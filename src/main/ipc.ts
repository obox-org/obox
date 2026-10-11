/**
 * 扩展 ↔ 外部进程 IPC 的**薄壳**（主进程）。规格见 issue #40；pipe 服务端（多连接）见 issue #43。
 *
 * 这里只做四件事：通道注册表与限额、把传输接起来（`ipcTransport` / `ipcServer`）、生命周期清理、
 * Electron IPC 接线（渲染进程里的扩展经 preload 调用）。
 * 协议与分帧在 `ipcCore.ts`、字节搬运在 `ipcTransport.ts`（客户端）与 `ipcServer.ts`（服务端）
 * ——三者都不依赖 electron，可单测。
 *
 * **不使用 TCP 端口**：stdio（宿主拉起子进程）或命名管道/Unix 域套接字（连接已在运行的进程）。
 *
 * 通道分两类，**共用同一命名空间**（同一扩展内名字唯一）：
 * - **client 通道**（`connect`）：宿主是拨号方，一对一，没有连接 ID；
 * - **server 通道**（`listen`）：宿主是服务端，接受**多条**连接，每条连接一个单调递增、不复用的 ID。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { IpcChannelDeclaration, IpcEvent, IpcReplyOutcome } from '../shared/types'
import { extensionSourceDir } from './paths'
import type { Readable, Writable } from 'node:stream'
import {
  IpcCoreError,
  ipcEndpoint,
  isIpcCoreError,
  resolveStdioSpawn,
  validateIpcDeclaration
} from './ipcCore'
import type { Framing } from './ipcCore'
import {
  openPipeClientTransport,
  openStdioTransport,
  openStreamTransport,
  resolveProgramInExtension,
  type IpcTransportHandles
} from './ipcTransport'
import {
  openPipeServerTransport,
  type IpcServerConnection,
  type IpcServerHandles
} from './ipcServer'

/** 每个扩展最多同时打开的通道数（**server 与 client 共用**；一条 server 只占 1 条） */
export const MAX_CHANNELS_PER_EXTENSION = 4
/** 单个 server 允许的并发连接上限（连接**不计入**上面的通道数上限） */
export const MAX_CONNECTIONS_PER_SERVER = 16
/** 把对端请求转发给渲染进程后的等待上限 */
const FORWARD_TIMEOUT_MS = 30_000

/** 一条已打开的通道：client（拨号/stdio/已有流）或 server（listen 多连接）；两者**共用命名空间** */
type OpenChannel =
  { kind: 'client'; transport: IpcTransportHandles } | { kind: 'server'; server: IpcServerHandles }

const channels = new Map<string, Map<string, OpenChannel>>()
/** 在途转发请求表：requestId → 等待回包者 + **归属连接**（用于断连时的定向失败） */
const pendingReplies = new Map<
  string,
  {
    /** server 连接上的对端请求为连接 ID；client/stdio 路径为 null */
    connectionId: number | null
    resolve: (outcome: IpcReplyOutcome) => void
    timer: NodeJS.Timeout
  }
>()
let replySeq = 1

function channelMap(extId: string): Map<string, OpenChannel> {
  const existing = channels.get(extId)
  if (existing) return existing
  const created = new Map<string, OpenChannel>()
  channels.set(extId, created)
  return created
}

function ipcSocketDir(): string {
  return join(app.getPath('userData'), 'ipc')
}

/** 主进程 → 渲染进程广播（扩展宿主在主窗口按 extId 过滤） */
function broadcast(event: IpcEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ipc:event', event)
  }
}

function failure(err: unknown): { ok: false; code: string; error: string } {
  if (isIpcCoreError(err)) return { ok: false, code: err.code, error: err.message }
  return {
    ok: false,
    code: 'protocol-error',
    error: err instanceof Error ? err.message : String(err)
  }
}

function requireChannel(extId: string, name: string): OpenChannel {
  const channel = channels.get(extId)?.get(name)
  if (!channel) {
    throw new IpcCoreError('not-connected', `通道不存在或未连接: ${name}`)
  }
  return channel
}

/** 取 server（名字不存在 → `not-connected`；名字是 client 通道 → `invalid-declaration`） */
function requireServer(extId: string, name: string): IpcServerHandles {
  const channel = requireChannel(extId, name)
  if (channel.kind !== 'server') {
    throw new IpcCoreError('invalid-declaration', `通道 ${name} 是客户端通道（不是服务端通道）`)
  }
  return channel.server
}

/**
 * 定向投递的统一判定（`request` / `notify`）：
 * - 名字不存在 → `not-connected`（沿用既有文案）；
 * - client 通道带了 `connectionId` → `invalid-declaration`（客户端通道没有连接 ID 命名空间）；
 * - server 名字省略 `connectionId` → `invalid-declaration`（服务端没有"唯一对端"，静默挑一条等于误投）；
 * - 定向到已断开/不存在的连接 → `not-connected`。
 */
function resolveTarget(
  extId: string,
  name: string,
  connectionId: number | undefined,
  what: 'request' | 'notify'
):
  | { kind: 'client'; transport: IpcTransportHandles }
  | { kind: 'server'; connection: IpcServerConnection } {
  const channel = requireChannel(extId, name)
  if (channel.kind === 'client') {
    if (connectionId !== undefined) {
      throw new IpcCoreError(
        'invalid-declaration',
        `通道 ${name} 是客户端通道，没有连接 ID 命名空间（请去掉 connectionId）`
      )
    }
    return { kind: 'client', transport: channel.transport }
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

/** 对端请求 → 转发给渲染进程的扩展处理器，并把结果作为 JSON-RPC 响应回给对端 */
async function forwardInboundRequest(
  extId: string,
  name: string,
  connectionId: number | null,
  method: string,
  params: unknown
): Promise<unknown> {
  const requestId = `ipc-${replySeq++}`
  const pending = new Promise<IpcReplyOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(requestId)
      resolve({ ok: false, error: '扩展未在超时内响应（渲染进程可能未注册处理器）' })
    }, FORWARD_TIMEOUT_MS)
    timer.unref?.()
    pendingReplies.set(requestId, { connectionId, resolve, timer })
  })
  // 先登记待回包，再广播请求，避免"回包早于登记"的竞态。
  // connectionId 只在 server 连接上出现：client/stdio 路径产生的事件与今天**逐字段一致**。
  broadcast({
    extId,
    name,
    type: 'request',
    requestId,
    method,
    params,
    ...(connectionId === null ? {} : { connectionId })
  })
  const outcome = await pending
  if (!outcome.ok) throw new Error(outcome.error ?? '扩展未处理该请求')
  return outcome.result
}

/**
 * 某条连接断开瞬间，把它在途的**转发请求**立即以断因码结算（**绝不重放**）。
 * 不做这一步就只能等 30s 转发超时，而且"重连后补发"会成为暗坑。
 */
function failForwardedForConnection(connectionId: number, reason: IpcCoreError): number {
  let failed = 0
  for (const [requestId, pending] of [...pendingReplies]) {
    if (pending.connectionId !== connectionId) continue
    clearTimeout(pending.timer)
    pendingReplies.delete(requestId)
    pending.resolve({ ok: false, error: reason.message })
    failed++
  }
  return failed
}

/** 在途转发请求数（**诊断与测试用**，先例 `hookBridge.pendingCount()`） */
export function pendingForwardCount(): number {
  return pendingReplies.size
}

/** 校验还能再开一条通道（重名与每扩展限额），返回该扩展的通道表 */
function assertChannelSlot(extId: string, name: string): Map<string, OpenChannel> {
  const map = channelMap(extId)
  if (map.has(name)) {
    throw new IpcCoreError('invalid-declaration', `通道 ${name} 已打开`)
  }
  if (map.size >= MAX_CHANNELS_PER_EXTENSION) {
    throw new IpcCoreError(
      'too-many-channels',
      `通道数已达上限 ${MAX_CHANNELS_PER_EXTENSION}（先关闭不用的通道）`
    )
  }
  return map
}

/**
 * 把一条已就绪的传输登记为通道：转发 stderr、挂关闭广播与注销、把对端请求交给渲染进程。
 * `openExtensionChannel`（自己 spawn/连接）与 `registerStreamChannel`（用调用方给的流）共用这段。
 */
function registerChannel(extId: string, name: string, transport: IpcTransportHandles): void {
  transport.onStderr((text) => broadcast({ extId, name, type: 'stderr', text: text.trimEnd() }))
  transport.channel.onClose((err) => {
    // 通道关闭：登记表移除，并通知扩展（err 为 null 表示扩展自己关闭）
    if (channels.get(extId)?.get(name) === undefined) return
    channels.get(extId)?.delete(name)
    if (channels.get(extId)?.size === 0) channels.delete(extId)
    broadcast({
      extId,
      name,
      type: 'close',
      code: err?.code ?? 'channel-closed',
      message: err?.message ?? '通道已关闭'
    })
  })
  transport.channel.setDefaultHandler((method, params) =>
    // client/stdio 路径没有连接 ID：显式 null
    forwardInboundRequest(extId, name, null, method, params)
  )
  channelMap(extId).set(name, { kind: 'client', transport })
}

/** 把一条已就绪的 server 登记为通道（与 client 通道**共用**命名空间与额度） */
function registerServer(extId: string, name: string, server: IpcServerHandles): void {
  channelMap(extId).set(name, { kind: 'server', server })
}

/** 打开一条通道（校验声明 → 建传输 → 接事件）；失败抛 IpcCoreError */
export async function openExtensionChannel(
  extId: string,
  rawDeclaration: IpcChannelDeclaration
): Promise<void> {
  const declaration = validateIpcDeclaration(rawDeclaration)
  assertChannelSlot(extId, declaration.id)

  const extensionDir = extensionSourceDir(extId)
  let transport: IpcTransportHandles
  if (declaration.transport === 'stdio') {
    const program = resolveProgramInExtension(extensionDir, declaration.program ?? '')
    const cwd = join(extensionDir, 'data')
    await fs.mkdir(cwd, { recursive: true })
    // 便利约定：`.js/.cjs/.mjs` 用宿主自带的 Node 运行（扩展无需自带解释器）；
    // 其它一律直接执行（Rust/Python/Go 等编译产物或系统可执行文件）。
    // 注意：必须带上 ELECTRON_RUN_AS_NODE（见 resolveStdioSpawn 的注释），否则脚本跑在
    // Electron 应用模式下——stdin 不接、stdio 协议不通。
    const spawn = resolveStdioSpawn({
      program,
      args: declaration.args,
      execPath: process.execPath
    })
    transport = openStdioTransport({
      program: spawn.program,
      args: spawn.args,
      cwd,
      framing: declaration.framing,
      env: spawn.env
    })
  } else {
    const socketDir = ipcSocketDir()
    await fs.mkdir(socketDir, { recursive: true })
    const endpoint = ipcEndpoint({ socketDir, extensionId: extId, name: declaration.id })
    transport = openPipeClientTransport({ endpoint, framing: declaration.framing })
  }

  await transport.ready
  registerChannel(extId, declaration.id, transport)
}

/**
 * 以**服务端**身份 listen 一个 pipe 端点（issue #43）：接受多条对端连接。
 *
 * 端点用**不带 suffix** 的稳定端点（对端必须能事先知道往哪连）；
 * 声明里的 `transport` 必须是 `'pipe'`，且名字与既有 client 通道**共用命名空间**。
 */
export async function openExtensionServer(
  extId: string,
  rawDeclaration: IpcChannelDeclaration
): Promise<void> {
  // 先判角色，再判名字/额度：否则 listen({transport:'stdio'}) 且名字已占用时会先报"已打开"，语义更差
  if (rawDeclaration?.transport !== 'pipe') {
    throw new IpcCoreError(
      'invalid-declaration',
      'listen 只支持 pipe（服务端不能拉起子进程；stdio 请用 connect）'
    )
  }
  const declaration = validateIpcDeclaration(rawDeclaration)
  assertChannelSlot(extId, declaration.id)

  const socketDir = ipcSocketDir()
  await fs.mkdir(socketDir, { recursive: true })
  const endpoint = ipcEndpoint({ socketDir, extensionId: extId, name: declaration.id })
  const server = openPipeServerTransport({
    endpoint,
    framing: declaration.framing,
    maxConnections: MAX_CONNECTIONS_PER_SERVER,
    onConnection: (connectionId): void => {
      broadcast({ extId, name: declaration.id, type: 'connection', connectionId })
    },
    onDisconnect: (connectionId, reason): void => {
      // 断开瞬间：该连接的在途转发请求立即以断因码结算（绝不重放），再广播 disconnect 事件
      const err = reason ?? new IpcCoreError('channel-closed', '通道已关闭')
      failForwardedForConnection(connectionId, err)
      broadcast({
        extId,
        name: declaration.id,
        type: 'disconnect',
        connectionId,
        code: err.code,
        message: err.message
      })
    },
    onRequest: (connectionId, method, params) =>
      forwardInboundRequest(extId, declaration.id, connectionId, method, params)
  })
  try {
    await server.ready
  } catch (err) {
    server.dispose()
    throw err
  }
  registerServer(extId, declaration.id, server)
}

/**
 * 用**调用方已建立的流**注册一条通道（issue #51：宿主以 shell 方式拉起的解释器进程）。
 *
 * 与 `openExtensionChannel` 共用限额、注册表、关闭广播与对端请求转发；区别只在于"字节从哪来"：
 * 这里由调用方给流，且 `name` 必须已经过校验（`pythonCore.normalizeChannelName` 一类）。
 * 对端退出时由调用方 `transport.channel.close(...)`——但那需要通道句柄，因此本函数返回它。
 */
export function registerStreamChannel(
  extId: string,
  name: string,
  streams: {
    readable: Readable
    writable: Writable
    framing?: Framing
    onDispose?: () => void
  }
): IpcTransportHandles {
  assertChannelSlot(extId, name)
  const transport = openStreamTransport({
    readable: streams.readable,
    writable: streams.writable,
    framing: streams.framing,
    onDispose: streams.onDispose
  })
  registerChannel(extId, name, transport)
  return transport
}

/**
 * 统一 `close(name)`：按名字关闭该名字下的**一切**。
 * - 该名字是 client 通道 → 断开该通道；
 * - 该名字是 server → 停止监听并断开它**全部**连接；
 * - 两类都不存在 → **静默成功**；**幂等**（重复调用无副作用、不抛错）。
 */
export function closeExtensionChannel(extId: string, name: string): void {
  const map = channels.get(extId)
  const channel = map?.get(name)
  if (!channel) return
  if (channel.kind === 'client') channel.transport.dispose()
  else channel.server.dispose()
  map?.delete(name)
  if (map && map.size === 0) channels.delete(extId)
}

/** 扩展停用/卸载/重载时清理它的全部通道与 server（与定时器/DB/watch/通知同一时机） */
export function closeExtensionIpc(extId: string): void {
  const map = channels.get(extId)
  if (!map) return
  for (const channel of [...map.values()]) {
    if (channel.kind === 'client') channel.transport.dispose()
    else channel.server.dispose()
  }
  channels.delete(extId)
}

/** 列出当前扩展已打开的通道名（诊断/自检用；**含** server 名） */
export function listExtensionChannels(extId: string): string[] {
  return [...(channels.get(extId)?.keys() ?? [])]
}

/**
 * 向该 **server** 当前**全部已连接**对端各发**一条通知**（不收集回包，因此返回 void）。
 * 已断开的连接跳过；**无连接时静默成功**；`name` 是 client 通道 → `invalid-declaration`；
 * `name` 不存在 → `not-connected`。
 */
export function broadcastExtensionChannel(
  extId: string,
  name: string,
  method: string,
  params?: unknown
): void {
  requireServer(extId, name).broadcast(String(method), params)
}

/** 定向请求：server 名字必须给 `connectionId`；client 通道不得给（见 `resolveTarget`） */
export async function requestExtensionChannel(
  extId: string,
  name: string,
  method: string,
  params: unknown,
  opts: { timeoutMs?: number; connectionId?: number }
): Promise<unknown> {
  const target = resolveTarget(extId, name, opts.connectionId, 'request')
  if (target.kind === 'client') {
    return target.transport.channel.request(String(method), params, { timeoutMs: opts.timeoutMs })
  }
  return target.connection.channel.request(String(method), params, { timeoutMs: opts.timeoutMs })
}

/** 定向通知：`connectionId` 的规则与 `requestExtensionChannel` 完全一致 */
export function notifyExtensionChannel(
  extId: string,
  name: string,
  method: string,
  params: unknown,
  opts: { connectionId?: number }
): void {
  const target = resolveTarget(extId, name, opts.connectionId, 'notify')
  if (target.kind === 'client') target.transport.channel.notify(String(method), params)
  else target.connection.channel.notify(String(method), params)
}

export function registerIpcBridge(): void {
  ipcMain.handle(
    'ipc:connect',
    async (
      _e,
      extId: string,
      declaration: IpcChannelDeclaration
    ): Promise<{ ok: boolean; code?: string; error?: string }> => {
      try {
        await openExtensionChannel(String(extId), declaration)
        return { ok: true }
      } catch (err) {
        return failure(err)
      }
    }
  )

  ipcMain.handle(
    'ipc:listen',
    async (
      _e,
      extId: string,
      declaration: IpcChannelDeclaration
    ): Promise<{ ok: boolean; code?: string; error?: string }> => {
      try {
        await openExtensionServer(String(extId), declaration)
        return { ok: true }
      } catch (err) {
        return failure(err)
      }
    }
  )

  // 统一语义：按名字关闭该名字下的**一切**（client 通道或 server）；不存在时静默成功、幂等
  ipcMain.handle('ipc:close', (_e, extId: string, name: string): void => {
    closeExtensionChannel(String(extId), String(name))
  })

  ipcMain.handle('ipc:list', (_e, extId: string): string[] => listExtensionChannels(String(extId)))

  ipcMain.handle(
    'ipc:request',
    async (
      _e,
      extId: string,
      name: string,
      method: string,
      params?: unknown,
      timeoutMs?: number,
      connectionId?: number
    ): Promise<{ ok: boolean; result?: unknown; code?: string; error?: string }> => {
      try {
        const result = await requestExtensionChannel(
          String(extId),
          String(name),
          String(method),
          params,
          { timeoutMs, connectionId }
        )
        return { ok: true, result }
      } catch (err) {
        return failure(err)
      }
    }
  )

  ipcMain.handle(
    'ipc:notify',
    (
      _e,
      extId: string,
      name: string,
      method: string,
      params?: unknown,
      connectionId?: number
    ): { ok: boolean; code?: string; error?: string } => {
      try {
        notifyExtensionChannel(String(extId), String(name), String(method), params, {
          connectionId
        })
        return { ok: true }
      } catch (err) {
        return failure(err)
      }
    }
  )

  ipcMain.handle(
    'ipc:broadcast',
    (
      _e,
      extId: string,
      name: string,
      method: string,
      params?: unknown
    ): { ok: boolean; code?: string; error?: string } => {
      try {
        broadcastExtensionChannel(String(extId), String(name), String(method), params)
        return { ok: true }
      } catch (err) {
        return failure(err)
      }
    }
  )

  // 渲染进程里扩展处理器对"对端请求"的回包（与 ui:show / ui:result 同一模式）
  ipcMain.handle('ipc:reply', (_e, requestId: string, outcome: IpcReplyOutcome): void => {
    const pending = pendingReplies.get(String(requestId))
    if (!pending) return
    clearTimeout(pending.timer)
    pendingReplies.delete(String(requestId))
    pending.resolve(outcome ?? { ok: false, error: '空回包' })
  })
}
