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
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AppRegistration,
  ExtensionActivationApi,
  Memento,
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
  type EventEnvelope,
  type LogLevel,
  type RequestEnvelope
} from '../../shared/extensionHostProtocol'
import { toErrorMessage } from '../errors'
import type { EnvelopeSink, HostLogger } from '../log'
import { unwrapParentPortMessage, type HostRendererPortLike } from '../port'
import { RpcServer } from '../rpc'

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
  appMessage: 'ui.appMessage'
} as const

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
}

/** hub 的构造参数 */
export interface UiPlaneHubOptions {
  /** `host-renderer` 的 port1（缺省 ⇒ 所有"要送到渲染侧"的调用抛 `EH_NOT_READY`） */
  rendererPort?: HostRendererPortLike | null
  /** hub 级日志（缺省丢弃；装配处会传宿主 logger） */
  log?: HostLogger
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
      statusSeq: 0
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
