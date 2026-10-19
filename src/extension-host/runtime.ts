/**
 * 宿主进程运行时：把端口、协议、RPC、加载器、激活器、状态表**装成一台机器**。
 *
 * 时序（与 EH-A2 的启动器对齐，见 `docs/adr/0026-extension-host-process.md`）：
 *
 * ```text
 * start()            → 发 ready（hostId + pid）
 * 收到 init          → 校验 apiVersion / 建加载器 / 播种状态表 / 建激活器
 *                    → 发 initialized
 *                    → 后台激活声明了 `*` 的扩展（不阻塞握手）
 * 收到 activate      → 按 extId + reason 激活（懒 import）
 * 收到 deactivate    → 停用（清定时器 + 跑清理）
 * 收到 req           → initialized 之前一律 EH_NOT_READY；之后交 RpcServer
 * 收到 terminate     → 停用全部 → 退出；graceMs 到期强制退出
 * ```
 *
 * 三条边界（本文件刻意守住的）：
 * 1. **不 import Electron 的 main-only API**：宿主是 `utilityProcess`，只有 Node。
 * 2. **扩展错误不升级为进程级**：`plugin(api)` 与后续异步回调都经 `runExtensionSafely`；
 *    这里接住的上报只写 `log` + 状态表。
 * 3. **失败不连锁**：加载器把不可加载的扩展标 `rejected`，激活器把失败标 `failed`，
 *    其余扩展照常激活与响应 RPC。
 */
import { randomUUID } from 'node:crypto'
import {
  EH_ERROR_TEXT,
  FIRST_REQUEST_ID,
  TERMINATE_GRACE_MS,
  EhProtocolError,
  createErrorEnvelope,
  createInitializedEnvelope,
  createReadyEnvelope,
  validateActivationReason,
  validateEnvelope,
  type ActivateEnvelope,
  type ActivationReason,
  type DeactivateEnvelope,
  type Envelope,
  type InitEnvelope,
  type RequestEnvelope,
  type TerminateEnvelope
} from '../shared/extensionHostProtocol'
import { Activator, type ActivationResult } from './activator'
import { createExtensionApi, type BuiltExtensionApi } from './apiFactory'
import { toErrorDetail, toErrorMessage } from './errors'
import { createEnvelopeLogger, createEnvelopeSink, type EnvelopeSink, type HostLogger } from './log'
import { ExtensionLoader, type LoadedExtension } from './loader'
import type { HostPort } from './port'
import { RpcClient, RpcServer, systemRpcTimers, type RpcRequestOptions } from './rpc'
import { createRunExtensionSafely, type ExtensionErrorReporter } from './safety'
import { ExtensionStatusTable, type ExtensionStatus } from './status'
import { unrefTimer } from './timers'

/** 宿主阶段（`ready` 之前是 `created`；`initialized` 之后才接 `req`） */
export type HostPhase =
  'created' | 'ready' | 'initializing' | 'initialized' | 'terminating' | 'terminated'

/** `host.status` RPC 的返回（也是宿主自检/测试的观察面） */
export interface HostStatusPayload {
  hostId: string
  pid: number
  phase: HostPhase
  /** 宿主能力面版本（= `init.apiVersion`；未 init 时为 0） */
  apiVersion: number
  /** 宿主数据目录（= `init.dataDir`；未 init 时为空串） */
  dataDir: string
  /** 一个扩展一行 */
  extensions: ExtensionStatus[]
  /** 已注册的 RPC method（排序） */
  rpcMethods: string[]
  /** 已激活扩展 id（排序） */
  activeExtensions: string[]
}

/** `ExtensionHostRuntime` 的构造参数（全部可注入，便于单测不起真进程） */
export interface HostRuntimeOptions {
  /** 消息端口（生产：`createHostPortFromParentPort(process.parentPort)`；测试：假端口） */
  port: HostPort
  /** 宿主 id（缺省随机 UUID；日志与崩溃归因用） */
  hostId?: string
  /** 宿主 pid（缺省 `process.pid`；测试可伪造） */
  pid?: number
  /** 应用信息（`api.appInfo` 的来源；缺省 `obox` / `0.0.0`） */
  appInfo?: { name: string; version: string }
  /** UI 语言（`api.env.language`；缺省 `zh`） */
  locale?: string
  /** RPC ack 超时（毫秒，缺省 `ACK_TIMEOUT_MS`） */
  ackTimeoutMs?: number
  /** 时钟（测试注入） */
  now?: () => number
  /** 是否把日志同时写进 console（**只给入口**开；单测关掉以免噪声） */
  echoLog?: boolean
  /** 退出实现（缺省 `process.exit`；测试注入 spy） */
  exit?: (code: number) => void
  /** 读扩展入口 `main`（缺省读 `manifest.json`；测试可注入） */
  readEntryMain?: (extensionDir: string) => string | null
  /** 动态 import（缺省真 `import()`；测试可注入） */
  importModule?: (url: string) => Promise<unknown>
}

/** 从 RPC 参数里读 `reason`（`host.dispatchActivation` / `host.activate` 共用） */
function readReasonParam(params: unknown): ActivationReason {
  const record: { reason?: unknown } =
    typeof params === 'object' && params !== null ? (params as { reason?: unknown }) : {}
  const checked = validateActivationReason(record.reason)
  if (!checked.ok) {
    throw new EhProtocolError('EH_INTERNAL', `参数 reason 非法：${checked.why}`)
  }
  return checked.reason
}

/** 从 RPC 参数里读 `extId` */
function readExtIdParam(params: unknown): string {
  const record: { extId?: unknown } =
    typeof params === 'object' && params !== null ? (params as { extId?: unknown }) : {}
  if (typeof record.extId !== 'string' || record.extId.trim() === '') {
    throw new EhProtocolError('EH_INTERNAL', '参数 extId 必须是非空字符串')
  }
  return record.extId
}

/**
 * 扩展宿主运行时。
 *
 * 用法（生产，见 `index.ts`）：`new ExtensionHostRuntime({ port }).start()`。
 * 用法（单测）：构造后直接 `handleMessage()` 喂信封，或经假端口喂。
 */
export class ExtensionHostRuntime {
  /** 扩展状态表（公开只读使用：`statuses()` / `statusOf()`） */
  readonly status: ExtensionStatusTable

  private readonly options: HostRuntimeOptions
  private readonly id: string
  private readonly pid: number
  private readonly sendRaw: EnvelopeSink
  private readonly logger: HostLogger
  private readonly rpc: RpcServer
  private readonly rpcClient: RpcClient
  private readonly exit: (code: number) => void
  private readonly unsubscribe: () => void
  private readonly pending = new Set<Promise<void>>()
  private loader: ExtensionLoader | null = null
  private activator: Activator | null = null
  private currentPhase: HostPhase = 'created'
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private apiVersion = 0
  private dataDir = ''
  private terminating = false

  constructor(options: HostRuntimeOptions) {
    this.options = options
    this.id = options.hostId ?? randomUUID()
    this.pid = options.pid ?? process.pid
    this.status = new ExtensionStatusTable(options.now ?? Date.now)
    this.exit =
      options.exit ??
      ((code: number): void => {
        process.exit(code)
      })

    // 发送口：帧上限 + 发送异常兜底都在 sink 里；这里再兜一层「已经 terminated 就不再发」
    this.sendRaw = createEnvelopeSink(options.port, (message: string): void => {
      console.error(`[extension-host] ${message}`)
    })
    this.logger = createEnvelopeLogger(
      (envelope): void => {
        this.send(envelope)
      },
      { echoToConsole: options.echoLog === true }
    )
    this.rpc = new RpcServer({
      send: (envelope): void => {
        this.send(envelope)
      },
      log: this.logger,
      now: options.now
    })
    this.rpcClient = new RpcClient({
      send: (envelope): void => {
        this.send(envelope)
      },
      log: this.logger,
      ackTimeoutMs: options.ackTimeoutMs,
      timers: systemRpcTimers,
      now: options.now
    })

    this.registerHostMethods()
    this.unsubscribe = options.port.subscribe((message: unknown): void => {
      this.handleMessage(message)
    })
  }

  /* ---------------------------------------- 观察面 ---------------------------------------- */

  get hostId(): string {
    return this.id
  }

  get phase(): HostPhase {
    return this.currentPhase
  }

  /** 状态表快照（排序后） */
  statuses(): ExtensionStatus[] {
    return this.status.all()
  }

  /** 单个扩展状态 */
  statusOf(extId: string): ExtensionStatus | undefined {
    return this.status.get(extId)
  }

  /** 加载器记录（诊断用；未 init 时为空数组） */
  extensions(): LoadedExtension[] {
    return this.loader?.all() ?? []
  }

  /** 已注册的 RPC method（排序） */
  rpcMethods(): string[] {
    return this.rpc.registeredMethods()
  }

  /** 写一条宿主日志（`log` 信封）；入口的进程级错误处理也用它 */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: string): void {
    this.logger(level, message, detail)
  }

  /* ---------------------------------------- 生命周期 -------------------------------------- */

  /** 启动：立刻发 `ready`（后续等 `init`） */
  start(): void {
    if (this.currentPhase !== 'created') {
      this.logger('warn', `start() 被重复调用（当前阶段 ${this.currentPhase}），忽略`)
      return
    }
    this.send(createReadyEnvelope(this.id, this.pid))
    this.currentPhase = 'ready'
    this.logger('debug', `扩展宿主已就绪：hostId=${this.id} pid=${this.pid}`)
  }

  /**
   * 处理一条入站消息（信封）。
   * **永不抛错**：坏信封只记日志（能配对 id 的 `req` 会回 `EH_INTERNAL`），
   * 这样消息循环不会因为一条脏数据停下来。
   */
  handleMessage(raw: unknown): void {
    if (this.currentPhase === 'terminated') return
    const checked = validateEnvelope(raw)
    if (!checked.ok) {
      this.logger('error', `收到畸形信封（${checked.code}）`, checked.why)
      this.replyMalformed(raw, checked.why)
      return
    }

    const envelope = checked.env
    switch (envelope.t) {
      case 'init':
        this.handleInit(envelope)
        return
      case 'activate':
        this.handleActivate(envelope)
        return
      case 'deactivate':
        this.handleDeactivate(envelope)
        return
      case 'req':
        this.handleRequest(envelope)
        return
      case 'res':
        if (!this.rpcClient.handleResponse(envelope)) {
          this.logger('warn', `收到无法配对的 res（id=${envelope.id}），已忽略`)
        }
        return
      case 'err':
        if (!this.rpcClient.handleError(envelope)) {
          this.logger('warn', `收到无法配对的 err（id=${envelope.id}），已忽略`)
        }
        return
      case 'cancel':
        // 两个方向的 id 各自独立，可能撞号：先当我们发出的请求被取消，再当对端请求被取消
        if (this.rpcClient.handleCancel(envelope)) return
        this.rpc.handleCancel(envelope)
        return
      case 'log':
        this.logger('debug', `收到 main 的日志（${envelope.level}）：${envelope.message}`)
        return
      case 'event':
        this.logger('warn', `扩展宿主不消费 event 信封（channel=${envelope.channel}），已忽略`)
        return
      case 'ready':
      case 'initialized':
        this.logger('warn', `收到方向错误的信封 t=${envelope.t}（该类型只由宿主发给 main）`)
        return
      case 'terminate':
        this.handleTerminate(envelope)
        return
    }
  }

  /** 发一个 RPC 请求给对端（渲染侧/main 的桥接能力用；EH-A3 只提供通道） */
  request(
    method: string,
    params: unknown = null,
    options: RpcRequestOptions = {}
  ): Promise<unknown> {
    return this.rpcClient.request(method, params, options)
  }

  /** 按激活事件批量激活（返回逐个结果；失败已进状态表，不抛错） */
  async dispatchActivation(reason: ActivationReason): Promise<ActivationResult[]> {
    if (!this.activator || this.currentPhase !== 'initialized') {
      throw new EhProtocolError(
        'EH_NOT_READY',
        EH_ERROR_TEXT.EH_NOT_READY,
        `当前阶段 ${this.currentPhase}：init 之后才能按激活事件分派`
      )
    }
    return this.activator.dispatch(reason)
  }

  /** 等所有后台激活任务结束（单测与 `terminate` 清理用） */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending])
    }
  }

  /** 释放端口订阅与在途请求（幂等；不退出进程） */
  dispose(): void {
    this.unsubscribe()
    this.rpc.dispose('扩展宿主已关停')
    this.rpcClient.rejectAll('EH_CANCELLED', '扩展宿主已关停，在途请求已取消')
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  /* ---------------------------------------- 信封处理 -------------------------------------- */

  /** `init`：加载清单 → 发 `initialized` → 后台激活 `*` */
  private handleInit(envelope: InitEnvelope): void {
    if (this.currentPhase !== 'ready') {
      this.logger(
        'warn',
        `忽略 init：当前阶段 ${this.currentPhase}（只接受 ready 阶段的一次 init）`
      )
      return
    }
    this.currentPhase = 'initializing'
    this.apiVersion = envelope.apiVersion
    this.dataDir = envelope.dataDir

    const loader = new ExtensionLoader({
      hostApiVersion: envelope.apiVersion,
      dataDir: envelope.dataDir,
      log: this.logger,
      readEntryMain: this.options.readEntryMain,
      importModule: this.options.importModule
    })
    const prepared = loader.prepare(envelope.extensions)
    for (const extension of prepared) {
      this.status.seed(extension.info)
      if (extension.state === 'rejected') {
        this.status.reject(extension.info.id, extension.reason ?? '扩展不可加载')
      }
    }

    const runSafely = createRunExtensionSafely(this.reportExtensionError)
    const activator = new Activator({
      loader,
      status: this.status,
      log: this.logger,
      runSafely,
      createApi: (extension: LoadedExtension): BuiltExtensionApi =>
        createExtensionApi({
          ext: extension.info,
          extensionDataDir: loader.dataDirFor(extension.info.id),
          appInfo: this.appInfo,
          locale: this.locale,
          log: this.logger,
          runSafely
        })
    })
    this.loader = loader
    this.activator = activator

    this.send(createInitializedEnvelope())
    this.currentPhase = 'initialized'

    const loadable = prepared.filter((extension) => extension.state === 'loadable').length
    this.logger(
      'info',
      `扩展宿主初始化完成：清单 ${prepared.length} 个，可加载 ${loadable} 个，拒绝 ${prepared.length - loadable} 个`
    )

    // 启动即激活（缺省 `*`）：与 `initialized` 握手解耦，扩展再多也不拖慢启动时序
    this.track(
      activator.dispatch('*').then((results): void => {
        const activated = results.filter((result) => result.state === 'activated').length
        this.logger('info', `启动激活完成：${activated}/${results.length} 个扩展`)
      })
    )
  }

  private handleActivate(envelope: ActivateEnvelope): void {
    const activator = this.activator
    if (!activator || this.currentPhase !== 'initialized') {
      this.logger('warn', `忽略 activate（${envelope.extId}）：宿主当前阶段 ${this.currentPhase}`)
      return
    }
    this.track(activator.activate(envelope.extId, envelope.reason))
  }

  private handleDeactivate(envelope: DeactivateEnvelope): void {
    const activator = this.activator
    if (!activator || this.currentPhase !== 'initialized') {
      this.logger('warn', `忽略 deactivate（${envelope.extId}）：宿主当前阶段 ${this.currentPhase}`)
      return
    }
    this.track(activator.deactivate(envelope.extId))
  }

  /** `req`：`initialized` 之前一律 `EH_NOT_READY`（协议层写明的时序） */
  private handleRequest(envelope: RequestEnvelope): void {
    if (this.currentPhase !== 'initialized') {
      this.send(
        createErrorEnvelope(
          envelope.id,
          'EH_NOT_READY',
          EH_ERROR_TEXT.EH_NOT_READY,
          `当前阶段 ${this.currentPhase}：init 之前不接受 req（method=${envelope.method}）`
        )
      )
      return
    }
    this.rpc.handleRequest(envelope)
  }

  /** `terminate`：先宽限清理，到点强制退出 */
  private handleTerminate(envelope: TerminateEnvelope): void {
    if (this.terminating) return
    this.terminating = true
    this.currentPhase = 'terminating'
    const graceMs = envelope.graceMs >= 0 ? envelope.graceMs : TERMINATE_GRACE_MS
    this.logger('info', `收到 terminate：宽限期 ${graceMs}ms`)

    this.graceTimer = setTimeout((): void => {
      this.logger('warn', '宽限期已到，强制退出扩展宿主')
      this.finish(0)
    }, graceMs)
    unrefTimer(this.graceTimer)

    void this.shutdown()
  }

  /** 优雅退出：等在途激活 → 取消在途 RPC → 停用全部扩展 → 退出 */
  private async shutdown(): Promise<void> {
    try {
      await this.settled()
      this.rpc.dispose('扩展宿主正在退出')
      this.rpcClient.rejectAll('EH_CANCELLED', '扩展宿主正在退出，在途请求已取消')
      await this.activator?.deactivateAll()
    } catch (error) {
      this.logger('warn', '退出清理时出错（继续退出）', toErrorDetail(error))
    }
    this.logger('info', '扩展宿主清理完毕，退出')
    this.finish(0)
  }

  /** 终态：清定时器、退订、调 `exit`（只执行一次） */
  private finish(code: number): void {
    if (this.currentPhase === 'terminated') return
    this.currentPhase = 'terminated'
    this.dispose()
    this.exit(code)
  }

  /* ---------------------------------------- 内部工具 -------------------------------------- */

  /** 发信封（`terminated` 之后静默丢弃：端口可能已经没了） */
  private send(envelope: Envelope): void {
    if (this.currentPhase === 'terminated') return
    this.sendRaw(envelope)
  }

  /** 登记一个后台任务，供 `settled()` 等待 */
  private track(task: Promise<unknown>): void {
    const handled: Promise<void> = task.then(
      (): void => undefined,
      (error: unknown): void => {
        this.logger('error', '宿主后台任务异常', toErrorDetail(error))
      }
    )
    this.pending.add(handled)
    void handled.then((): void => {
      this.pending.delete(handled)
    })
  }

  /**
   * 扩展错误上报：`log` 信封 + 状态表。
   * 激活/停用阶段的错误由 `Activator` 归类上报（含 `plugin-threw`），这里只补一条栈细节；
   * 运行期（定时器/回调）错误单独记 `runtimeError`，**不**把扩展状态改成失败。
   */
  private readonly reportExtensionError: ExtensionErrorReporter = (extId, error, phase): void => {
    const message = toErrorMessage(error)
    if (phase === 'activate' || phase === 'deactivate') {
      this.logger('debug', `扩展 ${extId} ${phase} 阶段异常细节`, toErrorDetail(error))
      return
    }
    this.status.recordRuntimeError(extId, phase, message)
    this.logger('error', `扩展 ${extId} 运行期错误（${phase}）`, toErrorDetail(error))
  }

  private get appInfo(): { name: string; version: string } {
    return this.options.appInfo ?? { name: 'obox', version: '0.0.0' }
  }

  private get locale(): string {
    return this.options.locale ?? 'zh'
  }

  /** 畸形信封：只对「看起来是 req 且 id 可配对」的回 `err`，其余仅记日志 */
  private replyMalformed(raw: unknown, why: string): void {
    if (typeof raw !== 'object' || raw === null) return
    const record = raw as { t?: unknown; id?: unknown }
    if (record.t !== 'req') return
    const id = record.id
    if (typeof id !== 'number' || !Number.isInteger(id) || id < FIRST_REQUEST_ID) return
    this.send(createErrorEnvelope(id, 'EH_INTERNAL', '收到畸形信封（协议不匹配）', why))
  }

  /** 注册宿主内置 RPC method（EH-A3 只给最小三件 + 一个激活入口） */
  private registerHostMethods(): void {
    this.rpc.register('host.ping', (): { pong: true; hostId: string; phase: HostPhase } => ({
      pong: true,
      hostId: this.id,
      phase: this.currentPhase
    }))

    this.rpc.register('host.status', (): HostStatusPayload => ({
      hostId: this.id,
      pid: this.pid,
      phase: this.currentPhase,
      apiVersion: this.apiVersion,
      dataDir: this.dataDir,
      extensions: this.statuses(),
      rpcMethods: this.rpc.registeredMethods(),
      activeExtensions: this.activator?.activeIds() ?? []
    }))

    this.rpc.register(
      'host.dispatchActivation',
      async (params: unknown): Promise<ActivationResult[]> => {
        return this.dispatchActivation(readReasonParam(params))
      }
    )

    this.rpc.register('host.activate', async (params: unknown): Promise<ActivationResult> => {
      const extId = readExtIdParam(params)
      const reason = readReasonParam(params)
      if (!this.activator) {
        throw new EhProtocolError('EH_NOT_READY', EH_ERROR_TEXT.EH_NOT_READY, '宿主尚未 init')
      }
      return this.activator.activate(extId, reason)
    })
  }
}
