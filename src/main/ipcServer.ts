/**
 * IPC **服务端**传输（**不依赖 electron**，可独立单测，issue #43）。
 *
 * 宿主作为服务端 `listen` 一个命名管道 / Unix 域套接字，接受**多条**对端连接；
 * 每条连接一条独立的 `JsonRpcChannel`（**协议零改动**，与客户端通道共用 `ipcCore`）。
 *
 * 与 `ipcTransport.ts` 的分工：
 * - `ipcTransport.ts`：**一条通道一条传输**（客户端拨号 / stdio / 已有流），形状 `IpcTransportHandles`；
 * - 本模块：**一条传输多条连接**，形状 `IpcServerHandles`。连接注册表、连接 ID 分配、
 *   连接数超限拒绝、陈旧端点处置（POSIX）、断连清理都在这里。
 *
 * 平台差异（R10/R11）：Windows 命名管道在内核命名空间、无落盘文件 → **不探测陈旧端点、不 chmod**；
 * POSIX 域套接字有落盘文件 → listen 前**试连探测**（连上=有活着的服务端，报错且不删；连不上=陈旧，unlink），
 * listen 成功后 `chmod 0600`，dispose 时 unlink。分支由 `endpointPrepPlan(platform)` 这个纯函数决定，
 * 便于在任一平台单测两条分支。
 */
import net from 'node:net'
import { promises as fs } from 'node:fs'
import {
  IpcCoreError,
  JsonRpcChannel,
  RPC_INTERNAL_ERROR,
  createFrameParser,
  isIpcCoreError,
  type Framing
} from './ipcCore'

/**
 * 连接 ID 计数器：**模块级 = 进程内全局**、单调递增、**永不复用**（issue #43 R7）。
 *
 * 放在模块级而非每个 server 一份，是为了彻底消除"旧 ID 撞上新连接"的误投：
 * 同名 server 关闭后重新 listen，新连接也只会拿到更大的 ID。
 */
let nextConnectionId = 1

/** **仅供测试**：把连接 ID 计数器复位（不导出给生产使用；不进任何生产调用路径） */
export function resetConnectionIdCounterForTest(): void {
  nextConnectionId = 1
}

/** 一条被接受的服务端连接（对 `ipc.ts` 暴露的句柄） */
export interface IpcServerConnection {
  readonly connectionId: number
  /** 该连接独立的协议状态机（分帧/请求关联/超时/并发上限） */
  readonly channel: JsonRpcChannel
  /** 对端地址（诊断用；Unix 域套接字通常为空串） */
  readonly remote: string
  /** 从注册表移除 + 关闭通道 + 销毁套接字（**幂等**；`reason` 为 null 表示宿主主动关闭） */
  dispose(reason?: IpcCoreError | null): void
}

/** 服务端传输句柄（一传输 N 连接） */
export interface IpcServerHandles {
  /** listen 成功（含 POSIX 陈旧文件处置与 chmod）；失败即 reject（`connect-failed`） */
  readonly ready: Promise<void>
  /** 实际使用的端点（**不带 suffix**） */
  readonly endpoint: string
  readonly connectionCount: number
  getConnection(connectionId: number): IpcServerConnection | undefined
  /** 当前连接 ID 列表（升序快照；定向投递与测试用） */
  listConnections(): number[]
  /** 向当前全部连接各发一条**通知**；无连接静默；单条写失败按该连接断开处理 */
  broadcast(method: string, params?: unknown): void
  /** 停止监听、断开全部连接、释放端点（幂等） */
  dispose(): void
}

export interface PipeServerOptions {
  /** 端点（调用方用 `ipcEndpoint()` 算出，**不带 suffix**） */
  endpoint: string
  framing?: Framing
  maxMessageBytes?: number
  defaultTimeoutMs?: number
  /** 连接上限（`ipc.ts` 传 `MAX_CONNECTIONS_PER_SERVER`） */
  maxConnections: number
  /** 平台（默认 `process.platform`；显式注入以便两平台分支都单测） */
  platform?: NodeJS.Platform | string
  /** 一条连接**被接受后**回调（被超限拒绝的连接不触发） */
  onConnection?: (connectionId: number) => void
  /** 一条**已接受**的连接断开（恰好一次；`null` = 宿主主动关闭） */
  onDisconnect?: (connectionId: number, reason: IpcCoreError | null) => void
  /** 对端请求处理器（由 `ipc.ts` 注入：转发到渲染进程） */
  onRequest?: (connectionId: number, method: string, params: unknown) => unknown
  /** 诊断日志（默认 `console.warn`） */
  log?: (message: string, detail?: unknown) => void
}

/** 平台分叉的**纯函数**：Windows 命名管道无落盘文件 → 不探测、不 chmod */
export function endpointPrepPlan(platform: NodeJS.Platform | string): {
  /** 是否执行"试连旧端点以判断是否被活着的服务端占用"（POSIX） */
  probeStale: boolean
  /** listen 成功后是否 `chmod 0600`（POSIX） */
  chmod: boolean
} {
  return platform === 'win32'
    ? { probeStale: false, chmod: false }
    : { probeStale: true, chmod: true }
}

/**
 * POSIX：试连端点。
 * - **连上** → 说明有活着的服务端（返回 true，调用方**不得**删除该文件）；
 * - 连不上（`ECONNREFUSED` / `ENOENT` / 超时 / 非套接字文件）→ 视为陈旧（返回 false）。
 */
export function probeEndpointAlive(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const socket = net.createConnection(endpoint)
    const finish = (alive: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function isAddrInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE'
}

/** 打开一个 pipe 端点并接受多条连接（本模块的唯一入口） */
export function openPipeServerTransport(options: PipeServerOptions): IpcServerHandles {
  const platform = options.platform ?? process.platform
  const plan = endpointPrepPlan(platform)
  const log =
    options.log ??
    ((message: string, detail?: unknown): void => {
      if (detail === undefined) console.warn(message)
      else console.warn(message, detail)
    })
  const framing = options.framing
  const connections = new Map<number, IpcServerConnection>()
  let closed = false
  /** 只有**成功 listen** 之后才允许 unlink 端点（否则会删掉别人活着的文件） */
  let listening = false

  const server = net.createServer()
  // 常驻 error 处理器：监听失败另有一次性处理器负责 reject，这里只兜住后续错误
  server.on('error', (err) => log(`[ipc] 服务端 ${options.endpoint} 出错`, err))

  /** 超限拒绝：先回一条 JSON-RPC 错误帧，再关闭套接字；**不分配连接 ID、不触发任何事件** */
  function rejectTooMany(socket: net.Socket): void {
    const message = `[too-many-connections] 连接数已达上限 ${options.maxConnections}（该 server 的既有连接不受影响）`
    try {
      const payload = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: RPC_INTERNAL_ERROR, message }
        }),
        'utf8'
      )
      // 用**该 server 声明的 framing** 编码，否则对端解不出来
      socket.write(createFrameParser(framing, options.maxMessageBytes).encode(payload))
      socket.end()
    } catch (err) {
      log(`[ipc] 回超限拒绝帧失败`, err)
      socket.destroy()
    }
  }

  server.on('connection', (socket) => {
    if (closed) {
      socket.destroy()
      return
    }
    if (connections.size >= options.maxConnections) {
      rejectTooMany(socket)
      return
    }
    socket.setNoDelay(true)
    const connectionId = nextConnectionId++
    const remote = socket.remoteAddress ?? ''

    const channel = new JsonRpcChannel({
      framing,
      maxMessageBytes: options.maxMessageBytes,
      defaultTimeoutMs: options.defaultTimeoutMs,
      sendFrame: (frame) => {
        if (!socket.writable) throw new IpcCoreError('not-connected', '套接字不可写（连接已断开）')
        socket.write(frame)
      }
    })

    let disposed = false
    const connection: IpcServerConnection = {
      connectionId,
      channel,
      remote,
      dispose: (reason?: IpcCoreError | null): void => {
        if (disposed) return
        disposed = true
        // 1) 先从注册表移除：此后定向投递立即 not-connected，新连入也看不到这个 ID
        connections.delete(connectionId)
        // 2) 关该连接的协议状态机：它的出站挂起请求全部以断因码失败
        channel.close(reason ?? undefined)
        // 3) 通知上层（ipc.ts 在此结算"转发到渲染进程的在途请求"并广播 disconnect 事件）
        options.onDisconnect?.(connectionId, reason ?? null)
        // 4) 销毁套接字（协议错误场景必须真的断开，否则半死连接继续占额度）
        socket.destroy()
      }
    }

    // 通道自行关闭（非法帧 protocol-error / 对端写失败）→ 走同一条收尾链
    channel.onClose((err) =>
      connection.dispose(err ?? new IpcCoreError('channel-closed', '通道已关闭'))
    )
    channel.setDefaultHandler(
      options.onRequest
        ? (method, params) => options.onRequest?.(connectionId, method, params)
        : null
    )
    socket.on('data', (chunk: Buffer) => channel.accept(chunk))
    socket.on('error', (err: Error) =>
      connection.dispose(new IpcCoreError('peer-crashed', `对端连接异常: ${err.message}`))
    )
    socket.on('close', () => connection.dispose(new IpcCoreError('peer-crashed', '对端连接已关闭')))

    connections.set(connectionId, connection)
    options.onConnection?.(connectionId)
  })

  /** 只 listen 一次；失败以原始错误 reject（由调用方决定重试/映射文案） */
  function listenOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(options.endpoint)
    })
  }

  async function unlinkQuiet(): Promise<void> {
    await fs.unlink(options.endpoint).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') log(`[ipc] 清理端点失败 ${options.endpoint}`, err)
    })
  }

  function toConnectFailed(err: unknown): IpcCoreError {
    if (isIpcCoreError(err)) return err
    const message = err instanceof Error ? err.message : String(err)
    return new IpcCoreError(
      'connect-failed',
      `端点已被占用或无法监听: ${options.endpoint}（${message}）`
    )
  }

  async function prepareAndListen(): Promise<void> {
    if (plan.probeStale) {
      // 连上 = 有活着的服务端 → 报错且**不删除**（R10）；连不上 = 陈旧 → unlink 后重新 listen
      if (await probeEndpointAlive(options.endpoint)) {
        throw new IpcCoreError('connect-failed', `端点已被占用: ${options.endpoint}`)
      }
      await unlinkQuiet()
    }
    try {
      await listenOnce()
    } catch (err) {
      // K3 竞态：探测与 listen 之间可能有他人抢先 listen → 重试一次
      if (!plan.probeStale || !isAddrInUse(err)) throw toConnectFailed(err)
      await unlinkQuiet()
      try {
        await listenOnce()
      } catch (err2) {
        throw toConnectFailed(err2)
      }
    }
    listening = true
    if (plan.chmod) {
      await fs.chmod(options.endpoint, 0o600).catch((err: unknown) => {
        log(`[ipc] chmod 0600 失败 ${options.endpoint}`, err)
      })
    }
  }

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    void prepareAndListen().then(resolveReady, rejectReady)
  })
  // 没人 await 时不要产生未处理拒绝（调用方仍可 await 拿到错误）
  ready.catch(() => {})

  return {
    ready,
    endpoint: options.endpoint,
    get connectionCount(): number {
      return connections.size
    },
    getConnection: (connectionId) => connections.get(connectionId),
    listConnections: (): number[] => [...connections.keys()].sort((a, b) => a - b),
    broadcast: (method, params): void => {
      for (const connection of [...connections.values()]) {
        try {
          connection.channel.notify(method, params)
        } catch (err) {
          // 消息校验失败（message-too-large）与连接健康无关 → 只跳过并记日志，**不断开**健康连接
          if (isIpcCoreError(err) && err.code === 'message-too-large') {
            log(`[ipc] 广播跳过连接 ${connection.connectionId}（消息超过上限）`)
            continue
          }
          // 套接字层写失败 → 按该连接断开处理（broadcast 本身不抛错）
          log(`[ipc] 广播写入连接 ${connection.connectionId} 失败，按断开处理`, err)
          connection.dispose(
            isIpcCoreError(err) ? err : new IpcCoreError('peer-crashed', String(err))
          )
        }
      }
    },
    dispose: (): void => {
      if (closed) return
      closed = true
      for (const connection of [...connections.values()]) connection.dispose(null)
      server.close(() => {})
      // 只有真正 listen 成功过才释放端点文件（否则可能删掉别人活着的 .sock）
      if (listening && plan.probeStale) void unlinkQuiet()
    }
  }
}
