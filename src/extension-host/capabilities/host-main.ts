/**
 * **主进程类能力族**（EH-B3a）：`window` / `overlay` / `dialog` / `shell` / `notification` /
 * `secrets` / `update.getVersion` / `update.onEvent` / `proxy.get`。
 *
 * 这些能力的共同点（ADR-0026 决策 3）：**宿主进程没有对应的 Electron 模块**，只能在 main 里做，
 * 因此实现方式是「宿主发 RPC → main 用既有模块执行 → 结果回宿主」。与本卡并列的
 * `capabilities/io.ts`（EH-B1，`HostMainBridge` 的定义也在那里）、`ipc.ts` / `python.ts` /
 * `sqlite.ts`（EH-B2）同构：文件按能力族切分，宿主侧只做装配与语义翻译，**不 import electron**
 * （`extension-host.js` 里出现 `require('electron')` 会直接起不来）。
 *
 * ## 宿主内部 RPC 一览（方法名集中在 {@link HOST_MAIN_METHODS}，main 与宿主 import 同一份常量）
 *
 * | method | 入参 | 返回 |
 * | --- | --- | --- |
 * | `host.window.minimize` | 无 | `{ ok, error? }` |
 * | `host.window.toggle-maximize` | 无 | `{ ok, error? }` |
 * | `host.window.close` | 无 | `{ ok, error? }` |
 * | `host.window.is-maximized` | 无 | `{ ok, value?, error? }` |
 * | `host.window.is-focused` | 无 | `{ ok, value?, error? }` |
 * | `host.window.set-progress-bar` | `{ progress: number \| null }` | `{ ok, error? }` |
 * | `host.overlay.create` | `{ extId, request }` | `OverlayResult`（与 v1 逐字一致） |
 * | `host.overlay.destroy` | `{ extId, id }` | `OverlayResult` |
 * | `host.overlay.set-mouse-through` | `{ extId, id, through }` | `OverlayResult` |
 * | `host.overlay.set-position` | `{ extId, id, x, y }` | `OverlayResult` |
 * | `host.dialog.open` | `{ opts }` | `DialogOpenResult` |
 * | `host.dialog.save` | `{ opts }` | `{ ok, filePath?, canceled?, error? }` |
 * | `host.dialog.message` | `{ opts }` | `{ ok, response?, error? }` |
 * | `host.shell.open-external` | `{ url }` | `{ ok, error? }` |
 * | `host.shell.open-path` | `{ path }` | `{ ok, error? }` |
 * | `host.notification.show` | `{ extId, opts: { title, body?, icon? } }` | `{ ok, id?, error? }` |
 * | `host.secrets.get` | `{ extId, key }` | `{ ok, value?, error? }` |
 * | `host.secrets.set` | `{ extId, key, value }` | `{ ok, error? }` |
 * | `host.secrets.delete` | `{ extId, key }` | `{ ok, error? }` |
 * | `host.update.version` | 无 | `{ ok, value?, error? }` |
 * | `host.proxy.get` | 无 | `{ ok, value?, error? }` |
 * | `host.event.poll` | `{ extId, cursor: number \| null }` | `{ cursor, events: [{ channel, payload }] }` |
 *
 * **返回值口径**：`res.result` 就是**扩展 API 的返回值形状**（`{ok:false}` 的能力保持 `{ok:false}`，
 * 见 `src/renderer/src/core/host.ts` 的既有分类），宿主侧不再二次包装——于是"哪种能力抛错、哪种回值"
 * 与 v1 一一对应，不需要在每个能力上重新判断。`err` 信封只在链路/协议层出问题（超时、取消）时出现。
 *
 * ## `extId` 一律由宿主绑定（overlay 的作用域安全）
 *
 * v1 的 `overlay` 是"闭包绑 `extId`"（`core/host.ts` 的 `buildOverlayApi`），main 的 4 个函数
 * 第一参数就是 `extId`，`overlays` 表按 `overlayKey(extId, id)` 寻址、越权明确拒绝
 * （`[overlay] 越权被拒`）。宿主侧把 `options.extId` 绑进每个请求的 `extId` 字段，**扩展侧 API
 * 里根本没有 extId 参数**，因此扩展无法指定别人的 id；越权判定完全复用 main 里那一份，
 * 不在这里抄第二份（抄一份就是让安全语义漂一份）。
 *
 * ## main → 宿主的事件：**轮询降级**（R65）
 *
 * 有 3 条能力是"订阅"语义：`window.onFocusChanged`、`update.onEvent`、`notification.show` 的
 * `onClick`（回调本身**不出宿主**，宿主只把 id 送出去）。按 ADR-0026 它们该走 main → 宿主的推送，
 * 但**推送需要一个协议信封，本卡没有**（`runtime.ts` 明确丢弃 `event` 信封，且本卡不允许改
 * runtime），所以这里用一条**游标轮询**（`host.event.poll`）降级替代：
 * - 事件源被隔离在窄接口 {@link HostEventSource}（`start(dispatch)` / `stop()`）后面，
 *   **能力层不直接调轮询**；将来换成长连接推送时只替换这一层；
 * - **有订阅者才轮询**：第一个订阅者 `start()`，最后一个退订（或 `dispose`）`stop()`；
 * - **只取新增事件**：游标为 `null` 的首次调用只回当前游标（不回放历史），因此新订阅者
 *   不会被历史事件重复触发（尤其是 `onClick` 的一次性语义）。
 *
 * 这是**实现方式降级，不是权限放宽**：轮询只取 main 已经决定要发给该扩展的事件；技术债记在
 * 回执里（给协议加 `mainEvent` 信封，`PROTOCOL_VERSION` 1→2）。
 *
 * ## 失败语义（照抄 v1，不自行判断）
 *
 * - `window.*`：v1 里"没有窗口就静默 no-op"，宿主版改为**明确中文错误**（能自查，不会静默）；
 * - `overlay` / `dialog` / `shell` / `notification` / `update`：保持 `{ok:false,error}`**回值**；
 * - `secrets`：v1 是 `{ok:false}` → **抛错**（`core/host.ts` 的 `if (!r.ok) throw`），照抄；
 * - 桥没接上（`hostMain` 缺省）：抛 `EH_INTERNAL` + 「需要主进程 IPC」，与 `clipboard` 同一风格；
 * - RPC 超时/取消：`EhProtocolError` **原样抛**（保留 `EH_TIMEOUT` / `EH_CANCELLED` 语义）。
 *
 * ## 本卡**没有**实现的两族（已知边界）
 *
 * - `update.resolveFeed` / `check` / `download` / `install`：门控是"当前生效的更新提供者"，
 *   该选择只存在于渲染进程（`stateStore` 的 `update.provider`，见 `updaterStore.isActive`），
 *   main 拿不到；按 R64 **留显式桩**（不 fail-closed，语义更诚实），等 EH-B3b 由渲染侧判定。
 * - `ui.*` / `output.createChannel`：渲染在**渲染进程**（`uiStore` / `outputStore`），main 没有
 *   UI 渲染能力；按 R67 归 B3b 的 host-renderer 通道。
 */
import type { Disposable } from '../../api/runtime'
import type { UpdateEvent } from '../../api/shared'
import type { ExtensionActivationApi } from '../../api/types'
import { EhProtocolError } from '../../shared/extensionHostProtocol'
import { normalizeProxyConfig, type ProxyConfigInput } from '../../shared/proxyConfig'
import type {
  CreateOverlayRequest,
  DialogOpenOptions,
  DialogOpenResult,
  OverlayResult,
  ProxyConfig
} from '../../shared/types'
import { toErrorMessage } from '../errors'
import type { HostLogger } from '../log'
import type { SafeRunner } from '../safety'
import { unrefTimer } from '../timers'
import type { HostMainBridge } from './io'

/* -------------------------------------------------------------------------------------------- */
/* 常量：宿主 ↔ main 的方法名（**唯一真相**，main 与宿主 import 同一份）                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * 宿主 → main 的全部方法名。
 *
 * 为什么用一张表而不是散落的字符串常量：main 侧（`src/main/index.ts`）的 `registerMethod()`
 * 必须与宿主侧的 `request()` 一一对上，两边各写一遍字符串迟早漂（漂了的表现是"未知 RPC method"，
 * 排查时看起来像宿主没实现，实际是名字打错）。两边 import 同一个对象，`test/extension-host-host-main.test.ts`
 * 还有一条**源码门禁**逐个 key 断言 main 里确实注册了它。
 */
export const HOST_MAIN_METHODS = {
  windowMinimize: 'host.window.minimize',
  windowToggleMaximize: 'host.window.toggle-maximize',
  windowClose: 'host.window.close',
  windowIsMaximized: 'host.window.is-maximized',
  windowIsFocused: 'host.window.is-focused',
  windowSetProgressBar: 'host.window.set-progress-bar',
  overlayCreate: 'host.overlay.create',
  overlayDestroy: 'host.overlay.destroy',
  overlaySetMouseThrough: 'host.overlay.set-mouse-through',
  overlaySetPosition: 'host.overlay.set-position',
  dialogOpen: 'host.dialog.open',
  dialogSave: 'host.dialog.save',
  dialogMessage: 'host.dialog.message',
  shellOpenExternal: 'host.shell.open-external',
  shellOpenPath: 'host.shell.open-path',
  notificationShow: 'host.notification.show',
  secretsGet: 'host.secrets.get',
  secretsSet: 'host.secrets.set',
  secretsDelete: 'host.secrets.delete',
  updateVersion: 'host.update.version',
  proxyGet: 'host.proxy.get',
  eventsPoll: 'host.event.poll'
} as const

/** 一个具体的方法名（`host.window.minimize` 这种联合值） */
export type HostMainMethod = (typeof HOST_MAIN_METHODS)[keyof typeof HOST_MAIN_METHODS]

/**
 * main → 宿主的事件 channel（`host.event.poll` 的 `payload.channel`）。
 *
 * 命名与 RPC 方法名一样统一带 `host.` 前缀：这条通道**不进扩展 API 面**，扩展看到的是
 * `api.window.onFocusChanged` / `api.update.onEvent` / `notification.show({onClick})`。
 */
export const HOST_MAIN_EVENT_CHANNELS = {
  /** 主窗口聚焦状态变化；`payload = { focused: boolean }`（全局事件，所有订阅者都收到） */
  windowFocus: 'host.window.focus',
  /** 更新事件；`payload = UpdateEvent`（全局事件） */
  updateEvent: 'host.update.event',
  /** 通知被点击；`payload = { notifId, title }`（**按 extId 定向**） */
  notificationClick: 'host.notification.click'
} as const

/** 一个事件 channel 名 */
export type HostMainEventChannel =
  (typeof HOST_MAIN_EVENT_CHANNELS)[keyof typeof HOST_MAIN_EVENT_CHANNELS]

/**
 * 事件轮询间隔（毫秒）。
 *
 * 250ms 是"人感觉不到延迟"与"空闲时也不吵"的折中：`onClick` / `onFocusChanged` 都是交互反馈，
 * 超过 ~300ms 就能被感知；而 250ms 一条极小的 RPC 对宿主与 main 都是噪声级别。
 * 只在**有订阅者**时才起这个定时器（见 {@link HostEventSource}）。
 */
export const DEFAULT_EVENT_POLL_INTERVAL_MS = 250

/**
 * `proxy.get` 快照的默认有效期（毫秒）。
 *
 * 1 秒是"配置改了几乎立刻生效"与"读代理不会每读一次发一条 RPC"的折中：`get()` 是同步 API，
 * 只能读快照（见 `HostMainCapabilitiesOptions.proxyCacheTtlMs`）。
 */
export const DEFAULT_PROXY_CACHE_TTL_MS = 1000

/* -------------------------------------------------------------------------------------------- */
/* main → 宿主的事件源（R65：降级实现隔离在这一层）                                                */
/* -------------------------------------------------------------------------------------------- */

/** 一条来自 main 的事件 */
export interface HostEvent {
  channel: string
  payload: unknown
}

/**
 * main → 宿主的**事件源窄接口**（R65 要求 1）。
 *
 * 能力层只认这两个方法：订阅到第一个监听者时 `start(dispatch)`，最后一个监听者退订时 `stop()`。
 * 将来把轮询换成真正的推送（协议加 `mainEvent` 信封）时，只需换掉这个接口的实现——能力层
 * 的 `subscribe()` 调用点一行不用改。
 */
export interface HostEventSource {
  /** 开始投递（幂等：重复调用不重复起定时器） */
  start(dispatch: (event: HostEvent) => void): void
  /** 停止投递（幂等；不清游标，重新 start 不重放） */
  stop(): void
}

/** 定时器（单测注入假时钟，才能断言"没有订阅者时一次都没轮询"） */
export interface EventPollTimers {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** 生产定时器：`setInterval` + `unref`（不拖住宿主退出） */
export const systemEventPollTimers: EventPollTimers = {
  setInterval(callback: () => void, ms: number): unknown {
    const handle = setInterval(callback, ms)
    unrefTimer(handle)
    return handle
  },
  clearInterval(handle: unknown): void {
    clearInterval(handle as ReturnType<typeof setInterval>)
  }
}

/** `createPollingEventSource` 的参数 */
export interface PollingEventSourceOptions {
  /** 宿主 → main 通道（与能力共用同一个 `RpcClient`） */
  bridge: HostMainBridge
  /** 调用方扩展 id（`host.event.poll` 只回该扩展的私事件 + 全局事件） */
  extId: string
  /** 宿主日志 */
  log: HostLogger
  /** 轮询间隔（缺省 {@link DEFAULT_EVENT_POLL_INTERVAL_MS}） */
  intervalMs?: number
  /** 定时器（单测注入） */
  timers?: EventPollTimers
}

/** 轮询事件源（额外暴露 `pollNow` / `isRunning` 给单测与诊断） */
export interface PollingEventSource extends HostEventSource {
  /** 立刻拉一次（测试用；生产由 {@link EventPollTimers} 驱动） */
  pollNow(): Promise<void>
  /** 当前是否在轮询（**没有订阅者时必须为 `false`**） */
  isRunning(): boolean
  /** 当前游标（`null` = 还没定位起点） */
  cursor(): number | null
  /** 永久关闭（宿主停用该扩展时调用；幂等） */
  dispose(): void
}

/** 把 `host.event.poll` 的返回值收成结构；无法识别返回 `null`（不抛错，轮询不该因一次坏包停掉） */
function parsePollResult(raw: unknown): { cursor: number; events: HostEvent[] } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as { cursor?: unknown; events?: unknown }
  const cursor = record.cursor
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) return null
  const events: HostEvent[] = []
  if (Array.isArray(record.events)) {
    for (const item of record.events) {
      if (typeof item !== 'object' || item === null) continue
      const event = item as { channel?: unknown; payload?: unknown }
      if (typeof event.channel !== 'string' || event.channel.trim() === '') continue
      events.push({ channel: event.channel, payload: event.payload })
    }
  }
  return { cursor, events }
}

/**
 * 构造**游标轮询**事件源（R65 的降级实现）。
 *
 * 语义细节：
 * - 首次 poll 传 `cursor: null` ⇒ main **只回当前游标、不回事件**（新订阅者不重放历史）；
 * - 之后每次只取 `seq > cursor` 的新事件，游标随响应推进；
 * - 上一次还没回来时不再发新的（`inflight` 去重）：慢 main 不该被轮询打爆；
 * - 失败**只 warn 一次**（成功一次后重置，便于发现"好了又坏"），然后继续按间隔重试；
 * - `stop()` 不清游标：退订后再订阅不会重放已经看过的事件。
 */
export function createPollingEventSource(options: PollingEventSourceOptions): PollingEventSource {
  const timers = options.timers ?? systemEventPollTimers
  const intervalMs = options.intervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS
  let handle: unknown = null
  let dispatch: ((event: HostEvent) => void) | null = null
  let cursor: number | null = null
  let inflight = false
  let warned = false
  let disposed = false

  const pollNow = async (): Promise<void> => {
    if (disposed || inflight) return
    inflight = true
    try {
      const raw = await options.bridge.request(HOST_MAIN_METHODS.eventsPoll, {
        extId: options.extId,
        cursor
      })
      const parsed = parsePollResult(raw)
      if (parsed === null) {
        if (!warned) {
          warned = true
          options.log(
            'warn',
            `[${options.extId}] 宿主事件轮询返回了无法识别的结果，已忽略本次（下次继续）`
          )
        }
        return
      }
      warned = false
      cursor = parsed.cursor
      for (const event of parsed.events) {
        const target = dispatch
        if (target === null) break
        target(event)
      }
    } catch (error) {
      if (!warned) {
        warned = true
        options.log(
          'warn',
          `[${options.extId}] 宿主事件轮询失败（main→宿主的推送需协议信封，本卡用轮询降级），` +
            `将按 ${intervalMs}ms 继续重试：${toErrorMessage(error)}`
        )
      }
    } finally {
      inflight = false
    }
  }

  return {
    start(next: (event: HostEvent) => void): void {
      dispatch = next
      if (handle !== null || disposed) return
      handle = timers.setInterval((): void => {
        void pollNow()
      }, intervalMs)
      // 立刻拉一次：第一跳只定位游标（不回放历史），第二跳开始就有新增事件
      void pollNow()
    },
    stop(): void {
      if (handle !== null) {
        timers.clearInterval(handle)
        handle = null
      }
      dispatch = null
    },
    pollNow,
    isRunning(): boolean {
      return handle !== null
    },
    cursor(): number | null {
      return cursor
    },
    dispose(): void {
      disposed = true
      dispatch = null
      if (handle !== null) {
        timers.clearInterval(handle)
        handle = null
      }
    }
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 事件分发（订阅者计数 → 起停事件源）                                                             */
/* -------------------------------------------------------------------------------------------- */

/** 事件分发器：按 channel 多播，并在"0 ↔ 有订阅者"时起停事件源 */
interface HostEventHub {
  subscribe(channel: string, listener: (event: HostEvent) => void): () => void
  readonly size: number
  isPolling(): boolean
  dispose(): void
}

/**
 * 造一个事件分发器。
 *
 * `source` 为 `null`（桥没接上）时订阅仍然成立，只是永远不会触发——与 v1 一致：
 * 订阅类 API 本来就不抛错，拿不到事件是环境问题（桥没接线），不是调用错误。
 */
function createHostEventHub(
  source: HostEventSource | null,
  log: HostLogger,
  extId: string
): HostEventHub {
  const listeners = new Map<string, Set<(event: HostEvent) => void>>()
  let disposed = false
  /** 事件源是否已被本 hub 启动（`isPolling` 的真相；不依赖具体实现自报） */
  let started = false

  const total = (): number => {
    let count = 0
    for (const set of listeners.values()) count += set.size
    return count
  }

  const dispatch = (event: HostEvent): void => {
    if (disposed) return
    const set = listeners.get(event.channel)
    if (!set) return
    // 遍历副本：监听器里可能退订（`onClick` 是一次性的）
    for (const listener of [...set]) {
      if (disposed) return
      if (!set.has(listener)) continue
      try {
        listener(event)
      } catch (error) {
        // 扩展回调抛错只记日志：一个订阅者炸掉不该让整条轮询停摆
        log(
          'warn',
          `[${extId}] 宿主事件回调抛错（channel=${event.channel}）`,
          toErrorMessage(error)
        )
      }
    }
  }

  return {
    subscribe(channel: string, listener: (event: HostEvent) => void): () => void {
      if (disposed) return (): void => {}
      const wasEmpty = total() === 0
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
      // 第一个订阅者：起轮询（R65 要求 2）
      if (wasEmpty && source !== null) {
        source.start(dispatch)
        started = true
      }
      let active = true
      return (): void => {
        if (!active) return
        active = false
        const current = listeners.get(channel)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(channel)
        // 最后一个订阅者退订：停轮询（不空转）
        if (total() === 0 && source !== null) {
          source.stop()
          started = false
        }
      }
    },
    get size(): number {
      return total()
    },
    isPolling(): boolean {
      return started
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      listeners.clear()
      if (source !== null) {
        source.stop()
        started = false
      }
    }
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 返回值的读取（把 main 回来的任意形状收成具体类型，不认识就回中文错误）                             */
/* -------------------------------------------------------------------------------------------- */

/** `{ ok, error? }` 的读取结果 */
interface OkResult {
  ok: boolean
  error?: string
}

/** `{ ok, value?, error? }` 的读取结果 */
type ValueResult = { ok: true; value: unknown } | { ok: false; error: string }

/** 未知值是否是普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读 `{ ok, error? }`；形状不认识按失败处理（不猜成功） */
function readOkResult(raw: unknown, action: string): OkResult {
  if (!isRecord(raw)) {
    return { ok: false, error: `${action}：主进程返回了无法识别的结果（不是 {ok} 对象）` }
  }
  const ok = raw.ok === true
  const error = typeof raw.error === 'string' && raw.error !== '' ? raw.error : undefined
  if (!ok) return { ok: false, error: error ?? `${action} 失败（主进程未给出原因）` }
  return error === undefined ? { ok: true } : { ok: true, error }
}

/** 读 `{ ok, value?, error? }` */
function readValueResult(raw: unknown, action: string): ValueResult {
  if (!isRecord(raw)) {
    return { ok: false, error: `${action}：主进程返回了无法识别的结果（不是 {ok} 对象）` }
  }
  if (raw.ok !== true) {
    const error = typeof raw.error === 'string' && raw.error !== '' ? raw.error : undefined
    return { ok: false, error: error ?? `${action} 失败（主进程未给出原因）` }
  }
  return { ok: true, value: raw.value }
}

/**
 * 读 overlay 结果：**原样返回**（v1 的 `OverlayResult` 就是 `{ok, error?, position?}`）。
 * 形状不认识时补一个中文错误而不是抛错——overlay 四方法是"回值"型能力（v1 从不抛）。
 */
function readOverlayResult(raw: unknown, action: string): OverlayResult {
  if (!isRecord(raw)) {
    return { ok: false, error: `${action}：主进程返回了无法识别的结果（不是 {ok} 对象）` }
  }
  const result: OverlayResult = { ok: raw.ok === true }
  if (typeof raw.error === 'string' && raw.error !== '') result.error = raw.error
  const position = raw.position
  if (isRecord(position) && typeof position.x === 'number' && typeof position.y === 'number') {
    result.position = { x: position.x, y: position.y }
  }
  if (!result.ok && result.error === undefined) {
    result.error = `${action} 失败（主进程未给出原因）`
  }
  return result
}

/** 通知返回：`{ ok, id?, error? }`（`id` 用于把点击回调绑到这条通知上） */
function readNotificationResult(
  raw: unknown,
  action: string
): {
  ok: boolean
  id?: number
  error?: string
} {
  const base = readOkResult(raw, action)
  if (!base.ok) return { ok: false, error: base.error }
  const id = isRecord(raw) ? raw.id : undefined
  return typeof id === 'number' && Number.isInteger(id) ? { ok: true, id } : { ok: true }
}

/* -------------------------------------------------------------------------------------------- */
/* 工厂                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** `update` 里由本卡实现的两项（其余 4 项是显式桩，见 `apiFactory`） */
export interface HostMainUpdateCapabilities {
  getVersion(): Promise<string>
  onEvent(callback: (event: UpdateEvent) => void): Disposable
}

/** `createHostMainCapabilities` 的参数（全部由宿主注入，本函数是纯装配） */
export interface HostMainCapabilitiesOptions {
  /** 扩展 id（**绑定**到每个请求上：overlay/secrets/notification 的作用域就靠它） */
  extId: string
  /** 宿主日志 */
  log: HostLogger
  /** 宿主 → main 通道（缺省 = 未接线：所有能力抛 EH_INTERNAL + 「需要主进程 IPC」） */
  hostMain?: HostMainBridge
  /**
   * main → 宿主的事件源（缺省由 `hostMain` 现造一个轮询实现）。
   * 单测注入假件即可精确断言"订阅即起、退订即停、只取新增"。
   */
  eventSource?: HostEventSource
  /** 轮询间隔（毫秒；只在缺省事件源时生效） */
  eventPollIntervalMs?: number
  /** 轮询定时器（毫秒；只在缺省事件源时生效，单测注入假时钟） */
  eventPollTimers?: EventPollTimers
  /** 隔离执行壳（订阅回调经它跑：扩展回调抛错只上报，不升级成宿主级异常） */
  runSafely?: SafeRunner
  /**
   * `proxy.get` 的缓存有效期（毫秒，缺省 {@link DEFAULT_PROXY_CACHE_TTL_MS}）。
   *
   * 这个能力在声明里是**同步**的，而 RPC 是异步的——只能读快照。TTL 决定"最多能有多旧"：
   * 过期后的第一次 `get()` 会顺手发起后台刷新（下一次读就到新值）。单测传 `0` 可让每次读都刷新。
   */
  proxyCacheTtlMs?: number
}

/** 主进程类能力族 */
export interface HostMainCapabilities {
  readonly window: ExtensionActivationApi['window']
  readonly overlay: ExtensionActivationApi['overlay']
  readonly dialog: ExtensionActivationApi['dialog']
  readonly shell: ExtensionActivationApi['shell']
  readonly notification: ExtensionActivationApi['notification']
  readonly secrets: ExtensionActivationApi['secrets']
  readonly update: HostMainUpdateCapabilities
  readonly proxy: ExtensionActivationApi['proxy']
  /** 当前是否在轮询 main 事件（诊断/测试：**没有订阅者时必须为 `false`**） */
  isPolling(): boolean
  /** 关闭全部订阅、停轮询、回收本扩展创建过的 overlay（幂等） */
  dispose(): void
}

/**
 * 按扩展构造主进程类能力族。
 *
 * 输入全部由宿主注入（`extId` / `log` / `hostMain` / 事件源），本函数不含宿主状态，可单测。
 * 错误边界见文件头「失败语义」一节。
 */
export function createHostMainCapabilities(
  options: HostMainCapabilitiesOptions
): HostMainCapabilities {
  const extId = options.extId
  const log = options.log
  const bridge = options.hostMain

  const eventSource: HostEventSource | null =
    options.eventSource ??
    (bridge === undefined
      ? null
      : createPollingEventSource({
          bridge,
          extId,
          log,
          intervalMs: options.eventPollIntervalMs,
          timers: options.eventPollTimers
        }))
  const hub = createHostEventHub(eventSource, log, extId)

  /** 订阅集合（`dispose` 一次退干净；也用于 `onClick` 的一次性语义） */
  const subscriptions = new Set<() => void>()
  /** 本扩展创建过、尚未 destroy 的 overlay id（停用即回收，v1 语义） */
  const createdOverlays = new Set<string>()

  /* ------------------------------------ 通道与通用工具 ------------------------------------ */

  /** 取桥；没接线就抛明确中文错误（措辞与 `clipboard` 一致，便于按同一句 grep） */
  const requireBridge = (api: string, method: string): HostMainBridge => {
    if (bridge !== undefined) return bridge
    throw new EhProtocolError(
      'EH_INTERNAL',
      `${api} 需要主进程 IPC：宿主进程没有对应的 Electron 模块`,
      `缺桥：hostMain 未接线（需要 main 侧 ${method} 提供者 + runtime.ts 注入）`
    )
  }

  /**
   * 发一条宿主内部 RPC。
   *
   * `EhProtocolError`（超时 / 取消 / 链路断开）**原样抛**：那是"查询链路"的语义，
   * 不该被包装成"能力失败"，否则调用方无法区分"操作失败"与"对端没响应"。
   */
  const call = async (api: string, method: string, params: unknown = null): Promise<unknown> => {
    const target = requireBridge(api, method)
    try {
      return await target.request(method, params)
    } catch (error) {
      if (error instanceof EhProtocolError) throw error
      throw new Error(`${api} 失败：${toErrorMessage(error)}`)
    }
  }

  /** 订阅 + 登记（`dispose` 时一次退干净） */
  const trackSubscription = (off: () => void): (() => void) => {
    subscriptions.add(off)
    return (): void => {
      subscriptions.delete(off)
      off()
    }
  }

  /** 跑扩展回调：优先走隔离执行壳（抛错只上报），没有壳时退到 try/catch + 日志 */
  const runCallback = (task: () => void, phase: 'callback' | 'event'): void => {
    if (options.runSafely !== undefined) {
      void options.runSafely(extId, task, phase)
      return
    }
    try {
      task()
    } catch (error) {
      log('warn', `[${extId}] 订阅回调抛错（${phase}）`, toErrorMessage(error))
    }
  }

  /** 校验字符串参数（扩展侧参数错误一律抛中文错） */
  const requireText = (api: string, name: string, value: unknown): string => {
    const text = typeof value === 'string' ? value : ''
    if (text.trim() === '') {
      throw new Error(`${api} 的 ${name} 必须是非空字符串`)
    }
    return text
  }

  /* ---------------------------------------- window ---------------------------------------- */

  const windowApi: ExtensionActivationApi['window'] = {
    async minimize(): Promise<void> {
      const result = readOkResult(
        await call('window.minimize', HOST_MAIN_METHODS.windowMinimize),
        'window.minimize'
      )
      if (!result.ok) throw new Error(result.error)
    },
    async toggleMaximize(): Promise<void> {
      const result = readOkResult(
        await call('window.toggleMaximize', HOST_MAIN_METHODS.windowToggleMaximize),
        'window.toggleMaximize'
      )
      if (!result.ok) throw new Error(result.error)
    },
    async close(): Promise<void> {
      const result = readOkResult(
        await call('window.close', HOST_MAIN_METHODS.windowClose),
        'window.close'
      )
      if (!result.ok) throw new Error(result.error)
    },
    async isMaximized(): Promise<boolean> {
      const result = readValueResult(
        await call('window.isMaximized', HOST_MAIN_METHODS.windowIsMaximized),
        'window.isMaximized'
      )
      if (!result.ok) throw new Error(result.error)
      if (typeof result.value !== 'boolean') {
        throw new Error('window.isMaximized 失败：主进程没有返回布尔值')
      }
      return result.value
    },
    async setProgressBar(progress: number | null): Promise<void> {
      // 与 v1 的差别只有一处：`NaN`/`Infinity` 会被 Electron 当成"清空"或抛错（平台相关），
      // 这里明确拒绝；**合法数字越界仍按 v1 钳到 0~1**（钳位在 main，见 index.ts 的 handler）。
      if (progress !== null && (typeof progress !== 'number' || !Number.isFinite(progress))) {
        throw new Error('window.setProgressBar 的 progress 必须是 0~1 的有限数字或 null')
      }
      const result = readOkResult(
        await call('window.setProgressBar', HOST_MAIN_METHODS.windowSetProgressBar, { progress }),
        'window.setProgressBar'
      )
      if (!result.ok) throw new Error(result.error)
    },
    async isFocused(): Promise<boolean> {
      const result = readValueResult(
        await call('window.isFocused', HOST_MAIN_METHODS.windowIsFocused),
        'window.isFocused'
      )
      if (!result.ok) throw new Error(result.error)
      if (typeof result.value !== 'boolean') {
        throw new Error('window.isFocused 失败：主进程没有返回布尔值')
      }
      return result.value
    },
    onFocusChanged(callback: (focused: boolean) => void): Disposable {
      if (typeof callback !== 'function') {
        throw new Error('window.onFocusChanged 的 callback 必须是函数')
      }
      const off = trackSubscription(
        hub.subscribe(HOST_MAIN_EVENT_CHANNELS.windowFocus, (event): void => {
          const payload = event.payload
          const focused = isRecord(payload) ? payload.focused : undefined
          if (typeof focused !== 'boolean') return
          runCallback((): void => callback(focused), 'event')
        })
      )
      return { dispose: off }
    }
  }

  /* --------------------------------------- overlay --------------------------------------- */

  /**
   * overlay 四方法：`extId` 由本工厂绑定，扩展侧 API 没有这个参数。
   * 越权判定（`[overlay] 越权被拒`）**只在 main**：那里有真正的 `overlays` 归属表。
   */
  const overlayApi: ExtensionActivationApi['overlay'] = {
    async create(request: CreateOverlayRequest): Promise<OverlayResult> {
      const id = isRecord(request) && typeof request.id === 'string' ? request.id : ''
      // 先登记再发请求（v1 同序：create 是异步的，若扩展入口随后立刻抛错，dispose 仍能回收窗体）
      if (id !== '') createdOverlays.add(id)
      const result = readOverlayResult(
        await call('overlay.create', HOST_MAIN_METHODS.overlayCreate, { extId, request }),
        'overlay.create'
      )
      if (!result.ok && id !== '') createdOverlays.delete(id)
      return result
    },
    async destroy(id: string): Promise<OverlayResult> {
      const target = requireText('overlay.destroy', 'id', id)
      const result = readOverlayResult(
        await call('overlay.destroy', HOST_MAIN_METHODS.overlayDestroy, { extId, id: target }),
        'overlay.destroy'
      )
      // ok 覆盖"销毁成功"与"幂等：本就不存在"；越权被拒时不动别人的登记
      if (result.ok) createdOverlays.delete(target)
      return result
    },
    async setMouseThrough(id: string, through: boolean): Promise<OverlayResult> {
      const target = requireText('overlay.setMouseThrough', 'id', id)
      if (typeof through !== 'boolean') {
        throw new Error('overlay.setMouseThrough 的 through 必须是布尔值')
      }
      return readOverlayResult(
        await call('overlay.setMouseThrough', HOST_MAIN_METHODS.overlaySetMouseThrough, {
          extId,
          id: target,
          through
        }),
        'overlay.setMouseThrough'
      )
    },
    async setPosition(id: string, x: number, y: number): Promise<OverlayResult> {
      const target = requireText('overlay.setPosition', 'id', id)
      // 非法坐标（NaN/Infinity/非数字）与 main 同口径：**直接拒绝，不钳不猜**
      for (const [name, value] of [
        ['x', x],
        ['y', y]
      ] as const) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(
            `overlay.setPosition 的 ${name} 必须是有限数字（NaN/Infinity/非数字一律拒绝，不钳不猜）`
          )
        }
      }
      return readOverlayResult(
        await call('overlay.setPosition', HOST_MAIN_METHODS.overlaySetPosition, {
          extId,
          id: target,
          x,
          y
        }),
        'overlay.setPosition'
      )
    }
  }

  /* --------------------------------------- dialog ---------------------------------------- */

  /** `opts` 允许缺省，但给了就必须是对象（挡掉"把字符串当配置"的调用错误） */
  const requireOptions = (api: string, opts: unknown): void => {
    if (opts === undefined) return
    if (!isRecord(opts)) throw new Error(`${api} 的 opts 必须是对象`)
  }

  const dialogApi: ExtensionActivationApi['dialog'] = {
    async showOpenDialog(opts?: DialogOpenOptions): Promise<DialogOpenResult> {
      requireOptions('dialog.showOpenDialog', opts)
      const raw = await call('dialog.showOpenDialog', HOST_MAIN_METHODS.dialogOpen, {
        opts: opts ?? {}
      })
      const result: DialogOpenResult = { ok: false }
      if (!isRecord(raw)) {
        result.error = 'dialog.showOpenDialog：主进程返回了无法识别的结果'
        return result
      }
      result.ok = raw.ok === true
      if (Array.isArray(raw.filePaths)) {
        result.filePaths = raw.filePaths.filter((item): item is string => typeof item === 'string')
      }
      if (typeof raw.canceled === 'boolean') result.canceled = raw.canceled
      if (typeof raw.error === 'string' && raw.error !== '') result.error = raw.error
      if (!result.ok && result.error === undefined) {
        result.error = 'dialog.showOpenDialog 失败（主进程未给出原因）'
      }
      return result
    },
    async showSaveDialog(opts?: {
      title?: string
      defaultName?: string
      filters?: Array<{ name: string; extensions: string[] }>
    }): Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }> {
      requireOptions('dialog.showSaveDialog', opts)
      const raw = await call('dialog.showSaveDialog', HOST_MAIN_METHODS.dialogSave, {
        opts: opts ?? {}
      })
      const result: { ok: boolean; filePath?: string; canceled?: boolean; error?: string } = {
        ok: false
      }
      if (!isRecord(raw)) {
        result.error = 'dialog.showSaveDialog：主进程返回了无法识别的结果'
        return result
      }
      result.ok = raw.ok === true
      if (typeof raw.filePath === 'string') result.filePath = raw.filePath
      if (typeof raw.canceled === 'boolean') result.canceled = raw.canceled
      if (typeof raw.error === 'string' && raw.error !== '') result.error = raw.error
      if (!result.ok && result.error === undefined) {
        result.error = 'dialog.showSaveDialog 失败（主进程未给出原因）'
      }
      return result
    },
    async showMessageBox(opts?: {
      type?: 'info' | 'warning' | 'error' | 'question'
      title?: string
      message?: string
      detail?: string
      buttons?: string[]
    }): Promise<{ ok: boolean; response?: number; error?: string }> {
      requireOptions('dialog.showMessageBox', opts)
      const raw = await call('dialog.showMessageBox', HOST_MAIN_METHODS.dialogMessage, {
        opts: opts ?? {}
      })
      const result: { ok: boolean; response?: number; error?: string } = { ok: false }
      if (!isRecord(raw)) {
        result.error = 'dialog.showMessageBox：主进程返回了无法识别的结果'
        return result
      }
      result.ok = raw.ok === true
      if (typeof raw.response === 'number' && Number.isInteger(raw.response)) {
        result.response = raw.response
      }
      if (typeof raw.error === 'string' && raw.error !== '') result.error = raw.error
      if (!result.ok && result.error === undefined) {
        result.error = 'dialog.showMessageBox 失败（主进程未给出原因）'
      }
      return result
    }
  }

  /* ---------------------------------------- shell ---------------------------------------- */

  const shellApi: ExtensionActivationApi['shell'] = {
    async openExternal(url: string): Promise<{ ok: boolean; error?: string }> {
      const target = requireText('shell.openExternal', 'url', url)
      return readOkResult(
        await call('shell.openExternal', HOST_MAIN_METHODS.shellOpenExternal, { url: target }),
        'shell.openExternal'
      )
    },
    async openPath(target: string): Promise<{ ok: boolean; error?: string }> {
      const value = requireText('shell.openPath', 'path', target)
      return readOkResult(
        await call('shell.openPath', HOST_MAIN_METHODS.shellOpenPath, { path: value }),
        'shell.openPath'
      )
    }
  }

  /* ------------------------------------- notification ------------------------------------ */

  /**
   * 通知：`onClick` **不出宿主**（函数过不了 RPC）。宿主把 main 回的 `notifId` 与本地回调
   * 绑起来，点击事件经事件源回来时一次性触发。
   *
   * 与 v1 的已知差别（回执里已报）：v1 在调用前检查"设置-通知"里该扩展是否被关闭
   * （`stateStore.isNotificationDisabled`），那是渲染侧状态，main/宿主都读不到；本卡直接显示。
   */
  /** 把一次点击绑到某条通知上：命中即退订（v1 的 `off()` 一次性语义） */
  const trackNotificationClick = (notifId: number, onClick: () => void): void => {
    let offRef: (() => void) | null = null
    const off = hub.subscribe(HOST_MAIN_EVENT_CHANNELS.notificationClick, (event): void => {
      const payload = isRecord(event.payload) ? event.payload.notifId : undefined
      if (payload !== notifId) return
      offRef?.()
      runCallback(onClick, 'event')
    })
    offRef = trackSubscription(off)
  }

  const notificationApi: ExtensionActivationApi['notification'] = {
    async show(opts: {
      title: string
      body?: string
      icon?: string
      onClick?: () => void
    }): Promise<{ ok: boolean; error?: string }> {
      if (!isRecord(opts)) throw new Error('notification.show 的 opts 必须是对象')
      const title = requireText('notification.show', 'title', opts.title)
      // 只发纯数据：`onClick` 留在宿主（帧里出现函数会被 checkSerializable 拒）
      const payload: { title: string; body?: string; icon?: string } = { title }
      if (typeof opts.body === 'string') payload.body = opts.body
      if (typeof opts.icon === 'string') payload.icon = opts.icon

      const result = readNotificationResult(
        await call('notification.show', HOST_MAIN_METHODS.notificationShow, {
          extId,
          opts: payload
        }),
        'notification.show'
      )
      if (result.ok && typeof result.id === 'number' && typeof opts.onClick === 'function') {
        trackNotificationClick(result.id, opts.onClick)
      }
      return { ok: result.ok, ...(result.error === undefined ? {} : { error: result.error }) }
    }
  }

  /* ---------------------------------------- secrets -------------------------------------- */

  const secretsApi: ExtensionActivationApi['secrets'] = {
    async get(key: string): Promise<string | undefined> {
      const name = requireText('secrets.get', 'key', key)
      const raw = await call('secrets.get', HOST_MAIN_METHODS.secretsGet, { extId, key: name })
      const result = readValueResult(raw, 'secrets.get')
      // v1：`if (!r.ok) throw new Error(r.error ?? 'secrets 操作失败')`
      if (!result.ok) throw new Error(result.error)
      return typeof result.value === 'string' ? result.value : undefined
    },
    async set(key: string, value: string): Promise<void> {
      const name = requireText('secrets.set', 'key', key)
      if (typeof value !== 'string') {
        throw new Error('secrets.set 的 value 必须是字符串')
      }
      const result = readOkResult(
        await call('secrets.set', HOST_MAIN_METHODS.secretsSet, { extId, key: name, value }),
        'secrets.set'
      )
      if (!result.ok) throw new Error(result.error)
    },
    async delete(key: string): Promise<void> {
      const name = requireText('secrets.delete', 'key', key)
      const result = readOkResult(
        await call('secrets.delete', HOST_MAIN_METHODS.secretsDelete, { extId, key: name }),
        'secrets.delete'
      )
      if (!result.ok) throw new Error(result.error)
    }
  }

  /* ---------------------------------------- update --------------------------------------- */

  const updateApi: HostMainUpdateCapabilities = {
    async getVersion(): Promise<string> {
      const result = readValueResult(
        await call('update.getVersion', HOST_MAIN_METHODS.updateVersion),
        'update.getVersion'
      )
      if (!result.ok) throw new Error(result.error)
      if (typeof result.value !== 'string' || result.value === '') {
        throw new Error('update.getVersion 失败：主进程没有返回版本字符串')
      }
      return result.value
    },
    onEvent(callback: (event: UpdateEvent) => void): Disposable {
      if (typeof callback !== 'function') {
        throw new Error('update.onEvent 的 callback 必须是函数')
      }
      const off = trackSubscription(
        hub.subscribe(HOST_MAIN_EVENT_CHANNELS.updateEvent, (event): void => {
          if (!isRecord(event.payload)) return
          const payload = event.payload as UpdateEvent
          runCallback((): void => callback(payload), 'event')
        })
      )
      return { dispose: off }
    }
  }

  /* ----------------------------------------- proxy --------------------------------------- */

  /**
   * `api.proxy.get()` 在声明里是**同步**的，而 RPC 是异步的——这是本族唯一一个"形状逼着降级"的能力。
   *
   * 做法：构造时预热一次快照；之后**过期即后台刷新**（TTL 见 `proxyCacheTtlMs`），因此语义是
   * "最多旧 TTL"而不是 v1 的"每次读都是最新"。取值来源与 v1 同源：main 的 `currentProxy()`
   * 就是渲染侧 `network.proxy` 设置经 `proxy:apply` 推过来的镜像。
   */
  const proxyTtlMs = options.proxyCacheTtlMs ?? DEFAULT_PROXY_CACHE_TTL_MS
  let proxySnapshot: ProxyConfig | null = null
  let proxySnapshotAt = 0
  let proxyInflight = false
  let warnedBadProxy = false

  const refreshProxy = (): void => {
    if (bridge === undefined || proxyInflight) return
    proxyInflight = true
    void bridge
      .request(HOST_MAIN_METHODS.proxyGet, null)
      .then((raw: unknown): void => {
        const result = readValueResult(raw, 'proxy.get')
        if (!result.ok) {
          log('warn', `[${extId}] 读取代理配置失败，沿用上一次快照：${result.error}`)
          return
        }
        const value = result.value
        if (value !== null && (!isRecord(value) || Array.isArray(value))) {
          if (!warnedBadProxy) {
            warnedBadProxy = true
            log('warn', `[${extId}] 主进程返回的代理配置形状无法识别，已回落默认（直连）`)
          }
          proxySnapshot = normalizeProxyConfig(undefined)
          proxySnapshotAt = Date.now()
          return
        }
        warnedBadProxy = false
        proxySnapshot = normalizeProxyConfig((value ?? undefined) as ProxyConfigInput)
        proxySnapshotAt = Date.now()
      })
      .catch((error: unknown): void => {
        log('warn', `[${extId}] 读取代理配置失败，沿用上一次快照：${toErrorMessage(error)}`)
      })
      .finally((): void => {
        proxyInflight = false
      })
  }

  /** 快照过期（或还没有）就发起一次后台刷新 */
  const refreshProxyIfStale = (): void => {
    if (proxySnapshot === null || Date.now() - proxySnapshotAt >= proxyTtlMs) refreshProxy()
  }

  // 构造即预热：第一次 `get()` 通常已经能拿到真值（扩展激活时 main 已经收过 `proxy:apply`）
  refreshProxy()

  const proxyApi: ExtensionActivationApi['proxy'] = {
    get(): ProxyConfig {
      refreshProxyIfStale()
      return proxySnapshot ?? normalizeProxyConfig(undefined)
    }
  }

  /* ---------------------------------------- 生命周期 -------------------------------------- */

  let closed = false
  return {
    window: windowApi,
    overlay: overlayApi,
    dialog: dialogApi,
    shell: shellApi,
    notification: notificationApi,
    secrets: secretsApi,
    update: updateApi,
    proxy: proxyApi,
    isPolling(): boolean {
      return hub.isPolling()
    },
    dispose(): void {
      if (closed) return
      closed = true
      for (const off of [...subscriptions]) {
        subscriptions.delete(off)
        try {
          off()
        } catch {
          // 退订本身失败不该阻断清理
        }
      }
      hub.dispose()
      // 回收本扩展创建过的 overlay（v1：停用/卸载即销毁窗体；这里是"尽力而为"，失败只记日志）
      const target = bridge
      if (target !== undefined) {
        for (const id of [...createdOverlays]) {
          void target
            .request(HOST_MAIN_METHODS.overlayDestroy, { extId, id })
            .catch((error: unknown): void => {
              log('warn', `[${extId}] 停用时销毁 overlay 失败：${id}`, toErrorMessage(error))
            })
        }
      }
      createdOverlays.clear()
      // 轮询源也一并关掉：停用后不该还有在途请求（幂等）
      const polling = eventSource as Partial<PollingEventSource> | null
      polling?.dispose?.()
    }
  }
}
