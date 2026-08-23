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
  const dict = messages[locale] ?? messages.zh
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
