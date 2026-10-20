/**
 * **渲染侧消费者**（EH-B3b-1）：把扩展宿主送来的"注册面"数据落到既有 registry / stores。
 *
 * 与宿主侧 `src/extension-host/capabilities/ui-plane.ts` 是一对：那边"说事实"，这边"落到唯一的
 * 真相里"（状态栏项 → `registry`、命令 → `registry.setCommandHandler`、树数据源 → `treeStore`、
 * App 卡片 → `appStore`、设置页 → `extensionSettingsStore`、设置值 → `stateStore`）。
 *
 * ## 为什么消费方不是"再建一套 store"
 *
 * 渲染侧的注册表就是 v1（扩展在渲染进程执行）的同一批 store，UI 组件只认它们。宿主模式要保证
 * **同一个界面、同一份真相**：扩展换到宿主里执行，界面不该换一套数据结构。所以这里只做搬运 +
 * 翻译，不新增状态。（唯一的本地状态是"宿主侧 id ↔ 渲染侧对象"的映射表，见 `runtimeStatusBarItems`）
 *
 * ## 方向
 *
 * - **收**：`host-renderer` 端口上的 `event` 信封（按 `channel` 分派，见 `EH_EVENT_CHANNELS`）。
 * - **发**：`settings` 通道的 `snapshot`（当前设置 / 语言 / 主题 id）——宿主的 `settings.get` /
 *   `theme.getCurrent` 是同步签名，只能读缓存，缓存靠这条消息校准；端口一到就推一次，之后每次
 *   设置变化再推。
 * - **问回去**：树子节点 / 执行命令 / App 消息寻址走 `req` 信封（既有 `ExtensionHostBridge.request`，
 *   `PROTOCOL_VERSION` 不变）。
 *
 * ## 回退开关
 *
 * 开关关（默认）⇒ 本模块**不订阅任何东西、不推任何东西**，`createExtensionHostConsumer()` 直接
 * 返回 `enabled: false` 的空壳。这是"默认行为零变化"的另一半（宿主侧那一半在 `extensionHostBridge`
 * 的 `handOverToExtensionHost`）。
 *
 * ## 容错
 *
 * 未知 channel / 未知子操作 / 畸形信封 / 载荷形状不对：**记日志 + 丢弃**，绝不抛错——消费者是
 * 宿主的对端，一条脏数据不该把整个界面的事件循环打断（`test/extension-host-ui-plane.test.ts`
 * 有专门的容错用例）。
 */
import {
  EH_EVENT_CHANNELS,
  createEventEnvelope,
  validateEnvelope,
  type Envelope
} from '../../../shared/extensionHostProtocol'
import type { AppRegistration, SettingsPage, TreeItem, TreeViewProvider } from '../../../api'
import { appStore } from './appStore'
import { extensionSettingsStore } from './extensionSettings'
import {
  getExtensionHostBridge,
  isExtensionHostEnabled,
  readExtensionHostFlag
} from './extensionHostBridge'
import { registry, type RegisteredStatusBarItem } from './registry'
import { STORAGE_KEY, parsePersistedState, stateStore } from './state'
import { themeStore } from './theme'
import { treeStore } from './treeStore'
import { i18n } from '../i18n'

/* -------------------------------------------------------------------------------------------- */
/* 常量                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** 数据面载荷版本（与宿主侧 `UI_PLANE_PAYLOAD_VERSION` 对应） */
export const HOSTED_UI_PAYLOAD_VERSION = 1

/**
 * 渲染侧 → 宿主的 RPC method。**与 `src/extension-host/capabilities/ui-plane.ts` 的
 * `UI_PLANE_RPC` 逐字一致**（两侧各写一份字符串是既有先例：`host-main.ts` 的 method 名在
 * `src/main/index.ts` 逐字重写；这里再加一条测试断言两边一致会更好，但跨侧 import 会把宿主
 * 代码打进渲染包，因此只靠"改一边就要改另一边"的注释约束 + 双端用例覆盖同一批字符串）。
 */
export const HOSTED_UI_RPC = {
  executeCommand: 'ui.executeCommand',
  treeChildren: 'ui.treeChildren',
  appMessage: 'ui.appMessage'
} as const

/* -------------------------------------------------------------------------------------------- */
/* 依赖接口（可注入，单测用假实现）                                                                */
/* -------------------------------------------------------------------------------------------- */

/** 日志出口（默认 console，统一 `[eh-ui]` 前缀便于与宿主日志区分） */
export interface HostedUiLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * 与宿主的**窄通道**（默认建在 `window.eh` + 既有桥单例上）。
 *
 * 拆成接口的理由与 `extensionHostBridge` 相同：单测要在没有 Electron、没有端口的 node 环境里
 * 精确驱动"收到一条事件"/"宿主没连上"两种情形。
 */
export interface HostedUiTransport {
  /** 发一个信封；端口未到返回 false（不抛错） */
  post(envelope: Envelope): boolean
  /** 订阅宿主发来的原始信封 */
  onEnvelope(listener: (raw: unknown) => void): () => void
  /** 发 `req` 并等 `res`（复用既有桥：3 秒超时、错误码、可传输性守卫都在那边） */
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  /** 端口到达通知（可选：默认实现接 preload 的 `eh.onPort`；缺省时只在启动推一次快照） */
  onPort?(listener: () => void): () => void
}

/**
 * 宿主侧（`core/host.ts`）要提供的那一点点内部入口。
 *
 * 目前**只有一条**：把宿主扩展的 `app.onMessage` 处理器挂进既有消息桥的归属路由
 * （`appMessageHandlers`）。其余数据消费者直接落到 store——那本来就是"唯一的真相"，
 * 多绕一层 host 反而会造出第二份状态（host.ts 保持最小侵入）。
 */
export interface HostedUiHostAdapter {
  /** 登记一个宿主扩展的 App 消息处理器（返回注销函数） */
  registerHostedAppMessageHandler(
    extensionId: string,
    handler: (channel: string, payload: unknown) => unknown | Promise<unknown>
  ): () => void
}

/** 消费者的构造参数 */
export interface ExtensionHostConsumerOptions {
  /** 回退开关原文（缺省读 preload 的 `OBOX_EXTENSION_HOST`） */
  flag?: string | null
  /** 窄通道（缺省建在 `window.eh` + 桥单例上） */
  transport?: HostedUiTransport
  /** 宿主侧内部入口（缺省尝试用 `core/host` 的单例；测试注入假件） */
  host?: HostedUiHostAdapter
  logger?: HostedUiLogger
  /** 读当前持久化设置（缺省解析 localStorage 快照；测试注入） */
  readSettings?(): Record<string, unknown>
  /** 读当前语言（缺省 `i18n.global.locale`） */
  readLocale?(): string
  /** 读当前主题 id（缺省 `themeStore.currentId`） */
  readThemeId?(): string
}

/** 消费者的观察面 */
export interface ExtensionHostConsumer {
  /** 开关是否打开（关 ⇒ 下面所有方法都是空操作） */
  readonly enabled: boolean
  /** 退订一切（幂等） */
  stop(): void
  /** 立刻推一次快照（幂等；端口未到会失败并等 `onPort` 重试） */
  pushSnapshot(): void
  /** 处理一条原始信封（入口也走它；测试直接调） */
  handleEnvelope(raw: unknown): void
  /** 诊断/测试：当前已落地的条目数 */
  stats(): {
    runtimeStatusBarItems: number
    commands: number
    treeProviders: number
    appMessageHandlers: number
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 载荷类型（与宿主侧 ui-plane.ts 结构一致；改形状要两边一起改）                                     */
/* -------------------------------------------------------------------------------------------- */

type StatusBarPayload =
  | { v: 1; kind: 'setText'; extId: string; id: string; text: string }
  | { v: 1; kind: 'setTooltip'; extId: string; id: string; tooltip: string }
  | { v: 1; kind: 'setVisible'; extId: string; id: string; visible: boolean }
  | {
      v: 1
      kind: 'create'
      extId: string
      id: string
      init: { text?: string; tooltip?: string; alignment?: 'left' | 'right'; priority?: number }
    }
  | { v: 1; kind: 'dispose'; extId: string; id: string }
  | { v: 1; kind: 'disposeExtension'; extId: string }

type ViewsPayload =
  | { v: 1; kind: 'treeProvider'; op: 'register' | 'dispose'; extId: string; viewId: string }
  | { v: 1; kind: 'navBadge'; extId: string; id: string; count: number | null }

type CommandsPayload =
  | { v: 1; op: 'register'; extId: string; command: string; title?: string }
  | { v: 1; op: 'dispose'; extId: string; command: string }

type AppRegisterPayload =
  | { v: 1; op: 'register'; extId: string; registration: AppRegistration }
  | { v: 1; op: 'dispose'; extId: string; appId: string }
  /** `app.onMessage` 注册（宿主说"消息可以往我这里寻址"） */
  | { v: 1; op: 'messageHandler'; extId: string }

type SettingsHostPayload =
  | { v: 1; op: 'registerPage'; extId: string; page: SettingsPage }
  | { v: 1; op: 'disposePage'; extId: string; pageId: string }
  | { v: 1; op: 'set'; key: string; value: unknown }
  | { v: 1; op: 'unset'; key: string }

/** 推给宿主的快照（`settings` 通道；宿主据此校准 `settings.get` / `theme.getCurrent`） */
export interface HostedSettingsSnapshot {
  v: 1
  op: 'snapshot'
  settings: Record<string, unknown>
  locale: string
  themeId: string
}

/* -------------------------------------------------------------------------------------------- */
/* 默认实现                                                                                      */
/* -------------------------------------------------------------------------------------------- */

const consoleLogger: HostedUiLogger = {
  debug: (message): void => console.debug(`[eh-ui] ${message}`),
  info: (message): void => console.info(`[eh-ui] ${message}`),
  warn: (message): void => console.warn(`[eh-ui] ${message}`),
  error: (message): void => console.error(`[eh-ui] ${message}`)
}

/** 默认窄通道：发送/订阅走 preload 的端口代理，反向调用走既有桥（超时与错误码都在那边） */
export function createWindowUiTransport(): HostedUiTransport {
  const noop = (): void => undefined
  const surface = (): Window['eh'] => (typeof window === 'undefined' ? undefined : window.eh)
  return {
    post: (envelope: Envelope): boolean => surface()?.post(envelope) === true,
    onEnvelope: (listener: (raw: unknown) => void): (() => void) =>
      surface()?.onMessage(listener) ?? noop,
    request: <T = unknown>(method: string, params?: unknown): Promise<T> =>
      getExtensionHostBridge().request<T>(method, params),
    onPort: (listener: () => void): (() => void) => surface()?.onPort(() => listener()) ?? noop
  }
}

/**
 * 默认设置读取：解析 `stateStore` 落盘的同一份快照（`parsePersistedState` 是那边的纯函数）。
 *
 * 为什么不给 `stateStore` 加一个"读全部设置"的方法：那要动 `core/state.ts`（本卡不碰），
 * 而 `STORAGE_KEY` 与 `parsePersistedState` 都已导出——读同一份 JSON 与"加个 getter"等价，
 * 且不会让宿主的缓存与真实存储产生第二种取值路径。
 */
function readPersistedSettings(): Record<string, unknown> {
  try {
    return parsePersistedState(localStorage.getItem(STORAGE_KEY)).settings
  } catch {
    return {}
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 消费者                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** 一个宿主扩展在本地留下的痕迹（停用时按它清理） */
interface ExtensionTraces {
  readonly commands: Map<string, () => void>
  readonly treeProviders: Map<string, () => void>
  readonly appCards: Map<string, () => void>
  /** `app.onMessage` 的注销函数 */
  appMessageHandler: (() => void) | null
}

/** 空消费者（开关关闭时返回；所有方法都是空操作） */
function disabledConsumer(): ExtensionHostConsumer {
  return {
    enabled: false,
    stop: (): void => undefined,
    pushSnapshot: (): void => undefined,
    handleEnvelope: (): void => undefined,
    stats: () => ({
      runtimeStatusBarItems: 0,
      commands: 0,
      treeProviders: 0,
      appMessageHandlers: 0
    })
  }
}

/**
 * 创建消费者：**开关打开时**立刻开始订阅（先推快照，再收事件）。
 *
 * 开关关闭（默认）⇒ 返回 `enabled: false` 的空壳，`window` / `localStorage` / 桥一律不碰。
 */
export function createExtensionHostConsumer(
  options: ExtensionHostConsumerOptions = {}
): ExtensionHostConsumer {
  const flag = options.flag === undefined ? readExtensionHostFlag() : options.flag
  if (!isExtensionHostEnabled(flag)) return disabledConsumer()

  const logger = options.logger ?? consoleLogger
  const transport = options.transport ?? createWindowUiTransport()
  const readSettings = options.readSettings ?? readPersistedSettings
  const readLocale = options.readLocale ?? ((): string => String(i18n.global.locale.value ?? 'zh'))
  const readThemeId = options.readThemeId ?? ((): string => themeStore.currentId)

  /** 宿主侧运行时状态栏项 id → 渲染侧注册表里的那条项 */
  const runtimeStatusBarItems = new Map<string, RegisteredStatusBarItem>()
  const traces = new Map<string, ExtensionTraces>()
  const offs: Array<() => void> = []
  let stopped = false

  const traceOf = (extId: string): ExtensionTraces => {
    const existing = traces.get(extId)
    if (existing) return existing
    const created: ExtensionTraces = {
      commands: new Map(),
      treeProviders: new Map(),
      appCards: new Map(),
      appMessageHandler: null
    }
    traces.set(extId, created)
    return created
  }

  /* --------------------------------- 发给宿主：快照 --------------------------------- */

  /**
   * 推一次快照。
   *
   * 端口还没到（`post` 返回 false）**不算错误**：宿主是渲染侧自己请求启动的，端口到达之前推一定
   * 失败。`onPort` 会在端口到达时再调一次（这是宿主拿到设置/主题的唯一校准时机，必须补上）。
   */
  const pushSnapshot = (): void => {
    if (stopped) return
    const payload: HostedSettingsSnapshot = {
      v: HOSTED_UI_PAYLOAD_VERSION,
      op: 'snapshot',
      settings: readSettings(),
      locale: readLocale(),
      themeId: readThemeId()
    }
    const delivered = transport.post(createEventEnvelope(EH_EVENT_CHANNELS.settings, payload))
    if (!delivered) {
      logger.debug('设置快照没有发出去（host-renderer 端口未到），等端口到达后再推')
    }
  }

  /* --------------------------------- 状态栏 --------------------------------- */

  const statusBarItemOf = (id: string): RegisteredStatusBarItem | undefined => {
    const runtime = runtimeStatusBarItems.get(id)
    if (runtime) return runtime
    // 静态项（manifest 声明）：注册表里已有同名项，直接改它（与 v1 的 api.statusBar.* 同一落点）
    return registry.getStatusBarItem(id)
  }

  const applyStatusBar = (payload: StatusBarPayload): void => {
    switch (payload.kind) {
      case 'setText': {
        const item = statusBarItemOf(payload.id)
        if (item) item.text = payload.text
        else logger.debug(`状态栏项 ${payload.id} 不在注册表里（setText 被忽略）`)
        return
      }
      case 'setTooltip': {
        const item = statusBarItemOf(payload.id)
        if (item) item.tooltip = payload.tooltip
        return
      }
      case 'setVisible': {
        const item = statusBarItemOf(payload.id)
        if (item) item.visible = payload.visible
        return
      }
      case 'create': {
        // 渲染侧自己生成终态 id（`runtime:<ext>:<seq>`），宿主侧的 id 只作映射键：
        // `registry.createRuntimeStatusBarItem` 的 id 规则是注册表的既有约定，不改它（不碰 registry.ts）
        const item = registry.createRuntimeStatusBarItem(payload.extId, payload.init)
        runtimeStatusBarItems.set(payload.id, item)
        return
      }
      case 'dispose': {
        const item = runtimeStatusBarItems.get(payload.id)
        if (!item) return
        runtimeStatusBarItems.delete(payload.id)
        item.active = false
        const index = registry.runtimeStatusBarItems.indexOf(item)
        if (index >= 0) registry.runtimeStatusBarItems.splice(index, 1)
        return
      }
      case 'disposeExtension':
        cleanupExtension(payload.extId)
        return
      default:
        logger.warn(`未知的 statusBar 子操作 ${String((payload as { kind?: unknown }).kind)}`)
    }
  }

  /* --------------------------------- 视图（树 + 导航徽标） --------------------------------- */

  const applyViews = (payload: ViewsPayload): void => {
    if (payload.kind === 'navBadge') {
      // `null` = 清除徽标（宿主侧的 `setBadge(id, undefined)`）
      registry.setNavBadge(payload.id, payload.count === null ? undefined : payload.count)
      return
    }
    if (payload.kind === 'treeProvider') {
      const key = `${payload.extId}:${payload.viewId}`
      const existing = traceOf(payload.extId).treeProviders.get(key)
      if (payload.op === 'dispose') {
        existing?.()
        traceOf(payload.extId).treeProviders.delete(key)
        return
      }
      existing?.()
      const provider: TreeViewProvider = {
        getChildren: (element?: TreeItem): Promise<TreeItem[]> =>
          transport.request<TreeItem[]>(HOSTED_UI_RPC.treeChildren, {
            extId: payload.extId,
            viewId: payload.viewId,
            element: element ?? null
          })
      }
      const off = treeStore.registerTreeProvider(payload.viewId, provider, payload.extId)
      traceOf(payload.extId).treeProviders.set(key, off)
      return
    }
    logger.warn(`未知的 views 子类型 ${String((payload as { kind?: unknown }).kind)}`)
  }

  /* --------------------------------- 命令 --------------------------------- */

  const applyCommands = (payload: CommandsPayload): void => {
    const trace = traceOf(payload.extId)
    if (payload.op === 'dispose') {
      trace.commands.get(payload.command)?.()
      trace.commands.delete(payload.command)
      return
    }
    trace.commands.get(payload.command)?.()
    const handler = (...args: unknown[]): Promise<unknown> =>
      transport.request(HOSTED_UI_RPC.executeCommand, {
        command: payload.command,
        args
      })
    try {
      // 命令必须已在注册表里（manifest `contributes.commands` 在启动阶段一就注册了）；
      // 未声明时 `setCommandHandler` 会抛——照 v1 的语义"注册了未声明的命令"只告警，不打断别的扩展
      const disposable = registry.setCommandHandler(payload.command, handler, payload.extId)
      trace.commands.set(payload.command, () => disposable.dispose())
    } catch (error) {
      logger.warn(
        `宿主扩展 ${payload.extId} 的命令 ${payload.command} 无法绑定实现：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  /* --------------------------------- App 卡片与消息 --------------------------------- */

  const applyAppRegister = (payload: AppRegisterPayload): void => {
    const trace = traceOf(payload.extId)
    if (payload.op === 'register') {
      const disposable = appStore.register(payload.extId, payload.registration)
      trace.appCards.set(payload.registration.id, () => disposable.dispose())
      return
    }
    if (payload.op === 'dispose') {
      trace.appCards.get(payload.appId)?.()
      trace.appCards.delete(payload.appId)
      return
    }
    if (payload.op === 'messageHandler') {
      const adapter = options.host
      if (!adapter) {
        logger.warn(
          `宿主扩展 ${payload.extId} 注册了 app.onMessage，但渲染侧没有拿到 host 适配器：` +
            '消息会被回「扩展未注册消息处理器」'
        )
        return
      }
      trace.appMessageHandler?.()
      trace.appMessageHandler = adapter.registerHostedAppMessageHandler(
        payload.extId,
        (channel: string, messagePayload: unknown) =>
          transport.request(HOSTED_UI_RPC.appMessage, {
            extId: payload.extId,
            channel,
            payload: messagePayload ?? null
          })
      )
      return
    }
    logger.warn(`未知的 app.register 子操作 ${String((payload as { op?: unknown }).op)}`)
  }

  /* --------------------------------- 设置页与设置值 --------------------------------- */

  const applySettings = (payload: SettingsHostPayload): void => {
    switch (payload.op) {
      case 'registerPage':
        extensionSettingsStore.register(payload.extId, payload.page)
        return
      case 'disposePage':
        extensionSettingsStore.removePage(payload.pageId)
        return
      case 'set':
        // 宿主写设置 = v1 扩展自己写设置：同一个 `stateStore`，同一条持久化与通知链
        stateStore.setSetting(payload.key, payload.value)
        return
      case 'unset':
        stateStore.setSetting(payload.key, undefined)
        return
      default:
        logger.warn(`未知的 settings 子操作 ${String((payload as { op?: unknown }).op)}`)
    }
  }

  /* --------------------------------- 扩展整体清理 --------------------------------- */

  /**
   * 宿主说"这个扩展没了"：把它的痕迹全部撤掉。
   *
   * 与 v1 的 `host.removeExtension` 同一批落点（状态栏/命令/树/卡片/设置页/消息处理器），只是
   * 触发源变成宿主事件。**幂等**：重复收到同一条不会出错。
   */
  function cleanupExtension(extId: string): void {
    const trace = traces.get(extId)
    registry.removeRuntimeStatusBarItems(extId)
    for (const [hostId, item] of [...runtimeStatusBarItems]) {
      if (item.extensionId === extId) runtimeStatusBarItems.delete(hostId)
    }
    if (trace) {
      for (const dispose of trace.commands.values()) dispose()
      for (const dispose of trace.treeProviders.values()) dispose()
      for (const dispose of trace.appCards.values()) dispose()
      trace.appMessageHandler?.()
      traces.delete(extId)
    }
    appStore.deactivateExtension(extId)
    extensionSettingsStore.deactivateExtension(extId)
  }

  /* --------------------------------- 入站分派 --------------------------------- */

  const handleEventEnvelope = (channel: string, payload: unknown): void => {
    if (typeof payload !== 'object' || payload === null) {
      logger.warn(`channel=${channel} 的载荷不是对象，已丢弃`)
      return
    }
    switch (channel) {
      case EH_EVENT_CHANNELS.statusBar:
        applyStatusBar(payload as StatusBarPayload)
        return
      case EH_EVENT_CHANNELS.views:
        applyViews(payload as ViewsPayload)
        return
      case EH_EVENT_CHANNELS.commands:
        applyCommands(payload as CommandsPayload)
        return
      case EH_EVENT_CHANNELS.appRegister:
        applyAppRegister(payload as AppRegisterPayload)
        return
      case EH_EVENT_CHANNELS.settings:
        applySettings(payload as SettingsHostPayload)
        return
      case EH_EVENT_CHANNELS.theme:
      case EH_EVENT_CHANNELS.bubble:
      case EH_EVENT_CHANNELS.cardIcon:
        // 已知但本卡不消费（气泡/卡片图标运行期更新归后续卡；theme 方向是"渲染侧 → 宿主"）
        logger.debug(`channel=${channel} 在 EH-B3b-1 里不消费，已忽略`)
        return
      default:
        // 未知 channel：容错丢弃（协议刻意不把 channel 定死，未来能力会加新 channel）
        logger.debug(`收到未知 channel=${channel} 的宿主事件，已忽略`)
    }
  }

  const handleEnvelope = (raw: unknown): void => {
    if (stopped) return
    const checked = validateEnvelope(raw)
    if (!checked.ok) {
      logger.warn(`收到畸形的宿主信封（${checked.code}）：${checked.why}`)
      return
    }
    const envelope = checked.env
    if (envelope.t === 'event') {
      handleEventEnvelope(envelope.channel, envelope.payload)
      return
    }
    if (envelope.t === 'log') {
      // 宿主日志已由桥转发到 console；这里不重复打印（桥的 `onLog` 是另一条订阅）
      return
    }
    // res / err / req / cancel 由桥自己配对处理；握手类信封与本消费者无关
    logger.debug(`消费者忽略信封 t=${envelope.t}`)
  }

  /* --------------------------------- 启动 --------------------------------- */

  offs.push(transport.onEnvelope(handleEnvelope))
  // 设置一变化就把新快照推给宿主（宿主的 settings.get / theme.getCurrent / i18n 都靠它校准）
  offs.push(
    stateStore.onSettingsChanged(() => {
      pushSnapshot()
    })
  )
  if (transport.onPort) {
    offs.push(
      transport.onPort(() => {
        // 端口到达 = 宿主此刻才可能收到快照；补推一次（首次 `post` 一定失败）
        pushSnapshot()
      })
    )
  }
  pushSnapshot()
  logger.info('扩展宿主数据面消费者已启动（开关 OBOX_EXTENSION_HOST 打开）')

  return {
    enabled: true,
    stop(): void {
      if (stopped) return
      stopped = true
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch {
          // 退订失败不该影响其余退订
        }
      }
      for (const extId of [...traces.keys()]) cleanupExtension(extId)
      runtimeStatusBarItems.clear()
    },
    pushSnapshot,
    handleEnvelope,
    stats: () => ({
      runtimeStatusBarItems: runtimeStatusBarItems.size,
      commands: [...traces.values()].reduce((sum, trace) => sum + trace.commands.size, 0),
      treeProviders: [...traces.values()].reduce((sum, trace) => sum + trace.treeProviders.size, 0),
      appMessageHandlers: [...traces.values()].filter((trace) => trace.appMessageHandler !== null)
        .length
    })
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 主窗口接线                                                                                    */
/* -------------------------------------------------------------------------------------------- */

let singleton: ExtensionHostConsumer | null = null

/**
 * 主窗口启动消费者（**幂等**；开关关闭时什么都不做，也不留全局副作用）。
 *
 * 调用时机：`main.ts` 里 `host.start()` **之前**（消费者要先订阅端口到达，才能保证宿主的第一次
 * `settings.get` 有缓存可读）。
 */
export function startExtensionHostConsumer(
  options: ExtensionHostConsumerOptions = {}
): ExtensionHostConsumer {
  if (!singleton) singleton = createExtensionHostConsumer(options)
  return singleton
}

/** 当前消费者（未启动时为 `null`；诊断用） */
export function currentExtensionHostConsumer(): ExtensionHostConsumer | null {
  return singleton
}

/** 停掉单例（**只给测试**：vitest 同一进程里会反复建消费者） */
export function stopExtensionHostConsumer(): void {
  singleton?.stop()
  singleton = null
}
