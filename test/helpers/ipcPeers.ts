/**
 * IPC 服务端测试的**真实对端**工具（issue #43）。
 *
 * 为什么要有这个文件：`test/ipc-server.test.ts` 要扮演"连上宿主 pipe 服务端的外部进程"。
 * 从 `test/ipc-transport.test.ts:84-128` 复制（**不 import 测试文件**——导入会连带注册它的 describe）：
 * `createServer`（content-length 极简服务端，用来占住一个端点）、`endpointFor`、`listen`、`waitFor`；
 * 另加本 issue 真正需要的能力：`connectPeer`（作为**客户端**连上宿主 listen 的端点并收发 JSON-RPC 帧）。
 */
import net from 'node:net'
import { join } from 'node:path'

/** 已收到的 JSON-RPC 消息（形状由用例自行窄化） */
export type PeerMessage = Record<string, unknown>

/** 对端对宿主请求的自动应答：`null` = **故意不回包**（超时/在途用例需要） */
export type PeerReply = { result: unknown } | { error: string } | null

export interface IpcPeer {
  readonly label: string
  readonly socket: net.Socket
  /** 按到达顺序记录的完整消息 */
  readonly messages: PeerMessage[]
  /** socket 是否已关闭 */
  readonly isClosed: boolean
  /** 编码并写出一条消息（content-length 分帧） */
  send(msg: unknown): void
  /** 写**原始字节**（非法帧用例用） */
  sendRaw(bytes: Buffer): void
  /** 等一条满足条件的消息；超时返回 null */
  waitFor(predicate: (msg: PeerMessage) => boolean, timeoutMs?: number): Promise<PeerMessage | null>
  /** 等 id 匹配的响应；超时返回 null */
  response(id: number | string, timeoutMs?: number): Promise<PeerMessage | null>
  /** 等 socket 关闭；超时返回 false */
  waitForClose(timeoutMs?: number): Promise<boolean>
  /** 半关闭（发 FIN；服务端随后应看到 close） */
  end(): void
  /** 立即断开（模拟对端崩溃） */
  destroy(): void
}

/**
 * 轮询等待条件成立（最长 timeoutMs）。
 * 照 `test/ipc-transport.test.ts:38-45`：别用固定 `setTimeout` 等异步现象，机器一忙就偶发失败。
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 20))
  }
  return true
}

/** 独立于 `ipcEndpoint()` 的端点参照实现（Windows 命名管道 / POSIX 域套接字；**无 TCP 端口**） */
export function endpointFor(name: string, workDir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\obox-${name}`
    : join(workDir, `obox-${name}.sock`)
}

/**
 * **硬约束（踩过的坑）**：Windows 命名管道是**机器级**命名空间（不含进程 / 临时目录），
 * 所以只要宿主那条连接还活着，对**同一端点**再 `listen` 一次就会失败：
 *
 * ```
 * Error: listen EADDRINUSE \\.\pipe\obox-<扩展id>-<通道名>
 * ```
 *
 * 这就是"每个测试文件的扩展 id 必须唯一"的原因（`test/ipc-server.test.ts` 用 `demo-ext`、
 * `test/ipc-reconnect.test.ts` 用 `reconnect-ext`…）：端点名 = `obox-<扩展id>-<通道名>`，
 * 两个 vitest worker 并行跑、扩展 id 撞名就会互相抢端点（表现为随机的 EADDRINUSE 或
 * "连上了别的测试的对端"）。同名端点要复用，必须先真正 `kill()`（销毁全部连接 + 停止监听，
 * POSIX 还要删掉陈旧的 `.sock`）。
 */
export function listen(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(endpoint, () => resolvePromise())
  })
}

/** content-length 分帧的极简服务端（测试扮演"占住端点的另一个进程"） */
export function createServer(
  onMessage: (send: (msg: unknown) => void, msg: Record<string, unknown>) => void
): net.Server {
  const buffers = new Map<net.Socket, Buffer>()
  const server = net.createServer((socket) => {
    buffers.set(socket, Buffer.alloc(0))
    const send = (msg: unknown): void => {
      const payload = Buffer.from(JSON.stringify(msg), 'utf8')
      socket.write(
        Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload])
      )
    }
    socket.on('data', (chunk: Buffer) => {
      let buf = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), chunk])
      for (;;) {
        const i = buf.indexOf('\r\n\r\n')
        if (i < 0) break
        const len = Number(
          /content-length:\s*(\d+)/i.exec(buf.subarray(0, i).toString())?.[1] ?? '0'
        )
        if (buf.length < i + 4 + len) break
        const payload = buf.subarray(i + 4, i + 4 + len)
        buf = buf.subarray(i + 4 + len)
        onMessage(send, JSON.parse(payload.toString('utf8')) as Record<string, unknown>)
      }
      buffers.set(socket, buf)
    })
    socket.on('close', () => buffers.delete(socket))
  })
  return server
}

/** content-length 分帧编码 */
export function encodeFrame(msg: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload])
}

export interface ConnectPeerOptions {
  label?: string
  /**
   * 宿主发来请求时的自动应答（content-length 分帧回包）。
   * 返回 `null` = **不回包**（用于超时与"在途请求不重放"用例）。
   */
  respond?: (method: string, params: unknown, msg: PeerMessage) => PeerReply
}

/** 作为**客户端**连上宿主 listen 的端点，并记录收到的每条消息 */
export function connectPeer(endpoint: string, options: ConnectPeerOptions = {}): Promise<IpcPeer> {
  return new Promise<IpcPeer>((resolvePromise, rejectPromise) => {
    const label = options.label ?? 'peer'
    const messages: PeerMessage[] = []
    const socket = net.createConnection(endpoint)
    let closed = false
    let buffer = Buffer.alloc(0)

    const peer: IpcPeer = {
      label,
      socket,
      messages,
      get isClosed(): boolean {
        return closed
      },
      send: (msg: unknown): void => {
        socket.write(encodeFrame(msg))
      },
      sendRaw: (bytes: Buffer): void => {
        socket.write(bytes)
      },
      waitFor: async (
        predicate: (msg: PeerMessage) => boolean,
        timeoutMs = 3000
      ): Promise<PeerMessage | null> => {
        const found = await waitFor(() => messages.some(predicate), timeoutMs)
        return found ? (messages.find(predicate) ?? null) : null
      },
      response: (id: number | string, timeoutMs = 3000): Promise<PeerMessage | null> =>
        peer.waitFor((msg) => msg.id === id && ('result' in msg || 'error' in msg), timeoutMs),
      waitForClose: (timeoutMs = 3000): Promise<boolean> => waitFor(() => closed, timeoutMs),
      end: (): void => void socket.end(),
      destroy: (): void => void socket.destroy()
    }

    socket.on('connect', () => resolvePromise(peer))
    socket.once('error', (err) => rejectPromise(err))
    // resolve 之后仍要兜住后续错误（否则未处理的 'error' 会抛）
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      for (;;) {
        const i = buffer.indexOf('\r\n\r\n')
        if (i < 0) break
        const len = Number(
          /content-length:\s*(\d+)/i.exec(buffer.subarray(0, i).toString())?.[1] ?? '0'
        )
        if (buffer.length < i + 4 + len) break
        const payload = buffer.subarray(i + 4, i + 4 + len)
        buffer = buffer.subarray(i + 4 + len)
        let parsed: PeerMessage
        try {
          parsed = JSON.parse(payload.toString('utf8')) as PeerMessage
        } catch {
          continue
        }
        messages.push(parsed)
        if (typeof parsed.method === 'string' && parsed.id !== undefined && options.respond) {
          const reply = options.respond(parsed.method, parsed.params, parsed)
          if (reply === null) continue
          peer.send(
            'error' in reply
              ? { jsonrpc: '2.0', id: parsed.id, error: { code: -32603, message: reply.error } }
              : { jsonrpc: '2.0', id: parsed.id, result: reply.result }
          )
        }
      }
    })
    socket.on('close', () => {
      closed = true
    })
  })
}
