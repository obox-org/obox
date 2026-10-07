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
  MenuContribution,
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

/** 注册的上下文菜单项（挂到该扩展 App 卡片右键） */
export interface RegisteredMenu extends MenuContribution {
  extensionId: string
  active: boolean
}

class Registry {
  readonly navItems = reactive<RegisteredNavItem[]>([])
  readonly statusBarItems = reactive<RegisteredStatusBarItem[]>([])
  readonly commands = reactive<RegisteredCommand[]>([])
  readonly menus = reactive<RegisteredMenu[]>([])
  /** 视图组件表：view id → Vue 组件（扩展激活时登记） */
  readonly viewComponents = new Map<string, Component>()
  private commandIndex = new Map<string, RegisteredCommand>()

  // ---- 注册（宿主启动阶段，manifest 声明） ----

  registerNavItem(extensionId: string, c: NavItemContribution): void {
    // 按 id 原地更新：覆盖安装/热重载会重复注册，直接 push 会让数组无限增长
    const existing = this.navItems.find((i) => i.id === c.id)
    if (existing) {
      Object.assign(existing, c, { group: c.group ?? 'top', extensionId, active: true })
      return
    }
    this.navItems.push({ ...c, group: c.group ?? 'top', extensionId, active: true })
  }

  /** 动态状态栏项（api.statusBar.createItem 创建；id 宿主生成，按扩展隔离） */
  private runtimeSeq = 0
  readonly runtimeStatusBarItems = reactive<RegisteredStatusBarItem[]>([])

  createRuntimeStatusBarItem(
    extensionId: string,
    init?: { text?: string; tooltip?: string; alignment?: 'left' | 'right'; priority?: number }
  ): RegisteredStatusBarItem {
    const id = `runtime:${extensionId}:${++this.runtimeSeq}`
    const item: RegisteredStatusBarItem = {
      id,
      name: id,
      text: init?.text ?? '',
      tooltip: init?.tooltip,
      alignment: init?.alignment ?? 'right',
      priority: init?.priority ?? 0,
      extensionId,
      visible: true,
      active: true
    }
    this.runtimeStatusBarItems.push(item)
    return item
  }

  /** 移除某扩展的全部动态状态栏项（停用时调用） */
  removeRuntimeStatusBarItems(extensionId: string): void {
    for (let i = this.runtimeStatusBarItems.length - 1; i >= 0; i--) {
      if (this.runtimeStatusBarItems[i].extensionId === extensionId) {
        this.runtimeStatusBarItems.splice(i, 1)
      }
    }
  }

  registerStatusBarItem(extensionId: string, c: StatusBarItemContribution): void {
    // 按 id 原地更新（同 registerNavItem：避免覆盖安装导致条目堆积）
    const existing = this.statusBarItems.find((i) => i.id === c.id)
    if (existing) {
      Object.assign(existing, c, {
        extensionId,
        text: c.text ?? '',
        visible: true,
        active: true
      })
      return
    }
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

  registerMenu(extensionId: string, c: MenuContribution): void {
    this.menus.push({ ...c, extensionId, active: true })
  }

  /** 某扩展的激活菜单项（App 卡片右键用） */
  getMenusFor(extensionId: string): RegisteredMenu[] {
    return this.menus.filter((m) => m.active && m.extensionId === extensionId && m.when !== 'false')
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
    for (const menu of this.menus) {
      if (menu.extensionId === extensionId) menu.active = false
    }
  }

  /**
   * 卸载 / 热移除时的**物理清理**：把该扩展的贡献项从注册表真正删除。
   *
   * 与 `deactivateExtension`（仅标记 active=false，禁用等场景需要保留条目）分开：
   * 卸载/覆盖安装必须物理移除，否则——
   * - 同 id 命令永久占据 commandIndex：重装声明同 id 的扩展被当重复丢弃、handler 绑到旧条目
   * - 导航项/状态栏项数组随每次覆盖安装无限增长（内存与渲染泄漏）
   */
  unregisterExtension(extensionId: string): void {
    const dropByExt = <T extends { extensionId: string }>(arr: T[]): void => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].extensionId === extensionId) arr.splice(i, 1)
      }
    }
    dropByExt(this.navItems)
    dropByExt(this.statusBarItems)
    dropByExt(this.commands)
    dropByExt(this.menus)
    for (const [id, cmd] of [...this.commandIndex]) {
      if (cmd.extensionId === extensionId) this.commandIndex.delete(id)
    }
    this.removeRuntimeStatusBarItems(extensionId)
  }

  // ---- 命令实现绑定（扩展激活时） ----

  setCommandHandler(
    id: string,
    handler: (...args: unknown[]) => unknown,
    extensionId?: string
  ): Disposable {
    const cmd = this.commandIndex.get(id)
    if (!cmd) throw new Error(`command not declared: ${id}`)
    // 归属校验：命令 id 全局唯一，只允许声明它的扩展绑定实现——
    // 否则后激活的扩展可用同名命令把 handler 绑到别人的命令项上（静默劫持）
    if (extensionId && cmd.extensionId !== extensionId) {
      console.warn(
        `[registry] 命令 ${id} 由扩展 ${cmd.extensionId} 声明，${extensionId} 不能绑定其实现`
      )
      return { dispose: (): void => {} }
    }
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
    for (const viewId of viewIds) {
      // 内置共享组件（如树视图所有贡献点共用的 'obox.tree'）不能随单个扩展移除，
      // 否则其它扩展的树视图会一并失效直至重启
      if (viewId.startsWith('obox.')) continue
      this.viewComponents.delete(viewId)
    }
  }

  // ---- 查询（UI 消费） ----

  getNavItems(group: 'top' | 'bottom'): RegisteredNavItem[] {
    return this.navItems.filter((i) => i.active && (i.group ?? 'top') === group)
  }

  getVisibleStatusBarItems(alignment: 'left' | 'right'): RegisteredStatusBarItem[] {
    const all = [...this.statusBarItems, ...this.runtimeStatusBarItems]
    return all
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
