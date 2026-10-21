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
 *
 * ---
 *
 * # EH-B3b-2 · 状态与 UI 面（本卡追加）
 *
 * 本卡让渲染侧从"只收数据"变成**也当服务端**：`ui`(5) / `output.createChannel`(1) / `update` 门控(4)
 * 的渲染与判定都在这里，宿主只是发起方（宿主侧见 `capabilities/ui-plane.ts` 的 `RpcClient`）。
 *
 * ## 新增的两件事
 *
 * 1. **一个渲染侧 `RpcServer`**（复用 `src/extension-host/rpc.ts`：纯模块、无 Node 依赖，main 早已
 *    复用同一份）。它挂在**同一个** `host-renderer` 端口上，收宿主发来的 `req`/`cancel`，回
 *    `res`/`err`。method 见 {@link HOSTED_RENDERER_RPC}（与宿主侧 `UI_RENDERER_RPC` 逐字一致）。
 *    **方向与前三个 `ui.*` 相反**：那三条是"渲染侧问宿主"（走 A4 的桥），这八条是"宿主问渲染侧"。
 * 2. **`output` 事件通道**（{@link HOSTED_UI_EVENT_CHANNELS}）：宿主 `createChannel` 之后把
 *    通道 id/名称推过来，这里落到 `outputStore`；`append`/`appendLine`/`show`/`clear`/`dispose`
 *    也走同一条通道。通道 id 由宿主生成，本文件维护"宿主 id ↔ 渲染侧句柄"的映射
 *    （与 B3b-1 的 `runtimeStatusBarItems` 同一手法）。
 *
 * ## 语义**照抄 v1**（`core/host.ts` 的 `showUiModal` / `uiStore` / `updaterStore`）
 *
 * - 模态框取消 ⇒ `{value:null}`（宿主翻成 `undefined`）；**超时由宿主侧计时**（60s，v1 在 main 里）；
 * - `showMessage` ⇒ `uiStore.showToast`（v1 逐字同一个调用）；
 * - `withProgress` ⇒ `uiStore.showProgress/hideProgress`（v1 是同一个单槽，所以新进度会**顶掉**旧
 *   的并把旧的判为取消——这是 v1 "单槽"语义的显式化，见 `cancelProgress`）；
 * - `updateGate` ⇒ `updaterStore.isActive(extId)`（**唯一真相**），拒绝文案照抄 v1。
 *
 * ## 窗口不在时**响亮**
 *
 * 渲染侧每个 UI handler 进来先过 {@link HOSTED_UI_WINDOW_MISSING} 的判定（`hasWindow()`，
 * 缺省看 `window`/`document` 是否存在，单测可注入）。没有窗口 ⇒ 回 `EH_NOT_READY` + 中文错误，
 * 宿主侧当场抛，不会让扩展的 Promise 永远挂着。
 *
 * ---
 *
 * # EH-C2 · 激活触发（本卡追加）
 *
 * 本卡给消费者加**唯一一个新方法**：{@link ExtensionHostConsumer.ensureActivated | ensureActivated}。
 * 它把"某扩展该激活了"从渲染侧送到宿主（`host.activate` RPC，走同一个 `host-renderer` 端口），
 * 并等宿主真的跑完 `plugin(api)` 再回来。
 *
 * 三条设计约束（都对应用例）：
 * 1. **合并**：同一扩展的并发 `ensureActivated` 只有**一条**在途请求（按 extId 的 Map），
 *    已确认激活过则零请求（`Set` 缓存）；宿主仍然有一层 `Activator` 的并发去重（双保险）。
 * 2. **超时**：{@link ACTIVATION_TIMEOUT_MS}（10 秒，不是桥的 3 秒）——激活要读盘 + 跑用户代码，
 *    3 秒的假超时会让用户看到"随机失败"，超时本身仍要能报错。
 * 3. **失败响亮**：`failed` 回包 / 传输错误一律抛 `EhProtocolError`（中文，含 extId + 触发原因 +
 *    宿主给的失败归类），调用方据此**中止**动作，不会拿一个没有实现的命令继续跑。
 *
 * 回退开关：关闭时消费者是空壳（`enabled: false`），`ensureActivated` 返回 `skipped` 且**零请求**；
 * 调用方（`core/host.ts`）先看 `enabled`，关闭态根本不会走宿主路径。
 *
 * ---
 *
 * # EH-D8b · overlay 归属（技术债 #13）
 *
 * 宿主进程里 `api.overlay.create` 由 main 建窗，**渲染侧的 `overlayOwners` 不会被回填**——那张表
 * 只在渲染进程自己的 `api.overlay.create` 路径里写。于是页面消息（`extension:message`，按
 * `appId`/`overlayId` 路由）永远找不到所属扩展，`app.onMessage` 一律回「扩展未注册消息处理器」
 * （实测：宠物窗口看得见、动画在播，但面板永远空、点击全无效）。
 *
 * 本卡给消费者加**第四条入口**（不新增 RPC、不改协议）：收 `overlay-owner` 事件
 * （{@link HOSTED_UI_EVENT_CHANNELS}），把 `bind` / `unbind` 转成
 * `HostedUiHostAdapter.registerHostedOverlayOwner()` 的登记/注销（落到 `core/host.ts` 的
 * `overlayOwners`）。扩展停用时（`disposeExtension`）连同归属一起撤，避免表里留脏 id。
 *
 * 时序：宿主在 `overlay.create` 成功之后、把结果回给扩展之前**同步**发 `bind`，所以"页面能发
 * 第一条消息"（窗口加载完才可能）时路由项已经在表里；端口未到时宿主侧抛 `EH_NOT_READY`，
 * 让 `overlay.create` 明确失败（不建哑窗口）。
 */
import {
  EH_EVENT_CHANNELS,
  EhProtocolError,
  createEventEnvelope,
  validateEnvelope,
  type ActivationReason,
  type Envelope,
  type RequestEnvelope
} from '../../../shared/extensionHostProtocol'
import type {
  AppRegistration,
  FormField,
  QuickPickItem,
  SettingsPage,
  TreeItem,
  TreeViewProvider
} from '../../../api'
import { RpcServer } from '../../../extension-host/rpc'
import { appStore } from './appStore'
import { extensionSettingsStore } from './extensionSettings'
import {
  getExtensionHostBridge,
  isExtensionHostEnabled,
  readExtensionHostFlag
} from './extensionHostBridge'
import { outputStore } from './outputStore'
import { registry, type RegisteredStatusBarItem } from './registry'
import { STORAGE_KEY, parsePersistedState, stateStore } from './state'
import { themeStore } from './theme'
import { treeStore } from './treeStore'
import { uiStore } from './uiStore'
import { updaterStore } from './updaterStore'
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
  appMessage: 'ui.appMessage',
  /** EH-B3b-2：取消宿主侧的 `ui.withProgress`（宿主把它结算成 `EH_CANCELLED`） */
  progressCancel: 'ui.progressCancel',
  /**
   * EH-C2：**激活**（渲染侧 → 宿主，走 `host-renderer` 端口）。与宿主侧 `UI_PLANE_RPC.activate`
   * 逐字一致，也与 main 侧 `host.activate` **同名**——"激活一个扩展"在全链路上只有一个名字。
   * 方向仍是"渲染侧 → 宿主"，所以放在这张表里（`test/extension-host-ui-plane2` 的两侧一致性
   * 断言因此自动覆盖它）。
   */
  activate: 'host.activate'
} as const

/**
 * 激活请求的超时（毫秒，EH-C2）。
 *
 * 为什么不复用桥的 3 秒（`ACK_TIMEOUT_MS`）：3 秒是**普通 RPC 往返**的预算（ping / 取树子节点 /
 * 执行一条已经就绪的命令）。激活要走 `import()` 读盘 + `plugin(api)` 跑用户代码，冷启动 + 杀毒
 * 软件扫描 + 扩展自己做初始化时，3 秒非常容易假超时；而假超时的后果是"命令报超时，但扩展随后
 * 真的激活了"，用户看到的是随机失败。10 秒在本机上是"慢，但确实还在干活"的量级。
 *
 * 也不给无限：这是命令执行/视图打开的前置等待，卡死必须能报错（`EH_TIMEOUT`，文案要求重启宿主）。
 */
export const ACTIVATION_TIMEOUT_MS = 10_000

/**
 * **宿主 → 渲染侧**的 RPC method（本卡新增，方向相反）。与宿主侧 `UI_RENDERER_RPC` 逐字一致，
 * 由 `test/extension-host-ui-plane2.test.ts` 断言（跨侧 import 会把 `node:fs` 带进渲染包）。
 */
export const HOSTED_RENDERER_RPC = {
  showMessage: 'ui.showMessage',
  showQuickPick: 'ui.showQuickPick',
  showInputBox: 'ui.showInputBox',
  showForm: 'ui.showForm',
  withProgress: 'ui.withProgress',
  progressUpdate: 'ui.progressUpdate',
  progressEnd: 'ui.progressEnd',
  updateGate: 'ui.updateGate'
} as const

/** 本卡新增的 `event` channel（与宿主侧 `UI_PLANE_EVENT_CHANNELS` 逐字一致） */
export const HOSTED_UI_EVENT_CHANNELS = {
  output: 'output',
  /**
   * **overlay 归属**（EH-D8b / 技术债 #13）：宿主创建的 overlay 的 `overlayId → extId`。
   *
   * 没有它，宿主模式下 `core/host.ts` 的 `overlayOwners` 永远不会回填（回填只发生在渲染进程
   * 自己的 `api.overlay.create` 里），页面消息一律得到「扩展未注册消息处理器」。
   */
  overlayOwner: 'overlay-owner'
} as const

/** 渲染侧**没有窗口**时的中文错误（与宿主侧 `UI_WINDOW_MISSING` 同一句） */
export const HOSTED_UI_WINDOW_MISSING =
  '界面窗口不在：该 UI（quickPick / inputBox / form / withProgress / toast）必须由渲染进程的 ' +
  'uiStore 渲染，但当前渲染侧没有可用窗口（主窗口正在销毁或页面已卸载）。请等主窗口恢复后重试；' +
  '宿主模式下没有 v1 的"本地渲染"兜底，所以这里明确报错而不是静默等待。'

/** 更新门控拒绝文案（与 v1 `core/host.ts` 的 `isProvider()` 逐字一致） */
export const HOSTED_UPDATE_NOT_PROVIDER = '当前扩展不是生效的更新提供者（需在设置-更新中选择）'

/** `outputStore.createChannel` 的返回句柄（结构类型：不为一个别名去改 store 的导出面） */
type OutputChannelHandle = ReturnType<typeof outputStore.createChannel>

/** 未知值 → 普通对象（宿主发来的 params 一定是纯数据，这里只做形状兜底） */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : ({} as Record<string, unknown>)
}

/** 未知错误 → 一行中文可读文本（日志与错误文案共用） */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 激活原因 → 用户在日志/错误文案里能对照清单的那一行（`onCommand:foo` / `onView:bar`）。
 * 与宿主 `status.ts` 的 `describeActivationReason` 同一份写法，但本文件不 import 宿主代码
 * （跨侧 import 会把 `node:*` 带进渲染包）。
 */
function formatActivationReason(reason: ActivationReason): string {
  if (reason === '*') return '*（启动即激活）'
  if (reason === 'onStartupFinished') return 'onStartupFinished（启动完成后激活）'
  if ('command' in reason) return `onCommand:${reason.command}`
  return `onView:${reason.view}`
}

/**
 * 宿主 `host.activate` 的回包（结构上 = 宿主侧 `ActivationHandlerResult` / `ActivationResult`）。
 *
 * 字段全部按 `unknown` 收：这是**跨进程来的数据**，形状不可信；校验在 `performActivation` 里做，
 * 不合法就报 `EH_INTERNAL`（协议不匹配），绝不按 `as` 硬转后当真。
 */
interface HostedActivationResult {
  extId?: unknown
  reason?: unknown
  state?: unknown
  failure?: { kind?: unknown; message?: unknown }
}

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
  /**
   * 发 `req` 并等 `res`（复用既有桥：3 秒超时、错误码、可传输性守卫都在那边）。
   *
   * `options.timeoutMs`（EH-C2 新增，可选）：激活请求要等用户代码真的跑完，比普通 RPC 慢得多，
   * 见 {@link ACTIVATION_TIMEOUT_MS}。缺省仍是桥的 3 秒（既有四条 method 的行为零变化）。
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T>
  /** 端口到达通知（可选：默认实现接 preload 的 `eh.onPort`；缺省时只在启动推一次快照） */
  onPort?(listener: () => void): () => void
  /**
   * 接管**宿主发起的反向 RPC**（EH-B3b-2；可选，返回注销函数）。
   *
   * 默认实现（`createWindowUiTransport`）接到 `core/extensionHostBridge` 的同名入口上——A4 的桥
   * 收到 `req` 本来只会回 `EH_INTERNAL`，必须由本消费者的 `RpcServer` 接手，否则宿主的
   * `ui.*` / `ui.updateGate` 在真机上永远拿不到结果。**单测的假通道不实现它**，于是
   * `req` 走 `onEnvelope` 的原始信封路径（两条路径的语义一致，见 `handleEnvelope`）。
   */
  onHostRequest?(handler: (envelope: RequestEnvelope) => boolean): () => void
}

/**
 * 宿主侧（`core/host.ts`）要提供的那一点点内部入口。
 *
 * 只有两条，都是"渲染侧消息桥的归属表"：
 * 1. `app.onMessage` 处理器（`appMessageHandlers`）——宿主扩展的消息实现；
 * 2. **overlay 归属**（`overlayOwners`，EH-D8b）——宿主创建的 overlay 的 `overlayId → extId`。
 *
 * 其余数据消费者直接落到 store——那本来就是"唯一的真相"，多绕一层 host 反而会造出第二份状态
 * （host.ts 保持最小侵入）。
 */
export interface HostedUiHostAdapter {
  /** 登记一个宿主扩展的 App 消息处理器（返回注销函数） */
  registerHostedAppMessageHandler(
    extensionId: string,
    handler: (channel: string, payload: unknown) => unknown | Promise<unknown>
  ): () => void
  /**
   * 登记一个**宿主进程创建的 overlay** 的归属（EH-D8b / 技术债 #13；返回注销函数）。
   *
   * 为什么需要：宿主模式的 overlay 由宿主的 `api.overlay.create` 经 main 建窗，渲染进程自己的
   * `api.overlay.create`（唯一会回填 `overlayOwners` 的地方）根本没被调用，于是页面消息寻址不到
   * 该扩展——症状是"窗口看得见、动画在播，但面板空、点击全无效"。
   *
   * **可选**：渲染侧适配器可能还没有这一条（旧版 `core/host.ts`、或单测的假适配器）。缺省时收到
   * 归属事件只记一条 warn（响亮，不静默——否则又变成"看起来什么都没配"）。
   */
  registerHostedOverlayOwner?(extensionId: string, overlayId: string): () => void
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
  /**
   * 渲染侧是否有可用窗口（EH-B3b-2）。
   *
   * 缺省看 `window` 与 `document` 是否存在。宿主问过来的 UI 请求（quickPick/inputBox/form/
   * withProgress/toast）必须先过它：没有窗口时**回 `EH_NOT_READY` + 中文错误**，而不是让宿主
   * 的 Promise 永远挂着（宿主侧没有 v1 的 `localFn` 本地兜底）。单测注入 `() => false` 即可覆盖。
   */
  hasWindow?(): boolean
}

/**
 * 一次 `ensureActivated` 的结果（EH-C2）。
 *
 * 只有两种"成功"：`activated` = 这次真的把它激活了；`skipped` = 宿主说它已经激活过（或开关关闭
 * 时的空壳）。**失败一律抛错**（`EhProtocolError`，中文可执行文案），因为调用方（执行命令 /
 * 打开视图）必须知道"目标没就绪"，不能拿着一个没有实现的命令往下走。
 */
export interface HostedActivationOutcome {
  extId: string
  /** 触发原因（原样带回，便于日志与断言） */
  reason: ActivationReason
  /** `activated` 本次激活；`skipped` 已激活（或消费者是关闭态的空壳） */
  state: 'activated' | 'skipped'
}

/**
 * 渲染侧需要的"激活触发"窄接口（EH-C2）。
 *
 * `core/host.ts` 只依赖这两个成员（`enabled` + `ensureActivated`），不 import 消费者的整张面：
 * 宿主侧（`core/host.ts`）是"谁该激活"的判定方，消费者是"怎么让宿主激活"的执行方，两边只在这一处
 * 相交。单测因此可以注入一个三行的假件，而不必造 Electron / 端口。
 */
export interface HostedActivationPort {
  /** 开关是否打开（关 ⇒ `ensureActivated` 是空操作，调用方也不必走宿主路径） */
  readonly enabled: boolean
  ensureActivated(extId: string, reason: ActivationReason): Promise<HostedActivationOutcome>
}

/** 消费者的观察面 */
export interface ExtensionHostConsumer extends HostedActivationPort {
  /** 开关是否打开（关 ⇒ 下面所有方法都是空操作） */
  readonly enabled: boolean
  /** 退订一切（幂等） */
  stop(): void
  /** 立刻推一次快照（幂等；端口未到会失败并等 `onPort` 重试） */
  pushSnapshot(): void
  /** 处理一条原始信封（入口也走它；测试直接调） */
  handleEnvelope(raw: unknown): void
  /**
   * 取消当前（或指定）进度任务（EH-B3b-2）：拆掉进度条并告诉宿主"这个 `ui.withProgress` 被放弃"，
   * 宿主侧对应的 Promise 会以 `EH_CANCELLED` 失败。
   *
   * 谁会调它：进度 UI 的取消按钮（本卡不动 Vue 组件，先把它作为消费者 API 暴露）、窗口即将销毁、
   * 以及"新的进度任务顶掉旧的"（`uiStore.progress` 在 v1 里就是单槽）。返回是否真的取消了一个。
   */
  cancelProgress(progressId?: string): boolean
  /** 诊断/测试：当前已落地的条目数 */
  stats(): {
    runtimeStatusBarItems: number
    commands: number
    treeProviders: number
    appMessageHandlers: number
  }
  /**
   * 诊断/测试：EH-B3b-2 的运行期计数（`stats()` 保持 B3b-1 的四个键不变——既有用例对它有
   * `deepEqual`，不为新能力去改旧断言）。
   */
  uiRuntime(): {
    outputChannels: number
    progressActive: number
  }
  /** 诊断/测试：渲染侧 `RpcServer` 已注册的 method（排序） */
  rendererRpcMethods(): string[]
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

/** `output` 通道的统一信封体（EH-B3b-2；与宿主侧 `OutputPayload` 结构一致） */
type OutputPayload =
  | { v: 1; op: 'create'; extId: string; id: string; name: string }
  | { v: 1; op: 'append'; extId: string; id: string; text: string }
  | { v: 1; op: 'appendLine'; extId: string; id: string; text: string }
  | { v: 1; op: 'show'; extId: string; id: string }
  | { v: 1; op: 'clear'; extId: string; id: string }
  | { v: 1; op: 'dispose'; extId: string; id: string }
  | { v: 1; op: 'disposeExtension'; extId: string }

/**
 * `overlay-owner` 通道的统一信封体（EH-D8b；与宿主侧 `OverlayOwnerPayload` 结构一致）。
 *
 * `op` 只有 `bind` / `unbind` 两种：前者登记 `overlayId → extId`，后者注销。
 * `extId` **来自宿主注入**，渲染侧只登记、不做信任判断（扩展无法指定别人的 id）。
 */
interface OverlayOwnerPayload {
  v: 1
  op: 'bind' | 'unbind'
  extId: string
  overlayId: string
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
    request: <T = unknown>(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number }
    ): Promise<T> => getExtensionHostBridge().request<T>(method, params, options),
    onPort: (listener: () => void): (() => void) => surface()?.onPort(() => listener()) ?? noop,
    // 宿主发起的 `req` 默认会被 A4 的桥回 EH_INTERNAL（它没有这个方向）：把它接到桥的接管口上。
    // 端口不在时桥同样不碰它（消费者根本没起来），不会留半条链路。
    onHostRequest: (handler: (envelope: RequestEnvelope) => boolean): (() => void) =>
      getExtensionHostBridge().setHostRequestHandler(handler)
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
  /**
   * 宿主创建的 overlay 归属注销函数（overlayId → off；EH-D8b）。
   * 扩展停用（`disposeExtension`）时逐个调用，避免 `core/host.ts` 的 `overlayOwners` 里留下脏 id。
   */
  readonly overlayOwners: Map<string, () => void>
}

/** 空消费者（开关关闭时返回；所有方法都是空操作） */
function disabledConsumer(): ExtensionHostConsumer {
  return {
    enabled: false,
    stop: (): void => undefined,
    pushSnapshot: (): void => undefined,
    handleEnvelope: (): void => undefined,
    cancelProgress: (): boolean => false,
    // EH-C2：开关关闭 ⇒ 一个请求都不发（"默认行为零变化"）。回 `skipped` 而不是抛错：
    // 调用方（`core/host.ts`）根本不该在关闭态走到这里（它先看 `enabled`），万一走到了，
    // "没有宿主这回事"也比"虚拟的激活失败"更接近事实。
    ensureActivated: async (
      extId: string,
      reason: ActivationReason
    ): Promise<HostedActivationOutcome> => ({ extId, reason, state: 'skipped' }),
    stats: () => ({
      runtimeStatusBarItems: 0,
      commands: 0,
      treeProviders: 0,
      appMessageHandlers: 0
    }),
    uiRuntime: () => ({ outputChannels: 0, progressActive: 0 }),
    rendererRpcMethods: (): string[] => []
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
  const hasWindow =
    options.hasWindow ??
    ((): boolean => typeof window !== 'undefined' && typeof document !== 'undefined')

  /** 宿主侧运行时状态栏项 id → 渲染侧注册表里的那条项 */
  const runtimeStatusBarItems = new Map<string, RegisteredStatusBarItem>()
  /** 宿主侧输出通道 id → 渲染侧 `outputStore` 的句柄（EH-B3b-2） */
  const outputChannels = new Map<string, { extId: string; handle: OutputChannelHandle }>()
  /** 当前在显示的进度任务（`uiStore.progress` 是单槽，所以这里也只有一个） */
  let activeProgress: { progressId: string; title: string } | null = null
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
      appMessageHandler: null,
      overlayOwners: new Map()
    }
    traces.set(extId, created)
    return created
  }

  /**
   * **渲染侧 RPC 服务端**（EH-B3b-2）：收宿主发来的 `req`/`cancel`，回 `res`/`err`。
   *
   * 与宿主侧 `ui-plane.ts` 的 `RpcServer` 是同一份实现（`src/extension-host/rpc.ts` 纯模块，
   * main 早已复用）；`send` 走同一条 `host-renderer` 端口（`transport.post`）。
   */
  const uiServer = new RpcServer({
    send: (envelope): void => {
      // 端口没到时 `post` 返回 false：这是一条回包，丢了就丢了（宿主侧会有自己的超时），不能抛
      const delivered = transport.post(envelope)
      if (!delivered) logger.debug(`渲染侧回包 ${envelope.t} 没有发出去（端口未到）`)
    },
    log: (level, message, detail): void => {
      logger[level](detail === undefined ? message : `${message}（${detail}）`)
    }
  })

  /**
   * 宿主发起的 `req` 是否由**桥的接管口**送进来（生产）还是由 `onEnvelope` 送来（单测假通道）。
   *
   * 两条路径都通向同一个 `uiServer`，但必须**只挂一条**：真机上 `window.eh.onMessage` 的每个
   * 订阅者都会收到同一条 `req`，桥与消费者同时处理会造成"同一 id 两次回包"（宿主侧表现为
   * `EH_INTERNAL` 与正确结果随机其一，比彻底不支持更难查）。
   */
  const usesHostRequestHook = typeof transport.onHostRequest === 'function'

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

  /* -------------------------- 激活触发（EH-C2，渲染侧 → 宿主） -------------------------- */

  /** 已确认激活过的扩展（执行命令是高频动作，不能每次都问宿主一遍） */
  const activatedExtensions = new Set<string>()
  /**
   * 在途的激活请求（extId → 同一个 Promise）。
   *
   * 合并的理由：同一扩展可能被**几乎同时**从多条路径触发（命令面板连点、快捷键 + 状态栏点击、
   * 切到视图的同时执行它的命令）。宿主侧 `Activator` 已经有并发去重（`activating` 表），但渲染侧
   * 不去重的话会白白多打几条 `host.activate`、多占几条超时预算，日志也会看起来像"激活了三次"。
   * 这里按 extId 合并，保证一次激活只有**一条**在途请求。
   */
  const activatingRequests = new Map<string, Promise<HostedActivationOutcome>>()

  /** 真正发一次激活请求并按回包给出结论（失败抛中文错误） */
  const performActivation = async (
    extId: string,
    reason: ActivationReason
  ): Promise<HostedActivationOutcome> => {
    const reasonText = formatActivationReason(reason)
    logger.info(`请求宿主激活扩展 ${extId}（${reasonText}）`)

    let result: HostedActivationResult
    try {
      result = await transport.request<HostedActivationResult>(
        HOSTED_UI_RPC.activate,
        { extId, reason },
        { timeoutMs: ACTIVATION_TIMEOUT_MS }
      )
    } catch (error) {
      // 传输层/超时的错误码保留（EH_TIMEOUT / EH_NOT_READY 各有可执行文案），但必须补上
      // "是哪个扩展、因为什么触发"——否则用户只看到"请求超时"，不知道该找哪个扩展。
      throw new EhProtocolError(
        error instanceof EhProtocolError ? error.code : 'EH_ACTIVATION_FAILED',
        `宿主扩展 ${extId} 的激活请求没有成功（触发：${reasonText}）：${describeError(error)}`
      )
    }

    if (result?.state === 'activated' || result?.state === 'skipped') {
      activatedExtensions.add(extId)
      logger.debug(
        result.state === 'activated'
          ? `宿主扩展 ${extId} 已激活（${reasonText}）`
          : `宿主扩展 ${extId} 之前已激活过（宿主回 skipped，${reasonText}）`
      )
      return { extId, reason, state: result.state }
    }

    if (result?.state === 'failed') {
      const kind = typeof result.failure?.kind === 'string' ? result.failure.kind : 'unknown'
      const message =
        typeof result.failure?.message === 'string' && result.failure.message !== ''
          ? result.failure.message
          : '宿主没有给出失败原因'
      logger.error(`宿主扩展 ${extId} 激活失败（${kind}）：${message}`)
      throw new EhProtocolError(
        'EH_ACTIVATION_FAILED',
        `宿主扩展 ${extId} 激活失败（触发：${reasonText}）：${message}（归类：${kind}）。` +
          '这个扩展还没有注册任何实现，动作已中止；请修好扩展入口的 activate() 后在扩展管理器里重启扩展宿主。'
      )
    }

    throw new EhProtocolError(
      'EH_INTERNAL',
      `宿主对扩展 ${extId} 的激活回包形状不对（${JSON.stringify(result)}）：既不是 activated/skipped，也不是 failed。`,
      '这属于协议不匹配（宿主版本与渲染侧不一致？）'
    )
  }

  /**
   * **确保某个宿主扩展已激活**（EH-C2 的核心）。
   *
   * 语义（三条，缺一不可）：
   * 1. **幂等 + 合并**：已确认激活过 ⇒ 立刻回 `skipped`（零请求）；在途 ⇒ 复用同一个 Promise；
   * 2. **失败必须响亮**：`EH_ACTIVATION_FAILED` + 中文（含 extId、触发原因、宿主给的失败归类），
   *    调用方据此中止动作（绝不能拿着一个没有实现的命令往下跑）；
   * 3. **超时**：走 {@link ACTIVATION_TIMEOUT_MS}（10 秒），超时抛 `EH_TIMEOUT` + 扩展 id。
   *
   * 开关关闭时消费者本身是空壳（`enabled: false`），`ensureActivated` 一个请求都不发。
   */
  const ensureActivated = async (
    extId: string,
    reason: ActivationReason
  ): Promise<HostedActivationOutcome> => {
    if (stopped) {
      throw new EhProtocolError(
        'EH_CANCELLED',
        '渲染侧的扩展宿主消费者已停止，这次激活请求没有发出。请重新加载页面后再试。'
      )
    }
    const id = typeof extId === 'string' ? extId.trim() : ''
    if (id === '') {
      throw new EhProtocolError(
        'EH_INTERNAL',
        '激活请求需要非空的扩展 id（要激活哪个扩展）。',
        `收到的 extId=${JSON.stringify(extId)}`
      )
    }
    // 已经激活过：零请求（这是"不要请求风暴"的第一道闸）
    if (activatedExtensions.has(id)) return { extId: id, reason, state: 'skipped' }

    const inflight = activatingRequests.get(id)
    if (inflight) return await inflight

    const task = performActivation(id, reason)
    activatingRequests.set(id, task)
    try {
      return await task
    } finally {
      // 只清自己那条（并发再次进入时可能有新的一条）
      if (activatingRequests.get(id) === task) activatingRequests.delete(id)
    }
  }

  /* ------------------------ 宿主 → 渲染侧请求（EH-B3b-2） ------------------------ */

  /**
   * UI 请求先过窗口判定：没有窗口 ⇒ `EH_NOT_READY` + 中文错误。
   *
   * 为什么必须在这里判（而不是让宿主的请求超时）：宿主侧没有 v1 的 `localFn` 本地兜底，
   * 静默等待只会让扩展的 Promise 永远挂着（`EH_TIMEOUT` 要等 60 秒才到），排查成本极高。
   */
  const assertUiWindow = (): void => {
    if (hasWindow()) return
    throw new EhProtocolError(
      'EH_NOT_READY',
      HOSTED_UI_WINDOW_MISSING,
      '渲染侧没有可用的 window/document：ui 请求无处渲染'
    )
  }

  /** 进度任务取消：拆掉进度条 + 告诉宿主那条 `ui.withProgress` 已被放弃（宿主结算成 EH_CANCELLED） */
  const cancelProgressNow = (reason: string): boolean => {
    const progress = activeProgress
    if (!progress) return false
    activeProgress = null
    uiStore.hideProgress()
    logger.info(`进度任务被取消（${progress.progressId}）：${reason}`)
    void transport
      .request(HOSTED_UI_RPC.progressCancel, { progressId: progress.progressId })
      .catch((error: unknown): void => {
        logger.debug(
          `取消进度没有送到宿主（${progress.progressId}）：${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
    return true
  }

  uiServer.register(HOSTED_RENDERER_RPC.showMessage, (params) => {
    assertUiWindow()
    const record = asRecord(params)
    const message = typeof record.message === 'string' ? record.message : ''
    const type =
      record.type === 'warning' || record.type === 'error' || record.type === 'success'
        ? record.type
        : 'info'
    // v1：`showMessage: (message, type = 'info') => uiStore.showToast(message, type)`（逐字同一调用）
    uiStore.showToast(message, type)
    return { ok: true }
  })

  uiServer.register(HOSTED_RENDERER_RPC.showQuickPick, async (params) => {
    assertUiWindow()
    const record = asRecord(params)
    const items = Array.isArray(record.items) ? (record.items as QuickPickItem[]) : []
    const opts = record.opts
    const value = await uiStore.showQuickPick(
      items,
      typeof opts === 'object' && opts !== null
        ? (opts as { title?: string; placeHolder?: string; closeOnClickOutside?: boolean })
        : undefined
    )
    // `null` 而不是 `undefined`：回包要能过帧与 JSON（取消就是 `null`）
    return { value: value ?? null }
  })

  uiServer.register(HOSTED_RENDERER_RPC.showInputBox, async (params) => {
    assertUiWindow()
    const record = asRecord(params)
    const value = await uiStore.showInputBox({
      title: typeof record.title === 'string' ? record.title : undefined,
      value: typeof record.value === 'string' ? record.value : undefined,
      placeHolder: typeof record.placeHolder === 'string' ? record.placeHolder : undefined,
      password: record.password === true,
      closeOnClickOutside:
        typeof record.closeOnClickOutside === 'boolean' ? record.closeOnClickOutside : undefined
    })
    return { value: value ?? null }
  })

  uiServer.register(HOSTED_RENDERER_RPC.showForm, async (params) => {
    assertUiWindow()
    const record = asRecord(params)
    const fields = Array.isArray(record.fields) ? (record.fields as FormField[]) : []
    const value = await uiStore.showForm({
      title: typeof record.title === 'string' ? record.title : undefined,
      fields,
      closeOnClickOutside:
        typeof record.closeOnClickOutside === 'boolean' ? record.closeOnClickOutside : undefined
    })
    return { value: value ?? null }
  })

  uiServer.register(HOSTED_RENDERER_RPC.withProgress, (params) => {
    assertUiWindow()
    const record = asRecord(params)
    const progressId = typeof record.progressId === 'string' ? record.progressId : ''
    if (progressId === '') {
      throw new EhProtocolError('EH_INTERNAL', 'ui.withProgress 需要字符串 progressId')
    }
    const title = typeof record.title === 'string' ? record.title : ''
    // 单槽语义（v1 的 `uiState.progress` 就是一个槽）：新的进度顶掉旧的，旧的按取消结算
    cancelProgressNow('被新的进度任务顶替')
    activeProgress = { progressId, title }
    uiStore.showProgress(title, null)
    return { ok: true }
  })

  uiServer.register(HOSTED_RENDERER_RPC.progressUpdate, (params) => {
    const record = asRecord(params)
    const progressId = typeof record.progressId === 'string' ? record.progressId : ''
    if (!activeProgress || activeProgress.progressId !== progressId) return { ok: false }
    const percent =
      typeof record.percent === 'number' && Number.isFinite(record.percent) ? record.percent : null
    uiStore.showProgress(activeProgress.title, percent)
    return { ok: true }
  })

  uiServer.register(HOSTED_RENDERER_RPC.progressEnd, (params) => {
    const record = asRecord(params)
    const progressId = typeof record.progressId === 'string' ? record.progressId : ''
    if (!activeProgress || activeProgress.progressId !== progressId) return { ok: false }
    activeProgress = null
    uiStore.hideProgress()
    return { ok: true }
  })

  uiServer.register(HOSTED_RENDERER_RPC.updateGate, (params) => {
    const record = asRecord(params)
    const extId = typeof record.extId === 'string' ? record.extId : ''
    // **门控权威在这里**（技术债 #2）：`update.provider` 的选择只存在于渲染侧设置，
    // 宿主与 main 都读不到；`updaterStore.isActive` 是 v1 的同一个判定函数。
    if (extId === '' || !updaterStore.isActive(extId)) {
      return { ok: false, code: 'not-provider', error: HOSTED_UPDATE_NOT_PROVIDER }
    }
    const feedUrl = updaterStore.active?.feedUrl
    return typeof feedUrl === 'string' && feedUrl !== '' ? { ok: true, feedUrl } : { ok: true }
  })

  /* --------------------------------- 输出通道 --------------------------------- */

  /**
   * `output` 通道（宿主 → 渲染侧）：落到 `outputStore`。
   *
   * 宿主侧的 `createChannel` 是同步返回句柄的，所以通道 id 由宿主生成、这里只维护映射；
   * 与 v1 的区别仅在"谁生成 id"（v1 是渲染进程内的 `out-N`），**落点仍是同一个 store**。
   */
  const applyOutput = (payload: OutputPayload): void => {
    if (payload.op === 'create') {
      const existing = outputChannels.get(payload.id)
      if (existing) {
        logger.warn(`输出通道 ${payload.id} 重复创建，已先拆掉旧的那个`)
        existing.handle.dispose()
        outputChannels.delete(payload.id)
      }
      outputChannels.set(payload.id, {
        extId: payload.extId,
        handle: outputStore.createChannel(payload.name)
      })
      return
    }
    if (payload.op === 'disposeExtension') {
      for (const [id, entry] of [...outputChannels]) {
        if (entry.extId !== payload.extId) continue
        outputChannels.delete(id)
        entry.handle.dispose()
      }
      return
    }
    const entry = outputChannels.get(payload.id)
    if (!entry) {
      logger.debug(`输出通道 ${payload.id} 不在本地映射里（${payload.op} 被忽略）`)
      return
    }
    switch (payload.op) {
      case 'append':
        entry.handle.append(payload.text)
        return
      case 'appendLine':
        entry.handle.appendLine(payload.text)
        return
      case 'show':
        entry.handle.show()
        return
      case 'clear':
        entry.handle.clear()
        return
      case 'dispose':
        outputChannels.delete(payload.id)
        entry.handle.dispose()
        return
      default:
        logger.warn(`未知的 output 子操作 ${String((payload as { op?: unknown }).op)}`)
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

  /* --------------------------------- overlay 归属（EH-D8b） --------------------------------- */

  /**
   * 宿主说"这个 overlay 属于这个扩展"（`bind`）/ "这个归属作废"（`unbind`）：登记/注销到
   * `core/host.ts` 的 `overlayOwners`（页面消息按 `overlayId` 寻址 `app.onMessage` 的那张表）。
   *
   * 三条语义：
   * 1. **只登记、不做信任判断**：`extId` 由宿主注入（扩展 API 里没有这个参数），页面与扩展都
   *    无法伪造归属；渲染侧没有任何"再校验一次"的余地，也不需要；
   * 2. **幂等**：`unbind` 只处理自己那条（没有登记就 no-op）；重复的 `bind` 先撤旧再登记，
   *    保证表里同一个 overlayId 永远只有一条注销函数；
   * 3. **响亮**：载荷不合法 / 适配器没有 `registerHostedOverlayOwner` ⇒ warn + 丢弃。绝不静默——
   *    静默的表现正是技术债 #13 那个"看起来什么都没配、实际消息全丢"。
   */
  const applyOverlayOwner = (payload: OverlayOwnerPayload): void => {
    const extId = typeof payload.extId === 'string' ? payload.extId.trim() : ''
    const overlayId = typeof payload.overlayId === 'string' ? payload.overlayId.trim() : ''
    const op = payload.op
    if (extId === '' || overlayId === '' || (op !== 'bind' && op !== 'unbind')) {
      logger.warn(
        `overlay-owner 载荷不合法（op=${String(op)} extId=${String(payload.extId)} ` +
          `overlayId=${String(payload.overlayId)}），已丢弃`
      )
      return
    }
    const hostAdapter = options.host
    const register = hostAdapter?.registerHostedOverlayOwner
    if (!hostAdapter || register === undefined) {
      logger.warn(
        `宿主报告了 overlay ${overlayId} 属于扩展 ${extId}，但渲染侧的 host 适配器没有 ` +
          'registerHostedOverlayOwner：该窗口的页面消息会被回「扩展未注册消息处理器」'
      )
      return
    }
    if (op === 'unbind') {
      // 没登记过就什么都不做（重复/迟到的 unbind 不是错误）。这里用 `traces.get` 而不是
      // `traceOf`：这个扩展可能刚被 `cleanupExtension` 整体清理过，不能为了注销一条归属又
      // 凭空造出一个空痕迹（那会让 `stats()` 与后续清理多出一条无主记录）。
      const owner = traces.get(extId)?.overlayOwners.get(overlayId)
      if (owner === undefined) return
      traces.get(extId)?.overlayOwners.delete(overlayId)
      try {
        owner()
      } catch (error) {
        logger.warn(`注销 overlay 归属失败（${extId}/${overlayId}）：${describeError(error)}`)
      }
      return
    }
    const trace = traceOf(extId)
    // `bind` 可重复（宿主重建窗口）：先撤旧再登记，避免旧注销函数把新归属删掉
    const existing = trace.overlayOwners.get(overlayId)
    if (existing !== undefined) {
      trace.overlayOwners.delete(overlayId)
      try {
        existing()
      } catch (error) {
        logger.warn(
          `重建 overlay 归属前撤销旧登记失败（${extId}/${overlayId}）：${describeError(error)}`
        )
      }
    }
    try {
      // 用 `call` 绑回适配器：`core/host.ts` 的方法是实例方法（`this.overlayOwners`）
      trace.overlayOwners.set(overlayId, register.call(hostAdapter, extId, overlayId))
    } catch (error) {
      logger.warn(`登记 overlay 归属失败（${extId}/${overlayId}）：${describeError(error)}`)
    }
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
    // EH-B3b-2：输出通道也归本扩展（停用即整批拆掉）
    for (const [channelId, entry] of [...outputChannels]) {
      if (entry.extId !== extId) continue
      outputChannels.delete(channelId)
      entry.handle.dispose()
    }
    if (trace) {
      for (const dispose of trace.commands.values()) dispose()
      for (const dispose of trace.treeProviders.values()) dispose()
      for (const dispose of trace.appCards.values()) dispose()
      trace.appMessageHandler?.()
      // EH-D8b：overlay 归属也撤（window 由宿主回收；渲染侧路由表不该留下指向死窗口的 id）
      for (const off of trace.overlayOwners.values()) {
        try {
          off()
        } catch (error) {
          logger.warn(`停用 ${extId} 时注销 overlay 归属失败：${describeError(error)}`)
        }
      }
      trace.overlayOwners.clear()
      traces.delete(extId)
    }
    appStore.deactivateExtension(extId)
    extensionSettingsStore.deactivateExtension(extId)
    // EH-C2：停用即"没激活过"（否则停用后再次触发会命中本地缓存、永远不发激活请求）
    activatedExtensions.delete(extId)
    activatingRequests.delete(extId)
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
      case HOSTED_UI_EVENT_CHANNELS.output:
        // EH-B3b-2：输出通道（协议常量里没有 output 语义的通道，本卡用局部常量声明，见文件头）
        applyOutput(payload as OutputPayload)
        return
      case HOSTED_UI_EVENT_CHANNELS.overlayOwner:
        // EH-D8b：宿主创建的 overlay 的归属（页面消息按 overlayId 寻址 app.onMessage）
        applyOverlayOwner(payload as OverlayOwnerPayload)
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
    if (envelope.t === 'req') {
      // EH-B3b-2：宿主 → 渲染侧的请求（ui.* / update 门控）由渲染侧 RpcServer 应答。
      //
      // 两条路径只会走一条：装了桥的接管口（生产）时 `req` 由桥交给 `uiServer`，消费者**不再**
      // 处理（否则同一个 id 会被处理两次 → 宿主收到重复回包）；没有接管口（单测假通道）时走这里。
      if (usesHostRequestHook) return
      uiServer.handleRequest(envelope)
      return
    }
    if (envelope.t === 'cancel') {
      // 宿主放弃了它自己发出的请求（RpcClient 超时）：按协议语义标记为取消
      uiServer.handleCancel(envelope)
      return
    }
    if (envelope.t === 'log') {
      // 宿主日志已由桥转发到 console；这里不重复打印（桥的 `onLog` 是另一条订阅）
      return
    }
    // res / err 由桥自己配对处理（那是渲染侧 → 宿主的请求的回包）；握手类信封与本消费者无关
    logger.debug(`消费者忽略信封 t=${envelope.t}`)
  }

  /* --------------------------------- 启动 --------------------------------- */

  // 生产路径：桥把宿主发起的 `req` 交到这里（A4 的桥原本只会回 EH_INTERNAL）
  if (transport.onHostRequest) {
    offs.push(
      transport.onHostRequest((envelope) => {
        if (stopped) return false
        uiServer.handleRequest(envelope)
        return true
      })
    )
  }
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
      // EH-B3b-2：先拆进度（端口此刻可能还在，宿主借此知道任务被放弃），再退订
      cancelProgressNow('渲染侧消费者已停止')
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch {
          // 退订失败不该影响其余退订
        }
      }
      for (const extId of [...traces.keys()]) cleanupExtension(extId)
      runtimeStatusBarItems.clear()
      // EH-C2：激活缓存/在途请求都清掉（消费者停了就不该再认为任何扩展"已激活"）
      activatedExtensions.clear()
      activatingRequests.clear()
      for (const entry of outputChannels.values()) entry.handle.dispose()
      outputChannels.clear()
      uiServer.dispose('渲染侧消费者已停止')
    },
    pushSnapshot,
    handleEnvelope,
    ensureActivated,
    cancelProgress: (progressId?: string): boolean => {
      if (progressId !== undefined && activeProgress?.progressId !== progressId) return false
      return cancelProgressNow(progressId === undefined ? '界面取消' : `界面取消（${progressId}）`)
    },
    stats: () => ({
      runtimeStatusBarItems: runtimeStatusBarItems.size,
      commands: [...traces.values()].reduce((sum, trace) => sum + trace.commands.size, 0),
      treeProviders: [...traces.values()].reduce((sum, trace) => sum + trace.treeProviders.size, 0),
      appMessageHandlers: [...traces.values()].filter((trace) => trace.appMessageHandler !== null)
        .length
    }),
    uiRuntime: () => ({
      outputChannels: outputChannels.size,
      progressActive: activeProgress === null ? 0 : 1
    }),
    rendererRpcMethods: (): string[] => uiServer.registeredMethods()
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
