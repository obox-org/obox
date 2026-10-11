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

  /**
   * 上一次 `apply()` 写入 `:root` 的 token 键集合（issue #81）。
   * 切换主题时用它把「上一主题写过、本次不再声明」的键 `removeProperty` 掉，
   * 否则那些键会一直保留旧主题的行内值、回不到 `assets/main.css` 的默认值。
   * 时序：首启为空集（不删任何键）｜同一主题重复 apply（集合相同，不误删）｜
   * 只增不减（新主题声明更多键）→ 只写不删。
   */
  private appliedTokenKeys = new Set<string>()

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

  /**
   * 把主题 token 套到 `:root`；并清掉上一主题写入的、本次不再声明的键（issue #81）。
   *
   * 之前只 `setProperty`、从不 `removeProperty`：从"全量主题"切到"部分 token 主题"时，
   * 未声明的键会保留**上一个主题**的行内值，而不是回落到 `main.css` 的默认值——
   * App 子窗口的 token 快照（`collectThemeTokens` 读 `getComputedStyle` 生效值）与
   * 主题声明值因此会不一致地"继承"旧主题。
   */
  apply(theme: RegisteredTheme): void {
    const root = document.documentElement
    const nextKeys = new Set<string>()
    for (const [key, value] of Object.entries(theme.tokens)) {
      nextKeys.add(key)
      root.style.setProperty(key, value)
    }
    for (const key of this.appliedTokenKeys) {
      if (!nextKeys.has(key)) root.style.removeProperty(key)
    }
    this.appliedTokenKeys = nextKeys
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
