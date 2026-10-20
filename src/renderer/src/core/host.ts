/**
 * 扩展宿主：扫描 → 校验 → 注册贡献点（阶段一）→ 激活（阶段二）。
 * 基于 Cordis：root Context 承载宿主服务；每个扩展是一个插件（apply(ctx)）。
 */
import { Context } from '@cordisjs/core'
import type { Component } from 'vue'
// 注意：必须用 api/runtime 的 Disposable（{ dispose(): void }），
// 直接用裸 `Disposable` 会解析到 Node 全局的 Symbol.dispose 形状，导致返回对象被判为多余属性
import type { Disposable } from '../../../api/runtime'
import type {
  CommandContribution,
  KeybindingContribution,
  MenuContribution,
  NavItemContribution,
  StatusBarItemContribution,
  ThemeContribution,
  ViewContribution
} from '../../../api/contributions'
import { registry } from './registry'
import { deferredHookResult, executeExtensionHook, hookFailureForActivation } from './hookRuntime'
import { resolveIpcChannelDeclaration } from '../../../shared/ipcDeclaration'
import {
  connectExtensionHostBridge,
  handOverToExtensionHost,
  readExtensionHostFlag
} from './extensionHostBridge'
import { collectHostedExtensions } from './loader'
import { contributesArray, makeExtensionInfo, topoSort } from './manifest'
import { stateStore } from './state'
import { appStore } from './appStore'
import { themeStore } from './theme'
import { extensionSettingsStore } from './extensionSettings'
import {
  registerExtensionMessages,
  clearExtensionMessages,
  translateExtension
} from './extensionI18n'
import { keybindingStore, normalizeKey } from './keybindings'
import { updaterStore } from './updaterStore'
import { plainProxyConfig } from './plainProxy'
import { uiStore } from './uiStore'
import { outputStore } from './outputStore'
import { treeStore } from './treeStore'
import { i18n } from '../i18n'
import TreeView from '../components/TreeView.vue'
import type {
  ExtensionActivationApi,
  ExtensionInfo,
  ExtensionManifest,
  ExtensionModule,
  ProxyConfig,
  SqliteDb,
  SqliteRow,
  UpdateEvent
} from './types'

/** 扩展条目（内置/用户统一形状） */
export interface ExtensionEntry {
  id: string
  manifest: ExtensionManifest
  load: () => Promise<ExtensionModule>
  /** 来源：内置（随应用打包，只读）/ 用户（userData，可卸载）/ 调试（--debug-extension，不安装） */
  source: 'builtin' | 'user' | 'debug'
  /**
   * 扩展根目录的**绝对路径**（用户扩展由主进程 `extensions:list-user` 给出）。
   * 只有 EH-A4 的清单交接用得到它：宿主按这个路径 `require`/`import` 扩展入口；
   * 渲染进程自己经 `app://` 加载，不读这个字段。
   */
  path?: string
  /** 安装时间戳（用户扩展；.obox-meta.json 提供） */
  installedTimestamp?: number
  /** 待补跑的 install 钩子（安装时渲染进程不可用，下次启动补跑；见 issue #52） */
  pendingInstall?: { version: string; at: number; previousVersion?: string }
  /** 上次 install 钩子跑过的版本（用于判断本次是否属于升级） */
  previousInstallVersion?: string
}

/** 宿主启动配置 */
export interface HostOptions {
  builtins: ExtensionEntry[]
  userExtensions: ExtensionEntry[]
  debugExtensions?: ExtensionEntry[]
  /**
   * 是否激活扩展（阶段二），默认 true。
   * App 子窗口传 false：只注册贡献点（主题 token / 语言包 / 导航项等数据），**不执行扩展代码**——
   * 子窗口渲染只需要这些数据 + 经 localStorage 共享的 App 卡片（appStore），
   * 若照常激活，会让每个子窗口都把全部扩展跑一遍（定时器 / DB 连接 / fs.watch 等副作用重复注册）。
   */
  activateExtensions?: boolean
}

/**
 * 扩展消息（`extension:message`）的归属路由（纯函数；test/overlay-window.test.ts 直接测）。
 *
 * 顺序即契约（卡 03）：
 * 1. `appId` 命中 App 卡片 ⇒ 卡片所属扩展（**既有路径**：App 卡片子窗口的行为逐字不变）；
 * 2. 未命中再按 `overlayId` 查 overlay 路由表 ⇒ 所属扩展——后台扩展（桌面宠物）没有卡片，
 *    页面把自己的 overlayId 当 appId 原样发（design D-3/D-11），外壳转发代码因此几乎不用改；
 * 3. 都未命中 ⇒ undefined，调用方回**既有错误**「扩展未注册消息处理器」。
 */
export function resolveMessageExtId(
  appId: string,
  findCardExtension: (appId: string) => string | undefined,
  overlayOwners: ReadonlyMap<string, string>
): string | undefined {
  return findCardExtension(appId) ?? overlayOwners.get(appId)
}

class ExtensionHost {
  private root: Context
  private extensions = new Map<string, ExtensionInfo>()
  private loaders = new Map<string, () => Promise<ExtensionModule>>()
  /**
   * 钩子专用加载器：登记**所有清单有效的条目**（与启用/禁用无关）。
   * 理由：卸载一个**禁用态**扩展时也要能跑它入口导出的 `uninstall`（issue #52 的验收项）；
   * 而 `loaders` 只登记"启用且有效"的扩展，因为那决定是否激活。
   */
  private hookLoaders = new Map<string, () => Promise<ExtensionModule>>()
  private cleanups = new Map<string, () => void>()
  private activated = new Set<string>()
  private barrierWaiters: Array<() => void> = []
  /** App 子窗口消息处理器（extensionId → handler；api.app.onMessage 注册） */
  private appMessageHandlers = new Map<
    string,
    (channel: string, payload: unknown) => unknown | Promise<unknown>
  >()
  /**
   * overlay 路由表：overlayId → 所属扩展 id（卡 03）。api.overlay.create 成功时登记，
   * destroy / 扩展移除时删除。用途：消息桥按 appId **先查卡片、查不到再按 overlayId 查本表**
   * （resolveMessageExtId）——桌面宠物一类**后台扩展**不注册 App 卡片，页面把自己的
   * overlayId 当 appId 发消息（design D-3/D-11；overlayId 全局唯一由主进程创建时保证，
   * 见 main/appWindow.ts createOverlayWindow 的重复 id 拒绝）。
   */
  private overlayOwners = new Map<string, string>()

  /**
   * 扩展宿主模式（EH-A4 的回退开关，默认 `false`）。
   *
   * 只由 `start()` 按 `OBOX_EXTENSION_HOST` 决定一次：为 true 时**用户扩展的 `activateExtension`
   * 交给宿主进程**（渲染侧只注册贡献点），`loadUserExtension`（热安装）也要跳过激活，
   * 否则同一个扩展会在两个进程里各跑一遍。开关关闭时这个字段恒为 false，所有既有分支不变。
   */
  private extensionHostMode = false

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

  /** 全部扩展（设置页通知开关等 UI 用） */
  getExtensions(): ExtensionInfo[] {
    return [...this.extensions.values()]
  }

  /** 执行命令（跨扩展，经命令 id；快捷键触发等场景用） */
  async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    const cmd = registry.commands.find((c) => c.command === id)
    if (!cmd || !cmd.handler) throw new Error(`command not found: ${id}`)
    return (await cmd.handler(...args)) as T
  }

  /** 阶段一：注册贡献点（barrier 释放前，UI 不消费注册表） */
  private registerContributions(ext: ExtensionInfo, module: ExtensionModule): void {
    const c = ext.manifest.contributes
    if (!c) return
    // issue #84：贡献点数组一律经 `contributesArray` 读取。旧代码用 `c.x ?? []` 只兜 null/undefined，
    // manifest 写成 `{}` / `5` / `true` 时 `for...of` 会抛 `TypeError: … is not iterable` 打断整轮注册。
    const navItems = contributesArray<NavItemContribution>(c.navItems)
    const statusBarItems = contributesArray<StatusBarItemContribution>(c.statusBarItems)
    const commands = contributesArray<CommandContribution>(c.commands)
    const themes = contributesArray<ThemeContribution>(c.themes)
    const keybindings = contributesArray<KeybindingContribution>(c.keybindings)
    const menus = contributesArray<MenuContribution>(c.menus)
    const views = contributesArray<ViewContribution>(c.views)
    for (const nav of navItems) {
      if (nav.id && nav.title && nav.icon) registry.registerNavItem(ext.id, nav)
      else
        ext.validations.push({
          severity: 'warning',
          message: `导航项缺少 id/title/icon: ${JSON.stringify(nav)}`
        })
    }
    for (const sb of statusBarItems) {
      if (sb.id && sb.name) registry.registerStatusBarItem(ext.id, sb)
      else
        ext.validations.push({
          severity: 'warning',
          message: `状态栏项缺少 id/name: ${JSON.stringify(sb)}`
        })
    }
    for (const cmd of commands) {
      if (cmd.command && cmd.title) registry.registerCommand(ext.id, cmd, ext.validations)
      else
        ext.validations.push({
          severity: 'warning',
          message: `命令缺少 command/title: ${JSON.stringify(cmd)}`
        })
    }
    // 主题贡献点：主题扩展声明 CSS 变量组
    for (const theme of themes) {
      if (theme.id && theme.label && theme.tokens) themeStore.register(ext.id, theme)
      else
        ext.validations.push({
          severity: 'warning',
          message: `主题缺少 id/label/tokens: ${JSON.stringify(theme)}`
        })
    }
    // 扩展语言包（manifest 声明）
    if (c.i18n) registerExtensionMessages(ext.id, c.i18n)
    // 扩展设置 schema（manifest 声明，对齐 VS Code configuration 简化版）
    if (c.settings) extensionSettingsStore.register(ext.id, c.settings)
    // 更新提供者（manifest 声明；设置-更新选择生效，只能一个）
    if (c.updater) updaterStore.register(ext.id, c.updater.feedUrl)
    // 快捷键贡献：复用 keybindingStore（冲突检测/可改/设置页展示/持久化）；labelKey 用命令 title
    for (const kb of keybindings) {
      const cmd = commands.find((x) => x.command === kb.command)
      if (!cmd) {
        ext.validations.push({
          severity: 'warning',
          message: `keybindings 引用的命令 ${kb.command} 未在 contributes.commands 声明`
        })
        continue
      }
      // 重名比较走 normalizeKey（issue #79）：`Ctrl+Shift+k` 与 `Ctrl+Shift+K` 视为同一绑定
      const conflict = keybindingStore
        .list()
        .find(
          (e) => e.command !== kb.command && normalizeKey(e.currentKey) === normalizeKey(kb.key)
        )
      if (conflict) {
        ext.validations.push({
          severity: 'warning',
          message: `快捷键 ${kb.key} 已被 ${conflict.command} 占用（${kb.command} 未注册）`
        })
        continue
      }
      keybindingStore.register({ command: kb.command, labelKey: cmd.title, defaultKey: kb.key })
    }
    // 上下文菜单：命令挂到该扩展 App 卡片右键（command 须已声明）
    for (const menu of menus) {
      if (!commands.some((x) => x.command === menu.command)) {
        ext.validations.push({
          severity: 'warning',
          message: `menus 引用的命令 ${menu.command} 未在 contributes.commands 声明`
        })
        continue
      }
      registry.registerMenu(ext.id, menu)
    }
    // 树视图：声明即注册为导航项（view = 内置 'obox.tree'；数据源由 api.views 提供）
    for (const v of views) {
      registry.registerNavItem(ext.id, { ...v, view: 'obox.tree' })
    }
    // 校验视图引用：导航项声明的 view 必须在扩展模块具名导出中存在
    for (const nav of navItems) {
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
    // issue #84：同样走 `contributesArray`（非数组按空处理），激活期也绝不因坏清单抛 TypeError
    for (const nav of contributesArray<NavItemContribution>(ext.manifest.contributes?.navItems)) {
      if (nav.view && nav.view in module) {
        registry.registerViewComponent(nav.view, module[nav.view] as Component)
      }
    }

    const disposables: Array<() => void> = []
    const api: ExtensionActivationApi = this.buildApi(ext, disposables)
    // 统一清理：遍历本次收集的副作用（事件订阅/App 卡片/设置页/树数据源/定时器回调/状态栏动态项等）
    const disposeAll = (): void => {
      for (const d of disposables) {
        try {
          d()
        } catch (err) {
          console.warn(`[host] cleanup ${ext.id} error`, err)
        }
      }
      disposables.length = 0
    }
    try {
      const result = plugin(api)
      if (typeof result === 'function') disposables.push(result)
      ext.isActive = true
      this.activated.add(ext.id)
      // 保存统一清理函数（热移除/停用时调用）
      this.cleanups.set(ext.id, disposeAll)
    } catch (err) {
      ext.activationError = err instanceof Error ? err.message : String(err)
      ext.isActive = false
      // 激活失败：**立即清理**本次已收集的副作用——此前只在成功分支保存清理函数，
      // 失败时这些注册会残留在注册表与主进程资源里（事件监听泄漏、App 卡片/设置页残留）
      this.cleanups.set(ext.id, disposeAll)
      disposeAll()
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
        return registry.setCommandHandler(id, handler, ext.id)
      },
      executeCommand: <T = unknown>(id: string, ...args: unknown[]): Promise<T> =>
        this.executeCommand(id, ...args),
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
        },
        createItem: (init) => {
          const item = registry.createRuntimeStatusBarItem(ext.id, init)
          disposables.push(() => {
            item.active = false
            const idx = registry.runtimeStatusBarItems.indexOf(item)
            if (idx >= 0) registry.runtimeStatusBarItems.splice(idx, 1)
          })
          return {
            get text(): string {
              return item.text
            },
            set text(v: string) {
              item.text = v
            },
            get tooltip(): string | undefined {
              return item.tooltip
            },
            set tooltip(v: string | undefined) {
              item.tooltip = v
            },
            show: () => {
              item.visible = true
            },
            hide: () => {
              item.visible = false
            },
            dispose: () => {
              item.active = false
              const idx = registry.runtimeStatusBarItems.indexOf(item)
              if (idx >= 0) registry.runtimeStatusBarItems.splice(idx, 1)
            }
          }
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
        isMaximized: async () => (await window.api.getWindowState())?.isMaximized ?? false,
        setProgressBar: (progress) => window.api.setProgressBar(progress),
        isFocused: async () => (await window.api.getWindowState())?.isFocused ?? false,
        onFocusChanged: (callback) => {
          const off = window.events.on('window:state-changed', (state) => {
            callback(state.isFocused)
          })
          disposables.push(off)
          return { dispose: off }
        }
      },
      appInfo: {
        get: () => window.api.getAppInfo()
      },
      app: {
        register: (registration) => appStore.register(ext.id, registration),
        onMessage: (handler) => {
          this.appMessageHandlers.set(ext.id, handler)
          const dispose = (): void => {
            this.appMessageHandlers.delete(ext.id)
          }
          disposables.push(dispose)
          return { dispose }
        }
      },
      overlay: this.buildOverlayApi(ext, disposables),
      i18n: {
        t: (key, params) => translateExtension(ext.id, key, params),
        get locale(): string {
          return i18n.global.locale.value
        },
        onLocaleChanged: (callback) => {
          // 复用 settings 变更通知（语言切换触发 emitSettingsChanged）。
          // 该通知的触发面远大于语言切换（任何设置项变化都会通知），因此**只在语言真的变化时**回调
          let last = i18n.global.locale.value as string
          const listener = (): void => {
            const now = i18n.global.locale.value as string
            if (now === last) return
            last = now
            callback(now)
          }
          const dispose = stateStore.onSettingsChanged(listener)
          disposables.push(dispose)
          return { dispose }
        },
        registerMessages: (messages) => {
          registerExtensionMessages(ext.id, messages)
        }
      },
      settings: {
        register: (page) => {
          extensionSettingsStore.register(ext.id, page)
          // 只撤掉本页（旧实现调 deactivateExtension 会连带清掉该扩展全部设置页，含 manifest 声明的）
          return { dispose: () => extensionSettingsStore.removePage(page.id) }
        },
        get: <T = unknown>(key: string, defaultValue?: T): T | undefined =>
          stateStore.getSetting<T>(key, defaultValue),
        set: (key, value) => stateStore.setSetting(key, value),
        onChanged: (callback) => {
          // 设置变更通知：回调带变更的设置项 key（无具体 key 的场景——如语言切换——传空串）
          const dispose = stateStore.onSettingsChanged((key) => callback(key ?? ''))
          disposables.push(dispose)
          return { dispose }
        }
      },
      update: this.buildUpdateApi(ext, disposables),
      ipc: this.buildIpcApi(ext, disposables),
      python: this.buildPythonApi(ext),
      proxy: {
        get: (): ProxyConfig =>
          plainProxyConfig(stateStore.getSetting<ProxyConfig>('network.proxy'))
      },
      timer: this.buildTimerApi(ext, disposables),
      sqlite: {
        open: (name) => this.buildSqliteDb(ext.id, name)
      },
      notification: {
        show: (opts) => this.showNotification(ext, opts, disposables)
      },
      net: {
        fetch: (url, opts) =>
          window.api.netFetch(
            {
              url,
              method: opts?.method,
              headers: opts?.headers,
              body: opts?.body,
              json: opts?.json
            },
            // ⚠️ 必须过 plainProxyConfig：设置里的代理是 reactive Proxy，直接进 IPC 会
            // 抛 `An object could not be cloned.`（见 plainProxy.ts 的说明）
            plainProxyConfig(stateStore.getSetting<ProxyConfig>('network.proxy'))
          )
      },
      dialog: {
        showOpenDialog: (opts) => window.api.dialogOpen(opts ?? {}),
        showSaveDialog: (opts) => window.api.dialogSave(opts ?? {}),
        showMessageBox: (opts) => window.api.dialogMessage(opts ?? {})
      },
      shell: {
        openExternal: (url) => window.api.shellOpenExternal(url),
        openPath: (p) => window.api.shellOpenPath(p)
      },
      clipboard: {
        readText: () => window.api.clipboardReadText(),
        writeText: (text) => window.api.clipboardWriteText(text)
      },
      env: {
        platform: window.api.env.platform,
        arch: window.api.env.arch,
        nodeVersion: window.api.env.nodeVersion,
        language: i18n.global.locale.value as string,
        getOboxVersion: () => window.api.getOboxVersion()
      },
      theme: this.buildThemeApi(disposables),
      fs: this.buildFsApi(ext.id, disposables),
      ui: {
        showQuickPick: (items, opts) =>
          this.showUiModal('quickPick', { items, opts }, () => uiStore.showQuickPick(items, opts)),
        showInputBox: (opts) =>
          this.showUiModal('inputBox', opts, () => uiStore.showInputBox(opts)),
        showMessage: (message, type = 'info') => uiStore.showToast(message, type),
        showForm: (opts) => this.showUiModal('form', opts, () => uiStore.showForm(opts)),
        withProgress: async (title, task) => {
          uiStore.showProgress(title, null)
          try {
            return await task((percent) => uiStore.showProgress(title, percent))
          } finally {
            uiStore.hideProgress()
          }
        }
      },
      output: {
        createChannel: (name) => outputStore.createChannel(name)
      },
      secrets: {
        get: async (key) => {
          const r = await window.api.secretsGet(ext.id, key)
          if (!r.ok) throw new Error(r.error ?? 'secrets 操作失败')
          return r.value
        },
        set: async (key, value) => {
          const r = await window.api.secretsSet(ext.id, key, value)
          if (!r.ok) throw new Error(r.error ?? 'secrets 操作失败')
        },
        delete: async (key) => {
          const r = await window.api.secretsDelete(ext.id, key)
          if (!r.ok) throw new Error(r.error ?? 'secrets 操作失败')
        }
      },
      views: {
        registerTreeProvider: (viewId, provider) => {
          const off = treeStore.registerTreeProvider(viewId, provider, ext.id)
          disposables.push(off)
          return { dispose: off }
        }
      }
    }
  }

  /**
   * 构造 api.overlay（卡 03；窗体实现全在主进程 main/appWindow.ts，这里只做两件事）：
   * 1. 维护 overlayId → 扩展 id 路由表（overlayOwners）——消息桥按 appId 查不到卡片时，
   *    按 overlayId 找所属扩展派发（resolveMessageExtId）；
   * 2. 把「销毁该 overlay」挂进 disposables——扩展停用/卸载走**既有 cleanup 路径**
   *    （activateExtension 的 disposeAll / removeExtension 的 cleanup()）自动回收窗体，
   *    扩展无需手动销毁兜底（api/types.ts overlay 的 JSDoc 契约、pet-window spec
   *    「停用或卸载即回收窗体」）。
   * 作用域安全由主进程按 extId 校验（四个方法都只能操作调用方扩展自己创建的 overlay，
   * 越权返回 ok:false + `[overlay]` 日志）；宿主侧把 ext.id 绑死在闭包里，扩展拿不到别人的绑定。
   */
  private buildOverlayApi(
    ext: ExtensionInfo,
    disposables: Array<() => void>
  ): ExtensionActivationApi['overlay'] {
    return {
      create: async (options) => {
        // 清理钩子在 create 发起时就挂（而不是等成功再挂）：create 是异步 IPC，若扩展入口在
        // 发起创建后立刻抛错，disposeAll 仍能销毁随后创建出来的窗体（IPC 同管道保序：
        // destroy 必在 create 之后被主进程处理）；destroy 对不存在的 id 幂等，多挂无副作用
        const overlayId = typeof options?.id === 'string' ? options.id : ''
        if (overlayId) {
          disposables.push(() => {
            if (this.overlayOwners.get(overlayId) === ext.id) this.overlayOwners.delete(overlayId)
            void window.api.overlayDestroy(ext.id, overlayId)
          })
        }
        const r = await window.api.overlayCreate(ext.id, options)
        // 路由表只收成功创建的 overlay（失败的 id 没有窗体，也不该参与消息路由）
        if (r.ok && overlayId) this.overlayOwners.set(overlayId, ext.id)
        return r
      },
      destroy: async (id) => {
        const r = await window.api.overlayDestroy(ext.id, id)
        // ok 覆盖「销毁成功」与「幂等：本就不存在」两种情况，都把路由项收掉；
        // 越权被拒（ok:false，id 属于别的扩展）时不动别人的路由
        if (r.ok && this.overlayOwners.get(id) === ext.id) this.overlayOwners.delete(id)
        return r
      },
      setMouseThrough: (id, through) => window.api.overlaySetMouseThrough(ext.id, id, through),
      // 移动窗体（卡 14）：坐标钳位与合法性校验都在主进程（宿主兜底、扩展主钳，design D-13）；
      // 返回的 position = 钳制后实际坐标，扩展入口用它校正自己记录的位置
      setPosition: (id, x, y) => window.api.overlaySetPosition(ext.id, id, x, y)
    }
  }

  /**
   * `extension:message` 派发（start() 里注册监听；拆成私有方法便于测试直接调用，
   * 先例：test/ipc-renderer-close.test.ts 对 buildIpcApi 的用法）。
   * App 卡片子窗口的行为与卡 03 之前**逐字一致**：只是归属查找换成了 resolveMessageExtId
   * 纯函数（卡片命中 ⇒ 既有路径；未命中 ⇒ overlay 兜底路由；都未命中 ⇒ 既有错误文案）。
   */
  private handleExtensionMessage(e: {
    requestId: number
    appId: string
    channel: string
    payload: unknown
  }): void {
    const extId = resolveMessageExtId(
      e.appId,
      (id) => appStore.findById(id)?.extensionId,
      this.overlayOwners
    )
    const handler = extId ? this.appMessageHandlers.get(extId) : undefined
    if (!handler) {
      window.api.extensionReply(e.requestId, { ok: false, error: '扩展未注册消息处理器' })
      return
    }
    Promise.resolve(handler(e.channel, e.payload))
      .then((data) => window.api.extensionReply(e.requestId, { ok: true, data }))
      .catch((err) =>
        window.api.extensionReply(e.requestId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      )
  }

  /** 构造 api.theme（读当前主题 + 监听切换，纯渲染侧） */
  private buildThemeApi(disposables: Array<() => void>): ExtensionActivationApi['theme'] {
    const listeners = new Set<(id: string) => void>()
    const notify = (): void => {
      const id = themeStore.currentId
      listeners.forEach((l) => l(id))
    }
    const off = stateStore.onSettingsChanged(notify)
    disposables.push(off)
    return {
      getCurrent: () => themeStore.currentId,
      onChanged: (callback) => {
        listeners.add(callback)
        return {
          dispose: () => {
            listeners.delete(callback)
          }
        }
      }
    }
  }

  /** 构造 api.fs（限定扩展 data 目录，相对路径；watch 经 'fs:watch-event' 分发） */
  private buildFsApi(extId: string, disposables: Array<() => void>): ExtensionActivationApi['fs'] {
    const call = async <T extends { ok: boolean; error?: string }>(
      p: Promise<T>
    ): Promise<Omit<T, 'ok' | 'error'>> => {
      const r = await p
      if (!r.ok) throw new Error(r.error ?? '文件操作失败')
      return r as unknown as Omit<T, 'ok' | 'error'>
    }
    const watchCallbacks = new Map<string, (e: { relPath: string }) => void>()
    const offWatch = window.events.on('fs:watch-event', (e) => {
      const cb = watchCallbacks.get(e.key)
      if (cb) cb({ relPath: e.relPath })
    })
    disposables.push(offWatch)
    return {
      readFile: async (rel) => (await call(window.api.fsReadFile(extId, rel))).content ?? '',
      writeFile: async (rel, content) => {
        await call(window.api.fsWriteFile(extId, rel, content))
      },
      readDir: async (rel) => (await call(window.api.fsReadDir(extId, rel))).entries ?? [],
      exists: async (rel) => (await call(window.api.fsExists(extId, rel))).exists ?? false,
      remove: async (rel) => {
        await call(window.api.fsRemove(extId, rel))
      },
      watch: async (watchId, dir, callback) => {
        watchCallbacks.set(`${extId}:${watchId}`, callback)
        const r = await window.api.fsWatch(extId, watchId, dir)
        if (!r.ok) {
          watchCallbacks.delete(`${extId}:${watchId}`)
          throw new Error(r.error ?? '监听失败')
        }
      },
      unwatch: async (watchId) => {
        watchCallbacks.delete(`${extId}:${watchId}`)
        await window.api.fsUnwatch(extId, watchId)
      }
    }
  }

  /** 构造 api.timer（主进程精确计时；触发经 'timer:fire' 事件分发回调） */
  private buildTimerApi(
    ext: ExtensionInfo,
    disposables: Array<() => void>
  ): ExtensionActivationApi['timer'] {
    const callbacks = new Map<string, () => void>()
    const offFire = window.events.on('timer:fire', (e) => {
      const cb = callbacks.get(e.key)
      if (!cb) return
      cb()
      if (e.kind === 'timeout') callbacks.delete(e.key)
    })
    disposables.push(offFire)
    const set =
      (kind: 'timeout' | 'interval') =>
      (id: string, seconds: number, callback: () => void): void => {
        callbacks.set(`${ext.id}:${id}`, callback)
        void (kind === 'timeout'
          ? window.api.setTimerTimeout(ext.id, id, seconds)
          : window.api.setTimerInterval(ext.id, id, seconds))
      }
    const clear = (id: string): void => {
      callbacks.delete(`${ext.id}:${id}`)
      void window.api.clearTimer(ext.id, id)
    }
    return {
      setTimeout: set('timeout'),
      setInterval: set('interval'),
      clearTimeout: clear,
      clearInterval: clear
    }
  }

  /** 构造 api.sqlite.open 返回的数据库句柄（所有操作经 IPC，异步） */
  private buildSqliteDb(extId: string, name: string): Promise<SqliteDb> {
    return window.api.sqliteOpen(extId, name).then((r) => {
      if (!r.ok) throw new Error(r.error ?? '打开数据库失败')
      const call = async <T extends { ok: boolean; error?: string }>(
        p: Promise<T>
      ): Promise<Omit<T, 'ok' | 'error'>> => {
        const result = await p
        if (!result.ok) throw new Error(result.error ?? '数据库操作失败')
        return result as unknown as Omit<T, 'ok' | 'error'>
      }
      return {
        exec: (sql) => window.api.sqliteExec(extId, name, sql),
        query: async (sql, params = []) =>
          ((await call(window.api.sqliteQuery(extId, name, sql, params))).rows as
            SqliteRow[] | undefined) ?? [],
        insert: async (row) =>
          ((await call(window.api.sqliteInsert(extId, name, row))).row as SqliteRow | undefined) ??
          null,
        update: async (where, patch) =>
          (await call(window.api.sqliteUpdate(extId, name, where, patch))).changes ?? 0,
        get: async (id) =>
          ((await call(window.api.sqliteGet(extId, name, id))).row as SqliteRow | undefined) ??
          null,
        get_all: async () =>
          ((await call(window.api.sqliteGetAll(extId, name))).rows as SqliteRow[] | undefined) ??
          [],
        get_by: async (where) =>
          ((await call(window.api.sqliteGetBy(extId, name, where))).rows as
            SqliteRow[] | undefined) ?? [],
        del: async (id) => (await call(window.api.sqliteDel(extId, name, id))).changes ?? 0,
        del_by: async (where) =>
          (await call(window.api.sqliteDelBy(extId, name, where))).changes ?? 0,
        clear: async () => (await call(window.api.sqliteClear(extId, name))).changes ?? 0,
        close: () => window.api.sqliteClose(extId, name)
      }
    })
  }

  /** api.notification.show：设置-通知关闭的扩展直接 no-op；点击通知分发 onClick（一次性） */
  /** 窗口化 ui 模态框：焦点在 App 子窗口 → 转发渲染；否则主窗口本地渲染 */
  private showUiModal<T>(
    kind: string,
    payload: unknown,
    localFn: () => Promise<T | undefined>
  ): Promise<T | undefined> {
    return window.api.uiShow(kind, payload).then((r) => {
      if (r.local) return localFn()
      return (r.canceled ? undefined : r.value) as T | undefined
    })
  }

  private showNotification(
    ext: ExtensionInfo,
    opts: { title: string; body?: string; icon?: string; onClick?: () => void },
    disposables: Array<() => void>
  ): Promise<{ ok: boolean; error?: string }> {
    if (stateStore.isNotificationDisabled(ext.id)) {
      return Promise.resolve({ ok: true })
    }
    return window.api
      .showNotification(ext.id, { title: opts.title, body: opts.body, icon: opts.icon })
      .then((r) => {
        if (r.ok && r.id !== undefined && opts.onClick) {
          const off = window.events.on('notification:click', (e) => {
            if (e.notifId === r.id) {
              opts.onClick?.()
              off()
            }
          })
          disposables.push(off)
        }
        return { ok: r.ok, error: r.error }
      })
  }

  /** 构造 api.update（仅更新提供者扩展可用；未选中时抛错） */
  private buildUpdateApi(
    ext: ExtensionInfo,
    disposables: Array<() => void>
  ): ExtensionActivationApi['update'] {
    const isProvider = (): void => {
      if (!updaterStore.isActive(ext.id)) {
        throw new Error('当前扩展不是生效的更新提供者（需在设置-更新中选择）')
      }
    }
    const proxy = (): ProxyConfig =>
      // ⚠️ 必须过 plainProxyConfig：`getSetting` 返回的是 reactive Proxy，直接进 IPC 会
      // 抛 `An object could not be cloned.`（设置页那条路径曾因此卡在"检查中…"）
      plainProxyConfig(stateStore.getSetting<ProxyConfig>('network.proxy'))
    return {
      getVersion: () => window.api.getOboxVersion(),
      resolveFeed: (repo) => {
        isProvider()
        return window.api.resolveUpdateFeed(repo, proxy())
      },
      check: async (feedUrl) => {
        isProvider()
        return window.api.checkUpdate({ feedUrl, proxy: proxy() })
      },
      download: async () => {
        isProvider()
        return window.api.downloadUpdate()
      },
      install: async (opts) => {
        isProvider()
        if (!opts?.force) {
          await window.api.installUpdate()
          return { ok: true }
        }
        // 强制重装/降级：优先用调用方给的 feedUrl，否则回落到提供者 manifest 里声明的 feedUrl
        const feedUrl = opts.feedUrl ?? updaterStore.active?.feedUrl
        if (!feedUrl) {
          return {
            ok: false,
            error:
              '强制重装需要更新源：请传入 feedUrl，或在 manifest 声明 contributes.updater.feedUrl'
          }
        }
        const r = await window.api.forceInstallUpdate({ feedUrl, proxy: proxy(), reason: 'user' })
        return { ok: r.ok, version: r.version, error: r.error }
      },
      onEvent: (callback) => {
        const off = window.events.on('update:event', (e) => {
          callback(e as unknown as UpdateEvent)
        })
        disposables.push(off)
        return { dispose: off }
      }
    }
  }

  /** 扫描并启动（主流程）：返回完整扩展列表 */
  async start(options: HostOptions): Promise<ExtensionInfo[]> {
    // 注册内置快捷键（命令面板 Ctrl+Shift+P）
    keybindingStore.register({
      command: 'app.showCommands',
      labelKey: 'palette.showCommands',
      defaultKey: 'Ctrl+Shift+P'
    })
    // 内置树视图组件（contributes.views 声明的导航项都指向它；数据源由 api.views 提供）
    registry.registerViewComponent('obox.tree', TreeView)
    // App 子窗口 / overlay 窗体 ↔ 扩展消息桥：归属路由在 handleExtensionMessage
    // （先按卡片 id 查所属扩展 = 既有路径；查不到再按 overlayId 查 overlayOwners = 卡 03 新增，
    // 后台扩展没有卡片，页面把自己的 overlayId 当 appId 发；design D-3/D-11）
    window.events.on('extension:message', (e) => this.handleExtensionMessage(e))
    // 生命周期钩子（issue #52）：主进程请宿主执行入口导出的 install / uninstall。
    // 扩展尚未加载到宿主时（刚安装完还没被扫描到）回 deferred —— 主进程据此保留 pendingInstall，
    // 下次启动扫描期补跑，而不是把"没跑"记成"跑过了"。
    // 加载器取值顺序：**所有有效条目** → 已激活扩展的加载器：这样**禁用态扩展**也能跑钩子
    // （规格要求"禁用态临时加载入口仅为跑钩子"），而它平时不会被激活。
    window.events.on('extension:hook-request', (e) => {
      const load = this.hookLoaders.get(e.extId) ?? this.loaders.get(e.extId)
      if (!load) {
        window.api.hookResult(deferredHookResult(e.requestId))
        return
      }
      const info = this.extensions.get(e.extId)
      if (!info) {
        // 构造不出文档承诺的 ctx.api 时不硬跑：回 deferred，留给下次启动补跑
        window.api.hookResult(deferredHookResult(e.requestId))
        return
      }
      // 钩子期注册类操作"不生效"= 钩子结束后立刻释放它们注册的东西
      const hookDisposables: Array<() => void> = []
      void executeExtensionHook(e, { load, api: this.buildApi(info, hookDisposables) })
        .then((result) => {
          // 只有"真的执行过且失败"才标激活失败（deferred 与成功都不算）
          const failure = hookFailureForActivation(result)
          if (failure) info.activationError = failure
          window.api.hookResult(result)
        })
        .finally(() => {
          for (const dispose of hookDisposables.splice(0)) {
            try {
              dispose()
            } catch (err) {
              console.warn('[host] 释放钩子期注册失败', err)
            }
          }
        })
    })
    // ---- 1. 汇总扩展（内置 + 用户），跳过禁用项 ----
    const all: ExtensionInfo[] = []
    const entries: ExtensionEntry[] = [
      ...options.builtins,
      ...options.userExtensions,
      ...(options.debugExtensions ?? [])
    ]

    for (const entry of entries) {
      const enabled = !stateStore.isDisabled(entry.id)
      const info = makeExtensionInfo(entry.id, entry.manifest, entry.source, enabled, {
        installedTimestamp: entry.installedTimestamp
      })
      all.push(info)
      if (enabled && info.isValid) this.loaders.set(entry.id, entry.load)
      // 钩子专用：清单有效即登记，**与是否启用无关**（禁用态的 install/uninstall 钩子也要能跑）
      if (info.isValid) this.hookLoaders.set(entry.id, entry.load)
    }

    for (const ext of all) this.extensions.set(ext.id, ext)

    // ---- 扩展宿主交接（EH-A4）----
    // 回退开关 `OBOX_EXTENSION_HOST`：**关（默认）⇒ 什么都不做**（一个 IPC 都不发，用户扩展照旧
    // 在本进程激活）；开 ⇒ 把用户扩展清单交给 main，由它 start() 宿主，渲染侧跳过这些扩展的激活
    // （贡献点仍在阶段一注册，导航/状态栏/命令照旧可用）。
    // 子窗口（activateExtensions === false）一律传 null：扩展宿主只服务主窗口；子窗口也起宿主会把
    // 同一批扩展再跑一遍（子窗口本来就只注册贡献点）。
    const handover = handOverToExtensionHost({
      flag: options.activateExtensions === false ? null : readExtensionHostFlag(),
      extensions: collectHostedExtensions(
        entries.filter((entry) => {
          const info = this.extensions.get(entry.id)
          return entry.source === 'user' && info !== undefined && info.enabled && info.isValid
        })
      )
    })
    this.extensionHostMode = handover.enabled
    const hostedIds: ReadonlySet<string> | null = handover.enabled
      ? new Set(handover.extensions.map((ext) => ext.id))
      : null
    if (handover.enabled) {
      // 端口会在 start() 之后才到（main 先 fork、再 transfer）：桥自己处理"未到达"期间的状态，
      // 这里只把它接起来（A5 / 扩展管理器用 getExtensionHostBridge() 订阅 phase 与崩溃原因）
      connectExtensionHostBridge()
      console.log(
        `[host] 扩展宿主模式：${handover.extensions.length} 个用户扩展交给宿主进程，` +
          '渲染侧只注册贡献点、不激活'
      )
    }

    // 清理孤儿 App 卡片：持久化里属于"已不存在的扩展"的卡片（如已卸载扩展的残留）
    const liveIds = new Set(all.map((e) => e.id))
    const orphans = appStore.items.filter((i) => !liveIds.has(i.extensionId))
    for (const orphan of orphans) {
      console.log(`[host] 清理孤儿 App 卡片: ${orphan.id}（扩展 ${orphan.extensionId} 已不在）`)
      appStore.deactivateExtension(orphan.extensionId)
    }

    // 补跑 install 钩子（#52）：上次安装时渲染进程不可用（或扩展尚未加载），元数据里留了
    // pendingInstall。这里在**激活前**补上（放在汇总之后，才有 enabled/isValid 与加载器可判），
    // 跑完回写元数据；失败归为激活失败；仍跑不了则保留 pending，下次启动再试。
    for (const entry of entries) {
      const pending = entry.pendingInstall
      if (!pending) continue
      const info = this.extensions.get(entry.id)
      if (!info || !info.enabled || !info.isValid) continue
      // 优先用安装时记下的"被替换版本"（延迟补跑的升级也能拿到），其次用上次钩子跑过的版本
      const previous = pending.previousVersion ?? entry.previousInstallVersion
      const hookDisposables: Array<() => void> = []
      const result = await executeExtensionHook(
        {
          requestId: `startup:${entry.id}`,
          extId: entry.id,
          phase: 'install',
          version: pending.version,
          upgraded: previous !== undefined && previous !== pending.version,
          previousVersion: previous
        },
        { load: entry.load, api: this.buildApi(info, hookDisposables) }
      )
      for (const dispose of hookDisposables.splice(0)) {
        try {
          dispose()
        } catch (err) {
          console.warn('[host] 释放钩子期注册失败', err)
        }
      }
      if (result.deferred) continue
      const failure = hookFailureForActivation(result)
      if (failure) info.activationError = failure
      await window.api.recordInstallHook(entry.id, pending.version, result.ok)
    }

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

    // ---- 4. 阶段二：依赖拓扑序激活（子窗口模式跳过，见 HostOptions.activateExtensions） ----
    const topo = topoSort(all.filter((e) => e.enabled && e.isValid))
    // 宿主模式：这些扩展已交给宿主进程激活，渲染侧**跳过**（否则两个进程各跑一遍）
    const renderable = hostedIds
      ? topo.ordered.filter((ext) => !hostedIds.has(ext.id))
      : topo.ordered
    if (hostedIds && renderable.length !== topo.ordered.length) {
      console.log(
        `[host] 宿主模式：跳过 ${topo.ordered.length - renderable.length} 个用户扩展的渲染侧激活`
      )
    }
    const ordered = options.activateExtensions === false ? [] : renderable
    const cyclic = topo.cyclic
    if (options.activateExtensions === false) {
      console.log('[host] 子窗口模式：仅注册贡献点，不激活扩展')
    }
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

    // 应用持久化主题（主题扩展已注册贡献）
    themeStore.applyCurrent()

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

    // 激活（先按 extensionDependencies 顺序激活依赖，与冷启动阶段二的拓扑序语义一致）
    if (this.extensionHostMode) {
      // 宿主模式（EH-A4）：热安装只注册贡献点，**不**在本进程激活——否则该扩展会在渲染进程与
      // 宿主里各跑一遍。把新清单热推给宿主属于 A5（扩展管理器的热装卸），这里要求重启。
      console.warn(
        `[host] 宿主模式：${id} 的贡献点已注册，但激活交给扩展宿主；请重启应用让它生效（热交接属于 A5）`
      )
      return info
    }
    try {
      const module = await entry.load()
      await this.activateInDependencyOrder(info, module)
    } catch (err) {
      info.activationError = err instanceof Error ? err.message : String(err)
    }

    console.log(
      `[host] 热安装完成: ${id} ${info.isActive ? '已激活' : '激活失败'}（贡献项已注册，立即可用）`
    )
    return info
  }

  /**
   * 激活扩展及其依赖（热安装用）：DFS 后序先激活依赖，再激活自身。
   * 冷启动阶段二已对全量扩展做拓扑排序，热安装此前直接激活目标扩展、忽略 extensionDependencies——
   * 依赖未激活时目标扩展的 `executeCommand(依赖命令)` 等会失败。
   * 缺失 / 已禁用 / 清单无效 / 无加载器的依赖只告警不阻塞；环由 seen 集合兜底（不会无限递归）。
   */
  private async activateInDependencyOrder(
    ext: ExtensionInfo,
    module: ExtensionModule
  ): Promise<void> {
    const seen = new Set<string>()
    const order: Array<{ ext: ExtensionInfo; module: ExtensionModule }> = []
    const walk = async (cur: ExtensionInfo, curModule: ExtensionModule): Promise<void> => {
      if (seen.has(cur.id)) return
      seen.add(cur.id)
      for (const depId of cur.manifest.extensionDependencies ?? []) {
        const dep = this.extensions.get(depId)
        if (!dep) {
          console.warn(`[host] ${cur.id} 依赖的扩展 ${depId} 不存在（跳过）`)
          continue
        }
        if (!dep.enabled || !dep.isValid) {
          console.warn(`[host] ${cur.id} 依赖的扩展 ${depId} 未启用或清单无效（跳过）`)
          continue
        }
        if (this.activated.has(depId)) continue
        const load = this.loaders.get(depId)
        if (!load) {
          console.warn(`[host] ${cur.id} 依赖的扩展 ${depId} 无加载器（跳过）`)
          continue
        }
        await walk(dep, await load())
      }
      order.push({ ext: cur, module: curModule })
    }
    await walk(ext, module)
    for (const item of order) {
      if (this.activated.has(item.ext.id)) continue
      await this.activateExtension(item.ext, item.module)
    }
  }

  /** 热移除：从宿主完全移除扩展（清理贡献项/视图/App 卡片/清理函数）。返回是否成功 */
  removeExtension(id: string): boolean {
    const ext = this.extensions.get(id)
    if (!ext) return false
    // 执行扩展注册的清理函数（命令 handler 清空、事件移除、App 卡片移除等；
    // 卡 03 起也含 api.overlay.create 挂上的「销毁 overlay」钩子——停用/卸载即回收窗体）
    const cleanup = this.cleanups.get(id)
    if (cleanup) {
      try {
        cleanup()
      } catch (err) {
        console.warn(`[host] cleanup ${id} error`, err)
      }
      this.cleanups.delete(id)
    }
    // overlay 路由表兜底清扫（卡 03）：窗体销毁由上面的 cleanup 触发（create 时挂进 disposables），
    // 这里清路由项——即便某条 create IPC 还在途、销毁钩子扑空（主进程随后的 destroy/'closed'
    // 仍会收掉窗体），路由项也不能残留，否则消息会按 overlayId 投给一个已停用的扩展
    for (const [overlayId, owner] of this.overlayOwners) {
      if (owner === id) this.overlayOwners.delete(overlayId)
    }
    // 注册表贡献项 + 视图组件 + App 卡片 + 设置页 + 语言包 + 更新提供者
    registry.deactivateExtension(id)
    registry.removeViewComponents(id)
    // 物理清除贡献项：命令/导航项/状态栏项/菜单（否则同 id 重装会被误判重复、数组持续增长）
    registry.unregisterExtension(id)
    appStore.deactivateExtension(id)
    extensionSettingsStore.deactivateExtension(id)
    clearExtensionMessages(id)
    updaterStore.deactivateExtension(id)
    this.activated.delete(id)
    this.loaders.delete(id)
    this.extensions.delete(id)
    // 清理主进程资源（定时器 + 数据库连接）
    void window.api.cleanupExtension(id)
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
    if (ext.source === 'debug') throw new Error('调试扩展不占用安装态，无需卸载')
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

  /**
   * 扩展 Python 能力：只提供 `run`（ADR-0018）。主进程负责准备环境、启动进程、杀进程树与清理；
   * 这一层只做"按扩展绑定 + 错误码还原成抛错"（与 `buildIpcApi` 同一风格）。
   */
  private buildPythonApi(ext: ExtensionInfo): ExtensionActivationApi['python'] {
    return {
      run: async (
        script: string,
        args?: string[],
        opts?: { channel?: string | boolean }
      ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
        const outcome = await window.api.pythonRun(ext.id, {
          script,
          args,
          channel: opts?.channel
        })
        if (!outcome.ok || !outcome.result) {
          throw new Error(
            `[${outcome.code ?? 'launch-failed'}] ${outcome.error ?? 'Python 运行失败'}`
          )
        }
        return outcome.result
      }
    }
  }

  /**
   * 扩展 IPC 能力：与外部进程的**端口无关**双向通道（issue #40）。
   * 宿主只做"按扩展绑定 + 事件分发 + 对端请求回包"；协议与传输在主进程（ipcCore / ipcTransport / ipcServer）。
   * issue #43 追加：server 通道（`listen`）的连接事件与定向/广播。
   */
  private buildIpcApi(
    ext: ExtensionInfo,
    disposables: Array<() => void>
  ): ExtensionActivationApi['ipc'] {
    type ChannelListeners = {
      requests: Set<(method: string, params: unknown) => unknown>
      notifications: Set<(method: string, params: unknown) => void>
      closes: Set<(err: { code: string; message: string }) => void>
      stderrs: Set<(text: string) => void>
      /** issue #43：server 连接事件（按通道名聚合，回调参数与 IpcEvent 一一对应） */
      connections: Set<(connectionId: number) => void>
      disconnects: Set<(connectionId: number, err: { code: string; message: string }) => void>
      /** issue #44：client 通道自动重连成功（attempts = 本次共尝试次数，含成功那次） */
      reconnects: Set<(info: { attempts: number }) => void>
    }
    const listeners = new Map<string, ChannelListeners>()
    const forChannel = (name: string): ChannelListeners => {
      const existing = listeners.get(name)
      if (existing) return existing
      const created: ChannelListeners = {
        requests: new Set(),
        notifications: new Set(),
        closes: new Set(),
        stderrs: new Set(),
        connections: new Set(),
        disconnects: new Set(),
        reconnects: new Set()
      }
      listeners.set(name, created)
      return created
    }

    const off = window.events.on('ipc:event', (e): void => {
      if (e.extId !== ext.id) return
      const target = listeners.get(e.name)
      if (!target) return
      if (e.type === 'notification') {
        for (const cb of [...target.notifications]) cb(e.method, e.params)
        return
      }
      if (e.type === 'stderr') {
        for (const cb of [...target.stderrs]) cb(e.text)
        return
      }
      if (e.type === 'close') {
        for (const cb of [...target.closes]) cb({ code: e.code, message: e.message })
        return
      }
      if (e.type === 'connection') {
        for (const cb of [...target.connections]) cb(e.connectionId)
        return
      }
      if (e.type === 'disconnect') {
        for (const cb of [...target.disconnects]) {
          cb(e.connectionId, { code: e.code, message: e.message })
        }
        return
      }
      if (e.type === 'reconnect') {
        for (const cb of [...target.reconnects]) cb({ attempts: e.attempts })
        return
      }
      // 对端发来的请求：交给扩展处理器，并把结果回传给主进程（再由主进程回给对端）
      const handler = [...target.requests][0]
      Promise.resolve(
        handler
          ? handler(e.method, e.params)
          : Promise.reject(new Error(`扩展未注册请求处理器（method=${e.method}）`))
      )
        .then((result) => window.api.ipcReply(e.requestId, { ok: true, result }))
        .catch((err: unknown) =>
          window.api.ipcReply(e.requestId, {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
        )
    })
    disposables.push(off)

    return {
      connect: async (declaration): Promise<void> => {
        // 清单静态声明（issue #45）：传通道 id 即可；传对象时**运行时声明优先**（不做合并/覆盖提示）
        const resolved =
          typeof declaration === 'string'
            ? resolveIpcChannelDeclaration(ext.manifest.contributes?.ipcChannels, declaration)
            : declaration
        if (!resolved) {
          throw new Error(
            `[invalid-declaration] 清单里没有声明通道 ${String(declaration)}（contributes.ipcChannels）`
          )
        }
        const r = await window.api.ipcConnect(ext.id, resolved)
        if (!r.ok) throw new Error(`[${r.code ?? 'connect-failed'}] ${r.error ?? '打开通道失败'}`)
      },
      listen: async (declaration): Promise<void> => {
        const r = await window.api.ipcListen(ext.id, declaration)
        if (!r.ok)
          throw new Error(`[${r.code ?? 'invalid-declaration'}] ${r.error ?? 'listen 失败'}`)
      },
      close: async (name: string): Promise<void> => {
        // 顺序即契约（真机 v11/v12 run5/run6 的缺陷回归）：主进程在这次 `ipc:close` invoke 里
        // 才发出该通道的收尾事件——client 通道是 `close{channel-closed}`，server 通道是**每条**
        // 活动连接各一条 `disconnect{channel-closed}`。先 `listeners.delete(name)` 会把这次
        // `close()` 自己的事件一起吞掉（扩展的 `onClose` / `onDisconnect` 永不触发），违反
        // `src/api/types.ts` 的契约（onClose："每扩展主动 `close()` 与每次断连各触发一次"；
        // onDisconnect："每条连接恰好触发一次……宿主关闭 server 或 `close()` 时为 channel-closed"）。
        // 因此**先等事件投递完**（Electron 帧内消息 FIFO：in-pipe 事件先于 invoke 回复到达渲染进程），
        // 再清理本地监听表；`finally` 让清理无条件执行（桥调用失败时该通道状态已不可知，
        // 留着旧订阅只会错投后续事件）。
        // 为什么不会泄漏/悬挂：清理是无条件的、且不持有任何定时器/句柄（唯一异步步骤是这一次
        // invoke，它必然 settle）；`close()` 返回后该名字的订阅全部作废，同名通道重新
        // `listen`/`connect` 从空表开始，不会被残留监听器影响。
        try {
          await window.api.ipcClose(ext.id, name)
        } finally {
          listeners.delete(name)
        }
      },
      channels: (): Promise<string[]> => window.api.ipcList(ext.id),
      request: async (name, method, params, opts): Promise<unknown> => {
        const r = await window.api.ipcRequest(
          ext.id,
          name,
          method,
          params,
          opts?.timeoutMs,
          opts?.connectionId
        )
        if (!r.ok) throw new Error(`[${r.code ?? 'protocol-error'}] ${r.error ?? '请求失败'}`)
        return r.result
      },
      notify: async (name, method, params, opts): Promise<void> => {
        const r = await window.api.ipcNotify(ext.id, name, method, params, opts?.connectionId)
        if (!r.ok) throw new Error(`[${r.code ?? 'protocol-error'}] ${r.error ?? '发送通知失败'}`)
      },
      broadcast: async (name, method, params): Promise<void> => {
        const r = await window.api.ipcBroadcast(ext.id, name, method, params)
        if (!r.ok) throw new Error(`[${r.code ?? 'protocol-error'}] ${r.error ?? '广播失败'}`)
      },
      onRequest: (name, handler): Disposable => {
        const target = forChannel(name)
        target.requests.add(handler)
        return { dispose: (): void => void target.requests.delete(handler) }
      },
      onNotification: (name, cb): Disposable => {
        const target = forChannel(name)
        target.notifications.add(cb)
        return { dispose: (): void => void target.notifications.delete(cb) }
      },
      onClose: (name, cb): Disposable => {
        const target = forChannel(name)
        target.closes.add(cb)
        return { dispose: (): void => void target.closes.delete(cb) }
      },
      onStderr: (name, cb): Disposable => {
        const target = forChannel(name)
        target.stderrs.add(cb)
        return { dispose: (): void => void target.stderrs.delete(cb) }
      },
      onConnection: (name, cb): Disposable => {
        const target = forChannel(name)
        target.connections.add(cb)
        return { dispose: (): void => void target.connections.delete(cb) }
      },
      onDisconnect: (name, cb): Disposable => {
        const target = forChannel(name)
        target.disconnects.add(cb)
        return { dispose: (): void => void target.disconnects.delete(cb) }
      },
      onReconnect: (name, cb): Disposable => {
        const target = forChannel(name)
        target.reconnects.add(cb)
        return { dispose: (): void => void target.reconnects.delete(cb) }
      }
    }
  }
}

export const host = new ExtensionHost()
