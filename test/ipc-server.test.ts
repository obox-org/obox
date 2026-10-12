/**
 * 扩展 IPC **pipe 服务端 / 多连接**测试（issue #43）。
 *
 * 缝隙说明（设计 §7）：`src/main/ipc.ts` 依赖 electron，而仓库既有约定是"测试不导入依赖 electron 的模块"。
 * 本文件用 `vi.mock('electron')` 只覆盖 `ipc.ts` 用到的 3 个符号（`app.getPath` / `BrowserWindow.getAllWindows`
 * / `ipcMain.handle`），既不改生产代码结构，又额外换来两处收益：能断言 `connection`/`disconnect` 事件的载荷，
 * 也能直接调用 `ipc:request` / `ipc:reply` 处理器（= 扮演渲染进程里的扩展）。
 *
 * 用例清单与 spec 的 V1–V9/V13/V14/V16/V17 一一对应（设计 §8.2）。所有断言只锁 `[稳定码]` 前缀，不锁文案全文。
 * 平台分支用"条件断言"而非 `it.skip`，保证用例名在 Windows（CI）上也命中。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

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
}

interface ElectronState {
  userData: string
  events: IpcEventLike[]
  handlers: Map<string, (...args: unknown[]) => unknown>
  waiters: Array<{ match: (e: IpcEventLike) => boolean; resolve: (e: IpcEventLike) => void }>
  emit(event: IpcEventLike): void
}

const electronState = vi.hoisted<ElectronState>(() => {
  const state: ElectronState = {
    userData: '',
    events: [],
    handlers: new Map(),
    waiters: [],
    emit: (): void => {}
  }
  state.emit = (event: IpcEventLike): void => {
    state.events.push(event)
    for (const waiter of [...state.waiters]) {
      if (!waiter.match(event)) continue
      state.waiters.splice(state.waiters.indexOf(waiter), 1)
      waiter.resolve(event)
    }
  }
  return state
})

vi.mock('electron', () => ({
  app: { getPath: (): string => electronState.userData },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (_channel: string, event: IpcEventLike): void => electronState.emit(event)
        }
      }
    ]
  },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown): void => {
      electronState.handlers.set(channel, fn)
    }
  }
}))

import {
  MAX_CONNECTIONS_PER_SERVER,
  broadcastExtensionChannel,
  closeExtensionChannel,
  closeExtensionIpc,
  listExtensionChannels,
  pendingForwardCount,
  registerIpcBridge,
  registerStreamChannel
} from '../src/main/ipc'
import {
  endpointPrepPlan,
  openPipeServerTransport,
  probeEndpointAlive,
  resetConnectionIdCounterForTest
} from '../src/main/ipcServer'
import { DEFAULT_TIMEOUT_MS, ipcEndpoint } from '../src/main/ipcCore'
import { validateIpcDeclaration } from '../src/shared/ipcDeclaration'
import {
  connectPeer,
  createServer,
  endpointFor,
  listen,
  waitFor,
  type ConnectPeerOptions,
  type IpcPeer
} from './helpers/ipcPeers'

const EXT = 'demo-ext'

let workDir = ''
const peers: IpcPeer[] = []
const cleanups: Array<() => void> = []
const extraServers: net.Server[] = []

/** POSIX 套接字目录（= `<userData>/ipc`，`electronState.userData` 指向临时目录） */
function socketDir(): string {
  return join(workDir, 'ipc')
}

/** 宿主 `listen` 后实际使用的端点（用 helper 的参照实现独立算出，不调 `ipcEndpoint`） */
function hostEndpoint(extId: string, name: string): string {
  return endpointFor(`${extId}-${name}`, socketDir())
}

interface BridgeResult {
  ok: boolean
  result?: unknown
  code?: string
  error?: string
}

function bridge(channel: string): (...args: unknown[]) => unknown {
  const fn = electronState.handlers.get(channel)
  if (!fn) throw new Error(`未注册的 handler: ${channel}`)
  return fn
}

async function callListen(extId: string, declaration: unknown): Promise<BridgeResult> {
  return (await bridge('ipc:listen')({}, extId, declaration)) as BridgeResult
}

async function callRequest(
  extId: string,
  name: string,
  method: string,
  params?: unknown,
  timeoutMs?: number,
  connectionId?: number
): Promise<BridgeResult> {
  return (await bridge('ipc:request')(
    {},
    extId,
    name,
    method,
    params,
    timeoutMs,
    connectionId
  )) as BridgeResult
}

async function callNotify(
  extId: string,
  name: string,
  method: string,
  params?: unknown,
  connectionId?: number
): Promise<BridgeResult> {
  return (await bridge('ipc:notify')({}, extId, name, method, params, connectionId)) as BridgeResult
}

async function callBroadcast(
  extId: string,
  name: string,
  method: string,
  params?: unknown
): Promise<BridgeResult> {
  return (await bridge('ipc:broadcast')({}, extId, name, method, params)) as BridgeResult
}

async function callClose(extId: string, name: string): Promise<void> {
  await bridge('ipc:close')({}, extId, name)
}

async function callReply(requestId: string, outcome: unknown): Promise<void> {
  await bridge('ipc:reply')({}, requestId, outcome)
}

function eventsOfType(type: string, extId = EXT): IpcEventLike[] {
  return electronState.events.filter((e) => e.extId === extId && e.type === type)
}

function connectionIds(extId = EXT): number[] {
  return eventsOfType('connection', extId).map((e) => Number(e.connectionId))
}

function requestEvents(extId = EXT): IpcEventLike[] {
  return eventsOfType('request', extId)
}

function disconnectEvents(extId = EXT): IpcEventLike[] {
  return eventsOfType('disconnect', extId)
}

/** 等一条事件（**不用定时器**：给 fake timers 用例用；谓词应唯一命中，否则可能命中旧事件） */
function nextEvent(match: (e: IpcEventLike) => boolean): Promise<IpcEventLike> {
  const existing = electronState.events.find(match)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve) => electronState.waiters.push({ match, resolve }))
}

async function openPeer(
  name: string,
  options: ConnectPeerOptions = {},
  extId = EXT
): Promise<IpcPeer> {
  const peer = await connectPeer(hostEndpoint(extId, name), options)
  peers.push(peer)
  return peer
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'obox-ipc-server-'))
  electronState.userData = workDir
  electronState.events.length = 0
  electronState.waiters.length = 0
  electronState.handlers.clear()
  resetConnectionIdCounterForTest()
  await fs.mkdir(socketDir(), { recursive: true })
  registerIpcBridge()
})

afterEach(async () => {
  // 先恢复被 spy 的 fs 方法（POSIX 分支用例会包 fs.unlink / fs.chmod）
  vi.restoreAllMocks()
  // 先恢复真实定时器：清理里的等待依赖它们
  vi.useRealTimers()
  for (const peer of peers.splice(0)) peer.destroy()
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const server of extraServers.splice(0)) server.close()
  closeExtensionIpc(EXT)
  await new Promise((r) => setTimeout(r, 50))
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 })
})

describe('api.ipc 服务端（listen 接受多连接）', () => {
  it('多客户端：两条真实连接各自定向 request 互不串包，各触发一次 onConnection', async () => {
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)

    const a = await openPeer('svc', { label: 'A' })
    const b = await openPeer('svc', { label: 'B' })
    expect(await waitFor(() => connectionIds().length === 2)).toBe(true)
    const ids = connectionIds()
    expect(ids[0]).not.toBe(ids[1])

    a.send({ jsonrpc: '2.0', id: 1, method: 'whoami', params: { from: 'A' } })
    b.send({ jsonrpc: '2.0', id: 1, method: 'whoami', params: { from: 'B' } })
    expect(await waitFor(() => requestEvents().length === 2)).toBe(true)

    const fromA = requestEvents().find((e) => (e.params as { from: string }).from === 'A')
    const fromB = requestEvents().find((e) => (e.params as { from: string }).from === 'B')
    expect(fromA?.connectionId).toBe(ids[0])
    expect(fromB?.connectionId).toBe(ids[1])

    await callReply(String(fromA?.requestId), { ok: true, result: { echo: 'A', conn: ids[0] } })
    await callReply(String(fromB?.requestId), { ok: true, result: { echo: 'B', conn: ids[1] } })

    // 各拿各的回包（连接级隔离）
    expect(await a.response(1)).toMatchObject({ result: { echo: 'A', conn: ids[0] } })
    expect(await b.response(1)).toMatchObject({ result: { echo: 'B', conn: ids[1] } })
  })

  it('广播：全部连接收到同一条通知；无连接时静默成功', async () => {
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    const a = await openPeer('svc', { label: 'A' })
    const b = await openPeer('svc', { label: 'B' })
    expect(await waitFor(() => connectionIds().length === 2)).toBe(true)

    expect((await callBroadcast(EXT, 'svc', 'tick', { n: 1 })).ok).toBe(true)
    const ma = await a.waitFor((m) => m.method === 'tick')
    const mb = await b.waitFor((m) => m.method === 'tick')
    // 通知语义：**没有 id**
    expect(ma).toEqual({ jsonrpc: '2.0', method: 'tick', params: { n: 1 } })
    expect(ma?.id).toBeUndefined()
    expect(mb).toEqual({ jsonrpc: '2.0', method: 'tick', params: { n: 1 } })

    // 无连接时静默成功（不报 not-connected）
    a.destroy()
    b.destroy()
    expect(await waitFor(() => disconnectEvents().length === 2)).toBe(true)
    const again = await callBroadcast(EXT, 'svc', 'tick', { n: 2 })
    expect(again.ok).toBe(true)
    expect(again.code).toBeUndefined()
  })

  it('广播：client 通道名 → invalid-declaration；不存在的名字 → not-connected', async () => {
    registerStreamChannel(EXT, 'cli', {
      readable: new PassThrough(),
      writable: new PassThrough()
    })

    const wrongRole = await callBroadcast(EXT, 'cli', 'm', {})
    expect(wrongRole.ok).toBe(false)
    expect(wrongRole.code).toBe('invalid-declaration')
    expect(String(wrongRole.error)).toMatch(/^\[invalid-declaration\]/)

    const missing = await callBroadcast(EXT, 'nope', 'm', {})
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe('not-connected')

    // 直调（不经桥）语义一致
    expect(() => broadcastExtensionChannel(EXT, 'cli', 'm')).toThrowError(
      /^\[invalid-declaration\]/
    )
  })

  it('并发：4 条连接同时连入并各自 request，onConnection 次数 = 连接数', async () => {
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    const conns = await Promise.all(
      [0, 1, 2, 3].map((i) => openPeer('svc', { label: `P${i}`, respond: () => null }))
    )
    expect(await waitFor(() => connectionIds().length === 4)).toBe(true)
    const ids = connectionIds()
    expect(new Set(ids).size).toBe(4)

    for (const [i, peer] of conns.entries()) {
      peer.send({ jsonrpc: '2.0', id: 1, method: 'who', params: { i } })
    }
    expect(await waitFor(() => requestEvents().length === 4)).toBe(true)
    const seen = new Set(requestEvents().map((e) => Number(e.connectionId)))
    expect(seen.size).toBe(4)
    for (const id of seen) expect(ids).toContain(id)

    for (const ev of requestEvents()) {
      await callReply(String(ev.requestId), { ok: true, result: ev.params })
    }
    // 每连接只收到自己那条回包
    for (const [i, peer] of conns.entries()) {
      expect(await peer.response(1)).toMatchObject({ result: { i } })
    }
    expect(connectionIds()).toHaveLength(4)
  })

  it('单连接断开：被断开那条恰好一次 onDisconnect，其余连接后续 request 仍成功', async () => {
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    const a = await openPeer('svc', { label: 'A', respond: () => ({ result: 'ok-A' }) })
    await openPeer('svc', { label: 'B', respond: () => ({ result: 'ok-B' }) })
    expect(await waitFor(() => connectionIds().length === 2)).toBe(true)
    const ids = connectionIds()

    a.destroy()
    expect(await waitFor(() => disconnectEvents().length === 1)).toBe(true)
    // 等一小会儿确认"恰好一次"
    await new Promise((r) => setTimeout(r, 120))
    expect(disconnectEvents()).toHaveLength(1)
    expect(disconnectEvents()[0].connectionId).toBe(ids[0])
    expect(disconnectEvents()[0].code).toBe('peer-crashed')

    // 其它连接完全不受影响
    const still = await callRequest(EXT, 'svc', 'ping', {}, undefined, ids[1])
    expect(still.ok).toBe(true)
    expect(still.result).toBe('ok-B')
  })

  it('端点被占用：第二次 listen 抛 connect-failed（含"已被占用"），不删除活着的端点', async () => {
    const ep = hostEndpoint(EXT, 'occupy')
    const occupy = createServer(() => {})
    extraServers.push(occupy)
    await listen(occupy, ep)

    const r = await callListen(EXT, { id: 'occupy', transport: 'pipe' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('connect-failed')
    expect(String(r.error)).toMatch(/已被占用/)

    if (process.platform !== 'win32') {
      // 活着的端点**不能**被删掉，且它确实还在应答
      await expect(fs.stat(ep)).resolves.toBeTruthy()
      expect(await probeEndpointAlive(ep)).toBe(true)
    }
  })

  it('陈旧端点：POSIX 清理残留 .sock 并 chmod 0600；Windows 不清理不 chmod', async () => {
    if (process.platform === 'win32') {
      // Windows 命名管道在内核命名空间、无落盘文件 → 不探测、不 chmod
      expect(endpointPrepPlan('win32')).toEqual({ probeStale: false, chmod: false })
      expect((await callListen(EXT, { id: 'stale', transport: 'pipe' })).ok).toBe(true)
      return
    }
    expect(endpointPrepPlan(process.platform)).toEqual({ probeStale: true, chmod: true })

    const ep = hostEndpoint(EXT, 'stale')
    await fs.writeFile(ep, '') // 伪造上次崩溃残留的文件
    expect((await callListen(EXT, { id: 'stale', transport: 'pipe' })).ok).toBe(true)
    const stat = await fs.stat(ep)
    expect(stat.mode & 0o777).toBe(0o600)

    // 端点确实可用（客户端连得上）
    await openPeer('stale')
    expect(await waitFor(() => connectionIds().length === 1)).toBe(true)
  })

  it('连接数上限：第 17 条收到错误帧后断开，不触发 onConnection', async () => {
    expect(MAX_CONNECTIONS_PER_SERVER).toBe(16)
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    for (let i = 0; i < MAX_CONNECTIONS_PER_SERVER; i++) {
      await openPeer('svc', { label: `P${i}` })
    }
    expect(await waitFor(() => connectionIds().length === MAX_CONNECTIONS_PER_SERVER)).toBe(true)

    const extra = await openPeer('svc', { label: 'extra' })
    const frame = await extra.waitFor((m) => m.error !== undefined, 2000)
    expect(frame?.id).toBeNull()
    const errObj = frame?.error as { code: number; message: string }
    expect(errObj.code).toBe(-32603)
    expect(errObj.message).toMatch(/^\[too-many-connections\]/)
    expect(await extra.waitForClose(2000)).toBe(true)

    expect(connectionIds()).toHaveLength(MAX_CONNECTIONS_PER_SERVER)
    expect(disconnectEvents()).toHaveLength(0)

    // 已建立的 16 条不受影响：各发一次 request 都成功
    const established = peers.slice(0, MAX_CONNECTIONS_PER_SERVER)
    const before = requestEvents().length
    for (const [i, peer] of established.entries()) {
      peer.send({ jsonrpc: '2.0', id: 100 + i, method: 'echo', params: { i } })
    }
    expect(await waitFor(() => requestEvents().length === before + 16)).toBe(true)
    for (const ev of requestEvents().slice(before)) {
      await callReply(String(ev.requestId), { ok: true, result: ev.params })
    }
    for (const [i, peer] of established.entries()) {
      expect(await peer.response(100 + i)).toMatchObject({ result: { i } })
    }
  })

  /**
   * M1 加固：上一条用例引用 `MAX_CONNECTIONS_PER_SERVER`，常量从 16 漂到 17 时它**跟着漂**、照样全绿。
   * 这条把上限**写死成字面量 16**（不引用常量），锁的是"行为"而不是"常量值"：
   * 第 17 个对端必须被拒、且 `connection` 事件恰好 16 次。
   */
  it('连接数上限（字面量 16）：17 个对端里 connection 事件恰好 16 次，第 17 个拿到 [too-many-connections]', async () => {
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)

    const opened: IpcPeer[] = []
    for (let i = 0; i < 17; i++) {
      opened.push(await openPeer('svc', { label: `L${i}` }))
    }

    // 第 17 条被拒：一条 JSON-RPC 错误帧 + 断开
    const rejected = opened[16]
    const frame = await rejected.waitFor((m) => m.error !== undefined, 2000)
    expect(frame?.id).toBeNull()
    expect((frame?.error as { message: string }).message).toMatch(/^\[too-many-connections\]/)
    expect(await rejected.waitForClose(2000)).toBe(true)

    // 行为断言：恰好 16 条连入（**字面量**，常量改成 17 也会红）
    expect(connectionIds()).toHaveLength(16)
    expect(disconnectEvents()).toHaveLength(0)
  })

  it('连接数上限（注入小上限）：maxConnections=2 时第 3 条被拒、第 1/2 条不受影响', async () => {
    const ep = hostEndpoint(EXT, 'small')
    const server = openPipeServerTransport({ endpoint: ep, maxConnections: 2 })
    cleanups.push(() => server.dispose())
    await server.ready

    const a = await connectPeer(ep, { label: 'A', respond: () => ({ result: 'a' }) })
    peers.push(a)
    const b = await connectPeer(ep, { label: 'B', respond: () => ({ result: 'b' }) })
    peers.push(b)
    expect(await waitFor(() => server.connectionCount === 2)).toBe(true)

    const c = await connectPeer(ep, { label: 'C' })
    peers.push(c)
    const frame = await c.waitFor((m) => m.error !== undefined, 2000)
    expect((frame?.error as { message: string }).message).toMatch(/^\[too-many-connections\]/)
    expect(server.connectionCount).toBe(2)

    const ids = server.listConnections()
    expect(ids).toHaveLength(2)
    const first = server.getConnection(ids[0])
    const second = server.getConnection(ids[1])
    await expect(first?.channel.request('ping')).resolves.toBe('a')
    await expect(second?.channel.request('ping')).resolves.toBe('b')
    expect(server.listConnections()).toEqual(ids)
  })

  it('closeExtensionIpc：关闭该扩展的全部 server 与连接，端点不再可连', async () => {
    const ep = hostEndpoint(EXT, 'svc')
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    const a = await openPeer('svc', { label: 'A' })
    const b = await openPeer('svc', { label: 'B' })
    expect(await waitFor(() => connectionIds().length === 2)).toBe(true)

    closeExtensionIpc(EXT)

    expect(await a.waitForClose(2000)).toBe(true)
    expect(await b.waitForClose(2000)).toBe(true)
    // 宿主主动关闭 → 每条连接恰好一次 disconnect，code = channel-closed
    expect(disconnectEvents().map((e) => e.code)).toEqual(['channel-closed', 'channel-closed'])
    expect(listExtensionChannels(EXT)).toEqual([])
    expect(await bridge('ipc:list')({}, EXT)).toEqual([])

    // 端点不再可连
    await expect(connectPeer(ep)).rejects.toBeTruthy()
    if (process.platform !== 'win32') {
      await expect(fs.stat(ep)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('close(name)：幂等、不存在静默成功、server 与 client 都按名字关闭', async () => {
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    registerStreamChannel(EXT, 'cli', {
      readable: new PassThrough(),
      writable: new PassThrough()
    })
    expect([...listExtensionChannels(EXT)].sort()).toEqual(['cli', 'svc'])

    const a = await openPeer('svc', { label: 'A' })
    expect(await waitFor(() => connectionIds().length === 1)).toBe(true)

    // 幂等：连调两次都不抛错
    await callClose(EXT, 'svc')
    await callClose(EXT, 'svc')
    expect(await a.waitForClose(2000)).toBe(true)
    expect(listExtensionChannels(EXT)).toEqual(['cli'])

    // 不存在 → 静默成功
    await callClose(EXT, 'nope')

    // client 通道也按名字关闭
    await callClose(EXT, 'cli')
    expect(listExtensionChannels(EXT)).toEqual([])
  })

  it('对端崩溃与非法帧：该连接以 peer-crashed / protocol-error 关闭并触发一次 onDisconnect，server 仍可接受新连接', async () => {
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)

    const a = await openPeer('svc', { label: 'A' })
    expect(await waitFor(() => connectionIds().length === 1)).toBe(true)
    a.destroy()
    expect(await waitFor(() => disconnectEvents().length === 1)).toBe(true)
    expect(disconnectEvents()[0].connectionId).toBe(connectionIds()[0])
    expect(disconnectEvents()[0].code).toBe('peer-crashed')

    // 非法帧：帧头声明 5 字节、载荷不是合法 JSON
    const b = await openPeer('svc', { label: 'B' })
    expect(await waitFor(() => connectionIds().length === 2)).toBe(true)
    b.sendRaw(Buffer.from('Content-Length: 5\r\n\r\nnope!', 'ascii'))
    expect(await waitFor(() => disconnectEvents().length === 2)).toBe(true)
    expect(disconnectEvents()[1].connectionId).toBe(connectionIds()[1])
    expect(disconnectEvents()[1].code).toBe('protocol-error')
    expect(await b.waitForClose(2000)).toBe(true)

    // server 没有退出：仍能接受新连接并完成一次请求
    await openPeer('svc', { label: 'C', respond: () => ({ result: 'pong' }) })
    expect(await waitFor(() => connectionIds().length === 3)).toBe(true)
    const r = await callRequest(EXT, 'svc', 'ping', {}, undefined, connectionIds()[2])
    expect(r.ok).toBe(true)
    expect(r.result).toBe('pong')
  })

  it('超时：server 连接上的 request 在对端不回包时以 timeout 失败（默认口径不变），该连接与其它连接此后仍可用', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    await openPeer('svc', {
      label: 'A',
      respond: (method) => (method === 'slow' ? null : { result: 'fast' })
    })
    await openPeer('svc', { label: 'B', respond: () => ({ result: 'fast' }) })
    expect(await waitFor(() => connectionIds().length === 2)).toBe(true)
    const ids = connectionIds()

    const timedOut = await callRequest(EXT, 'svc', 'slow', {}, 80, ids[0])
    expect(timedOut.ok).toBe(false)
    expect(timedOut.code).toBe('timeout')

    // 该连接此后仍可用
    const stillOk = await callRequest(EXT, 'svc', 'fast', {}, 500, ids[0])
    expect(stillOk.ok).toBe(true)
    expect(stillOk.result).toBe('fast')
    // 其它连接不受影响
    expect((await callRequest(EXT, 'svc', 'fast', {}, 500, ids[1])).ok).toBe(true)
  })

  it('invalid-declaration 三例：listen 传 stdio / server 名省略 connectionId / client 通道传 connectionId', async () => {
    // ① 名字已被占用 + transport:'stdio' → 仍报 invalid-declaration（**角色判定先于名字判定**）
    registerStreamChannel(EXT, 'busy', {
      readable: new PassThrough(),
      writable: new PassThrough()
    })
    const busy = await callListen(EXT, { id: 'busy', transport: 'stdio', program: 'bin/x.js' })
    expect(busy.ok).toBe(false)
    expect(busy.code).toBe('invalid-declaration')
    expect(String(busy.error)).toMatch(/^\[invalid-declaration\]/)
    const stdio = await callListen(EXT, { id: 'stdio-only', transport: 'stdio' })
    expect(stdio.code).toBe('invalid-declaration')

    // ② server 名字下省略 connectionId
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    const noConn = await callRequest(EXT, 'svc', 'm', {})
    expect(noConn.ok).toBe(false)
    expect(noConn.code).toBe('invalid-declaration')
    expect((await callNotify(EXT, 'svc', 'm', {})).code).toBe('invalid-declaration')
    // 名字不存在仍是 not-connected（缺省定向判定在名字存在性之后）
    expect((await callRequest(EXT, 'nope', 'm', {})).code).toBe('not-connected')

    // ③ client 通道传 connectionId
    const wrongTarget = await callRequest(EXT, 'busy', 'm', {}, undefined, 1)
    expect(wrongTarget.ok).toBe(false)
    expect(wrongTarget.code).toBe('invalid-declaration')
    expect((await callNotify(EXT, 'busy', 'm', {}, 1)).code).toBe('invalid-declaration')
  })

  it('在途请求：连接断开瞬间转发条目立即结算（不重放），新连接拿新 ID 且不再收到该请求', async () => {
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    const a = await openPeer('svc', { label: 'A', respond: () => null })
    expect(await waitFor(() => connectionIds().length === 1)).toBe(true)
    const oldId = connectionIds()[0]

    a.send({ jsonrpc: '2.0', id: 7, method: 'hold', params: { n: 1 } })
    expect(await waitFor(() => requestEvents().length === 1)).toBe(true)
    const inFlight = requestEvents()[0]
    expect(inFlight.connectionId).toBe(oldId)
    expect(pendingForwardCount()).toBe(1)

    a.destroy()
    // **不等 30s**：断连瞬间就结算
    expect(await waitFor(() => pendingForwardCount() === 0, 2000)).toBe(true)
    expect(await waitFor(() => disconnectEvents().length === 1)).toBe(true)

    const a2 = await openPeer('svc', { label: 'A2' })
    expect(await waitFor(() => connectionIds().length === 2)).toBe(true)
    const newId = connectionIds()[1]
    expect(newId).toBeGreaterThan(oldId)

    // 迟到的旧回包被当作未知 requestId 丢弃（不重放、不报错）
    await callReply(String(inFlight.requestId), { ok: true, result: 'late' })
    await new Promise((r) => setTimeout(r, 150))
    expect(a2.messages).toHaveLength(0)
    expect(pendingForwardCount()).toBe(0)
  })

  it('连接 ID：单调递增且不复用（关闭 server 后重新 listen，新 ID 严格大于此前全部 ID）', async () => {
    resetConnectionIdCounterForTest()
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    const a = await openPeer('svc', { label: 'A' })
    expect(await waitFor(() => connectionIds().length === 1)).toBe(true)
    const first = connectionIds()[0]
    expect(first).toBe(1)

    closeExtensionChannel(EXT, 'svc')
    expect(await a.waitForClose(2000)).toBe(true)
    expect(await waitFor(() => disconnectEvents().length === 1)).toBe(true)
    expect(disconnectEvents()[0].connectionId).toBe(first)

    // 同名 server 重建：新连接拿到**严格更大**的 ID（不断言 "=2"：超限连接不分配 ID）
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    await openPeer('svc', { label: 'B' })
    expect(await waitFor(() => connectionIds().length === 2)).toBe(true)
    const second = connectionIds()[1]
    expect(second).toBeGreaterThan(first)

    // 旧 ID 不再出现在任何 connection 事件里
    expect(connectionIds().filter((id) => id === first)).toHaveLength(1)
    expect(new Set(connectionIds()).size).toBe(2)
    expect(disconnectEvents()).toHaveLength(1)
  })

  it('平台分叉：endpointPrepPlan 三分支 + ipcEndpoint 不含 suffix（两平台）', () => {
    expect(endpointPrepPlan('win32')).toEqual({ probeStale: false, chmod: false })
    expect(endpointPrepPlan('linux')).toEqual({ probeStale: true, chmod: true })
    expect(endpointPrepPlan('darwin')).toEqual({ probeStale: true, chmod: true })

    const dir = socketDir()
    const plain = ipcEndpoint({ socketDir: dir, extensionId: 'ext', name: 'svc' })
    const suffixed = ipcEndpoint({ socketDir: dir, extensionId: 'ext', name: 'svc', suffix: '7' })
    expect(suffixed).not.toBe(plain)
    // 不带 suffix 的形态与 helper 的参照实现一致
    expect(plain).toBe(endpointFor('ext-svc', dir))
    // 不是 TCP 端口
    expect(plain).not.toMatch(/:\d{2,5}$/)
    if (process.platform === 'win32') {
      expect(plain).toBe('\\\\.\\pipe\\obox-ext-svc')
    } else {
      expect(plain.endsWith('obox-ext-svc.sock')).toBe(true)
    }
  })

  it('pendingForwardCount：转发超时后归零（既有 30s 口径）', async () => {
    expect((await callListen(EXT, { id: 'svc', transport: 'pipe' })).ok).toBe(true)
    const a = await openPeer('svc', { label: 'A', respond: () => null })
    expect(await waitFor(() => connectionIds().length === 1)).toBe(true)
    expect(pendingForwardCount()).toBe(0)

    vi.useFakeTimers()
    try {
      a.send({ jsonrpc: '2.0', id: 1, method: 'hold' })
      // 事件等待用 mock 的 waiter（**不用定时器**，fake timers 下也能跑）
      await nextEvent((e) => e.type === 'request')
      expect(pendingForwardCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(pendingForwardCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }

    // 对端收到 -32603 回包（socket.write 是真实 I/O，与定时器无关）
    const errFrame = await a.waitFor((m) => m.error !== undefined, 2000)
    expect((errFrame?.error as { code: number }).code).toBe(-32603)
  })

  /**
   * M2（V15 的行为面）：清单里写 `mode` **不生效** —— 归一化后的声明里没有任何"角色位"，
   * 因此它**不会**带来任何监听；端点只有显式 `api.ipc.listen()` 才会建立。
   * 断言的后半段（显式 listen 后同一端点就连得上）证明前半段不是空洞断言。
   */
  it('V15：清单里写 mode 不产生任何监听（角色位进不了声明，监听只由 api.ipc.listen 建立）', async () => {
    const ep = hostEndpoint(EXT, 'bus')
    // 合法值 `'server'` 与**非法枚举值**都被白名单读取吞掉：既不过校验、也不进声明
    for (const mode of ['server', 'bogus']) {
      const declaration = validateIpcDeclaration({ id: 'bus', transport: 'pipe', mode })
      expect(declaration, mode).toEqual({ id: 'bus', transport: 'pipe' })
      expect(Object.keys(declaration), mode).toEqual(['id', 'transport'])
    }
    const declaration = validateIpcDeclaration({ id: 'bus', transport: 'pipe', mode: 'server' })

    // 只有"清单声明"（哪怕写了 role 语义）→ 没有任何监听
    expect(listExtensionChannels(EXT)).toEqual([])
    await expect(connectPeer(ep)).rejects.toBeTruthy()

    // 反向确认：同一端点只要显式 listen 就能连上（断言不空洞）
    expect((await callListen(EXT, declaration)).ok).toBe(true)
    await openPeer('bus')
    expect(await waitFor(() => connectionIds().length === 1)).toBe(true)
  })
})

/**
 * H1 / M3：POSIX 专属分支（`plan.probeStale` / `plan.chmod`）的**注入式覆盖**。
 *
 * 为什么必须注入：本文件此前没有任何一处给 `openPipeServerTransport` 传 `platform:`，
 * 于是 `plan.probeStale` 在 windows-latest（CI）上恒为 false，`src/main/ipcServer.ts` 里
 * "探测到活端点则报错且**绝不 unlink**"（R10）、"陈旧则清理 + chmod"（R11）、"K3 竞态重试"、
 * "dispose 收尾 unlink"四条分支在 CI 上**零覆盖**——把 unlink 插进探测命中分支也能全绿。
 *
 * 注入 `platform:'linux'` 只改**平台分叉判定**，端点仍是本机真实端点（Windows 命名管道 / POSIX 域套接字），
 * 所以既不需要真实 UDS，也让断言落在真实 I/O 上：`vi.spyOn(fs,'unlink'|'chmod')` 记录调用，
 * "活端点一次 unlink 都不许发"这条断言在违反 R10 时必然变红。
 */
describe('POSIX 分支注入（platform:"linux"）：R10 不删活端点 / 陈旧处置 / K3 竞态 / dispose 收尾', () => {
  it('活端点：探测命中即 connect-failed（走探测分支的错误文案），且一次 unlink 都不发（R10）', async () => {
    const ep = hostEndpoint(EXT, 'alive')
    const occupy = createServer(() => {})
    extraServers.push(occupy)
    await listen(occupy, ep)

    const unlinkSpy = vi.spyOn(fs, 'unlink')
    const server = openPipeServerTransport({ endpoint: ep, platform: 'linux', maxConnections: 4 })
    cleanups.push(() => server.dispose())

    // 探测分支自己的文案（不是 toConnectFailed 的"已被占用或无法监听"）→ 证明确实命中了探测
    await expect(server.ready).rejects.toMatchObject({ code: 'connect-failed' })
    await expect(server.ready).rejects.toThrow(/^\[connect-failed\] 端点已被占用: /)

    // **核心断言（H1）**：活着的端点绝不能被 unlink —— 删活端点就是 R10 违规
    expect(unlinkSpy).not.toHaveBeenCalled()
    // 端点确实还活着：探测为 true，对端仍能连上
    await expect(probeEndpointAlive(ep)).resolves.toBe(true)
    const peer = await connectPeer(ep)
    peers.push(peer)
    expect(peer.isClosed).toBe(false)
  })

  it('probeEndpointAlive：活端点 true / 不存在的端点 false（不用 mock）', async () => {
    const live = hostEndpoint(EXT, 'probe-live')
    const occupy = createServer(() => {})
    extraServers.push(occupy)
    await listen(occupy, live)

    await expect(probeEndpointAlive(live)).resolves.toBe(true)
    await expect(probeEndpointAlive(hostEndpoint(EXT, 'probe-gone'))).resolves.toBe(false)
  })

  it('陈旧端点：listen 前清理一次、listen 后 chmod 0600、dispose 时再清理一次（R11 + 收尾分支）', async () => {
    const ep = hostEndpoint(EXT, 'stale-injected')
    const unlinkSpy = vi.spyOn(fs, 'unlink')
    const chmodSpy = vi.spyOn(fs, 'chmod')

    const server = openPipeServerTransport({
      endpoint: ep,
      platform: 'linux',
      maxConnections: 4,
      log: () => {}
    })
    await server.ready

    // ① 陈旧清理分支：探测判定"陈旧"→ listen 之前对端点做过一次 unlink
    expect(unlinkSpy.mock.calls.map((call) => String(call[0]))).toEqual([ep])
    // ② chmod 分支：listen 成功后 chmod 0600
    expect(chmodSpy.mock.calls.map((call) => [String(call[0]), call[1]])).toEqual([[ep, 0o600]])

    // ③ 端点真的在监听
    const peer = await connectPeer(ep)
    peers.push(peer)
    expect(await waitFor(() => server.connectionCount === 1)).toBe(true)

    // ④ dispose 收尾分支（`listening && plan.probeStale`）→ 再清理一次端点
    server.dispose()
    expect(unlinkSpy.mock.calls.map((call) => String(call[0]))).toEqual([ep, ep])
  })

  it('K3 竞态：探测判定"陈旧"后被他人抢先 listen → unlink 后重试一次并成功（重试分支）', async () => {
    const ep = hostEndpoint(EXT, 'race')
    const realUnlink = fs.unlink.bind(fs)
    /** 抢先占住端点者：模拟"探测与 listen 之间的另一个进程" */
    let occupier: net.Server | null = null
    const unlinkCalls: number[] = []

    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      unlinkCalls.push(unlinkCalls.length + 1)
      const path = String(target)
      if (unlinkCalls.length === 1) {
        // 探测（陈旧）之后、真正 listen 之前：他人抢先 bind → 让第一次 listen 真报 EADDRINUSE
        occupier = net.createServer()
        await listen(occupier, path)
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }
      // 重试前的清理：放掉抢先者，再真删端点文件（POSIX 需要，Windows 上是 EINVAL/ENOENT 无所谓）
      const held = occupier
      occupier = null
      if (held) await new Promise<void>((r) => held.close(() => r()))
      await realUnlink(path).catch(() => {})
    })

    const server = openPipeServerTransport({
      endpoint: ep,
      platform: 'linux',
      maxConnections: 4,
      log: () => {}
    })
    cleanups.push(() => server.dispose())

    await expect(server.ready).resolves.toBeUndefined()
    // 两次 unlink：① 陈旧清理 ② 竞态重试前的清理（重试分支确实跑到了）
    expect(unlinkSpy).toHaveBeenCalledTimes(2)
    expect(occupier).toBeNull()

    // 重试真的 listen 成功了：对端能连上
    const peer = await connectPeer(ep)
    peers.push(peer)
    expect(await waitFor(() => server.connectionCount === 1)).toBe(true)
  })
})
