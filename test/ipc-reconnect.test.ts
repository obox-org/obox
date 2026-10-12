/**
 * 扩展 IPC **断线自动重连**测试（issue #44）。
 *
 * 覆盖（设计 §9.1 的 16 条 → 本文件 18 个用例）：
 * - **生产壳层**（`src/main/ipc.ts`，经 `vi.mock('electron')` 触达）：重连成功 / 窗口期 `not-connected` /
 *   在途请求不重放 / 上限与放弃 / `close()` 与 `closeExtensionIpc` 取消 / 非法帧不重连 /
 *   协议状态归零 / stdio 拒绝 / `retries: 0` 关闭 / 不传 `autoReconnect` 的回归；
 * - **纯逻辑**（`src/main/ipcReconnect.ts`）：封闭清单、退避序列与封顶、`attempts` 语义、`cancel` 幂等。
 *
 * 缝隙说明：
 * 1. **electron mock** 沿用 `test/ipc-server.test.ts` 的写法（只覆盖 `ipc.ts` 用到的三个符号），
 *    因此可以直接调用 `ipc:connect` / `ipc:request` 等处理器（= 扮演渲染进程里的扩展）；
 * 2. **sleep 注入**：`ipc.ts` 自己 new 控制器，测试要拿到"等待序列"与"窗口期控制权"，
 *    故用 `vi.mock('../src/main/ipcReconnect')` 在**不改生产代码**的前提下包一层注入式 sleep；
 * 3. **定时器计数**：需要 `vi.getTimerCount()` 的用例把 sleep 交回控制器自带的 `setTimeout`
 *    （`toFake: ['setTimeout','clearTimeout']`，其它计时器保持真实），否则"0 个定时器"会是自我指涉的空断言。
 * 4. 真实对端是 `net` 服务端（pipe 传输的"已在运行的进程"），复用 `test/helpers/ipcPeers.ts` 的
 *    `createServer` / `endpointFor` / `listen` / `waitFor`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 本文件对 `ipc:event` 载荷的窄化视图（只用到这些字段） */
interface IpcEventLike {
  extId: string
  name: string
  type: string
  code?: string
  message?: string
  attempts?: number
  connectionId?: number
  requestId?: string
  method?: string
  params?: unknown
  text?: string
}

interface ElectronState {
  userData: string
  events: IpcEventLike[]
  handlers: Map<string, (...args: unknown[]) => unknown>
  /** 事件等待者：无定时器（fake timers 下也能跑） */
  waiters: Array<{ check: () => boolean }>
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
      if (!waiter.check()) continue
      state.waiters.splice(state.waiters.indexOf(waiter), 1)
    }
  }
  return state
})

/**
 * 退避等待的注入缝隙（`vi.mock` 的工厂必须用 hoisted 变量）：
 * - `real`：不注入 → 控制器自带 `setTimeout` + `unref()`（配合 `vi.useFakeTimers` 数定时器）；
 * - `auto`：注入并**立即 resolve**（确定性序列，不依赖真实等待）；
 * - `manual`：注入并**挂起**，由用例 `release()` 逐次放行（窗口期与逐次尝试的精确控制）。
 */
interface SleepGate {
  mode: 'real' | 'auto' | 'manual'
  sleeps: number[]
  pending: Array<() => void>
  release(): void
  reset(): void
}

const sleepGate = vi.hoisted<SleepGate>(() => {
  const gate: SleepGate = {
    mode: 'real',
    sleeps: [],
    pending: [],
    release: (): void => {
      gate.pending.shift()?.()
    },
    reset: (): void => {
      gate.mode = 'real'
      gate.sleeps.length = 0
      gate.pending.length = 0
    }
  }
  return gate
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

vi.mock('../src/main/ipcReconnect', async () => {
  const actual = await vi.importActual<typeof import('../src/main/ipcReconnect')>(
    '../src/main/ipcReconnect'
  )
  return {
    ...actual,
    createReconnectController: (
      options: Parameters<typeof actual.createReconnectController>[0]
    ): ReturnType<typeof actual.createReconnectController> => {
      if (sleepGate.mode === 'real') return actual.createReconnectController(options)
      const sleep = (ms: number): Promise<void> => {
        sleepGate.sleeps.push(ms)
        if (sleepGate.mode === 'auto') return Promise.resolve()
        return new Promise<void>((resolve) => sleepGate.pending.push(resolve))
      }
      return actual.createReconnectController({ ...options, sleep })
    }
  }
})

import { closeExtensionIpc, listExtensionChannels, registerIpcBridge } from '../src/main/ipc'
import { DEFAULT_TIMEOUT_MS, IpcCoreError, type IpcErrorCode } from '../src/main/ipcCore'
import {
  backoffDelayFor,
  createReconnectController,
  isReconnectableCloseReason
} from '../src/main/ipcReconnect'
import {
  DEFAULT_RECONNECT_BACKOFF_MS,
  DEFAULT_RECONNECT_RETRIES,
  MAX_BACKOFF_MS,
  validateRuntimeIpcDeclaration
} from '../src/shared/ipcDeclaration'
import { createServer, encodeFrame, endpointFor, listen, waitFor } from './helpers/ipcPeers'

/**
 * 扩展 id：**故意与其它测试文件不同**。
 * Windows 命名管道是**机器级**的（不含进程/临时目录），`obox-<扩展id>-<通道名>` 会在
 * vitest 的并行 worker 之间撞名——`test/ipc-server.test.ts` 用 `demo-ext` + `svc`/`bus`，
 * 因此本文件必须换一个扩展 id，否则同一台机器上两个文件会互相抢端点。
 */
const EXT = 'reconnect-ext'

interface BridgeResult {
  ok: boolean
  result?: unknown
  code?: string
  error?: string
}

/** 真实对端（pipe 传输的"已在运行的进程"） */
interface TestPeer {
  readonly endpoint: string
  readonly messages: Array<Record<string, unknown>>
  /** 写一条**原始字节**（非法帧用例） */
  sendRaw(bytes: Buffer): void
  /** 模拟对端进程崩溃：销毁全部连接 + 停止监听 +（POSIX）清掉陈旧 `.sock` */
  kill(): Promise<void>
}

let workDir = ''
const peers: TestPeer[] = []

/** 宿主 client 通道实际使用的端点（用 helper 的参照实现独立算出，不调 `ipcEndpoint`） */
function socketDir(): string {
  return join(workDir, 'ipc')
}

function hostEndpoint(name: string): string {
  return endpointFor(`${EXT}-${name}`, socketDir())
}

/** 起一个真实对端；`respond` 返回 `null` = **故意不回包**（在途/超时用例需要） */
async function startPeer(
  name: string,
  options: {
    respond?: (msg: Record<string, unknown>) => { result: unknown } | { error: string } | null
    /** 收到该方法时发一个**非法帧**（issue #44 V16） */
    badFrameOn?: string
  } = {}
): Promise<TestPeer> {
  const endpoint = hostEndpoint(name)
  const messages: Array<Record<string, unknown>> = []
  const sockets = new Set<net.Socket>()
  const respond =
    options.respond ??
    ((msg: Record<string, unknown>) => (msg.method === 'ping' ? { result: 'pong' } : null))
  const server = createServer((send, msg) => {
    messages.push(msg)
    if (options.badFrameOn !== undefined && msg.method === options.badFrameOn) {
      const socket = [...sockets][0]
      // 非 JSON 载荷 → 对端发非法帧（`protocol-error`）
      socket?.write(Buffer.from('Content-Length: 5\r\n\r\n{bad}', 'utf8'))
      return
    }
    const reply = respond(msg)
    if (reply) send({ jsonrpc: '2.0', id: msg.id, ...reply })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await listen(server, endpoint)
  if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600).catch(() => {})

  const peer: TestPeer = {
    endpoint,
    messages,
    sendRaw: (bytes: Buffer): void => {
      for (const socket of sockets) socket.write(bytes)
    },
    kill: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // Node 不会在 close 时删掉 POSIX 的 `.sock`；留着会让"重启对端"撞 EADDRINUSE（K6 的真机现象）
      if (process.platform !== 'win32') await fs.unlink(endpoint).catch(() => {})
    }
  }
  peers.push(peer)
  return peer
}

function bridge(channel: string): (...args: unknown[]) => unknown {
  const fn = electronState.handlers.get(channel)
  if (!fn) throw new Error(`未注册的 handler: ${channel}`)
  return fn
}

async function callConnect(extId: string, declaration: unknown): Promise<BridgeResult> {
  return (await bridge('ipc:connect')({}, extId, declaration)) as BridgeResult
}

async function callListen(extId: string, declaration: unknown): Promise<BridgeResult> {
  return (await bridge('ipc:listen')({}, extId, declaration)) as BridgeResult
}

async function callRequest(
  extId: string,
  name: string,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<BridgeResult> {
  return (await bridge('ipc:request')({}, extId, name, method, params, timeoutMs)) as BridgeResult
}

async function callNotify(
  extId: string,
  name: string,
  method: string,
  params?: unknown
): Promise<BridgeResult> {
  return (await bridge('ipc:notify')({}, extId, name, method, params)) as BridgeResult
}

async function callClose(extId: string, name: string): Promise<void> {
  await bridge('ipc:close')({}, extId, name)
}

function eventsOfType(type: string, extId = EXT): IpcEventLike[] {
  return electronState.events.filter((e) => e.extId === extId && e.type === type)
}

/**
 * 等**第 n 条**满足条件的事件（n 从 1 起）。
 * 用事件等待者而非轮询定时器 → 与 `vi.useFakeTimers()` 兼容；"第 n 条"的写法让"恰好一次"可断言。
 */
function waitEvent(match: (e: IpcEventLike) => boolean, occurrence = 1): Promise<IpcEventLike> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const hits = electronState.events.filter(match)
      if (hits.length < occurrence) return false
      resolve(hits[occurrence - 1])
      return true
    }
    if (check()) return
    electronState.waiters.push({ check })
  })
}

/** 连接一个带 `autoReconnect` 的 pipe 通道（缺省即用例最常用的策略） */
async function connectBus(
  policy: { retries?: number; backoffMs?: number } = { retries: 3, backoffMs: 250 }
): Promise<BridgeResult> {
  return callConnect(EXT, { id: 'bus', transport: 'pipe', autoReconnect: policy })
}

beforeEach(async () => {
  sleepGate.reset()
  workDir = await fs.mkdtemp(join(tmpdir(), 'obox-ipc-reconnect-'))
  electronState.userData = workDir
  electronState.events.length = 0
  electronState.waiters.length = 0
  electronState.handlers.clear()
  await fs.mkdir(socketDir(), { recursive: true })
  registerIpcBridge()
})

afterEach(async () => {
  vi.useRealTimers()
  for (const peer of peers.splice(0)) await peer.kill()
  closeExtensionIpc(EXT)
  await new Promise((r) => setTimeout(r, 30))
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 })
})

/**
 * 纯逻辑：**可重连断因的封闭清单**（R4/S2）。
 * 逐码断言（不是"只断常量"）：把 `peer-crashed` 之外**任何一个**码放宽成可重连都会红。
 */
describe('ipcReconnect 纯逻辑', () => {
  it('isReconnectableCloseReason 的封闭清单：只有 peer-crashed 可重连（null/其余码一律不可）', () => {
    const codes: IpcErrorCode[] = [
      'invalid-declaration',
      'not-connected',
      'connect-failed',
      'protocol-error',
      'timeout',
      'cancelled',
      'message-too-large',
      'too-many-requests',
      'too-many-channels',
      'too-many-connections',
      'peer-crashed',
      'channel-closed'
    ]
    for (const code of codes) {
      expect(isReconnectableCloseReason(new IpcCoreError(code, 'x')), code).toBe(
        code === 'peer-crashed'
      )
    }
    // 主动关闭（`transport.dispose()` → `channel.close()` 无 reason）→ 不可重连
    expect(isReconnectableCloseReason(null)).toBe(false)
  })

  it('backoffDelayFor：×2 递增、单次等待封顶 MAX_BACKOFF_MS、backoffMs:0 不等待', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => backoffDelayFor({ attempt, backoffMs: 250 }))).toEqual([
      250, 500, 1000, 2000, 4000
    ])
    // 封顶：backoffMs 很大时单次等待被截到 30000（与"默认请求超时 30s"同量级）
    expect([1, 2, 3, 4].map((attempt) => backoffDelayFor({ attempt, backoffMs: 20_000 }))).toEqual([
      20_000, 30_000, 30_000, 30_000
    ])
    // 溢出保护：很大 attempt 也不会算出 Infinity
    expect(backoffDelayFor({ attempt: 400, backoffMs: 250 })).toBe(MAX_BACKOFF_MS)
    // E4：`backoffMs: 0` 合法 = 不等待
    expect([1, 2, 3].map((attempt) => backoffDelayFor({ attempt, backoffMs: 0 }))).toEqual([
      0, 0, 0
    ])
    expect(MAX_BACKOFF_MS).toBe(30_000)
    expect(DEFAULT_RECONNECT_RETRIES).toBe(3)
    expect(DEFAULT_RECONNECT_BACKOFF_MS).toBe(250)
  })

  it('上限：连续失败 retries 次后停止，等待序列为 [250,500,1000]，之后无新调用/success', async () => {
    const sleeps: number[] = []
    let attempts = 0
    const giveUps: unknown[] = []
    const successes: number[] = []
    const controller = createReconnectController({
      retries: 3,
      backoffMs: 250,
      sleep: async (ms): Promise<void> => void sleeps.push(ms),
      attempt: async (): Promise<void> => {
        attempts++
        throw new Error('重连尝试失败')
      },
      onGiveUp: (err): void => void giveUps.push(err),
      onSuccess: (info): void => void successes.push(info.attempts)
    })
    controller.start()
    expect(await waitFor(() => giveUps.length === 1)).toBe(true)
    expect(sleeps).toEqual([250, 500, 1000])
    expect(attempts).toBe(3)
    expect(controller.running).toBe(false)
    expect(successes).toEqual([])
    // 之后不再有任何等待/尝试（真实等待一段时间来证明，而不是"只看常量"）
    await new Promise((r) => setTimeout(r, 60))
    expect(sleeps).toEqual([250, 500, 1000])
    expect(attempts).toBe(3)
  })

  it('cancel 幂等：两次 cancel 不抛错；尝试进行中 cancel → 不再触发 onSuccess', async () => {
    const successes: number[] = []
    const finished = createReconnectController({
      retries: 3,
      backoffMs: 250,
      sleep: async (): Promise<void> => {},
      attempt: async (): Promise<void> => {},
      onSuccess: (info): void => void successes.push(info.attempts)
    })
    finished.start()
    expect(await waitFor(() => successes.length === 1)).toBe(true)
    expect(successes).toEqual([1])
    expect(() => {
      finished.cancel()
      finished.cancel()
    }).not.toThrow()
    expect(successes).toEqual([1])

    // 尝试已启动但尚未 resolve 时 cancel：该尝试 resolve 后**不得**触发 onSuccess（R10）
    let releaseAttempt: (() => void) | null = null
    const inflight: number[] = []
    const running = createReconnectController({
      retries: 3,
      backoffMs: 0,
      sleep: async (): Promise<void> => {},
      attempt: (): Promise<void> =>
        new Promise<void>((resolve) => {
          releaseAttempt = resolve
        }),
      onSuccess: (info): void => void inflight.push(info.attempts)
    })
    running.start()
    expect(await waitFor(() => releaseAttempt !== null)).toBe(true)
    running.cancel()
    releaseAttempt!()
    await new Promise((r) => setTimeout(r, 40))
    expect(inflight).toEqual([])
    expect(running.running).toBe(false)
  })
})

/**
 * 生产壳层（`ipc.ts`）：重连窗口期的对外行为。
 * 这些用例走**真实命名管道 / UDS**，用注入 sleep 精确控制"什么时候尝试重连"。
 */
describe('api.ipc 自动重连（生产壳层）', () => {
  it('重连成功：对端断开后自动连上，onClose 一次 + onReconnect 一次（attempts===1）', async () => {
    sleepGate.mode = 'manual'
    const a = await startPeer('bus')
    expect((await connectBus()).ok).toBe(true)
    expect(await callRequest(EXT, 'bus', 'ping')).toMatchObject({ ok: true, result: 'pong' })
    expect(listExtensionChannels(EXT)).toEqual(['bus'])

    await a.kill()
    const closed = await waitEvent((e) => e.type === 'close' && e.name === 'bus')
    expect(closed.code).toBe('peer-crashed')
    // 窗口期：表项**仍在**（K3：`channels()` 仍含该名字 = 正在重连），但请求立即 not-connected
    expect(listExtensionChannels(EXT)).toEqual(['bus'])
    expect(await callRequest(EXT, 'bus', 'ping')).toMatchObject({
      ok: false,
      code: 'not-connected'
    })
    // 第一次等待用的是声明的 backoffMs
    expect(sleepGate.sleeps).toEqual([250])

    const b = await startPeer('bus')
    sleepGate.release()
    const reconnected = await waitEvent((e) => e.type === 'reconnect' && e.name === 'bus')
    expect(reconnected.attempts).toBe(1)
    // onClose 恰好一次（E1：不二次触发）
    expect(eventsOfType('close')).toHaveLength(1)
    expect(await callRequest(EXT, 'bus', 'ping')).toMatchObject({ ok: true, result: 'pong' })
    expect(b.messages.filter((m) => m.method === 'ping')).toHaveLength(1)
  })

  it('在途请求：断开瞬间以 peer-crashed 失败，且重连后对端没有收到重复请求', async () => {
    sleepGate.mode = 'manual'
    const a = await startPeer('bus', {
      respond: (m) => (m.method === 'slow' ? null : { result: 'pong' })
    })
    expect((await connectBus()).ok).toBe(true)

    const inflight = callRequest(EXT, 'bus', 'slow')
    expect(await waitFor(() => a.messages.some((m) => m.method === 'slow'))).toBe(true)
    await a.kill()
    // 在途请求**立即**以断因码失败（绝不挂到重连后）
    expect(await inflight).toMatchObject({ ok: false, code: 'peer-crashed' })
    await waitEvent((e) => e.type === 'close' && e.name === 'bus')

    const b = await startPeer('bus')
    sleepGate.release()
    await waitEvent((e) => e.type === 'reconnect' && e.name === 'bus')
    expect((await callRequest(EXT, 'bus', 'ping')).result).toBe('pong')

    // **绝不重放**：新对端一条 slow 都没收到；旧对端也只收到过一条
    expect(b.messages.filter((m) => m.method === 'slow')).toHaveLength(0)
    expect(a.messages.filter((m) => m.method === 'slow')).toHaveLength(1)
  })

  it('重连窗口：窗口内 request/notify 立即 not-connected（不排队），channels() 仍含该通道', async () => {
    sleepGate.mode = 'manual'
    const a = await startPeer('bus')
    expect((await connectBus()).ok).toBe(true)
    await a.kill()
    await waitEvent((e) => e.type === 'close' && e.name === 'bus')

    // 断言"立即"：第一次退避**还没放行**（挂起中），请求就已经失败了
    expect(sleepGate.sleeps).toEqual([250])
    expect(sleepGate.pending).toHaveLength(1)

    const requested = await callRequest(EXT, 'bus', 'ping')
    expect(requested).toMatchObject({ ok: false, code: 'not-connected' })
    expect(String(requested.error)).toMatch(/正在重连/)
    const notified = await callNotify(EXT, 'bus', 'tick')
    expect(notified).toMatchObject({ ok: false, code: 'not-connected' })
    // 请求没有等任何一次 sleep 完成，也没有把它消费掉
    expect(sleepGate.pending).toHaveLength(1)
    expect(listExtensionChannels(EXT)).toEqual(['bus'])
  })

  it('上限与放弃：重连连续失败 3 次后停止（等待序列 [250,500,1000]），不再有新调用、无第二次 close', async () => {
    sleepGate.mode = 'manual'
    const a = await startPeer('bus')
    expect((await connectBus()).ok).toBe(true)
    await a.kill()
    await waitEvent((e) => e.type === 'close' && e.name === 'bus')
    expect(sleepGate.sleeps).toEqual([250])

    sleepGate.release() // 第 1 次尝试：端点无人监听 → connect-failed → 继续退避
    expect(await waitFor(() => sleepGate.sleeps.length === 2)).toBe(true)
    expect(sleepGate.sleeps).toEqual([250, 500])
    sleepGate.release()
    expect(await waitFor(() => sleepGate.sleeps.length === 3)).toBe(true)
    expect(sleepGate.sleeps).toEqual([250, 500, 1000])
    sleepGate.release() // 第 3 次尝试仍失败 → 放弃

    expect(await waitFor(() => listExtensionChannels(EXT).length === 0)).toBe(true)
    // E1：放弃时**不**再广播第二次 close
    expect(eventsOfType('close')).toHaveLength(1)
    expect(eventsOfType('reconnect')).toHaveLength(0)
    // 之后不再有任何重连尝试
    await new Promise((r) => setTimeout(r, 120))
    expect(sleepGate.sleeps).toEqual([250, 500, 1000])
    const after = await callRequest(EXT, 'bus', 'ping')
    expect(after).toMatchObject({ ok: false, code: 'not-connected' })
    // "已放弃"与"正在重连"文案可区分（K3）
    expect(String(after.error)).not.toMatch(/正在重连/)
  })

  it('close 期间：close() 后无任何重连尝试、无 onReconnect、无遗留定时器', async () => {
    // 用控制器自带的 setTimeout：下面的 getTimerCount 才有意义
    sleepGate.mode = 'real'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = await startPeer('bus')
    expect((await connectBus()).ok).toBe(true)
    await a.kill()
    await waitEvent((e) => e.type === 'close' && e.name === 'bus')

    // 前置真值：窗口期确实挂着**一个**退避定时器（不是 0，让后面的 0 有意义）
    expect(vi.getTimerCount()).toBe(1)
    await callClose(EXT, 'bus')
    expect(vi.getTimerCount()).toBe(0)
    expect(listExtensionChannels(EXT)).toEqual([])
    // 窗口期没有可 dispose 的传输，但"扩展主动 close() 触发一次 close"是既有语义 → 补发一次
    await waitEvent((e) => e.type === 'close' && e.name === 'bus', 2)
    const closes = eventsOfType('close')
    expect(closes).toHaveLength(2)
    expect(closes[0].code).toBe('peer-crashed')
    expect(closes[1].code).toBe('channel-closed')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(eventsOfType('reconnect')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closeExtensionIpc：重连窗口内立即停止（无遗留定时器、无 onReconnect、额度释放）', async () => {
    sleepGate.mode = 'real'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = await startPeer('bus')
    expect((await connectBus()).ok).toBe(true)
    await a.kill()
    await waitEvent((e) => e.type === 'close' && e.name === 'bus')
    expect(vi.getTimerCount()).toBe(1)

    closeExtensionIpc(EXT)
    expect(vi.getTimerCount()).toBe(0)
    expect(listExtensionChannels(EXT)).toEqual([])
    // 停用时的收尾同样按既有语义发一次 close（窗口期没有传输可 dispose）
    await waitEvent((e) => e.type === 'close' && e.name === 'bus', 2)
    expect(eventsOfType('close').map((e) => e.code)).toEqual(['peer-crashed', 'channel-closed'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(eventsOfType('reconnect')).toHaveLength(0)

    // 收尾后额度确实释放：同名通道可以重新打开并正常收发包
    vi.useRealTimers()
    await startPeer('bus')
    expect((await connectBus()).ok).toBe(true)
    expect((await callRequest(EXT, 'bus', 'ping')).result).toBe('pong')
  })

  it('非法帧：protocol-error 关闭、不重连、无遗留定时器、从注册表移除', async () => {
    sleepGate.mode = 'real'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = await startPeer('bus', { badFrameOn: 'bad' })
    expect((await connectBus()).ok).toBe(true)

    expect(await callRequest(EXT, 'bus', 'bad')).toMatchObject({
      ok: false,
      code: 'protocol-error'
    })
    const closed = await waitEvent((e) => e.type === 'close' && e.name === 'bus')
    expect(closed.code).toBe('protocol-error')
    // 与坏对端无限拉锯的路径必须关闭：不重连、不挂定时器
    expect(vi.getTimerCount()).toBe(0)
    expect(listExtensionChannels(EXT)).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(eventsOfType('reconnect')).toHaveLength(0)
    expect(a.messages).toHaveLength(1)
  })

  it('协议状态：重连后第一条 request 在对端看到 id===1；旧 id 的迟到回包不唤醒新请求', async () => {
    sleepGate.mode = 'manual'
    const a = await startPeer('bus')
    expect((await connectBus()).ok).toBe(true)
    expect((await callRequest(EXT, 'bus', 'ping')).result).toBe('pong')
    expect(a.messages[0].id).toBe(1)

    await a.kill()
    await waitEvent((e) => e.type === 'close' && e.name === 'bus')
    const b = await startPeer('bus', {
      respond: (m) => (m.method === 'ping' ? { result: 'pong' } : null)
    })
    sleepGate.release()
    await waitEvent((e) => e.type === 'reconnect' && e.name === 'bus')

    // 新通道：请求 id 从 1 重新开始（协议层状态全部丢弃）
    expect((await callRequest(EXT, 'bus', 'ping')).result).toBe('pong')
    expect(b.messages[0].id).toBe(1)

    // 新通道上挂一条不回包的请求（id=2），再投一条**旧通道 id=1** 的迟到回包 → 不得唤醒它
    let settled = false
    const pending = callRequest(EXT, 'bus', 'slow', undefined, 200).then((r) => {
      settled = true
      return r
    })
    expect(await waitFor(() => b.messages.some((m) => m.method === 'slow'))).toBe(true)
    b.sendRaw(encodeFrame({ jsonrpc: '2.0', id: 1, result: '迟到的旧回包' }))
    await new Promise((r) => setTimeout(r, 100))
    expect(settled).toBe(false)
    // 它最终以**自己的**超时结束（证明上面那 100ms 里确实没被唤醒）
    expect(await pending).toMatchObject({ ok: false, code: 'timeout' })

    // 客户端通道**没有** connectionId（R8/R17①：连接 ID 只属于服务端接受的连接）
    const busEvents = electronState.events.filter((e) => e.name === 'bus')
    expect(busEvents.length).toBeGreaterThan(0)
    for (const e of busEvents) expect(e.connectionId).toBeUndefined()
  })

  it('attempts 语义：连续失败 2 次后成功 → attempts===3（等待序列 [250,500,1000]）', async () => {
    sleepGate.mode = 'manual'
    const a = await startPeer('bus')
    expect((await connectBus({ retries: 5, backoffMs: 250 })).ok).toBe(true)
    await a.kill()
    await waitEvent((e) => e.type === 'close' && e.name === 'bus')

    sleepGate.release() // 第 1 次：失败
    expect(await waitFor(() => sleepGate.sleeps.length === 2)).toBe(true)
    sleepGate.release() // 第 2 次：仍失败
    expect(await waitFor(() => sleepGate.sleeps.length === 3)).toBe(true)
    await startPeer('bus') // 第 3 次之前对端回来了
    sleepGate.release()
    const reconnected = await waitEvent((e) => e.type === 'reconnect' && e.name === 'bus')
    expect(reconnected.attempts).toBe(3)
    expect(sleepGate.sleeps).toEqual([250, 500, 1000])
  })

  it('禁用：retries:0 等价关闭（断开即移除，无任何重连尝试）', async () => {
    sleepGate.mode = 'manual'
    const a = await startPeer('bus')
    expect((await connectBus({ retries: 0 })).ok).toBe(true)
    await a.kill()
    await waitEvent((e) => e.type === 'close' && e.name === 'bus')
    expect(listExtensionChannels(EXT)).toEqual([])
    expect(sleepGate.sleeps).toEqual([])
    expect(eventsOfType('reconnect')).toHaveLength(0)
    expect(await callRequest(EXT, 'bus', 'ping')).toMatchObject({
      ok: false,
      code: 'not-connected'
    })
  })

  it('回归（R16）：不传 autoReconnect 的通道断开行为与今天一致（close 一次、立即移除、无任何重连）', async () => {
    sleepGate.mode = 'manual'
    const a = await startPeer('bus')
    expect((await callConnect(EXT, { id: 'bus', transport: 'pipe' })).ok).toBe(true)
    await a.kill()
    const closed = await waitEvent((e) => e.type === 'close' && e.name === 'bus')
    expect(closed.code).toBe('peer-crashed')
    expect(eventsOfType('close')).toHaveLength(1)
    expect(listExtensionChannels(EXT)).toEqual([])
    expect(sleepGate.sleeps).toEqual([])
    expect(eventsOfType('reconnect')).toHaveLength(0)
    expect(await callRequest(EXT, 'bus', 'ping')).toMatchObject({
      ok: false,
      code: 'not-connected'
    })
  })

  it('stdio 拒绝：connect(stdio + autoReconnect) → invalid-declaration，且不产生任何重连尝试', async () => {
    const rejected = await callConnect(EXT, {
      id: 'w',
      transport: 'stdio',
      program: 'peer.cjs',
      autoReconnect: {}
    })
    expect(rejected).toMatchObject({ ok: false, code: 'invalid-declaration' })
    expect(String(rejected.error)).toMatch(/^\[invalid-declaration\]/)
    expect(String(rejected.error)).toMatch(/只支持 pipe/)
    expect(sleepGate.sleeps).toEqual([])
    expect(listExtensionChannels(EXT)).toEqual([])

    // 非法策略值也在同一个入口被拒
    const bad = await callConnect(EXT, {
      id: 'w',
      transport: 'pipe',
      autoReconnect: { retries: -1 }
    })
    expect(bad).toMatchObject({ ok: false, code: 'invalid-declaration' })
    expect(listExtensionChannels(EXT)).toEqual([])

    // `listen` 保持 `validateIpcDeclaration`：autoReconnect（哪怕值非法）被白名单剥掉 → 不报错、不重连
    expect(
      (await callListen(EXT, { id: 'svc', transport: 'pipe', autoReconnect: { retries: -1 } })).ok
    ).toBe(true)
    expect(listExtensionChannels(EXT)).toEqual(['svc'])
    expect(sleepGate.sleeps).toEqual([])
    expect(eventsOfType('reconnect')).toHaveLength(0)
  })

  it('封顶与超时：backoffMs 很大时单次等待封顶 30000；请求超时口径不变（30s 默认）', async () => {
    sleepGate.mode = 'manual'
    const a = await startPeer('bus', {
      respond: (m) => (m.method === 'slow' ? null : { result: 'pong' })
    })
    expect((await connectBus({ retries: 2, backoffMs: 20_000 })).ok).toBe(true)

    // 请求超时口径不变（N5）：逐请求覆盖仍然生效
    expect(await callRequest(EXT, 'bus', 'slow', undefined, 80)).toMatchObject({
      ok: false,
      code: 'timeout'
    })
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)

    // 声明里的 20000 合法（不封顶"配置值"），封顶只发生在**单次等待**
    const declaration = validateRuntimeIpcDeclaration({
      id: 'bus',
      transport: 'pipe',
      autoReconnect: { backoffMs: 20_000 }
    })
    expect(declaration.autoReconnect).toEqual({ retries: 3, backoffMs: 20_000 })
    expect(backoffDelayFor({ attempt: 2, backoffMs: 20_000 })).toBe(30_000)
    expect(backoffDelayFor({ attempt: 3, backoffMs: 20_000 })).toBe(30_000)

    await a.kill()
    await waitEvent((e) => e.type === 'close' && e.name === 'bus')
    expect(sleepGate.sleeps).toEqual([20_000])
  })
})
