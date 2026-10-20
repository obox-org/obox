/**
 * **进程族（一）**：`api.ipc`（与外部进程的双向通道，14 个成员）——EH-B2。
 *
 * 位置与分工沿用 EH-B1 的先例：`apiFactory.ts` 只做装配，实现落在本文件。本卡的文件所有权只到
 * `capabilities/{ipc,python,sqlite}.ts` + `apiFactory.ts`，因此**协议与传输层一行不改**，全部
 * 只读复用 main 的纯 Node 模块（都不 import electron，可被宿主 bundle 直接引用）：
 *
 * | 复用什么 | 为什么 |
 * | --- | --- |
 * | `src/main/ipcCore.ts` 的 `JsonRpcChannel` / `IpcCoreError` / `isIpcCoreError` / `ipcEndpoint` / `resolveStdioSpawn` | JSON-RPC 2.0 + 两种分帧 + 超时/并发/限额 + 端点命名只有一份实现，抄一份必然分叉 |
 * | `src/main/ipcTransport.ts` 的 `openStreamTransport` / `openPipeClientTransport` / `resolveProgramInExtension` / `IpcTransportHandles` | 传输层（字节怎么走）与协议层分离；`program` 越界校验也只有一份 |
 * | `src/main/ipcServer.ts` 的 `openPipeServerTransport` | `listen`（per-connection 通道、连接 ID、超限拒绝） |
 * | `src/main/ipcReconnect.ts` 的 `createReconnectController` / `isReconnectableCloseReason` | `pipe` + `autoReconnect` 的退避语义 |
 *
 * ## 为什么 `stdio` 的 spawn 由本文件持有（而不是直接用 `openStdioTransport`）
 *
 * `openStdioTransport` 内部 spawn 后**不把 `ChildProcess` 交出来**，而本卡有两条硬要求它做不到：
 * 1. **清理要"先 kill、宽限后强杀"**：只 `kill()` 一次，在 Windows 上对 `cmd` 包装/卡住的子进程
 *    不保证结束；需要有句柄来补 `SIGKILL`。
 * 2. **测试要能断言"进程真被杀"**：拿不到 pid 就只能断言"调用过 kill"，那是假证据。
 *
 * 因此 spawn 由本文件做（`startStdioSidecar`），**协议与分帧仍然 100% 走 `openStreamTransport`**
 * （它的 `readable`/`writable` 参数本来就是为了"调用方自己拉起进程"这个场景设计的，见其文件头：
 * issue #51）。也就是说：没有复制任何协议代码，多出来的只有"子进程生命周期"（spawn/就绪/stderr
 * 转发/退出归因/宽限强杀/unref）这一层。
 *
 * ## 语义对齐（逐条照 `src/api/types.ts` 的 `api.ipc` 注释实现）
 *
 * - `connect`：`stdio` 由宿主拉起子进程（`program` 必须是扩展目录内相对路径）；`pipe` 连已在运行的
 *   进程；`connect('<id>')` 的声明来自**宿主自己读的** `<扩展目录>/manifest.json` 的
 *   `contributes.ipcChannels`（R61 裁定，见 `readManifestFile`；有进程内缓存，只读一次盘）；
 * - `listen`：宿主作为服务端接受多条连接（`connectionId` 单调递增、永不复用）；
 * - `close(name)`：client/server 统一关闭，**幂等**、不存在时静默成功；
 * - `request` / `notify`：server 名字必须给 `connectionId`，client 通道不得给（`invalid-declaration`）；
 * - `broadcast`：只对 server，已断开的连接跳过、无连接静默成功；
 * - 事件：`onRequest`（**只生效最先注册的那个**）/ `onNotification` / `onClose` / `onStderr` /
 *   `onConnection` / `onDisconnect` / `onReconnect`；
 * - 错误码沿用 `IpcCoreError` 的稳定码（抛出的就是它，扩展可读 `error.code`）。
 *
 * ## 清理
 *
 * `dispose()`（宿主停用扩展/退出时调）：
 * - 取消所有重连控制器 → 关所有 client 传输（stdio 子进程 kill + 宽限后强杀）与 server；
 * - 清空全部监听器表（此后同名通道重新 connect 从空表开始）；
 * - 子进程与定时器都 `unref`：**不拖住宿主退出**。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Disposable } from '../../api/runtime'
import type { ExtensionActivationApi } from '../../api/types'
import type { IpcChannelDeclaration, ResolvedAutoReconnect } from '../../shared/ipcDeclaration'
import {
  checkIpcChannelList,
  IpcDeclarationError,
  resolveIpcChannelDeclaration,
  validateRuntimeIpcDeclaration
} from '../../shared/ipcDeclaration'
import type { RuntimeIpcChannelDeclaration } from '../../shared/ipcDeclaration'
import { IpcCoreError, ipcEndpoint, isIpcCoreError, resolveStdioSpawn } from '../../main/ipcCore'
import { createReconnectController, isReconnectableCloseReason } from '../../main/ipcReconnect'
import type { ReconnectController } from '../../main/ipcReconnect'
import {
  openPipeClientTransport,
  openStreamTransport,
  resolveProgramInExtension,
  type IpcTransportHandles
} from '../../main/ipcTransport'
import { openPipeServerTransport, type IpcServerHandles } from '../../main/ipcServer'
import { toErrorMessage } from '../errors'
import type { HostLogger } from '../log'
import { unrefTimer } from '../timers'

/* -------------------------------------------------------------------------------------------- */
/* 常量                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** 每扩展同时打开的通道上限（**client 与 server 共用**；与 main 的同名常量一致） */
export const MAX_CHANNELS_PER_EXTENSION = 4

/** 单个 server 允许的并发连接上限（连接不计入通道数上限） */
export const MAX_CONNECTIONS_PER_SERVER = 16

/** 子进程终止的宽限期（毫秒）：先 `kill()`，到期仍活着再强杀 */
export const DEFAULT_KILL_GRACE_MS = 2000

/** 关闭事件里的缺省断因（`src/api/types.ts` 的稳定错误码之一） */
const CHANNEL_CLOSED = 'channel-closed'

/* -------------------------------------------------------------------------------------------- */
/* 工厂参数与返回值                                                                               */
/* -------------------------------------------------------------------------------------------- */

export interface HostIpcCapabilitiesOptions {
  /** 扩展 id（通道归属 + 日志） */
  extId: string
  /** **扩展根目录**（`program` 的解析基准；来自 `init.extensions[].path`） */
  extensionDir: string
  /** 扩展 data 目录（stdio 子进程的 cwd；套接字目录**不再**由它推导，见 `socketDir`） */
  extensionDataDir: string
  /** 宿主日志 */
  log: HostLogger
  /**
   * POSIX 下的套接字目录（Windows 命名管道在内核命名空间，**用不到它**）。
   *
   * **生产链路（R63）**：`runtime.ts` 显式传 `join(init.dataDir, 'ipc')` → `apiFactory` 原样透传 →
   * 这里，取值与 main 的 `ipcSocketDir()` **逐字一致**。`src/api/types.ts` 写明了 POSIX 端点形如
   * `<userData>/ipc/obox-<扩展id>-<通道名>.sock`，对端程序按文档算出的路径必须对得上，所以这个值
   * 只能由知道 `init.dataDir` 的地方给（本文件拿不到 userData，也不该反推）。
   *
   * 缺省 = `<扩展 data 目录>/ipc`：仅在没有 `init` 的嵌入场景/单测里走到（只影响 POSIX）。
   */
  socketDir?: string
  /**
   * 清单静态声明的通道（`contributes.ipcChannels`），`connect('<id>')` 用。
   *
   * **缺省为 undefined，且不需要调用方注入**：`init.extensions` 的 `HostedExtensionInfo` 是
   * **封闭白名单**（`src/shared/extensionHostProtocol.ts` 的 `HOSTED_EXTENSION_FIELDS`），没有该
   * 字段；加字段要升 `PROTOCOL_VERSION` 并改 `src/shared/**` + 渲染侧载荷，代价远大于收益。
   * 因此 R61 的裁定是：**宿主自己读 `<扩展目录>/manifest.json`**（与 loader 读 `main` 同一先例：
   * "读一个已知文件，不是扫目录"）。这个参数只留给"以后协议真的下发清单"或单测直接注入。
   */
  manifestChannels?: readonly IpcChannelDeclaration[]
  /**
   * 读扩展清单文本（缺省读 `<extensionDir>/manifest.json`）。
   *
   * 注入点存在的唯一理由：让"**同一扩展多次 connect 只读一次盘**"这条可断言（否则测试只能
   * 通过副作用猜）。生产实现见 `readManifestFile`。
   */
  readManifest?: (extensionDir: string) => string
  /** 子进程终止宽限（毫秒，缺省 `DEFAULT_KILL_GRACE_MS`） */
  killGraceMs?: number
  /** 通道上限（缺省 `MAX_CHANNELS_PER_EXTENSION`） */
  maxChannels?: number
  /** server 连接上限（缺省 `MAX_CONNECTIONS_PER_SERVER`） */
  maxConnectionsPerServer?: number
}

/** `python.run({ channel })` 交给本能力的流（与 main 的 `registerStreamChannel` 同义） */
export interface StreamChannelInput {
  readable: NodeJS.ReadableStream
  writable: NodeJS.WritableStream
  framing?: RuntimeIpcChannelDeclaration['framing']
  /** 主动关闭该通道时的收尾（如杀解释器进程） */
  onDispose?: () => void
}

/** IPC 能力族 */
export interface IpcCapabilities {
  /** `api.ipc`（声明里的 14 个成员全量） */
  readonly api: ExtensionActivationApi['ipc']
  /**
   * 把**已建立的流**注册成一条 client 通道（宿主内部用：`api.python.run` 的 `channel` 选项）。
   * 不进扩展 API 面（扩展看不到它），与 main 的 `registerStreamChannel` 一一对应。
   */
  registerStreamChannel(name: string, streams: StreamChannelInput): void
  /** 注销一条通道（进程结束/取消时用；触发一次 `close` 事件；幂等） */
  closeChannel(name: string): void
  /** 当前活动通道名（诊断；含 server 名） */
  channelNames(): string[]
  /** 当前活动 sidecar 子进程 pid（诊断/测试断言"进程真被杀"用） */
  childPids(): number[]
  /** 关掉一切（扩展停用/宿主退出；幂等） */
  dispose(): void
}

/* -------------------------------------------------------------------------------------------- */
/* 子进程 sidecar                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** 一条由宿主拉起的 stdio 子进程（协议层是 `openStreamTransport`，生命周期在本文件） */
interface SidecarProcess {
  readonly transport: IpcTransportHandles
  /** 就绪 = 子进程 `spawn` 成功；spawn 失败即 reject（`connect-failed`） */
  ready: Promise<void>
  /** 子进程 pid（spawn 失败时为 undefined） */
  pid(): number | undefined
  /** 先 `kill()`，宽限后强杀（幂等；定时器 unref，不拖住宿主退出） */
  kill(): void
  /** 是否已经结束（诊断用） */
  exited(): boolean
}

/**
 * 拉起一个 stdio sidecar，并把它的 stdin/stdout 交给 `openStreamTransport` 承载 JSON-RPC。
 *
 * 三个必须自己做的点（见文件头）：
 * 1. **`ELECTRON_RUN_AS_NODE`**：`.js/.cjs/.mjs` 助手用宿主自带的 Node 跑（`resolveStdioSpawn`
 *    给出 program/args/env；不给这个变量时 Electron 会以应用模式启动，stdin 不接、协议不通）；
 * 2. **stderr 转发**：`openStreamTransport` 没有 stderr 概念，这里把 `child.stderr` 的块交给
 *    `onStderr` 监听器（`api.ipc.onStderr` 的音源）；
 * 3. **退出 → `peer-crashed`**：主动 dispose 触发的退出不算崩溃（`disposed` 为 true 时直接忽略）。
 */
function startStdioSidecar(options: {
  program: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  framing?: RuntimeIpcChannelDeclaration['framing']
  graceMs: number
  onStderr: (text: string) => void
  onExit: (error: IpcCoreError) => void
}): SidecarProcess {
  const child: ChildProcessWithoutNullStreams = spawn(options.program, options.args ?? [], {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true
  })

  let disposed = false
  let didExit = false
  let spawned = false
  let forceTimer: ReturnType<typeof setTimeout> | null = null

  // 宿主退出时不被这个子进程拖住（stdio 管道仍会短暂 hold 住 loop，kill 由 dispose 负责）
  child.unref()

  const transport = openStreamTransport({
    readable: child.stdout,
    writable: child.stdin,
    ...(options.framing === undefined ? {} : { framing: options.framing }),
    onDispose: (): void => {
      kill()
    }
  })

  /**
   * 就绪 = `spawn` 事件（不是 `openStreamTransport` 的 `ready`：流是现成的，它恒为 resolved）。
   * **首连失败必须让 `connect()` 抛 `connect-failed`**（`src/api/types.ts` 的稳定码），所以这里
   * 自己造一个：spawn 失败（ENOENT/EACCES）即 reject，之后才转交给通道状态机。
   */
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child.once('spawn', () => {
      spawned = true
      resolveReady()
    })
    child.once('error', (error: Error) => {
      if (!spawned) {
        rejectReady(new IpcCoreError('connect-failed', `启动对端失败: ${error.message}`))
        return
      }
      if (disposed) return
      options.onExit(new IpcCoreError('connect-failed', `对端进程出错: ${error.message}`))
    })
  })
  // 没人 await 时不要产生未处理拒绝（调用方仍可 await 拿到错误）
  ready.catch(() => {})

  child.stderr?.on('data', (chunk: Buffer) => {
    options.onStderr(chunk.toString('utf8'))
  })
  child.on('exit', (code, signal) => {
    didExit = true
    clearForceTimer()
    if (disposed) return
    options.onExit(
      new IpcCoreError(
        'peer-crashed',
        `对端进程退出（code=${String(code)}, signal=${String(signal)}）`
      )
    )
  })

  function clearForceTimer(): void {
    if (forceTimer === null) return
    clearTimeout(forceTimer)
    forceTimer = null
  }

  function kill(): void {
    disposed = true
    if (didExit) return
    try {
      child.kill()
    } catch {
      // 已经结束：忽略
    }
    if (forceTimer !== null) return
    // 宽限后强杀：Windows 上 SIGKILL 同样是 TerminateProcess；POSIX 下先 SIGTERM 再 SIGKILL
    forceTimer = setTimeout(
      () => {
        forceTimer = null
        if (didExit) return
        try {
          child.kill('SIGKILL')
        } catch {
          // 已经结束：忽略
        }
      },
      Math.max(0, options.graceMs)
    )
    unrefTimer(forceTimer)
  }

  return {
    transport,
    ready,
    pid: (): number | undefined => child.pid,
    kill,
    exited: (): boolean => didExit
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 通道表                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** 一个名字下的监听器集合（与通道是否存在**解耦**：先订阅后 connect 是常见写法） */
interface ChannelListeners {
  requests: Set<(method: string, params: unknown) => unknown>
  notifications: Set<(method: string, params: unknown) => void>
  closes: Set<(err: { code: string; message: string }) => void>
  stderrs: Set<(text: string) => void>
  connections: Set<(connectionId: number) => void>
  disconnects: Set<(connectionId: number, err: { code: string; message: string }) => void>
  reconnects: Set<(info: { attempts: number }) => void>
}

/** `pipe` + `autoReconnect` 的重连绑定（写法照 main 的 `ClientReconnectBinding`，只保留必需项） */
interface ReconnectBinding {
  policy: ResolvedAutoReconnect
  rebuild: () => Promise<IpcTransportHandles>
  controller: ReconnectController | null
  /** 重连代次：每次观测到可重连断线 +1，在途 attempt 据此自弃 */
  epoch: number
}

/** 一条 client 通道（重连窗口期 `transport` 为 null、`state === 'reconnecting'`） */
type ClientChannel = {
  kind: 'client'
  state: 'open' | 'reconnecting'
  transport: IpcTransportHandles | null
  reconnect?: ReconnectBinding
}

/** 一条已打开的通道：client 与 server **共用命名空间**（同一扩展内名字唯一） */
type OpenChannel = ClientChannel | { kind: 'server'; server: IpcServerHandles }

/* -------------------------------------------------------------------------------------------- */
/* 工具                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** 校验包装：共享校验器抛 `IpcDeclarationError`，宿主契约要求 `IpcCoreError('invalid-declaration')` */
function validateRuntimeDeclaration(raw: unknown): RuntimeIpcChannelDeclaration {
  try {
    return validateRuntimeIpcDeclaration(raw)
  } catch (error) {
    if (error instanceof IpcDeclarationError) {
      throw new IpcCoreError('invalid-declaration', error.message)
    }
    throw new IpcCoreError('invalid-declaration', toErrorMessage(error))
  }
}

/** 把任意错误归一成 `IpcCoreError`（稳定码优先） */
function toIpcError(error: unknown, fallback: 'connect-failed' | 'protocol-error'): IpcCoreError {
  if (isIpcCoreError(error)) return error
  return new IpcCoreError(fallback, toErrorMessage(error))
}

/* -------------------------------------------------------------------------------------------- */
/* 工厂                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * 按扩展构造 IPC 能力族。
 *
 * 错误边界（贯穿全文件）：
 * - **声明/参数错误**（名字、传输、program 越界、定向规则、超限）→ 抛 `IpcCoreError('invalid-declaration')`；
 * - **传输失败** → `connect-failed`；**对端退出** → `peer-crashed`；**协议错误** → `protocol-error`；
 * - **扩展回调抛错**（`onRequest` 的 handler）→ 作为 JSON-RPC 错误回给对端（`replyError`），
 *   不升级成宿主级异常，也不影响其它通道。
 */
export function createIpcCapabilities(options: HostIpcCapabilitiesOptions): IpcCapabilities {
  const extId = options.extId
  const extensionDir = path.resolve(options.extensionDir)
  const dataDir = path.resolve(options.extensionDataDir)
  const socketDir = options.socketDir ?? path.join(dataDir, 'ipc')
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const maxChannels = options.maxChannels ?? MAX_CHANNELS_PER_EXTENSION
  const maxConnections = options.maxConnectionsPerServer ?? MAX_CONNECTIONS_PER_SERVER

  const channels = new Map<string, OpenChannel>()
  const listeners = new Map<string, ChannelListeners>()
  const sidecars = new Set<SidecarProcess>()
  let disposed = false

  /* -------------------------------------- 监听器 -------------------------------------- */

  const listenersFor = (name: string): ChannelListeners => {
    const existing = listeners.get(name)
    if (existing) return existing
    const created: ChannelListeners = {
      requests: new Set(),
      notifications: new Set(),
      closes: new Set(),
      stderrs: new Set(),
      connections: new Set(),
      disconnects: new Set(),
      reconnects: new Set()
    }
    listeners.set(name, created)
    return created
  }

  /** 订阅辅助：返回 `Disposable`（先例：`api.fs.watch` 的 unwatch 也是注销函数） */
  function subscribe<T>(set: Set<T>, value: T): Disposable {
    set.add(value)
    return {
      dispose: (): void => void set.delete(value)
    }
  }

  const emitClose = (name: string, err: { code: string; message: string }): void => {
    for (const callback of [...(listeners.get(name)?.closes ?? [])]) {
      try {
        callback(err)
      } catch (error) {
        options.log('warn', `[${extId}] ipc.onClose 回调抛错（${name}）`, toErrorMessage(error))
      }
    }
  }

  const emitStderr = (name: string, text: string): void => {
    for (const callback of [...(listeners.get(name)?.stderrs ?? [])]) {
      try {
        callback(text)
      } catch (error) {
        options.log('warn', `[${extId}] ipc.onStderr 回调抛错（${name}）`, toErrorMessage(error))
      }
    }
  }

  /* -------------------------------------- 槽位校验 -------------------------------------- */

  /** 名字未占用 + 未超每扩展上限（重名与超限都是 `invalid-declaration`/`too-many-channels`） */
  function assertChannelSlot(name: string): void {
    if (disposed) {
      throw new IpcCoreError('channel-closed', '该扩展的 api 已释放（dispose 之后不能再打开通道）')
    }
    if (channels.has(name)) {
      throw new IpcCoreError('invalid-declaration', `通道 ${name} 已打开`)
    }
    if (channels.size >= maxChannels) {
      throw new IpcCoreError(
        'too-many-channels',
        `通道数已达上限 ${maxChannels}（先关闭不用的通道）`
      )
    }
  }

  /** 取一条通道（不存在 → `not-connected`） */
  function requireChannel(name: string): OpenChannel {
    const channel = channels.get(name)
    if (!channel) throw new IpcCoreError('not-connected', `通道不存在或未连接: ${name}`)
    return channel
  }

  /** 取 client 通道**可用**的传输（重连窗口期内请求立即 `not-connected`，不排队） */
  function requireClientTransport(channel: ClientChannel, name: string): IpcTransportHandles {
    if (channel.state === 'reconnecting' || !channel.transport) {
      throw new IpcCoreError(
        'not-connected',
        `通道 ${name} 正在重连（请求不排队，请在 onReconnect 后重发）`
      )
    }
    return channel.transport
  }

  /**
   * 定向投递的统一判定（`request` / `notify` 共用，规则逐条照 `src/api/types.ts`）：
   * - 名字不存在 → `not-connected`；
   * - client 通道带了 `connectionId` → `invalid-declaration`；
   * - server 名字省略 `connectionId` → `invalid-declaration`；
   * - 定向到已断开/不存在的连接 → `not-connected`。
   */
  function resolveTarget(
    name: string,
    connectionId: number | undefined,
    what: 'request' | 'notify'
  ):
    | { kind: 'client'; transport: IpcTransportHandles }
    | { kind: 'server'; connection: ReturnType<IpcServerHandles['getConnection']> & object } {
    const channel = requireChannel(name)
    if (channel.kind === 'client') {
      if (connectionId !== undefined) {
        throw new IpcCoreError(
          'invalid-declaration',
          `通道 ${name} 是客户端通道，没有连接 ID 命名空间（请去掉 connectionId）`
        )
      }
      return { kind: 'client', transport: requireClientTransport(channel, name) }
    }
    if (connectionId === undefined) {
      const verb = what === 'request' ? '请求' : '通知'
      throw new IpcCoreError(
        'invalid-declaration',
        `服务端通道 ${name} 必须指定 connectionId 才能${verb}，或用 broadcast`
      )
    }
    const connection = channel.server.getConnection(connectionId)
    if (!connection) {
      throw new IpcCoreError('not-connected', `连接不存在或已断开: ${name}#${connectionId}`)
    }
    return { kind: 'server', connection }
  }

  /* ------------------------------------ 对端请求分派 ------------------------------------ */

  /**
   * 对端发来的请求 → 扩展注册的 handler。
   *
   * **只生效最先注册的那个**（`src/api/types.ts` 的 onRequest 文档明确写了这条限制）：`Set` 的
   * 插入序即注册序，`dispose()` 掉第一个之后第二个才顶上。
   */
  const dispatchInboundRequest = async (
    name: string,
    method: string,
    params: unknown
  ): Promise<unknown> => {
    const handler = [...(listeners.get(name)?.requests ?? [])][0]
    if (!handler) {
      throw new Error(`扩展未注册请求处理器（method=${method}）`)
    }
    return await handler(method, params)
  }

  /* ------------------------------------ 挂载 client 通道 ------------------------------------ */

  /**
   * 把一条**已就绪**的 client 传输登记为通道：转发 stderr、挂关闭处理、把对端的**请求与通知**
   * 交给扩展。
   *
   * 可被**重复调用**（每次是一条新的 `JsonRpcChannel`）：`connect` 首连与**重连成功**共用它。
   */
  function attachClientChannel(
    name: string,
    entry: ClientChannel,
    transport: IpcTransportHandles
  ): void {
    entry.state = 'open'
    entry.transport = transport
    transport.onStderr((text: string) => emitStderr(name, text.trimEnd()))
    transport.channel.onClose((err) => handleClientClose(name, entry, err))
    // 通知必须显式订阅：`JsonRpcChannel` 只把它投给 `onNotification` 的监听器（没人听就丢），
    // 与"请求走 setDefaultHandler"是两条独立通道——漏掉这一行，扩展的 onNotification 永远收不到东西。
    transport.channel.onNotification((method, params) => {
      for (const callback of [...(listeners.get(name)?.notifications ?? [])]) {
        try {
          callback(method, params)
        } catch (error) {
          options.log(
            'warn',
            `[${extId}] ipc.onNotification 回调抛错（${name}）`,
            toErrorMessage(error)
          )
        }
      }
    })
    transport.channel.setDefaultHandler((method, params) =>
      dispatchInboundRequest(name, method, params)
    )
    channels.set(name, entry)
  }

  /**
   * client 通道断开：按"可重连断因封闭清单"分流（`peer-crashed` + 有重连绑定才重连）。
   *
   * 不可重连时与 main 逐字段一致：删表 + 广播一次 `close`；**窗口期内再次断线**只前移代次、
   * 不新建控制器、不重复广播（每个断连周期恰好一次 `onClose`）。
   */
  function handleClientClose(name: string, entry: ClientChannel, err: IpcCoreError | null): void {
    if (channels.get(name) !== entry) return

    const reconnect = entry.reconnect
    if (!reconnect || !isReconnectableCloseReason(err)) {
      channels.delete(name)
      if (reconnect) entry.transport?.dispose()
      emitClose(name, {
        code: err?.code ?? CHANNEL_CLOSED,
        message: err?.message ?? '通道已关闭'
      })
      return
    }

    entry.transport?.dispose()
    entry.transport = null
    entry.state = 'reconnecting'
    reconnect.epoch += 1
    if (reconnect.controller) return

    // `channels()` 仍含该名字 = 正在重连；`close` 在第一次重试**之前**广播（每周期一次）
    emitClose(name, {
      code: err?.code ?? 'peer-crashed',
      message: err?.message ?? '对端连接已关闭'
    })

    const controller = createReconnectController({
      retries: reconnect.policy.retries,
      backoffMs: reconnect.policy.backoffMs,
      attempt: async (): Promise<void> => {
        const epochAtStart = reconnect.epoch
        const next = await reconnect.rebuild()
        // 过期 attempt（期间被 close / 被停用 / 又断了一次）→ 不挂载、不自弃成事件
        if (
          channels.get(name) !== entry ||
          reconnect.controller !== controller ||
          reconnect.epoch !== epochAtStart
        ) {
          next.dispose()
          throw new IpcCoreError(
            'channel-closed',
            `通道 ${name} 的重连尝试已过期（期间发生新的断线）`
          )
        }
        entry.transport?.dispose()
        attachClientChannel(name, entry, next)
      },
      onSuccess: (info): void => {
        if (reconnect.controller !== controller) return
        reconnect.controller = null
        for (const callback of [...(listeners.get(name)?.reconnects ?? [])]) {
          try {
            callback({ attempts: info.attempts })
          } catch (error) {
            options.log(
              'warn',
              `[${extId}] ipc.onReconnect 回调抛错（${name}）`,
              toErrorMessage(error)
            )
          }
        }
      },
      onGiveUp: (): void => {
        if (reconnect.controller !== controller) return
        reconnect.controller = null
        if (channels.get(name) !== entry) return
        channels.delete(name)
      }
    })
    reconnect.controller = controller
    controller.start()
  }

  /* ------------------------------------ 建传输（两种传输） ------------------------------------ */

  /**
   * 按声明造一个"建传输"的闭包（重连时用**同一份**声明再建一次，端点/framing/program 不变）。
   *
   * `stdio`：`program` 解析进扩展目录内（越界 → `invalid-declaration`），`.js/.cjs/.mjs` 用宿主自带
   * Node 跑（`resolveStdioSpawn` 注入 `ELECTRON_RUN_AS_NODE`），cwd = 扩展 data 目录（与 main 一致）；
   * `pipe`：`<socketDir>/obox-<extId>-<name>.sock`（Windows 上 `ipcEndpoint` 给命名管道）。
   */
  async function buildTransportFactory(
    declaration: RuntimeIpcChannelDeclaration
  ): Promise<() => Promise<IpcTransportHandles>> {
    if (declaration.transport === 'stdio') {
      const program = resolveProgramInExtension(extensionDir, declaration.program ?? '')
      await mkdir(dataDir, { recursive: true })
      const spawnPlan = resolveStdioSpawn({
        program,
        args: declaration.args,
        execPath: process.execPath
      })
      return async (): Promise<IpcTransportHandles> => {
        const sidecar = startStdioSidecar({
          program: spawnPlan.program,
          args: spawnPlan.args,
          cwd: dataDir,
          ...(spawnPlan.env === undefined ? {} : { env: spawnPlan.env }),
          ...(declaration.framing === undefined ? {} : { framing: declaration.framing }),
          graceMs,
          onStderr: (text: string): void => emitStderr(declaration.id, text),
          onExit: (error: IpcCoreError): void => {
            // 子进程退出：交给通道状态机（首连失败由 `ready` 的 reject 表达，不会走到这里）
            sidecars.delete(sidecar)
            sidecar.transport.channel.close(error)
          }
        })
        sidecars.add(sidecar)
        try {
          // `openStreamTransport` 的 ready 恒为 resolved（流是现成的），真正的"就绪"是 spawn 成功
          await sidecar.ready
        } catch (error) {
          // 启动失败：收尾（杀半成品/清定时器）后把 `connect-failed` 抛给扩展
          sidecar.kill()
          sidecars.delete(sidecar)
          throw error
        }
        return sidecar.transport
      }
    }

    await mkdir(socketDir, { recursive: true })
    const endpoint = ipcEndpoint({ socketDir, extensionId: extId, name: declaration.id })
    return async (): Promise<IpcTransportHandles> => {
      const transport = openPipeClientTransport({
        endpoint,
        ...(declaration.framing === undefined ? {} : { framing: declaration.framing })
      })
      try {
        await transport.ready
      } catch (error) {
        transport.dispose()
        throw error
      }
      return transport
    }
  }

  /* -------------------------------------- connect -------------------------------------- */

  /**
   * 生产实现：读 `<扩展目录>/manifest.json`。
   *
   * **为什么宿主自己读清单**（R61 裁定）：`init.extensions[]` 的 `HostedExtensionInfo` 是**封闭
   * 白名单**（`src/shared/extensionHostProtocol.ts` 的 `HOSTED_EXTENSION_FIELDS`，未知字段直接判
   * 非法并提示"新增字段需升 PROTOCOL_VERSION"），所以 `contributes.ipcChannels` 不会随 `init` 到
   * 宿主。两条路：
   * - 升协议（改 `src/shared/**` + `HOSTED_EXTENSION_FIELDS` + 渲染侧载荷 + `PROTOCOL_VERSION`）；
   * - **宿主自己读这个已知文件**——`loader.ts` 早就在读同一个文件里的 `main`，注释写明"这是读一个
   *   已知文件，不是扫目录"，而清单本身就是渲染侧从磁盘那份 manifest 来的，不会分叉。
   * 选后者：零协议改动、零版本号、零共享/渲染改动。
   */
  const readManifestFile = (dir: string): string =>
    readFileSync(path.join(dir, 'manifest.json'), 'utf8')

  /**
   * 清单通道声明的**进程内缓存**（每个扩展一份=每个能力实例一份）。
   *
   * 为什么要缓存：`connect('<id>')` 是运行期高频调用（重连、换通道都会再来一次），每次都读盘 +
   * `JSON.parse` 是白费；而清单在扩展安装/升级前不会变。失败结果也缓存（畸形清单不该每次重读）。
   */
  type ManifestChannels =
    { ok: true; declarations: IpcChannelDeclaration[] } | { ok: false; message: string }
  let manifestCache: ManifestChannels | null = null

  const loadManifestChannels = (): ManifestChannels => {
    if (manifestCache !== null) return manifestCache
    const read = options.readManifest ?? readManifestFile
    let text: string
    try {
      text = read(extensionDir)
    } catch (error) {
      manifestCache = {
        ok: false,
        message: `读取扩展清单失败（${path.join(extensionDir, 'manifest.json')}）：${toErrorMessage(error)}`
      }
      return manifestCache
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      manifestCache = { ok: false, message: `扩展清单不是合法 JSON：${toErrorMessage(error)}` }
      return manifestCache
    }
    const contributes =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { contributes?: { ipcChannels?: unknown } }).contributes
        : undefined
    const checked = checkIpcChannelList(contributes?.ipcChannels)
    manifestCache = checked.ok
      ? { ok: true, declarations: checked.declarations }
      : { ok: false, message: `清单的 contributes.ipcChannels 非法：${checked.message}` }
    return manifestCache
  }

  /**
   * `connect('<通道id>')` 的清单解析（issue #45 的字符串简写形式）。
   *
   * 三条失败路径都给**可执行的中文错误**，且都不影响对象形式（`connect({...})` 完全不碰清单）：
   * 1. 读不到/解析不了清单 → `invalid-declaration` + 具体原因；
   * 2. `contributes.ipcChannels` 形状非法 → `invalid-declaration` + 逐项原因（与清单校验同一套规则）；
   * 3. 清单里没有该 id → `invalid-declaration` + 「清单里没有声明通道 x」。
   */
  const resolveManifestChannel = (id: string): IpcChannelDeclaration => {
    const manifest: ManifestChannels =
      options.manifestChannels === undefined
        ? loadManifestChannels()
        : { ok: true, declarations: [...options.manifestChannels] }
    if (!manifest.ok) {
      throw new IpcCoreError(
        'invalid-declaration',
        `${manifest.message}（无法用 id 引用通道 ${String(id)}）`
      )
    }
    let resolved: IpcChannelDeclaration | undefined
    try {
      resolved = resolveIpcChannelDeclaration(manifest.declarations, String(id))
    } catch (error) {
      throw new IpcCoreError('invalid-declaration', toErrorMessage(error))
    }
    if (!resolved) {
      throw new IpcCoreError(
        'invalid-declaration',
        `清单里没有声明通道 ${String(id)}（contributes.ipcChannels）`
      )
    }
    return resolved
  }

  const connect = async (declaration: IpcChannelDeclaration | string): Promise<void> => {
    const resolved =
      typeof declaration === 'string' ? resolveManifestChannel(declaration) : declaration
    const validated = validateRuntimeDeclaration(resolved)
    assertChannelSlot(validated.id)

    const createTransport = await buildTransportFactory(validated)
    let transport: IpcTransportHandles
    try {
      transport = await createTransport()
    } catch (error) {
      // 首连失败：稳定码抛给扩展（子进程/套接字在半成品阶段已被收尾）
      throw toIpcError(error, 'connect-failed')
    }

    const entry: ClientChannel = { kind: 'client', state: 'open', transport: null }
    const policy = validated.autoReconnect
    if (policy) {
      // 只有 `pipe` 会走到这里（`validateRuntimeIpcDeclaration` 已挡掉 stdio + autoReconnect）
      entry.reconnect = {
        policy,
        controller: null,
        epoch: 0,
        rebuild: async (): Promise<IpcTransportHandles> => await createTransport()
      }
    }
    attachClientChannel(validated.id, entry, transport)
  }

  /* -------------------------------------- listen -------------------------------------- */

  const listen = async (declaration: IpcChannelDeclaration): Promise<void> => {
    // 先判角色再判名字/额度：否则 listen({transport:'stdio'}) 且名字已占用时会先报"已打开"
    if (declaration?.transport !== 'pipe') {
      throw new IpcCoreError(
        'invalid-declaration',
        'listen 只支持 pipe（服务端不能拉起子进程；stdio 请用 connect）'
      )
    }
    const validated = validateRuntimeDeclaration(declaration)
    assertChannelSlot(validated.id)
    await mkdir(socketDir, { recursive: true })
    const endpoint = ipcEndpoint({ socketDir, extensionId: extId, name: validated.id })
    const server = openPipeServerTransport({
      endpoint,
      ...(validated.framing === undefined ? {} : { framing: validated.framing }),
      maxConnections,
      log: (message: string, detail?: unknown): void => {
        options.log(
          'warn',
          `[${extId}] ipc server（${validated.id}）：${message}`,
          detail === undefined ? undefined : toErrorMessage(detail)
        )
      },
      onConnection: (connectionId: number): void => {
        for (const callback of [...(listeners.get(validated.id)?.connections ?? [])]) {
          try {
            callback(connectionId)
          } catch (error) {
            options.log(
              'warn',
              `[${extId}] ipc.onConnection 回调抛错（${validated.id}）`,
              toErrorMessage(error)
            )
          }
        }
      },
      onDisconnect: (connectionId: number, reason: IpcCoreError | null): void => {
        const err = reason ?? new IpcCoreError(CHANNEL_CLOSED, '通道已关闭')
        for (const callback of [...(listeners.get(validated.id)?.disconnects ?? [])]) {
          try {
            callback(connectionId, { code: err.code, message: err.message })
          } catch (error) {
            options.log(
              'warn',
              `[${extId}] ipc.onDisconnect 回调抛错（${validated.id}）`,
              toErrorMessage(error)
            )
          }
        }
      },
      // `connectionId` 不参与分派：`onRequest` 的回调签名按 `src/api/types.ts` 不带连接 ID
      // （"每连接独立会话"的已知限制，见该声明的文档），回包由 ipcServer 按内部 requestId 路由。
      onRequest: (_connectionId: number, method: string, params: unknown): unknown =>
        dispatchInboundRequest(validated.id, method, params)
    })
    try {
      await server.ready
    } catch (error) {
      server.dispose()
      throw toIpcError(error, 'connect-failed')
    }
    channels.set(validated.id, { kind: 'server', server })
  }

  /* -------------------------------------- 关通道 -------------------------------------- */

  /** 关一条 client 通道：先取消重连控制器，再 dispose 传输（窗口期补一次 `close`） */
  function closeClientChannel(name: string, channel: ClientChannel): void {
    channel.reconnect?.controller?.cancel()
    if (channel.reconnect) channel.reconnect.controller = null
    const transport = channel.transport
    channel.transport = null
    if (transport) {
      transport.dispose()
      return
    }
    if (!channel.reconnect) return
    // 窗口期没有可 dispose 的传输：补一次 `close{channel-closed}`（`onClose` 每扩展主动 close 各触发一次）
    emitClose(name, { code: CHANNEL_CLOSED, message: '通道已关闭' })
  }

  const closeChannel = (name: string): void => {
    const channel = channels.get(name)
    if (!channel) return
    if (channel.kind === 'client') closeClientChannel(name, channel)
    else channel.server.dispose()
    channels.delete(name)
  }

  /* -------------------------------------- api.ipc -------------------------------------- */

  const api: ExtensionActivationApi['ipc'] = {
    async connect(declaration): Promise<void> {
      await connect(declaration)
    },

    async listen(declaration): Promise<void> {
      await listen(declaration)
    },

    async close(name: string): Promise<void> {
      closeChannel(name)
    },

    async channels(): Promise<string[]> {
      return [...channels.keys()]
    },

    async request(name, method, params, opts): Promise<unknown> {
      const target = resolveTarget(name, opts?.connectionId, 'request')
      if (target.kind === 'client') {
        return target.transport.channel.request(String(method), params, {
          ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })
        })
      }
      return target.connection.channel.request(String(method), params, {
        ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })
      })
    },

    async notify(name, method, params, opts): Promise<void> {
      const target = resolveTarget(name, opts?.connectionId, 'notify')
      if (target.kind === 'client') target.transport.channel.notify(String(method), params)
      else target.connection.channel.notify(String(method), params)
    },

    async broadcast(name, method, params): Promise<void> {
      const channel = requireChannel(name)
      if (channel.kind !== 'server') {
        throw new IpcCoreError(
          'invalid-declaration',
          `通道 ${name} 是客户端通道（broadcast 只对 listen 的 server 有意义）`
        )
      }
      channel.server.broadcast(String(method), params)
    },

    onRequest(name, handler): Disposable {
      if (typeof handler !== 'function') throw new Error('ipc.onRequest 的 handler 必须是函数')
      return subscribe(listenersFor(name).requests, handler)
    },

    onNotification(name, callback): Disposable {
      if (typeof callback !== 'function') throw new Error('ipc.onNotification 的回调必须是函数')
      const target = listenersFor(name)
      target.notifications.add(callback)
      return { dispose: (): void => void target.notifications.delete(callback) }
    },

    onClose(name, callback): Disposable {
      if (typeof callback !== 'function') throw new Error('ipc.onClose 的回调必须是函数')
      return subscribe(listenersFor(name).closes, callback)
    },

    onStderr(name, callback): Disposable {
      if (typeof callback !== 'function') throw new Error('ipc.onStderr 的回调必须是函数')
      return subscribe(listenersFor(name).stderrs, callback)
    },

    onConnection(name, callback): Disposable {
      if (typeof callback !== 'function') throw new Error('ipc.onConnection 的回调必须是函数')
      return subscribe(listenersFor(name).connections, callback)
    },

    onDisconnect(name, callback): Disposable {
      if (typeof callback !== 'function') throw new Error('ipc.onDisconnect 的回调必须是函数')
      return subscribe(listenersFor(name).disconnects, callback)
    },

    onReconnect(name, callback): Disposable {
      if (typeof callback !== 'function') throw new Error('ipc.onReconnect 的回调必须是函数')
      return subscribe(listenersFor(name).reconnects, callback)
    }
  }

  /* -------------------------------- 宿主内部：流通道注册 -------------------------------- */

  const registerStreamChannel = (name: string, streams: StreamChannelInput): void => {
    const channelName = String(name)
    assertChannelSlot(channelName)
    const transport = openStreamTransport({
      readable: streams.readable,
      writable: streams.writable,
      ...(streams.framing === undefined ? {} : { framing: streams.framing }),
      ...(streams.onDispose === undefined ? {} : { onDispose: streams.onDispose })
    })
    attachClientChannel(channelName, { kind: 'client', state: 'open', transport: null }, transport)
  }

  /* ---------------------------------------- 清理 ---------------------------------------- */

  return {
    api,
    registerStreamChannel,
    closeChannel,
    channelNames: (): string[] => [...channels.keys()],
    childPids: (): number[] => {
      const pids: number[] = []
      for (const sidecar of sidecars) {
        const pid = sidecar.pid()
        if (pid !== undefined && !sidecar.exited()) pids.push(pid)
      }
      return pids
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const [name, channel] of [...channels.entries()]) {
        if (channel.kind === 'client') closeClientChannel(name, channel)
        else channel.server.dispose()
      }
      channels.clear()
      // 兜底：即使某条传输没走 close 路径，也把子进程杀掉（kill 幂等）
      for (const sidecar of [...sidecars]) {
        sidecar.kill()
        sidecars.delete(sidecar)
      }
      listeners.clear()
    }
  }
}
