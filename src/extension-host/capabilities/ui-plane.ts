/**
 * **宿主 → 渲染侧的数据面**（EH-B3b-1）：扩展宿主进程把"注册面"的数据经 `host-renderer` 通道
 * 送给渲染进程，渲染侧落到既有 registry / stores（消费方见
 * `src/renderer/src/core/extensionHostConsumer.ts`）。
 *
 * 决策见 `docs/adr/0026-extension-host-process.md`，任务卡见 `docs/extension-host-migration.md`
 * 的 EH-B3b-1。本卡接手的能力（**28 项**，全从桩变实现）：
 *
 * | 命名空间 | 项 | 方向 |
 * | --- | --- | --- |
 * | `statusBar` | setText / setTooltip / show / hide / createItem | 宿主 → 渲染侧 |
 * | `navbar.setBadge` | 1 | 宿主 → 渲染侧 |
 * | `registerCommand` / `executeCommand` | 2 | 注册表在宿主（执行也发生在宿主） |
 * | `views.registerTreeProvider` | 1 | 注册宿主 → 渲染侧；取子节点 **渲染侧 → 宿主** |
 * | `settings` | register / get / set / onChanged | 注册与写入是两个方向 |
 * | `theme` | getCurrent / onChanged | 渲染侧 → 宿主（推送快照） |
 * | `i18n` | t / onLocaleChanged / registerMessages | 文案在宿主解析；语言由渲染侧推 |
 * | `app` | register / onMessage | 卡片宿主 → 渲染侧；消息 **渲染侧 → 宿主** |
 * | `on` / `emit` | 2 | 宿主内事件总线（不走桥） |
 * | `workspaceState` / `globalState` | 各 3 | 宿主本地文件（不走桥） |
 *
 * ## 为什么是"数据面"而不是"能力代理"
 *
 * 渲染侧的注册表是**唯一真相**：状态栏/导航/命令面板/设置页/App 卡片都由 Vue 组件消费
 * `registry` / `appStore` / `extensionSettingsStore` / `treeStore`。宿主进程没有 DOM、也不该有
 * 一套平行的 UI 状态。所以这里只做两件事：
 * 1. **把事实送过去**（"我把 `id` 的文本设成 X 了"、"我注册了一张卡片"），由渲染侧落到它自己的
 *    store —— 与 v1（扩展在渲染进程执行）的落点**逐字同一个 store**；
 * 2. **把查询接回来**（"这个节点的子节点是什么"、"执行这个命令"、"这条 app 消息给谁"）——
 *    这些是宿主里才有的回调/实现，渲染侧必须问回来。
 *
 * ## 通道复用（`EH_EVENT_CHANNELS` 已定义的那 8 个）
 *
 * | channel | 谁发 | payload 子类型 | 为什么用它 |
 * | --- | --- | --- | --- |
 * | `statusBar` | 宿主 | `setText` / `setTooltip` / `setVisible` / `create` / `dispose` / `disposeExtension` | 状态栏项的原生归属通道 |
 * | `views` | 宿主 | `treeProvider`（register/dispose）+ **`navBadge`** | 树视图注册本就属于它；**导航项也由 `contributes.views` 注册成 nav item**，故 `navbar.setBadge` 复用这里（`EH_EVENT_CHANNELS` 没有 navbar 通道，`bubble`/`cardIcon` 语义不沾边，而改协议常量要动 `src/shared/**`） |
 * | `commands` | 宿主 | `register` / `dispose` | 命令注册 |
 * | `app.register` | 宿主 | `register` / `dispose` / **`messageHandler`** | App 卡片；`messageHandler` 是"我的 `app.onMessage` 可以寻址了"的公告——没有它，渲染侧消息桥只会回「扩展未注册消息处理器」 |
 * | `settings` | **双向** | 宿主发 `registerPage` / `disposePage` / `set` / `unset`；渲染侧发 `snapshot`（settings + locale + themeId） | 设置页与设置值；语言/主题的当前值也随 `snapshot` 一起过来（v1 的 `i18n.onLocaleChanged` 本就建在"设置变更"上） |
 * | `theme` | —— | **本卡未使用**（不留空转通道） | 宿主只需要"当前主题 id"，它随 `settings` 的 `snapshot` 一起过来（少一条通道、少一处同步）；真正应用 token 的仍是渲染侧 `themeStore` |
 *
 * `bubble` / `cardIcon` **本卡不用**（属宠物气泡与 App 卡片图标字符串的运行期更新，归后续卡）。
 *
 * ## 渲染侧 → 宿主：`req` 信封（**不是协议扩展**）
 *
 * 三条反向调用走同一端口的 `req`/`res`/`err` 信封（`PROTOCOL_VERSION` 保持 1，不加信封字段）：
 * `ui.executeCommand` / `ui.treeChildren` / `ui.appMessage`。宿主侧用既有 `../rpc.ts` 的
 * `RpcServer`，渲染侧用既有 `ExtensionHostBridge.request()`——两边都不需要新形状。
 *
 * ## 失败姿态：**响亮**
 *
 * 端口没到（`runtime.ts` 没把 `host-renderer` 端口透传进来）时，一切"要送到渲染侧"的调用抛
 * `EH_NOT_READY` + 「host-renderer 端口未到」，**绝不静默 no-op**（ADR-0026 明确要避免的降级风格）。
 * 为什么这条很重要：这条缝曾经断过（`port.ts` 只取 `event.data`、把 `ports` 丢了），而没人发现，
 * 正是因为"什么都没发生"看起来像"什么都没配"。`test/extension-host-ui-plane.test.ts` 有一组
 * 接缝测试专门盯它。
 *
 * ---
 *
 * # EH-B3b-2 · 状态与 UI 面（本卡追加）
 *
 * 本卡接手最后 **10 项**桩，把对照表推到 **99 实现 + 0 桩**：`ui`(5) / `output.createChannel`(1) /
 * `update` 的 4 条门控方法。它们与 B3b-1 的"注册面"不同：**渲染与判定都在渲染侧**，宿主只是发起方。
 *
 * ## 方向：宿主 → 渲染侧的 `req`（`RpcClient`）
 *
 * 同一个 `host-renderer` 端口上现在有**两条 RPC 方向**，各自一对 `RpcServer`/`RpcClient`（协议零扩展）：
 *
 * | 方向 | 宿主侧 | 渲染侧 | method |
 * | --- | --- | --- | --- |
 * | 渲染侧 → 宿主 | `RpcServer`（B3b-1） | `ExtensionHostBridge.request()` | `UI_PLANE_RPC` |
 * | **宿主 → 渲染侧** | **`RpcClient`** | **`RpcServer`**（本卡） | **`UI_RENDERER_RPC`** |
 *
 * 为什么必须反过来起一个渲染侧 `RpcServer`：`ui.*` 的模态框/toast 由渲染进程的 `uiStore` 渲染、
 * `output` 的通道由 `outputStore` 持有、`update` 的门控真相是渲染侧的 `updaterStore`。宿主进程
 * 没有 DOM，也没有那三份状态——**谁能渲染/谁能判定，请求就发给谁**。复用 `../rpc.ts`（纯模块、
 * 无 Node 依赖，main 早已复用同一份，见 `extensionHostStarter.ts` 的 `registerMethod`），语义
 * （未知 method 列表、取消、超时、错误码）天然一致，不需要第二套。
 *
 * ## 语义**照抄 v1**（`core/host.ts` 的 `showUiModal` / `buildUpdateApi` / `output.createChannel`）
 *
 * - 模态框（quickPick / inputBox / form）：取消 ⇒ `undefined`；**60 秒无结果 ⇒ 取消**——v1 的
 *   `src/main/ui.ts` 用的是 60s 定时器 + `canceled:true`，这里给 `RpcClient` 传
 *   `timeoutMs: UI_MODAL_TIMEOUT_MS`，并把 `EH_TIMEOUT` **翻译成 `undefined`**（不是抛错）；
 * - `ui.showMessage` 保持**同步 void**（v1 是 `uiStore.showToast`）：内部发一条 `ui.showMessage`
 *   请求但不等待结果，失败只落宿主日志（toast 永远不该让扩展的调用点抛错）；
 * - `output.createChannel` 保持**同步**并当场返回句柄：通道 id 由宿主生成（`host-output:<ext>:<n>`），
 *   渲染侧用它当映射键（与 B3b-1 的 `statusBar.createItem` 同一手法），后续
 *   `append`/`appendLine`/`show`/`clear`/`dispose` 全部走 `output` 通道的 `event`；
 * - `update` 的 4 条：**渲染侧权威判定**（技术债 #2 的退场条件）——先问 `ui.updateGate`，只有
 *   `{ok:true}` 才继续。非提供者抛 v1 那句「当前扩展不是生效的更新提供者（需在设置-更新中选择）」；
 *   放行后经既有 `HostMainBridge` 发 `HOST_MAIN_METHODS.update*`（R70：main 侧已注册这 4 条，
 *   实现复用 `src/main/updater.ts` 的同一份逻辑）。
 *
 * ## 窗口不在时**响亮**
 *
 * v1 的 `showUiModal` 在焦点不在 App 子窗口时走 `localFn`（主窗口本地渲染）。宿主模式下**没有
 * 「本地」可退**：端口没到 ⇒ `EH_NOT_READY` + {@link HOST_RENDERER_PORT_MISSING}；端口到了但渲染
 * 侧没有窗口（页面正在销毁/回退期）⇒ 渲染侧回 `EH_NOT_READY` + {@link UI_WINDOW_MISSING}。
 * 两种情况都是**当场抛中文错误**，绝不静默地让扩展的 Promise 永远挂着。
 *
 * ## 新增的 `output` 事件 channel（为什么不复用既有 5 个）
 *
 * `EH_EVENT_CHANNELS` 里没有 output 语义的通道（statusBar/commands/views/app.register/settings/
 * theme/bubble/cardIcon 都不沾边）。协议对 `event.channel` **不设白名单**（`validateEnvelope` 只要求
 * 非空字符串，注释明说"新增已知 channel 时同步补到协议常量与文档"），而本卡所有权不含
 * `src/shared/extensionHostProtocol.ts`，因此这里用**局部常量** {@link UI_PLANE_EVENT_CHANNELS}
 * 声明 `output`，两侧逐字一致并由测试断言；把它并回协议常量是 D1 文档卡的一行活。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AppRegistration,
  ExtensionActivationApi,
  Memento,
  OutputChannel,
  SettingsPage,
  StatusBarItem,
  TreeItem,
  TreeViewProvider
} from '../../api'
import {
  EH_EVENT_CHANNELS,
  EhProtocolError,
  checkFrameSize,
  checkSerializable,
  createEventEnvelope,
  type CancelEnvelope,
  type Envelope,
  type ErrorEnvelope,
  type EventEnvelope,
  type LogLevel,
  type RequestEnvelope,
  type ResponseEnvelope
} from '../../shared/extensionHostProtocol'
import { toErrorMessage } from '../errors'
import type { EnvelopeSink, HostLogger } from '../log'
import { unwrapParentPortMessage, type HostRendererPortLike } from '../port'
import {
  RpcClient,
  RpcServer,
  systemRpcTimers,
  type RpcRequestOptions,
  type RpcTimers
} from '../rpc'
import { HOST_MAIN_METHODS } from './host-main'
import type { HostMainBridge } from './io'

/* -------------------------------------------------------------------------------------------- */
/* 常量                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** 数据面信封的载荷版本（**与 `PROTOCOL_VERSION` 无关**：它只描述 payload 自己的形状）。 */
export const UI_PLANE_PAYLOAD_VERSION = 1

/**
 * 渲染侧 → 宿主的 RPC method（反向调用）。**两侧各写一份字符串**（先例：`host-main.ts` 的
 * method 名在 `src/main/index.ts` 逐字重写），改名字要同时改
 * `src/renderer/src/core/extensionHostConsumer.ts` 的 `HOSTED_UI_RPC`。
 */
export const UI_PLANE_RPC = {
  /** 执行命令（渲染侧 UI 点了宿主管辖的命令） */
  executeCommand: 'ui.executeCommand',
  /** 取树视图子节点（渲染侧 `TreeView` 组件问回宿主里的 provider） */
  treeChildren: 'ui.treeChildren',
  /** 派发 App 子窗口消息（渲染侧消息桥寻址到某个宿主扩展后问回宿主） */
  appMessage: 'ui.appMessage',
  /**
   * `ui.withProgress` 的**取消**（EH-B3b-2，渲染侧 → 宿主）。
   *
   * 为什么取消要单独一条而不是复用 `cancel` 信封：`cancel` 的语义是"**发起方**放弃自己那条
   * 在途请求"，而这里发起方是宿主、放弃方是渲染侧（用户点了取消/进度被顶掉/窗口要关）。用一条
   * 普通 `req` 表达"请把那个进度任务判为已取消"，宿主侧的回处理就是把对应 Promise 以
   * `EH_CANCELLED` 结算——语义显式，且两边都不需要给协议加字段。
   */
  progressCancel: 'ui.progressCancel'
} as const

/**
 * **宿主 → 渲染侧**的 RPC method（EH-B3b-2）。与本文件顶端的 `UI_PLANE_RPC` 方向相反。
 *
 * 渲染侧各写一份同名字符串（`src/renderer/src/core/extensionHostConsumer.ts` 的
 * `HOSTED_RENDERER_RPC`）——理由与 B3b-1 相同：跨侧 import 会把宿主代码（含 `node:fs`）打进渲染包，
 * 所以两边各写一份、由 `test/extension-host-ui-plane2.test.ts` 断言逐字一致。
 */
export const UI_RENDERER_RPC = {
  /** 应用内 toast（`uiStore.showToast`；v1 的 `ui.showMessage` 是同步 void） */
  showMessage: 'ui.showMessage',
  /** 快速选择（取消 ⇒ `value:null`） */
  showQuickPick: 'ui.showQuickPick',
  /** 单行输入（取消 ⇒ `value:null`） */
  showInputBox: 'ui.showInputBox',
  /** 多字段表单（取消 ⇒ `value:null`） */
  showForm: 'ui.showForm',
  /** 进度开始（渲染侧建进度条并登记 progressId） */
  withProgress: 'ui.withProgress',
  /** 进度帧（percent） */
  progressUpdate: 'ui.progressUpdate',
  /** 进度结束（渲染侧拆除进度条） */
  progressEnd: 'ui.progressEnd',
  /** 更新门控判定（**渲染侧权威**：`updaterStore.isActive(extId)`） */
  updateGate: 'ui.updateGate'
} as const

/**
 * 本卡新增的 `event` channel（只有一条）。
 *
 * 为什么不加进 `EH_EVENT_CHANNELS`：那是 `src/shared/extensionHostProtocol.ts` 的常量表，本卡
 * 所有权不含它；而协议**不限制** `event.channel` 的取值（`validateEnvelope` 只校验非空字符串，
 * 且注释写明"新增已知 channel 时同步补到协议常量与文档"）。渲染侧同名常量见
 * `HOSTED_UI_EVENT_CHANNELS`，测试断言两侧逐字一致。
 */
export const UI_PLANE_EVENT_CHANNELS = {
  /** 输出通道：create / append / appendLine / show / clear / dispose / disposeExtension */
  output: 'output'
} as const

/**
 * 模态框的等待上限 = **60 秒**，与 v1 逐字同一个数（`src/main/ui.ts` 的 60_000 定时器 ⇒
 * `canceled:true` ⇒ `undefined`）。超过它按"用户取消"处理（不是报错）。
 */
export const UI_MODAL_TIMEOUT_MS = 60_000

/**
 * 渲染侧**没有窗口**时的中文错误（渲染侧同名常量 `HOSTED_UI_WINDOW_MISSING`）。
 *
 * v1 的 `showUiModal` 在焦点不在 App 子窗口时走 `localFn`（主窗口本地渲染）；宿主模式下没有
 * "本地"可退，因此窗口不在时**必须响亮**，绝不让扩展的 Promise 永远挂着（ADR-0026 的失败姿态）。
 */
export const UI_WINDOW_MISSING =
  '界面窗口不在：该 UI（quickPick / inputBox / form / withProgress / toast）必须由渲染进程的 ' +
  'uiStore 渲染，但当前渲染侧没有可用窗口（主窗口正在销毁或页面已卸载）。请等主窗口恢复后重试；' +
  '宿主模式下没有 v1 的"本地渲染"兜底，所以这里明确报错而不是静默等待。'

/** 更新门控拒绝时的文案（**逐字**照抄 v1 `core/host.ts` 的 `isProvider()`） */
export const UPDATE_NOT_PROVIDER = '当前扩展不是生效的更新提供者（需在设置-更新中选择）'

/** 端口没到时给的中文可执行文案（**固定句式**：接缝测试与日志都按这句话认） */
export const HOST_RENDERER_PORT_MISSING =
  'host-renderer 端口未到：宿主进程还没拿到渲染侧数据面通道（该端口随 init 信封 transfer 过来），' +
  '本次数据没有送到界面。请确认 src/extension-host/index.ts 用的是 createHostPortsFromParentPort() ' +
  '并在 runtime 里透传 rendererPort；反复出现请附宿主日志反馈。'

/* -------------------------------------------------------------------------------------------- */
/* 载荷类型（渲染侧 consumer 有一份结构相同的定义，改形状要两边一起改）                                */
/* -------------------------------------------------------------------------------------------- */

/** `statusBar` 通道的统一信封体（`kind` 区分子操作） */
export type StatusBarPayload =
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

/** `views` 通道：树视图 provider 注册 + 导航徽标 */
export type ViewsPayload =
  | { v: 1; kind: 'treeProvider'; op: 'register' | 'dispose'; extId: string; viewId: string }
  | { v: 1; kind: 'navBadge'; extId: string; id: string; count: number | null }

/** `commands` 通道 */
export type CommandsPayload =
  | { v: 1; op: 'register'; extId: string; command: string; title?: string }
  | { v: 1; op: 'dispose'; extId: string; command: string }

/** `app.register` 通道 */
export type AppRegisterPayload =
  | { v: 1; op: 'register'; extId: string; registration: AppRegistration }
  | { v: 1; op: 'dispose'; extId: string; appId: string }

/** `settings` 通道（宿主 → 渲染侧） */
export type SettingsHostPayload =
  | { v: 1; op: 'registerPage'; extId: string; page: SettingsPage }
  | { v: 1; op: 'disposePage'; extId: string; pageId: string }
  | { v: 1; op: 'set'; key: string; value: unknown }
  /** `undefined` 过不了桥 ⇒ 删除用独立子操作（对应 `stateStore.setSetting(key, undefined)`） */
  | { v: 1; op: 'unset'; key: string }

/**
 * `settings` 通道（渲染侧 → 宿主）：**当前设置/语言/主题的快照**。
 *
 * 为什么用"整份快照"而不是增量 diff：宿主的 `settings.get` / `theme.getCurrent` 是**同步**签名，
 * 只能读缓存；缓存必须能被一条消息整体校准（增量一旦漏一条就永久错），而快照只有几十字节。
 */
export interface SettingsSnapshotPayload {
  v: 1
  op: 'snapshot'
  settings: Record<string, unknown>
  locale: string
  themeId: string
}

/* -------------------------------------------------------------------------------------------- */
/* 载荷类型 · EH-B3b-2（ui / output / update；渲染侧 consumer 有结构相同的定义）                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * `output` 通道的统一信封体（`op` 区分子操作）。
 *
 * 通道 id 由**宿主**生成（`host-output:<extId>:<seq>`）：`createChannel` 在扩展 API 里是**同步**
 * 返回句柄的，宿主必须当场给出一个 id 才能让后续 `append` 有归属；渲染侧把它当映射键
 * （它自己那份 `outputStore` 里的 `out-N` 只在渲染进程内有意义）。
 */
export type OutputPayload =
  | { v: 1; op: 'create'; extId: string; id: string; name: string }
  | { v: 1; op: 'append'; extId: string; id: string; text: string }
  | { v: 1; op: 'appendLine'; extId: string; id: string; text: string }
  | { v: 1; op: 'show'; extId: string; id: string }
  | { v: 1; op: 'clear'; extId: string; id: string }
  | { v: 1; op: 'dispose'; extId: string; id: string }
  | { v: 1; op: 'disposeExtension'; extId: string }

/** 模态框的回包形状（`value:null` = 取消；渲染侧保证不写 `undefined`——它过不了 `checkSerializable` 的语义） */
export interface UiModalResult {
  value: unknown | null
}

/**
 * `ui.updateGate` 的回包。
 *
 * `ok:false` 时 `code` 固定 `not-provider`（宿主据此写日志/文案；目前只有这一种拒绝原因，
 * 但留了 `code` 让将来"提供者扩展已停用"之类的原因可以区分，不必改信封）。
 */
export type UiUpdateGateResult =
  { ok: true; feedUrl?: string } | { ok: false; code: 'not-provider'; error: string }

/* -------------------------------------------------------------------------------------------- */
/* 扩展清单（宿主自己读；与 ipc.ts 的 R61 同一先例）                                                */
/* -------------------------------------------------------------------------------------------- */

/** 数据面要用到的清单片段 */
export interface UiPlaneManifest {
  /** `contributes.i18n`（`api.i18n.t` 的初始文案） */
  messages: Record<string, Record<string, string>>
  /** `contributes.commands` 里的命令 id → 标题（`registerCommand` 的告警与渲染侧标题兜底） */
  commandTitles: Map<string, string>
}

/** 空清单（读不到/畸形时用它：数据面照常工作，只是没有初始文案与标题） */
function emptyManifest(): UiPlaneManifest {
  return { messages: {}, commandTitles: new Map() }
}

/**
 * 解析清单里与数据面有关的两块。
 *
 * 为什么宿主自己读 `<扩展目录>/manifest.json`（R61 裁定，`ipc.ts` 已开先例）：`HostedExtensionInfo`
 * 是**封闭白名单**，`contributes.*` 不会随 `init` 到宿主；而数据面又必须知道"这个扩展声明了哪些
 * 语言包与命令标题"。读一个已知文件比升协议（改 `PROTOCOL_VERSION`）便宜得多，且清单本身来自
 * 渲染侧扫描的同一份文件，不会分叉。
 */
export function parseUiPlaneManifest(text: string): UiPlaneManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyManifest()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyManifest()
  const contributes = (parsed as { contributes?: unknown }).contributes
  if (typeof contributes !== 'object' || contributes === null) return emptyManifest()
  const record = contributes as { i18n?: unknown; commands?: unknown }

  const messages: Record<string, Record<string, string>> = {}
  if (typeof record.i18n === 'object' && record.i18n !== null && !Array.isArray(record.i18n)) {
    for (const [locale, table] of Object.entries(record.i18n as Record<string, unknown>)) {
      if (typeof table !== 'object' || table === null || Array.isArray(table)) continue
      const dict: Record<string, string> = {}
      for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
        if (typeof value === 'string') dict[key] = value
      }
      messages[locale] = dict
    }
  }

  const commandTitles = new Map<string, string>()
  if (Array.isArray(record.commands)) {
    for (const entry of record.commands) {
      if (typeof entry !== 'object' || entry === null) continue
      const command = (entry as { command?: unknown }).command
      const title = (entry as { title?: unknown }).title
      if (typeof command === 'string' && typeof title === 'string') {
        commandTitles.set(command, title)
      }
    }
  }
  return { messages, commandTitles }
}

/* -------------------------------------------------------------------------------------------- */
/* Memento（workspaceState / globalState）——**不过桥**，宿主本地落地                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * 造一个落盘的 `Memento`（`workspaceState` / `globalState`，共 6 项能力）。
 *
 * ## 为什么在宿主侧实现（本卡的关键裁定）
 *
 * v1 的 memento 存在渲染进程的 `stateStore.memento(extId)`（localStorage）。宿主模式下**执行方是
 * 宿主**：数据所有权跟着执行方走，且渲染侧 localStorage 在宿主模式下**没有任何写入方**（用户扩展
 * 不在渲染进程激活了）——照旧路径写会得到一个"写进渲染侧、宿主读不到"的空壳。宿主有 `fs`，
 * 所以直接落 `<扩展 data 目录>/state/workspace.json` 与 `state/global.json`。
 *
 * ## 与 v1 的**唯一语义差异**（有意改）
 *
 * v1 的 `workspaceState` 与 `globalState` **指向同一个 store**（`stateStore.memento(ext.id)` 被调了
 * 两次），也就是 workspace/global 在 v1 里根本没有隔离。本卡按名字给出真正的隔离（两份文件、
 * 两套键空间），跨扩展仍然按 `extId` 隔离（各自 data 目录）。这是"修掉一个假隔离"，不是新增约定。
 *
 * ## 持久化细节
 *
 * - 构造时同步读一次（文件在扩展 data 目录里，通常几 KB；`createExtensionApi` 本身是同步装配）；
 * - `update` 先改内存再落盘，落盘是**写临时文件 + rename**（崩溃时不会留下半个 JSON）；
 * - 写入串行化（同一个 memento 的多次 `update` 按调用顺序落地，后写覆盖前写）；
 * - 畸形 JSON / 非对象 → 当成空存储（不抛错：一个坏文件不该让扩展激活失败）。
 *
 * 返回对象**只有 `Memento` 的三个成员**：多挂一个字段（比如文件路径）会被
 * `listApiImplementation` 记成第四项能力（`workspaceState.file` 曾真的出现在对照表里）。
 */
export function createMementoStore(file: string): Memento {
  // `const`：只有内容（键值）会变，绑定本身不换（`delete data[key]` / `data[key] = v` 都不是重赋值）
  const data: Record<string, unknown> = loadSync(file)
  let queue: Promise<void> = Promise.resolve()

  const persist = (): Promise<void> => {
    const text = JSON.stringify(data, null, 2)
    queue = queue.then(async (): Promise<void> => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file)
    })
    return queue
  }

  return {
    keys(): string[] {
      return Object.keys(data)
    },
    get<T = unknown>(key: string, defaultValue?: T): T | undefined {
      // 显式 `in`：存进去的 `null` 与"没存过"必须区分（v1 用 `key in ns`，照旧）
      return key in data ? (data[key] as T) : defaultValue
    },
    async update(key: string, value: unknown): Promise<void> {
      if (typeof key !== 'string' || key.trim() === '') {
        throw new Error('memento.update 的 key 必须是非空字符串')
      }
      if (value === undefined) delete data[key]
      else data[key] = value
      await persist()
    }
  }
}

/** 同步读 memento 文件（畸形/不存在 → 空存储） */
function loadSync(file: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return { ...(parsed as Record<string, unknown>) }
  } catch {
    return {}
  }
}

/** 同上，异步版（暴露给"想不阻塞地校验一次"的调用方；当前只有测试用） */
export async function readMementoFile(file: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return { ...(parsed as Record<string, unknown>) }
  } catch {
    return {}
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Hub（进程内共享的一份数据面状态）                                                              */
/* -------------------------------------------------------------------------------------------- */

/** 一个扩展在 hub 里的状态 */
interface ExtensionPlaneState {
  readonly extId: string
  readonly extensionDir: string
  readonly manifest: UiPlaneManifest
  readonly log: HostLogger
  /** `settings.onChanged` 订阅者 */
  readonly settingsListeners: Set<(key: string) => void>
  /** `theme.onChanged` 订阅者 */
  readonly themeListeners: Set<(themeId: string) => void>
  /** `i18n.onLocaleChanged` 订阅者 */
  readonly localeListeners: Set<(locale: string) => void>
  /** `i18n.registerMessages` 运行时追加的文案（按 locale 合并） */
  readonly runtimeMessages: Map<string, Record<string, string>>
  /** 本扩展注册的树视图 provider（viewId → provider） */
  readonly treeProviders: Map<string, TreeViewProvider>
  /** `app.onMessage` 注册的处理器（每扩展一个，与 v1 的 `appMessageHandlers` 同语义） */
  appMessageHandler: ((channel: string, payload: unknown) => unknown | Promise<unknown>) | null
  /** 运行时状态栏项（宿主侧句柄 id → 当前值；渲染侧按 id 找同一项） */
  readonly statusBarItems: Map<string, { text: string; tooltip?: string; visible: boolean }>
  /** 本扩展注册的事件总线订阅（停用时逐个退订，避免泄漏到下一个实例） */
  readonly busCleanups: Array<() => void>
  /** 本扩展已经发过的 `dispose` 句柄（幂等） */
  statusSeq: number
  /** 本扩展创建过的输出通道数（生成 `host-output:<extId>:<n>` 的序号） */
  outputSeq: number
  /** 本扩展发起过的进度任务数（生成 `host-progress:<extId>:<n>` 的序号） */
  progressSeq: number
}

/** hub 的构造参数 */
export interface UiPlaneHubOptions {
  /** `host-renderer` 的 port1（缺省 ⇒ 所有"要送到渲染侧"的调用抛 `EH_NOT_READY`） */
  rendererPort?: HostRendererPortLike | null
  /** hub 级日志（缺省丢弃；装配处会传宿主 logger） */
  log?: HostLogger
  /**
   * 宿主 → 渲染侧 `RpcClient` 的定时器（缺省 {@link systemRpcTimers}）。
   * 单测注入假时钟才能断言"模态框 60 秒无结果 ⇒ 当取消"，而不用真的等一分钟。
   */
  rpcTimers?: RpcTimers
  /** 模态框等待上限（毫秒，缺省 {@link UI_MODAL_TIMEOUT_MS}；单测可缩短） */
  modalTimeoutMs?: number
}

/** `hub.forExtension()` 的参数 */
export interface UiPlaneExtensionOptions {
  /** 扩展 id（所有数据按它隔离） */
  extId: string
  /** 扩展根目录（读 `manifest.json` 用） */
  extensionDir: string
  /** 宿主的初始语言（`init` 之前只有 env 里的 `OBOX_LOCALE`；渲染侧快照到了会覆盖） */
  locale: string
  log: HostLogger
  /** 读清单文本（缺省读 `<extensionDir>/manifest.json`；测试注入） */
  readManifest?: (extensionDir: string) => string
  /**
   * 宿主 → main 的请求通道（`apiFactory` 已经把 `options.hostMain` 接好）。
   *
   * 本卡只用于 `update` 的 4 条门控方法（门控放行后：解析源/检查/下载/安装都要 main 的
   * `electron-updater`）。缺省 ⇒ 抛 `EH_INTERNAL` + 「需要主进程 IPC」，与 secrets/clipboard 同一口径。
   */
  hostMain?: HostMainBridge
  /**
   * 读当前代理配置（`update.*` 与 v1 一样带上代理：`window.api.resolveUpdateFeed(repo, proxy())`）。
   *
   * 由装配处提供（`() => hostMainCapabilities.proxy.get()`：宿主侧同步缓存，来自 main 的
   * `host.proxy.get`），这样本文件不必知道 `ProxyConfig` 的形状。
   */
  readProxyConfig?: () => unknown
}

/** 本卡新增的三族能力（`apiFactory` 摊进 `api`） */
export interface UiPlaneUpdateCapabilities {
  readonly resolveFeed: ExtensionActivationApi['update']['resolveFeed']
  readonly check: ExtensionActivationApi['update']['check']
  readonly download: ExtensionActivationApi['update']['download']
  readonly install: ExtensionActivationApi['update']['install']
}

/** 一个扩展拿到的数据面能力（`apiFactory` 直接摊进 `api`） */
export interface UiPlaneExtension {
  readonly statusBar: ExtensionActivationApi['statusBar']
  readonly navbar: ExtensionActivationApi['navbar']
  readonly views: ExtensionActivationApi['views']
  readonly settings: ExtensionActivationApi['settings']
  readonly theme: ExtensionActivationApi['theme']
  readonly i18n: ExtensionActivationApi['i18n']
  readonly app: ExtensionActivationApi['app']
  readonly on: ExtensionActivationApi['on']
  readonly emit: ExtensionActivationApi['emit']
  readonly registerCommand: ExtensionActivationApi['registerCommand']
  readonly executeCommand: ExtensionActivationApi['executeCommand']
  /** EH-B3b-2：交互 UI（渲染侧 `uiStore` 渲染，宿主发起请求） */
  readonly ui: ExtensionActivationApi['ui']
  /** EH-B3b-2：输出通道（渲染侧 `outputStore` 持有；本文件只发事件） */
  readonly output: ExtensionActivationApi['output']
  /** EH-B3b-2：更新门控（渲染侧 `updaterStore` 判定，放行后回 main） */
  readonly update: UiPlaneUpdateCapabilities
  /** 发 dispose 事件并清掉本扩展在 hub 里的一切（停用时调用；幂等） */
  dispose(): void
}

/** 数据面 hub 的观察面（测试/诊断） */
export interface UiPlaneHub {
  /** 换/补上渲染侧端口（幂等；`null` 不覆盖已捕获的端口） */
  attachRendererPort(port: HostRendererPortLike | null): void
  /** 当前是否已连上渲染侧 */
  hasRendererPort(): boolean
  /** 已发出的 `event` 数（测试用） */
  sentCount(): number
  /** 已注册的命令数（诊断用） */
  commandCount(): number
  /** 处理一条来自渲染侧的原始信封（`event` 快照推送 / `req` 反向调用） */
  handleRendererMessage(raw: unknown): void
  /** 为某个扩展构造能力 */
  forExtension(options: UiPlaneExtensionOptions): UiPlaneExtension
  /** 关掉 hub（宿主退出时；幂等） */
  dispose(): void
}

/** 发往渲染侧的一个 `event`（形状校验 + 可传输性 + 帧上限都在这里） */
function assertEventPayload(channel: string, payload: unknown): EventEnvelope {
  const measured = checkSerializable(payload, `payload(${channel})`)
  if (!measured.ok) {
    throw new EhProtocolError(
      'EH_UNSERIALIZABLE',
      `发往渲染侧的数据无法跨进程传输：${measured.path} 是 ${measured.kind}。` +
        '请只传纯数据（字符串/数字/布尔/null/纯对象/数组）；函数与类实例要放在宿主里或用 id 引用。'
    )
  }
  const envelope = createEventEnvelope(channel, payload)
  const frame = checkFrameSize(envelope)
  if (!frame.ok) {
    throw new EhProtocolError(frame.code, '发往渲染侧的单帧超过 8 MB 上限。', frame.why)
  }
  return envelope
}

/** 造 hub（生产用 `getSharedUiPlaneHub`；单测直接造一个注入假端口） */
export function createUiPlaneHub(options: UiPlaneHubOptions = {}): UiPlaneHub {
  const log: HostLogger = options.log ?? ((): void => {})
  /** 每个扩展一份 */
  const extensions = new Map<string, ExtensionPlaneState>()
  /** 全局命令表：command id → 归属扩展 + 实现（`executeCommand` 跨扩展可见，与 v1 同一张表语义） */
  const commands = new Map<string, { extId: string; handler: (...args: unknown[]) => unknown }>()
  /** 事件总线（`on` / `emit`）：进程内共享，键是事件名 */
  const busListeners = new Map<string, Set<(...args: unknown[]) => void>>()

  /** 渲染侧推上来的当前值（`settings.get` / `theme.getCurrent` 的同步缓存） */
  let cachedSettings: Record<string, unknown> = {}
  let cachedLocale = ''
  let cachedThemeId = ''
  /** 快照是否到过（没到过时读缓存要留痕，见 {@link warnColdCache}） */
  let snapshotArrived = false
  /** 冷缓存告警只发一次（每次读都刷一条会把宿主日志淹掉） */
  let warnedColdCache = false

  let rendererPort: HostRendererPortLike | null = null
  let sent = 0
  let disposed = false

  const sendEnvelope: EnvelopeSink = (envelope: Envelope): void => {
    const port = rendererPort
    if (!port) {
      throw new EhProtocolError('EH_NOT_READY', HOST_RENDERER_PORT_MISSING)
    }
    port.postMessage(envelope)
    sent += 1
  }

  /** 反向调用的服务端（渲染侧 → 宿主）：与 host-main 用的是同一个实现，语义天然一致 */
  const rpc = new RpcServer({
    send: (envelope): void => {
      sendEnvelope(envelope)
    },
    log
  })

  /**
   * **宿主 → 渲染侧**的客户端（EH-B3b-2）：`ui.*` / `output` 之外的 4 条 `update` 门控与全部
   * UI 请求都从这里发出。与服务端是同一份 `../rpc.ts` 实现，方向相反。
   *
   * 超时语义沿用 `ACK_TIMEOUT_MS`（3 秒）**只做默认**：模态框显式传 `timeoutMs = modalTimeoutMs`
   * （v1 的 60 秒），因为"用户还没点"不是"对端卡住"。
   */
  const client = new RpcClient({
    send: (envelope): void => {
      sendEnvelope(envelope)
    },
    log,
    timers: options.rpcTimers ?? systemRpcTimers
  })
  const modalTimeoutMs = options.modalTimeoutMs ?? UI_MODAL_TIMEOUT_MS

  /**
   * 在途的 `ui.withProgress` 会话（progressId → 取消入口）。
   *
   * 为什么放在 hub 级而不是扩展级：取消是渲染侧经 `ui.progressCancel` **按 progressId** 找回来的，
   * 与哪个扩展无关（id 里已带 extId）；hub 级一张表才能让"取消一条已经不存在的进度"变成幂等 no-op。
   */
  const progressSessions = new Map<string, { cancel(): void; cancelled: boolean }>()

  /** 发一条 `event`（端口没到 ⇒ 抛 `EH_NOT_READY`，不静默） */
  const emit = (channel: string, payload: unknown): void => {
    if (disposed) return
    sendEnvelope(assertEventPayload(channel, payload))
  }

  /** 端口没到时的中文错误（`on/emit` 之外的"必须送到界面"的动作都走它） */
  const requirePort = (): void => {
    if (disposed) {
      throw new EhProtocolError('EH_CANCELLED', '扩展宿主正在退出，数据面已关闭。')
    }
    if (!rendererPort) {
      throw new EhProtocolError('EH_NOT_READY', HOST_RENDERER_PORT_MISSING)
    }
  }

  const stateOf = (extId: string): ExtensionPlaneState | undefined => extensions.get(extId)

  /** 冷缓存读取的留痕（快照还没到 ⇒ 返回默认值，但**要在宿主日志里说出来**） */
  const warnColdCache = (what: string): void => {
    if (snapshotArrived || warnedColdCache) return
    warnedColdCache = true
    log(
      'warn',
      `数据面快照还没到，${what} 先返回缺省值`,
      '正常时序下渲染侧在端口到达时（早于 init 一个 IPC 往返）就推了快照；这条只该在异常时序或单测里出现'
    )
  }

  /* ------------------------------ 渲染侧 → 宿主：快照推送 ------------------------------ */

  const applySnapshot = (payload: SettingsSnapshotPayload): void => {
    const nextSettings =
      typeof payload.settings === 'object' && payload.settings !== null ? payload.settings : {}
    const changedKeys = diffKeys(cachedSettings, nextSettings)
    /** 第一次快照是**初始化校准**，不是"变化"（v1 的 onChanged/onLocaleChanged 也不在激活时报一次） */
    const initialization = !snapshotArrived
    cachedSettings = nextSettings
    snapshotArrived = true

    const localeChanged = payload.locale !== cachedLocale
    const themeChanged = payload.themeId !== cachedThemeId
    cachedLocale = typeof payload.locale === 'string' ? payload.locale : ''
    cachedThemeId = typeof payload.themeId === 'string' ? payload.themeId : ''
    if (initialization) return

    // `settings.onChanged`：按变化了的具体 key 逐个通知（v1 的 `stateStore.onSettingsChanged`
    // 也是"带变更 key"，扩展据此只刷自己关心的项）
    if (changedKeys.length > 0) {
      for (const state of extensions.values()) {
        for (const key of changedKeys) notify(state.settingsListeners, key)
      }
    }
    if (localeChanged) {
      for (const state of extensions.values()) notify(state.localeListeners, cachedLocale)
    }
    if (themeChanged) {
      for (const state of extensions.values()) notify(state.themeListeners, cachedThemeId)
    }
  }

  /* ------------------------------ 反向调用（渲染侧发起的 req） ------------------------------ */

  const findTreeProvider = (extId: string, viewId: string): TreeViewProvider | undefined =>
    stateOf(extId)?.treeProviders.get(viewId)

  rpc.register(UI_PLANE_RPC.executeCommand, (params: unknown): Promise<unknown> => {
    const record = asRecord(params)
    const command = typeof record.command === 'string' ? record.command : ''
    if (command === '') {
      throw new EhProtocolError('EH_INTERNAL', 'ui.executeCommand 需要字符串 command')
    }
    const args = Array.isArray(record.args) ? (record.args as unknown[]) : []
    return Promise.resolve(executeCommand(command, args))
  })

  rpc.register(UI_PLANE_RPC.treeChildren, async (params: unknown): Promise<TreeItem[]> => {
    const record = asRecord(params)
    const extId = typeof record.extId === 'string' ? record.extId : ''
    const viewId = typeof record.viewId === 'string' ? record.viewId : ''
    const provider = findTreeProvider(extId, viewId)
    if (!provider) {
      throw new EhProtocolError(
        'EH_UNKNOWN_EXT',
        `扩展 ${extId || '(未给)'} 没有注册视图 ${viewId || '(未给)'} 的数据源`,
        '渲染侧的 views 注册事件与宿主里的 provider 对不上（可能扩展已停用）'
      )
    }
    const element = record.element
    const children = await provider.getChildren(
      typeof element === 'object' && element !== null ? (element as TreeItem) : undefined
    )
    return Array.isArray(children) ? children : []
  })

  rpc.register(UI_PLANE_RPC.appMessage, async (params: unknown): Promise<unknown> => {
    const record = asRecord(params)
    const extId = typeof record.extId === 'string' ? record.extId : ''
    const state = stateOf(extId)
    const handler = state?.appMessageHandler
    if (!handler) {
      throw new EhProtocolError(
        'EH_UNKNOWN_EXT',
        `扩展 ${extId || '(未给)'} 没有注册 app.onMessage 处理器`,
        '与 v1 的「扩展未注册消息处理器」同一判定'
      )
    }
    const channel = typeof record.channel === 'string' ? record.channel : ''
    return await handler(channel, record.payload)
  })

  /** 执行命令：先查宿主的命令表（跨扩展），没有就照 v1 的文案报错 */
  const executeCommand = async (id: string, args: unknown[]): Promise<unknown> => {
    const entry = commands.get(id)
    if (!entry) throw new Error(`command not found: ${id}`)
    return await entry.handler(...args)
  }

  /**
   * `ui.progressCancel`（渲染侧 → 宿主，EH-B3b-2）：把某个进度任务判为已取消。
   *
   * 幂等：进度已经结束（`progressSessions` 里没有它）时回 `{ok:false}` 而不是抛错——渲染侧的
   * "结束"与"取消"可能交错到达（用户点取消的同时任务刚好跑完），那不是错误。
   */
  rpc.register(UI_PLANE_RPC.progressCancel, (params: unknown): { ok: boolean } => {
    const record = asRecord(params)
    const progressId = typeof record.progressId === 'string' ? record.progressId : ''
    const session = progressId === '' ? undefined : progressSessions.get(progressId)
    if (!session) {
      log(
        'debug',
        `收到 ui.progressCancel（progressId=${progressId || '(未给)'}）：没有在途进度，忽略`
      )
      return { ok: false }
    }
    session.cancel()
    return { ok: true }
  })

  /* ------------------------------ 端口 ------------------------------ */

  const attachRendererPort = (port: HostRendererPortLike | null): void => {
    if (!port || port === rendererPort || disposed) return
    rendererPort = port
    // 挂 `onmessage` 即隐式 `start()`：端口在 start 之前会把消息**排队**，所以"拿到就挂"
    // 不会丢渲染侧早发的快照（它比宿主的 init 还早一个 IPC 往返）。
    try {
      port.onmessage = (event: unknown): void => {
        handleRendererMessage(unwrapParentPortMessage(event))
      }
    } catch (error) {
      log('warn', '挂 host-renderer 端口的 onmessage 失败', toErrorMessage(error))
    }
  }

  /* ------------------------------ 入站信封 ------------------------------ */

  const handleRendererMessage = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) {
      log('warn', '收到非对象的渲染侧消息，已忽略')
      return
    }
    const envelope = raw as { t?: unknown; channel?: unknown; payload?: unknown }
    if (envelope.t === 'req') {
      rpc.handleRequest(raw as RequestEnvelope)
      return
    }
    if (envelope.t === 'cancel') {
      rpc.handleCancel(raw as CancelEnvelope)
      return
    }
    if (envelope.t === 'res') {
      // EH-B3b-2：宿主 → 渲染侧请求的**回包**（方向与下面三类相反）
      client.handleResponse(raw as ResponseEnvelope)
      return
    }
    if (envelope.t === 'err') {
      client.handleError(raw as ErrorEnvelope)
      return
    }
    if (envelope.t === 'event') {
      if (envelope.channel === EH_EVENT_CHANNELS.settings) {
        const payload = asRecord(envelope.payload)
        if (payload.op === 'snapshot') {
          applySnapshot(envelope.payload as SettingsSnapshotPayload)
          return
        }
        log('warn', `渲染侧发来未知的 settings 子操作 ${String(payload.op)}，已忽略`)
        return
      }
      // 其它 channel 目前没有"渲染侧 → 宿主"的语义：记一条 debug 就好（不是错误）
      log('debug', `忽略渲染侧事件 channel=${String(envelope.channel)}`)
      return
    }
    log('warn', `宿主数据面不消费渲染侧信封 t=${String(envelope.t)}，已忽略`)
  }

  /* ------------------------------ 能力装配 ------------------------------ */

  const forExtension = (extensionOptions: UiPlaneExtensionOptions): UiPlaneExtension => {
    const { extId, extensionDir, log: extLog } = extensionOptions
    const existing = extensions.get(extId)
    if (existing) {
      // 同一宿主内重复激活（热重载）时复用状态，只把旧注册清掉
      extensionOptions.log('warn', `数据面已经在为 ${extId} 服务，重建它的注册`)
      extensions.delete(extId)
      for (const [command, entry] of [...commands]) {
        if (entry.extId === extId) commands.delete(command)
      }
    }

    const manifest = loadManifestText(extensionOptions)
    const state: ExtensionPlaneState = {
      extId,
      extensionDir,
      manifest,
      log: extLog,
      settingsListeners: new Set(),
      themeListeners: new Set(),
      localeListeners: new Set(),
      runtimeMessages: new Map(),
      treeProviders: new Map(),
      appMessageHandler: null,
      statusBarItems: new Map(),
      busCleanups: [],
      statusSeq: 0,
      outputSeq: 0,
      progressSeq: 0
    }
    extensions.set(extId, state)

    /* ------------------------------ 状态栏 ------------------------------ */

    const statusBarItemOf = (id: string): { text: string; tooltip?: string; visible: boolean } => {
      const item = state.statusBarItems.get(id)
      if (item) return item
      // 静态项（manifest 声明）：文本/可见性由宿主先记在影子表里，再送渲染侧（渲染侧读的是
      // 注册表里那条同名项）。影子表让"setText → show → hide"的顺序在宿主侧也自洽。
      const shadow = { text: '', visible: true }
      state.statusBarItems.set(id, shadow)
      return shadow
    }

    const statusBar: ExtensionActivationApi['statusBar'] = {
      setText(id: string, text: string): void {
        requirePort()
        statusBarItemOf(id).text = text
        emit(EH_EVENT_CHANNELS.statusBar, {
          v: UI_PLANE_PAYLOAD_VERSION,
          kind: 'setText',
          extId,
          id,
          text
        })
      },
      setTooltip(id: string, tooltip: string): void {
        requirePort()
        statusBarItemOf(id).tooltip = tooltip
        emit(EH_EVENT_CHANNELS.statusBar, {
          v: UI_PLANE_PAYLOAD_VERSION,
          kind: 'setTooltip',
          extId,
          id,
          tooltip
        })
      },
      show(id: string): void {
        requirePort()
        statusBarItemOf(id).visible = true
        emit(EH_EVENT_CHANNELS.statusBar, {
          v: UI_PLANE_PAYLOAD_VERSION,
          kind: 'setVisible',
          extId,
          id,
          visible: true
        })
      },
      hide(id: string): void {
        requirePort()
        statusBarItemOf(id).visible = false
        emit(EH_EVENT_CHANNELS.statusBar, {
          v: UI_PLANE_PAYLOAD_VERSION,
          kind: 'setVisible',
          extId,
          id,
          visible: false
        })
      },
      createItem(init): StatusBarItem {
        requirePort()
        state.statusSeq += 1
        const id = `host-runtime:${extId}:${state.statusSeq}`
        const plainInit = compactInit(init)
        const shadow = {
          text: plainInit.text ?? '',
          tooltip: plainInit.tooltip,
          visible: true
        }
        state.statusBarItems.set(id, shadow)
        emit(EH_EVENT_CHANNELS.statusBar, {
          v: UI_PLANE_PAYLOAD_VERSION,
          kind: 'create',
          extId,
          id,
          init: plainInit
        })
        const item: StatusBarItem = {
          get text(): string {
            return shadow.text
          },
          set text(value: string) {
            statusBar.setText(id, value)
          },
          get tooltip(): string | undefined {
            return shadow.tooltip
          },
          set tooltip(value: string | undefined) {
            if (value === undefined) return
            statusBar.setTooltip(id, value)
          },
          show: (): void => statusBar.show(id),
          hide: (): void => statusBar.hide(id),
          dispose: (): void => {
            if (!state.statusBarItems.delete(id)) return
            if (disposed || !rendererPort) return
            emit(EH_EVENT_CHANNELS.statusBar, {
              v: UI_PLANE_PAYLOAD_VERSION,
              kind: 'dispose',
              extId,
              id
            })
          }
        }
        return item
      }
    }

    /* ------------------------------ 导航徽标 ------------------------------ */

    const navbar: ExtensionActivationApi['navbar'] = {
      setBadge(id: string, count: number | undefined): void {
        requirePort()
        // `undefined` 不能过桥（`checkSerializable` 拒 `undefined`）⇒ 用 `null` 表示"清除徽标"，
        // 与 `registry.setNavBadge(id, undefined)` 的语义一一对应。
        const payload: ViewsPayload = {
          v: UI_PLANE_PAYLOAD_VERSION,
          kind: 'navBadge',
          extId,
          id,
          count: typeof count === 'number' ? count : null
        }
        emit(EH_EVENT_CHANNELS.views, payload)
      }
    }

    /* ------------------------------ 命令 ------------------------------ */

    const registerCommand: ExtensionActivationApi['registerCommand'] = (
      id: string,
      handler: (...args: unknown[]) => unknown
    ) => {
      // 与 statusBar 同口径：注册是"要送到界面"的动作，端口没到就响亮失败。
      // （宿主内 `executeCommand` 不依赖端口，但"能执行却不出现在命令面板"是更难查的半可用状态）
      requirePort()
      if (typeof id !== 'string' || id.trim() === '') {
        throw new Error('registerCommand 的命令 id 必须是非空字符串')
      }
      if (typeof handler !== 'function') {
        throw new Error(`registerCommand(${id}) 的 handler 必须是函数`)
      }
      const title = state.manifest.commandTitles.get(id)
      if (title === undefined) {
        // v1 同一告警（`[host] ${ext.id} 注册了未声明的命令`）：不阻断，但要说出来
        extLog(
          'warn',
          `扩展 ${extId} 注册了未在 manifest 声明的命令 ${id}`,
          'manifest 的 contributes.commands 未包含该 id：命令面板里不会出现它'
        )
      }
      commands.set(id, { extId, handler })
      const payload: CommandsPayload =
        title === undefined
          ? { v: UI_PLANE_PAYLOAD_VERSION, op: 'register', extId, command: id }
          : { v: UI_PLANE_PAYLOAD_VERSION, op: 'register', extId, command: id, title }
      emit(EH_EVENT_CHANNELS.commands, payload)
      return {
        dispose: (): void => {
          const entry = commands.get(id)
          if (entry && entry.extId === extId && entry.handler === handler) commands.delete(id)
          // 停用时端口可能已经关了（宿主正在退出）：清理尽力而为，不抛
          if (disposed || !rendererPort) return
          emit(EH_EVENT_CHANNELS.commands, {
            v: UI_PLANE_PAYLOAD_VERSION,
            op: 'dispose',
            extId,
            command: id
          })
        }
      }
    }

    const executeCommandForExt: ExtensionActivationApi['executeCommand'] = <T = unknown>(
      id: string,
      ...args: unknown[]
    ): Promise<T> => executeCommand(id, args) as Promise<T>

    /* ------------------------------ 树视图 ------------------------------ */

    const views: ExtensionActivationApi['views'] = {
      registerTreeProvider(viewId: string, provider: TreeViewProvider) {
        requirePort()
        if (typeof viewId !== 'string' || viewId.trim() === '') {
          throw new Error('registerTreeProvider 的 viewId 必须是非空字符串')
        }
        if (!provider || typeof provider.getChildren !== 'function') {
          throw new Error(`registerTreeProvider(${viewId}) 的 provider 必须实现 getChildren`)
        }
        state.treeProviders.set(viewId, provider)
        emit(EH_EVENT_CHANNELS.views, {
          v: UI_PLANE_PAYLOAD_VERSION,
          kind: 'treeProvider',
          op: 'register',
          extId,
          viewId
        })
        return {
          dispose: (): void => {
            if (state.treeProviders.get(viewId) === provider) state.treeProviders.delete(viewId)
            if (disposed || !rendererPort) return
            emit(EH_EVENT_CHANNELS.views, {
              v: UI_PLANE_PAYLOAD_VERSION,
              kind: 'treeProvider',
              op: 'dispose',
              extId,
              viewId
            })
          }
        }
      }
    }

    /* ------------------------------ 设置 ------------------------------ */

    const settings: ExtensionActivationApi['settings'] = {
      register(page: SettingsPage) {
        requirePort()
        if (!page || typeof page.id !== 'string' || page.id.trim() === '') {
          throw new Error('settings.register 的 page.id 必须是非空字符串')
        }
        emit(EH_EVENT_CHANNELS.settings, {
          v: UI_PLANE_PAYLOAD_VERSION,
          op: 'registerPage',
          extId,
          page
        })
        // 与 v1 同一语义：只撤掉自己这一页（manifest 声明的页与其它运行时页不受影响）
        return {
          dispose: (): void => {
            if (disposed || !rendererPort) return
            emit(EH_EVENT_CHANNELS.settings, {
              v: UI_PLANE_PAYLOAD_VERSION,
              op: 'disposePage',
              extId,
              pageId: page.id
            })
          }
        }
      },
      get<T = unknown>(key: string, defaultValue?: T): T | undefined {
        if (!snapshotArrived) warnColdCache(`settings.get(${key})`)
        return key in cachedSettings ? (cachedSettings[key] as T) : defaultValue
      },
      set(key: string, value: unknown): void {
        requirePort()
        if (typeof key !== 'string' || key.trim() === '') {
          throw new Error('settings.set 的 key 必须是非空字符串')
        }
        if (value === undefined) {
          // `undefined` 过不了桥：显式改成删除子操作（与 `stateStore.setSetting` 一致：undefined 即删）
          emit(EH_EVENT_CHANNELS.settings, {
            v: UI_PLANE_PAYLOAD_VERSION,
            op: 'unset',
            key
          })
          delete cachedSettings[key]
          return
        }
        emit(EH_EVENT_CHANNELS.settings, {
          v: UI_PLANE_PAYLOAD_VERSION,
          op: 'set',
          key,
          value
        })
        cachedSettings[key] = value
      },
      onChanged(callback: (key: string) => void) {
        state.settingsListeners.add(callback)
        return {
          dispose: (): void => {
            state.settingsListeners.delete(callback)
          }
        }
      }
    }

    /* ------------------------------ 主题 ------------------------------ */

    const theme: ExtensionActivationApi['theme'] = {
      getCurrent(): string {
        if (!snapshotArrived) warnColdCache('theme.getCurrent()')
        return cachedThemeId
      },
      onChanged(callback: (themeId: string) => void) {
        state.themeListeners.add(callback)
        return {
          dispose: (): void => {
            state.themeListeners.delete(callback)
          }
        }
      }
    }

    /* ------------------------------ 多语言 ------------------------------ */

    const messagesFor = (locale: string): Record<string, string> => {
      const base = state.manifest.messages[locale] ?? {}
      const runtime = state.runtimeMessages.get(locale) ?? {}
      return { ...base, ...runtime }
    }

    const currentLocale = (): string => cachedLocale || extensionOptions.locale

    const i18n: ExtensionActivationApi['i18n'] = {
      t(key: string, params?: Record<string, unknown>): string {
        const locale = currentLocale()
        // 该语言没有这条文案时回退 zh（渲染侧 `translateExtension` 同一意图；那边是"整包回退"，
        // 这边按 key 回退，是它的超集——键都存在时行为一致）
        const dict = messagesFor(locale)
        const fallback = locale === 'zh' ? {} : messagesFor('zh')
        const text = key in dict ? dict[key] : fallback[key]
        if (text === undefined) return key
        if (!params) return text
        let out = text
        for (const [name, value] of Object.entries(params)) {
          out = out.split(`{${name}}`).join(String(value))
        }
        return out
      },
      get locale(): string {
        return currentLocale()
      },
      onLocaleChanged(callback: (locale: string) => void) {
        state.localeListeners.add(callback)
        return {
          dispose: (): void => {
            state.localeListeners.delete(callback)
          }
        }
      },
      registerMessages(messages: Record<string, Record<string, string>>): void {
        if (typeof messages !== 'object' || messages === null) {
          throw new Error('i18n.registerMessages 的参数必须是 { locale: { key: text } }')
        }
        for (const [locale, table] of Object.entries(messages)) {
          if (typeof table !== 'object' || table === null) continue
          const merged = { ...(state.runtimeMessages.get(locale) ?? {}) }
          for (const [key, value] of Object.entries(table)) {
            if (typeof value === 'string') merged[key] = value
          }
          state.runtimeMessages.set(locale, merged)
        }
      }
    }

    /* ------------------------------ App ------------------------------ */

    const app: ExtensionActivationApi['app'] = {
      register(registration: AppRegistration) {
        requirePort()
        if (!registration || typeof registration.id !== 'string' || registration.id.trim() === '') {
          throw new Error('app.register 的 registration.id 必须是非空字符串')
        }
        emit(EH_EVENT_CHANNELS.appRegister, {
          v: UI_PLANE_PAYLOAD_VERSION,
          op: 'register',
          extId,
          registration
        })
        return {
          dispose: (): void => {
            if (disposed || !rendererPort) return
            emit(EH_EVENT_CHANNELS.appRegister, {
              v: UI_PLANE_PAYLOAD_VERSION,
              op: 'dispose',
              extId,
              appId: registration.id
            })
          }
        }
      },
      onMessage(handler) {
        requirePort()
        if (typeof handler !== 'function') {
          throw new Error('app.onMessage 的 handler 必须是函数')
        }
        state.appMessageHandler = handler
        // 必须告诉渲染侧"消息可以往我这里寻址"：渲染侧的消息桥按 `appMessageHandlers` 派发
        // （`core/host.ts` 的 `handleExtensionMessage`），没有这条事件它只会回
        // 「扩展未注册消息处理器」——那是**看起来正常**的静默失败。
        emit(EH_EVENT_CHANNELS.appRegister, {
          v: UI_PLANE_PAYLOAD_VERSION,
          op: 'messageHandler',
          extId
        })
        return {
          dispose: (): void => {
            if (state.appMessageHandler === handler) state.appMessageHandler = null
          }
        }
      }
    }

    /* ------------------------------ 交互 UI（EH-B3b-2） ------------------------------ */

    // 方向：**宿主 → 渲染侧**（上面的 `client`）。语义逐条照抄 v1（见文件头「语义照抄 v1」）：
    // 端口没到 ⇒ `EH_NOT_READY`；端口到了但窗口不在 ⇒ 渲染侧回 `EH_NOT_READY` + UI_WINDOW_MISSING。

    /** 请求参数先过可传输性守卫（函数/类实例/undefined 在跨进程**之前**就报清楚字段路径） */
    const assertCallParams = (method: string, params: unknown): void => {
      const measured = checkSerializable(params, `params(${method})`)
      if (!measured.ok) {
        throw new EhProtocolError(
          'EH_UNSERIALIZABLE',
          `调用渲染侧 ${method} 的参数无法跨进程传输：${measured.path} 是 ${measured.kind}。` +
            '请只传纯数据；回调要留在宿主里（界面侧按 id 寻址回来）。'
        )
      }
    }

    /** 发一条宿主 → 渲染侧的请求（端口没到当场抛，不排队假成功） */
    const callRenderer = async (
      method: string,
      params: unknown,
      requestOptions?: RpcRequestOptions
    ): Promise<unknown> => {
      requirePort()
      assertCallParams(method, params)
      return await client.request(method, params, requestOptions)
    }

    /**
     * 一条模态框请求：回 `{value}`，`null`/缺省 = 取消 ⇒ `undefined`。
     *
     * `EH_TIMEOUT` **也当取消**：v1 的 `src/main/ui.ts` 是 60s 定时器 ⇒ `canceled:true` ⇒ `undefined`。
     * 这里用同一个数（`UI_MODAL_TIMEOUT_MS`）并做同样的翻译，区别只是"谁在计时"（宿主侧 RpcClient）。
     */
    const runModal = async <T>(method: string, params: unknown): Promise<T | undefined> => {
      let raw: unknown
      try {
        raw = await callRenderer(method, params, { timeoutMs: modalTimeoutMs })
      } catch (error) {
        if (error instanceof EhProtocolError && error.code === 'EH_TIMEOUT') {
          extLog(
            'warn',
            `${method} 在 ${modalTimeoutMs}ms 内没有结果，按 v1 语义当作取消（返回 undefined）`,
            'v1 的 src/main/ui.ts 也是 60s 定时器 ⇒ canceled:true'
          )
          return undefined
        }
        // 其余错误（EH_NOT_READY / EH_CANCELLED / EH_INTERNAL）原样抛：链路与窗口问题必须响亮
        throw error
      }
      const value = asRecord(raw).value
      return value === null || value === undefined ? undefined : (value as T)
    }

    const ui: ExtensionActivationApi['ui'] = {
      showQuickPick(items, opts) {
        const list = Array.isArray(items) ? items.map((item) => compactShallow(item)) : []
        return runModal<string>(
          UI_RENDERER_RPC.showQuickPick,
          opts === undefined ? { items: list } : { items: list, opts: compactShallow(opts) }
        )
      },
      showInputBox(opts) {
        return runModal<string>(
          UI_RENDERER_RPC.showInputBox,
          opts === undefined ? {} : compactShallow(opts)
        )
      },
      showMessage(message, type = 'info') {
        // v1 是**同步 void**（`uiStore.showToast`）：所以这里也不返回 Promise，失败只落宿主日志
        // （一条 toast 不该让扩展的调用点抛错）；但"端口没到"仍然当场抛——那是接缝问题，必须响亮。
        requirePort()
        void callRenderer(UI_RENDERER_RPC.showMessage, {
          message: typeof message === 'string' ? message : String(message ?? ''),
          type: normalizeToastType(type)
        }).catch((error: unknown): void => {
          extLog('warn', 'ui.showMessage 没有送到界面', toErrorMessage(error))
        })
      },
      showForm(opts) {
        const fields = Array.isArray(opts?.fields)
          ? opts.fields.map((field) => compactShallow(field))
          : []
        const params: Record<string, unknown> = { fields }
        if (opts?.title !== undefined) params.title = opts.title
        if (opts?.closeOnClickOutside !== undefined) {
          params.closeOnClickOutside = opts.closeOnClickOutside
        }
        return runModal<Record<string, unknown>>(UI_RENDERER_RPC.showForm, params)
      },
      withProgress: async <T>(
        title: string,
        task: (report: (percent: number) => void) => Promise<T>
      ): Promise<T> => {
        if (typeof task !== 'function') {
          throw new Error('ui.withProgress 的 task 必须是函数')
        }
        requirePort()
        state.progressSeq += 1
        const progressId = `host-progress:${extId}:${state.progressSeq}`
        /** 取消入口（渲染侧经 `ui.progressCancel` 触发；会话结束时整条删掉） */
        const session = {
          cancelled: false,
          cancel: (): void => {}
        }
        await callRenderer(UI_RENDERER_RPC.withProgress, {
          progressId,
          extId,
          title: typeof title === 'string' ? title : String(title ?? '')
        })

        progressSessions.set(progressId, session)
        /** 取消信号：reject 一条永不 resolve 的 Promise，让 `Promise.race` 以 `EH_CANCELLED` 结算 */
        const cancelled = new Promise<never>((_resolve, reject) => {
          session.cancel = (): void => {
            if (session.cancelled) return
            session.cancelled = true
            reject(
              new EhProtocolError(
                'EH_CANCELLED',
                '进度已被界面取消：该 ui.withProgress 的任务被放弃（宿主侧 Promise 以 EH_CANCELLED 失败）',
                `progressId=${progressId}`
              )
            )
          }
        })
        /** 进度帧：取消之后不再发（渲染侧进度条已经拆掉了） */
        const report = (percent: number): void => {
          if (session.cancelled) return
          const value = typeof percent === 'number' && Number.isFinite(percent) ? percent : 0
          void callRenderer(UI_RENDERER_RPC.progressUpdate, { progressId, percent: value }).catch(
            (error: unknown): void => {
              extLog(
                'debug',
                `ui.withProgress 的进度帧没有送到界面（${progressId}）`,
                toErrorMessage(error)
              )
            }
          )
        }

        try {
          const taskPromise = Promise.resolve().then(() => task(report))
          // 取消之后没人再等它：先挂一个空 catch，避免宿主日志被 unhandledRejection 刷屏
          taskPromise.catch((): void => {})
          return await Promise.race([taskPromise, cancelled])
        } finally {
          progressSessions.delete(progressId)
          if (!disposed && rendererPort) {
            // 无论成功/失败/取消都要拆掉界面的进度条（v1 的 `finally { hideProgress() }`）
            void callRenderer(UI_RENDERER_RPC.progressEnd, { progressId }).catch(
              (error: unknown): void => {
                extLog(
                  'debug',
                  `ui.withProgress 结束时拆除进度条失败（${progressId}）`,
                  toErrorMessage(error)
                )
              }
            )
          }
        }
      }
    }

    /* ------------------------------ 输出通道（EH-B3b-2） ------------------------------ */

    // `createChannel` 在 v1 里是**同步**返回句柄的（`outputStore.createChannel(name)`），所以通道 id 只能
    // 由宿主当场生成；渲染侧把 `id` 当映射键、自己那份 store 的 `out-N` 只在该进程内有意义
    // （与 B3b-1 的 `statusBar.createItem` 同一手法）。后续操作全部走 `output` channel 的 event。

    const output: ExtensionActivationApi['output'] = {
      createChannel(name: string): OutputChannel {
        requirePort()
        if (typeof name !== 'string' || name.trim() === '') {
          throw new Error('output.createChannel 的 name 必须是非空字符串')
        }
        state.outputSeq += 1
        const id = `host-output:${extId}:${state.outputSeq}`
        /** 发给渲染侧的通道事件（`href` 停用/宿主退出后静默：句柄还在扩展手里，不能抛） */
        const send = (payload: OutputPayload): void => {
          if (disposed || !rendererPort) return
          emit(UI_PLANE_EVENT_CHANNELS.output, payload)
        }
        send({
          v: UI_PLANE_PAYLOAD_VERSION,
          op: 'create',
          extId,
          id,
          name
        })
        let handleDisposed = false
        return {
          append(text: string): void {
            if (handleDisposed) return
            send({
              v: UI_PLANE_PAYLOAD_VERSION,
              op: 'append',
              extId,
              id,
              text: typeof text === 'string' ? text : String(text ?? '')
            })
          },
          appendLine(text: string): void {
            if (handleDisposed) return
            send({
              v: UI_PLANE_PAYLOAD_VERSION,
              op: 'appendLine',
              extId,
              id,
              text: typeof text === 'string' ? text : String(text ?? '')
            })
          },
          show(): void {
            if (handleDisposed) return
            send({ v: UI_PLANE_PAYLOAD_VERSION, op: 'show', extId, id })
          },
          clear(): void {
            if (handleDisposed) return
            send({ v: UI_PLANE_PAYLOAD_VERSION, op: 'clear', extId, id })
          },
          dispose(): void {
            if (handleDisposed) return
            handleDisposed = true
            send({ v: UI_PLANE_PAYLOAD_VERSION, op: 'dispose', extId, id })
          }
        }
      }
    }

    /* ------------------------------ 更新门控（EH-B3b-2） ------------------------------ */

    // 技术债 #2 的退场：门控真相只在渲染侧（`updaterStore.isActive`），所以**先问渲染侧**，
    // 只有 `{ok:true}` 才回 main（R70 起 main 侧已注册 `host.update.*` 四条，实现复用
    // `src/main/updater.ts` 的同一份逻辑，不是第二套）。

    /**
     * 问渲染侧"我这个扩展是不是当前生效的更新提供者"。
     *
     * 非提供者 ⇒ 抛 v1 逐字同一句（`core/host.ts` 的 `isProvider()`），**绝不在门控前碰 main**。
     * 返回放行时的提供者 `feedUrl`（v1 的 `install({force:true})` 缺省用它）。
     */
    const requireUpdateProvider = async (api: string): Promise<string | undefined> => {
      const gate = asRecord(await callRenderer(UI_RENDERER_RPC.updateGate, { extId }))
      if (gate.ok !== true) {
        const message =
          typeof gate.error === 'string' && gate.error.trim() !== ''
            ? gate.error
            : UPDATE_NOT_PROVIDER
        extLog('warn', `${api} 被拒：${message}`)
        throw new Error(message)
      }
      return typeof gate.feedUrl === 'string' && gate.feedUrl !== '' ? gate.feedUrl : undefined
    }

    /** 发一条宿主 → main 的请求（缺桥 ⇒ 与 secrets/clipboard 同一句中文错误） */
    const callUpdateMain = async (
      api: string,
      method: string,
      params: unknown
    ): Promise<Record<string, unknown>> => {
      const bridge = extensionOptions.hostMain
      if (!bridge) {
        throw new EhProtocolError(
          'EH_INTERNAL',
          `${api} 需要主进程 IPC：宿主进程没有对应的 Electron 模块`,
          `缺桥：hostMain 未接线（需要 main 侧 ${method} 提供者 + runtime.ts 注入）`
        )
      }
      try {
        return asRecord(await bridge.request(method, params))
      } catch (error) {
        if (error instanceof EhProtocolError) throw error
        throw new Error(`${api} 失败：${toErrorMessage(error)}`)
      }
    }

    /** 当前代理配置（v1 的 `proxy()`；渲染侧是 reactive Proxy，宿主侧读的是 main 推来的纯对象） */
    const readProxy = (): unknown => extensionOptions.readProxyConfig?.() ?? null

    const update: UiPlaneUpdateCapabilities = {
      async resolveFeed(repo: string) {
        await requireUpdateProvider('update.resolveFeed')
        const raw = await callUpdateMain(
          'update.resolveFeed',
          HOST_MAIN_METHODS.updateResolveFeed,
          {
            repo: typeof repo === 'string' ? repo : String(repo ?? ''),
            proxy: readProxy()
          }
        )
        const result: {
          ok: boolean
          tag?: string
          feedUrl?: string
          publishedAt?: string
          error?: string
        } = { ok: raw.ok === true }
        if (typeof raw.tag === 'string') result.tag = raw.tag
        if (typeof raw.feedUrl === 'string') result.feedUrl = raw.feedUrl
        if (typeof raw.publishedAt === 'string') result.publishedAt = raw.publishedAt
        if (typeof raw.error === 'string') result.error = raw.error
        return result
      },
      async check(feedUrl: string) {
        await requireUpdateProvider('update.check')
        const raw = await callUpdateMain('update.check', HOST_MAIN_METHODS.updateCheck, {
          feedUrl: typeof feedUrl === 'string' ? feedUrl : '',
          proxy: readProxy()
        })
        const result: { ok: boolean; available?: string; error?: string } = { ok: raw.ok === true }
        if (typeof raw.available === 'string') result.available = raw.available
        if (typeof raw.error === 'string') result.error = raw.error
        return result
      },
      async download() {
        await requireUpdateProvider('update.download')
        const raw = await callUpdateMain('update.download', HOST_MAIN_METHODS.updateDownload, {
          proxy: readProxy()
        })
        const result: { ok: boolean; error?: string } = { ok: raw.ok === true }
        if (typeof raw.error === 'string') result.error = raw.error
        return result
      },
      async install(opts) {
        const providerFeedUrl = await requireUpdateProvider('update.install')
        if (opts?.force !== true) {
          // v1：非 force 只等 `installUpdate()`（quitAndInstall），回值固定 `{ok:true}`
          await callUpdateMain('update.install', HOST_MAIN_METHODS.updateInstall, {
            force: false,
            proxy: readProxy()
          })
          return { ok: true }
        }
        // 强制重装/降级：优先用调用方给的 feedUrl，否则回落到提供者 manifest 里声明的 feedUrl
        const requested =
          typeof opts.feedUrl === 'string' && opts.feedUrl !== '' ? opts.feedUrl : undefined
        const feedUrl = requested ?? providerFeedUrl
        if (feedUrl === undefined) {
          return {
            ok: false,
            error:
              '强制重装需要更新源：请传入 feedUrl，或在 manifest 声明 contributes.updater.feedUrl'
          }
        }
        const raw = await callUpdateMain('update.install', HOST_MAIN_METHODS.updateInstall, {
          force: true,
          feedUrl,
          proxy: readProxy(),
          reason: 'user'
        })
        const result: { ok: boolean; version?: string; error?: string } = { ok: raw.ok === true }
        if (typeof raw.version === 'string') result.version = raw.version
        if (typeof raw.error === 'string') result.error = raw.error
        return result
      }
    }

    /* ------------------------------ 事件总线（on / emit） ------------------------------ */

    const on: ExtensionActivationApi['on'] = (event, listener) => {
      if (typeof event !== 'string' || event === '') {
        throw new Error('on 的事件名必须是非空字符串')
      }
      if (typeof listener !== 'function') throw new Error('on 的 listener 必须是函数')
      const set = busListeners.get(event) ?? new Set<(...args: unknown[]) => void>()
      set.add(listener)
      busListeners.set(event, set)
      const off = (): void => {
        const current = busListeners.get(event)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) busListeners.delete(event)
      }
      state.busCleanups.push(off)
      return { dispose: off }
    }

    const emitBus: ExtensionActivationApi['emit'] = (event, ...args) => {
      if (typeof event !== 'string' || event === '') {
        throw new Error('emit 的事件名必须是非空字符串')
      }
      const set = busListeners.get(event)
      if (!set) return
      for (const listener of [...set]) {
        try {
          listener(...args)
        } catch (error) {
          // 订阅者抛错不能打断其它订阅者（与 v1 的 Cordis 事件语义一致，但要留痕）
          extLog('error', `事件 ${event} 的订阅者抛错`, toErrorMessage(error))
        }
      }
    }

    /* ------------------------------ dispose ------------------------------ */

    let extensionDisposed = false
    const disposeExtension = (): void => {
      if (extensionDisposed) return
      extensionDisposed = true
      if (!disposed && rendererPort) {
        // 逐个撤掉本扩展在渲染侧注册的东西（幂等：渲染侧对这些 op 都是"删不到就算了"）
        try {
          emit(EH_EVENT_CHANNELS.statusBar, {
            v: UI_PLANE_PAYLOAD_VERSION,
            kind: 'disposeExtension',
            extId
          })
          for (const viewId of [...state.treeProviders.keys()]) {
            emit(EH_EVENT_CHANNELS.views, {
              v: UI_PLANE_PAYLOAD_VERSION,
              kind: 'treeProvider',
              op: 'dispose',
              extId,
              viewId
            })
          }
          for (const command of [...commands.keys()]) {
            if (commands.get(command)?.extId !== extId) continue
            commands.delete(command)
            emit(EH_EVENT_CHANNELS.commands, {
              v: UI_PLANE_PAYLOAD_VERSION,
              op: 'dispose',
              extId,
              command
            })
          }
          // EH-B3b-2：输出通道也归本扩展，停用即让渲染侧整批拆掉（否则底部面板会留下僵尸通道）
          emit(UI_PLANE_EVENT_CHANNELS.output, {
            v: UI_PLANE_PAYLOAD_VERSION,
            op: 'disposeExtension',
            extId
          })
        } catch (error) {
          extLog('warn', `停用 ${extId} 时清理渲染侧注册失败`, toErrorMessage(error))
        }
      }
      // 宿主侧状态一律清干净（无论有没有渲染侧端口）
      for (const [command, entry] of [...commands]) {
        if (entry.extId === extId) commands.delete(command)
      }
      // 事件总线订阅：逐个退订（否则扩展被停用后仍会收到别人 emit 的事件）
      for (const off of state.busCleanups.splice(0)) {
        try {
          off()
        } catch {
          // 退订本身不该抛；抛了也不影响后续清理
        }
      }
      state.settingsListeners.clear()
      state.themeListeners.clear()
      state.localeListeners.clear()
      state.treeProviders.clear()
      state.statusBarItems.clear()
      state.appMessageHandler = null
      extensions.delete(extId)
    }

    return {
      statusBar,
      navbar,
      views,
      settings,
      theme,
      i18n,
      app,
      on,
      emit: emitBus,
      registerCommand,
      executeCommand: executeCommandForExt,
      ui,
      output,
      update,
      dispose: disposeExtension
    }
  }

  // 构造时就挂上端口（生产：`init` 处理过程中建 hub，端口已在手；测试：直接注入假端口）。
  // 挂 `onmessage` 即隐式 `start()`，因此比 hub 更早到达的渲染侧快照不会丢。
  attachRendererPort(options.rendererPort ?? null)

  return {
    attachRendererPort,
    hasRendererPort: (): boolean => rendererPort !== null,
    sentCount: (): number => sent,
    commandCount: (): number => commands.size,
    handleRendererMessage,
    forExtension,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const state of [...extensions.values()]) {
        state.settingsListeners.clear()
        state.themeListeners.clear()
        state.localeListeners.clear()
        state.treeProviders.clear()
        state.statusBarItems.clear()
        state.appMessageHandler = null
      }
      extensions.clear()
      commands.clear()
      busListeners.clear()
      rpc.dispose('宿主数据面已关闭')
      // EH-B3b-2：在途的宿主 → 渲染侧请求全部以 EH_CANCELLED 结算（不重放，见协议层 cancel 注释）；
      // 进度会话跟着一起清（它们的 Promise 由 `client` 的 reject 或 task 自己收尾）。
      client.rejectAll('EH_CANCELLED', '扩展宿主正在退出，在途的界面请求已取消')
      progressSessions.clear()
      try {
        rendererPort?.close?.()
      } catch {
        // 端口可能已随进程退出失效：关闭是尽力而为
      }
      rendererPort = null
    }
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 进程内共享 hub                                                                                 */
/* -------------------------------------------------------------------------------------------- */

let sharedHub: UiPlaneHub | null = null

/**
 * 取进程内共享的数据面 hub（**唯一实例**：命令表、事件总线、设置缓存都必须是同一个）。
 *
 * 为什么共享：`executeCommand` 要能跨扩展执行（v1 的 `registry.commands` 也是一张全局表），
 * `on`/`emit` 是进程内事件总线，设置/主题缓存也只该有一份。每个扩展各造一个 hub 会让这三样
 * 各自成孤岛。
 */
export function getSharedUiPlaneHub(options: UiPlaneHubOptions = {}): UiPlaneHub {
  if (!sharedHub) {
    sharedHub = createUiPlaneHub(options)
    sharedHub.attachRendererPort(options.rendererPort ?? null)
    return sharedHub
  }
  sharedHub.attachRendererPort(options.rendererPort ?? null)
  return sharedHub
}

/** 丢掉共享 hub（**只给测试**：vitest 同一进程里会反复建宿主） */
export function resetSharedUiPlaneHub(): void {
  sharedHub?.dispose()
  sharedHub = null
}

/* -------------------------------------------------------------------------------------------- */
/* 小工具                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** 未知值 → 普通对象（`asRecord` 在宿主里被大量用到，缺省给空对象而不是 null） */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : ({} as Record<string, unknown>)
}

/**
 * 浅拷贝并丢掉 `undefined` 值字段（EH-B3b-2）。
 *
 * 为什么必须做：`checkSerializable` **拒绝 `undefined`**（它过不了 JSON 表达，见协议层注释），
 * 而 `ui.*` 的 opts / items / form field 全是可选字段——扩展写 `showQuickPick(items, { title })`
 * 时若 `title` 恰好是 `undefined`，最普通的调用就会在跨进程时抛 `EH_UNSERIALIZABLE`。
 * v1 走 IPC（structured clone 会把 `undefined` 字段照传）不会因此报错，所以这里做等价归一：
 * **"没给" 与 "给的是 undefined" 都记成"没给"**。
 */
function compactShallow(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof value !== 'object' || value === null) return out
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue
    out[key] = child
  }
  return out
}

/** toast 类型归一（v1 的 `uiStore.showToast` 默认 `info`；非法值回落 `info`） */
function normalizeToastType(value: unknown): 'info' | 'warning' | 'error' | 'success' {
  return value === 'warning' || value === 'error' || value === 'success' ? value : 'info'
}

/** 逐字段通知订阅者（单个订阅者抛错不能打断其它订阅者） */
function notify<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value)
    } catch {
      // 订阅者是扩展代码：抛错已由 runSafely/日志覆盖，这里只保证不连锁
    }
  }
}

/** 两份设置的差异键（新增/删除/值不同都算；顺序 = 旧键序 + 新增键） */
function diffKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const changed: string[] = []
  for (const key of Object.keys(before)) {
    if (!(key in after) || !sameValue(before[key], after[key])) changed.push(key)
  }
  for (const key of Object.keys(after)) {
    if (!(key in before)) changed.push(key)
  }
  return changed
}

/** 设置值比较（可能是对象/数组） */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/**
 * `statusBar.createItem` 的 init 去 `undefined`。
 *
 * 为什么必须去：`checkSerializable` 拒绝 `undefined`（它过不了 JSON 表达），而 `createItem({})` 的
 * 每个字段都是可选的——不清理就会让"最普通的调用"在跨进程时抛 `EH_UNSERIALIZABLE`。
 */
function compactInit(
  init:
    | {
        text?: string
        tooltip?: string
        alignment?: 'left' | 'right'
        priority?: number
      }
    | undefined
): { text?: string; tooltip?: string; alignment?: 'left' | 'right'; priority?: number } {
  const out: { text?: string; tooltip?: string; alignment?: 'left' | 'right'; priority?: number } =
    {}
  if (!init) return out
  if (typeof init.text === 'string') out.text = init.text
  if (typeof init.tooltip === 'string') out.tooltip = init.tooltip
  if (init.alignment === 'left' || init.alignment === 'right') out.alignment = init.alignment
  if (typeof init.priority === 'number' && Number.isFinite(init.priority))
    out.priority = init.priority
  return out
}

/** 读扩展清单（数据面关心的两块）；读不到/畸形 ⇒ 空清单 + 一条 warn */
function loadManifestText(options: UiPlaneExtensionOptions): UiPlaneManifest {
  const read =
    options.readManifest ??
    ((dir: string): string => readFileSync(join(dir, 'manifest.json'), 'utf8'))
  try {
    return parseUiPlaneManifest(read(options.extensionDir))
  } catch (error) {
    options.log(
      'warn',
      `读取扩展清单失败，i18n 初始文案与命令标题为空（${join(options.extensionDir, 'manifest.json')}）`,
      toErrorMessage(error)
    )
    return emptyManifest()
  }
}

/** 确保目录存在（memento 的 `state/`；导出给装配处用，避免 apiFactory 再 import node:fs） */
export function ensureStateDir(extensionDataDir: string): string {
  const dir = join(extensionDataDir, 'state')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 日志级别类型转出（消费方不必再 import 协议模块） */
export type UiPlaneLogLevel = LogLevel
