/**
 * 主题系统：收集主题扩展的 contributes.themes，套用/持久化当前主题。
 * 主题 token 是 CSS 变量组，套到 document.documentElement（:root）。
 */
import { reactive } from 'vue'
import type { ThemeContribution } from './types'
import { stateStore } from './state'

export interface RegisteredTheme extends ThemeContribution {
  extensionId: string
}

const THEME_SETTING_KEY = 'theme'

class ThemeStore {
  readonly themes = reactive<RegisteredTheme[]>([])

  register(extensionId: string, theme: ThemeContribution): void {
    const existing = this.themes.find((t) => t.id === theme.id)
    if (existing) {
      // 重复 id：更新（热重载场景）
      Object.assign(existing, theme, { extensionId })
      return
    }
    this.themes.push({ ...theme, extensionId })
  }

  /** 当前主题 id（设置存储，缺省第一个主题或 'theme-dark.dark'） */
  get currentId(): string {
    const saved = stateStore.getSetting<string>(THEME_SETTING_KEY)
    if (saved && this.themes.some((t) => t.id === saved)) return saved
    // 缺省：dark（第一个注册的主题，或约定 id）
    const dark = this.themes.find((t) => t.id.includes('dark'))
    return dark?.id ?? this.themes[0]?.id ?? ''
  }

  get current(): RegisteredTheme | undefined {
    return this.themes.find((t) => t.id === this.currentId)
  }

  /** 选择主题：套用 CSS 变量 + 持久化 */
  setTheme(id: string): void {
    const theme = this.themes.find((t) => t.id === id)
    if (!theme) return
    stateStore.setSetting(THEME_SETTING_KEY, id)
    this.apply(theme)
  }

  /** 把主题 token 套到 :root */
  apply(theme: RegisteredTheme): void {
    const root = document.documentElement
    for (const [key, value] of Object.entries(theme.tokens)) {
      root.style.setProperty(key, value)
    }
  }

  /** 应用当前持久化主题（启动时调用） */
  applyCurrent(): void {
    const theme = this.current
    if (theme) this.apply(theme)
  }

  /** 供子窗口注入：当前主题的 token 组 */
  get currentTokens(): Record<string, string> {
    return this.current?.tokens ?? {}
  }
}

export const themeStore = new ThemeStore()
