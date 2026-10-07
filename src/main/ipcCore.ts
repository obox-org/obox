/**
 * 端口无关的双向 IPC 核心（**不依赖 electron**，可独立单测）。规格见 issue #40。
 *
 * 组成：
 * - **分帧**：`content-length`（LSP 同款，二进制安全，默认）与 `ndjson`（脚本友好）
 * - **协议**：JSON-RPC 2.0（请求/响应/错误/通知四种形状，含双向：对端也可向宿主发请求）
 * - **通道状态机**：请求-响应关联、超时、取消、并发上限、消息上限、关闭语义与稳定错误码
 * - **平台命名**：Windows 命名管道 / POSIX Unix 域套接字（**全程不使用 TCP 端口**）
 * - **声明校验**：扩展贡献的通道声明（名字安全、传输与协议枚举）
 *
 * 传输层（spawn 子进程 stdio / `node:net` 连接）在薄壳 `ipc.ts` 中，只负责把字节喂给
 * `JsonRpcChannel.accept()` 并把 `sendFrame` 的字节写出去——因此本模块与传输完全解耦。
 */
import { isAbsolute, posix } from 'node:path'

/** 单条消息上限（与 api.net.fetch 的 8MB 响应上限一致） */
export const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
/** 默认请求超时 */
export const DEFAULT_TIMEOUT_MS = 30_000
/** 每通道并发请求上限 */
export const DEFAULT_MAX_PENDING_REQUESTS = 64
/** 分帧类型 */
export type Framing = 'content-length' | 'ndjson'
/** 传输类型（**没有 TCP**） */
export type IpcTransport = 'stdio' | 'pipe'

/** 稳定错误码（扩展按码分支，不依赖 message 文本） */
export type IpcErrorCode =
  | 'invalid-declaration' // 声明非法（名字/传输/路径）
  | 'not-connected' // 尚未连接
  | 'connect-failed' // 连接失败（含对端未启动）
  | 'protocol-error' // 分帧或 JSON-RPC 形状非法
  | 'timeout' // 请求超时
  | 'cancelled' // 请求被调用方取消
  | 'message-too-large' // 单条消息超过上限（收/发皆可能）
  | 'too-many-requests' // 并发请求超限
  | 'too-many-channels' // 通道数超限
  | 'peer-crashed' // 对端进程异常退出
  | 'channel-closed' // 通道已关闭

export class IpcCoreError extends Error {
  readonly code: IpcErrorCode
  constructor(code: IpcErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'IpcCoreError'
    this.code = code
  }
}

export function isIpcCoreError(err: unknown): err is IpcCoreError {
  return err instanceof IpcCoreError
}

// ---------------------------------------------------------------------------
// 分帧
// ---------------------------------------------------------------------------

export interface FrameParser {
  /** 把一段收到的字节喂进去，返回已完整的消息载荷；出错时返回 error（且状态不再可用） */
  push(chunk: Buffer): { messages: Buffer[]; error?: IpcCoreError }
  /** 把一条消息载荷编码成可写出的字节 */
  encode(payload: Buffer): Buffer
  /** 供诊断：当前缓冲区字节数 */
  readonly buffered: number
}

const MAX_HEADER_BYTES = 8 * 1024

/** `Content-Length: n\r\n\r\n<payload>` 分帧（LSP 同款） */
export class ContentLengthParser implements FrameParser {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly maxMessageBytes: number

  constructor(maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES) {
    this.maxMessageBytes = maxMessageBytes
  }

  get buffered(): number {
    return this.buffer.length
  }

  encode(payload: Buffer): Buffer {
    return Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'),
      payload
    ])
  }

  push(chunk: Buffer): { messages: Buffer[]; error?: IpcCoreError } {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: Buffer[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          return {
            messages,
            error: new IpcCoreError('protocol-error', `帧头超过 ${MAX_HEADER_BYTES} 字节`)
          }
        }
        return { messages }
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = parseContentLength(header)
      if (length === null) {
        return {
          messages,
          error: new IpcCoreError('protocol-error', `帧头非法: ${header.slice(0, 120)}`)
        }
      }
      if (length > this.maxMessageBytes) {
        return {
          messages,
          error: new IpcCoreError(
            'message-too-large',
            `消息长度 ${length} 超过上限 ${this.maxMessageBytes}`
          )
        }
      }
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + length
      if (this.buffer.length < bodyEnd) return { messages }
      messages.push(this.buffer.subarray(bodyStart, bodyEnd))
      this.buffer = this.buffer.subarray(bodyEnd)
    }
  }
}

/** 从帧头里提取 Content-Length（大小写不敏感，允许多个头部行） */
function parseContentLength(header: string): number | null {
  for (const rawLine of header.split('\r\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 0) return null
    const key = line.slice(0, colon).trim().toLowerCase()
    if (key !== 'content-length') continue
    const value = line.slice(colon + 1).trim()
    if (!/^\d+$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/** 换行分隔 JSON 分帧（每行一条 JSON；容忍 CRLF 与空行） */
export class NdjsonParser implements FrameParser {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly maxMessageBytes: number

  constructor(maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES) {
    this.maxMessageBytes = maxMessageBytes
  }

  get buffered(): number {
    return this.buffer.length
  }

  encode(payload: Buffer): Buffer {
    // JSON.stringify 不会产生裸换行，因此直接追加 '\n' 即可
    return Buffer.concat([payload, Buffer.from('\n', 'ascii')])
  }

  push(chunk: Buffer): { messages: Buffer[]; error?: IpcCoreError } {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: Buffer[] = []
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) {
        if (this.buffer.length > this.maxMessageBytes) {
          return {
            messages,
            error: new IpcCoreError(
              'message-too-large',
              `单行长度超过上限 ${this.maxMessageBytes}（可能缺少换行符）`
            )
          }
        }
        return { messages }
      }
      let line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length > 0 && line[line.length - 1] === 0x0d)
        line = line.subarray(0, line.length - 1)
      if (line.length === 0) continue
      if (line.length > this.maxMessageBytes) {
        return {
          messages,
          error: new IpcCoreError(
            'message-too-large',
            `消息长度 ${line.length} 超过上限 ${this.maxMessageBytes}`
          )
        }
      }
      messages.push(line)
    }
  }
}

export function createFrameParser(
  framing: Framing = 'content-length',
  maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES
): FrameParser {
  return framing === 'ndjson'
    ? new NdjsonParser(maxMessageBytes)
    : new ContentLengthParser(maxMessageBytes)
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 消息形状
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string

export interface JsonRpcRequestMessage {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotificationMessage {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponseMessage {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result?: unknown
  error?: JsonRpcErrorObject
}

/** JSON-RPC 标准错误码（子集） */
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INTERNAL_ERROR = -32603
export const RPC_INVALID_REQUEST = -32600

// ---------------------------------------------------------------------------
// 通道状态机
// ---------------------------------------------------------------------------

export interface ChannelOptions {
  /** 由传输层提供：把已编码的字节写出去（写子进程 stdin / 写套接字） */
  sendFrame: (frame: Buffer) => void
  framing?: Framing
  maxMessageBytes?: number
  defaultTimeoutMs?: number
  maxPendingRequests?: number
}

export interface RequestOptions {
  timeoutMs?: number
  /** 取消信号：中止时本次请求以 `cancelled` 失败，并向对端发 `$/cancelRequest` 通知 */
  signal?: AbortSignal
}

export interface Disposable {
  dispose(): void
}

type PendingCall = {
  method: string
  resolve: (value: unknown) => void
  reject: (err: IpcCoreError) => void
  timer: ReturnType<typeof setTimeout> | null
  onAbort: (() => void) | null
}

/**
 * 一条双向 JSON-RPC 通道。
 * 传输层负责：把收到的字节交给 `accept()`，把 `sendFrame` 给出的字节写出去；
 * 其余（分帧、编解码、关联、超时、取消、限额、关闭）都在这里。
 */
export class JsonRpcChannel {
  private readonly parser: FrameParser
  private readonly sendFrame: (frame: Buffer) => void
  private readonly maxMessageBytes: number
  private readonly defaultTimeoutMs: number
  private readonly maxPendingRequests: number
  private readonly pending = new Map<JsonRpcId, PendingCall>()
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>()
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>()
  private readonly closeListeners = new Set<(err: IpcCoreError | null) => void>()
  private nextId = 1
  private closed = false
  private closedReason: IpcCoreError | null = null

  constructor(options: ChannelOptions) {
    this.sendFrame = options.sendFrame
    this.parser = createFrameParser(options.framing, options.maxMessageBytes)
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS
  }

  get isClosed(): boolean {
    return this.closed
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get closeReason(): IpcCoreError | null {
    return this.closedReason
  }

  /** 发请求并等响应；失败以 `IpcCoreError` 抛出（稳定错误码） */
  request(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.closedReason ?? new IpcCoreError('channel-closed', '通道已关闭'))
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(
        new IpcCoreError(
          'too-many-requests',
          `并发请求已达上限 ${this.maxPendingRequests}，请等待前序请求完成`
        )
      )
    }
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const call: PendingCall = { method, resolve, reject, timer: null, onAbort: null }
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        call.timer = setTimeout(() => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          reject(new IpcCoreError('timeout', `请求 ${method} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        // 不要因为一次请求的定时器拖住进程退出（主进程/测试都受益）
        call.timer.unref?.()
      }
      if (options.signal) {
        const onAbort = (): void => {
          if (!this.pending.has(id)) return
          this.settlePending(id, new IpcCoreError('cancelled', `请求 ${method} 已被取消`))
          // 通知对端（尽力而为；对端可选实现）
          this.tryNotify('$/cancelRequest', { id })
        }
        if (options.signal.aborted) {
          reject(new IpcCoreError('cancelled', `请求 ${method} 已被取消`))
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        call.onAbort = () => options.signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, call)
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        this.settlePending(id, toCoreError(err, 'protocol-error'))
      }
    })
  }

  /** 发通知（无应答） */
  notify(method: string, params?: unknown): void {
    if (this.closed) {
      throw this.closedReason ?? new IpcCoreError('channel-closed', '通道已关闭')
    }
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** 注册对端请求的处理器（双向：对端也可调用宿主） */
  handle(method: string, handler: (params: unknown) => unknown): Disposable {
    this.requestHandlers.set(method, handler)
    return {
      dispose: (): void => {
        if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method)
      }
    }
  }

  /** 订阅对端通知 */
  onNotification(listener: (method: string, params: unknown) => void): Disposable {
    this.notificationListeners.add(listener)
    return {
      dispose: (): void => {
        this.notificationListeners.delete(listener)
      }
    }
  }

  /** 订阅通道关闭（err 为 null 表示调用方主动 close） */
  onClose(listener: (err: IpcCoreError | null) => void): Disposable {
    this.closeListeners.add(listener)
    return {
      dispose: (): void => {
        this.closeListeners.delete(listener)
      }
    }
  }

  /** 传输层收到字节后调用；命中协议错误时通道会以 `protocol-error` 关闭 */
  accept(chunk: Buffer): void {
    if (this.closed) return
    const { messages, error } = this.parser.push(chunk)
    if (error) {
      this.close(error)
      return
    }
    for (const payload of messages) {
      if (this.closed) return
      this.dispatchPayload(payload)
    }
  }

  /** 关闭通道：所有挂起请求以 `channel-closed`（或给定错误）失败，之后再调用一律被拒 */
  close(reason?: IpcCoreError): void {
    if (this.closed) return
    this.closed = true
    this.closedReason = reason ?? new IpcCoreError('channel-closed', '通道已关闭')
    const err = this.closedReason
    for (const [id, call] of [...this.pending]) {
      this.clearCall(call)
      this.pending.delete(id)
      call.reject(err)
    }
    for (const listener of [...this.closeListeners]) listener(reason ?? null)
    this.closeListeners.clear()
    this.notificationListeners.clear()
    this.requestHandlers.clear()
  }

  // ---- 内部 ----

  private write(
    message: JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage
  ): void {
    const payload = Buffer.from(JSON.stringify(message), 'utf8')
    if (payload.length > this.maxMessageBytes) {
      throw new IpcCoreError(
        'message-too-large',
        `待发送消息 ${payload.length} 字节超过上限 ${this.maxMessageBytes}`
      )
    }
    this.sendFrame(this.parser.encode(payload))
  }

  private tryNotify(method: string, params?: unknown): void {
    try {
      this.write({ jsonrpc: '2.0', method, params })
    } catch {
      // 取消通知失败不影响取消语义本身
    }
  }

  private settlePending(id: JsonRpcId, err: IpcCoreError): void {
    const call = this.pending.get(id)
    if (!call) return
    this.clearCall(call)
    this.pending.delete(id)
    call.reject(err)
  }

  private clearCall(call: PendingCall): void {
    if (call.timer) clearTimeout(call.timer)
    call.timer = null
    call.onAbort?.()
    call.onAbort = null
  }

  private dispatchPayload(payload: Buffer): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload.toString('utf8'))
    } catch {
      this.close(new IpcCoreError('protocol-error', '消息不是合法 JSON'))
      return
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
      this.close(new IpcCoreError('protocol-error', '缺少 jsonrpc: "2.0"'))
      return
    }
    const id = parsed.id
    const method = parsed.method
    const isResponse = id !== undefined && ('result' in parsed || 'error' in parsed)

    if (isResponse) {
      if (id !== null && (typeof id === 'number' || typeof id === 'string')) {
        const call = this.pending.get(id)
        // 未知 id 一律忽略（对端可能已超时/取消）
        if (call) {
          this.clearCall(call)
          this.pending.delete(id)
          if (isRecord(parsed.error)) {
            const errObj = parsed.error
            call.reject(
              new IpcCoreError(
                'protocol-error',
                `对端返回错误 ${String(errObj.code ?? '')}: ${String(errObj.message ?? '')}`
              )
            )
          } else {
            call.resolve(parsed.result)
          }
        }
      }
      return
    }

    if (typeof method !== 'string' || !method) {
      this.close(new IpcCoreError('protocol-error', '消息既不是响应也没有 method'))
      return
    }

    if (id !== undefined) {
      // 对端发来的请求 → 交给处理器（双向通信）
      void this.handleInboundRequest(id as JsonRpcId, method, parsed.params)
      return
    }

    for (const listener of [...this.notificationListeners]) {
      try {
        listener(method, parsed.params)
      } catch (err) {
        console.error('[ipc] 通知监听器抛错', err)
      }
    }
  }

  private async handleInboundRequest(
    id: JsonRpcId,
    method: string,
    params: unknown
  ): Promise<void> {
    const handler = this.requestHandlers.get(method)
    if (!handler) {
      this.replyError(id, RPC_METHOD_NOT_FOUND, `未注册的方法: ${method}`)
      return
    }
    try {
      const result = await handler(params)
      this.replyResult(id, result)
    } catch (err) {
      this.replyError(id, RPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err))
    }
  }

  private replyResult(id: JsonRpcId, result: unknown): void {
    if (this.closed) return
    try {
      this.write({ jsonrpc: '2.0', id, result })
    } catch (err) {
      console.error('[ipc] 回包失败', err)
    }
  }

  private replyError(id: JsonRpcId, code: number, message: string): void {
    if (this.closed) return
    try {
      this.write({ jsonrpc: '2.0', id, error: { code, message } })
    } catch (err) {
      console.error('[ipc] 回包失败', err)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toCoreError(err: unknown, fallback: IpcErrorCode): IpcCoreError {
  if (isIpcCoreError(err)) return err
  return new IpcCoreError(fallback, err instanceof Error ? err.message : String(err))
}

// ---------------------------------------------------------------------------
// 平台命名（Windows 命名管道 / POSIX 域套接字；**不用 TCP 端口**）
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 校验通道/扩展 id 片段：只允许字母数字与 . _ -，禁止路径分隔符与 .. */
export function sanitizeIpcName(raw: unknown, what = 'ipc 名称'): string {
  if (typeof raw !== 'string') {
    throw new IpcCoreError('invalid-declaration', `${what} 必须是字符串`)
  }
  const value = raw.trim()
  if (!value || !NAME_RE.test(value) || value.includes('..')) {
    throw new IpcCoreError(
      'invalid-declaration',
      `${what} 非法（只允许字母/数字/./_/-，且不能含 ..）: ${value}`
    )
  }
  return value
}

export interface IpcEndpointOptions {
  /** 平台（默认 process.platform）；显式传入以便单测覆盖 Windows/POSIX 两条分支 */
  platform?: NodeJS.Platform | string
  /** POSIX 下套接字所在目录（通常 userData/ipc） */
  socketDir: string
  extensionId: string
  name: string
  /** 可选随机后缀（宿主作为服务端"多客户端"场景用；作为客户端拨号时必须稳定，不传） */
  suffix?: string
}

/**
 * 计算端点：
 * - Windows：`\\.\pipe\obox-<扩展id>-<name>[-<suffix>]`（内核命名空间，无落盘文件、无端口）
 * - 其它：`<socketDir>/<扩展id>-<name>[-<suffix>].sock`（Unix 域套接字，需清理陈旧文件）
 */
export function ipcEndpoint(options: IpcEndpointOptions): string {
  const extId = sanitizeIpcName(options.extensionId, '扩展 id')
  const name = sanitizeIpcName(options.name, '通道名')
  const suffix = options.suffix ? sanitizeIpcName(options.suffix, '后缀') : ''
  const base = `obox-${extId}-${name}${suffix ? `-${suffix}` : ''}`
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return `\\\\.\\pipe\\${base}`
  // 注意：这里必须用 posix.join —— 用 path.join 会跟随**宿主**平台的分隔符，
  // 导致在 Windows 上为 POSIX 目标算出 `\home\u\...`（单测已覆盖该回归）
  return posix.join(options.socketDir, `${base}.sock`)
}

export function isWindowsNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith('\\\\')
}

// ---------------------------------------------------------------------------
// 声明校验（扩展在 manifest 里声明的通道）
// ---------------------------------------------------------------------------

export interface IpcChannelDeclaration {
  /** 通道名（同一扩展内唯一） */
  id: string
  /** 传输：stdio（宿主拉起子进程）/ pipe（连接已在运行的进程） */
  transport: IpcTransport
  /** stdio 必填：相对扩展目录的可执行文件/脚本路径（禁止绝对路径与 ..） */
  program?: string
  /** stdio 可选：命令行参数 */
  args?: string[]
  /** 分帧（默认 content-length） */
  framing?: Framing
}

/** 校验一个通道声明；非法即抛 `invalid-declaration` */
export function validateIpcDeclaration(raw: unknown): IpcChannelDeclaration {
  if (!isRecord(raw)) {
    throw new IpcCoreError('invalid-declaration', '通道声明必须是对象')
  }
  const id = sanitizeIpcName(raw.id, '通道 id')
  const transport = raw.transport
  if (transport !== 'stdio' && transport !== 'pipe') {
    throw new IpcCoreError(
      'invalid-declaration',
      `通道 ${id} 的 transport 必须是 'stdio' 或 'pipe'（不支持 TCP/端口）`
    )
  }
  const framing = raw.framing
  if (framing !== undefined && framing !== 'content-length' && framing !== 'ndjson') {
    throw new IpcCoreError('invalid-declaration', `通道 ${id} 的 framing 非法: ${String(framing)}`)
  }
  const declaration: IpcChannelDeclaration = { id, transport }
  if (framing) declaration.framing = framing

  if (transport === 'stdio') {
    const program = raw.program
    if (typeof program !== 'string' || !program.trim()) {
      throw new IpcCoreError('invalid-declaration', `stdio 通道 ${id} 必须声明 program`)
    }
    const normalized = program.replace(/\\/g, '/').replace(/^\.\//, '')
    if (
      isAbsolute(normalized) ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new IpcCoreError(
        'invalid-declaration',
        `stdio 通道 ${id} 的 program 必须是扩展目录内的相对路径: ${program}`
      )
    }
    declaration.program = normalized
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
        throw new IpcCoreError('invalid-declaration', `stdio 通道 ${id} 的 args 必须是字符串数组`)
      }
      declaration.args = raw.args as string[]
    }
  } else if (raw.program !== undefined || raw.args !== undefined) {
    throw new IpcCoreError(
      'invalid-declaration',
      `pipe 通道 ${id} 不应声明 program/args（它是连接已在运行的进程）`
    )
  }
  return declaration
}
