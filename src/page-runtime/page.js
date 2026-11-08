/**
 * obox 扩展页面运行时（宿主经 `app://obox/page.js` 提供；change `unified-page-context` 任务 3.1）。
 *
 * 页面里一行接入：
 *
 * ```html
 * <script type="module">
 *   import { startPageContext } from 'app://obox/page.js'
 *   startPageContext({
 *     onChange(ctx) {
 *       // ctx.tokens 已写进 :root、ctx.colorScheme 已设好
 *       document.body.textContent = ctx.t('hello')
 *     }
 *   })
 * </script>
 * ```
 *
 * 它负责四件**每个页面都会重复写错**的事：
 * 1. **首帧兜底**：启动时立刻写入暗色默认 token（同步，早于首次绘制），避免白屏/白闪；
 * 2. **跟随上下文**：收到 `obox:context` 时写 `:root` token、设 `colorScheme`、更新词条与 locale；
 * 3. **竞态兜底**：宿主可能在页面注册监听之前就推过一次，因此在 0/300/1000ms 主动请求重发，
 *    收到上下文即停（老宿主不会回，最后只 warn 一次并使用默认值）；
 * 4. **同值去重**：宿主连续推同一份状态时不再重复写 DOM、不再重复回调。
 *
 * 为什么是独立文件、而不是让页面各自写：上面四件事在三个系统扩展页与所有 `url` 型 App 卡片里
 * 逐字重复，且已出现过"页面多拼一层 `--`（写成 `----bg`）导致主题从未生效"的真实缺陷。
 *
 * 依赖约定：只用浏览器 API（`window` / `document` / `setTimeout`），**不 import 任何东西**；
 * 所有依赖都可从 `options` 注入，便于在 node 里用假件单测。
 */

/** 与 `src/shared/pageContext.ts` 保持一致的常量（页面运行时是浏览器脚本，不能 import TS） */
const CONTEXT_TYPE = 'obox:context'
const REQUEST_TYPE = 'obox:context-request'
const CONTEXT_VERSION = 1

/** 暗色默认 token（与 `main.css` 的 `:root` 一致；仅用于首帧兜底，随后会被宿主上下文覆盖） */
const DEFAULT_TOKENS = {
  '--bg': '#1e1e1e',
  '--bg-panel': '#252526',
  '--bg-sidebar': '#333333',
  '--bg-titlebar': '#323233',
  '--bg-input': '#3c3c3c',
  '--border': '#3c3c3c',
  '--fg': '#cccccc',
  '--fg-dim': '#6e6e6e',
  '--fg-bright': '#ffffff',
  '--fg-link': '#75beff',
  '--fg-error': '#f48771',
  '--fg-warning': '#cca700',
  '--fg-success': '#4ec9b0',
  '--accent': '#007acc',
  '--hover-bg': 'rgba(255, 255, 255, 0.1)',
  '--selection-bg': '#094771',
  '--nav-icon': '#858585',
  '--statusbar-bg': '#2a2a2a',
  '--statusbar-fg': '#cccccc',
  '--font-family':
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
  '--font-size': '13px',
  '--font-size-sm': '12px',
  '--font-size-lg': '16px',
  '--nav-icon-size': '24px',
  '--icon-size': '24px'
}

/** token 名规则：与 `shared/pageContext.ts` 同一条（`--` + 小写字母/数字/连字符） */
const TOKEN_NAME_RE = /^--[a-z0-9-]+$/

/** 请求重试时刻（毫秒）：宿主可能先推、页面后监听 */
const DEFAULT_REQUEST_DELAYS_MS = [0, 300, 1000]

/** 页面上下文快照（传给 `onChange`） */
function freezeContext(raw) {
  const tokens = raw && typeof raw.tokens === 'object' && raw.tokens ? raw.tokens : {}
  const messages = raw && typeof raw.messages === 'object' && raw.messages ? raw.messages : {}
  return {
    themeId: typeof raw?.themeId === 'string' ? raw.themeId : '',
    colorScheme: raw?.colorScheme === 'light' ? 'light' : 'dark',
    tokens: { ...tokens },
    locale: typeof raw?.locale === 'string' ? raw.locale : 'zh',
    messages: { ...messages }
  }
}

/** `{name}` 插值（与 `api.i18n.t` 的占位语法一致） */
function interpolate(text, params) {
  if (!params || typeof params !== 'object') return text
  let out = text
  for (const [key, value] of Object.entries(params)) {
    out = out.split(`{${key}}`).join(String(value))
  }
  return out
}

/** 消息形状判定：只认必需字段，未知字段忽略（宿主升级加字段不该让老页面拒收） */
export function isContextMessageShape(data) {
  if (!data || typeof data !== 'object') return false
  if (data.type !== CONTEXT_TYPE) return false
  if (typeof data.version !== 'number' || !Number.isFinite(data.version)) return false
  if (typeof data.themeId !== 'string') return false
  if (data.colorScheme !== 'dark' && data.colorScheme !== 'light') return false
  if (typeof data.locale !== 'string') return false
  if (!data.tokens || typeof data.tokens !== 'object' || Array.isArray(data.tokens)) return false
  if (!data.messages || typeof data.messages !== 'object' || Array.isArray(data.messages)) {
    return false
  }
  for (const [name, value] of Object.entries(data.tokens)) {
    if (!TOKEN_NAME_RE.test(name) || typeof value !== 'string') return false
  }
  for (const [key, value] of Object.entries(data.messages)) {
    if (key === '' || typeof value !== 'string') return false
  }
  return true
}

/**
 * 启动页面上下文。
 *
 * @param {{
 *   window?: Window & { parent?: unknown },
 *   document?: Document,
 *   onChange?: (ctx: ReturnType<typeof freezeContext>) => void,
 *   requestDelaysMs?: number[],
 *   warn?: (message: string) => void,
 *   now?: () => number,
 *   setTimeout?: typeof setTimeout,
 *   clearTimeout?: typeof clearTimeout
 * }} [options]
 * @returns {{ destroy: () => void, t: (key: string, params?: Record<string, unknown>) => string,
 *             getContext: () => ReturnType<typeof freezeContext> | null }}
 */
export function startPageContext(options = {}) {
  const win = options.window ?? (typeof window !== 'undefined' ? window : undefined)
  const doc = options.document ?? win?.document
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
  const requestDelays = Array.isArray(options.requestDelaysMs)
    ? options.requestDelaysMs
    : DEFAULT_REQUEST_DELAYS_MS
  const warn = typeof options.warn === 'function' ? options.warn : (m) => console.warn(m)
  const later = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = options.clearTimeout ?? ((id) => clearTimeout(id))

  const root = doc?.documentElement
  let appliedTokens = []
  let current = null
  let received = false
  let warnedMissingContext = false
  let warnedVersion = false
  let destroyed = false
  let lastSerialized = ''
  const timers = []
  let warnedKeys = new Set()

  /** 写 token：先清掉上次写过的、本次不再出现的键（与宿主同一条"只写不清会残留旧主题"的教训） */
  function applyTokens(tokens) {
    const style = root?.style
    if (!style) return 0
    const nextKeys = []
    for (const [name, value] of Object.entries(tokens || {})) {
      if (!TOKEN_NAME_RE.test(name)) continue
      if (typeof value !== 'string' || value.trim() === '') continue
      style.setProperty(name, value)
      nextKeys.push(name)
    }
    const next = new Set(nextKeys)
    for (const name of appliedTokens) {
      if (!next.has(name)) style.removeProperty(name)
    }
    appliedTokens = nextKeys
    return nextKeys.length
  }

  function applyColorScheme(scheme) {
    if (root?.style) root.style.colorScheme = scheme === 'light' ? 'light' : 'dark'
  }

  function t(key, params) {
    if (!current) return key
    const text = current.messages[key]
    if (text === undefined) {
      // 缺 key：回退 key 本身（与 api.i18n.t 一致），每个 key 只提醒一次
      if (!warnedKeys.has(key)) {
        warnedKeys.add(key)
        warn(`[page-runtime] 缺少词条：${key}（已回退为 key 本身）`)
      }
      return key
    }
    return interpolate(text, params)
  }

  /** 应用一条上下文（校验 → 去重 → 写 DOM → 通知） */
  function applyContext(data) {
    if (!isContextMessageShape(data)) return false
    const serialized = JSON.stringify({
      themeId: data.themeId,
      colorScheme: data.colorScheme,
      tokens: data.tokens,
      locale: data.locale,
      messages: data.messages
    })
    if (serialized === lastSerialized) return false
    lastSerialized = serialized
    received = true
    current = freezeContext(data)
    warnedKeys = new Set()
    applyTokens(current.tokens)
    applyColorScheme(current.colorScheme)
    onChange(current)
    return true
  }

  function requestContext() {
    if (destroyed) return
    const parent = win?.parent
    if (!parent || parent === win) return
    try {
      parent.postMessage({ type: REQUEST_TYPE }, '*')
    } catch {
      // 父窗口已销毁：忽略，下一次重试还有机会
    }
  }

  function onMessage(event) {
    if (destroyed) return
    const parent = win?.parent
    // 只接受父窗口（宿主）发来的消息：同文档里其它脚本伪造的 push 不该改页面主题
    if (parent && event.source && event.source !== parent) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    // 旧协议消息（`obox-theme`）在页面运行时里**静默忽略**：老宿主只发它，页面走默认值；
    // 新宿主同时发新协议，运行时只处理新协议。
    if (data.type !== CONTEXT_TYPE) return
    if (data.version > CONTEXT_VERSION) {
      // 未来版本：字段可能被改名，宁可不用也不要把页面渲染成空白
      if (!warnedVersion) {
        warnedVersion = true
        warn(
          `[page-runtime] 宿主上下文版本 ${data.version} 高于页面运行时 ${CONTEXT_VERSION}，已忽略`
        )
      }
      return
    }
    applyContext(data)
  }

  // 首帧兜底：同步写入默认 token（早于页面自己的首次绘制）
  applyTokens(DEFAULT_TOKENS)
  applyColorScheme('dark')

  win?.addEventListener?.('message', onMessage)

  for (const delay of requestDelays) {
    const timer = later(() => {
      if (destroyed || received) return
      requestContext()
      if (delay === requestDelays[requestDelays.length - 1] && !received && !warnedMissingContext) {
        warnedMissingContext = true
        warn('[page-runtime] 未收到宿主上下文（可能运行在旧版本 obox 上），已使用默认主题与语言')
      }
    }, delay)
    timers.push(timer)
  }

  return {
    destroy() {
      destroyed = true
      for (const timer of timers) cancel(timer)
      timers.length = 0
      win?.removeEventListener?.('message', onMessage)
    },
    t,
    getContext: () => (current ? freezeContext(current) : null)
  }
}
