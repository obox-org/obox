/**
 * i18n 模块：vue-i18n 实例 + 语言切换 + 持久化 + 本地化显示名。
 * 语言下拉框显示各语言自己的本地化名称（中文 → "中文"，English → "English"）。
 *
 * **语言的唯一来源是设置项**（change `unified-page-context` 任务 5.1）：`stateStore` 的
 * `locale` 键。旧版本把语言存在 localStorage 的 `obox:locale:v1` 里，升级时读一次并迁移，
 * 之后不再读旧键（避免"设置改了、旧键还在、重启又变回去"）。
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

/** 设置里的语言键（与主题同一层：`stateStore.getSetting('locale')`） */
export const LOCALE_SETTING_KEY = 'locale'

/** 旧版本的 localStorage 键（只读一次用于迁移；迁移后删除） */
export const LEGACY_LOCALE_STORAGE_KEY = 'obox:locale:v1'

/** 是否是宿主支持的语言 */
export function isSupportedLocale(value: unknown): value is LocaleCode {
  return value === 'zh' || value === 'en'
}

/**
 * 解析初始语言（纯函数，便于单测）：
 *
 * 1. 设置里的合法值（新位置）；
 * 2. 旧 localStorage 键里的合法值（只用于升级迁移，标记 `migratedFromLegacy`）；
 * 3. 都不合法/不存在 → `zh`（现有默认；不跟随系统语言，避免"系统英文 → 界面半中半英"）。
 */
export function resolveInitialLocale(
  storedSetting: unknown,
  legacyValue: unknown
): { code: LocaleCode; migratedFromLegacy: boolean } {
  if (isSupportedLocale(storedSetting)) return { code: storedSetting, migratedFromLegacy: false }
  if (isSupportedLocale(legacyValue)) return { code: legacyValue, migratedFromLegacy: true }
  return { code: 'zh', migratedFromLegacy: false }
}

function readLegacyLocale(): string | null {
  try {
    return localStorage.getItem(LEGACY_LOCALE_STORAGE_KEY)
  } catch {
    return null
  }
}

function removeLegacyLocale(): void {
  try {
    localStorage.removeItem(LEGACY_LOCALE_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

const legacyValue = readLegacyLocale()
const initial = resolveInitialLocale(stateStore.getSetting(LOCALE_SETTING_KEY), legacyValue)
if (initial.migratedFromLegacy) {
  // 迁移写回：之后所有读取都只认设置项
  stateStore.setSetting(LOCALE_SETTING_KEY, initial.code)
}
// 旧键只读这一次：即便设置项已经存在，也顺手清掉，避免"设置改了、旧键还在"的困惑
if (legacyValue !== null) removeLegacyLocale()

export const i18n = createI18n({
  legacy: false,
  locale: initial.code,
  fallbackLocale: 'zh',
  messages: { zh, en }
})

/**
 * 把已生效的语言推给主进程（托盘/关窗/关于跟随设置；change `unified-page-context` 5.3）。
 *
 * 主进程听不到渲染侧的 localStorage 设置，只能由渲染侧主动推（与 `proxy:apply` 同款模式）。
 * 任何异常都吞掉：语言同步失败不该影响界面渲染；下一次切换会再推。
 */
function pushLocaleToMain(code: LocaleCode): void {
  if (typeof window === 'undefined') return
  try {
    const api = window.api as { applyLocale?: (locale: LocaleCode) => Promise<unknown> } | undefined
    if (typeof api?.applyLocale === 'function') void api.applyLocale(code)
  } catch {
    /* ignore */
  }
}

// 首帧即同步一次：用户看到托盘语言与应用语言一致，不必等第一次切换
pushLocaleToMain(initial.code)

/**
 * 当前语言代码（响应式）。
 *
 * **优先读设置项**：App 子窗口/overlay 通过 `storage` 事件合并主窗口写入的设置（`applyExternal`），
 * 它们自己的 vue-i18n 实例可能还没切（各窗口各一份模块实例）。页面上下文/宿主快照都问这个函数，
 * 以设置为准才能让"主窗口切语言 → 子窗口页面的 `obox:context`"立刻带上新语言。
 * 设置项还没写过（全新安装）时回退 vue-i18n 的当前值。
 */
export function currentLocale(): LocaleCode {
  const saved = stateStore.getSetting(LOCALE_SETTING_KEY)
  if (isSupportedLocale(saved)) return saved
  return i18n.global.locale.value as LocaleCode
}

/**
 * 跨窗口语言同步（子窗口视角）：主窗口写设置 → `storage` 事件 → `stateStore.applyExternal`
 * 同步通知订阅者。这里同步本窗口的 vue-i18n，否则子窗口外壳自己的 `t()` 仍是旧语言
 * （真机缺陷：App 卡片窗口标题/壳子文案不跟着切）。
 */
stateStore.onSettingsChanged((key) => {
  if (key !== LOCALE_SETTING_KEY) return
  const saved = stateStore.getSetting(LOCALE_SETTING_KEY)
  if (!isSupportedLocale(saved)) return
  if (saved === i18n.global.locale.value) return
  i18n.global.locale.value = saved
  pushLocaleToMain(saved)
})

/**
 * 切换语言：先切 vue-i18n，再写设置（持久化 + 通知订阅者，key = `locale`）。
 *
 * **顺序不能反**（change `unified-page-context` 真机缺陷，与主题同型）：`stateStore.setSetting`
 * 会**同步**通知订阅者——`ContentArea` 在这时读 `currentLocale()` 组装 `obox:context` 推给页面、
 * 扩展宿主也在这时取快照。若先写设置后切 vue-i18n，推出去的是**上一个**语言（切英文后页面仍是
 * 中文、切回中文才变英文）。所以先让 `currentLocale()` 变成新值，再通知。
 */
export function setLocale(code: LocaleCode): void {
  if (!isSupportedLocale(code)) return
  i18n.global.locale.value = code
  stateStore.setSetting(LOCALE_SETTING_KEY, code)
  removeLegacyLocale()
  pushLocaleToMain(code)
}

/** 按 code 找语言显示名 */
export function localeDisplayName(code: LocaleCode): string {
  return LOCALES.find((l) => l.code === code)?.displayName ?? code
}
