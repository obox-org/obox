/**
 * 更新提供者扩展注册表。
 * - 扩展 manifest 声明 contributes.updater → 成为更新提供者候选
 * - 设置-更新页选择生效的一个（只能一个），存 stateStore.settings（key: update.provider）
 * - 无默认更新源：未选择时不检查更新
 */
import { reactive } from 'vue'
import { stateStore } from './state'

export interface UpdaterProvider {
  /** 扩展 id */
  extensionId: string
  /** 更新源 URL（manifest 声明或运行时提供） */
  feedUrl?: string
}

const PROVIDER_SETTING_KEY = 'update.provider'

class UpdaterStore {
  readonly providers = reactive<UpdaterProvider[]>([])

  register(extensionId: string, feedUrl?: string): void {
    const existing = this.providers.find((p) => p.extensionId === extensionId)
    if (existing) {
      existing.feedUrl = feedUrl ?? existing.feedUrl
      return
    }
    this.providers.push({ extensionId, feedUrl })
  }

  /** 扩展停用/移除时清理 */
  deactivateExtension(extensionId: string): void {
    const idx = this.providers.findIndex((p) => p.extensionId === extensionId)
    if (idx >= 0) this.providers.splice(idx, 1)
    // 若被移除的扩展是当前生效提供者，清除选择
    if (stateStore.getSetting(PROVIDER_SETTING_KEY) === extensionId) {
      stateStore.setSetting(PROVIDER_SETTING_KEY, undefined)
    }
  }

  /** 当前生效的更新提供者扩展 id（缺省无） */
  get activeId(): string | undefined {
    const saved = stateStore.getSetting<string>(PROVIDER_SETTING_KEY)
    if (saved && this.providers.some((p) => p.extensionId === saved)) return saved
    return undefined
  }

  /** 当前生效的提供者（含 feedUrl） */
  get active(): UpdaterProvider | undefined {
    const id = this.activeId
    return id ? this.providers.find((p) => p.extensionId === id) : undefined
  }

  /** 选择生效的更新提供者（只能一个） */
  setActive(extensionId: string | null): void {
    if (extensionId === null) {
      stateStore.setSetting(PROVIDER_SETTING_KEY, undefined)
      return
    }
    if (!this.providers.some((p) => p.extensionId === extensionId)) return
    stateStore.setSetting(PROVIDER_SETTING_KEY, extensionId)
  }

  /** 某扩展是否是更新提供者且当前生效 */
  isActive(extensionId: string): boolean {
    return this.activeId === extensionId
  }
}

export const updaterStore = new UpdaterStore()
