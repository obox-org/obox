/**
 * `.oix` 的平台规则（用户确认的规则表）。
 *
 * 标识（清单 `manifest.platforms`，缺省 `['universal']`）：
 * - `universal`：任意 OS/架构
 * - `win32`：Windows 任意架构
 * - `win32-x64` / `win32-arm64`：Windows 指定架构
 * - 未来只加表项不改规则：`linux-x64` / `linux-arm64` / `darwin-arm64` …
 *
 * 产物文件名后缀（与标识一一对应）：
 * `universal → ""`、`win32 → "-win"`、`win32-x64 → "-win-x64"`、`win32-arm64 → "-win-arm64"`。
 *
 * 为什么把规则做成纯函数：安装器（拦截不匹配的包）、发布脚本（决定文件名）、文档三者
 * 必须同一份口径；散落三处必然漂移。
 */

/** 已知平台标识（新增平台时补这里 + 文档 + 文件名映射） */
export const KNOWN_PLATFORMS = ['universal', 'win32', 'win32-x64', 'win32-arm64'] as const

export type OixPlatform = (typeof KNOWN_PLATFORMS)[number]

/** 宿主平台（`process.platform` + `process.arch`） */
export interface HostPlatform {
  os: string
  arch: string
}

/** 平台标识 → 产物文件名后缀 */
export const PLATFORM_SUFFIX: Record<OixPlatform, string> = {
  universal: '',
  win32: '-win',
  'win32-x64': '-win-x64',
  'win32-arm64': '-win-arm64'
}

/** 导出名：`<name>-<version><suffix>.oix` */
export function oixFileName(name: string, version: string, platform: OixPlatform): string {
  return `${name}-${version}${PLATFORM_SUFFIX[platform]}.oix`
}

/**
 * 解析清单里的 `platforms`。
 *
 * - 缺省（undefined / 空数组）⇒ `['universal']`
 * - 非法项（未知标识、非字符串）⇒ 返回 null，由调用方报可读错误（不静默当 universal）
 */
export function parsePlatforms(raw: unknown): OixPlatform[] | null {
  if (raw === undefined) return ['universal']
  if (!Array.isArray(raw)) return null
  if (raw.length === 0) return ['universal']
  const result: OixPlatform[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    const token = item.trim().toLowerCase()
    if (!(KNOWN_PLATFORMS as readonly string[]).includes(token)) return null
    if (!result.includes(token as OixPlatform)) result.push(token as OixPlatform)
  }
  return result
}

/** 宿主是否满足任一平台标识 */
export function isPlatformCompatible(platforms: OixPlatform[], host: HostPlatform): boolean {
  return platforms.some((platform) => {
    if (platform === 'universal') return true
    const [os, arch] = platform.split('-')
    if (host.os !== os) return false
    return arch === undefined ? true : host.arch === arch
  })
}

/** 人类可读的宿主平台（错误文案用） */
export function hostPlatformLabel(host: HostPlatform): string {
  return `${host.os}-${host.arch}`
}

/** 不匹配时的中文文案（安装器直接展示） */
export function platformMismatchMessage(platforms: OixPlatform[], host: HostPlatform): string {
  return `此包支持 ${platforms.join(' / ')}，当前设备为 ${hostPlatformLabel(host)}，请安装对应平台的包`
}
