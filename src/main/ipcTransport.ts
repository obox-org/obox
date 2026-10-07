/**
 * IPC 传输层（**不依赖 electron**，可独立单测）：把"字节怎么走"与协议实现分开。
 *
 * - `stdio`：宿主 spawn 子进程，用它的 stdin/stdout 承载协议、stderr 作日志
 * - `pipe`：`node:net` 连接**已在运行**的进程（Windows 命名管道 / POSIX Unix 域套接字）
 *
 * **不使用 TCP 端口**。传输层只做两件事：把收到的字节喂给 `JsonRpcChannel.accept()`，
 * 把 `sendFrame` 给出的字节写出去；协议、分帧、超时、限额都在 `ipcCore.ts`。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { resolve, sep } from 'node:path'
import { IpcCoreError, JsonRpcChannel, type Framing } from './ipcCore'

export interface IpcTransportHandles {
  channel: JsonRpcChannel
  /** 传输就绪（stdio：进程已 spawn；pipe：已连上）；失败即 reject */
  ready: Promise<void>
  /** 对端日志（stdio 的 stderr；pipe 没有独立日志流） */
  onStderr(listener: (text: string) => void): { dispose(): void }
  /** 通道关闭（含对端崩溃/主动断开） */
  onClose(listener: (err: IpcCoreError | null) => void): { dispose(): void }
  /** 主动关闭：终止子进程 / 关闭套接字 */
  dispose(): void
}

/** 子进程环境：只继承最小集（不把宿主的密钥类变量透给对端） */
function minimalEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) {
    const value = process.env[key]
    if (value) base[key] = value
  }
  return { ...base, ...(extra ?? {}) }
}

/**
 * 把扩展声明的相对 program 解析成绝对路径，并校验**没有越出扩展目录**。
 * （声明校验在 ipcCore 已挡绝对路径与 `..`；这里是第二道——解析后再做包含检查。）
 */
export function resolveProgramInExtension(extensionDir: string, program: string): string {
  const base = resolve(extensionDir)
  const target = resolve(base, program)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new IpcCoreError('invalid-declaration', `program 越出扩展目录: ${program}`)
  }
  return target
}

export interface StdioTransportOptions {
  /** 绝对路径（调用方用 resolveProgramInExtension 解析并校验） */
  program: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  framing?: Framing
  maxMessageBytes?: number
  defaultTimeoutMs?: number
}

/** 由宿主拉起子进程，用 stdio 双向通信 */
export function openStdioTransport(options: StdioTransportOptions): IpcTransportHandles {
  let disposed = false
  let child: ChildProcess | null = null
  const stderrListeners = new Set<(text: string) => void>()

  const channel = new JsonRpcChannel({
    framing: options.framing,
    maxMessageBytes: options.maxMessageBytes,
    defaultTimeoutMs: options.defaultTimeoutMs,
    sendFrame: (frame) => {
      const stdin = child?.stdin
      if (!stdin || !stdin.writable) {
        throw new IpcCoreError('not-connected', '对端 stdin 不可写（进程可能已退出）')
      }
      stdin.write(frame)
    }
  })

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child = spawn(options.program, options.args ?? [], {
      cwd: options.cwd,
      env: minimalEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    })
    child.once('spawn', () => resolveReady())
    child.once('error', (err) => {
      const coreErr = new IpcCoreError('connect-failed', `启动对端失败: ${err.message}`)
      rejectReady(coreErr)
      channel.close(coreErr)
    })
    child.stdout?.on('data', (chunk: Buffer) => channel.accept(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      for (const listener of [...stderrListeners]) listener(text)
    })
    child.on('exit', (code, signal) => {
      if (disposed) return
      channel.close(
        new IpcCoreError(
          'peer-crashed',
          `对端进程退出（code=${String(code)}, signal=${String(signal)}）`
        )
      )
    })
  })
  // 没人 await 时不要产生未处理拒绝（调用方仍可 await 拿到错误）
  ready.catch(() => {})

  return {
    channel,
    ready,
    onStderr: (listener) => {
      stderrListeners.add(listener)
      return { dispose: (): void => void stderrListeners.delete(listener) }
    },
    onClose: (listener) => channel.onClose(listener),
    dispose: (): void => {
      disposed = true
      channel.close()
      if (child && !child.killed) child.kill()
    }
  }
}

export interface StreamTransportOptions {
  /** 协议输入（对端 → 宿主） */
  readable: NodeJS.ReadableStream
  /** 协议输出（宿主 → 对端） */
  writable: NodeJS.WritableStream
  framing?: Framing
  maxMessageBytes?: number
  defaultTimeoutMs?: number
  /** 主动关闭时的清理回调（如杀进程树、销毁套接字）；应当幂等 */
  onDispose?: () => void
}

/**
 * 用**调用方已建立的流**承载协议（issue #51：宿主以 shell 方式拉起的解释器进程）。
 *
 * 与 `openStdioTransport` 的区别：这里不 spawn、也不管 stderr——流从哪来、日志怎么收由调用方决定。
 * 对端结束/退出时，由调用方 `channel.close(new IpcCoreError('peer-crashed', …))` 收尾
 * （`ipc.ts` 注册通道时会挂 onClose 做广播与注销）。
 */
export function openStreamTransport(options: StreamTransportOptions): IpcTransportHandles {
  const channel = new JsonRpcChannel({
    framing: options.framing,
    maxMessageBytes: options.maxMessageBytes,
    defaultTimeoutMs: options.defaultTimeoutMs,
    sendFrame: (frame) => {
      if (!options.writable.writable) {
        throw new IpcCoreError('not-connected', '对端输入流不可写（进程可能已退出）')
      }
      options.writable.write(frame)
    }
  })

  options.readable.on('data', (chunk: Buffer) => channel.accept(chunk))

  return {
    channel,
    // 流已经建立，无需等待连接
    ready: Promise.resolve(),
    // 没有独立的 stderr 流：对端日志请由调用方自行转发（如解释器的 stderr 收集）
    onStderr: () => ({ dispose: (): void => {} }),
    onClose: (listener) => channel.onClose(listener),
    dispose: (): void => {
      channel.close()
      options.onDispose?.()
    }
  }
}

export interface PipeClientTransportOptions {
  /** 端点：Windows `\\.\pipe\…`；POSIX `<dir>/….sock` */
  endpoint: string
  framing?: Framing
  maxMessageBytes?: number
  defaultTimeoutMs?: number
}

/** 作为客户端连接一个已在运行的对端（命名管道 / Unix 域套接字） */
export function openPipeClientTransport(options: PipeClientTransportOptions): IpcTransportHandles {
  let disposed = false
  let connected = false
  const socket = net.createConnection(options.endpoint)

  const channel = new JsonRpcChannel({
    framing: options.framing,
    maxMessageBytes: options.maxMessageBytes,
    defaultTimeoutMs: options.defaultTimeoutMs,
    sendFrame: (frame) => {
      if (!socket.writable) throw new IpcCoreError('not-connected', '套接字不可写（连接已断开）')
      socket.write(frame)
    }
  })

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    socket.once('connect', () => {
      connected = true
      resolveReady()
    })
    socket.once('error', (err) => {
      const coreErr = new IpcCoreError(
        connected ? 'peer-crashed' : 'connect-failed',
        `连接 ${options.endpoint} 失败: ${err.message}`
      )
      if (!connected) rejectReady(coreErr)
      channel.close(coreErr)
    })
  })
  ready.catch(() => {})
  socket.on('data', (chunk: Buffer) => channel.accept(chunk))
  socket.on('close', () => {
    if (disposed) return
    channel.close(new IpcCoreError('peer-crashed', '对端连接已关闭'))
  })

  return {
    channel,
    ready,
    // pipe 没有单独的 stderr 流：对端日志由对端自己经通道发通知
    onStderr: () => ({ dispose: (): void => {} }),
    onClose: (listener) => channel.onClose(listener),
    dispose: (): void => {
      disposed = true
      channel.close()
      socket.destroy()
    }
  }
}
