/**
 * 应用状态持久化（userData JSON）。
 * - disabledExtensions: 禁用列表（缺省即启用模型）
 * - notificationDisabledExtensions: 通知关闭列表（设置-通知逐扩展关闭，缺省即开启）
 * - lastActiveNavId: 上次激活的导航项 id（重启恢复）
 * - memento: 每扩展命名空间的 Memento 存储（workspaceState/globalState 共用一处，分命名空间）
 * - settings: 统一设置存储（主题/快捷键/扩展设置等，key-value）
 *
 * 通过 window.api 无法直接读写 userData 文件（能力面未开放通用 fs），
 * 因此状态经 localStorage 持久化——Electron 渲染进程 localStorage 落在 userData 下。
 */
const STORAGE_KEY = 'obox:state:v1'

interface PersistedState {
  disabledExtensions: string[]
  notificationDisabledExtensions: string[]
  lastActiveNavId: string | null
  memento: Record<string, Record<string, unknown>>
  settings: Record<string, unknown>
}

const state: PersistedState = load()

function load(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {
        disabledExtensions: [],
        notificationDisabledExtensions: [],
        lastActiveNavId: null,
        memento: {},
        settings: {}
      }
    }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    return {
      disabledExtensions: Array.isArray(parsed.disabledExtensions) ? parsed.disabledExtensions : [],
      notificationDisabledExtensions: Array.isArray(parsed.notificationDisabledExtensions)
        ? parsed.notificationDisabledExtensions
        : [],
      lastActiveNavId: typeof parsed.lastActiveNavId === 'string' ? parsed.lastActiveNavId : null,
      memento: parsed.memento && typeof parsed.memento === 'object' ? parsed.memento : {},
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}
    }
  } catch {
    return {
      disabledExtensions: [],
      notificationDisabledExtensions: [],
      lastActiveNavId: null,
      memento: {},
      settings: {}
    }
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (err) {
    console.error('[state] persist failed', err)
  }
}

/** 设置变更订阅（主题/语言/快捷键等变更时通知，供 UI 刷新） */
type SettingsListener = () => void
const settingsListeners = new Set<SettingsListener>()

export const stateStore = {
  get disabledExtensions(): string[] {
    return [...state.disabledExtensions]
  },
  isDisabled(id: string): boolean {
    return state.disabledExtensions.includes(id)
  },
  setDisabled(id: string, disabled: boolean): void {
    if (disabled && !state.disabledExtensions.includes(id)) {
      state.disabledExtensions.push(id)
      save()
    } else if (!disabled) {
      state.disabledExtensions = state.disabledExtensions.filter((x) => x !== id)
      save()
    }
  },
  /** 通知是否被该扩展关闭（设置-通知；缺省开启） */
  isNotificationDisabled(id: string): boolean {
    return state.notificationDisabledExtensions.includes(id)
  },
  setNotificationDisabled(id: string, disabled: boolean): void {
    if (disabled && !state.notificationDisabledExtensions.includes(id)) {
      state.notificationDisabledExtensions.push(id)
      save()
    } else if (!disabled) {
      state.notificationDisabledExtensions = state.notificationDisabledExtensions.filter(
        (x) => x !== id
      )
      save()
    }
  },
  get lastActiveNavId(): string | null {
    return state.lastActiveNavId
  },
  setLastActiveNavId(id: string): void {
    state.lastActiveNavId = id
    save()
  },
  /** 统一设置存储：读取设置值 */
  getSetting<T>(key: string, defaultValue?: T): T | undefined {
    return key in state.settings ? (state.settings[key] as T) : defaultValue
  },
  /** 统一设置存储：写入设置值（undefined 删除），并通知订阅者 */
  setSetting(key: string, value: unknown): void {
    if (value === undefined) delete state.settings[key]
    else state.settings[key] = value
    save()
    settingsListeners.forEach((l) => l())
  },
  /** 订阅设置变更，返回退订函数 */
  onSettingsChanged(listener: SettingsListener): () => void {
    settingsListeners.add(listener)
    return () => settingsListeners.delete(listener)
  },
  /** 触发设置变更通知（语言切换等场景） */
  emitSettingsChanged(): void {
    settingsListeners.forEach((l) => l())
  },
  /** Memento：按扩展 id 命名空间读写 */
  memento(extensionId: string): {
    keys(): string[]
    get<T>(key: string, defaultValue?: T): T | undefined
    update(key: string, value: unknown): Promise<void>
  } {
    const ns = state.memento[extensionId] ?? (state.memento[extensionId] = {})
    return {
      keys: () => Object.keys(ns),
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        key in ns ? (ns[key] as T) : defaultValue,
      update: async (key, value) => {
        if (value === undefined) delete ns[key]
        else ns[key] = value
        save()
      }
    }
  }
}
