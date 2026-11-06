/**
 * 「开发运行时」的 Python 发现核心（纯逻辑，不依赖 electron/child_process）。
 *
 * 两路来源（change 里「设置 → 开发运行时」分区）：
 * 1. **本机**：Windows 的 `py -0p` 启动器列表（最准，带默认标记），回退 `where python`；
 * 2. **内置**：扩展根目录里带 {@link RUNTIME_MARKER_FILE} 标记文件的扩展——"内置"由**文件**判定，
 *    而不是靠作者名猜。两个根都扫：`<安装目录>/extensions`（运行时包的**正式落点**）与
 *    `<userData>/extensions`（2.2.x 及更早的旧位置，仅兼容）。
 *
 * 之所以把解析抽成纯函数：`py -0p` 的输出格式、marker 的容错规则如果只能在真机上试，
 * 一改就没人敢动；这里用固定样例锁死行为。
 */

/** 运行时标记文件名（放在扩展根目录；内容含语言与版本） */
export const RUNTIME_MARKER_FILE = 'runtime.json'

/** 一个候选解释器 */
export interface PythonCandidate {
  /** 解释器可执行文件绝对路径 */
  path: string
  /** 形如 `3.12`（拿不到版本时为空串） */
  version: string
  /** 是否本机启动器登记的默认版本 */
  isDefault?: boolean
}

/** 内置运行时（来自扩展目录里的 marker） */
export interface BuiltinRuntime {
  /** 扩展 id（= 安装目录名：系统根是 `python3.11_runtime`，用户根是 `python3.11_runtime.obox`） */
  extensionId: string
  /** 扩展根目录 */
  dir: string
  /** marker 里声明的版本（如 `3.12.4`） */
  version: string
  /** 语言（目前只有 python） */
  language: string
  /** 是否已具备可执行文件（缺 python/python.exe 视为损坏） */
  hasExecutable: boolean
  /**
   * 来自哪个扩展根：
   * - `system` = `<安装目录>/extensions`（**运行时包的正式落点**，用户手动安装、落系统根）
   * - `user` = `<userData>/extensions`（2.2.x 及更早装在这里；仅作兼容扫描）
   */
  source?: 'system' | 'user'
}

/** `py -0p` 一行：` -V:3.12 *        C:\Program Files\Python312\python.exe` */
const PY_LIST_LINE = /^\s*-V:(\S+)\s+(\*)?\s*(.+?)\s*$/

/**
 * 解析 `py -0p` 输出。无法识别的行（表头、空行）直接跳过——宁可少一条，不要造一条假路径。
 */
export function parsePyLauncherList(output: string): PythonCandidate[] {
  const result: PythonCandidate[] = []
  const seen = new Set<string>()
  for (const raw of output.split(/\r?\n/)) {
    const match = PY_LIST_LINE.exec(raw)
    if (!match) continue
    const path = match[3].trim()
    if (!path.toLowerCase().endsWith('python.exe')) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ path, version: match[1], isDefault: match[2] === '*' })
  }
  return result
}

/** `where python` 输出：每行一个路径 */
export function parseWhereOutput(output: string): PythonCandidate[] {
  const result: PythonCandidate[] = []
  const seen = new Set<string>()
  for (const raw of output.split(/\r?\n/)) {
    const path = raw.trim()
    if (!path) continue
    if (!path.toLowerCase().endsWith('python.exe')) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ path, version: '' })
  }
  return result
}

/**
 * 从扩展目录的 marker 解析内置运行时。
 *
 * 容错：不是对象、language 不是 `python`、version 不是非空字符串 ⇒ 一律返回 null
 * （坏 marker 不该让整个列表崩，也不该被当成运行时）。
 */
export function parseRuntimeMarker(raw: unknown): { language: string; version: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const language = typeof record.language === 'string' ? record.language.trim().toLowerCase() : ''
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  if (language !== 'python') return null
  if (!version) return null
  return { language, version }
}

/**
 * 去重与排序：本机候选按版本降序（新版本优先），同路径只留一条。
 * 不做"内置 vs 本机同版本去重"——按约定，两者用路径/来源区分，允许同版本并存。
 */
export function normalizeCandidates(list: PythonCandidate[]): PythonCandidate[] {
  const byPath = new Map<string, PythonCandidate>()
  for (const item of list) {
    const key = item.path.toLowerCase()
    const existing = byPath.get(key)
    if (
      !existing ||
      (item.version && !existing.version) ||
      (item.isDefault && !existing.isDefault)
    ) {
      byPath.set(key, {
        ...item,
        ...(existing?.isDefault && !item.isDefault ? { isDefault: true } : {})
      })
    }
  }
  return [...byPath.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return compareVersions(b.version, a.version)
  })
}

/** 版本比较：`3.12` > `3.9`（按数字段，不按字符串） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((v) => Number.parseInt(v, 10) || 0)
  const pb = b.split('.').map((v) => Number.parseInt(v, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 合并两个根的内置运行时：**系统根优先**。
 *
 * 去重键：
 * - 同一 `extensionId`（同 id 时系统那份胜出）；
 * - 同一 `language:version`（约定"同一个 Python 版本只允许一个内置运行时"：2.2.x 装在用户根、
 *   升级后系统根又有一份时，不该给用户列出两条一样的 3.11.9）。
 *
 * 抽成纯函数放这里（而不是 `devRuntime.ts`）：后者 import 了 electron 的 `app`，纯逻辑放一起才能单测。
 */
export function mergeBuiltinRuntimes(
  system: BuiltinRuntime[],
  user: BuiltinRuntime[]
): BuiltinRuntime[] {
  const byId = new Map<string, BuiltinRuntime>()
  const byVersion = new Set<string>()
  for (const item of [...system, ...user]) {
    const key = `${item.language}:${item.version}`
    if (byId.has(item.extensionId) || byVersion.has(key)) continue
    byId.set(item.extensionId, item)
    byVersion.add(key)
  }
  return [...byId.values()].sort((a, b) => compareVersions(b.version, a.version))
}
