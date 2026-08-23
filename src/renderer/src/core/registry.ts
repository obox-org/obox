/**
 * 贡献点注册表：导航项 / 状态栏项 / 命令。
 * 宿主在"注册贡献点"阶段把 manifest 声明写入注册表，UI 组件消费注册表渲染。
 * 用 Vue reactive 保证 UI 响应式。
 */
import { reactive, markRaw } from 'vue'
import type { Component } from 'vue'
import type {
  CommandContribution,
  Disposable,
  NavItemContribution,
  StatusBarItemContribution
} from './types'

export interface RegisteredNavItem extends NavItemContribution {
  /** 贡献它的扩展 id */
  extensionId: string
  /** 运行时徽标（可被扩展更新） */
  badgeCount?: number
  /** 是否启用（扩展被禁用/停用时清除） */
  active: boolean
}

export interface RegisteredStatusBarItem extends StatusBarItemContribution {
  extensionId: string
  text: string
  tooltip?: string
  visible: boolean
  active: boolean
}

export interface RegisteredCommand extends CommandContribution {
  extensionId: string
  /** 命令实现（由扩展激活时注册；未注册时执行报错） */
  handler?: (...args: unknown[]) => unknown
  active: boolean
}

class Registry {
  readonly navItems = reactive<RegisteredNavItem[]>([])
  readonly statusBarItems = reactive<RegisteredStatusBarItem[]>([])
  readonly commands = reactive<RegisteredCommand[]>([])
  /** 视图组件表：view id → Vue 组件（扩展激活时登记） */
  readonly viewComponents = new Map<string, Component>()
  private commandIndex = new Map<string, RegisteredCommand>()

  // ---- 注册（宿主启动阶段，manifest 声明） ----

  registerNavItem(extensionId: string, c: NavItemContribution): void {
    this.navItems.push({ ...c, group: c.group ?? 'top', extensionId, active: true })
  }

  registerStatusBarItem(extensionId: string, c: StatusBarItemContribution): void {
    this.statusBarItems.push({
      ...c,
      extensionId,
      text: c.text ?? '',
      visible: true,
      active: true
    })
  }

  registerCommand(extensionId: string, c: CommandContribution): void {
    const cmd: RegisteredCommand = { ...c, extensionId, active: true }
    if (this.commandIndex.has(c.command)) {
      // 重复 id：保留第一个，记录冲突（宿主会写进该扩展的 validations）
      console.warn(`[registry] duplicate command id: ${c.command}`)
      return
    }
    this.commandIndex.set(c.command, cmd)
    this.commands.push(cmd)
  }

  // ---- 扩展停用：清除该扩展的贡献项 ----

  deactivateExtension(extensionId: string): void {
    for (const item of this.navItems) {
      if (item.extensionId === extensionId) item.active = false
    }
    for (const item of this.statusBarItems) {
      if (item.extensionId === extensionId) item.active = false
    }
    for (const cmd of this.commands) {
      if (cmd.extensionId === extensionId) {
        cmd.active = false
        cmd.handler = undefined
      }
    }
  }

  // ---- 命令实现绑定（扩展激活时） ----

  setCommandHandler(id: string, handler: (...args: unknown[]) => unknown): Disposable {
    const cmd = this.commandIndex.get(id)
    if (!cmd) throw new Error(`command not declared: ${id}`)
    cmd.handler = handler
    cmd.active = true
    return { dispose: () => (cmd.handler = undefined) }
  }

  // ---- 状态栏运行时 ----

  getStatusBarItem(id: string): RegisteredStatusBarItem | undefined {
    return this.statusBarItems.find((i) => i.id === id && i.active)
  }

  // ---- 导航徽标 ----

  setNavBadge(id: string, count: number | undefined): void {
    const item = this.navItems.find((i) => i.id === id)
    if (item) item.badgeCount = count
  }

  // ---- 视图组件 ----

  registerViewComponent(viewId: string, component: Component): void {
    this.viewComponents.set(viewId, markRaw(component))
  }

  /** 移除某扩展注册的视图组件（热移除/停用时调用） */
  removeViewComponents(extensionId: string): void {
    const viewIds = new Set<string>()
    for (const nav of this.navItems) {
      if (nav.extensionId === extensionId && nav.view) viewIds.add(nav.view)
    }
    for (const viewId of viewIds) this.viewComponents.delete(viewId)
  }

  // ---- 查询（UI 消费） ----

  getNavItems(group: 'top' | 'bottom'): RegisteredNavItem[] {
    return this.navItems.filter((i) => i.active && (i.group ?? 'top') === group)
  }

  getVisibleStatusBarItems(alignment: 'left' | 'right'): RegisteredStatusBarItem[] {
    return this.statusBarItems
      .filter((i) => i.active && i.visible && (i.alignment ?? 'right') === alignment)
      .sort((a, b) => {
        const pa = a.priority ?? 0
        const pb = b.priority ?? 0
        if (pa !== pb) return pb - pa
        return a.extensionId.localeCompare(b.extensionId)
      })
  }

  getPaletteCommands(): RegisteredCommand[] {
    return this.commands.filter((c) => c.active && c.palette !== false)
  }
}

export const registry = new Registry()
