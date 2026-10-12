/**
 * 「重连尝试**在途**时本通道又断一次」的窗口期竞态测试（issue #44 并发整改 / 阻断-1）。
 *
 * ## 为什么单独一个文件、并且要在传输层留缝隙
 *
 * 真实 I/O 下这个窗口**进不去**：断线通知（`ipc.ts` 的 `handleClientClose`）只能由
 * `attachClientChannel` 注册的 `channel.onClose` 监听器触发，而 `attach` 是 `attempt()` 的
 * 最后一条语句；`onSuccess` 与它在**同一段微任务**里跑完（Node 在每个宏任务回调后抽干微任务
 * 队列），所以任何 I/O 驱动的断线回调到达时，`reconnect.controller` 必然已经是 `null`
 * ——那是**合法的下一个断连周期**。实机探针（对端销毁时机：release 后立即 / 等到连接出现 /
 * accept 即 destroy / accept 后 5ms）全部证实这一点：第二次 close 到达时
 * `entry.state === 'open'` 且 `reconnect.controller === null`。
 *
 * 因此本文件用**假传输**把"本通道在 attempt 在途时又观测到一次 peer-crashed"这一输入
 * **直接投递**进窗口期（`emitPeerCrashFromTest`，见该方法的注释），测的是**状态机对这条输入的
 * 响应**——这是 `epoch` 守卫唯一能被区分的地方。真实 I/O 侧的等价场景（重连刚连上又崩 = 下一个
 * 断连周期）由 `test/ipc-reconnect.test.ts` 的用例覆盖，两者互补。
 *
 * 断言全部是**可观测状态**：控制器创建次数（诊断出口）、事件、表项、被弃传输是否 dispose、
 * 是否真的挂上（`setDefaultHandler` 计数）、以及后续 request 由哪条传输应答。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface IpcEventLike {
  extId: string
  name: string
  type: string
  code?: string
  message?: string
  attempts?: number
}

interface ElectronState {
  userData: string
  events: IpcEventLike[]
  handlers: Map<string, (...args: unknown[]) => unknown>
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

/** 退避等待的注入缝隙（与 `test/ipc-reconnect.test.ts` 同形）：`manual` = 由用例逐次放行 */
interface SleepGate {
  mode: 'auto' | 'manual'
  sleeps: number[]
  pending: Array<() => void>
  release(): void
  reset(): void
}

const sleepGate = vi.hoisted<SleepGate>(() => {
  const gate: SleepGate = {
    mode: 'manual',
    sleeps: [],
    pending: [],
    release: (): void => {
      gate.pending.shift()?.()
    },
    reset: (): void => {
      gate.mode = 'manual'
      gate.sleeps.length = 0
      gate.pending.length = 0
    }
  }
  return gate
})

/** 假传输队列（`vi.mock` 工厂是提升的，因此状态必须走 `vi.hoisted`） */
const fakeQueue = vi.hoisted<{ transports: unknown[] }>(() => ({ transports: [] }))

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
      const sleep = (ms: number): Promise<void> => {
        sleepGate.sleeps.push(ms)
        if (sleepGate.mode === 'auto') return Promise.resolve()
        return new Promise<void>((resolve) => sleepGate.pending.push(resolve))
      }
      return actual.createReconnectController({ ...options, sleep })
    }
  }
})

/**
 * 传输层缝隙：只替换"建传输"这一步，其余（注册表 / 事件 / 控制器 / 退避）都是**生产代码**。
 * 假传输复刻 `openPipeClientTransport` 的关键行为：`dispose()` 会以"无 reason"关通道
 * （因此"主动关闭"与"对端崩"在 `isReconnectableCloseReason` 上可区分）；`request` 的返回值带上
 * 自己的 label，用来证明"最后由哪条传输在服务这条通道"。
 */
vi.mock('../src/main/ipcTransport', () => ({
  openPipeClientTransport: (options: { endpoint: string }): unknown => {
    const next = fakeQueue.transports.shift()
    if (!next) throw new Error(`测试没有预置 transport（endpoint=${options.endpoint}）`)
    return next
  },
  openStdioTransport: (): never => {
    throw new Error('本文件不覆盖 stdio')
  },
  openStreamTransport: (): never => {
    throw new Error('本文件不覆盖 stream')
  },
  resolveProgramInExtension: (_dir: string, program: string): string => program
}))

import {
  closeExtensionIpc,
  listExtensionChannels,
  reconnectControllerCount,
  registerIpcBridge
} from '../src/main/ipc'
import { IpcCoreError } from '../src/main/ipcCore'
import { waitFor } from './helpers/ipcPeers'

const EXT = 'race-ext'

type CloseListener = (err: IpcCoreError | null) => void

/** 假通道：只实现 `ipc.ts` 真正用到的面（onClose / setDefaultHandler / request / notify / close） */
class FakeChannel {
  closed = false
  /** `setDefaultHandler` 被调用过 = 这条传输**真的**被 `attachClientChannel` 挂上了 */
  attached = 0
  requestCount = 0
  private listeners: CloseListener[] = []

  constructor(readonly label: string) {}

  onClose(listener: CloseListener): { dispose(): void } {
    this.listeners.push(listener)
    return {
      dispose: (): void => {
        this.listeners = this.listeners.filter((l) => l !== listener)
      }
    }
  }

  setDefaultHandler(): void {
    this.attached += 1
  }

  /** 复刻 `JsonRpcChannel.close()`：先置 closed，再同步触发监听器（幂等） */
  close(reason?: IpcCoreError | null): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.listeners]) listener(reason ?? null)
  }

  request(method: string): Promise<unknown> {
    this.requestCount += 1
    return Promise.resolve(`pong:${method}@${this.label}`)
  }

  notify(): void {
    this.requestCount += 0
  }

  /**
   * **测试专属注入点**：把"本通道在 attempt 在途时又观测到一次 peer-crashed"直接投给当前
   * 监听器集合。真实传输在 `close()` 后不再重投通知（因此这个窗口在真实 I/O 下不可达，
   * 见文件头）；这里只借它把状态机逼进那个窗口，断言守卫的响应。
   */
  emitPeerCrashFromTest(): void {
    for (const listener of [...this.listeners]) {
      listener(new IpcCoreError('peer-crashed', '对端连接已关闭'))
    }
  }
}

class FakeTransport {
  readonly channel = new FakeChannel(this.label)
  disposeCount = 0
  disposed = false
  /** 被 `createTransport()` 取用（= 这次的 `rebuild()` 真的开始建传输了） */
  requested = false
  private release: (() => void) | null = null
  readonly ready: Promise<void>

  constructor(
    readonly label: string,
    options: { manualReady?: boolean } = {}
  ) {
    this.ready = options.manualReady
      ? new Promise<void>((resolve) => {
          this.release = resolve
        })
      : Promise.resolve()
  }

  /** 放行这次 attempt 的 `await rebuild()`（配合 `manualReady` 把"在途"钉成确定性窗口） */
  releaseReady(): void {
    this.release?.()
  }

  onStderr(): { dispose(): void } {
    return { dispose: (): void => {} }
  }

  onClose(listener: CloseListener): { dispose(): void } {
    return this.channel.onClose(listener)
  }

  dispose(): void {
    this.disposed = true
    this.disposeCount += 1
    this.channel.close()
  }
}

function pushTransport(transport: FakeTransport): FakeTransport {
  fakeQueue.transports.push(transport)
  return transport
}

function bridge(channel: string): (...args: unknown[]) => unknown {
  const fn = electronState.handlers.get(channel)
  if (!fn) throw new Error(`未注册的 handler: ${channel}`)
  return fn
}

async function callConnect(declaration: unknown): Promise<{ ok: boolean; code?: string }> {
  return (await bridge('ipc:connect')({}, EXT, declaration)) as { ok: boolean; code?: string }
}

async function callRequest(
  name: string,
  method: string
): Promise<{ ok: boolean; result?: unknown }> {
  return (await bridge('ipc:request')({}, EXT, name, method)) as { ok: boolean; result?: unknown }
}

function eventsOfType(type: string): IpcEventLike[] {
  return electronState.events.filter((e) => e.extId === EXT && e.type === type)
}

let workDir = ''

beforeEach(async () => {
  sleepGate.reset()
  fakeQueue.transports.length = 0
  workDir = await fs.mkdtemp(join(tmpdir(), 'obox-ipc-race-'))
  electronState.userData = workDir
  electronState.events.length = 0
  electronState.waiters.length = 0
  electronState.handlers.clear()
  await fs.mkdir(join(workDir, 'ipc'), { recursive: true })
  registerIpcBridge()
})

afterEach(async () => {
  closeExtensionIpc(EXT)
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 })
})

describe('重连尝试在途时的第二次断线（窗口期竞态）', () => {
  it('在途 attempt 过期自弃：不挂传输、不触发事件、不新建控制器，交回同一控制器重试成功', async () => {
    const t1 = pushTransport(new FakeTransport('t1'))
    expect(
      await callConnect({
        id: 'bus',
        transport: 'pipe',
        autoReconnect: { retries: 3, backoffMs: 250 }
      })
    ).toMatchObject({ ok: true })
    // 前置真值：首连真的挂上了 t1，且此时**没有**任何控制器（首连成功不挂控制器，R4）
    expect(t1.channel.attached).toBe(1)
    expect(listExtensionChannels(EXT)).toEqual(['bus'])
    expect(reconnectControllerCount()).toBe(0)

    // ① 第 1 次断线：进入窗口期 → 恰好一次 close + 恰好一个控制器（等待 250ms）
    t1.channel.close(new IpcCoreError('peer-crashed', '对端连接已关闭'))
    expect(eventsOfType('close').map((e) => e.code)).toEqual(['peer-crashed'])
    expect(reconnectControllerCount()).toBe(1)
    expect(sleepGate.sleeps).toEqual([250])
    expect(listExtensionChannels(EXT)).toEqual(['bus'])

    // ② 放行退避 → 第 1 次 attempt 开始；`rebuild()` 挂在**手工挡住**的 ready 上，
    //    于是"attempt 在途"是一个确定性窗口（不靠抢时序）
    const t2 = pushTransport(new FakeTransport('t2', { manualReady: true }))
    sleepGate.release()
    expect(
      await waitFor(() => fakeQueue.transports.length === 0 && sleepGate.pending.length === 0)
    ).toBe(true)

    // ③ 就在这条 attempt 在途时，本通道又观测到一次 peer-crashed
    t1.channel.emitPeerCrashFromTest()

    // 断言 1：**没有**新建控制器（同一通道同一时刻最多一个控制器在跑）
    expect(reconnectControllerCount()).toBe(1)
    // 断言 2：**不**重复广播 close（本断连周期已经广播过一次；R7 "每周期恰好一次"）
    expect(eventsOfType('close')).toHaveLength(1)
    // 断言 3：表项仍在重连窗口里（K3），重连链没有断
    expect(listExtensionChannels(EXT)).toEqual(['bus'])

    // ④ 放行这条"过期"的传输：attempt 必须自弃——不挂传输、不报成功，并继续退避
    t2.releaseReady()
    // 抽干 attempt 的微任务（rebuild 放行 → 守卫 → 自弃 → 控制器继续退避），再断言
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(t2.channel.attached).toBe(0) // 没被挂上（`attachClientChannel` 从未碰它）
    expect(t2.disposeCount).toBe(1) // 也没被泄漏：建出来就 dispose 掉了
    expect(t2.channel.requestCount).toBe(0)
    expect(eventsOfType('reconnect')).toHaveLength(0)
    expect(reconnectControllerCount()).toBe(1)
    expect(sleepGate.sleeps).toEqual([250, 500])

    // ⑤ 第 2 次 attempt（**同一个**控制器）：代次已一致 → 正常挂载并报成功（attempts === 2）
    const t3 = pushTransport(new FakeTransport('t3'))
    sleepGate.release()
    expect(await waitFor(() => eventsOfType('reconnect').length === 1)).toBe(true)
    expect(eventsOfType('reconnect')[0]).toMatchObject({ name: 'bus', attempts: 2 })
    expect(t3.channel.attached).toBe(1)
    expect(reconnectControllerCount()).toBe(1)
    expect(eventsOfType('close')).toHaveLength(1)
    expect(await callRequest('bus', 'ping')).toMatchObject({ ok: true, result: 'pong:ping@t3' })
    expect(t3.channel.requestCount).toBe(1)
    expect(t2.channel.requestCount).toBe(0)

    // ⑥ 重连**成功之后**再崩 = 合法的下一个断连周期：这次才该有第 2 次 close + 第 2 个控制器
    t3.channel.close(new IpcCoreError('peer-crashed', '对端连接已关闭'))
    expect(eventsOfType('close').map((e) => e.code)).toEqual(['peer-crashed', 'peer-crashed'])
    expect(reconnectControllerCount()).toBe(2)
    expect(sleepGate.sleeps).toEqual([250, 500, 250])

    // ⑦ 这个控制器**可取消**（旧实现里 `onSuccess` 无条件置空 `controller`，会让并存的另一个
    //    控制器永久不可 cancel）：close() 之后即使放行挂起的等待，也不得再挂载/触发事件
    const t4 = pushTransport(new FakeTransport('t4'))
    await bridge('ipc:close')({}, EXT, 'bus')
    expect(listExtensionChannels(EXT)).toEqual([])
    sleepGate.release()
    await new Promise((r) => setTimeout(r, 30))
    expect(t4.channel.attached).toBe(0)
    expect(eventsOfType('reconnect')).toHaveLength(1)
    expect(eventsOfType('close').map((e) => e.code)).toEqual([
      'peer-crashed',
      'peer-crashed',
      'channel-closed'
    ])
  })
})
