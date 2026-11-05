/**
 * 扩展来源扫描（提案 `system-extensions-from-install-dir` 的 D-1 / D-2 / D-10）。
 *
 * 两个根：
 * - **系统根**：`<安装目录>/extensions/<name>`（随安装包，author 必须是 `obox`）
 * - **用户根**：`<userData>/extensions/<name>.<author>`
 *
 * 规则：
 * 1. **目录名即 id**，两种来源各自成规则（系统 `id = <name>`、用户 `id = <name>.<author>`）；
 * 2. 系统根先扫、用户根后扫；同 id 时系统胜出，用户那份标 `shadowed` 且不参与激活；
 * 3. 旧的下划线命名（`pet_chenzhi`）**不识别**（D-10），跳过并只记一次告警；
 * 4. 目录名与清单不一致（系统扩展 author 不是 obox、用户扩展拼不出同名目录）⇒ 记为 `invalid`。
 *
 * 为什么把 IO 注入：本模块不 import electron，`node --test`/`vitest` 可直接用假目录树断言规则，
 * 避免"扫描逻辑只能靠真机验证"。
 */
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 系统扩展的作者标识（目录名不含作者，id 就等于目录名） */
export const SYSTEM_EXTENSION_AUTHOR = 'obox'

export type ExtensionSourceKind = 'system' | 'user'

/** 扫描结果条目 */
export interface ScannedExtension {
  /** = 目录名；系统扩展是 `<name>`，用户扩展是 `<name>.<author>` */
  id: string
  source: ExtensionSourceKind
  /** 绝对目录 */
  dir: string
  /** 被同 id 的系统扩展遮蔽（只有用户扩展会为 true） */
  shadowed?: boolean
  /** 清单校验不过时的可读原因；有它就不会被加载 */
  error?: string
}

export interface ScanExtensionSourcesOptions {
  systemRoot: string
  userRoot: string
  /** 列目录（默认 readdir；测试注入假树） */
  listDirectories?: (root: string) => Promise<string[]>
  /** 读清单（默认读 `<dir>/manifest.json`；测试注入） */
  readManifest?: (dir: string) => Promise<{ name?: unknown; author?: unknown } | null>
  /** 告警出口（默认 console.warn；测试注入收集） */
  warn?: (message: string) => void
}

/** 默认列目录：跳过 `.` 开头的目录与文件 */
async function defaultListDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
}

async function defaultReadManifest(
  dir: string
): Promise<{ name?: unknown; author?: unknown } | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      name?: unknown
      author?: unknown
    }
  } catch {
    return null
  }
}

/** 旧命名（下划线连接 name/author，且没有点号）——不识别，只告警 */
export function isLegacyExtensionDirName(name: string): boolean {
  return !name.includes('.') && /^[a-z0-9][a-z0-9._-]*_[a-z0-9._-]+$/.test(name)
}

/** 目录名合法性（两段都按扩展 id 字符集） */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

/**
 * 扫描两个根。
 *
 * 返回的条目按"系统在前、用户在后"排列；`error` 非空的条目保留在列表里，
 * 让扩展管理器能显示"为什么这份没生效"，但调用方不得激活它们。
 */
export async function scanExtensionSources(
  options: ScanExtensionSourcesOptions
): Promise<ScannedExtension[]> {
  const list = options.listDirectories ?? defaultListDirectories
  const readManifest = options.readManifest ?? defaultReadManifest
  const warn = options.warn ?? ((message: string): void => console.warn(message))

  const system: ScannedExtension[] = []
  const user: ScannedExtension[] = []
  const systemIds = new Set<string>()
  let legacyWarned = false

  const scanRoot = async (root: string, source: ExtensionSourceKind): Promise<void> => {
    let names: string[]
    try {
      names = await list(root)
    } catch {
      return // 目录不存在：正常情况（例如安装包里没有系统扩展）
    }
    for (const name of names) {
      const dir = join(root, name)
      if (isLegacyExtensionDirName(name)) {
        if (!legacyWarned) {
          warn(
            `[extensions] 跳过旧命名目录 ${name}（下划线命名不再识别；用户扩展应为 <name>.<author>）`
          )
          legacyWarned = true
        }
        continue
      }
      const manifest = await readManifest(dir)
      if (!manifest) {
        // 没有清单的目录（数据目录、安装临时目录）静默跳过：扫描不该为它们刷日志
        continue
      }
      const manifestName = typeof manifest.name === 'string' ? manifest.name.trim() : ''
      const manifestAuthor = typeof manifest.author === 'string' ? manifest.author.trim() : ''

      if (!ID_PATTERN.test(name)) {
        ;(source === 'system' ? system : user).push({
          id: name,
          source,
          dir,
          error: `目录名非法（只允许 [a-z0-9._-]，且以字母/数字开头）：${name}`
        })
        continue
      }

      if (source === 'system') {
        if (manifestAuthor !== SYSTEM_EXTENSION_AUTHOR) {
          ;(source === 'system' ? system : user).push({
            id: name,
            source,
            dir,
            error: `系统扩展的 author 必须是 ${SYSTEM_EXTENSION_AUTHOR}（实际：${manifestAuthor || '(缺失)'}）`
          })
          continue
        }
        if (manifestName !== name) {
          ;(source === 'system' ? system : user).push({
            id: name,
            source,
            dir,
            error: `系统扩展目录名必须等于清单 name（目录 ${name}、清单 ${manifestName || '(缺失)'}）`
          })
          continue
        }
        systemIds.add(name)
        system.push({ id: name, source, dir })
        continue
      }

      const expectedId = manifestAuthor === '' ? manifestName : `${manifestName}.${manifestAuthor}`
      if (manifestName === '' || expectedId !== name) {
        user.push({
          id: name,
          source,
          dir,
          error: `用户扩展目录名必须是 <name>.<author>（目录 ${name}、清单推出 ${expectedId || '(缺失)'}）`
        })
        continue
      }
      user.push({ id: name, source, dir })
    }
  }

  await scanRoot(options.systemRoot, 'system')
  await scanRoot(options.userRoot, 'user')

  // 同 id：系统优先，用户那份标 shadowed（仍保留条目，管理器要能显示"已遮蔽"）
  for (const entry of user) {
    if (systemIds.has(entry.id)) entry.shadowed = true
  }
  return [...system, ...user]
}

/** 只取可加载的条目（无 error 且未被遮蔽） */
export function selectLoadableExtensions(entries: ScannedExtension[]): ScannedExtension[] {
  return entries.filter((e) => !e.error && !e.shadowed)
}

/** 目录名 → 期望 id（供安装流程校验，避免两处各写一遍规则） */
export function expectedExtensionId(
  source: ExtensionSourceKind,
  manifest: { name?: unknown; author?: unknown }
): string | null {
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : ''
  const author = typeof manifest.author === 'string' ? manifest.author.trim() : ''
  if (name === '') return null
  return source === 'system' ? name : author === '' ? name : `${name}.${author}`
}

/** 由目录路径反推它属于哪个根（协议与卸载用） */
export function sourceKindOf(
  dir: string,
  roots: { systemRoot: string; userRoot: string }
): ExtensionSourceKind {
  const normalized = dir.replace(/[\\/]+$/, '')
  if (normalized === roots.systemRoot.replace(/[\\/]+$/, '')) return 'system'
  if (normalized.startsWith(roots.systemRoot)) return 'system'
  return basename(roots.userRoot) && normalized.startsWith(roots.userRoot) ? 'user' : 'user'
}
/** 扫描条目 → IPC 载荷（字段与顺序的唯一来源；`capabilities.ts` 直接用它） */
export function toUserExtensionEntry(entry: ScannedExtension): {
  id: string
  path: string
  source: ExtensionSourceKind
  shadowed?: boolean
  error?: string
} {
  return {
    id: entry.id,
    path: entry.dir,
    source: entry.source,
    ...(entry.shadowed ? { shadowed: true } : {}),
    ...(entry.error ? { error: entry.error } : {})
  }
}
/**
 * `app://extensions/<id>` 的根解析：**系统根优先，用户根兜底**（change 任务 3.1）。
 *
 * `exists` 注入是为了单测（真实调用方传 `manifest.json` 是否存在的检查）；
 * 返回 null 表示两个根都没有这个 id。
 */
export function resolveExtensionRoot(
  id: string,
  roots: { systemRoot: string; userRoot: string },
  exists: (dir: string) => boolean
): string | null {
  const system = join(roots.systemRoot, id)
  if (exists(system)) return roots.systemRoot
  const user = join(roots.userRoot, id)
  if (exists(user)) return roots.userRoot
  return null
}

/**
 * 系统扩展不可卸载 / 不可禁用（change 任务 3.2）：底层统一在这里判定，
 * UI 只是不渲染按钮，不作为唯一防线。
 */
export function systemExtensionError(
  entries: ScannedExtension[],
  id: string,
  action: '卸载' | '禁用'
): string | null {
  const hit = entries.find((e) => e.id === id && e.source === 'system')
  return hit ? `系统扩展不可${action}（${id} 随安装包分发）` : null
}
