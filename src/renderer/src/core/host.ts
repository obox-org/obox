/**
 * 扩展宿主：扫描 → 校验 → 注册贡献点（阶段一）→ 激活（阶段二）。
 * 基于 Cordis：root Context 承载宿主服务；每个扩展是一个插件（apply(ctx)）。
 */
import { Context } from '@cordisjs/core'
import type { Component } from 'vue'
import { registry } from './registry'
import { makeExtensionInfo, topoSort } from './manifest'
import { stateStore } from './state'
import { appStore } from './appStore'
import type {
  ExtensionActivationApi,
  ExtensionInfo,
  ExtensionManifest,
  ExtensionModule
} from './types'

/** 扩展条目（内置/用户统一形状） */
export interface ExtensionEntry {
  id: string
  manifest: ExtensionManifest
  load: () => Promise<ExtensionModule>
  /** 来源：内置（随应用打包，只读）/ 用户（userData，可卸载） */
  source: 'builtin' | 'user'
  /** 安装时间戳（用户扩展；.obox-meta.json 提供） */
  installedTimestamp?: number
}

/** 宿主启动配置 */
export interface HostOptions {
  builtins: ExtensionEntry[]
  userExtensions: ExtensionEntry[]
}

class ExtensionHost {
  private root: Context
  private extensions = new Map<string, ExtensionInfo>()
  private loaders = new Map<string, () => Promise<ExtensionModule>>()
  private cleanups = new Map<string, () => void>()
  private activated = new Set<string>()
  private barrierWaiters: Array<() => void> = []

  /** 宿主就绪：贡献点已注册完毕，UI 可查询 */
  readonly ready: Promise<void>

  constructor() {
    this.root = new Context()
    this.ready = new Promise((resolve) => this.barrierWaiters.push(resolve))
  }

  get rootContext(): Context {
    return this.root
  }

  listExtensions(): ExtensionInfo[] {
    return [...this.extensions.values()]
  }

  getExtension(id: string): ExtensionInfo | undefined {
    return this.extensions.get(id)
  }

  /** 阶段一：注册贡献点（barrier 释放前，UI 不消费注册表） */
  private registerContributions(ext: ExtensionInfo, module: ExtensionModule): void {
    const c = ext.manifest.contributes
    if (!c) return
    for (const nav of c.navItems ?? []) {
      if (nav.id && nav.title && nav.icon) registry.registerNavItem(ext.id, nav)
      else
        ext.validations.push({
          severity: 'warning',
          message: `导航项缺少 id/title/icon: ${JSON.stringify(nav)}`
        })
    }
    for (const sb of c.statusBarItems ?? []) {
      if (sb.id && sb.name) registry.registerStatusBarItem(ext.id, sb)
      else
        ext.validations.push({
          severity: 'warning',
          message: `状态栏项缺少 id/name: ${JSON.stringify(sb)}`
        })
    }
    for (const cmd of c.commands ?? []) {
      if (cmd.command && cmd.title) registry.registerCommand(ext.id, cmd)
      else
        ext.validations.push({
          severity: 'warning',
          message: `命令缺少 command/title: ${JSON.stringify(cmd)}`
        })
    }
    // 校验视图引用：导航项声明的 view 必须在扩展模块具名导出中存在
    for (const nav of c.navItems ?? []) {
      if (nav.view && !(nav.view in module)) {
        ext.validations.push({
          severity: 'warning',
          message: `导航项 ${nav.id} 声明的视图组件 ${nav.view} 未在扩展入口导出`
        })
      }
    }
  }

  /** 阶段二：激活扩展（按依赖拓扑序），构造扩展 API 并调用 apply(ctx) */
  private async activateExtension(ext: ExtensionInfo, module: ExtensionModule): Promise<void> {
    if (this.activated.has(ext.id)) return
    const plugin = module.default
    if (typeof plugin !== 'function') {
      ext.activationError = '扩展入口未导出 default 插件函数'
      ext.isActive = false
      return
    }

    // 视图组件导出表（导航项 view 引用）→ 登记进注册表
    for (const nav of ext.manifest.contributes?.navItems ?? []) {
      if (nav.view && nav.view in module) {
        registry.registerViewComponent(nav.view, module[nav.view] as Component)
      }
    }

    const disposables: Array<() => void> = []
    const api: ExtensionActivationApi = this.buildApi(ext, disposables)
    try {
      const result = plugin(api)
      if (typeof result === 'function') disposables.push(result)
      ext.isActive = true
      this.activated.add(ext.id)
      // 保存统一清理函数（热移除/停用时调用）
      this.cleanups.set(ext.id, () => {
        for (const d of disposables) {
          try {
            d()
          } catch (err) {
            console.warn(`[host] cleanup ${ext.id} error`, err)
          }
        }
        disposables.length = 0
      })
    } catch (err) {
      ext.activationError = err instanceof Error ? err.message : String(err)
      ext.isActive = false
      console.error(`[host] activate ${ext.id} failed`, err)
    }
  }

  private buildApi(ext: ExtensionInfo, disposables: Array<() => void>): ExtensionActivationApi {
    const mementoNs = stateStore.memento(ext.id)
    return {
      registerCommand: (id, handler) => {
        const found = registry.commands.find((c) => c.command === id && c.extensionId === ext.id)
        if (!found) {
          console.warn(
            `[host] ${ext.id} 注册了未声明的命令 ${id}（manifest contributes.commands 未包含）`
          )
        }
        return registry.setCommandHandler(id, handler)
      },
      executeCommand: async <T = unknown>(id: string, ...args: unknown[]): Promise<T> => {
        const cmd = registry.commands.find((c) => c.command === id)
        if (!cmd || !cmd.handler) throw new Error(`command not found: ${id}`)
        return (await cmd.handler(...args)) as T
      },
      statusBar: {
        setText: (id, text) => {
          const item = registry.getStatusBarItem(id)
          if (item) item.text = text
        },
        setTooltip: (id, tooltip) => {
          const item = registry.getStatusBarItem(id)
          if (item) item.tooltip = tooltip
        },
        show: (id) => {
          const item = registry.getStatusBarItem(id)
          if (item) item.visible = true
        },
        hide: (id) => {
          const item = registry.getStatusBarItem(id)
          if (item) item.visible = false
        }
      },
      navbar: {
        setBadge: (id, count) => registry.setNavBadge(id, count)
      },
      workspaceState: {
        keys: () => mementoNs.keys(),
        get: <T = unknown>(key: string, defaultValue?: T): T | undefined =>
          mementoNs.get<T>(key, defaultValue),
        update: async (key, value) => mementoNs.update(key, value)
      },
      globalState: {
        keys: () => mementoNs.keys(),
        get: <T = unknown>(key: string, defaultValue?: T): T | undefined =>
          mementoNs.get<T>(key, defaultValue),
        update: async (key, value) => mementoNs.update(key, value)
      },
      on: (event, listener) => {
        const handler = (...args: unknown[]): void => listener(...args)
        this.root.on(event as never, handler as never)
        const disposable = {
          dispose: (): void => {
            this.root.off(event as never, handler as never)
          }
        }
        disposables.push(() => disposable.dispose())
        return disposable
      },
      emit: (event, ...args) => {
        // Cordis 事件是类型化签名，扩展事件为运行时自由字符串，经 any 转发
        const ctx = this.root as unknown as {
          emit(name: string, ...rest: unknown[]): void
        }
        ctx.emit(event, ...args)
      },
      window: {
        minimize: () => window.api.windowAction('minimize'),
        toggleMaximize: () => window.api.windowAction('toggle-maximize'),
        close: () => window.api.windowAction('close'),
        isMaximized: async () => (await window.api.getWindowState())?.isMaximized ?? false
      },
      appInfo: {
        get: () => window.api.getAppInfo()
      },
      app: {
        register: (registration) => appStore.register(ext.id, registration)
      }
    }
  }

  /** 扫描并启动（主流程）：返回完整扩展列表 */
  async start(options: HostOptions): Promise<ExtensionInfo[]> {
    // ---- 1. 汇总扩展（内置 + 用户），跳过禁用项 ----
    const all: ExtensionInfo[] = []
    const entries: ExtensionEntry[] = [...options.builtins, ...options.userExtensions]

    for (const entry of entries) {
      const enabled = !stateStore.isDisabled(entry.id)
      const info = makeExtensionInfo(entry.id, entry.manifest, entry.source, enabled, {
        installedTimestamp: entry.installedTimestamp
      })
      all.push(info)
      if (enabled && info.isValid) this.loaders.set(entry.id, entry.load)
    }

    for (const ext of all) this.extensions.set(ext.id, ext)

    // ---- 2. 阶段一：注册贡献点（仅有效且启用的扩展）----
    for (const ext of all) {
      if (!ext.enabled || !ext.isValid) continue
      const load = this.loaders.get(ext.id)
      if (!load) continue
      try {
        const module = await load()
        this.registerContributions(ext, module)
      } catch (err) {
        ext.validations.push({
          severity: 'error',
          message: `入口加载失败: ${err instanceof Error ? err.message : String(err)}`
        })
      }
    }

    // ---- 3. 释放 barrier：UI 可查询注册表 ----
    this.barrierWaiters.forEach((w) => w())
    this.barrierWaiters = []

    // ---- 4. 阶段二：依赖拓扑序激活 ----
    const { ordered, cyclic } = topoSort(all.filter((e) => e.enabled && e.isValid))
    for (const ext of ordered) {
      const load = this.loaders.get(ext.id)
      if (!load) continue
      try {
        const module = await load()
        await this.activateExtension(ext, module)
      } catch (err) {
        ext.activationError = err instanceof Error ? err.message : String(err)
      }
    }

    // 状态摘要（开发期输出）
    console.log(
      `[host] 启动完成: ${all.length} 个扩展（${all.filter((e) => e.enabled).length} 启用 / ${
        all.filter((e) => !e.enabled).length
      } 禁用），激活 ${this.activated.size}，依赖环 ${
        cyclic.length ? cyclic.map((c) => c.id).join(',') : '无'
      }`
    )

    return all
  }
  /** 热安装：安装 .oix 后增量加载单个用户扩展（立即显示 + 立即激活，无需重启） */
  async loadUserExtension(entry: ExtensionEntry): Promise<ExtensionInfo> {
    const id = entry.id
    // 已存在（覆盖安装场景）：先清理旧实例再加载
    if (this.extensions.has(id)) {
      this.removeExtension(id)
    }

    const enabled = !stateStore.isDisabled(id)
    const info = makeExtensionInfo(id, entry.manifest, 'user', enabled, {
      installedTimestamp: entry.installedTimestamp
    })
    this.extensions.set(id, info)

    if (!enabled) {
      console.log(`[host] 热安装 ${id}：已禁用，仅展示不激活`)
      return info
    }
    if (!info.isValid) {
      console.log(`[host] 热安装 ${id}：清单无效，仅展示标红`)
      return info
    }

    // 注册贡献点
    try {
      const module = await entry.load()
      this.registerContributions(info, module)
    } catch (err) {
      info.validations.push({
        severity: 'error',
        message: `入口加载失败: ${err instanceof Error ? err.message : String(err)}`
      })
      return info
    }

    // 激活
    try {
      const module = await entry.load()
      await this.activateExtension(info, module)
    } catch (err) {
      info.activationError = err instanceof Error ? err.message : String(err)
    }

    console.log(
      `[host] 热安装完成: ${id} ${info.isActive ? '已激活' : '激活失败'}（贡献项已注册，立即可用）`
    )
    return info
  }

  /** 热移除：从宿主完全移除扩展（清理贡献项/视图/App 卡片/清理函数）。返回是否成功 */
  removeExtension(id: string): boolean {
    const ext = this.extensions.get(id)
    if (!ext) return false
    // 执行扩展注册的清理函数（命令 handler 清空、事件移除、App 卡片移除等）
    const cleanup = this.cleanups.get(id)
    if (cleanup) {
      try {
        cleanup()
      } catch (err) {
        console.warn(`[host] cleanup ${id} error`, err)
      }
      this.cleanups.delete(id)
    }
    // 注册表贡献项 + 视图组件 + App 卡片
    registry.deactivateExtension(id)
    registry.removeViewComponents(id)
    appStore.deactivateExtension(id)
    this.activated.delete(id)
    this.loaders.delete(id)
    this.extensions.delete(id)
    console.log(`[host] 热移除: ${id}`)
    return true
  }

  /** 判断扩展能否热移除（未激活 = 可立即热生效；已激活 = 需重启） */
  canHotRemove(id: string): boolean {
    return !this.activated.has(id)
  }

  /** 扩展管理：禁用/启用。未激活扩展立即热停用；已激活扩展标记需重启（UI 弹重启按钮） */
  setEnabled(id: string, enabled: boolean): { hot: boolean; needsRestart: boolean } {
    stateStore.setDisabled(id, !enabled)
    const ext = this.extensions.get(id)
    if (!ext) return { hot: false, needsRestart: false }
    ext.enabled = enabled
    if (enabled) {
      // 启用：当前设计不支持热启用已卸载的扩展，标记需重启
      ext.requiresRestart = true
      return { hot: false, needsRestart: true }
    }
    if (this.canHotRemove(id)) {
      // 未激活：立即热移除
      this.removeExtension(id)
      return { hot: true, needsRestart: false }
    }
    // 已激活：标记需重启
    ext.requiresRestart = true
    return { hot: false, needsRestart: true }
  }

  /** 卸载用户扩展（删目录由主进程执行；内置扩展不可卸载）。未激活立即热移除；已激活标记需重启 */
  async uninstall(id: string): Promise<{ hot: boolean; needsRestart: boolean }> {
    const ext = this.extensions.get(id)
    if (!ext) throw new Error(`extension not found: ${id}`)
    if (ext.source === 'builtin') throw new Error('内置扩展不可卸载')
    await window.api.uninstallUserExtension(id)
    stateStore.setDisabled(id, false)
    if (this.canHotRemove(id)) {
      this.removeExtension(id)
      return { hot: true, needsRestart: false }
    }
    ext.enabled = false
    ext.requiresRestart = true
    return { hot: false, needsRestart: true }
  }
}

export const host = new ExtensionHost()
