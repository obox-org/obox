/**
 * App 卡片 / 子窗口页面地址的**判定与归一化**（change `fix-app-card-blank-page`）。
 *
 * 为什么需要它：卡片地址由扩展自己给，旧构建的扩展写的是
 * `new URL('./ui/index.html', import.meta.url).href`。宿主模式（2.0 起默认）下
 * `import.meta.url` 是 `file://…`，于是卡片地址变成 `file://`，而外壳 CSP 只允许
 * `default-src 'self' app:`（`frame-src` 回落到它）⇒ iframe 被整块拦掉，表现为**白色空白窗口**。
 *
 * 这里做两件事：
 * 1. **归一化**：把"落在扩展目录内"的 `file://` 地址映射为等价的 `app://` 地址，
 *    使已安装的旧扩展无需重发即可打开；
 * 2. **判定**：其余不可用地址返回原因码，供上层渲染诊断块（而不是白屏）。
 *
 * 边界（为什么只认形状、不猜）：
 * - 子窗口不激活扩展、拿不到扩展表，因此没有"目录名 → 扩展 id"的可靠映射；
 * - 猜错会把用户送到 404，比白屏更难排查。所以只在路径里出现 `extensions/<目录段>/` 时归一化，
 *   其余一律判定为不可用并说明原因。
 *
 * 纯函数、不依赖 DOM/electron，便于单测。
 */

/** `app://` 允许的 host（与 `src/main/appUrlCore.ts` 的命名空间一致） */
const APP_HOSTS = new Set(['extensions', 'builtin', 'debug'])

/** 不可用原因码（界面文案由 i18n 提供，`detail` 只用于日志与诊断展示） */
export type CardUrlReason =
  | 'empty'
  | 'invalid'
  | 'app-not-allowed'
  | 'unsupported-protocol'
  | 'file-not-extension'
  | 'unsafe-path'

export type CardUrlResult =
  | { kind: 'ok'; url: string }
  | { kind: 'normalized'; url: string; from: string }
  | { kind: 'unusable'; reason: CardUrlReason; detail?: string }

/**
 * 把 `app://` 地址判定为可用。
 *
 * 只做**形状**校验（协议 + host + 非空路径）：真正的落盘解析与越界拒绝仍在主进程
 * （`src/main/appUrlCore.ts`），这里再挡一层是为了不把明显非法的东西塞进 iframe。
 *
 * 为什么这里不查 `..`：`new URL()` 在解析阶段就把 `.` / `..`（含 `%2e%2e`）规范化掉了，
 * 传进来的 `pathname` 不可能再出现这些段——写了也是不可达的死代码。越界防护由主进程负责
 * （规范化后必须仍在扩展根之下，否则 403）。
 */
function checkAppUrl(url: URL, raw: string): CardUrlResult {
  if (!APP_HOSTS.has(url.hostname)) {
    return { kind: 'unusable', reason: 'app-not-allowed', detail: url.hostname }
  }
  const segments = url.pathname.replace(/^\/+/, '').split('/')
  if (segments.every((segment) => segment === '')) {
    return { kind: 'unusable', reason: 'file-not-extension', detail: raw }
  }
  return { kind: 'ok', url: raw }
}

/**
 * `file://` 地址归一化：路径里出现 `extensions/<目录段>/<余下…>` 时映射为
 * `app://extensions/<目录段>/<余下…>`；否则判定不可用（不猜归属）。
 *
 * 为什么用 `extensions` 这个段名：用户扩展与系统扩展都装在 `<根>/extensions/<安装目录名>/` 下
 * （`<根>` 可能是 `<userData>` 或安装目录），这是**唯一**在子窗口里也能看到的结构信息。
 */
function normalizeFileUrl(url: URL, raw: string): CardUrlResult {
  let segments: string[]
  try {
    // pathname 是百分号编码的；先整体解码再按段处理，输出时逐段重新编码（避免二次编码）
    segments = decodeURIComponent(url.pathname)
      .split(/[\\/]+/)
      .filter((s) => s !== '')
  } catch {
    return { kind: 'unusable', reason: 'invalid', detail: raw }
  }
  const at = segments.indexOf('extensions')
  // `extensions` 必须是**目录段**（后面至少还有"目录 + 文件"两段）
  if (at < 0 || segments.length < at + 3) {
    return { kind: 'unusable', reason: 'file-not-extension', detail: raw }
  }
  const rest = segments.slice(at + 1)
  const encoded = rest.map((segment) => encodeURIComponent(segment)).join('/')
  return { kind: 'normalized', url: `app://extensions/${encoded}`, from: raw }
}

/**
 * 判定一张卡片的页面地址。
 *
 * @param raw 卡片注册的 `url`（可能为空：空表示该卡片走 `html`/`srcdoc`，调用方不应把它当错误）
 */
export function normalizeCardUrl(raw: string | null | undefined): CardUrlResult {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return { kind: 'unusable', reason: 'empty' }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { kind: 'unusable', reason: 'invalid', detail: value }
  }

  if (url.protocol === 'app:') return checkAppUrl(url, value)
  if (url.protocol === 'file:') return normalizeFileUrl(url, value)

  return { kind: 'unusable', reason: 'unsupported-protocol', detail: url.protocol.replace(':', '') }
}

/** 供上层判断"这个结果能不能直接塞进 iframe" */
export function usableCardUrl(result: CardUrlResult): string | undefined {
  return result.kind === 'unusable' ? undefined : result.url
}
