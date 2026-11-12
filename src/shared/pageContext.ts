/**
 * 宿主 → 扩展页面的**统一运行时上下文**协议（纯模块：零 electron / 零 DOM，node 环境可单测）。
 *
 * ## 为什么要有它（change `unified-page-context`）
 *
 * 主体界面已是磁盘系统扩展的 HTML 页面，但"宿主当前是什么主题、什么语言"此前分成两条链路：
 * - App 卡片/overlay：`{ source:'obox-app', action:'obox-theme', themeId, tokens }`（全部主题 token 的生效值）；
 * - 系统 nav 页：`{ type:'obox-theme', tokens }`（只推主题**声明**值，且页面还多拼了一层 `--`）。
 *
 * 结果是同一份状态要写两套监听，且"主题到了、语言没到"成为合法中间态。本模块把状态收成**一条**
 * `obox:context` 消息：主题（`themeId` + `colorScheme` + 全部主题 token 的生效值）与语言（`locale` +
 * 该扩展自己的词条）一起下发，页面只需处理一份快照。
 *
 * ## 边界
 *
 * - 本文件只做「形状 / 校验 / 规范化」，不碰 DOM、不碰消息通道、不读主题或语言存储——
 *   组装在渲染进程（`src/renderer/src/core/pageContext.ts`），落地在页面运行时（`src/page-runtime/`）。
 * - **不校验 token 数量**：数量是宿主组装侧的契约（`HOST_THEME_TOKEN_NAMES`），
 *   这里只保证"名字合法、值非空"，避免把白名单抄成第三份。
 * - `messages` **只装本扩展自己的词条**：泄漏别人的词条等于跨扩展读数据（组装侧保证）。
 */

import { isThemeTokenName } from './themeTokens'

/** 宿主下发上下文的动作名（与旧协议 `obox-theme` 区分） */
export const PAGE_CONTEXT_TYPE = 'obox:context'

/** 页面请求重发上下文的动作名（首帧竞态兜底；无 requestId，不是请求-响应） */
export const PAGE_CONTEXT_REQUEST_TYPE = 'obox:context-request'

/**
 * 协议版本：宿主加字段时递增（只增不改的字段不递增）；页面按 `>=` 判断能否使用某字段。
 *
 * 为什么带版本：页面运行时可能在**旧宿主**上跑（扩展先于 obox 更新），需要能识别"这个宿主
 * 只支持 v1"并降级，而不是读一个 undefined 字段把页面渲染成空白。
 */
export const PAGE_CONTEXT_VERSION = 1

/** 原生控件/滚动条的深浅：页面据此设 `documentElement.style.colorScheme` */
export type PageColorScheme = 'dark' | 'light'

/** 宿主 → 扩展页面的上下文消息 */
export interface PageContextMessage {
  type: typeof PAGE_CONTEXT_TYPE
  version: number
  /** 当前主题 id（空串 = 没有主题扩展） */
  themeId: string
  colorScheme: PageColorScheme
  /** token 名（`--bg` 形式）→ 生效值；组装侧给的是 全部主题 token（当前 26 个）的完整快照 */
  tokens: Record<string, string>
  /** 当前界面语言（`zh` / `en`） */
  locale: string
  /** 该页面所属扩展自己的词条（当前语言；缺 key 由页面运行时回退） */
  messages: Record<string, string>
}

/** 页面 → 宿主：请求重发上下文 */
export interface PageContextRequestMessage {
  type: typeof PAGE_CONTEXT_REQUEST_TYPE
}

/** `buildPageContext` 的入参：比消息本体宽松（允许未规范化的值，函数负责清洗） */
export interface PageContextInput {
  themeId?: unknown
  colorScheme?: unknown
  tokens?: unknown
  locale?: unknown
  messages?: unknown
}

/**
 * 过滤 token 表：丢弃非法键名 / 非字符串值 / 空串/纯空白值，**不抛错**。
 *
 * 与 `themeTokens.isThemeTokensPayload` 同一条规则（复用 `isThemeTokenName`）：
 * 页面接受任何来源的上下文都先过这一层，避免把 `background` 这类非 token 属性写到 `:root`。
 */
export function sanitizeContextTokens(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isThemeTokenName(key)) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    out[key] = value
  }
  return out
}

/** 过滤词条表：只保留 `字符串键 → 非空字符串`，其余丢弃（不抛错） */
export function sanitizeContextMessages(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === '') continue
    if (typeof value !== 'string') continue
    out[key] = value
  }
  return out
}

/**
 * 解析原生控件深浅：**主题显式声明优先**，缺省才按 id 推断。
 *
 * 为什么不能只按 id 猜：主题 id 是人取的（`solarized` 是浅色却不含 `light`），猜错的表现是
 * 深色页面里出现白底黑字的原生下拉/滚动条。`colorScheme` 让主题作者能说清楚，旧主题走回退。
 */
export function resolveColorScheme(declared: unknown, themeId?: unknown): PageColorScheme {
  if (declared === 'light' || declared === 'dark') return declared
  return /light/i.test(typeof themeId === 'string' ? themeId : '') ? 'light' : 'dark'
}

/** 组装一条规范化后的上下文消息（宿主与单测共用；非法值就地清洗，不抛错） */
export function buildPageContext(input: PageContextInput): PageContextMessage {
  const themeId = typeof input.themeId === 'string' ? input.themeId : ''
  return {
    type: PAGE_CONTEXT_TYPE,
    version: PAGE_CONTEXT_VERSION,
    themeId,
    colorScheme: resolveColorScheme(input.colorScheme, themeId),
    tokens: sanitizeContextTokens(input.tokens),
    locale: typeof input.locale === 'string' && input.locale !== '' ? input.locale : 'zh',
    messages: sanitizeContextMessages(input.messages)
  }
}

/**
 * 形状校验（页面运行时与跨进程入口共用）。
 *
 * 只认必需字段的类型，**忽略未知字段**：宿主以后加字段不该让老页面运行时拒收整条消息
 * （那是"升级宿主把页面打白"的典型来源）。
 */
export function isPageContext(value: unknown): value is PageContextMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (v.type !== PAGE_CONTEXT_TYPE) return false
  if (typeof v.version !== 'number' || !Number.isFinite(v.version)) return false
  if (typeof v.themeId !== 'string') return false
  if (v.colorScheme !== 'dark' && v.colorScheme !== 'light') return false
  if (typeof v.locale !== 'string') return false
  if (!isPlainObject(v.tokens) || !isPlainObject(v.messages)) return false
  for (const [name, tokenValue] of Object.entries(v.tokens)) {
    if (!isThemeTokenName(name)) return false
    if (typeof tokenValue !== 'string') return false
  }
  for (const [key, messageValue] of Object.entries(v.messages)) {
    if (key === '' || typeof messageValue !== 'string') return false
  }
  return true
}

/** 是否是页面发出的上下文请求 */
export function isContextRequest(value: unknown): value is PageContextRequestMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return (value as Record<string, unknown>).type === PAGE_CONTEXT_REQUEST_TYPE
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
