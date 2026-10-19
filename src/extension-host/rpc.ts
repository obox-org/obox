/**
 * 宿主侧 RPC：**服务端**（接 main / 渲染侧的 `req`）与**客户端**（宿主反向调用对端）。
 *
 * 协议信封（`req` / `res` / `err` / `cancel`）由 `extensionHostProtocol.ts` 定义，本文件只做
 * 四件协议层刻意没做的事（ADR-0026 决策 7 + EH-A1 的语义约定）：
 * 1. **分发**：`req.method` → 已注册的处理函数；未命中回 `EH_INTERNAL` 并带**可用 method 列表**
 *    （没有列表的话，扩展作者只能看到「方法不存在」，无法判断是拼错还是宿主版本旧）；
 * 2. **配对**：`res` / `err` 按 `id` 还给调用方；
 * 3. **取消**：`cancel` 标记放弃——**已经做完的请求回正常响应，放弃掉的请求回 `EH_CANCELLED`**
 *    （协议层写死的语义；实现上就是「等处理函数真的结束再回」，而不是立刻回取消）；
 * 4. **超时**：`ACK_TIMEOUT_MS`（默认 3 秒）——**只观测、不杀**。客户端到点回
 *    `EH_TIMEOUT` 并补发 `cancel`，但**不**重启/终止宿主：宿主里跑的是用户的完整 Node 代码，
 *    一次同步 IO 就可能接近 3 秒，杀进程的代价远大于一次慢请求（ADR-0026 决策 7）。
 */
import {
  ACK_TIMEOUT_MS,
  EH_ERROR_TEXT,
  FIRST_REQUEST_ID,
  EhProtocolError,
  createCancelEnvelope,
  createErrorEnvelope,
  createRequestEnvelope,
  createResponseEnvelope,
  type CancelEnvelope,
  type EhErrorCode,
  type ErrorEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope
} from '../shared/extensionHostProtocol'
import { errorCodeOf, toErrorDetail, toErrorMessage } from './errors'
import type { EnvelopeSink, HostLogger } from './log'
import { unrefTimer } from './timers'

/* -------------------------------------------------------------------------------------------- */
/* 服务端                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** 处理函数收到的调用上下文 */
export interface RpcCallContext {
  /** 请求 id（同一方向内唯一） */
  readonly id: number
  /** 请求 method */
  readonly method: string
  /** 取消信号：收到 `cancel` 时 abort（处理函数若支持中断，应监听它） */
  readonly signal: AbortSignal
  /** 是否已被取消（与 `signal.aborted` 同步，读起来更直观） */
  readonly cancelled: boolean
  /** 收到请求的时间戳（`Date.now()`） */
  readonly startedAt: number
}

/**
 * RPC 处理函数：返回值即 `res.result`；抛错即 `err`（`EhProtocolError` 保留错误码，
 * 其它一律 `EH_INTERNAL`）。允许返回 Promise——宿主能力基本都是异步的。
 */
export type RpcHandler = (params: unknown, context: RpcCallContext) => unknown

/** 在途调用（取消标记 + abort 控制器） */
interface InflightCall {
  readonly method: string
  readonly controller: AbortController
  readonly startedAt: number
  cancelled: boolean
}

/** `RpcServer` 的构造参数 */
export interface RpcServerOptions {
  /** 发信封（通常是 `createEnvelopeSink(port, log)`） */
  send: EnvelopeSink
  /** 日志（未知 method、取消、异常都要留痕） */
  log: HostLogger
  /** 时钟（测试注入） */
  now?: () => number
}

/**
 * RPC 服务端：注册 method → 收 `req` → 回 `res` / `err`；收 `cancel` → 标记放弃。
 *
 * 线程模型：全部在宿主的事件循环里跑，不做并发限制（扩展自己负责背压）；
 * `inflight` 只用于取消与重复 id 检测。
 */
export class RpcServer {
  private readonly methods = new Map<string, RpcHandler>()
  private readonly inflight = new Map<number, InflightCall>()
  private readonly send: EnvelopeSink
  private readonly log: HostLogger
  private readonly now: () => number

  constructor(options: RpcServerOptions) {
    this.send = options.send
    this.log = options.log
    this.now = options.now ?? Date.now
  }

  /**
   * 注册一个 method；返回注销函数。
   * 重复注册**抛错**（而不是后注册覆盖前一个）：静默覆盖会让「为什么我的 handler 没被调用」
   * 变成一次二小时的排查。
   */
  register(method: string, handler: RpcHandler): () => void {
    if (method.trim() === '') throw new Error('RPC method 名不能为空')
    if (this.methods.has(method)) throw new Error(`RPC method 重复注册：${method}`)
    this.methods.set(method, handler)
    return (): void => {
      this.methods.delete(method)
    }
  }

  /** 已注册的 method 名（排序，用于 `host.status` 与未知 method 的提示） */
  registeredMethods(): string[] {
    return [...this.methods.keys()].sort((left, right) => left.localeCompare(right))
  }

  /** 在途请求数（诊断用） */
  get pendingCount(): number {
    return this.inflight.size
  }

  /**
   * 处理一条 `req`（**不返回 Promise**：调用方是消息循环，不该 await）。
   * 处理结果异步经 `send` 回出去。
   */
  handleRequest(envelope: RequestEnvelope): void {
    void this.dispatch(envelope)
  }

  /**
   * 处理一条 `cancel`：标记放弃。
   *
   * 语义（协议层约定）：处理函数**继续跑完**，结束时回 `EH_CANCELLED` 而不是结果；
   * 已经回过的请求（不在 `inflight`）静默忽略——取消一条已完成的请求不是错误。
   */
  handleCancel(envelope: CancelEnvelope): void {
    const call = this.inflight.get(envelope.id)
    if (!call) {
      this.log('debug', `收到 cancel（id=${envelope.id}），该请求已完成或不存在，忽略`)
      return
    }
    call.cancelled = true
    call.controller.abort(new Error(`请求已被对端取消（method=${call.method}）`))
    this.log('debug', `请求被取消：method=${call.method} id=${envelope.id}`)
  }

  /** 关停：把所有在途请求标记为已取消（宿主退出前调用，避免处理函数再回帧） */
  dispose(reason = '扩展宿主正在关闭'): void {
    for (const [id, call] of this.inflight) {
      call.cancelled = true
      call.controller.abort(new Error(reason))
      this.log('debug', `关停时仍有在途请求：method=${call.method} id=${id}`)
    }
  }

  private async dispatch(envelope: RequestEnvelope): Promise<void> {
    const handler = this.methods.get(envelope.method)
    if (!handler) {
      const available = this.registeredMethods()
      const list = available.length > 0 ? available.join(', ') : '（无）'
      this.send(
        createErrorEnvelope(
          envelope.id,
          'EH_INTERNAL',
          `未知 RPC method "${envelope.method}"：本宿主没有注册该方法`,
          `可用 method：${list}`
        )
      )
      this.log('warn', `收到未知 RPC method：${envelope.method}`, `可用 method：${list}`)
      return
    }

    if (this.inflight.has(envelope.id)) {
      this.send(
        createErrorEnvelope(
          envelope.id,
          'EH_INTERNAL',
          `RPC 请求 id 重复：${envelope.id}`,
          '同一方向内 id 必须由发送方自增且唯一（FIRST_REQUEST_ID 起）'
        )
      )
      this.log('warn', `RPC 请求 id 重复：${envelope.id}（method=${envelope.method}）`)
      return
    }

    const call: InflightCall = {
      method: envelope.method,
      controller: new AbortController(),
      startedAt: this.now(),
      cancelled: false
    }
    this.inflight.set(envelope.id, call)

    const context: RpcCallContext = {
      id: envelope.id,
      method: envelope.method,
      signal: call.controller.signal,
      startedAt: call.startedAt,
      get cancelled(): boolean {
        return call.cancelled
      }
    }

    try {
      const result = await handler(envelope.params, context)
      if (call.cancelled) {
        this.send(
          createErrorEnvelope(
            envelope.id,
            'EH_CANCELLED',
            EH_ERROR_TEXT.EH_CANCELLED,
            `请求已被取消：method=${envelope.method}`
          )
        )
        return
      }
      this.send(createResponseEnvelope(envelope.id, result))
    } catch (error) {
      if (call.cancelled) {
        this.send(
          createErrorEnvelope(
            envelope.id,
            'EH_CANCELLED',
            EH_ERROR_TEXT.EH_CANCELLED,
            `请求已被取消：method=${envelope.method}`
          )
        )
        return
      }
      const code = errorCodeOf(error, 'EH_INTERNAL')
      this.send(createErrorEnvelope(envelope.id, code, toErrorMessage(error), toErrorDetail(error)))
      this.log('error', `RPC 处理失败：method=${envelope.method}`, toErrorDetail(error))
    } finally {
      this.inflight.delete(envelope.id)
    }
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 客户端                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** 定时器抽象（单测注入假时钟；生产用 `systemRpcTimers`，句柄 unref 以免拖住宿主退出） */
export interface RpcTimers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** 默认定时器：`setTimeout` + `unref`（有未决请求时也不阻塞宿主退出） */
export const systemRpcTimers: RpcTimers = {
  set(callback: () => void, ms: number): unknown {
    const handle = setTimeout(callback, ms)
    unrefTimer(handle)
    return handle
  },
  clear(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

/** `RpcClient` 的构造参数 */
export interface RpcClientOptions {
  /** 发信封 */
  send: EnvelopeSink
  /** 日志 */
  log: HostLogger
  /** 默认 ack 超时（毫秒，缺省 `ACK_TIMEOUT_MS` = 3s；只观测不杀） */
  ackTimeoutMs?: number
  /** 定时器（测试注入） */
  timers?: RpcTimers
  /** 时钟（测试注入） */
  now?: () => number
}

/** 逐请求选项 */
export interface RpcRequestOptions {
  /** 覆盖本次的超时（毫秒） */
  timeoutMs?: number
}

/** 在途请求 */
interface PendingCall {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: unknown
  readonly startedAt: number
}

/**
 * RPC 客户端：发 `req`、按 id 配对 `res`/`err`、超时回 `EH_TIMEOUT` 并补发 `cancel`。
 *
 * 断链（对端消失）时调用 `rejectAll`：所有在途请求立即以 `EH_CANCELLED` 失败，
 * **绝不重放**（重放会让非幂等调用被执行两次，见协议层的 `cancel` 注释）。
 */
export class RpcClient {
  private nextId = FIRST_REQUEST_ID
  private readonly pending = new Map<number, PendingCall>()
  private readonly send: EnvelopeSink
  private readonly log: HostLogger
  private readonly ackTimeoutMs: number
  private readonly timers: RpcTimers
  private readonly now: () => number

  constructor(options: RpcClientOptions) {
    this.send = options.send
    this.log = options.log
    this.ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS
    this.timers = options.timers ?? systemRpcTimers
    this.now = options.now ?? Date.now
  }

  /** 在途请求数（诊断用） */
  get pendingCount(): number {
    return this.pending.size
  }

  /** 在途请求 id（升序；取消/断链补偿用） */
  pendingIds(): number[] {
    return [...this.pending.keys()].sort((left, right) => left - right)
  }

  /**
   * 发一个请求并等响应。
   *
   * 注意：超时**只**让本次调用失败并提示调用方（`EH_TIMEOUT`），不终止宿主进程
   * （ADR-0026 决策 7 的「只观测、不杀」）。
   */
  request(
    method: string,
    params: unknown = null,
    options: RpcRequestOptions = {}
  ): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1
    const timeoutMs = options.timeoutMs ?? this.ackTimeoutMs

    return new Promise<unknown>((resolve, reject): void => {
      const timer = this.timers.set((): void => {
        const timedOut = this.pending.get(id)
        if (!timedOut) return
        this.pending.delete(id)
        this.timers.clear(timedOut.timer)
        this.send(createCancelEnvelope(id))
        this.log(
          'warn',
          `RPC 请求超时：${method}（id=${id}）`,
          `超过 ${timeoutMs}ms 未收到 res/err；按 ACK_TIMEOUT_MS 语义只观测，不重启宿主`
        )
        reject(
          new EhProtocolError(
            'EH_TIMEOUT',
            EH_ERROR_TEXT.EH_TIMEOUT,
            `method=${method} id=${id} 超过 ${timeoutMs}ms 无响应`
          )
        )
      }, timeoutMs)

      this.pending.set(id, { method, resolve, reject, timer, startedAt: this.now() })
      this.send(createRequestEnvelope(id, method, params))
    })
  }

  /** 处理 `res`：命中则 resolve，返回是否命中 */
  handleResponse(envelope: ResponseEnvelope): boolean {
    const call = this.take(envelope.id)
    if (!call) return false
    call.resolve(envelope.result)
    return true
  }

  /** 处理 `err`：命中则以同码 `EhProtocolError` reject，返回是否命中 */
  handleError(envelope: ErrorEnvelope): boolean {
    const call = this.take(envelope.id)
    if (!call) return false
    call.reject(new EhProtocolError(envelope.code, envelope.message, envelope.detail))
    return true
  }

  /**
   * 处理对端发来的 `cancel`：把该在途请求按 `EH_CANCELLED` 结束。
   * 返回是否命中（未命中说明 id 属于反方向，由服务端处理）。
   */
  handleCancel(envelope: CancelEnvelope): boolean {
    const call = this.take(envelope.id)
    if (!call) return false
    call.reject(
      new EhProtocolError(
        'EH_CANCELLED',
        EH_ERROR_TEXT.EH_CANCELLED,
        `对端取消：method=${call.method}`
      )
    )
    return true
  }

  /** 主动取消某个在途请求（发 `cancel` + 本地立即失败） */
  cancel(id: number): boolean {
    const call = this.take(id)
    if (!call) return false
    this.send(createCancelEnvelope(id))
    call.reject(
      new EhProtocolError(
        'EH_CANCELLED',
        EH_ERROR_TEXT.EH_CANCELLED,
        `调用方取消：method=${call.method}`
      )
    )
    return true
  }

  /** 链路断开：所有在途请求立即失败（不重放） */
  rejectAll(code: EhErrorCode, message: string): void {
    const ids = this.pendingIds()
    for (const id of ids) {
      const call = this.take(id)
      if (call) call.reject(new EhProtocolError(code, message, `method=${call.method} id=${id}`))
    }
  }

  /** 取出并清理一条在途请求（清定时器） */
  private take(id: number): PendingCall | undefined {
    const call = this.pending.get(id)
    if (!call) return undefined
    this.pending.delete(id)
    this.timers.clear(call.timer)
    return call
  }
}
