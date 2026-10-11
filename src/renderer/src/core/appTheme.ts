/**
 * App 子窗口的主题下发协议（宿主侧，纯模块：零 import，node 环境可直接单测）。
 *
 * 背景（ADR-0022 / 设计 §2.7）：`srcdoc` 型卡片把主题 token 拼进同一份文档即可生效，
 * 但 `url` 型卡片加载的是 `app://extensions|debug/<id>/…`，与父文档**跨源**：
 * `iframe.contentDocument` 恒为 null（注入不了 `<style>`），CSS 自定义属性也不跨文档继承。
 * 因此 token 只能经 `postMessage` 送达：
 *   宿主 → iframe：{ source:'obox-app', action:'obox-theme', themeId, tokens }
 *   iframe → 宿主：{ source:'obox-app', action:'obox-theme-request' }（无 requestId，非请求-响应）
 *
 * 本模块只做「构造 / 校验 / key 计算」，不碰 DOM、不碰消息通道，便于单测与复用。
 */

/** 宿主下发主题 token 的动作名 */
export const APP_THEME_PUSH_ACTION = 'obox-theme'

/** 子窗口请求宿主重发主题 token 的动作名 */
export const APP_THEME_REQUEST_ACTION = 'obox-theme-request'

/** 既有 obox-app 消息族的 source 字面量 */
export const APP_THEME_SOURCE = 'obox-app'

/**
 * 宿主主题 token 白名单（25 个），逐条对齐 `src/renderer/src/assets/main.css` 的 `:root`。
 * 顺序也保持一致 —— `test/app-theme.test.ts` 会按「集合 + 顺序」与 main.css 差分比对，
 * 因此改 `main.css` 的 token 必须同步改这里（token 漂移即测试红）。
 */
export const HOST_THEME_TOKEN_NAMES: readonly string[] = [
  '--bg',
  '--bg-panel',
  '--bg-sidebar',
  '--bg-titlebar',
  '--bg-input',
  '--border',
  '--fg',
  '--fg-dim',
  '--fg-bright',
  '--fg-link',
  '--fg-error',
  '--fg-warning',
  '--fg-success',
  '--accent',
  '--hover-bg',
  '--selection-bg',
  '--nav-icon',
  '--statusbar-bg',
  '--statusbar-fg',
  '--font-family',
  '--font-size',
  '--font-size-sm',
  '--font-size-lg',
  '--nav-icon-size',
  '--icon-size'
]

/** token 名下发的载荷 */
export interface AppThemeMessage {
  source: typeof APP_THEME_SOURCE
  action: typeof APP_THEME_PUSH_ACTION
  /** 当前主题 id（空串表示当前没有主题扩展） */
  themeId: string
  /** token 名 → 生效值 */
  tokens: Record<string, string>
}

const TOKEN_NAME_RE = /^--[a-z0-9-]+$/

/** token 名校验：`--` 开头，只含小写字母/数字/连字符 */
export function isTokenName(name: unknown): boolean {
  return typeof name === 'string' && TOKEN_NAME_RE.test(name)
}

/**
 * 过滤 token 载荷：丢弃非法键名 / 非字符串值 / 空串，**不抛错**。
 * 宿主构造时过滤一次，扩展侧收到后再过滤一次（双保险）。
 */
export function sanitizeThemeTokens(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isTokenName(key)) continue
    if (typeof value !== 'string' || value === '') continue
    out[key] = value
  }
  return out
}

/**
 * 按白名单逐个读值，组装 token 快照；空值跳过。
 *
 * 只取 `HOST_THEME_TOKEN_NAMES` 内的键，且读的是**生效值**（调用方传入的 read 通常是
 * `getComputedStyle(document.documentElement).getPropertyValue`）——这样快照与宿主主窗口
 * 肉眼所见一致，并天然跟随 `themeStore.apply()` 「只写不清旧键」的残留语义（设计 §2.7.5）。
 */
export function collectThemeTokens(
  read: (name: string) => string,
  names: readonly string[] = HOST_THEME_TOKEN_NAMES
): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const name of names) {
    let value: string
    try {
      value = read(name)
    } catch {
      continue
    }
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    tokens[name] = trimmed
  }
  return tokens
}

/** 构造下发给子窗口 iframe 的主题消息 */
export function buildThemeMessage(
  themeId: string,
  tokens: Record<string, string>
): AppThemeMessage {
  return {
    source: APP_THEME_SOURCE,
    action: APP_THEME_PUSH_ACTION,
    themeId: typeof themeId === 'string' ? themeId : '',
    tokens: sanitizeThemeTokens(tokens)
  }
}

/** 是否是宿主下发的主题推送（扩展侧判定；形状校验，不看 tokens 内容） */
export function isThemePush(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const msg = data as Record<string, unknown>
  return msg.source === APP_THEME_SOURCE && msg.action === APP_THEME_PUSH_ACTION
}

/** 是否是子窗口的主题重发请求 */
export function isThemeRequest(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const msg = data as Record<string, unknown>
  return msg.source === APP_THEME_SOURCE && msg.action === APP_THEME_REQUEST_ACTION
}

/**
 * iframe 的 `:key`。
 *
 * - `url` 型（`registration.url` 存在）：`url:<url>`，**与 themeId 无关** ⇒ 切主题不换 key
 *   ⇒ Vue 不重建 iframe ⇒ 页面内表单内容不丢；主题靠 `obox-theme` 推送更新。
 * - 其余（`html`/`srcdoc` 型）：`srcdoc:<themeId>` ⇒ 切主题换 key ⇒ iframe 重建 ⇒
 *   重新拼 `<style>` 注入 token（保留原有重渲染路径）。
 */
export function appFrameKey(
  registration: { url?: string; html?: string } | undefined,
  themeId: string
): string {
  const url = registration?.url
  if (typeof url === 'string' && url !== '') return `url:${url}`
  return `srcdoc:${typeof themeId === 'string' ? themeId : ''}`
}
