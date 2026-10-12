/**
 * 渲染进程侧 `api.ipc` 的**关闭事件顺序**回归（真机 v11/v12 run5/run6 发现的缺陷）。
 *
 * 缺陷：`buildIpcApi().close(name)` 曾经是 `listeners.delete(name)` → `await window.api.ipcClose(...)`，
 * 于是主进程在这次 close 里才发出的收尾事件（client 通道的 `close`、server 通道**每条**活动连接的
 * `disconnect`）到达渲染进程时，该通道的监听表已经被删掉 → 扩展自己注册的 `onClose` / `onDisconnect`
 * **永不触发**（对端崩溃路径正常，因为那条路径不经过 `close()`）。契约在 `src/api/types.ts`：
 * `onClose`"每扩展主动 `close()` 与每次断连各触发一次"、`onDisconnect`"每条连接恰好触发一次……
 * 宿主关闭 server 或 `close()` 时为 `channel-closed`"。
 *
 * 缝隙说明（沿用 `test/ipc-server.test.ts:1-11` 的 electron mock，**不改生产代码结构**）：
 * 1. `vi.mock('electron')` 只覆盖 `ipc.ts` 用到的 3 个符号（`app.getPath` / `BrowserWindow.getAllWindows`
 *    / `ipcMain.handle`），因此本文件跑的是**真实**的 `src/main/ipc.ts`（真 transport、真 socket、
 *    真事件载荷）与真实的 `src/renderer/src/core/host.ts`；
 * 2. `vi.mock('TreeView.vue')`：`host.ts` 顶层 import 了那个 SFC，node 环境里必须替掉才能 import 宿主
 *    （`buildIpcApi` 本身只依赖 `window`）；
 * 3. **window 仿真**（`installWindow`）：`window.api.*` 直连真实的 `ipcMain.handle` 处理器，
 *    `webContents.send` 的事件按 Electron 的**帧内消息 FIFO** 投递——处理器里同步发出的事件在
 *    invoke 回复**之前**派发到渲染进程。这正是"等事件投递完再清理监听表"这条修复成立的前提，
 *    也是本文件要锁死的顺序。
 *
 * 断言口径：只断言对外可观察的**回调次数与断因码**（`api/types.ts` 的契约 + `api-reference.md`
 * 的封闭清单），不断言实现内部结构。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionActivationApi, ExtensionInfo } from '../src/api'

/** 本文件对 `ipc:event` 载荷的窄化视图（只用到这些字段） */
interface IpcEventLike {
  extId: string
  name: string
  type: string
  connectionId?: number
  requestId?: string
  method?: string
  params?: unknown
  code?: string
  message?: string
  text?: string
  attempts?: number
}

/**
 * 主进程侧（mock electron）+ 渲染进程侧（window 仿真）共用的状态。
 * `send` 模型化"主进程 → 渲染进程"的消息投递：事件是**独立消息**，下一个任务才派发；
 * 因此 `invoke()` 里那句 `await setImmediate` 之后，处理器发出的事件一定**已经**派发完。
 */
const state = vi.hoisted(() => {
  const s = {
    userData: '',
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    /** 已发出但尚未投递到渲染进程的事件（FIFO） */
    pending: [] as IpcEventLike[],
    /** 渲染进程里 `window.events.on('ipc:event', …)` 的订阅者（= 宿主的 buildIpcApi） */
    rendererListeners: [] as Array<(e: IpcEventLike) => void>,
    send(event: IpcEventLike): void {
      s.pending.push(event)
      setImmediate(() => {
        const batch = s.pending.splice(0)
        for (const e of batch) for (const cb of [...s.rendererListeners]) cb(e)
      })
    },
    reset(): void {
      s.userData = ''
      s.handlers.clear()
      s.pending.length = 0
      s.rendererListeners.length = 0
    }
  }
  return s
})

vi.mock('electron', () => ({
  app: { getPath: (): string => state.userData },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (_channel: string, event: IpcEventLike): void => state.send(event)
        }
      }
    ]
  },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown): void => {
      state.handlers.set(channel, fn)
    }
  }
}))

vi.mock('../src/renderer/src/components/TreeView.vue', () => ({ default: {} }))

import { closeExtensionIpc, registerIpcBridge } from '../src/main/ipc'
import { resetConnectionIdCounterForTest } from '../src/main/ipcServer'
import { host } from '../src/renderer/src/core/host'
import { makeExtensionInfo } from '../src/renderer/src/core/manifest'
import {
  connectPeer,
  createServer,
  endpointFor,
  listen,
  waitFor,
  type IpcPeer
} from './helpers/ipcPeers'

/**
 * 扩展 id：**故意与其它测试文件不同**（Windows 命名管道是机器级命名空间，见
 * `test/helpers/ipcPeers.ts:61-74`）。
 */
const EXT = 'renderer-ext'

let workDir = ''
let disposables: Array<() => void> = []
const peers: IpcPeer[] = []
const servers: net.Server[] = []

function socketDir(): string {
  return join(workDir, 'ipc')
}

/** 宿主实际使用的端点（用 helper 的参照实现独立算出，不调 `ipcEndpoint`） */
function hostEndpoint(name: string): string {
  return endpointFor(`${EXT}-${name}`, socketDir())
}

/**
 * 扮演 preload 的 `ipcRenderer.invoke`：直连真实处理器；返回前先把本次调用产生的事件投递掉
 * （Electron 帧内消息 FIFO：事件消息先于 invoke 回复到达渲染进程）。
 */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`未注册的 handler: ${channel}`)
  const result = await handler({}, ...args)
  await new Promise<void>((resolve) => setImmediate(resolve))
  return result
}

/** 把 preload 暴露的 `window.events` / `window.api` 装到 globalThis 上（`buildIpcApi` 只读 `window`） */
function installWindow(): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    events: {
      on: (_channel: string, cb: (e: IpcEventLike) => void): (() => void) => {
        state.rendererListeners.push(cb)
        return () => {
          const i = state.rendererListeners.indexOf(cb)
          if (i >= 0) state.rendererListeners.splice(i, 1)
        }
      }
    },
    api: {
      ipcConnect: (extId: unknown, declaration: unknown) =>
        invoke('ipc:connect', extId, declaration),
      ipcListen: (extId: unknown, declaration: unknown) => invoke('ipc:listen', extId, declaration),
      ipcClose: (extId: unknown, name: unknown) => invoke('ipc:close', extId, name),
      ipcList: (extId: unknown) => invoke('ipc:list', extId),
      ipcRequest: (
        extId: unknown,
        name: unknown,
        method: unknown,
        params: unknown,
        timeoutMs: unknown,
        connectionId: unknown
      ) => invoke('ipc:request', extId, name, method, params, timeoutMs, connectionId),
      ipcNotify: (
        extId: unknown,
        name: unknown,
        method: unknown,
        params: unknown,
        connectionId: unknown
      ) => invoke('ipc:notify', extId, name, method, params, connectionId),
      ipcBroadcast: (extId: unknown, name: unknown, method: unknown, params: unknown) =>
        invoke('ipc:broadcast', extId, name, method, params),
      ipcReply: (requestId: unknown, outcome: unknown) => invoke('ipc:reply', requestId, outcome)
    }
  }
}

/** 取一份扩展的 `api.ipc`（每次调用都是一次"激活"，各自一张独立的监听表） */
function buildApi(): ExtensionActivationApi['ipc'] {
  const ext: ExtensionInfo = makeExtensionInfo(
    EXT,
    { name: EXT, version: '1.0.0', main: 'index.js' },
    'debug',
    true
  )
  const builder = host as unknown as {
    buildIpcApi(ext: ExtensionInfo, disposables: Array<() => void>): ExtensionActivationApi['ipc']
  }
  return builder.buildIpcApi(ext, disposables)
}

/** 起一个"已在运行的对端"（pipe 服务端；收到 ping 回 pong） */
async function startPipePeer(name: string): Promise<net.Server> {
  const server = createServer((send, msg) => {
    if (msg.method === 'ping') send({ jsonrpc: '2.0', id: msg.id, result: 'pong' })
  })
  await listen(server, hostEndpoint(name))
  servers.push(server)
  return server
}

/** 连上宿主 `listen` 的端点，扮演"连进来的外部进程" */
async function openPeer(name: string): Promise<IpcPeer> {
  const peer = await connectPeer(hostEndpoint(name))
  peers.push(peer)
  return peer
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'obox-ipc-renderer-'))
  state.reset()
  state.userData = workDir
  resetConnectionIdCounterForTest()
  await fs.mkdir(socketDir(), { recursive: true })
  registerIpcBridge()
  installWindow()
  disposables = []
})

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose()
  for (const peer of peers.splice(0)) peer.destroy()
  for (const server of servers.splice(0)) server.close()
  closeExtensionIpc(EXT)
  delete (globalThis as unknown as { window?: unknown }).window
  await new Promise((r) => setTimeout(r, 50))
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 })
})

describe('渲染进程 api.ipc.close(name) 的事件顺序', () => {
  it('server 多连接：每条活动连接各一次 onDisconnect{channel-closed}（真机 run5/run6 的回归锁）', async () => {
    const api = buildApi()
    const conns: number[] = []
    api.onConnection('svc', (id) => conns.push(id))
    await api.listen({ id: 'svc', transport: 'pipe' })
    await openPeer('svc')
    await openPeer('svc')
    expect(await waitFor(() => conns.length === 2)).toBe(true)

    // 真机姿势：close 之前才挂监听
    const disconnects: Array<{ id: number; code: string }> = []
    const closes: string[] = []
    api.onDisconnect('svc', (id, err) => disconnects.push({ id, code: err.code }))
    api.onClose('svc', (err) => closes.push(err.code))

    await api.close('svc')

    // 主进程在这次 close 里为**每条**连接各发一条 disconnect{channel-closed}
    expect(disconnects.map((d) => d.code)).toEqual(['channel-closed', 'channel-closed'])
    expect(disconnects.map((d) => d.id).sort((a, b) => a - b)).toEqual(
      [...conns].sort((a, b) => a - b)
    )
    // 事件**形状**不变：server 关闭在本期只发逐连接 disconnect（设计 §4.7 / api-reference），
    // 本次修复只改"清理时机"，不给自己加一条 close
    expect(closes).toEqual([])
    expect(await api.channels()).toEqual([])
  })

  it('client 通道：onClose 恰好一次 {channel-closed}；close 后同名 connect 仍可用且旧订阅不再参与', async () => {
    const api = buildApi()
    await startPipePeer('cli')
    await api.connect({ id: 'cli', transport: 'pipe' })
    expect(await api.request('cli', 'ping')).toBe('pong')

    const closes: string[] = []
    api.onClose('cli', (err) => closes.push(err.code))
    await api.close('cli')
    // 扩展主动 close() → onClose 一次，code = channel-closed
    expect(closes).toEqual(['channel-closed'])
    expect(await api.channels()).toEqual([])

    // 同名再 connect：通道照常工作（close 没有破坏名字空间/状态机）
    await api.connect({ id: 'cli', transport: 'pipe' })
    expect(await api.request('cli', 'ping')).toBe('pong')

    // 旧订阅已随第一次 close 作废：第二次 close 不再打到它（无残留监听器）
    await api.close('cli')
    expect(closes).toEqual(['channel-closed'])
  })

  it('对端崩溃：该连接恰好一次 onDisconnect{peer-crashed}，其后的 close(name) 不补发', async () => {
    const api = buildApi()
    const conns: number[] = []
    const seen: Array<{ id: number; code: string }> = []
    api.onConnection('svc', (id) => conns.push(id))
    api.onDisconnect('svc', (id, err) => seen.push({ id, code: err.code }))
    await api.listen({ id: 'svc', transport: 'pipe' })
    const peer = await openPeer('svc')
    expect(await waitFor(() => conns.length === 1)).toBe(true)

    peer.destroy()
    expect(await waitFor(() => seen.length === 1)).toBe(true)
    expect(seen[0]).toEqual({ id: conns[0], code: 'peer-crashed' })

    // 连接已经崩掉 → 随后的 close(name) 对该连接**不再**产生事件（R18：恰好一次）
    await api.close('svc')
    expect(seen).toHaveLength(1)
  })

  it('close 与对端崩溃并发：该连接仍恰好一次 onDisconnect，且重复 close 无副作用', async () => {
    const api = buildApi()
    const conns: number[] = []
    const seen: Array<{ id: number; code: string }> = []
    api.onConnection('svc', (id) => conns.push(id))
    api.onDisconnect('svc', (id, err) => seen.push({ id, code: err.code }))
    await api.listen({ id: 'svc', transport: 'pipe' })
    const peer = await openPeer('svc')
    expect(await waitFor(() => conns.length === 1)).toBe(true)

    // 崩与 close 同刻发出：谁先被主进程处理由事件循环决定，但"恰好一次"必须成立
    peer.destroy()
    await api.close('svc')
    expect(await waitFor(() => seen.length === 1)).toBe(true)
    expect(seen[0].id).toBe(conns[0])
    // 断因取自封闭清单：抢在套接字关闭事件前收尾 = channel-closed，反之 = peer-crashed
    expect(['peer-crashed', 'channel-closed']).toContain(seen[0].code)

    // 幂等：再 close 两次，既不再产生事件也不抛错
    await api.close('svc')
    await api.close('svc')
    expect(seen).toHaveLength(1)
  })

  it('close 后同名 listen：旧监听器已被清理，新通道的断开只通知新注册的回调', async () => {
    const api = buildApi()
    const oldConnections: number[] = []
    const oldDisconnects: number[] = []
    api.onConnection('svc', (id) => oldConnections.push(id))
    await api.listen({ id: 'svc', transport: 'pipe' })
    await openPeer('svc')
    expect(await waitFor(() => oldConnections.length === 1)).toBe(true)

    api.onDisconnect('svc', (id) => oldDisconnects.push(id))
    await api.close('svc')
    // close 自己的事件必须到（这正是缺陷 1 的回归点）
    expect(oldDisconnects).toEqual([oldConnections[0]])

    // 同名通道重新 listen：旧的两类监听器都该已被清理
    await api.listen({ id: 'svc', transport: 'pipe' })
    const fresh: number[] = []
    api.onDisconnect('svc', (id) => fresh.push(id))
    const peer = await openPeer('svc')
    peer.destroy()
    expect(await waitFor(() => fresh.length === 1)).toBe(true)
    expect(fresh[0]).not.toBe(oldConnections[0])
    expect(oldDisconnects).toHaveLength(1)
    expect(oldConnections).toHaveLength(1)
  })
})
