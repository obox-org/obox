/**
 * 宿主 → overlay 窗口的主题 token 下发协议（纯模块：零 electron / 零 DOM 依赖，node 环境可单测）。
 *
 * ## 为什么需要它
 *
 * 宿主把 25 个主题 token 注入在**主窗口**的 `document.documentElement` 上。可 overlay（浮层）是
 * 主进程 `new BrowserWindow()` 加载的**独立文档**（`app://extensions/<id>/dist/index.html`）：
 * CSS 自定义属性**不跨文档继承**，App 子窗口/iframe 那条 `obox-theme` postMessage 也送不到它。
 * 于是浮层页里所有 `var(--bg-panel)` 都解析为空 ⇒ 面板背景/边框/文字全透明。
 *
 * 链路（本模块负责"载荷形状 + 应用"这两段纯逻辑）：
 *   renderer（theme.ts，主题生效后）→ `api.themePushTokens()` → main 缓存并广播
 *   → 每个 overlay 的 preload 收到 → `applyThemeTokens(document, payload)` 写到 documentElement
 *
 * 时序：main 在建窗后 `dom-ready` 时补发一次缓存（页面首帧前就到了），此后主题变更即时广播。
 */

/** preload ↔ main 的 IPC 频道名（单一来源，避免两处字符串漂移）：main → 各窗口下发 */
export const OVERLAY_THEME_CHANNEL = 'theme:tokens'

/** renderer → main 上报 token 的频道名（与下发方向区分开，避免同名双向造成误读） */
export const THEME_TOKENS_PUSH_CHANNEL = 'theme:push-tokens'

/** 主题 token 载荷：`themeId` 空串表示"当前没有主题扩展" */
export interface ThemeTokensPayload {
  themeId: string
  tokens: Record<string, string>
}

/** token 名校验：与 `appTheme.ts` 的 `isTokenName` 同一规则（`--` + 小写字母/数字/连字符） */
const TOKEN_NAME_RE = /^--[a-z0-9-]+$/

/**
 * 校验一份来自 IPC 的载荷。
 *
 * 跨进程边界必须验：渲染进程被攻破/写错时不能让它往 documentElement 上写任意属性
 * （`style.setProperty('background', ...)` 这类非 token 属性会被这里挡掉）。
 */
export function isThemeTokensPayload(value: unknown): value is ThemeTokensPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.themeId !== 'string') return false
  if (!v.tokens || typeof v.tokens !== 'object') return false
  for (const [name, tokenValue] of Object.entries(v.tokens as Record<string, unknown>)) {
    if (!TOKEN_NAME_RE.test(name)) return false
    if (typeof tokenValue !== 'string') return false
  }
  return true
}

/**
 * 把 token 写到某个文档的 `documentElement` 上（内联样式，优先级高于页面自己的 `:root` 规则）。
 *
 * - `payload === null`：清掉本模块上次写过的全部 token（主题被卸载时用）；
 * - 只写 `--x` 形状的名字，其它一律忽略（双保险，`isThemeTokensPayload` 已经挡过一次）；
 * - 返回**实际写入的 token 数**，便于测试与日志断言；
 * - 任何 DOM 异常都吞掉：主题下发失败不该让页面白屏或让 preload 抛错。
 */
export function applyThemeTokens(
  doc:
    | {
        documentElement?: {
          style?: {
            setProperty(name: string, value: string): void
            removeProperty(name: string): void
          }
        }
      }
    | null
    | undefined,
  payload: ThemeTokensPayload | null,
  previous: readonly string[] = []
): string[] {
  const style = doc?.documentElement?.style
  if (!style) return [...previous]
  const applied: string[] = []
  try {
    for (const name of previous) {
      if (!name.startsWith('--')) continue
      style.removeProperty(name)
    }
    if (payload) {
      for (const [name, value] of Object.entries(payload.tokens)) {
        if (!TOKEN_NAME_RE.test(name)) continue
        if (typeof value !== 'string' || value.trim() === '') continue
        style.setProperty(name, value)
        applied.push(name)
      }
    }
  } catch {
    // 文档已销毁 / style 不可写：忽略
  }
  return applied
}
