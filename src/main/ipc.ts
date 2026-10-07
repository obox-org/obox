/**
 * 扩展 ↔ 外部进程 IPC 的**薄壳**（主进程）。规格见 issue #40。
 *
 * 这里只做四件事：通道注册表与限额、把传输接起来（`ipcTransport`）、生命周期清理、
 * Electron IPC 接线（渲染进程里的扩展经 preload 调用）。
 * 协议与分帧在 `ipcCore.ts`、字节搬运在 `ipcTransport.ts`——两者都不依赖 electron，可单测。
 *
 * **不使用 TCP 端口**：stdio（宿主拉起子进程）或命名管道/Unix 域套接字（连接已在运行的进程）。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { IpcChannelDeclaration, IpcEvent, IpcReplyOutcome } from '../shared/types'
import { extensionSourceDir } from './paths'
import type { Readable, Writable } from 'node:stream'
import { IpcCoreError, ipcEndpoint, isIpcCoreError, validateIpcDeclaration } from './ipcCore'
import type { Framing } from './ipcCore'
import {
  openPipeClientTransport,
  openStdioTransport,
  openStreamTransport,
  resolveProgramInExtension,
  type IpcTransportHandles
} from './ipcTransport'

/** 每个扩展最多同时打开的通道数 */
export const MAX_CHANNELS_PER_EXTENSION = 4
/** 把对端请求转发给渲染进程后的等待上限 */
const FORWARD_TIMEOUT_MS = 30_000

interface OpenChannel {
  transport: IpcTransportHandles
}

const channels = new Map<string, Map<string, OpenChannel>>()
const pendingReplies = new Map<
  string,
  { resolve: (outcome: IpcReplyOutcome) => void; timer: NodeJS.Timeout }
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

/** 对端请求 → 转发给渲染进程的扩展处理器，并把结果作为 JSON-RPC 响应回给对端 */
async function forwardInboundRequest(
  extId: string,
  name: string,
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
    pendingReplies.set(requestId, { resolve, timer })
  })
  // 先登记待回包，再广播请求，避免"回包早于登记"的竞态
  broadcast({ extId, name, type: 'request', requestId, method, params })
  const outcome = await pending
  if (!outcome.ok) throw new Error(outcome.error ?? '扩展未处理该请求')
  return outcome.result
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
    forwardInboundRequest(extId, name, method, params)
  )
  channelMap(extId).set(name, { transport })
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
    // 其它一律直接执行（Rust/Python/Go 等编译产物或系统可执行文件）
    const isJsProgram = /\.(c?js|mjs)$/i.test(program)
    transport = openStdioTransport({
      program: isJsProgram ? process.execPath : program,
      args: isJsProgram ? [program, ...(declaration.args ?? [])] : declaration.args,
      cwd,
      framing: declaration.framing
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

/** 关闭一条通道（幂等） */
export function closeExtensionChannel(extId: string, name: string): void {
  const map = channels.get(extId)
  const channel = map?.get(name)
  if (!channel) return
  channel.transport.dispose()
  map?.delete(name)
  if (map && map.size === 0) channels.delete(extId)
}

/** 扩展停用/卸载/重载时清理它的全部通道（与定时器/DB/watch/通知同一时机） */
export function closeExtensionIpc(extId: string): void {
  const map = channels.get(extId)
  if (!map) return
  for (const channel of [...map.values()]) channel.transport.dispose()
  channels.delete(extId)
}

/** 列出当前扩展已打开的通道名（诊断/自检用） */
export function listExtensionChannels(extId: string): string[] {
  return [...(channels.get(extId)?.keys() ?? [])]
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
      timeoutMs?: number
    ): Promise<{ ok: boolean; result?: unknown; code?: string; error?: string }> => {
      try {
        const channel = requireChannel(String(extId), String(name))
        const result = await channel.transport.channel.request(String(method), params, {
          timeoutMs
        })
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
      params?: unknown
    ): { ok: boolean; code?: string; error?: string } => {
      try {
        requireChannel(String(extId), String(name)).transport.channel.notify(String(method), params)
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
