/**
 * 扩展身份守卫（主进程，**不依赖 electron**，可独立单测）。见 ADR-0015。
 *
 * ## 定位：误用防护，**不是**安全边界
 * 扩展入口是被宿主**动态 import 进主窗口渲染进程**的 ESM 模块，与宿主、与彼此同进程同上下文；
 * main 侧收到的 `senderFrame` 对所有扩展都是同一个窗口，**无法区分"是哪个扩展在调用"**。
 * 更根本的是扩展本可直接访问 `window.api`（见 SKILL.md「扩展是受信代码」）。
 * 因此任何"能隔离恶意扩展"的主进程检查都是虚假安全感——真正的隔离需要把扩展移入独立进程（本期不做）。
 *
 * 守卫能做的三件事：
 * 1. **id 规范化收敛到一处**（与 `.oix` 安装目录命名规则一致），并统一拒绝语义；
 * 2. 在 main 侧**确实掌握真值**的场景做成员校验（已知扩展集合由 main 自己的真值来源维护）；
 * 3. 给出稳定错误码，便于调用方与日志区分"参数非法"与"未知扩展"。
 */

/** 扩展 id / 安装目录名规则（与 oix 安装目录派生保持一致） */
const EXT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i

export type ExtGuardErrorCode = 'invalid-extension-id' | 'unknown-extension'

/** 守卫拒绝：带稳定错误码（消息前缀 `[<code>]` 便于 grep 与展示） */
export class ExtGuardError extends Error {
  readonly code: ExtGuardErrorCode
  constructor(code: ExtGuardErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'ExtGuardError'
    this.code = code
  }
}

/**
 * 规范化并校验扩展 id。
 * 拒绝：非字符串、空串、以非字母数字开头、含路径分隔符或 `.`/`..` 段（正则已排除分隔符，这里补齐语义化的点段）。
 */
export function normalizeExtensionId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ExtGuardError('invalid-extension-id', '扩展 id 必须是字符串')
  }
  const id = raw.trim()
  if (!id) {
    throw new ExtGuardError('invalid-extension-id', '扩展 id 不能为空')
  }
  if (!EXT_ID_RE.test(id) || id.includes('..')) {
    throw new ExtGuardError(
      'invalid-extension-id',
      `扩展 id 非法（只允许字母/数字/./_/-，且不能含 ..）: ${id}`
    )
  }
  return id
}

/**
 * 已知扩展 id 集合，分两部分维护：
 * - `scanned`：`userData/extensions` 目录扫描结果（磁盘真值，刷新时整体替换）
 * - `extra`：`--debug-extension` 声明的 id 与 .oix 安装成功后的登记（不随磁盘扫描清空）
 * 两者取并集即为"已知扩展"。
 * **注意**：内置扩展不在 userData（随应用打包），main 无法枚举——这也是数据面 handler 只做
 * "格式 + 路径包含"校验、而不做成员校验的原因（见 ADR-0015）。
 */
const scannedExtensions = new Set<string>()
const extraExtensions = new Set<string>()

function tryNormalize(id: unknown): string | null {
  try {
    return normalizeExtensionId(id)
  } catch {
    return null
  }
}

/** 整体替换已知集合（启动引导或测试用） */
export function setKnownExtensions(ids: readonly string[]): void {
  scannedExtensions.clear()
  extraExtensions.clear()
  for (const id of ids) {
    const normalized = tryNormalize(id)
    if (normalized) scannedExtensions.add(normalized)
  }
}

/** 刷新"磁盘扫描"部分：替换 scanned，保留 extra（调试扩展与已安装登记不被冲掉） */
export function refreshScannedExtensions(ids: readonly string[]): void {
  scannedExtensions.clear()
  for (const id of ids) {
    const normalized = tryNormalize(id)
    if (normalized) scannedExtensions.add(normalized)
  }
}

/** 登记一个已知扩展（安装成功后或调试扩展注册时调用） */
export function addKnownExtension(id: string): void {
  extraExtensions.add(normalizeExtensionId(id))
}

/** 注销一个已知扩展（卸载后调用）；id 非法时静默忽略（清理路径不应因参数问题失败） */
export function removeKnownExtension(id: string): void {
  const normalized = tryNormalize(id)
  if (!normalized) return
  scannedExtensions.delete(normalized)
  extraExtensions.delete(normalized)
}

export function isKnownExtension(id: string): boolean {
  const normalized = tryNormalize(id)
  return normalized !== null && (scannedExtensions.has(normalized) || extraExtensions.has(normalized))
}

/** 当前已知扩展 id 快照（诊断用） */
export function knownExtensionIds(): string[] {
  return [...new Set([...scannedExtensions, ...extraExtensions])]
}

/**
 * 校验 id 且要求它已在已知集合内。
 * 用于 main 掌握真值的路径（例如"只对已安装扩展执行卸载钩子"）；
 * **不要**用在数据面 handler 上——内置扩展不在集合内，会误挡合法调用。
 */
export function requireKnownExtension(raw: unknown): string {
  const id = normalizeExtensionId(raw)
  if (!isKnownExtension(id)) {
    throw new ExtGuardError('unknown-extension', `未知扩展 id（未安装或已卸载）: ${id}`)
  }
  return id
}
