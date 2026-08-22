/**
 * App（应用）扩展的插件卡片注册表。
 * - reactive：App 视图实时渲染
 * - 持久化：经 localStorage 共享，子窗口按 appId 查找注册信息
 * - 清理：扩展停用时注销其卡片；register 返回注销函数
 */
import { reactive } from 'vue'
import type { AppRegistration, Disposable } from './types'

export interface RegisteredApp extends AppRegistration {
  /** 注册它的扩展 id */
  extensionId: string
  /** 是否仍有效（扩展停用后 false，App 视图灰显或移除） */
  active: boolean
}

const STORAGE_KEY = 'obox:app-registry:v1'

function loadPersisted(): RegisteredApp[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as RegisteredApp[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

class AppStore {
  readonly items = reactive<RegisteredApp[]>(loadPersisted())
  private index = new Map<string, RegisteredApp>()

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items))
    } catch (err) {
      console.error('[app] persist failed', err)
    }
  }

  /** 扩展调用 api.app.register 注册卡片 */
  register(extensionId: string, registration: AppRegistration): Disposable {
    const existing = this.index.get(registration.id)
    if (existing) {
      // 重复 id：更新而非新建（扩展热重载场景）
      Object.assign(existing, registration, { extensionId, active: true })
      this.persist()
      return { dispose: () => this.unregister(registration.id) }
    }
    const item: RegisteredApp = { ...registration, extensionId, active: true }
    this.items.push(item)
    this.index.set(item.id, item)
    this.persist()
    return { dispose: () => this.unregister(item.id) }
  }

  private unregister(id: string): void {
    const idx = this.items.findIndex((i) => i.id === id)
    if (idx >= 0) {
      this.items.splice(idx, 1)
      this.index.delete(id)
      this.persist()
    }
  }

  /** 扩展停用时清理其注册的全部卡片 */
  deactivateExtension(extensionId: string): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].extensionId === extensionId) {
        this.index.delete(this.items[i].id)
        this.items.splice(i, 1)
      }
    }
    this.persist()
  }

  /** 子窗口按 appId 查找（读持久化 + 内存兜底） */
  findById(id: string): RegisteredApp | undefined {
    return this.items.find((i) => i.id === id && i.active) ?? this.index.get(id)
  }
}

export const appStore = new AppStore()
