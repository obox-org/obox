/**
 * 应用状态持久化（userData JSON）。
 * - disabledExtensions: 禁用列表（缺省即启用模型）
 * - notificationDisabledExtensions: 通知关闭列表（设置-通知逐扩展关闭，缺省即开启）
 * - memento: 每扩展命名空间的 Memento 存储（workspaceState/globalState 共用一处，分命名空间）
 * - settings: 统一设置存储（主题/快捷键/扩展设置等，key-value）
 *
 * 通过 window.api 无法直接读写 userData 文件（能力面未开放通用 fs），
 * 因此状态经 localStorage 持久化——Electron 渲染进程 localStorage 落在 userData 下。
 *
 * 注：曾持久化 `lastActiveNavId`（重启恢复上次导航项），现已移除——
 * 启动视图改为**固定显示"应用"扩展**（见 core/startupView.ts），不再恢复上次选择；
 * 旧值留在 localStorage 里也无害（load() 不再读取该字段）。
 */
export const STORAGE_KEY = 'obox:state:v1'

/**
 * 「在独立进程中运行扩展」开关的设置键（EH-D2a）。
 *
 * 值只有三种有意义的状态：`true`（用户显式开）、`false`（用户显式关）、**键不存在**（从未设过）。
 * 解析优先级（设置 > 环境变量 > 默认开）由 `core/extensionHostBridge.ts` 的
 * `resolveExtensionHostSwitch()` 负责，这里只存"用户的显式选择"——存储层不掺业务判定。
 */
export const EXTENSION_HOST_SETTING_KEY = 'extensionHost.enabled'

export interface PersistedState {
  disabledExtensions: string[]
  notificationDisabledExtensions: string[]
  memento: Record<string, Record<string, unknown>>
  settings: Record<string, unknown>
}

/** 空快照（缺省即启用 / 无设置） */
function emptyState(): PersistedState {
  return {
    disabledExtensions: [],
    notificationDisabledExtensions: [],
    memento: {},
    settings: {}
  }
}

/**
 * 解析持久化快照（**纯函数**，不碰 localStorage）。
 * null / 空串 / 畸形 JSON / 结构不符 → 返回全空结构，绝不抛错。
 */
export function parsePersistedState(raw: string | null): PersistedState {
  if (!raw) return emptyState()
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState()
    return {
      disabledExtensions: Array.isArray(parsed.disabledExtensions) ? parsed.disabledExtensions : [],
      notificationDisabledExtensions: Array.isArray(parsed.notificationDisabledExtensions)
        ? parsed.notificationDisabledExtensions
        : [],
      memento: parsed.memento && typeof parsed.memento === 'object' ? parsed.memento : {},
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}
    }
  } catch {
    return emptyState()
  }
}

/** 设置项深比较（值可能是对象/数组，如快捷键映射） */
function sameSettingValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * 比较两份 settings，返回**发生变化**的 key 列表（新增 / 删除 / 值不同都算变化）。
 * 顺序 = before 的键序（新增键追加在后），便于测试断言稳定。
 */
export function diffSettingsKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const changed: string[] = []
  for (const key of Object.keys(before)) {
    if (!(key in after) || !sameSettingValue(before[key], after[key])) changed.push(key)
  }
  for (const key of Object.keys(after)) {
    if (!(key in before)) changed.push(key)
  }
  return changed
}

const state: PersistedState = load()

function load(): PersistedState {
  try {
    return parsePersistedState(localStorage.getItem(STORAGE_KEY))
  } catch {
    return emptyState()
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (err) {
    console.error('[state] persist failed', err)
  }
}

/** 设置变更订阅（主题/语言/快捷键等变更时通知，供 UI 刷新）；key = 变更的设置项（无具体 key 时为 undefined） */
type SettingsListener = (key?: string) => void
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
  /** 统一设置存储：读取设置值 */
  getSetting<T>(key: string, defaultValue?: T): T | undefined {
    return key in state.settings ? (state.settings[key] as T) : defaultValue
  },
  /**
   * 「在独立进程中运行扩展」的**显式设置值**（EH-D2a）。
   *
   * - `true` / `false`：用户亲手设过，开关解析里优先级最高（压过环境变量）；
   * - `undefined`：从未设过（键不存在 **或** 存值不是布尔）——交给解析器回落到环境变量/默认开。
   *
   * 为什么只认布尔：`'false'` / `0` / `null` 这类脏值若参与判定，"显式设过"这件事就有多种含义，
   * 优先级表会长出无数分支；统一按"未设过"处理，语义只剩一种。
   */
  getExtensionHostEnabled(): boolean | undefined {
    const value = state.settings[EXTENSION_HOST_SETTING_KEY]
    return typeof value === 'boolean' ? value : undefined
  },
  /**
   * 写「在独立进程中运行扩展」的显式设置值（EH-D2a）。
   *
   * **不做热切换**：调用方（设置页）只落库 + 提示"重启后生效"；生效判定在下次启动时由
   * `readExtensionHostSwitch()` 读取。
   */
  setExtensionHostEnabled(enabled: boolean): void {
    this.setSetting(EXTENSION_HOST_SETTING_KEY, enabled)
  },
  /** 统一设置存储：写入设置值（undefined 删除），并通知订阅者（带变更的 key） */
  setSetting(key: string, value: unknown): void {
    if (value === undefined) delete state.settings[key]
    else state.settings[key] = value
    save()
    settingsListeners.forEach((l) => l(key))
  },
  /** 订阅设置变更，返回退订函数 */
  onSettingsChanged(listener: SettingsListener): () => void {
    settingsListeners.add(listener)
    return () => settingsListeners.delete(listener)
  },
  /** 触发设置变更通知（语言切换等场景，无具体 key） */
  emitSettingsChanged(): void {
    settingsListeners.forEach((l) => l())
  },
  /**
   * 合并**另一个窗口**写入的快照（跨窗口主题同步，见 ADR-0022 / 设计 §2.7.4）。
   *
   * 语义：整体替换四个字段（子窗口从不写 localStorage ⇒ 单写者，无冲突；设计 §11.2 R11），
   * 然后对**变化了的 settings key** 逐个通知订阅者；无变化则不通知、不写回。
   * 畸形快照（`'{'` / `'null'` / `'[]'`）由 `parsePersistedState` 兜成全空结构——
   * 此时四个字段都被替换为空，调用方（`storage` 监听）只在 `newValue` 为 string 时调用。
   *
   * @returns 发生变化的 settings key 列表
   */
  applyExternal(raw: string): string[] {
    const next = parsePersistedState(raw)
    const changed = diffSettingsKeys(state.settings, next.settings)
    state.settings = next.settings
    state.disabledExtensions = next.disabledExtensions
    state.notificationDisabledExtensions = next.notificationDisabledExtensions
    state.memento = next.memento
    for (const key of changed) settingsListeners.forEach((l) => l(key))
    return changed
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

/**
 * 跨窗口设置同步（浏览器侧专用）：两个窗口同源同 session ⇒ 共享 localStorage，
 * `storage` 事件是 Chromium 提供的跨文档通知通道（本仓库自 ADR-0022 起依赖它）。
 *
 * - 只在**浏览器**环境安装（node 单测环境没有 `window`，模块照常可 import）；
 * - 只处理本 key；`storage` 事件只在**其它**文档写入时触发，本窗口 `save()` 不会自触发，
 *   因此不存在回环；
 * - 子窗口收到主窗口的主题快照后，AppWindow 会 `applyCurrent()` + 推送 token（设计 §2.7.4）。
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return
    if (typeof e.newValue !== 'string') return
    stateStore.applyExternal(e.newValue)
  })
}
