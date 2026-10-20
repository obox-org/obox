/**
 * EH-A4 · 渲染侧扩展宿主桥（Extension Host Renderer Bridge）。
 *
 * 决策见 `docs/adr/0026-extension-host-process.md`，任务卡见 `docs/extension-host-migration.md`
 * 的 EH-A4。本文件是**纯渲染侧模块**（不 import electron / node），因此可以在 node 环境的单测里
 * 用假端口与假 IPC 直接驱动。
 *
 * ## 它负责什么
 *
 * 1. **开关判定（EH-D2a）**：设置项（用户显式设过）> 环境变量 `OBOX_EXTENSION_HOST`（`1`/`true`
 *    显式开、`0`/`false` 显式关）> **默认 `true`**（2.0.0 起用户扩展默认在宿主进程里执行）。
 *    判定是纯函数 `resolveExtensionHostSwitch()`，一处实现、可穷举；`readExtensionHostFlag()`
 *    把结论编码成老契约的 `'1'`/`'0'`，让 `core/host.ts` 与 `core/extensionHostConsumer.ts`
 *    不改接线就跟随同一个开关。开关关闭时本模块**什么都不做**：不交接、不发请求、不 start 宿主。
 * 2. **清单交接**：开关打开时，把 `loader.collectHostedExtensions()` 产出的
 *    `HostedExtensionInfo[]` 经 `ehStart` 交给 main，由 main `start()` 宿主（**main 不在启动时
 *    自动 start**）。交接本身永不 reject，失败只降级成日志 + `ok:false` **+ 自动回退**
 *    （`applyRendererFallback`：明确日志 + 会话标记 + 重新加载窗口，需求 4）。
 * 3. **RPC 客户端**：发送前 `validateEnvelope` + `checkSerializable`（失败给中文可执行错误并带
 *    字段路径）→ req/res 按 `id` 配对 → 默认 3 秒（`ACK_TIMEOUT_MS`）超时。
 * 4. **事件与日志**：`event` 信封按 `channel` 分发；`log` 信封转发到渲染侧 console（UI 可另订阅）。
 * 5. **状态可观测**：把启动器的 `phase`（idle/starting/ready/unresponsive/crashed/stopped）与
 *    最近崩溃原因暴露成订阅（`onStatus` / `getStatus`），供 A5 / 扩展管理器展示；
 *    端口状态照 A2 的 `eh:get-port` 定义用（`getPortStatus`）。
 *
 * ## 端口为什么不是真的 MessagePort
 *
 * 端口只能由 main 用 `webContents.postMessage('eh:port', payload, [port])` 转移（`ipcMain.handle`
 * 的返回值带不出端口，A2 已确认）；而 `contextBridge` 又不支持传 transferable。因此 preload 在
 * 隔离世界里持有真端口，渲染世界拿到的是 `window.eh`（发送 / 订阅 / 是否已到三个动作）。
 * 本模块只依赖 `ExtensionHostChannel` 这个窄接口，单测注入假实现即可。
 *
 * ## 已知限制（A4 范围内不解决）
 *
 * 页面重新加载后，旧页面的端口随旧渲染进程销毁，而 A2 的 `portDelivered` 仍是 `true` ——
 * 不会自动补发。此时发送请求会得到"端口未到"的中文错误，恢复方式是重启应用
 * （或先 `ehStop()` 再 `ehStart()` 重建链路，留给 A5 的扩展管理器做按钮）。
 */
import {
  ACK_TIMEOUT_MS,
  EH_ERROR_TEXT,
  EhProtocolError,
  checkFrameSize,
  checkSerializable,
  createErrorEnvelope,
  createRequestEnvelope,
  validateEnvelope,
  type Envelope,
  type HostedExtensionInfo,
  type LogLevel,
  type RequestEnvelope,
  type UnserializableKind
} from '../../../shared/extensionHostProtocol'
import type {
  ExtensionHostBridgeSurface,
  ExtensionHostPhase,
  ExtensionHostPortStatus,
  ExtensionHostStartOutcome,
  ExtensionHostStatusSnapshot
} from '../../../shared/types'
// 设置项的显式值（EH-D2a）：开关解析要读"用户是否设过"，而 state 是唯一存它的地方。
// 单向依赖（state 不认识桥），不会形成环。
import { stateStore } from './state'

declare global {
  interface Window {
    /**
     * preload 暴露的扩展宿主桥接口（EH-A4，见 `src/shared/types.ts` 的
     * `ExtensionHostBridgeSurface`）：`src/preload/index.ts` 用
     * `contextBridge.exposeInMainWorld('eh', …)` 注入。
     *
     * 类型声明放在本文件而不是 `preload/index.d.ts`：暴露面的**消费者**是渲染侧（这里），
     * 声明跟着消费方走，读代码时不必跨目录找。
     */
    eh?: ExtensionHostBridgeSurface
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 常量                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * 扩展宿主开关的环境变量名（**开发者/兜底**手段，不再是对外唯一开关）。
 *
 * 2.0.0 起用户开关是「设置 → 通用 → 在独立进程中运行扩展」；本环境变量只在没有显式设置值时
 * 参与判定（`1`/`true` 显式开，`0`/`false` 显式关，其余取值视为未设）。
 */
export const EXTENSION_HOST_ENV = 'OBOX_EXTENSION_HOST'

/** `event.channel` 的通配订阅键（收到任意 channel 都会回调；给 A5 做"日志面板/调试视图"用） */
export const ANY_EVENT_CHANNEL = '*'

/**
 * 「上次启动宿主失败、本窗口已回退到渲染进程」的**会话级**标记（sessionStorage）。
 *
 * 为什么是 sessionStorage 而不是设置项：它只描述"这一个窗口这一次会话"的事实，不能污染
 * 用户的持久化设置；窗口关闭（= 应用退出）后会自然清掉，下次启动重新尝试宿主。
 * 存的值同时也是给用户看的中文提示（`extensionHostFallbackNotice()`）。
 */
export const EXTENSION_HOST_FALLBACK_KEY = 'obox:extension-host:renderer-fallback'

/* -------------------------------------------------------------------------------------------- */
/* 开关解析（EH-D2a）：设置项 > 环境变量 > 默认开                                                  */
/* -------------------------------------------------------------------------------------------- */

/** 开关的判定来源（日志/设置页展示用；`fallback` = 启动失败后的临时回退） */
export type ExtensionHostSwitchSource = 'setting' | 'env' | 'default' | 'fallback'

/** 开关判定结果 */
export interface ExtensionHostSwitchDecision {
  /** 是否让用户扩展在扩展宿主进程里执行 */
  enabled: boolean
  /** 结论来自哪一级（排查"为什么现在是渲染进程"时唯一的线索） */
  source: ExtensionHostSwitchSource
}

/** 来源 → 中文说明（日志与设置页共用**同一份**文案，避免两处描述打架） */
export const EXTENSION_HOST_SOURCE_TEXT: Record<ExtensionHostSwitchSource, string> = {
  setting: '设置项',
  env: `环境变量 ${EXTENSION_HOST_ENV}`,
  default: '默认（2.0.0 起默认开）',
  fallback: '启动失败后的临时回退（重启后重新尝试）'
}

/**
 * 解析环境变量原文（**纯函数**）。
 *
 * - `1` / `true`（大小写与首尾空白不敏感）⇒ `true`（显式开）；
 * - `0` / `false` ⇒ `false`（显式关，"显式关也认"是本卡与旧实现的差别之一）；
 * - 未设置 / 空串 / 全空白 / 认不出的值 ⇒ `undefined` = **当作未设**，交给下一级（默认开）。
 *
 * 为什么认不出的值不再等同于"关"：优先级表只有"显式开/显式关/未设"三种状态；拼错
 * （`OBOX_EXTENSION_HOST=no`）若被当成显式关，用户会以为"我明明设了却没反应"。
 */
export function parseExtensionHostEnv(env: string | null | undefined): boolean | undefined {
  if (typeof env !== 'string') return undefined
  const normalized = env.trim().toLowerCase()
  if (normalized === '') return undefined
  if (normalized === '1' || normalized === 'true') return true
  if (normalized === '0' || normalized === 'false') return false
  return undefined
}

/**
 * **开关判定的唯一出处**（纯函数，可穷举）。
 *
 * 优先级：设置项（用户显式设过）> 环境变量（显式开/关都认）> **默认 `true`**。
 *
 * 与 preload 是否暴露环境变量**解耦**：`env` 拿不到（`undefined` / `null` / 非字符串）就等同"未设"，
 * 直接落到默认开，绝不会因为"读不到 env"而把扩展关回渲染进程。
 */
export function resolveExtensionHostSwitch(input: {
  /** 设置项的值：`true`/`false` = 用户显式设过；`undefined` = 从未设过 */
  setting?: boolean | undefined
  /** 环境变量原文（`process.env.OBOX_EXTENSION_HOST`）；拿不到就传 `null`/`undefined` */
  env?: string | null | undefined
}): ExtensionHostSwitchDecision {
  if (typeof input.setting === 'boolean') return { enabled: input.setting, source: 'setting' }
  const fromEnv = parseExtensionHostEnv(input.env)
  if (fromEnv !== undefined) return { enabled: fromEnv, source: 'env' }
  return { enabled: true, source: 'default' }
}

/**
 * 解析**已判定的**开关编码（只认 `1` / `true` 为开）。
 *
 * 它不再做优先级判定——判定在 `resolveExtensionHostSwitch()`；本函数只负责把
 * `'1'`/`'0'` 这种老契约（`core/host.ts` 与 `core/extensionHostConsumer.ts` 认的形态）解释成布尔。
 * 保留"不认识就算关"的保守语义：调用方手里只有这两个合法取值。
 */
export function isExtensionHostEnabled(flag: string | null | undefined): boolean {
  if (typeof flag !== 'string') return false
  const normalized = flag.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}

/**
 * 读**当前生效**的开关（含来源）：设置项 > 环境变量 > 默认开；本窗口启动失败过 ⇒ 临时回退。
 *
 * 回退标记优先级最高（压过设置项）是刻意的：否则"用户显式开着 + 宿主启动即崩"会在每次
 * 重新加载时再崩一次——那是崩溃循环，不是回退。
 */
export function readExtensionHostSwitch(): ExtensionHostSwitchDecision {
  if (isRendererFallbackActive()) return { enabled: false, source: 'fallback' }
  return resolveExtensionHostSwitch({
    setting: stateStore.getExtensionHostEnabled(),
    env: windowSurface()?.extensionHostFlag ?? null
  })
}

/**
 * 读 preload 暴露的**当前生效开关**，按老契约编码成 `'1'` / `'0'`。
 *
 * 为什么还返回字符串：`core/host.ts` 与 `core/extensionHostConsumer.ts` 只认
 * `isExtensionHostEnabled(flag)` 这一个入口，而它们不在本卡所有权内。把"设置 > env > 默认开"
 * 的解析收在这里，两个消费者就自动跟随同一个开关，不需要改它们的接线。
 * （`window.eh.extensionHostFlag` 本身仍是 preload 读到的**原始** env，本函数不写它。）
 */
export function readExtensionHostFlag(): string | null {
  return readExtensionHostSwitch().enabled ? '1' : '0'
}

/* -------------------------------------------------------------------------------------------- */
/* 启动失败回退（EH-D2a 需求 4）                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** 一个明确的中文提示：为什么回退了、扩展现在在哪跑、怎么恢复（设置页与日志共用同一句话） */
export function rendererFallbackNoticeText(reason: string): string {
  return (
    `扩展宿主没有启动成功（${reason}），已自动回退：扩展继续在主界面进程执行（兼容旧行为）。` +
    '重启 Obox 后会再次尝试在独立进程中运行扩展。'
  )
}

/** sessionStorage 读（无浏览器环境 / 被禁用时返回 null，绝不抛错） */
function sessionGet(key: string): string | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

/** sessionStorage 写（返回是否真的写进去了；无浏览器环境 / 被禁用时返回 false） */
function sessionSet(key: string, value: string): boolean {
  try {
    if (typeof sessionStorage === 'undefined') return false
    sessionStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** sessionStorage 删（同上，静默） */
function sessionRemove(key: string): void {
  try {
    if (typeof sessionStorage === 'undefined') return
    sessionStorage.removeItem(key)
  } catch {
    // 同上
  }
}

/** 本窗口是否处于"启动失败已回退"状态（是 ⇒ 开关判定恒为关，见 `readExtensionHostSwitch`） */
export function isRendererFallbackActive(): boolean {
  return extensionHostFallbackNotice() !== null
}

/**
 * 回退提示原文（没有回退过 ⇒ `null`；设置页据此渲染一行红字）。
 *
 * 唯一事实来源是 sessionStorage：它才能跨"自动重载"活下来——而回退的自动生效正是靠重载
 * （见 `applyRendererFallback`）。没有 sessionStorage 时本窗口就没有回退状态
 * （不重载、也不假装回退），只留日志，绝不制造"重载 → 还是起不来 → 再重载"的循环。
 */
export function extensionHostFallbackNotice(): string | null {
  const stored = sessionGet(EXTENSION_HOST_FALLBACK_KEY)
  if (typeof stored !== 'string') return null
  return stored.trim() === '' ? null : stored
}

/**
 * 记下"本窗口回退到渲染进程"并返回给用户看的提示。
 *
 * 幂等：重复调用只覆盖提示文案。**不清设置项**——用户的选择照旧保留，重启后重新尝试。
 */
export function activateRendererFallback(reason: string): string {
  const notice = rendererFallbackNoticeText(reason)
  sessionSet(EXTENSION_HOST_FALLBACK_KEY, notice)
  return notice
}

/**
 * 清掉回退标记（用户主动改开关时调用）。
 *
 * 为什么需要：回退标记压过设置项（见 `readExtensionHostSwitch`），若不提供"清标记"，
 * 用户在设置页点开关会看起来毫无反应——那才是真正的坏体验。
 */
export function clearRendererFallback(): void {
  sessionRemove(EXTENSION_HOST_FALLBACK_KEY)
  fallbackApplied = false
}

/** 一个窗口生命周期内"回退动作"（日志 + 重载）只做一次，避免崩溃/失败重复触发重载循环 */
let fallbackApplied = false

/** 回退动作的参数 */
interface RendererFallbackOptions {
  /** 失败原因（一句话，进提示文案） */
  reason: string
  /** 更详细的一手信息（错误码/退出码，进日志） */
  detail: string
  /** 被交接给宿主的用户扩展数（0 ⇒ 没有需要"救回来"的扩展，不必重载） */
  hostedCount: number
  /** 即使没有清单也强制重载（宿主**运行中**崩溃时用它：扩展已经随宿主没了） */
  forceReload?: boolean
  logger: ExtensionHostBridgeLogger
  /** 重载动作（默认 `window.location.reload()`；`null` = 不重载，单测用） */
  reload?: (() => void) | null
}

/**
 * 执行回退：留一条明确日志 → 记标记 → **重新加载本窗口**。
 *
 * 为什么必须重载：`core/host.ts` 在 `start()` 里**同步**用交接结果算出了"哪些扩展跳过渲染侧
 * 激活"，这个决定发生在我们知道 `ehStart` 成败之前。于是失败后唯一的"自动回退"通路是让
 * `start()` 再跑一遍——这次开关判定读到回退标记 ⇒ 走渲染进程路径 ⇒ 用户在用的扩展照旧全部在。
 * 重载只发生一次（`fallbackApplied` + 标记本身都阻止循环）。
 */
function applyRendererFallback(options: RendererFallbackOptions): string {
  const notice = rendererFallbackNoticeText(options.reason)
  // 写标记的**成败**决定了能不能重载：写不进去就无法在重载后保持回退（见下方注释）
  const persisted = sessionSet(EXTENSION_HOST_FALLBACK_KEY, notice)
  if (fallbackApplied) return notice
  fallbackApplied = true
  options.logger.error(
    `扩展宿主启动失败，已自动回退到主界面进程：${options.reason}（${options.detail}）；` +
      `本窗口接下来按渲染进程执行扩展（${options.hostedCount} 个用户扩展，兼容旧行为），` +
      '不会再尝试扩展宿主；重启 Obox 后会再次尝试。'
  )
  // 只有"标记真的存下来了"才重载：存不下来就无法在重载后保持回退，重载只会变成
  // "起不来 → 重载 → 还是起不来"的循环。此时只留日志，让用户手动重启。
  if (!persisted) {
    options.logger.warn(
      '回退标记无法持久化（sessionStorage 不可用），本次不自动重新加载；请手动重启 Obox 让扩展回到主界面进程执行。'
    )
    return notice
  }
  if (options.hostedCount > 0 || options.forceReload === true) reloadWindow(options.reload)
  return notice
}

/** 重新加载当前窗口（默认实现；单测注入 spy 或 `null` 关掉） */
function reloadWindow(reload: (() => void) | null | undefined): void {
  if (reload === null) return
  if (typeof reload === 'function') {
    try {
      reload()
    } catch (error) {
      console.warn(`[eh] 回退重载失败：${describeError(error)}（请手动重启 Obox）`)
    }
    return
  }
  if (typeof window === 'undefined') return
  try {
    window.location.reload()
  } catch (error) {
    console.warn(`[eh] 回退重载失败：${describeError(error)}（请手动重启 Obox）`)
  }
}

/**
 * 宿主 **运行中崩溃** ⇒ 同样回退到渲染进程（EH-D2a 需求 4 的后半句）。
 *
 * 启动期就崩会走 `ehStart` 的 `ok:false`（启动器在握手期退出即返回失败）；这里覆盖"已经
 * ready 之后又崩"的情形——扩展已经随宿主一起没了，不处理就是用户看到"所有扩展消失"。
 * 返回给用户看的提示（phase 不是 `crashed` 时返回 `null`，完全不动作）。
 */
export function handleExtensionHostCrash(
  status: ExtensionHostStatusSnapshot,
  options: {
    logger?: ExtensionHostBridgeLogger
    reload?: (() => void) | null
  } = {}
): string | null {
  if (status.phase !== 'crashed') return null
  const logger = options.logger ?? consoleLogger
  const reason = status.lastCrash
    ? `宿主进程崩溃（退出码 ${status.lastCrash.code}）`
    : '宿主进程异常退出'
  return applyRendererFallback({
    reason,
    detail: status.lastCrash
      ? `崩溃时间 ${new Date(status.lastCrash.at).toISOString()}`
      : '没有崩溃详情',
    hostedCount: 0,
    // 宿主崩了 = 交给它的扩展已经没了，必须重载才能把它们救回渲染进程
    forceReload: true,
    logger,
    reload: options.reload
  })
}

/* -------------------------------------------------------------------------------------------- */
/* 依赖接口（可注入，单测用假实现）                                                              */
/* -------------------------------------------------------------------------------------------- */

/** 桥的诊断日志出口（默认 console；与宿主日志区分，统一 `[eh]` 前缀） */
export interface ExtensionHostBridgeLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * 桥对外的**下行/上行通道**（默认实现建在 `window.eh` + `window.api` 上）。
 *
 * 拆成接口的理由：单测要能在**没有 Electron、没有端口**的 node 环境里精确控制"端口到没到"、
 * "宿主回了什么"，而真实 Electron 的端口/事件在 vitest 里造不出来。
 */
export interface ExtensionHostChannel {
  /** 端口是否已到达且可用（false ⇒ 任何发送都该给中文可执行错误） */
  isReady(): boolean
  /** 发送一个**已校验**的信封；端口未到返回 false（不抛错） */
  send(envelope: Envelope): boolean
  /** 订阅宿主 → 渲染侧的消息（原始值，桥自己校验形状） */
  onEnvelope(listener: (raw: unknown) => void): () => void
  /** 订阅宿主状态快照变化 */
  onStatus(listener: (status: ExtensionHostStatusSnapshot) => void): () => void
  /** 读当前状态快照（首次校准 / "端口未到"时的诊断）；拿不到返回 null */
  readStatus(): Promise<ExtensionHostStatusSnapshot | null>
  /** 读端口状态（A2 的 `eh:get-port` 形状：只有状态、没有端口） */
  readPortStatus(): Promise<ExtensionHostPortStatus | null>
}

/** 宿主状态基线（还没收到任何快照时的取值；与启动器 `getStatus()` 的初值一致） */
export function idleStatus(): ExtensionHostStatusSnapshot {
  return {
    phase: 'idle',
    hostId: null,
    pid: null,
    crashCount: 0,
    lastCrash: null,
    lastAckAt: null
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 可传输性：种类 → 中文说明                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * `checkSerializable` 的失败种类 → 中文说明。
 *
 * 必须穷举（`Record` 由类型保证）：新增种类时这里会编译报错，避免出现"用户看到英文 kind"。
 */
const UNSERIALIZABLE_TEXT: Record<UnserializableKind, string> = {
  undefined: 'undefined（值缺失）',
  bigint: 'bigint',
  function: '函数',
  symbol: 'Symbol',
  'symbol-key': 'Symbol 键',
  'non-finite-number': 'NaN / Infinity',
  circular: '循环引用',
  'sparse-array': '稀疏数组（有空洞）',
  map: 'Map',
  set: 'Set',
  weakmap: 'WeakMap',
  weakset: 'WeakSet',
  date: 'Date 实例',
  regexp: 'RegExp 实例',
  error: 'Error 实例',
  promise: 'Promise',
  'typed-array': '非 Uint8Array 的 TypedArray / DataView',
  'class-instance': '类实例（不是纯对象）',
  unreadable: '读不出来的属性（getter 抛错）'
}

/** 不可传输种类的中文说明 */
export function describeUnserializableKind(kind: UnserializableKind): string {
  return UNSERIALIZABLE_TEXT[kind]
}

/* -------------------------------------------------------------------------------------------- */
/* 桥                                                                                            */
/* -------------------------------------------------------------------------------------------- */

/** 在途请求 */
interface PendingCall {
  /** 方法名（超时/取消的错误文案里带上，便于定位） */
  method: string
  resolve(value: unknown): void
  reject(error: EhProtocolError): void
  timer: unknown
}

/** 桥的对外接口 */
export interface ExtensionHostBridge {
  /** 端口是否已到（可发请求） */
  isReady(): boolean
  /**
   * 发一个 RPC 请求并等响应。
   *
   * 失败一律抛 `EhProtocolError`（`code` 是协议错误码，`message` 是中文可执行文案）：
   * - `EH_UNSERIALIZABLE`：参数含不可传输值（文案含**字段路径**）
   * - `EH_FRAME_TOO_LARGE`：单帧超过 8 MB
   * - `EH_NOT_READY`：端口未到（文案按启动器 `phase` 给下一步动作）
   * - `EH_TIMEOUT`：超时内没有 `res`/`err`
   * - `EH_CANCELLED`：宿主回 `cancel`
   * - 宿主回的 `err`：原样保留 `code` / `message` / `detail`
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T>
  /** 订阅宿主 `event`（按 channel 精确匹配；传 `ANY_EVENT_CHANNEL` 收全部） */
  onEvent(channel: string, listener: (payload: unknown) => void): () => void
  /** 订阅宿主 `log`（console 转发始终发生，这里给 UI 附加订阅） */
  onLog(listener: (level: LogLevel, message: string) => void): () => void
  /** 订阅状态快照（每次 `eh:status` 与主动刷新都会回调） */
  onStatus(listener: (status: ExtensionHostStatusSnapshot) => void): () => void
  /** 最近一次状态快照（未收到过时是 `idle` 基线） */
  getStatus(): ExtensionHostStatusSnapshot
  /** 主动刷新：`eh:get-status` 拿到 phase / 崩溃原因，写进快照并通知订阅者 */
  refreshStatus(): Promise<ExtensionHostStatusSnapshot>
  /** 端口状态（A2 的 `eh:get-port`；拿不到返回 null） */
  getPortStatus(): Promise<ExtensionHostPortStatus | null>
  /** 在途请求数（诊断与测试用） */
  pendingRequestCount(): number
  /**
   * 注册「宿主发起 RPC」的接管者（EH-B3b-2；返回注销函数）。
   *
   * 为什么必须有这条：A4 的桥只做「渲染侧 → 宿主」的请求，收到宿主的 `req` 时只能回
   * `EH_INTERNAL`。B3b-2 的 `ui.*` / `ui.updateGate` 方向相反，必须由渲染侧消费者的 `RpcServer`
   * 接管；未注册时保持原行为（回 `EH_INTERNAL`），A4 的语义不变。
   */
  setHostRequestHandler(handler: ((envelope: RequestEnvelope) => boolean) | null): () => void
  /** 退订全部订阅 + 以 `EH_CANCELLED` 拒绝在途请求（页面卸载时调用；幂等） */
  dispose(): void
}

/** 创建桥的参数 */
export interface ExtensionHostBridgeOptions {
  /** 通道（默认建在 `window.eh` + `window.api` 上） */
  channel?: ExtensionHostChannel
  /** 默认请求超时（毫秒，默认 `ACK_TIMEOUT_MS` = 3 秒） */
  timeoutMs?: number
  logger?: ExtensionHostBridgeLogger
}

/** 默认日志出口：统一 `[eh]` 前缀，便于在渲染进程 console 里与扩展/宿主日志区分 */
const consoleLogger: ExtensionHostBridgeLogger = {
  debug: (message): void => console.debug(`[eh] ${message}`),
  info: (message): void => console.info(`[eh] ${message}`),
  warn: (message): void => console.warn(`[eh] ${message}`),
  error: (message): void => console.error(`[eh] ${message}`)
}

/** 把未知错误压成一行（日志用） */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 崩溃原因 → 一句中文（`code` 是真实退出码或启动器的合成码） */
function describeCrash(crash: { code: number; at: number }): string {
  return `退出码 ${crash.code}（${new Date(crash.at).toLocaleString()}）`
}

/** "端口未到"的中文可执行文案：按 phase 给**下一步动作**，而不是复述错误名 */
export function notReadyMessage(status: ExtensionHostStatusSnapshot): string {
  const head = '扩展宿主的端口还没到本窗口，请求没有发出去。'
  switch (status.phase) {
    case 'idle':
      return (
        `${head}当前宿主从未启动（phase=idle）：请确认「设置 → 通用 → 在独立进程中运行扩展」是打开的` +
        `（2.0.0 起默认开）并重启 Obox；开发者也可以临时用 ${EXTENSION_HOST_ENV}=1 启动，` +
        '或在扩展管理器里点"启动扩展宿主"。若开关已关掉，用户扩展在主界面进程执行，不需要本桥。'
      )
    case 'starting':
      return `${head}宿主正在启动（phase=starting，握手未完成）：请等 1-2 秒后重试；若一直如此，看主进程日志里的握手失败原因。`
    case 'ready':
      return `${head}宿主已就绪（phase=ready）但端口没到：页面可能刚重新加载过（端口随旧页面销毁）。请重启应用重建链路，或先 ehStop() 再 ehStart()。`
    case 'unresponsive':
      return `${head}宿主被标记无响应（phase=unresponsive，3 秒内没应答判活）：请检查扩展是否阻塞了事件循环，必要时在扩展管理器里重启宿主。`
    case 'crashed':
      return (
        `${head}宿主已崩溃（phase=crashed` +
        `${status.lastCrash ? `，最近崩溃：${describeCrash(status.lastCrash)}` : ''}）：` +
        '请在扩展管理器里重启宿主或禁用出错的扩展。'
      )
    case 'stopped':
      return `${head}宿主已停止（phase=stopped）：请重新 ehStart() 启动宿主。`
  }
}

class ExtensionHostBridgeImpl implements ExtensionHostBridge {
  private readonly channel: ExtensionHostChannel
  private readonly timeoutMs: number
  private readonly logger: ExtensionHostBridgeLogger

  private nextRequestId = 1
  private readonly pending = new Map<number, PendingCall>()
  private readonly eventListeners = new Map<string, Set<(payload: unknown) => void>>()
  private readonly logListeners = new Set<(level: LogLevel, message: string) => void>()
  private readonly statusListeners = new Set<(status: ExtensionHostStatusSnapshot) => void>()
  private status: ExtensionHostStatusSnapshot = idleStatus()
  /**
   * 宿主发起的反向 RPC 的接管者（EH-B3b-2）。
   *
   * A4 的桥只有「宿主 → 渲染」的 `event` / `log` 方向，收到 `req` 会回 `EH_INTERNAL`。B3b-2 起
   * 渲染侧消费者在同一端口上跑一个 `RpcServer`（`ui.showMessage` / `ui.updateGate` 等），必须由它
   * 接管这些 `req`——**否则宿主永远只会收到「渲染侧桥暂不支持」**（这正是本卡真机上唯一的死点）。
   *
   * 未注册时保持原行为（回 `EH_INTERNAL` + 告警），所以 A4 的既有语义与用例不受影响。
   */
  private hostRequestHandler: ((envelope: RequestEnvelope) => boolean) | null = null

  private readonly offEnvelope: () => void
  private readonly offStatus: () => void
  private disposed = false

  constructor(options: ExtensionHostBridgeOptions = {}) {
    this.channel = options.channel ?? createWindowChannel()
    this.timeoutMs = options.timeoutMs ?? ACK_TIMEOUT_MS
    this.logger = options.logger ?? consoleLogger
    // 端起订阅（不是按端口订阅）：端口晚到也能收到此后的一切消息
    this.offEnvelope = this.channel.onEnvelope((raw) => this.handleRaw(raw))
    this.offStatus = this.channel.onStatus((status) => this.applyStatus(status))
  }

  isReady(): boolean {
    return !this.disposed && this.channel.isReady()
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    if (this.disposed) {
      throw new EhProtocolError(
        'EH_CANCELLED',
        '渲染侧桥已释放（页面正在卸载），请求没有发出。请重新加载页面后再试。'
      )
    }
    if (typeof method !== 'string' || method.trim() === '') {
      throw new EhProtocolError(
        'EH_INTERNAL',
        'RPC 方法名必须是非空字符串（宿主按方法名分派），请检查调用方传入的 method。'
      )
    }

    // ① 可传输性：失败必须带字段路径，否则用户只看到"某个值不行"。
    // `params` 缺省按 `null` 处理（信封里也是 null）：`undefined` 本身不可传输，但不该因此
    // 让"无参请求"报错——那是调用方最常用的写法。
    const payload = params ?? null
    const serializable = checkSerializable(payload, 'params')
    if (!serializable.ok) {
      throw new EhProtocolError(
        'EH_UNSERIALIZABLE',
        `方法 ${method} 的参数里 ${serializable.path} 是${describeUnserializableKind(serializable.kind)}，` +
          `无法跨进程传输。${EH_ERROR_TEXT.EH_UNSERIALIZABLE}`
      )
    }

    const id = this.nextRequestId++
    const envelope = createRequestEnvelope(id, method, payload)
    // ② 形状：自己拼的也要校验（先例：A2 的 send()），否则畸形信封只会在对面被静默丢弃
    const checked = validateEnvelope(envelope)
    if (!checked.ok) {
      throw new EhProtocolError(checked.code, `请求信封形状不合法：${checked.why}`)
    }
    // ③ 帧大小：8 MB 上限，超了要在本地就说清"分片或落盘"
    const frame = checkFrameSize(checked.env)
    if (!frame.ok) {
      throw new EhProtocolError(frame.code, EH_ERROR_TEXT.EH_FRAME_TOO_LARGE, frame.why)
    }

    // ④ 端口未到：给中文可执行错误（不 panic、不排队）
    if (!this.channel.isReady()) {
      throw new EhProtocolError('EH_NOT_READY', await this.notReadyText())
    }

    const timeoutMs = options?.timeoutMs ?? this.timeoutMs
    return new Promise<T>((resolve, reject) => {
      const call: PendingCall = {
        method,
        resolve: (value: unknown): void => {
          resolve(value as T)
        },
        reject,
        timer: undefined
      }
      call.timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new EhProtocolError(
            'EH_TIMEOUT',
            EH_ERROR_TEXT.EH_TIMEOUT,
            `方法 ${method}（id=${id}）在 ${timeoutMs}ms 内没有响应；渲染侧已放弃等待，宿主侧可能仍在执行`
          )
        )
      }, timeoutMs)
      this.pending.set(id, call)
      if (!this.channel.send(checked.env)) {
        // 检查与发送之间端口断了（页面重建/宿主退出）：撤销挂起，回可操作错误
        this.settleLocally(
          id,
          new EhProtocolError(
            'EH_NOT_READY',
            '端口在发送的瞬间断开了（宿主已退出或页面正在重建）。请重新 ehStart() 或重启应用。'
          )
        )
      }
    })
  }

  onEvent(channel: string, listener: (payload: unknown) => void): () => void {
    if (typeof channel !== 'string' || channel === '') {
      throw new EhProtocolError('EH_INTERNAL', '事件 channel 必须是非空字符串')
    }
    const set = this.eventListeners.get(channel) ?? new Set<(payload: unknown) => void>()
    set.add(listener)
    this.eventListeners.set(channel, set)
    return (): void => {
      set.delete(listener)
      if (set.size === 0) this.eventListeners.delete(channel)
    }
  }

  onLog(listener: (level: LogLevel, message: string) => void): () => void {
    this.logListeners.add(listener)
    return (): void => {
      this.logListeners.delete(listener)
    }
  }

  onStatus(listener: (status: ExtensionHostStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener)
    return (): void => {
      this.statusListeners.delete(listener)
    }
  }

  getStatus(): ExtensionHostStatusSnapshot {
    return { ...this.status }
  }

  async refreshStatus(): Promise<ExtensionHostStatusSnapshot> {
    try {
      const status = await this.channel.readStatus()
      if (status) this.applyStatus(status)
    } catch (error) {
      this.logger.warn(`读取扩展宿主状态失败：${describeError(error)}`)
    }
    return this.getStatus()
  }

  async getPortStatus(): Promise<ExtensionHostPortStatus | null> {
    try {
      return await this.channel.readPortStatus()
    } catch (error) {
      this.logger.warn(`读取扩展宿主端口状态失败：${describeError(error)}`)
      return null
    }
  }

  pendingRequestCount(): number {
    return this.pending.size
  }

  /**
   * 注册/注销「宿主发起 RPC」的接管者（EH-B3b-2，返回注销函数）。
   *
   * 交接约定：接管者收到信封后**自己回帧**（`res`/`err`），返回 `true` 表示"我接了"；
   * 返回 `false` 则落回 A4 的 `EH_INTERNAL` 回包（没人在听的时候宿主也不会挂死）。
   */
  setHostRequestHandler(handler: ((envelope: RequestEnvelope) => boolean) | null): () => void {
    this.hostRequestHandler = handler
    return (): void => {
      if (this.hostRequestHandler === handler) this.hostRequestHandler = null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offEnvelope()
    this.offStatus()
    this.statusListeners.clear()
    this.logListeners.clear()
    this.eventListeners.clear()
    for (const id of [...this.pending.keys()]) {
      this.settleLocally(
        id,
        new EhProtocolError('EH_CANCELLED', '渲染侧桥已释放（页面卸载），在途请求被取消。')
      )
    }
  }

  /* ------------------------------ 入站 ------------------------------ */

  /** 端口还没到时给"按 phase 的下步动作"；读状态失败也不能把错误变成 panic */
  private async notReadyText(): Promise<string> {
    try {
      const status = (await this.channel.readStatus()) ?? this.status
      return notReadyMessage(status)
    } catch {
      return notReadyMessage(this.status)
    }
  }

  private handleRaw(raw: unknown): void {
    const checked = validateEnvelope(raw)
    if (!checked.ok) {
      // 畸形信封不致命，但必须留痕：否则表现只是"请求一直没响应"
      this.logger.error(`收到畸形的宿主信封（${checked.code}）：${checked.why}`)
      return
    }
    this.handleEnvelope(checked.env)
  }

  private handleEnvelope(envelope: Envelope): void {
    switch (envelope.t) {
      case 'res': {
        const call = this.take(envelope.id)
        if (!call) {
          this.logger.warn(`收到未知 id=${envelope.id} 的 res（已超时或已取消），已丢弃`)
          return
        }
        this.finish(call)
        call.resolve(envelope.result)
        return
      }
      case 'err': {
        const call = this.take(envelope.id)
        if (!call) {
          this.logger.warn(`收到未知 id=${envelope.id} 的 err（已超时或已取消），已丢弃`)
          return
        }
        this.finish(call)
        call.reject(new EhProtocolError(envelope.code, envelope.message, envelope.detail))
        return
      }
      case 'cancel': {
        const call = this.take(envelope.id)
        if (!call) return
        this.finish(call)
        call.reject(
          new EhProtocolError(
            'EH_CANCELLED',
            EH_ERROR_TEXT.EH_CANCELLED,
            `方法 ${call.method}（id=${envelope.id}）被宿主取消`
          )
        )
        return
      }
      case 'event':
        this.dispatchEvent(envelope.channel, envelope.payload)
        return
      case 'log':
        this.dispatchLog(envelope.level, envelope.message)
        return
      case 'req': {
        // 宿主发起的反向 RPC（EH-B3b-2）：先交给渲染侧消费者注册的 `RpcServer`；
        // 没人接（未注册 / 该 handler 不认）才落回 A4 的"不支持"回包——不能沉默，否则宿主挂死。
        const handler = this.hostRequestHandler
        if (handler && handler(envelope)) return
        this.logger.warn(
          `宿主发起 RPC ${envelope.method}#${envelope.id}：渲染侧没有接管者，已回 EH_INTERNAL`
        )
        this.channel.send(
          createErrorEnvelope(
            envelope.id,
            'EH_INTERNAL',
            '渲染侧没有接管宿主发起的 RPC（消费者未启动或已停止）。若这是 UI 能力，请确认扩展宿主开关与主窗口都在。'
          )
        )
        return
      }
      case 'ready':
      case 'initialized':
      case 'activate':
      case 'deactivate':
        // 握手与激活控制由启动器/宿主自己走，渲染侧桥只观测
        this.logger.debug(`收到 ${envelope.t} 信封（渲染侧桥不消费）`)
        return
      case 'init':
      case 'terminate':
        // 主进程 → 宿主方向的信封出现在渲染侧说明有人发错通道；不抛错，留痕即可
        this.logger.warn(`收到不该出现在渲染侧的 ${envelope.t} 信封，已忽略`)
        return
    }
  }

  private dispatchEvent(channel: string, payload: unknown): void {
    let delivered = false
    if (channel !== ANY_EVENT_CHANNEL) {
      const listeners = this.eventListeners.get(channel)
      if (listeners) {
        delivered = this.callEventListeners(listeners, payload)
      }
    }
    const anyListeners = this.eventListeners.get(ANY_EVENT_CHANNEL)
    if (anyListeners) {
      delivered = this.callEventListeners(anyListeners, payload) || delivered
    }
    if (!delivered) {
      // 还没人订阅不是错误：A5 的 UI 消费者尚未接上（A4 只保证总线可用）
      this.logger.debug(`收到未订阅的宿主事件 channel=${channel}，已丢弃`)
    }
  }

  private callEventListeners(
    listeners: Set<(payload: unknown) => void>,
    payload: unknown
  ): boolean {
    let called = false
    for (const listener of [...listeners]) {
      called = true
      try {
        listener(payload)
      } catch (error) {
        this.logger.error(`宿主事件订阅者抛错：${describeError(error)}`)
      }
    }
    return called
  }

  /** 宿主日志 → 渲染侧 console（`level` 原样映射）；UI 想收集就另订阅 */
  private dispatchLog(level: LogLevel, message: string): void {
    const line = `[host] ${message}`
    switch (level) {
      case 'debug':
        console.debug(line)
        break
      case 'info':
        console.info(line)
        break
      case 'warn':
        console.warn(line)
        break
      case 'error':
        console.error(line)
        break
    }
    for (const listener of [...this.logListeners]) {
      try {
        listener(level, message)
      } catch (error) {
        this.logger.error(`宿主日志订阅者抛错：${describeError(error)}`)
      }
    }
  }

  private applyStatus(status: ExtensionHostStatusSnapshot): void {
    this.status = { ...status }
    for (const listener of [...this.statusListeners]) {
      try {
        listener(this.getStatus())
      } catch (error) {
        this.logger.error(`宿主状态订阅者抛错：${describeError(error)}`)
      }
    }
  }

  /** 取出并注销在途请求（不结定时器：调用方马上要 finish） */
  private take(id: number): PendingCall | undefined {
    const call = this.pending.get(id)
    if (!call) return undefined
    this.pending.delete(id)
    return call
  }

  /** 清掉定时器（响应已到/已取消/已超时） */
  private finish(call: PendingCall): void {
    clearTimeout(call.timer as Parameters<typeof clearTimeout>[0])
  }

  /** 本地结掉一个在途请求（超时/发送失败/释放） */
  private settleLocally(id: number, error: EhProtocolError): void {
    const call = this.take(id)
    if (!call) return
    this.finish(call)
    call.reject(error)
  }
}

/** 创建一个桥（**不发起任何请求**，只挂订阅） */
export function createExtensionHostBridge(
  options: ExtensionHostBridgeOptions = {}
): ExtensionHostBridge {
  return new ExtensionHostBridgeImpl(options)
}

/* -------------------------------------------------------------------------------------------- */
/* 默认通道（window.eh + window.api）与单例                                                       */
/* -------------------------------------------------------------------------------------------- */

/** 取 preload 暴露面（非 Electron 环境 / preload 未注入时为 undefined） */
function windowSurface(): ExtensionHostBridgeSurface | undefined {
  if (typeof window === 'undefined') return undefined
  return window.eh
}

/**
 * 默认通道：下行 `window.eh.post`，上行 `window.eh.onMessage`，状态走 `ipcRenderer` 转发的
 * `eh:status` / `eh:get-status`，端口状态走 A2 的 `eh:get-port`。
 */
export function createWindowChannel(): ExtensionHostChannel {
  const noop = (): void => undefined
  return {
    isReady: (): boolean => windowSurface()?.hasPort() === true,
    send: (envelope: Envelope): boolean => windowSurface()?.post(envelope) === true,
    onEnvelope: (listener: (raw: unknown) => void): (() => void) =>
      windowSurface()?.onMessage(listener) ?? noop,
    onStatus: (listener: (status: ExtensionHostStatusSnapshot) => void): (() => void) =>
      windowSurface()?.onStatus(listener) ?? noop,
    readStatus: async (): Promise<ExtensionHostStatusSnapshot | null> => {
      if (typeof window === 'undefined') return null
      try {
        return await window.api.ehGetStatus()
      } catch (error) {
        console.warn(`[eh] ehGetStatus 失败：${describeError(error)}`)
        return null
      }
    },
    readPortStatus: async (): Promise<ExtensionHostPortStatus | null> => {
      if (typeof window === 'undefined') return null
      try {
        return await window.api.ehGetPort()
      } catch (error) {
        console.warn(`[eh] ehGetPort 失败：${describeError(error)}`)
        return null
      }
    }
  }
}

/** 进程内单例（A5 / 扩展管理器订阅它，避免每次拿桥都新订阅一条通道） */
let bridgeSingleton: ExtensionHostBridge | null = null
let connected = false

/** 取单例（**不建立连接**；开关关闭时也不会有任何副作用） */
export function getExtensionHostBridge(): ExtensionHostBridge {
  if (!bridgeSingleton) bridgeSingleton = createExtensionHostBridge()
  return bridgeSingleton
}

/**
 * 交接成功后调用（幂等）：把状态迁移写进渲染侧日志并校准一次当前快照。
 *
 * 只在开关打开时被 `host.start()` 调用一次；开关关闭时**永远不会**走到这里。
 * 另外接上"运行中崩溃 ⇒ 自动回退"（EH-D2a 需求 4）：`phase=crashed` 时走
 * `handleExtensionHostCrash()`，与启动失败同一条回退通路。
 */
export function connectExtensionHostBridge(): ExtensionHostBridge {
  const bridge = getExtensionHostBridge()
  if (connected) return bridge
  connected = true
  let lastPhase: ExtensionHostPhase | null = null
  bridge.onStatus((status) => {
    if (status.phase === lastPhase) return
    lastPhase = status.phase
    const crash = status.lastCrash ? `，最近崩溃：${describeCrash(status.lastCrash)}` : ''
    console.info(`[eh] 扩展宿主状态：${status.phase}${crash}`)
    // 已经 ready 之后又崩：扩展随宿主一起没了，必须回退并把它们救回渲染进程（见 handleExtensionHostCrash）
    if (status.phase === 'crashed') handleExtensionHostCrash(status)
  })
  void bridge.refreshStatus()
  return bridge
}

/* -------------------------------------------------------------------------------------------- */
/* 清单交接                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** 交接参数 */
export interface ExtensionHostHandoverOptions {
  /**
   * **已判定的**开关编码（`readExtensionHostFlag()` 返回的 `'1'` / `'0'`；单测直接传原文）。
   *
   * 优先级判定不在这里做（唯一出处是 `resolveExtensionHostSwitch()`）：传进来的就是结论，
   * 本函数只把 `1`/`true` 认成开。传 `null`/`undefined` 一律按关（子窗口不交接宿主）。
   */
  flag: string | null | undefined
  /** 用户扩展清单（`collectHostedExtensions()` 产出；开关关闭时逐字不使用） */
  extensions: HostedExtensionInfo[]
  /** 发起 start 的 IPC（默认 `window.api.ehStart`） */
  start?(extensions: HostedExtensionInfo[]): Promise<ExtensionHostStartOutcome>
  logger?: ExtensionHostBridgeLogger
  /**
   * 启动失败后用**重新加载本窗口**来让回退真正生效（默认 `window.location.reload()`）。
   *
   * 传 `null` = 不重载（单测/无浏览器环境）；传函数 = 用它替代默认实现。
   */
  reload?: (() => void) | null
}

/** 交接结果：**开关关闭时 `started` 恒为 `null`、`extensions` 恒为空** */
export interface ExtensionHostHandover {
  /** 开关是否打开（打开 ⇒ 渲染侧跳过用户扩展的 `activateExtension`） */
  enabled: boolean
  /** 真正交给宿主的清单（开关关闭时为空数组） */
  extensions: HostedExtensionInfo[]
  /** 交接结果（开关关闭时为 `null`；永不 reject） */
  started: Promise<ExtensionHostStartOutcome> | null
}

/** 默认 start：经 preload 的 `ehStart` 请求 main 启动宿主 */
async function defaultStart(extensions: HostedExtensionInfo[]): Promise<ExtensionHostStartOutcome> {
  if (typeof window === 'undefined') {
    throw new Error('没有渲染进程环境（window 未定义）')
  }
  return await window.api.ehStart(extensions)
}

/**
 * **交接**：开关打开时把用户扩展清单交给 main 并请它 `start()` 宿主。
 *
 * 开关关闭时返回 `{ enabled: false, extensions: [], started: null }`，**不读 window、
 * 不发 IPC、不 start**（2.0.0 起"默认开"，所以这条路径只在用户关掉设置项 / 环境变量显式关 /
 * 本窗口已回退时走到；语义与旧实现逐字相同）。
 *
 * 交接结果永不 reject：`ehStart` 失败只降级成日志 + `ok:false` + **自动回退**
 * （`applyRendererFallback`：一次明确日志 + 会话标记 + 重新加载窗口），否则会打断
 * `host.start()` 后续的贡献点注册（UI 会整个起不来），或者让用户看到"所有扩展消失"。
 */
export function handOverToExtensionHost(
  options: ExtensionHostHandoverOptions
): ExtensionHostHandover {
  const logger = options.logger ?? consoleLogger
  if (!isExtensionHostEnabled(options.flag)) {
    return { enabled: false, extensions: [], started: null }
  }

  const extensions = [...options.extensions]
  const start = options.start ?? defaultStart
  // 日志带**来源**：用户报"为什么扩展跑在主界面进程"时，这一行就是答案
  const source = readExtensionHostSwitch().source
  logger.info(
    `扩展宿主开关已打开（来源：${EXTENSION_HOST_SOURCE_TEXT[source]}）：` +
      `${extensions.length} 个用户扩展交给扩展宿主，渲染侧只注册贡献点、不激活`
  )

  const started = (async (): Promise<ExtensionHostStartOutcome> => {
    try {
      const outcome = await start(extensions)
      if (outcome.ok) {
        logger.info(`扩展宿主已启动（hostId=${outcome.hostId} pid=${outcome.pid}）`)
        return outcome
      }
      // 启动失败 ⇒ 自动回退到渲染进程（需求 4）。降级不抛错，调用方照旧继续启动 UI。
      applyRendererFallback({
        reason: `启动失败 ${outcome.code}`,
        detail: outcome.message + (outcome.detail ? ` / ${outcome.detail}` : ''),
        hostedCount: extensions.length,
        logger,
        reload: options.reload
      })
      return outcome
    } catch (error) {
      // IPC 本身失败（handler 未注册 / 窗口正在关闭）：不抛出去，避免打断 host.start()
      const detail = describeError(error)
      applyRendererFallback({
        reason: '启动请求失败',
        detail,
        hostedCount: extensions.length,
        logger,
        reload: options.reload
      })
      return { ok: false, code: 'EH_INTERNAL', message: `扩展宿主启动请求失败：${detail}` }
    }
  })()

  return { enabled: true, extensions, started }
}
