/**
 * 应用状态持久化（userData JSON）。
 * - disabledExtensions: 禁用列表（缺省即启用模型）
 * - lastActiveNavId: 上次激活的导航项 id（重启恢复）
 * - memento: 每扩展命名空间的 Memento 存储（workspaceState/globalState 共用一处，分命名空间）
 *
 * 通过 window.api 无法直接读写 userData 文件（能力面未开放通用 fs），
 * 因此状态经 localStorage 持久化——Electron 渲染进程 localStorage 落在 userData 下。
 */
const STORAGE_KEY = 'obox:state:v1'

interface PersistedState {
  disabledExtensions: string[]
  lastActiveNavId: string | null
  memento: Record<string, Record<string, unknown>>
}

const state: PersistedState = load()

function load(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { disabledExtensions: [], lastActiveNavId: null, memento: {} }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    return {
      disabledExtensions: Array.isArray(parsed.disabledExtensions) ? parsed.disabledExtensions : [],
      lastActiveNavId: typeof parsed.lastActiveNavId === 'string' ? parsed.lastActiveNavId : null,
      memento: parsed.memento && typeof parsed.memento === 'object' ? parsed.memento : {}
    }
  } catch {
    return { disabledExtensions: [], lastActiveNavId: null, memento: {} }
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (err) {
    console.error('[state] persist failed', err)
  }
}

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
  get lastActiveNavId(): string | null {
    return state.lastActiveNavId
  },
  setLastActiveNavId(id: string): void {
    state.lastActiveNavId = id
    save()
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
