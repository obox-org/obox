/**
 * .oix 扩展包安装核心（**不依赖 electron**，可独立单测；electron 层见 oix.ts）。
 *
 * 安装语义（S1 规格）：
 * - 校验：zip 可解析 → 根 manifest.json → name/version/main → 入口在包内 → 条目路径安全（zip-slip 规则）
 * - 限额：条目数上限 + 解压总量上限（防压缩炸弹）
 * - **原子性**：先解到暂存目录，全部通过后再整体替换目标目录；目标已存在时先改名为备份，
 *   替换失败则把备份改回（旧版本不丢）
 * - **串行化**：同一扩展 id 的安装排队执行，并发安装不会写出半安装目录
 * - 失败以 `OixInstallError`（带稳定错误码）抛出，由 electron 层转成返回值
 */
import AdmZip from 'adm-zip'
import { promises as fs } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import type { ExtensionMeta, InstallOixErrorCode, InstallOixResult } from '../shared/types'
import { findRuntimeVersionConflict, readRuntimeMarker } from './runtimeInstallGuard'
import {
  isPlatformCompatible,
  KNOWN_PLATFORMS,
  parsePlatforms,
  platformMismatchMessage
} from './oixPlatform'
import { isPythonCoreError, toPythonArch, validatePythonDeclaration } from './pythonCore'
import { parseRuntimeMarker, RUNTIME_MARKER_FILE } from './pythonDiscovery'
import { SYSTEM_EXTENSION_AUTHOR } from './extensionSources'

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i
const SAFE_DIR_RE = /^[a-z0-9._-]+$/i
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

/**
 * 解压限额（可在 opts 覆盖，测试用小值）。
 *
 * 条目/总量因"运行时等大文件随扩展包分发"而放宽（issue #51 决策 12；残余风险见 ADR-0018），
 * 但**仍是硬上限**：超限依旧以 `too-large` 拒绝并回滚，不是取消压缩炸弹防护。
 */
export const DEFAULT_MAX_ENTRIES = 10000
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024

/**
 * 扩展**运行时数据目录**名（`<扩展目录>/data`）：`api.fs` 与 `api.sqlite` 的落点。
 * 两条规则共用它：① 覆盖安装时保留旧 `data/`（升级不丢数据）；② 包内不得含 `data/`。
 */
export const EXT_DATA_DIR = 'data'

export interface OixInstallOptions {
  /** 扩展安装根目录（electron 层传 userData/extensions） */
  targetRoot: string
  /** 暂存目录根（必须与 targetRoot 同一卷，保证 rename 原子） */
  tmpRoot: string
  /**
   * 运行时包的**专用**安装根（系统扩展目录，见 change「运行时安装到系统扩展目录」）。
   *
   * 为什么运行时特殊：它是用户手动安装的包（不随 obox 分发），但要落在**系统扩展根**里——
   * ① 全用户/多版本共享同一份 100MB 解释器；② 扫描器按系统扩展规则判它（id 无作者后缀）。
   * 省略时（单测/嵌入场景）运行时仍装到 {@link targetRoot}，与旧行为一致。
   */
  runtimeTargetRoot?: string
  /** 额外的"同版本唯一性"检查根（用户扩展根：迁移前旧位置的同一运行时要在成功后清掉） */
  runtimeOtherRoots?: string[]
  maxEntries?: number
  maxTotalBytes?: number
}

/** 带稳定错误码的安装失败 */
export class OixInstallError extends Error {
  readonly code: InstallOixErrorCode
  constructor(code: InstallOixErrorCode, message: string) {
    super(message)
    this.name = 'OixInstallError'
    this.code = code
  }
}

/**
 * 从 manifest 派生安装目录名：**`<name>.<author>`**（change `system-extensions-from-install-dir`）。
 *
 * 与扫描器 `expectedExtensionId()` 必须逐字同一规则：清洗（小写 + 去掉 `[^a-z0-9._-]`）后
 * 用点号连接；没有 author 时目录名就是 name。
 */
export function deriveDirName(name: string, author?: string): string {
  const safeAuthor = (author ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '')
  return safeAuthor ? `${name}.${safeAuthor}` : name
}

function readRootManifest(zip: AdmZip): Record<string, unknown> | null {
  const entry = zip.getEntries().find((e) => e.entryName === 'manifest.json')
  if (!entry) return null
  const buf = zip.readFile(entry)
  if (!buf) return null
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 从 zip **根**读运行时 marker（`runtime.json`），不解压即可判定"这是运行时包"。
 *
 * 为什么必须在解压前判定：目标根不同 ⇒ 暂存目录也必须与目标根同卷（rename 原子），
 * 所以"装到用户根还是系统根"这条决策不能等到解压之后再做。
 */
function readRootRuntimeMarker(zip: AdmZip): { language: string; version: string } | null {
  const entry = zip.getEntries().find((e) => e.entryName === RUNTIME_MARKER_FILE)
  if (!entry) return null
  const buf = zip.readFile(entry)
  if (!buf) return null
  try {
    return parseRuntimeMarker(JSON.parse(buf.toString('utf8')))
  } catch {
    return null
  }
}

/** 写盘类错误 → 稳定错误码（系统扩展目录不可写时给用户可执行的指引，而不是裸 errno） */
export function mapWriteError(err: unknown, isSystemTarget: boolean): OixInstallError {
  if (err instanceof OixInstallError) return err
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (isSystemTarget && (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')) {
    return new OixInstallError(
      'need-admin',
      '系统扩展目录不可写：请把 obox 安装在当前用户下（安装时选「仅为我安装」），' +
        `或以管理员身份运行 obox 后再安装运行时（${message}）`
    )
  }
  return new OixInstallError('write-failed', message)
}

/**
 * 校验 zip 条目路径并解析为目标目录下的安全绝对路径。
 * 拒绝：空路径、绝对路径（/ 开头或盘符）、反斜杠、.. 段、目标目录外的路径。
 */
function resolveEntry(
  target: string,
  entryName: string
): { filePath: string; isDir: boolean } | null {
  if (!entryName || entryName.includes('\\')) return null
  if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) return null
  const isDir = entryName.endsWith('/')
  const clean = entryName.replace(/\/+$/, '')
  const parts = clean.split('/')
  if (parts.some((p) => p === '..' || p === '')) return null
  const filePath = resolve(target, ...parts)
  if (filePath !== target && !filePath.startsWith(target + sep)) return null
  return { filePath, isDir }
}

/** 按扩展 id 串行：同 id 的安装排队，避免并发交错写出半安装目录 */
const installQueues = new Map<string, Promise<void>>()
/** 仅供测试：等待所有排队中的安装结束 */
export async function drainInstallQueue(): Promise<void> {
  await Promise.allSettled([...installQueues.values()])
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 读取扩展元数据（`.obox-meta.json`）。
 * 缺失、损坏、非对象一律返回空对象——**旧安装没有钩子字段也照常工作**（issue #52）。
 */
export async function readExtensionMeta(extensionDir: string): Promise<ExtensionMeta> {
  try {
    const raw = await fs.readFile(join(extensionDir, '.obox-meta.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as ExtensionMeta) : {}
  } catch {
    return {}
  }
}

/**
 * 记录一次 install 钩子的执行结果并**清除 `pendingInstall`**。
 *
 * 调用方（`oix.ts`）只在"请求确实送达渲染进程且不是 deferred"时才调用，否则保留
 * `pendingInstall` 待下次启动补跑；钩子失败也记录（`ok:false`），以免"每次安装只跑一次"
 * 被破坏后无限重跑（判定见 `renderer/src/core/hookState.ts` 的 `decideInstallHook`）。
 */
export async function recordInstallHookResult(
  extensionDir: string,
  version: string,
  ok: boolean,
  at: number = Date.now()
): Promise<ExtensionMeta> {
  const current = await readExtensionMeta(extensionDir)
  const next: ExtensionMeta = { ...current, install: { version, at, ok } }
  delete next.pendingInstall
  await fs.writeFile(join(extensionDir, '.obox-meta.json'), JSON.stringify(next), 'utf8')
  return next
}

/** 读某目录清单里的版本号（覆盖安装时记下被替换的版本，供钩子的 ctx.previousVersion） */
async function readManifestVersion(dir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(join(dir, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** 解压阶段进入暂存目录：所有校验通过前不碰目标目录 */
async function extractToStage(
  zip: AdmZip,
  stage: string,
  opts: Required<Pick<OixInstallOptions, 'maxEntries' | 'maxTotalBytes'>>
): Promise<number> {
  const entries = zip.getEntries().filter((e) => !e.isDirectory)
  if (entries.length > opts.maxEntries) {
    throw new OixInstallError(
      'too-large',
      `oix 包条目过多（${entries.length} > ${opts.maxEntries}），已拒绝安装`
    )
  }
  // 包内不得含 data/：那是扩展的**运行时数据目录**（api.fs / api.sqlite 的落点），
  // 由宿主在覆盖安装时保留（见下方 rename 段）。若允许打进包里，旧包会用陈旧数据覆盖用户数据。
  const forbidden = entries.find(
    (e) => e.entryName === EXT_DATA_DIR || e.entryName.startsWith(`${EXT_DATA_DIR}/`)
  )
  if (forbidden) {
    throw new OixInstallError(
      'forbidden-entry',
      `包内不得包含 ${EXT_DATA_DIR}/ 目录：它是扩展运行时数据目录，升级时由宿主保留`
    )
  }
  let total = 0
  for (const entry of entries) {
    const r = resolveEntry(stage, entry.entryName)
    if (!r) {
      throw new OixInstallError('entry-invalid', `oix 包内含非法条目路径: ${entry.entryName}`)
    }
    const data = zip.readFile(entry)
    if (!data) continue
    total += data.byteLength
    if (total > opts.maxTotalBytes) {
      throw new OixInstallError(
        'too-large',
        `oix 包解压总量超限（> ${Math.round(opts.maxTotalBytes / 1024 / 1024)}MB），已拒绝安装`
      )
    }
    await fs.mkdir(dirname(r.filePath), { recursive: true })
    await fs.writeFile(r.filePath, data)
  }
  return total
}

/**
 * 安装 .oix 包。成功返回扩展信息；失败抛 `OixInstallError`。
 * 同一扩展 id 的调用会排队串行执行。
 */
export async function installFromPackage(
  filePath: string,
  opts: OixInstallOptions
): Promise<InstallOixResult> {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new OixInstallError('path-invalid', '无效的安装路径')
  }
  if (!(await pathExists(filePath))) {
    throw new OixInstallError('path-invalid', `安装包不存在: ${filePath}`)
  }

  // 先解析清单拿到扩展 id（轻量、只读），再按 id 串行进入解压/替换阶段
  let zip: AdmZip
  try {
    zip = new AdmZip(filePath)
  } catch {
    throw new OixInstallError('invalid-package', '无法解析该文件：不是有效的 .oix（zip）包')
  }
  const manifest = readRootManifest(zip)
  if (!manifest) {
    throw new OixInstallError('invalid-manifest', 'oix 包内缺少根 manifest.json')
  }
  const { name, version, main } = manifest
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new OixInstallError('invalid-manifest', 'manifest.name 非法（只能含字母/数字/./_/-）')
  }
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new OixInstallError('invalid-manifest', 'manifest.version 非法（需 semver，如 1.0.0）')
  }
  if (typeof main !== 'string' || !main.trim()) {
    throw new OixInstallError('invalid-manifest', 'manifest.main（入口文件）必填')
  }
  const mainClean = main.replace(/^\.\//, '')
  if (!zip.getEntries().some((e) => e.entryName === mainClean)) {
    throw new OixInstallError('entry-missing', `入口文件 ${main} 不在 oix 包内`)
  }
  const author = typeof manifest.author === 'string' ? manifest.author : undefined
  const displayName = typeof manifest.displayName === 'string' ? manifest.displayName : undefined

  // 运行时包（包根有 runtime.json）：**装到系统扩展根**（用户裁定，change「运行时安装到系统扩展目录」）。
  // 它仍是"用户手动安装"的包（不随 obox 分发），只是落点与系统扩展一致：
  // ① 全用户共享同一份解释器；② 扫描器按系统扩展规则判它，id = name（不带作者后缀）。
  // 判定必须在解压前完成：目标根决定暂存目录（rename 原子要求同卷）。
  const runtime = readRootRuntimeMarker(zip)
  const goesToSystemRoot = runtime !== null && opts.runtimeTargetRoot !== undefined
  if (goesToSystemRoot && author !== SYSTEM_EXTENSION_AUTHOR) {
    throw new OixInstallError(
      'invalid-manifest',
      `运行时扩展装到系统扩展目录时 author 必须是 ${SYSTEM_EXTENSION_AUTHOR}（实际：${author ?? '(缺失)'}）`
    )
  }
  const id = goesToSystemRoot ? name : deriveDirName(name, author)
  if (!SAFE_DIR_RE.test(id)) {
    throw new OixInstallError('invalid-manifest', `派生的安装目录名非法: ${id}`)
  }

  // Python 运行时声明（issue #51 / ADR-0018）：**安装期**就拒掉错架构的包，
  // 别让用户装上之后才发现"运行时不匹配"。声明了 arch/python 就必须成对合法。
  if (manifest.arch !== undefined || manifest.python !== undefined) {
    const hostArch = toPythonArch(process.arch)
    if (hostArch !== null) {
      try {
        validatePythonDeclaration({ arch: manifest.arch, python: manifest.python }, hostArch)
      } catch (err) {
        if (isPythonCoreError(err) && err.code === 'arch-mismatch') {
          throw new OixInstallError('arch-mismatch', err.message)
        }
        throw new OixInstallError(
          'invalid-manifest',
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  }

  // 平台规则（用户确认的规则表）：清单 `platforms` 缺省 = universal；
  // 与宿主平台不匹配时**安装期**就拒掉，别让用户装上跑不起来。
  const platforms = parsePlatforms(manifest.platforms)
  if (platforms === null) {
    throw new OixInstallError(
      'invalid-manifest',
      `platforms 必须是 ${KNOWN_PLATFORMS.join(' / ')} 的子集`
    )
  }
  const hostPlatform = { os: process.platform, arch: process.arch }
  if (!isPlatformCompatible(platforms, hostPlatform)) {
    throw new OixInstallError('platform-mismatch', platformMismatchMessage(platforms, hostPlatform))
  }

  const limits = {
    maxEntries: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxTotalBytes: opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  }

  const run = async (): Promise<InstallOixResult> => {
    // 系统扩展根（安装目录下）与用户根可能不在同一卷：暂存目录必须跟着目标根走
    const targetRoot = goesToSystemRoot ? (opts.runtimeTargetRoot as string) : opts.targetRoot
    const tmpRoot = goesToSystemRoot ? join(targetRoot, '.tmp') : opts.tmpRoot
    const target = resolve(targetRoot, id) // SAFE_DIR_RE 已保证无分隔符，必在 targetRoot 之下
    const stage = join(tmpRoot, `${id}.staging-${process.pid}-${Date.now()}`)
    const backup = join(tmpRoot, `${id}.backup-${process.pid}-${Date.now()}`)
    try {
      await fs.mkdir(tmpRoot, { recursive: true })
    } catch (err) {
      throw mapWriteError(err, goesToSystemRoot)
    }
    await fs.rm(stage, { recursive: true, force: true })

    // 覆盖安装：**替换前**把旧版本号与旧的钩子执行记录读出来（替换后旧目录就没了）。
    // previousVersion 供 install 钩子做 ctx.previousVersion；旧 install 记录要继承下来，
    // 否则"同一版本只跑一次"的判定在替换后就失去了依据（E2E 抓到的重复执行）
    const replaced = await pathExists(target)
    const previousVersion = replaced ? await readManifestVersion(target) : undefined
    const previousMeta = replaced ? await readExtensionMeta(target) : {}

    // 从旧位置（用户扩展根）迁移过来的同一运行时：成功后再删，失败则保留旧副本
    let migrateFrom: string | null = null

    try {
      await fs.mkdir(stage, { recursive: true })
      await extractToStage(zip, stage, limits)
      // 运行时包唯一性（change「开发运行时」）：同一个 Python 版本只允许一个内置运行时。
      // 放在 rename 之前：冲突时 stage 会被清掉，磁盘上不留半成品。
      const runtimeMarker = await readRuntimeMarker(stage)
      if (runtimeMarker) {
        const roots = [targetRoot, ...(opts.runtimeOtherRoots ?? [])]
        for (const root of roots) {
          const conflict = await findRuntimeVersionConflict(
            root,
            runtimeMarker.version,
            root === targetRoot ? id : undefined
          )
          if (!conflict) continue
          // 旧位置里**同名运行时**的旧目录（`python3.11_runtime.obox`）不算冲突，算迁移：
          // 用户在 2.2.x 装过用户扩展版，升到系统根后旧副本必须清掉，否则同版本会有两份。
          const legacyIds = [name, deriveDirName(name, author)]
          if (root !== targetRoot && legacyIds.includes(conflict)) {
            migrateFrom = join(root, conflict)
            continue
          }
          throw new OixInstallError(
            'runtime-version-conflict',
            `已存在 Python ${runtimeMarker.version} 的内置运行时（${conflict}）；同一版本只允许安装一个`
          )
        }
      }
      const now = Date.now()
      const meta: ExtensionMeta = {
        installedTimestamp: now,
        // 继承覆盖安装前的 install 记录（同版本重装 → 主进程据此判定"已跑过"并跳过钩子）
        ...(previousMeta.install ? { install: previousMeta.install } : {}),
        // 安装完成即标记"待执行 install 钩子"：渲染进程执行后回写 install 并清除本字段；
        // 若安装当时渲染进程不可用，则留待下次启动扫描期补跑（见 issue #52 / hookState.ts）。
        // 记上 previousVersion：延迟补跑时同样能给出正确的升级上下文
        pendingInstall: { version, at: now, previousVersion }
      }
      await fs.writeFile(join(stage, '.obox-meta.json'), JSON.stringify(meta), 'utf8')
    } catch (err) {
      await fs.rm(stage, { recursive: true, force: true })
      throw err instanceof OixInstallError ? err : mapWriteError(err, goesToSystemRoot)
    }

    // 原子替换：旧目录先改名备份，替换失败则改回（旧版本不丢）
    try {
      if (replaced) await fs.rename(target, backup)
      await fs.rename(stage, target)
    } catch (err) {
      if (replaced && (await pathExists(backup)) && !(await pathExists(target))) {
        await fs.rename(backup, target).catch(() => {})
      }
      await fs.rm(stage, { recursive: true, force: true })
      const mapped = mapWriteError(err, goesToSystemRoot)
      throw mapped.code === 'need-admin'
        ? mapped
        : new OixInstallError(
            'write-failed',
            `写入安装目录失败：${err instanceof Error ? err.message : String(err)}`
          )
    }
    // **保留扩展运行时数据**：旧目录已整体挪到 backup，新目录只有包内内容。
    // 在删 backup 之前把旧 data/ 搬回来，否则升级即丢库（api.sqlite）与文件（api.fs）。
    // stage 与 target 同在 extensions/ 下（同卷），rename 原子；失败只记日志，不阻断安装、不丢新版本。
    if (replaced) {
      const oldData = join(backup, EXT_DATA_DIR)
      const newData = join(target, EXT_DATA_DIR)
      try {
        if ((await pathExists(oldData)) && !(await pathExists(newData))) {
          await fs.rename(oldData, newData)
        }
      } catch (err) {
        console.warn(
          `[oix] 保留旧 ${EXT_DATA_DIR}/ 目录失败（不影响本次安装）：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {})

    // 旧位置的同一运行时（用户扩展根）清掉：否则同版本会同时存在两份，扫描/默认值会打架
    if (migrateFrom) {
      try {
        await fs.rm(migrateFrom, { recursive: true, force: true })
        console.log(`[oix] 运行时已从用户扩展目录迁移到系统扩展目录：${migrateFrom} → ${target}`)
      } catch (err) {
        console.warn(
          `[oix] 清理旧位置的运行时失败（新版本已安装）：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    return {
      id,
      name,
      displayName,
      version,
      author,
      replaced,
      previousVersion,
      dir: target,
      source: goesToSystemRoot ? 'system' : 'user'
    }
  }

  // 串行化：把本次安装接到该 id 的队列尾部；队列项自身不抛错，避免影响后续安装
  const prev = installQueues.get(id) ?? Promise.resolve()
  const current = prev.then(run, run)
  const settled = current.then(
    () => undefined,
    () => undefined
  )
  installQueues.set(id, settled)
  try {
    return await current
  } finally {
    // 仅当没有更新的安装接在队列后面时才清理（否则会打断串行链）
    if (installQueues.get(id) === settled) installQueues.delete(id)
  }
}
