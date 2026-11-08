/**
 * 扩展 i18n 语言包注册表：扩展经 api.i18n.registerMessages 或 manifest contributes.i18n 注册，
 * api.i18n.t 按当前语言查扩展自己的语言包（与宿主语言包独立命名空间）。
 */
import { i18n } from '../i18n'

interface ExtensionMessages {
  zh?: Record<string, string>
  en?: Record<string, string>
}

const stores = new Map<string, ExtensionMessages>()

/** 扩展注册语言包（extensionId 命名空间） */
export function registerExtensionMessages(extensionId: string, messages: ExtensionMessages): void {
  const merged = stores.get(extensionId) ?? {}
  stores.set(extensionId, {
    zh: { ...merged.zh, ...messages.zh },
    en: { ...merged.en, ...messages.en }
  })
}

/** 扩展注销时清理语言包 */
export function clearExtensionMessages(extensionId: string): void {
  stores.delete(extensionId)
}

/** 按扩展 + key 取当前语言的文案（缺省返回 key） */
export function translateExtension(
  extensionId: string,
  key: string,
  params?: Record<string, unknown>
): string {
  const messages = stores.get(extensionId)
  if (!messages) return key
  const locale = i18n.global.locale.value as 'zh' | 'en'
  // registerExtensionMessages 会为未提供的语言建**空对象**，因此不能简单用 `?? messages.zh`
  // （空对象不是 nullish），要按"该语言是否有条目"判断，才能真正回退到 zh
  const localized = messages[locale]
  const dict = localized && Object.keys(localized).length > 0 ? localized : messages.zh
  let text = dict?.[key]
  if (text === undefined) return key
  // 简单 {param} 替换
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}

/**
 * 取某扩展在指定语言的**整包**词条（change `unified-page-context`）：页面上下文要一次下发
 * 全部词条，让页面自己 `t(key)`，而不是每取一条就走一次消息。
 *
 * 回退语义与 {@link translateExtension} 一致：当前语言有词条就用它（缺 key 由页面回退 key），
 * 否则整包回退 `zh`——避免中英混排；返回**拷贝**，调用方改不到注册表。
 */
export function getExtensionMessages(
  extensionId: string,
  locale?: 'zh' | 'en'
): Record<string, string> {
  const messages = stores.get(extensionId)
  if (!messages) return {}
  const code = locale ?? (i18n.global.locale.value as 'zh' | 'en')
  const localized = messages[code]
  if (localized && Object.keys(localized).length > 0) return { ...localized }
  return { ...(messages.zh ?? {}) }
}
