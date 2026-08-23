/**
 * i18n 模块：vue-i18n 实例 + 语言切换 + 持久化 + 本地化显示名。
 * 语言下拉框显示各语言自己的本地化名称（中文 → "中文"，English → "English"）。
 */
import { createI18n } from 'vue-i18n'
import zh from './locales/zh'
import en from './locales/en'
import { stateStore } from '../core/state'

export type LocaleCode = 'zh' | 'en'

export interface LocaleInfo {
  code: LocaleCode
  /** 该语言自己语言的显示名（本地化名称） */
  displayName: string
}

/** 语言列表：displayName 用各语言自己的名称 */
export const LOCALES: LocaleInfo[] = [
  { code: 'zh', displayName: '中文' },
  { code: 'en', displayName: 'English' }
]

const STORAGE_KEY = 'obox:locale:v1'

function loadLocale(): LocaleCode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'zh' || raw === 'en') return raw
  } catch {
    /* ignore */
  }
  // 跟随系统语言？首版固定中文（与现有 UI 一致）
  return 'zh'
}

export function persistLocale(code: LocaleCode): void {
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {
    /* ignore */
  }
}

export const i18n = createI18n({
  legacy: false,
  locale: loadLocale(),
  fallbackLocale: 'zh',
  messages: { zh, en }
})

/** 当前语言代码（响应式） */
export function currentLocale(): LocaleCode {
  return i18n.global.locale.value as LocaleCode
}

/** 切换语言并持久化（立即生效） */
export function setLocale(code: LocaleCode): void {
  i18n.global.locale.value = code
  persistLocale(code)
  // 触发设置状态变更（主题/语言同属设置系统）
  stateStore.emitSettingsChanged()
}

/** 按 code 找语言显示名 */
export function localeDisplayName(code: LocaleCode): string {
  return LOCALES.find((l) => l.code === code)?.displayName ?? code
}
