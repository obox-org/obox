/**
 * 扩展宿主进程的**启动器**（Extension Host Starter）—— ADR-0026 / 任务卡 EH-A2。
 *
 * 职责只有五件，多一件都不要往这里加（业务 RPC、清单加载、扩展激活属于 EH-A3/A4）：
 * 1. **fork**：把宿主入口用 `utilityProcess.fork(entry, args, { stdio: 'pipe', serviceName, env })` 拉起来；
 *    入口路径**由调用方传入**（本卡不硬编码 A3 的产物路径），env 注入 `EH_DATA_DIR`。
 * 2. **握手**：等 `ready`（`validateEnvelope` 校验）→ 回 `init`（`apiVersion` / `dataDir` / `extensions`）
 *    → 等 `initialized`；全程 10s 上限，超时返回**结构化失败**（`{ ok: false, code: 'EH_TIMEOUT' }`），
 *    不抛未捕获异常。
 * 3. **两条通道**（ADR-0026）：`host-main` 直接复用 `utilityProcess.postMessage / on('message')`；
 *    `host-renderer` 用 `MessageChannelMain` 建一对端口，**port1 随 init 信封交给宿主**（transfer），
 *    **port2 经 `webContents.postMessage('eh:port', …)` 交给主窗口**（窗口未就绪时排队）。
 * 4. **崩溃计数**：`exit` ⇒ 记录 `{ code, at }`；5 分钟窗口内 <3 次自动重启，达 3 次标记 `crashed`
 *    且不再重启，`lastCrash` 留给上层弹窗。
 * 5. **判活**：`host.ping` 请求发出后 `ACK_TIMEOUT_MS`（3s）内没收到 `res`/`err`/`cancel` ⇒ 标记
 *    `unresponsive`。**只观测，不杀也不重启**（ADR-0026 决策 7）——宿主里跑的是用户的完整 Node 代码，
 *    一次同步 IO 就可能超过 3s，杀进程的代价远大于一次慢请求。
 *
 * ## 可测试性（本卡硬要求）
 *
 * `utilityProcess` / `MessageChannelMain` / `webContents` / 定时器 / 日志 / 强杀全部走
 * `ExtensionHostStarterDeps` 注入，默认实现才碰真的 Electron API。于是**单测可以完全不起进程**：
 * 注入假 `fork` 拿到 `ExtensionHostProcessLike` 句柄，直接 `emitMessage` / `emitExit` 驱动状态机，
 * 注入假定时器精确推进 10s/3s/5s/5min。
 *
 * ## 与 A3/A4 的接口约定（写在这里，避免两张卡各猜一套）
 *
 * - 宿主必须应答 `host.ping`（回 `res` 或 `err` 都算 ack），否则 10s 后会被标 `unresponsive`；
 * - 渲染侧拿到端口的**唯一**途径是 `webContents.postMessage('eh:port', …)` 的 transfer；
 *   `eh:get-port` 只回报**状态**（见 `describeRendererPort`）；
 * - 页面的 preload 需要在 `ipcRenderer.on('eh:port', (e) => { const port = e.ports[0]; port.start() })`
 *   里接住端口（`MessagePortMain`/`MessagePort` 在 `start()` 之前消息是排队的）。
 */
import { ipcMain, MessageChannelMain, utilityProcess } from 'electron'
import {
  ACK_TIMEOUT_MS,
  EH_ERROR_TEXT,
  PROTOCOL_VERSION,
  TERMINATE_GRACE_MS,
  createInitEnvelope,
  createRequestEnvelope,
  createTerminateEnvelope,
  validateEnvelope,
  type EhErrorCode,
  type Envelope,
  type HostedExtensionInfo,
  type ProtocolVersion
} from '../shared/extensionHostProtocol'
import { getMainWindow } from './window'

/* -------------------------------------------------------------------------------------------- */
/* 常量                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** `ProcessMetric` / `child-process-gone` 里显示的宿主进程名（ADR-0026 决策 2） */
export const HOST_SERVICE_NAME = 'extension-host'

/** 握手总上限：fork 之后 10s 内必须走完 `ready → init → initialized` */
export const HANDSHAKE_TIMEOUT_MS = 10_000

/** 崩溃计数窗口（ADR-0026 决策 7：5 分钟） */
export const CRASH_WINDOW_MS = 5 * 60_000

/** 崩溃阈值：窗口内达 3 次就不再自动重启 */
export const CRASH_LIMIT = 3

/**
 * 自动重启前的等待。**不设 0**：宿主崩溃往往伴随大量磁盘/CPU 抖动，立刻重启容易连撞三次把
 * 5 分钟预算烧光；500ms 足够让上一次的退出收尾，又不会让 UI 明显等待。
 */
export const RESTART_DELAY_MS = 500

/** 判活请求的方法名（宿主侧 A3 必须应答；回 `res`/`err` 都算 ack） */
export const HEARTBEAT_METHOD = 'host.ping'

/** 两次判活请求之间的间隔（比 `ACK_TIMEOUT_MS` 宽，避免慢请求叠成误报） */
export const ACK_PING_INTERVAL_MS = 10_000

/** 交付 host-renderer 端口时用的渲染侧 channel（preload 里 `ipcRenderer.on('eh:port')`） */
export const RENDERER_PORT_CHANNEL = 'eh:port'

/** 渲染侧查询端口状态的 IPC（**只回状态**，端口只能经 `postMessage` transfer） */
export const RENDERER_PORT_IPC = 'eh:get-port'

/** 主窗口还没就绪时的重试间隔（轮询窗口是否可投递） */
export const RENDERER_READY_RETRY_MS = 250

/**
 * 交付端口的最长重试次数（250ms × 240 ≈ 60s）。超时不丢端口，只是停止轮询：
 * 剩下那次机会留给 A4 在渲染侧报告就绪后显式调 `flushRendererPort()`。
 */
export const RENDERER_DELIVERY_MAX_ATTEMPTS = 240

/** 注入宿主环境变量的名字：宿主可写的数据目录（与 main 的 `userData` 同源） */
export const EH_DATA_DIR_ENV = 'EH_DATA_DIR'

/** ADR-0026 决策 8：obox 2.0 的扩展 API 版本 */
export const DEFAULT_HOST_API_VERSION = 3

/** 合成退出码：握手超时（真实退出码在 Windows/POSIX 上都是非负，负数专用于启动器合成的原因） */
export const EXIT_CODE_HANDSHAKE_TIMEOUT = -1

/** 合成退出码：入口无法拉起（路径不存在 / `fork` 同步抛错） */
export const EXIT_CODE_FORK_FAILED = -2

/* -------------------------------------------------------------------------------------------- */
/* 状态                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * 宿主生命周期阶段。**没有单独的 `restarting`**：自动重启期间同样是 `starting`，用
 * `crashCount`/`lastCrash` 区分「首次启动」与「崩溃后重启」，少一个状态就少一处漏判。
 */
export type ExtensionHostPhase =
  'idle' | 'starting' | 'ready' | 'unresponsive' | 'crashed' | 'stopped'

/** 一次非主动退出（或启动失败）的原因：`code` 只是退出码，**不含**信号名（utilityProcess 不提供） */
export interface ExtensionHostCrash {
  code: number
  /** 发生时间（ms epoch） */
  at: number
}

/** 状态快照（`onStatus` 订阅者收到的是它，不是可变对象） */
export interface ExtensionHostStatus {
  phase: ExtensionHostPhase
  /** 宿主自报的 id（`ready.hostId`）；未握手成功为 `null` */
  hostId: string | null
  /** 宿主进程 pid（`ready.pid`）；未握手成功为 `null` */
  pid: number | null
  /** 5 分钟窗口内的崩溃次数（= 本次启动已用掉的自动重启预算） */
  crashCount: number
  /** 最近一次崩溃/启动失败的原因（上层弹窗用）；从未失败为 `null` */
  lastCrash: ExtensionHostCrash | null
  /** 最近一次收到宿主合法信封的时间（判活信号）；还没收到过为 `null` */
  lastAckAt: number | null
}

/** `start()` 的结果：**永远 resolve**，失败走 `ok: false`，调用方不必 try/catch */
export type ExtensionHostStartResult =
  | { ok: true; hostId: string; pid: number }
  | { ok: false; code: EhErrorCode; message: string; detail?: string }

/** 把崩溃原因翻成一句可以直接进弹窗的中文（合成退出码有专属文案） */
export function describeExtensionHostCrash(crash: ExtensionHostCrash): string {
  switch (crash.code) {
    case EXIT_CODE_HANDSHAKE_TIMEOUT:
      return `扩展宿主在 ${HANDSHAKE_TIMEOUT_MS / 1000} 秒内没有完成握手（无响应或入口加载失败）`
    case EXIT_CODE_FORK_FAILED:
      return '扩展宿主入口无法拉起（入口文件缺失或 fork 失败）'
    default:
      return `扩展宿主进程异常退出（退出码 ${crash.code}）`
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 可注入依赖（默认实现见文件末尾）                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * `MessagePortMain` 的最小结构（只做转移，A2 自己不读写端口里的消息）。
 *
 * `transfer` 刻意写 `unknown[]` 而不是 `ExtensionHostPortLike[]`：`MessagePortMain` 与它互相
 * 引用会让结构比较打成环，`unknown[]` 既满足"能转移端口"，也保留 `WebContents`/`UtilityProcess`
 * 原签名的可赋值性。
 */
export interface ExtensionHostPortLike {
  postMessage(message: unknown, transfer?: unknown[]): void
  close(): void
}

/** 宿主进程句柄的最小结构（`utilityProcess.fork()` 的返回值即满足） */
export interface ExtensionHostProcessLike {
  readonly pid?: number | undefined
  readonly stdout: ExtensionHostReadableLike | null
  readonly stderr: ExtensionHostReadableLike | null
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  postMessage(message: unknown, transfer?: unknown[]): void
  kill(): boolean
}

/** 只读流的最小结构（`child.stdout`/`child.stderr`，`stdio: 'pipe'` 下才有） */
export interface ExtensionHostReadableLike {
  on(event: 'data', listener: (chunk: unknown) => void): unknown
}

/** fork 选项（是 `ForkOptions` 的子集；`stdio: 'pipe'` 才能转发 stdout/stderr） */
export interface ExtensionHostForkOptions {
  stdio: 'pipe'
  serviceName: string
  env: Record<string, string | undefined>
}

/** 渲染进程目标（`webContents` 即满足；抽出来是为了单测注入假窗口） */
export interface ExtensionHostRendererTarget {
  isDestroyed(): boolean
  postMessage(channel: string, message: unknown, transfer: unknown[]): void
}

/** 主窗口（`BrowserWindow` 即满足） */
export interface ExtensionHostWindowLike {
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
}

/** 定时器（默认用全局 `setTimeout`；单测注入可控时钟，才能精确推进 10s/3s/5min） */
export interface ExtensionHostTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

/** 日志出口（默认 `console`；主进程可换成自己的日志器） */
export interface ExtensionHostLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 全部可注入依赖 */
export interface ExtensionHostStarterDeps {
  fork(
    entryPoint: string,
    args: string[],
    options: ExtensionHostForkOptions
  ): ExtensionHostProcessLike
  createMessageChannel(): { port1: ExtensionHostPortLike; port2: ExtensionHostPortLike }
  getRendererTarget(): ExtensionHostRendererTarget | null
  /** 宽限期后仍然不退出时的最后一手（默认 `process.kill(pid, 'SIGKILL')`） */
  forceKill(pid: number): void
  timers: ExtensionHostTimers
  logger: ExtensionHostLogger
}

/* -------------------------------------------------------------------------------------------- */
/* 对外接口                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** 创建启动器的参数 */
export interface ExtensionHostStarterOptions {
  /** 宿主入口的绝对路径（A3 的产物 / 测试 fixture 都由调用方给，本模块不猜） */
  entryPoint: string
  /** 传给入口的 argv（默认空） */
  args?: string[]
  /** 交给宿主的 apiVersion（ADR-0026 决策 8：3） */
  apiVersion?: number
  /** 宿主可写的数据目录（同时经 `EH_DATA_DIR` 注入 env） */
  dataDir: string
  /** 要加载的扩展清单摘要（本卡允许空数组，A4 再接清单） */
  extensions?: HostedExtensionInfo[]
  /** 额外注入给宿主的环境变量（覆盖 `EH_DATA_DIR`） */
  env?: Record<string, string | undefined>
  /** 依赖注入（默认用真 Electron API） */
  deps?: Partial<ExtensionHostStarterDeps>
}

/** `eh:get-port` 的返回：**只有状态**，没有端口 */
export interface RendererPortDescription {
  phase: ExtensionHostPhase
  /** 端口是否已经交给某个渲染进程（true 而页面没有端口 = 页面在交付之后重新加载过） */
  portDelivered: boolean
  /** 端口是否还挂在启动器手里等窗口就绪 */
  portPending: boolean
  hostId: string | null
  pid: number | null
  /** 端口实际投递用的 channel（渲染侧照它监听） */
  channel: string
  protocolVersion: ProtocolVersion
}

/** `eh:port` 的载荷（**不是信封**：信封字段是封闭集合，端口靠 transfer 列表走，不塞字段） */
export interface RendererPortPayload {
  v: ProtocolVersion
  hostId: string | null
  pid: number | null
}

/** 启动器句柄 */
export interface ExtensionHostStarter {
  /** 启动（幂等）：已就绪直接回 ok；崩溃后手动调用 = 重置 5 分钟预算再试一次 */
  start(): Promise<ExtensionHostStartResult>
  /** 主动停止（幂等）：先发 `terminate` + `kill()`，宽限 `TERMINATE_GRACE_MS` 后强杀 */
  stop(): Promise<void>
  /** 应用退出清理（幂等）：解绑窗口/注销 IPC/清定时器 + `stop()` */
  dispose(): Promise<void>
  /** 绑定主窗口：`closed` 即终止宿主（可重复调用，最后一次生效） */
  bindWindow(window: ExtensionHostWindowLike): void
  /** 注册 `eh:get-port`（幂等） */
  registerIpc(): void
  /** 订阅状态变化，返回退订函数 */
  onStatus(listener: (status: ExtensionHostStatus) => void): () => void
  /** 读当前快照 */
  getStatus(): ExtensionHostStatus
  /**
   * `host-main` 通道发送（A3/A4 发 `activate`/`deactivate`/`req` 用）。
   * 形状不合法的信封会被拒绝并返回 `false`（不抛错）。
   */
  send(envelope: Envelope): boolean
  /** 订阅宿主经 `host-main` 发来的信封（握手类信封也一并转发，订阅者自己筛） */
  onEnvelope(listener: (envelope: Envelope) => void): () => void
  /** 立刻尝试把挂起的渲染侧端口投递出去；成功返回 true */
  flushRendererPort(): boolean
}

/** 定时器槽位（统一管理，退出时一次清完，避免漏一个 timer 让进程无法退出） */
type TimerSlot = 'handshake' | 'ping' | 'ack' | 'restart' | 'grace' | 'renderer'

/** 简单 deferred（`start()`/`stop()` 各需要一个可从内部 resolve 的 promise） */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** 把未知错误压成一行，用于日志/`detail` */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** stdout/stderr 的 chunk（Buffer|string）转文本 */
function toStreamText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8')
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk).toString('utf8')
  return String(chunk)
}

/* -------------------------------------------------------------------------------------------- */
/* 实现                                                                                          */
/* -------------------------------------------------------------------------------------------- */

class ExtensionHostStarterImpl implements ExtensionHostStarter {
  private readonly entryPoint: string
  private readonly args: string[]
  private readonly apiVersion: number
  private readonly dataDir: string
  private readonly extensions: HostedExtensionInfo[]
  private readonly extraEnv: Record<string, string | undefined>
  private readonly deps: ExtensionHostStarterDeps

  private phase: ExtensionHostPhase = 'idle'
  private process: ExtensionHostProcessLike | null = null
  private hostId: string | null = null
  private pid: number | null = null
  private lastCrash: ExtensionHostCrash | null = null
  private lastAckAt: number | null = null
  private readonly crashes: ExtensionHostCrash[] = []
  /** 非空表示这次退出是主动的（`stop` / 启动失败清理），不计入崩溃也不会重启 */
  private stopReason: 'stop' | 'failure' | null = null
  private disposed = false
  private ipcRegistered = false

  /** 还没随 `init` 转移给宿主的 port1 */
  private hostPort: ExtensionHostPortLike | null = null
  /** 还没交给渲染进程的 port2 */
  private rendererPort: ExtensionHostPortLike | null = null
  private rendererDelivered = false
  private rendererAttempts = 0

  private boundWindow: ExtensionHostWindowLike | null = null

  private pendingStart: Deferred<ExtensionHostStartResult> | null = null
  private pendingStop: Deferred<void> | null = null
  private pendingAck: { id: number; at: number } | null = null
  /** 判过「无响应」的那次 ping id：迟到的 ack 靠它识别"恢复了" */
  private timedOutAckId: number | null = null
  private nextRequestId = 1
  private initSent = false

  private readonly timerHandles = new Map<TimerSlot, unknown>()
  private readonly statusListeners = new Set<(status: ExtensionHostStatus) => void>()
  private readonly envelopeListeners = new Set<(envelope: Envelope) => void>()

  constructor(options: ExtensionHostStarterOptions) {
    this.entryPoint = options.entryPoint
    this.args = options.args ?? []
    this.apiVersion = options.apiVersion ?? DEFAULT_HOST_API_VERSION
    this.dataDir = options.dataDir
    this.extensions = options.extensions ?? []
    this.extraEnv = options.env ?? {}
    this.deps = { ...defaultDeps(), ...options.deps }
  }

  /* ------------------------------ 对外：启动 / 停止 ------------------------------ */

  async start(): Promise<ExtensionHostStartResult> {
    if (this.disposed) {
      return {
        ok: false,
        code: 'EH_INTERNAL',
        message: '扩展宿主启动器已释放（应用正在退出），无法再启动宿主'
      }
    }
    if (this.phase === 'ready' || this.phase === 'unresponsive') {
      return { ok: true, hostId: this.hostId ?? 'unknown', pid: this.pid ?? 0 }
    }
    if (this.pendingStart) return this.pendingStart.promise

    const pending = deferred<ExtensionHostStartResult>()
    this.pendingStart = pending
    // 达阈值后手动 start() = 用户在上层弹窗里选了「重启宿主」：重置 5 分钟预算
    // （`lastCrash` 保留，它是"最近一次崩溃原因"，弹窗还要显示）
    if (this.phase === 'crashed') this.crashes.length = 0
    // 已在 `starting`（崩溃后的自动重启在途/已排期）：只挂上这个 deferred，别重复 fork
    if (this.phase !== 'starting') this.launch()
    return pending.promise
  }

  async stop(): Promise<void> {
    this.stopTimers('ping', 'ack', 'restart', 'renderer')
    this.rendererAttempts = 0
    this.pendingAck = null
    this.timedOutAckId = null
    this.setPhase('stopped')
    // 还在握手就被叫停：把 start() 的 promise 结掉，否则调用方永远等不到结果
    this.resolvePendingStart({
      ok: false,
      code: 'EH_CANCELLED',
      message: '扩展宿主启动被取消（stop()）：链路已断开，可按需重新 start()'
    })
    if (!this.process) {
      this.stopReason = null
      this.hostPort = null
      this.rendererPort = null
      this.rendererDelivered = false
      this.resolvePendingStop()
      return
    }
    await this.terminateProcess('stop')
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.boundWindow = null
    if (this.ipcRegistered) {
      ipcMain.removeHandler(RENDERER_PORT_IPC)
      this.ipcRegistered = false
    }
    this.statusListeners.clear()
    this.envelopeListeners.clear()
    await this.stop()
    // `stop()` 里起的宽限定时器也要清掉：应用退出后没必要再留着强杀兜底
    this.stopTimers('grace')
  }

  bindWindow(target: ExtensionHostWindowLike): void {
    this.boundWindow = target
    if (target.isDestroyed()) {
      this.boundWindow = null
      return
    }
    target.once('closed', () => {
      // 只有"当前绑定的那个窗口"关闭才算数（重复 bindWindow 时旧窗口的 closed 要忽略）
      if (this.boundWindow !== target) return
      this.boundWindow = null
      this.deps.logger.info('主窗口已关闭：扩展宿主随之终止（ADR-0026：随窗口同生共死）')
      void this.stop()
    })
  }

  registerIpc(): void {
    if (this.ipcRegistered) return
    this.ipcRegistered = true
    // 只能回状态：`ipcMain.handle` 的返回值走结构化克隆，MessagePort **不能**从 invoke 返回，
    // 端口唯一的交付方式是 `webContents.postMessage(channel, payload, [port])`。
    ipcMain.handle(RENDERER_PORT_IPC, () => this.describeRendererPort())
  }

  onStatus(listener: (status: ExtensionHostStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  getStatus(): ExtensionHostStatus {
    return {
      phase: this.phase,
      hostId: this.hostId,
      pid: this.pid,
      crashCount: this.crashCount(),
      lastCrash: this.lastCrash === null ? null : { ...this.lastCrash },
      lastAckAt: this.lastAckAt
    }
  }

  send(envelope: Envelope): boolean {
    const checked = validateEnvelope(envelope)
    if (!checked.ok) {
      this.deps.logger.error(`拒绝发送畸形信封：${checked.why}`)
      return false
    }
    if (!this.process) {
      this.deps.logger.warn(`扩展宿主未运行，信封 ${envelope.t} 被丢弃`)
      return false
    }
    return this.postToHost(checked.env)
  }

  onEnvelope(listener: (envelope: Envelope) => void): () => void {
    this.envelopeListeners.add(listener)
    return () => {
      this.envelopeListeners.delete(listener)
    }
  }

  flushRendererPort(): boolean {
    return this.tryDeliverRendererPort()
  }

  /* ------------------------------ fork 与握手 ------------------------------ */

  private launch(): void {
    this.stopReason = null
    this.initSent = false
    this.hostId = null
    this.pid = null
    this.rendererAttempts = 0
    this.rendererDelivered = false
    this.setPhase('starting')

    let channel: { port1: ExtensionHostPortLike; port2: ExtensionHostPortLike }
    try {
      channel = this.deps.createMessageChannel()
    } catch (error) {
      this.failStart('EH_INTERNAL', EXIT_CODE_FORK_FAILED, '无法创建宿主通道', describeError(error))
      return
    }
    this.hostPort = channel.port1
    this.rendererPort = channel.port2

    let host: ExtensionHostProcessLike
    try {
      host = this.deps.fork(this.entryPoint, this.args, {
        stdio: 'pipe',
        serviceName: HOST_SERVICE_NAME,
        env: { ...globalThis.process.env, [EH_DATA_DIR_ENV]: this.dataDir, ...this.extraEnv }
      })
    } catch (error) {
      this.hostPort = null
      this.rendererPort = null
      this.failStart(
        'EH_INTERNAL',
        EXIT_CODE_FORK_FAILED,
        '扩展宿主入口无法拉起',
        `${this.entryPoint}：${describeError(error)}`
      )
      return
    }

    this.process = host
    this.attachProcess(host)
    this.deps.logger.info(`扩展宿主已 fork：${this.entryPoint}（serviceName=${HOST_SERVICE_NAME}）`)
    this.startTimer('handshake', () => this.onHandshakeTimeout(), HANDSHAKE_TIMEOUT_MS)
    // 端口一建好就开始尝试投递（窗口通常已就绪；未就绪就排队重试）
    this.scheduleRendererDelivery()
  }

  private attachProcess(host: ExtensionHostProcessLike): void {
    host.on('message', (message) => {
      if (this.process !== host) return
      this.onMessage(message)
    })
    host.on('exit', (code) => {
      if (this.process !== host) return
      this.onExit(code)
    })
    host.stdout?.on('data', (chunk) => this.forwardStream('stdout', 'info', chunk))
    host.stderr?.on('data', (chunk) => this.forwardStream('stderr', 'warn', chunk))
  }

  /** stdout/stderr 转发到主进程日志：打包后宿主的标准输出默认没人看（stdio: 'pipe'） */
  private forwardStream(tag: string, level: 'info' | 'warn', chunk: unknown): void {
    const text = toStreamText(chunk).replace(/\r?\n$/, '')
    if (text === '') return
    this.deps.logger[level](`[host:${tag}] ${text}`)
  }

  private onMessage(message: unknown): void {
    const checked = validateEnvelope(message)
    if (!checked.ok) {
      // 畸形信封不致命（可能是 A3 还没对齐的字段），但必须留痕，否则只会表现为"没反应"
      this.deps.logger.warn(`宿主发来畸形信封（${checked.code}）：${checked.why}`)
      return
    }
    const envelope = checked.env
    this.lastAckAt = this.deps.timers.now()
    this.emitEnvelope(envelope)

    switch (envelope.t) {
      case 'ready':
        this.onReady(envelope.hostId, envelope.pid)
        return
      case 'initialized':
        this.onInitialized()
        return
      case 'res':
      case 'err':
      case 'cancel':
        this.onAck(envelope.id)
        return
      case 'log':
        // 宿主的结构化日志：主进程直接落到自己的日志里（A3/A4 也能从 onEnvelope 再收一份）
        this.deps.logger[envelope.level](`[host] ${envelope.message}`)
        return
      default:
        // activate/deactivate/req/event 属于 A3/A4 的消费者，A2 只做透传
        return
    }
  }

  private onReady(hostId: string, pid: number): void {
    if (this.phase !== 'starting' || this.initSent) {
      this.deps.logger.warn(`忽略意外的 ready（phase=${this.phase}, initSent=${this.initSent}）`)
      return
    }
    this.hostId = hostId
    this.pid = pid
    const port = this.hostPort
    if (!port) {
      this.deps.logger.warn('忽略 ready：host-renderer 的 port1 已不在启动器手里')
      return
    }
    this.hostPort = null
    this.initSent = true
    // 关键：port1 走 transfer 列表，**不放进信封字段**（信封字段是封闭集合，多一个就畸形）
    this.postToHost(
      createInitEnvelope({
        apiVersion: this.apiVersion,
        dataDir: this.dataDir,
        extensions: this.extensions
      }),
      [port]
    )
    this.deps.logger.info(
      `宿主就绪（hostId=${hostId} pid=${pid}），已发 init：apiVersion=${this.apiVersion}，extensions=${this.extensions.length} 个`
    )
  }

  private onInitialized(): void {
    if (this.phase !== 'starting' || !this.initSent) {
      this.deps.logger.warn(
        `忽略意外的 initialized（phase=${this.phase}, initSent=${this.initSent}）`
      )
      return
    }
    this.stopTimers('handshake')
    this.setPhase('ready')
    this.deps.logger.info('扩展宿主握手完成（initialized）')
    this.resolvePendingStart({
      ok: true,
      hostId: this.hostId ?? 'unknown',
      pid: this.pid ?? 0
    })
    this.scheduleAckPing()
  }

  private onHandshakeTimeout(): void {
    if (this.phase !== 'starting') return
    const waitingFor = this.initSent ? 'initialized' : 'ready'
    this.failStart(
      'EH_TIMEOUT',
      EXIT_CODE_HANDSHAKE_TIMEOUT,
      EH_ERROR_TEXT.EH_TIMEOUT,
      `${HANDSHAKE_TIMEOUT_MS}ms 内没等到 ${waitingFor} 信封（入口 ${this.entryPoint}）`
    )
  }

  /**
   * 启动失败：标记 `crashed` + 记合成退出码 + 回结构化结果 + 收起进程。
   * 刻意**不计入**崩溃计数——握手超时通常意味着入口写错了，走重启预算只会把 3 次烧在同一个错误上。
   */
  private failStart(
    code: EhErrorCode,
    syntheticExitCode: number,
    message: string,
    detail?: string
  ): void {
    this.stopTimers('handshake', 'ping', 'ack')
    this.lastCrash = { code: syntheticExitCode, at: this.deps.timers.now() }
    this.setPhase('crashed')
    this.deps.logger.error(`扩展宿主启动失败（${code}）：${message}${detail ? ` / ${detail}` : ''}`)
    this.resolvePendingStart({ ok: false, code, message, ...(detail ? { detail } : {}) })
    this.hostPort = null
    this.rendererPort = null
    void this.terminateProcess('failure')
  }

  /* ------------------------------ 退出与重启 ------------------------------ */

  private onExit(code: number): void {
    this.process = null
    this.pid = null
    this.hostPort = null
    this.rendererPort = null
    this.rendererDelivered = false
    this.pendingAck = null
    this.timedOutAckId = null
    this.stopTimers('handshake', 'ping', 'ack', 'grace', 'renderer')

    if (this.stopReason !== null) {
      // 主动退出 / 启动失败清理：阶段已由发起方设置，这里只收尾
      this.deps.logger.info(`扩展宿主已退出（code=${code}，${this.stopReason}）`)
      this.stopReason = null
      this.resolvePendingStop()
      return
    }

    const at = this.deps.timers.now()
    this.crashes.push({ code, at })
    this.pruneCrashes(at)
    this.lastCrash = { code, at }
    const crashCount = this.crashes.length

    if (crashCount >= CRASH_LIMIT) {
      // 达阈值：不重启，把原因留给上层弹窗（ADR-0026 决策 7）
      this.setPhase('crashed')
      this.deps.logger.error(
        `${CRASH_WINDOW_MS / 60_000} 分钟内第 ${crashCount} 次崩溃（code=${code}）：不再自动重启`
      )
      this.resolvePendingStart({
        ok: false,
        code: 'EH_INTERNAL',
        message:
          `${CRASH_WINDOW_MS / 60_000} 分钟内扩展宿主崩溃 ` +
          `${crashCount} 次（已达阈值 ${CRASH_LIMIT}），不再自动重启。` +
          `请在上层弹窗里选择"重启宿主"或"禁用扩展"；原因：${describeExtensionHostCrash({ code, at })}`
      })
      return
    }

    this.setPhase('starting')
    this.deps.logger.warn(
      `扩展宿主崩溃（code=${code}），${RESTART_DELAY_MS}ms 后自动重启（窗口内第 ${crashCount}/${CRASH_LIMIT} 次）`
    )
    this.startTimer(
      'restart',
      () => {
        this.launch()
      },
      RESTART_DELAY_MS
    )
  }

  /**
   * 先礼后兵：`terminate` 信封（让宿主自己清理）+ `kill()`（SIGTERM），宽限 `TERMINATE_GRACE_MS`
   * 之后仍然没退出就强杀。强杀后不再等 `exit`（进程可能已经不响应任何信号外的路径），直接把状态收干净——
   * 退出流程**不能**被一个僵死的子进程拖住。
   */
  private terminateProcess(reason: 'stop' | 'failure'): Promise<void> {
    const host = this.process
    this.stopReason = reason
    if (!host) {
      this.stopReason = null
      this.resolvePendingStop()
      return Promise.resolve()
    }
    const pending = this.pendingStop ?? deferred<void>()
    this.pendingStop = pending
    this.stopTimers('handshake', 'ping', 'ack', 'restart', 'renderer')

    const pid = this.pid ?? host.pid ?? null
    this.postToHost(createTerminateEnvelope(TERMINATE_GRACE_MS))
    let killed = false
    try {
      killed = host.kill()
    } catch (error) {
      this.deps.logger.warn(`kill() 抛错：${describeError(error)}`)
    }
    this.deps.logger.info(
      `要求扩展宿主退出（${reason === 'stop' ? '主动停止' : '启动失败清理'}）：` +
        `已发 terminate + kill(${killed})，宽限 ${TERMINATE_GRACE_MS}ms`
    )

    this.startTimer(
      'grace',
      () => {
        if (this.process !== host) return
        this.deps.logger.warn(
          `扩展宿主在 ${TERMINATE_GRACE_MS}ms 宽限内未退出，强制结束（pid=${pid}）`
        )
        if (pid !== null) {
          this.deps.forceKill(pid)
        } else {
          // 连 pid 都拿不到（进程从没 spawn 成功）：只能再发一次 kill()
          try {
            host.kill()
          } catch {
            // 已经死了就无所谓
          }
        }
        this.process = null
        this.pid = null
        this.resolvePendingStop()
      },
      TERMINATE_GRACE_MS
    )
    return pending.promise
  }

  /* ------------------------------ 判活（只观测） ------------------------------ */

  private scheduleAckPing(): void {
    this.stopTimers('ping')
    if (this.phase !== 'ready') return
    this.startTimer(
      'ping',
      () => {
        this.sendPing()
      },
      ACK_PING_INTERVAL_MS
    )
  }

  private sendPing(): void {
    if (this.phase !== 'ready') return
    const id = this.nextRequestId++
    this.pendingAck = { id, at: this.deps.timers.now() }
    if (!this.postToHost(createRequestEnvelope(id, HEARTBEAT_METHOD, null))) {
      this.pendingAck = null
      return
    }
    this.startTimer(
      'ack',
      () => {
        this.onAckTimeout(id)
      },
      ACK_TIMEOUT_MS
    )
  }

  private onAck(id: number): void {
    if (this.pendingAck && this.pendingAck.id === id) {
      this.pendingAck = null
      this.stopTimers('ack')
      if (this.phase === 'unresponsive') {
        // 迟到的 ack：恢复观测（A2 不改进程状态，只更新 phase）
        this.setPhase('ready')
        this.deps.logger.info('扩展宿主恢复响应（收到迟到的 ack），重新开始判活')
      }
      this.scheduleAckPing()
      return
    }
    // 已经判过无响应的那次 ping 的 ack 迟到：同样算恢复
    if (this.timedOutAckId !== null && this.timedOutAckId === id) {
      this.timedOutAckId = null
      if (this.phase === 'unresponsive') {
        this.setPhase('ready')
        this.deps.logger.info('扩展宿主恢复响应（收到迟到的 ack），重新开始判活')
        this.scheduleAckPing()
      }
    }
  }

  private onAckTimeout(id: number): void {
    if (!this.pendingAck || this.pendingAck.id !== id) return
    this.pendingAck = null
    this.timedOutAckId = id
    if (this.phase !== 'ready') return
    this.setPhase('unresponsive')
    // ADR-0026 决策 7：只观测。不杀、不重启、也不再连着 ping（等迟到的 ack 自己恢复）
    this.deps.logger.warn(
      `扩展宿主 ${ACK_TIMEOUT_MS}ms 内没有应答 ${HEARTBEAT_METHOD}#${id}：标记无响应（只观测，不杀不重启）`
    )
  }

  private pruneCrashes(at: number): void {
    const edge = at - CRASH_WINDOW_MS
    while (this.crashes.length > 0 && this.crashes[0].at < edge) this.crashes.shift()
  }

  private crashCount(): number {
    const edge = this.deps.timers.now() - CRASH_WINDOW_MS
    return this.crashes.filter((crash) => crash.at >= edge).length
  }

  /* ------------------------------ host-renderer 端口交付 ------------------------------ */

  private rendererPayload(): RendererPortPayload {
    return { v: PROTOCOL_VERSION, hostId: this.hostId, pid: this.pid }
  }

  private describeRendererPort(): RendererPortDescription {
    return {
      phase: this.phase,
      portDelivered: this.rendererDelivered,
      portPending: this.rendererPort !== null,
      hostId: this.hostId,
      pid: this.pid,
      channel: RENDERER_PORT_CHANNEL,
      protocolVersion: PROTOCOL_VERSION
    }
  }

  /**
   * 主窗口可能还没加载完：先立刻试一次，不行就按固定间隔重试（这就是"排队"）。
   * 尝试次数有上限，避免窗口永远不出现时留一个 4 次/秒的定时器转到进程退出。
   */
  private scheduleRendererDelivery(): void {
    this.stopTimers('renderer')
    if (this.disposed || this.rendererDelivered || this.rendererPort === null) return
    this.rendererAttempts += 1
    if (this.tryDeliverRendererPort()) return
    if (this.rendererAttempts >= RENDERER_DELIVERY_MAX_ATTEMPTS) {
      this.deps.logger.warn(
        `主窗口 ${Math.round((RENDERER_READY_RETRY_MS * RENDERER_DELIVERY_MAX_ATTEMPTS) / 1000)}s ` +
          '内仍不可投递：端口继续排队，等渲染侧就绪后调用 flushRendererPort()'
      )
      return
    }
    this.startTimer(
      'renderer',
      () => {
        this.scheduleRendererDelivery()
      },
      RENDERER_READY_RETRY_MS
    )
  }

  private tryDeliverRendererPort(): boolean {
    if (this.rendererDelivered || this.rendererPort === null) return false
    const target = this.deps.getRendererTarget()
    if (!target || target.isDestroyed()) return false
    const port = this.rendererPort
    try {
      // 端口只能这样交付：`postMessage(channel, payload, [port])`，payload 里放不下端口
      target.postMessage(RENDERER_PORT_CHANNEL, this.rendererPayload(), [port])
    } catch (error) {
      this.deps.logger.warn(
        `向渲染进程转交端口失败（窗口可能正在销毁），稍后重试：${describeError(error)}`
      )
      return false
    }
    this.rendererPort = null
    this.rendererDelivered = true
    this.stopTimers('renderer')
    this.deps.logger.info(`已把 host-renderer 端口转交主窗口（channel=${RENDERER_PORT_CHANNEL}）`)
    return true
  }

  /* ------------------------------ 杂项 ------------------------------ */

  private postToHost(envelope: Envelope, transfer?: ExtensionHostPortLike[]): boolean {
    const process = this.process
    if (!process) return false
    try {
      if (transfer === undefined) process.postMessage(envelope)
      else process.postMessage(envelope, transfer)
      return true
    } catch (error) {
      this.deps.logger.error(`向扩展宿主发送 ${envelope.t} 信封失败：${describeError(error)}`)
      return false
    }
  }

  private emitEnvelope(envelope: Envelope): void {
    for (const listener of [...this.envelopeListeners]) {
      try {
        listener(envelope)
      } catch (error) {
        this.deps.logger.error(`信封订阅者抛错：${describeError(error)}`)
      }
    }
  }

  private setPhase(phase: ExtensionHostPhase): void {
    this.phase = phase
    const status = this.getStatus()
    for (const listener of [...this.statusListeners]) {
      try {
        listener(status)
      } catch (error) {
        this.deps.logger.error(`状态订阅者抛错：${describeError(error)}`)
      }
    }
  }

  private resolvePendingStart(result: ExtensionHostStartResult): void {
    const pending = this.pendingStart
    this.pendingStart = null
    pending?.resolve(result)
  }

  private resolvePendingStop(): void {
    const pending = this.pendingStop
    this.pendingStop = null
    pending?.resolve()
  }

  private startTimer(slot: TimerSlot, callback: () => void, ms: number): void {
    this.stopTimers(slot)
    // 回调触发时先把自己的槽位清掉：这样回调里再 startTimer 同一槽位不会被误清
    const handle = this.deps.timers.setTimeout(() => {
      this.timerHandles.delete(slot)
      callback()
    }, ms)
    this.timerHandles.set(slot, handle)
  }

  private stopTimers(...slots: TimerSlot[]): void {
    for (const slot of slots) {
      const handle = this.timerHandles.get(slot)
      if (handle === undefined) continue
      this.deps.timers.clearTimeout(handle)
      this.timerHandles.delete(slot)
    }
  }
}

/**
 * 默认依赖：真的 Electron API + 全局定时器 + console 日志。
 *
 * 两处 `as unknown as` 是**有意的适配层**：`MessagePortMain` / `WebContents` 的 `postMessage`
 * 签名要求 transfer 是 `MessagePortMain[]`，而启动器只依赖窄接口（为了让单测能注入假端口/假窗口）。
 * 运行时传进去的就是真 `MessagePortMain`，所以这里的断言不改变任何行为。
 */
function defaultDeps(): ExtensionHostStarterDeps {
  const prefix = '[extension-host]'
  return {
    fork: (entryPoint, args, options) => utilityProcess.fork(entryPoint, args, options),
    createMessageChannel: () => {
      const channel = new MessageChannelMain()
      return {
        port1: channel.port1 as unknown as ExtensionHostPortLike,
        port2: channel.port2 as unknown as ExtensionHostPortLike
      }
    },
    getRendererTarget: () => {
      const window = getMainWindow()
      if (!window || window.isDestroyed()) return null
      const contents = window.webContents
      if (contents.isDestroyed()) return null
      // 页面还没加载完就投递 = 消息会丢；返回 null 让调用方排队重试
      if (contents.isLoadingMainFrame()) return null
      return contents as unknown as ExtensionHostRendererTarget
    },
    forceKill: (pid) => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 进程已经退出（或权限不足）：强杀是尽力而为，失败不该再抛
      }
    },
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      now: () => Date.now()
    },
    logger: {
      debug: (message) => console.log(`${prefix} ${message}`),
      info: (message) => console.log(`${prefix} ${message}`),
      warn: (message) => console.warn(`${prefix} ${message}`),
      error: (message) => console.error(`${prefix} ${message}`)
    }
  }
}

/**
 * 创建一个扩展宿主启动器（**不启动进程**，`start()` 才 fork）。
 *
 * 本卡在 `src/main/index.ts` 里只做两处接线：`registerIpc()` + `bindWindow()`，以及退出时的
 * `dispose()`。真正 `start()` 的时机（拿到扩展清单后）属于 EH-A4。
 */
export function createExtensionHostStarter(
  options: ExtensionHostStarterOptions
): ExtensionHostStarter {
  return new ExtensionHostStarterImpl(options)
}
