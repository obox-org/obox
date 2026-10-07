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

export interface OixInstallOptions {
  /** 扩展安装根目录（electron 层传 userData/extensions） */
  targetRoot: string
  /** 暂存目录根（必须与 targetRoot 同一卷，保证 rename 原子） */
  tmpRoot: string
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

/** 从 manifest 派生安装目录名：<name>_<清洗后 author> */
export function deriveDirName(name: string, author?: string): string {
  const safeAuthor = (author ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '')
  return safeAuthor ? `${name}_${safeAuthor}` : name
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
  const id = deriveDirName(name, author)
  if (!SAFE_DIR_RE.test(id)) {
    throw new OixInstallError('invalid-manifest', `派生的安装目录名非法: ${id}`)
  }

  const limits = {
    maxEntries: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxTotalBytes: opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  }

  const run = async (): Promise<InstallOixResult> => {
    const target = resolve(opts.targetRoot, id) // SAFE_DIR_RE 已保证无分隔符，必在 targetRoot 之下
    const stage = join(opts.tmpRoot, `${id}.staging-${process.pid}-${Date.now()}`)
    const backup = join(opts.tmpRoot, `${id}.backup-${process.pid}-${Date.now()}`)
    await fs.mkdir(opts.tmpRoot, { recursive: true })
    await fs.rm(stage, { recursive: true, force: true })

    try {
      await fs.mkdir(stage, { recursive: true })
      await extractToStage(zip, stage, limits)
      const now = Date.now()
      const meta: ExtensionMeta = {
        installedTimestamp: now,
        // 安装完成即标记"待执行 install 钩子"：渲染进程执行后回写 install 并清除本字段；
        // 若安装当时渲染进程不可用，则留待下次启动扫描期补跑（见 issue #52 / hookState.ts）
        pendingInstall: { version, at: now }
      }
      await fs.writeFile(join(stage, '.obox-meta.json'), JSON.stringify(meta), 'utf8')
    } catch (err) {
      await fs.rm(stage, { recursive: true, force: true })
      throw err instanceof OixInstallError
        ? err
        : new OixInstallError('write-failed', err instanceof Error ? err.message : String(err))
    }

    // 原子替换：旧目录先改名备份，替换失败则改回（旧版本不丢）
    const replaced = await pathExists(target)
    try {
      if (replaced) await fs.rename(target, backup)
      await fs.rename(stage, target)
    } catch (err) {
      if (replaced && (await pathExists(backup)) && !(await pathExists(target))) {
        await fs.rename(backup, target).catch(() => {})
      }
      await fs.rm(stage, { recursive: true, force: true })
      throw new OixInstallError(
        'write-failed',
        `写入安装目录失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {})

    return { id, name, displayName, version, author, replaced }
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
