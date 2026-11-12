/**
 * 渲染进程侧的**页面上下文组装器**（change `unified-page-context` 任务 1.2）。
 *
 * 职责：把"当前主题（全部主题 token 的生效值 + colorScheme）"与"当前语言 + 该扩展的词条"装成一条
 * `obox:context`（形状与校验在 `src/shared/pageContext.ts`），并负责投递。
 *
 * 为什么单独成文件：组装需要读三个单例（themeStore / i18n / extensionI18n），而**纯逻辑**
 * （清洗、colorScheme 解析、形状校验）已在 shared 里；这里只做"读真相 + 投递"，便于用注入的
 * 假依赖单测（不依赖真实 Vue/DOM 单例）。
 */
import {
  buildPageContext,
  isContextRequest,
  PAGE_CONTEXT_REQUEST_TYPE,
  type PageContextMessage
} from '../../../shared/pageContext'
import { HOST_THEME_TOKEN_NAMES, collectThemeTokens } from './appTheme'
import { themeStore } from './theme'
import { currentLocale } from '../i18n'
import { getExtensionMessages } from './extensionI18n'

/** 组装上下文所需的四个真相来源（生产实现读单例；测试注入假件） */
export interface PageContextDeps {
  themeId: () => string
  /** 主题声明值（undefined = 未声明，按 id 推断） */
  declaredColorScheme: () => 'dark' | 'light' | undefined
  /** 全部主题 token（当前 26 个）的**生效值**（main.css 默认值 + 当前主题覆盖） */
  tokens: () => Record<string, string>
  locale: () => string
  /** 该扩展在当前语言下的整包词条（只给接收页面自己的） */
  messages: (extensionId: string) => Record<string, string>
}

/** 用注入的依赖构造 `(extensionId) => 上下文消息` */
export function createPageContextBuilder(
  deps: PageContextDeps
): (extensionId: string) => PageContextMessage {
  return (extensionId: string): PageContextMessage =>
    buildPageContext({
      themeId: deps.themeId(),
      colorScheme: deps.declaredColorScheme(),
      tokens: deps.tokens(),
      locale: deps.locale(),
      messages: deps.messages(extensionId)
    })
}

/**
 * 读宿主 `:root` 上的**生效** token 值。
 *
 * 为什么读 `getComputedStyle` 而不是主题声明：主题可能只声明部分 token，其余要回落到
 * `main.css` 默认值——页面要的是"宿主现在长什么样"这一份完整快照。
 * 任何异常（DOM 未就绪、node 单测无 `getComputedStyle`）都回空表，绝不抛错。
 */
export function readEffectiveTokens(): Record<string, string> {
  try {
    const root = document.documentElement
    return collectThemeTokens(
      (name) => getComputedStyle(root).getPropertyValue(name),
      HOST_THEME_TOKEN_NAMES
    )
  } catch {
    return {}
  }
}

/** 生产环境的组装器（单例读取真实状态） */
export const buildPageContextFor = createPageContextBuilder({
  themeId: () => themeStore.currentId,
  declaredColorScheme: () => themeStore.current?.colorScheme,
  tokens: readEffectiveTokens,
  locale: () => currentLocale(),
  messages: (extensionId) => getExtensionMessages(extensionId)
})

/** 能接单条消息的最小窗口形状（`Window` / iframe `contentWindow` 都满足） */
export type PostableWindow = {
  postMessage(message: unknown, targetOrigin: string): void
}

/** 向窗口发一条消息；窗口未就绪/已销毁时返回 false（投递失败不该影响宿主渲染） */
function postMessageSafe(win: PostableWindow | null | undefined, message: unknown): boolean {
  if (!win) return false
  try {
    win.postMessage(message, '*')
    return true
  } catch {
    return false
  }
}

/**
 * 向扩展页面投递 `obox:context`。
 *
 * @returns 是否真的发出（窗口未就绪/已销毁返回 false，调用方可据此重试）
 */
export function pushPageContext(
  win: PostableWindow | null | undefined,
  extensionId: string
): boolean {
  return postMessageSafe(win, buildPageContextFor(extensionId))
}

/**
 * 旧协议：系统扩展页面曾用 `{ type: 'obox-theme', tokens }` 收主题。
 *
 * 新宿主在**一个 minor 版本**内继续发它，让已发布的页面零改动；`tokens` 仍给 全部主题 token 的生效值
 * （旧页面自己会拼 `--`，历史 bug 保持原样，反正新页面不会再走这条）。
 */
export function buildLegacySystemThemeMessage(): {
  type: 'obox-theme'
  tokens: Record<string, string>
} {
  return { type: 'obox-theme', tokens: readEffectiveTokens() }
}

/**
 * 按兼容顺序投递：**旧协议先、`obox:context` 后**。
 *
 * 为什么顺序固定：旧页面会对未知消息静默忽略（文档已要求），先把认识的发过去能让它在首帧
 * 就拿到主题；新页面则忽略旧消息、等后面的上下文。反过来发会让老页面先收到不认识的消息，
 * 虽然也忽略，但首帧会多空一帧。
 *
 * @param legacyMessage 旧协议消息（系统页 `{type:'obox-theme'}` / App 卡片 `obox-app` 主题消息）；
 *                      传 `undefined` 表示不双发
 * @returns `obox:context` 是否发出
 */
export function pushWithLegacy(
  win: PostableWindow | null | undefined,
  extensionId: string,
  legacyMessage: unknown
): boolean {
  if (legacyMessage !== undefined) postMessageSafe(win, legacyMessage)
  return pushPageContext(win, extensionId)
}

/** 是否是页面发来的上下文请求（宿主侧判定，避免把任意消息都当请求重推） */
export function isPageContextRequest(data: unknown): boolean {
  return isContextRequest(data) && (data as { type?: unknown }).type === PAGE_CONTEXT_REQUEST_TYPE
}

/** 请求消息的常量转出（页面/宿主共用同一字面量，避免字符串漂移） */
export { PAGE_CONTEXT_REQUEST_TYPE }
