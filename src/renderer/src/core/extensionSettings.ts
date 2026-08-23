/**
 * 扩展设置页注册表：api.settings.register 注册的设置页（显示在设置"扩展"节点）。
 */
import { reactive } from 'vue'
import type { SettingsPage } from './types'

export interface RegisteredSettingsPage extends SettingsPage {
  extensionId: string
}

class ExtensionSettingsStore {
  readonly pages = reactive<RegisteredSettingsPage[]>([])

  register(extensionId: string, page: SettingsPage): void {
    const existing = this.pages.find((p) => p.id === page.id)
    if (existing) {
      Object.assign(existing, page, { extensionId })
      return
    }
    this.pages.push({ ...page, extensionId })
  }

  /** 扩展停用时清理其设置页 */
  deactivateExtension(extensionId: string): void {
    for (let i = this.pages.length - 1; i >= 0; i--) {
      if (this.pages[i].extensionId === extensionId) this.pages.splice(i, 1)
    }
  }

  /** 按扩展 id 找设置页（扩展节点下按扩展名展开） */
  byExtension(extensionId: string): RegisteredSettingsPage[] {
    return this.pages.filter((p) => p.extensionId === extensionId)
  }

  /** 所有注册了设置的非内置扩展 id（按扩展名展开） */
  get extensionIds(): string[] {
    return [...new Set(this.pages.map((p) => p.extensionId))]
  }
}

export const extensionSettingsStore = new ExtensionSettingsStore()
