/**
 * EH-A2 · 扩展宿主启动器单测。
 *
 * 判据来自 `docs/adr/0026-extension-host-process.md` 决策 2/7 与 `docs/extension-host-migration.md`
 * 的 EH-A2 行：fork 参数、ready→init→initialized 握手、握手超时、崩溃计数（5 分钟 3 次）、
 * <3 次自动重启、达阈值不重启、3 秒 ack 判活（只观测）、终止先 kill 后宽限强杀、退出清理幂等、
 * stdout/stderr 转发。
 *
 * **完全不起进程**：`utilityProcess` / `MessageChannelMain` / `webContents` / 定时器全部注入假实现
 * （`vi.mock('electron')` 只是为了让模块顶层的 import 不炸，以及记录 `eh:get-port` 的注册）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, vi } from 'vitest'
import {
  ACK_TIMEOUT_MS,
  EH_ERROR_TEXT,
  PROTOCOL_VERSION,
  TERMINATE_GRACE_MS,
  createActivateEnvelope,
  createInitializedEnvelope,
  createLogEnvelope,
  createReadyEnvelope,
  createResponseEnvelope,
  type Envelope
} from '../src/shared/extensionHostProtocol'

/* -------------------------------------------------------------------------------------------- */
/* Electron 假实现（模块顶层 import 的落地处；本文件的用例都不走真 API）                          */
/* -------------------------------------------------------------------------------------------- */

const electronMock = vi.hoisted(() => {
  const ipcHandlers = new Map<string, () => unknown>()
  return {
    ipcHandlers,
    ipcMain: {
      handle: (channel: string, handler: () => unknown): void => {
        // 真 Electron 重复注册同一 channel 会抛错，假的也抛，才能测出"注册只做一次"
        if (ipcHandlers.has(channel)) throw new Error(`重复注册 ipcMain.handle('${channel}')`)
        ipcHandlers.set(channel, handler)
      },
      removeHandler: (channel: string): void => {
        ipcHandlers.delete(channel)
      }
    },
    // 下面这些只是 src/main/window.ts 与 tray.ts 的顶层 import 需要，本测试不会调用
    app: { getName: (): string => 'obox', getPath: (): string => 'C:\\userData' },
    BrowserWindow: class {},
    Tray: class {},
    Menu: {},
    nativeImage: {},
    utilityProcess: {
      fork: (): never => {
        throw new Error('单测必须注入假 utilityProcess：不允许真的 fork 宿主')
      }
    },
    MessageChannelMain: class {}
  }
})

vi.mock('electron', () => electronMock)
// 启动器经 src/main/window.ts 间接依赖它（取主窗口的 webContents）；这个包在 node_modules 里会被
// vitest 外部化、走原生 ESM 加载，于是 `vi.mock('electron')` 管不到它——必须单独挡掉。
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import {
  ACK_PING_INTERVAL_MS,
  CRASH_LIMIT,
  CRASH_WINDOW_MS,
  DEFAULT_HOST_API_VERSION,
  EH_DATA_DIR_ENV,
  EXIT_CODE_FORK_FAILED,
  EXIT_CODE_HANDSHAKE_TIMEOUT,
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_METHOD,
  HOST_SERVICE_NAME,
  RENDERER_PORT_CHANNEL,
  RENDERER_PORT_IPC,
  RENDERER_READY_RETRY_MS,
  RESTART_DELAY_MS,
  createExtensionHostStarter,
  describeExtensionHostCrash,
  type ExtensionHostForkOptions,
  type ExtensionHostPhase,
  type ExtensionHostPortLike,
  type ExtensionHostProcessLike,
  type ExtensionHostStarter,
  type ExtensionHostStarterOptions,
  type ExtensionHostStatus,
  type ExtensionHostTimers
} from '../src/main/extensionHostStarter'

/* -------------------------------------------------------------------------------------------- */
/* 可控时钟                                                                                      */
/* -------------------------------------------------------------------------------------------- */

interface FakeTimers extends ExtensionHostTimers {
  /** 推进时钟并依次触发到期定时器（每个之间让出一次微任务，便于 promise 结算） */
  advance(ms: number): Promise<void>
  /** 只推进时钟（同步位移所有未触发的定时器），用于跨越 5 分钟崩溃窗口 */
  skip(ms: number): void
  pending(): number
}

function createFakeTimers(start = 1_700_000_000_000): FakeTimers {
  let now = start
  let seq = 0
  const entries = new Map<number, { id: number; at: number; callback: () => void }>()

  return {
    now: (): number => now,
    setTimeout: (callback: () => void, ms: number): unknown => {
      seq += 1
      entries.set(seq, { id: seq, at: now + Math.max(0, ms), callback })
      return seq
    },
    clearTimeout: (handle: unknown): void => {
      if (typeof handle === 'number') entries.delete(handle)
    },
    async advance(ms: number): Promise<void> {
      const target = now + ms
      for (;;) {
        const due = [...entries.values()]
          .filter((entry) => entry.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        entries.delete(due.id)
        now = due.at
        due.callback()
        await Promise.resolve()
      }
      now = target
    },
    skip(ms: number): void {
      now += ms
      for (const entry of entries.values()) entry.at += ms
    },
    pending: (): number => entries.size
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 假宿主进程 / 假端口 / 假窗口                                                                   */
/* -------------------------------------------------------------------------------------------- */

interface FakeStream {
  emit(chunk: unknown): void
}

interface FakeChild {
  handle: ExtensionHostProcessLike
  /** 启动器发给宿主的信封 */
  messages: Envelope[]
  /** 每个信封对应的 transfer 列表（与 messages 同下标，没有就是空数组） */
  transfers: unknown[][]
  stdout: FakeStream
  stderr: FakeStream
  killCalls: number
  emitMessage(message: unknown): void
  emitExit(code: number): void
}

function createFakeChild(options: { pid: number; timeline: string[] }): FakeChild {
  const messageListeners: ((message: unknown) => void)[] = []
  const exitListeners: ((code: number) => void)[] = []
  const streams = {
    stdout: [] as ((chunk: unknown) => void)[],
    stderr: [] as ((chunk: unknown) => void)[]
  }
  const child: FakeChild = {
    handle: undefined as unknown as ExtensionHostProcessLike,
    messages: [],
    transfers: [],
    stdout: {
      emit: (chunk): void => {
        for (const listener of streams.stdout) listener(chunk)
      }
    },
    stderr: {
      emit: (chunk): void => {
        for (const listener of streams.stderr) listener(chunk)
      }
    },
    killCalls: 0,
    emitMessage: (message): void => {
      for (const listener of [...messageListeners]) listener(message)
    },
    emitExit: (code): void => {
      for (const listener of [...exitListeners]) listener(code)
    }
  }
  child.handle = {
    pid: options.pid,
    stdout: {
      on: (_event, listener): void => {
        streams.stdout.push(listener)
      }
    },
    stderr: {
      on: (_event, listener): void => {
        streams.stderr.push(listener)
      }
    },
    on: (event: 'message' | 'exit', listener: (...args: never[]) => void): void => {
      if (event === 'message') messageListeners.push(listener as (message: unknown) => void)
      else exitListeners.push(listener as (code: number) => void)
    },
    postMessage: (message, transfer): void => {
      child.messages.push(message as Envelope)
      child.transfers.push(transfer === undefined ? [] : [...transfer])
    },
    kill: (): boolean => {
      child.killCalls += 1
      options.timeline.push('kill')
      return true
    }
  } as ExtensionHostProcessLike
  return child
}

interface FakePort extends ExtensionHostPortLike {
  readonly name: string
  readonly posted: unknown[]
  closeCalls: number
}

function createFakePort(name: string): FakePort {
  const port: FakePort = {
    name,
    posted: [],
    closeCalls: 0,
    postMessage: (message): void => {
      port.posted.push(message)
    },
    close: (): void => {
      port.closeCalls += 1
    }
  }
  return port
}

interface FakeRendererTarget {
  posts: { channel: string; payload: unknown; transfer: unknown[] }[]
  postMessage(channel: string, message: unknown, transfer: unknown[]): void
  isDestroyed(): boolean
}

function createFakeRendererTarget(): FakeRendererTarget {
  const target: FakeRendererTarget = {
    posts: [],
    postMessage: (channel, message, transfer): void => {
      target.posts.push({ channel, payload: message, transfer })
    },
    isDestroyed: (): boolean => false
  }
  return target
}

interface FakeWindow {
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): void
  emitClosed(): void
  closedListenerCount(): number
}

function createFakeWindow(): FakeWindow {
  const listeners: (() => void)[] = []
  return {
    isDestroyed: (): boolean => false,
    once: (_event, listener): void => {
      listeners.push(listener)
    },
    emitClosed: (): void => {
      for (const listener of [...listeners]) listener()
    },
    closedListenerCount: (): number => listeners.length
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 组装：全部依赖注入，不起任何进程                                                                */
/* -------------------------------------------------------------------------------------------- */

interface Harness {
  starter: ExtensionHostStarter
  timers: FakeTimers
  children: FakeChild[]
  channels: { port1: FakePort; port2: FakePort }[]
  logs: { level: string; message: string }[]
  forkCalls: { entryPoint: string; args: string[]; options: ExtensionHostForkOptions }[]
  forceKills: number[]
  timeline: string[]
  renderer: FakeRendererTarget | null
  /** 下一次 fork 抛错（测"入口无法拉起"） */
  failFork: Error | null
  statuses: ExtensionHostStatus[]
}

function createHarness(overrides: Partial<ExtensionHostStarterOptions> = {}): Harness {
  electronMock.ipcHandlers.clear()
  const timers = createFakeTimers()
  const harness: Harness = {
    starter: undefined as unknown as ExtensionHostStarter,
    timers,
    children: [],
    channels: [],
    logs: [],
    forkCalls: [],
    forceKills: [],
    timeline: [],
    renderer: null,
    failFork: null,
    statuses: []
  }

  harness.starter = createExtensionHostStarter({
    entryPoint: 'C:\\app\\out\\main\\extension-host.js',
    dataDir: 'C:\\userData',
    ...overrides,
    deps: {
      timers,
      fork: (entryPoint, args, options): ExtensionHostProcessLike => {
        harness.forkCalls.push({ entryPoint, args, options })
        if (harness.failFork) throw harness.failFork
        const child = createFakeChild({
          pid: 4000 + harness.children.length,
          timeline: harness.timeline
        })
        harness.children.push(child)
        return child.handle
      },
      createMessageChannel: () => {
        const channel = { port1: createFakePort('port1'), port2: createFakePort('port2') }
        harness.channels.push(channel)
        return channel
      },
      getRendererTarget: () => harness.renderer,
      forceKill: (pid): void => {
        harness.forceKills.push(pid)
        harness.timeline.push(`force:${pid}`)
      },
      logger: {
        debug: (message): void => {
          harness.logs.push({ level: 'debug', message })
        },
        info: (message): void => {
          harness.logs.push({ level: 'info', message })
        },
        warn: (message): void => {
          harness.logs.push({ level: 'warn', message })
        },
        error: (message): void => {
          harness.logs.push({ level: 'error', message })
        }
      },
      ...overrides.deps
    }
  })
  harness.starter.onStatus((status) => harness.statuses.push(status))
  return harness
}

function lastChild(harness: Harness): FakeChild {
  const child = harness.children[harness.children.length - 1]
  assert.ok(child, '还没有任何 fork')
  return child
}

/** fork 之后立刻完成握手（ready → init → initialized） */
function handshake(harness: Harness, hostId = 'host-1'): FakeChild {
  const child = lastChild(harness)
  child.emitMessage(createReadyEnvelope(hostId, child.handle.pid ?? 4000))
  child.emitMessage(createInitializedEnvelope())
  return child
}

function phaseOf(harness: Harness): ExtensionHostPhase {
  return harness.starter.getStatus().phase
}

function logMessages(harness: Harness, level?: string): string[] {
  return harness.logs
    .filter((entry) => level === undefined || entry.level === level)
    .map((entry) => entry.message)
}

/* -------------------------------------------------------------------------------------------- */
/* 1. fork 参数                                                                                   */
/* -------------------------------------------------------------------------------------------- */

test('fork：入口/args 由调用方传入，stdio=pipe、serviceName=extension-host，并注入 EH_DATA_DIR', () => {
  const harness = createHarness({
    entryPoint: 'C:\\repo\\out\\main\\extension-host.js',
    args: ['--inspect=9339'],
    dataDir: 'C:\\Users\\me\\AppData\\Roaming\\obox',
    env: { OBOX_TEST_FLAG: '1' }
  })

  void harness.starter.start()

  assert.equal(harness.forkCalls.length, 1)
  const call = harness.forkCalls[0]
  assert.equal(call.entryPoint, 'C:\\repo\\out\\main\\extension-host.js')
  assert.deepEqual(call.args, ['--inspect=9339'])
  assert.equal(call.options.stdio, 'pipe', 'stdio 必须是 pipe 才能转发 stdout/stderr')
  assert.equal(call.options.serviceName, 'extension-host')
  assert.equal(call.options.serviceName, HOST_SERVICE_NAME)
  assert.equal(call.options.env[EH_DATA_DIR_ENV], 'C:\\Users\\me\\AppData\\Roaming\\obox')
  assert.equal(call.options.env.OBOX_TEST_FLAG, '1')
  assert.equal(phaseOf(harness), 'starting')
})

test('fork 同步抛错：不抛未捕获异常，返回结构化失败并记合成退出码', async () => {
  const harness = createHarness()
  harness.failFork = new Error('entry not found')

  const result = await harness.starter.start()

  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'EH_INTERNAL')
  assert.match(result.ok === false ? (result.detail ?? '') : '', /entry not found/)
  assert.equal(phaseOf(harness), 'crashed')
  const status = harness.starter.getStatus()
  assert.equal(status.lastCrash?.code, EXIT_CODE_FORK_FAILED)
  assert.match(describeExtensionHostCrash(status.lastCrash!), /入口无法拉起/)
})

/* -------------------------------------------------------------------------------------------- */
/* 2. 握手 ready → init → initialized                                                            */
/* -------------------------------------------------------------------------------------------- */

test('握手：ready 之后回 init（apiVersion/dataDir/extensions），port1 走 transfer；initialized 才算就绪', async () => {
  const harness = createHarness({ dataDir: 'C:\\userData' })
  const pending = harness.starter.start()
  const child = lastChild(harness)

  child.emitMessage(createReadyEnvelope('host-42', 4321))

  // 收到 ready 前不该发任何东西
  assert.equal(child.messages.length, 1)
  assert.deepEqual(child.messages[0], {
    v: PROTOCOL_VERSION,
    t: 'init',
    apiVersion: DEFAULT_HOST_API_VERSION,
    dataDir: 'C:\\userData',
    extensions: []
  })
  assert.equal(child.transfers[0].length, 1, 'init 必须把 host-renderer 的 port1 转移给宿主')
  assert.equal(child.transfers[0][0], harness.channels[0].port1)
  // 端口不能塞进信封字段（信封字段是封闭集合）
  assert.deepEqual(Object.keys(child.messages[0]).sort(), [
    'apiVersion',
    'dataDir',
    'extensions',
    't',
    'v'
  ])

  assert.equal(phaseOf(harness), 'starting', 'initialized 之前不算就绪')
  child.emitMessage(createInitializedEnvelope())
  const result = await pending

  assert.deepEqual(result, { ok: true, hostId: 'host-42', pid: 4321 })
  const status = harness.starter.getStatus()
  assert.equal(status.phase, 'ready')
  assert.equal(status.hostId, 'host-42')
  assert.equal(status.pid, 4321)
  assert.equal(status.crashCount, 0)
  assert.equal(status.lastCrash, null)
  assert.notEqual(status.lastAckAt, null)
})

test('握手：畸形信封被忽略且留痕，不会当成 ready/initialized', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  const child = lastChild(harness)

  child.emitMessage({ v: 999, t: 'ready', hostId: 'x', pid: 1 })
  child.emitMessage({ v: PROTOCOL_VERSION, t: 'initialized' })
  child.emitMessage('这不是信封')

  assert.equal(child.messages.length, 0, '畸形 ready 不该触发 init')
  assert.equal(phaseOf(harness), 'starting')
  assert.ok(logMessages(harness, 'warn').some((message) => message.includes('畸形信封')))

  // 正常握手仍能完成
  child.emitMessage(createReadyEnvelope('host-1', 4321))
  child.emitMessage(createInitializedEnvelope())
  assert.equal((await pending).ok, true)
})

test('握手超时：返回结构化 EH_TIMEOUT（不抛），标记 crashed 并收回进程', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()

  await harness.timers.advance(HANDSHAKE_TIMEOUT_MS)
  const result = await pending

  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'EH_TIMEOUT')
  assert.equal(result.ok === false && result.message, EH_ERROR_TEXT.EH_TIMEOUT)
  assert.match(result.ok === false ? (result.detail ?? '') : '', /ready/)

  const status = harness.starter.getStatus()
  assert.equal(status.phase, 'crashed')
  assert.equal(status.lastCrash?.code, EXIT_CODE_HANDSHAKE_TIMEOUT)
  assert.equal(lastChild(harness).killCalls, 1, '握手失败的进程不能留着')
  assert.deepEqual(harness.forceKills, [], '宽限期没到不该强杀')
})

test('握手超时（已发 init、等 initialized）：detail 指向 initialized', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  lastChild(harness).emitMessage(createReadyEnvelope('host-1', 4321))

  await harness.timers.advance(HANDSHAKE_TIMEOUT_MS)
  const result = await pending

  assert.equal(result.ok, false)
  assert.match(result.ok === false ? (result.detail ?? '') : '', /initialized/)
})

/* -------------------------------------------------------------------------------------------- */
/* 3. 崩溃计数与自动重启                                                                          */
/* -------------------------------------------------------------------------------------------- */

test('exit：记录 {code, at} 并按 5 分钟窗口计数，<3 次自动重启', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  const child = handshake(harness)
  await pending

  const crashedAt = harness.timers.now()
  child.emitExit(7)

  let status = harness.starter.getStatus()
  assert.equal(status.crashCount, 1)
  assert.deepEqual(status.lastCrash, { code: 7, at: crashedAt })
  assert.match(describeExtensionHostCrash(status.lastCrash!), /退出码 7/)
  assert.equal(status.pid, null, '进程已死，pid 要清掉')
  assert.equal(harness.forkCalls.length, 1, '重启前应先等 RESTART_DELAY_MS')

  await harness.timers.advance(RESTART_DELAY_MS)
  assert.equal(harness.forkCalls.length, 2, '第 2 次 fork 应已发生')

  const restarted = lastChild(harness)
  restarted.emitMessage(createReadyEnvelope('host-2', restarted.handle.pid ?? 4001))
  restarted.emitMessage(createInitializedEnvelope())
  status = harness.starter.getStatus()
  assert.equal(status.phase, 'ready')
  assert.equal(status.hostId, 'host-2')
  assert.equal(status.crashCount, 1, '重启成功不清空窗口内的崩溃计数')
})

test(`达阈值（${CRASH_LIMIT} 次）：不重启、状态 crashed、最近崩溃原因可读`, async () => {
  const harness = createHarness()
  const first = harness.starter.start()
  handshake(harness, 'host-1')
  await first

  for (let index = 1; index < CRASH_LIMIT; index++) {
    lastChild(harness).emitExit(index)
    await harness.timers.advance(RESTART_DELAY_MS)
    handshake(harness, `host-${index + 1}`)
  }
  assert.equal(harness.forkCalls.length, CRASH_LIMIT)

  // 第 3 次崩溃：不再重启
  const crashedAt = harness.timers.now()
  lastChild(harness).emitExit(9)
  await harness.timers.advance(RESTART_DELAY_MS * 4)

  const status = harness.starter.getStatus()
  assert.equal(status.phase, 'crashed')
  assert.equal(status.crashCount, CRASH_LIMIT)
  assert.deepEqual(status.lastCrash, { code: 9, at: crashedAt })
  assert.equal(harness.forkCalls.length, CRASH_LIMIT, '达阈值后不得再 fork')
  assert.ok(
    harness.statuses.some((snapshot) => snapshot.phase === 'crashed'),
    '上层要能从 onStatus 里看到 crashed'
  )
  assert.ok(
    logMessages(harness, 'error').some((message) => message.includes('不再自动重启')),
    '达阈值必须留下 error 日志'
  )
})

test('达阈值后手动 start()：重置 5 分钟预算再试一次（弹窗的"重启宿主"）', async () => {
  const harness = createHarness()
  const first = harness.starter.start()
  handshake(harness, 'host-1')
  await first

  for (let index = 0; index < CRASH_LIMIT; index++) {
    lastChild(harness).emitExit(1)
    await harness.timers.advance(RESTART_DELAY_MS)
    if (index < CRASH_LIMIT - 1) handshake(harness, `host-${index + 2}`)
  }
  assert.equal(phaseOf(harness), 'crashed')

  const retry = harness.starter.start()
  assert.equal(harness.forkCalls.length, CRASH_LIMIT + 1, '手动重试应重新 fork')
  handshake(harness, 'host-retry')
  assert.equal((await retry).ok, true)
  assert.equal(harness.starter.getStatus().crashCount, 0)
})

test('崩溃窗口滑动：5 分钟之前的崩溃不计入阈值', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  handshake(harness, 'host-1')
  await pending

  lastChild(harness).emitExit(1)
  await harness.timers.advance(RESTART_DELAY_MS)
  handshake(harness, 'host-2')
  assert.equal(harness.starter.getStatus().crashCount, 1)

  // 纯时间旅行：旧的那次崩溃滑出 5 分钟窗口
  harness.timers.skip(CRASH_WINDOW_MS + 1000)
  lastChild(harness).emitExit(1)

  assert.equal(harness.starter.getStatus().crashCount, 1, '只应保留窗口内的这一次')
  assert.equal(phaseOf(harness), 'starting', '窗口内只有 1 次，仍应自动重启')
})

test('启动过程中的崩溃同样计数并重启：start() 的 promise 等重启后的握手', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()

  lastChild(harness).emitExit(3)
  assert.equal(harness.starter.getStatus().crashCount, 1)

  await harness.timers.advance(RESTART_DELAY_MS)
  assert.equal(harness.forkCalls.length, 2)
  assert.equal(phaseOf(harness), 'starting')

  // 重启后的握手会把最初那个 start() 的 promise 结掉
  handshake(harness, 'host-restarted')
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.ok === true ? result.hostId : '', 'host-restarted')
})

/* -------------------------------------------------------------------------------------------- */
/* 4. 判活：3 秒无 ack 只观测                                                                    */
/* -------------------------------------------------------------------------------------------- */

test('ack 超时：标记 unresponsive、不 kill、不重启；迟到的 ack 能恢复 ready', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  const child = handshake(harness)
  await pending

  await harness.timers.advance(ACK_PING_INTERVAL_MS)
  const ping = child.messages.find((envelope) => envelope.t === 'req')
  assert.ok(ping, '应该发出一次判活请求')
  assert.equal(ping.t === 'req' ? ping.method : '', HEARTBEAT_METHOD)

  await harness.timers.advance(ACK_TIMEOUT_MS)
  assert.equal(phaseOf(harness), 'unresponsive')
  assert.equal(child.killCalls, 0, '只观测：不许杀进程')
  assert.equal(harness.forkCalls.length, 1, '只观测：不许重启')
  assert.ok(
    logMessages(harness, 'warn').some((message) => message.includes('标记无响应')),
    '必须留下可观测的日志'
  )

  // 迟到的 ack：恢复 ready，并重新开始判活
  child.emitMessage(createResponseEnvelope(ping.t === 'req' ? ping.id : 1, null))
  assert.equal(phaseOf(harness), 'ready')
  assert.ok(logMessages(harness, 'info').some((message) => message.includes('恢复响应')))
})

test('收到 ack 就不会被判无响应', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  const child = handshake(harness)
  await pending

  for (let round = 0; round < 3; round++) {
    await harness.timers.advance(ACK_PING_INTERVAL_MS)
    const pings = child.messages.filter((envelope) => envelope.t === 'req')
    const ping = pings[pings.length - 1]
    assert.ok(ping && ping.t === 'req')
    child.emitMessage(createResponseEnvelope(ping.t === 'req' ? ping.id : 1, null))
    assert.equal(phaseOf(harness), 'ready')
  }
})

/* -------------------------------------------------------------------------------------------- */
/* 5. 终止：先 kill、宽限后强杀                                                                   */
/* -------------------------------------------------------------------------------------------- */

test('stop()：先发 terminate + kill，宽限 TERMINATE_GRACE_MS 后仍不退出就强杀', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  const child = handshake(harness)
  await pending

  const stopping = harness.starter.stop()

  const terminate = child.messages.find((envelope) => envelope.t === 'terminate')
  assert.ok(terminate, '先礼：必须发 terminate 信封让宿主自己清理')
  assert.equal(terminate.t === 'terminate' ? terminate.graceMs : -1, TERMINATE_GRACE_MS)
  assert.equal(child.killCalls, 1, '后兵：立刻 kill()')
  assert.deepEqual(harness.forceKills, [], '宽限期内不许强杀')

  // 宿主没在宽限期内退出
  await harness.timers.advance(TERMINATE_GRACE_MS)
  await stopping

  assert.deepEqual(harness.forceKills, [child.handle.pid ?? 4000], '宽限到期按 pid 强杀')
  assert.deepEqual(harness.timeline, ['kill', `force:${child.handle.pid ?? 4000}`])
  assert.equal(phaseOf(harness), 'stopped')
})

test('stop()：宿主收到 terminate 自行退出时立即收尾，不再强杀', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  const child = handshake(harness)
  await pending

  const stopping = harness.starter.stop()
  child.emitExit(0)
  await stopping
  await harness.timers.advance(TERMINATE_GRACE_MS * 2)

  assert.deepEqual(harness.forceKills, [], '优雅退出不该再强杀')
  assert.equal(phaseOf(harness), 'stopped')
  assert.equal(harness.starter.getStatus().crashCount, 0, '主动停止不算崩溃')
})

test('握手途中 stop()：start() 以 EH_CANCELLED 结束，不留下永远挂起的 promise', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  const child = lastChild(harness)

  const stopping = harness.starter.stop()
  child.emitExit(0)
  await stopping

  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'EH_CANCELLED')
  assert.equal(harness.starter.getStatus().crashCount, 0, '取消不算崩溃')
})

test('主窗口 closed：扩展宿主随之终止（ADR-0026 同生共死）', async () => {
  const harness = createHarness()
  const window = createFakeWindow()
  harness.starter.bindWindow(window)
  const pending = harness.starter.start()
  const child = handshake(harness)
  await pending

  assert.equal(window.closedListenerCount(), 1)
  window.emitClosed()

  assert.equal(child.killCalls, 1)
  assert.ok(child.messages.some((envelope) => envelope.t === 'terminate'))
})

/* -------------------------------------------------------------------------------------------- */
/* 6. 退出清理幂等                                                                                */
/* -------------------------------------------------------------------------------------------- */

test('dispose()：清理幂等（只 kill 一次、注销 eh:get-port、状态 stopped）', async () => {
  const harness = createHarness()
  harness.starter.registerIpc()
  assert.ok(electronMock.ipcHandlers.has(RENDERER_PORT_IPC))

  const pending = harness.starter.start()
  const child = handshake(harness)
  await pending

  const first = harness.starter.dispose()
  child.emitExit(0)
  await first

  const second = harness.starter.dispose()
  await second

  assert.equal(child.killCalls, 1, '重复 dispose 不该再 kill')
  assert.equal(electronMock.ipcHandlers.has(RENDERER_PORT_IPC), false, 'IPC 要注销')
  assert.equal(phaseOf(harness), 'stopped')
  // 已释放后 start() 直接回结构化失败，不会重新拉起宿主
  const result = await harness.starter.start()
  assert.equal(result.ok, false)
  assert.equal(harness.forkCalls.length, 1)
})

test('dispose() 在没有启动过宿主时也安全（纯清理）', async () => {
  const harness = createHarness()
  await harness.starter.dispose()
  await harness.starter.dispose()
  assert.equal(harness.forkCalls.length, 0)
  assert.deepEqual(harness.forceKills, [])
})

/* -------------------------------------------------------------------------------------------- */
/* 7. stdout / stderr 转发                                                                       */
/* -------------------------------------------------------------------------------------------- */

test('stdout/stderr 转发到主进程日志（info/warn，带 [host:*] 前缀）', () => {
  const harness = createHarness()
  void harness.starter.start()
  const child = lastChild(harness)

  child.stdout.emit('扩展宿主已启动\n')
  child.stderr.emit(Buffer.from('警告：读清单失败'))

  assert.ok(logMessages(harness, 'info').includes('[host:stdout] 扩展宿主已启动'))
  assert.ok(logMessages(harness, 'warn').includes('[host:stderr] 警告：读清单失败'))
})

/* -------------------------------------------------------------------------------------------- */
/* 8. 两条通道：host-main 直连；host-renderer 端口排队后经 postMessage 转移                        */
/* -------------------------------------------------------------------------------------------- */

test('host-main：宿主发来的信封透传给订阅者，log 顺带进主进程日志', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  const child = handshake(harness)
  await pending

  const received: Envelope[] = []
  const off = harness.starter.onEnvelope((envelope) => received.push(envelope))
  child.emitMessage(createLogEnvelope('warn', '扩展 pet 激活失败'))

  assert.equal(received.length, 1)
  assert.equal(received[0].t, 'log')
  assert.ok(logMessages(harness, 'warn').includes('[host] 扩展 pet 激活失败'))

  off()
  child.emitMessage(createLogEnvelope('info', '再发一条'))
  assert.equal(received.length, 1, '退订后不再收到')
})

test('host-main：send() 走 utilityProcess.postMessage，畸形信封被拒（不抛）', async () => {
  const harness = createHarness()
  const pending = harness.starter.start()
  const child = handshake(harness)
  await pending

  assert.equal(harness.starter.send(createActivateEnvelope('pet', '*')), true)
  assert.deepEqual(child.messages[child.messages.length - 1], {
    v: PROTOCOL_VERSION,
    t: 'activate',
    extId: 'pet',
    reason: '*'
  })

  const malformed = { v: PROTOCOL_VERSION, t: 'activate', extId: '' } as unknown as Envelope
  assert.equal(harness.starter.send(malformed), false)
  assert.ok(logMessages(harness, 'error').some((message) => message.includes('畸形信封')))
})

test('host-renderer：主窗口未就绪时端口排队，就绪后经 webContents.postMessage 转移 port2', async () => {
  const harness = createHarness()
  harness.renderer = null
  const pending = harness.starter.start()
  handshake(harness)
  await pending

  const channel = harness.channels[0]
  assert.equal(channel.port2.posted.length, 0, '窗口没就绪就没有任何投递')

  // 窗口就绪：下一次重试就把端口交出去
  const target = createFakeRendererTarget()
  harness.renderer = target
  await harness.timers.advance(RENDERER_READY_RETRY_MS)

  assert.equal(target.posts.length, 1)
  const post = target.posts[0]
  assert.equal(post.channel, RENDERER_PORT_CHANNEL)
  assert.deepEqual(post.payload, { v: PROTOCOL_VERSION, hostId: 'host-1', pid: 4000 })
  assert.equal(post.transfer.length, 1)
  assert.equal(post.transfer[0], channel.port2)
})

test('host-renderer：窗口已就绪时端口在 fork 后立刻投递', () => {
  const harness = createHarness()
  const target = createFakeRendererTarget()
  harness.renderer = target

  void harness.starter.start()

  assert.equal(target.posts.length, 1)
  assert.equal(target.posts[0].channel, RENDERER_PORT_CHANNEL)
  assert.equal(target.posts[0].transfer[0], harness.channels[0].port2)
})

test('eh:get-port 只回报状态（端口不能从 invoke 返回）；未注册时不存在该 channel', async () => {
  const harness = createHarness()
  harness.starter.registerIpc()
  harness.starter.registerIpc() // 幂等：不应重复注册

  const handler = electronMock.ipcHandlers.get(RENDERER_PORT_IPC)
  assert.ok(handler, 'eh:get-port 必须注册')
  assert.equal(electronMock.ipcHandlers.size, 1)

  const before = handler()
  assert.equal(typeof before, 'object')
  const description = before as Record<string, unknown>
  assert.equal(description.channel, RENDERER_PORT_CHANNEL)
  assert.equal(description.phase, 'idle')
  assert.equal(description.portDelivered, false)
  assert.equal(description.portPending, false)
  assert.equal(description.protocolVersion, PROTOCOL_VERSION)
  assert.equal(
    'port' in description,
    false,
    '端口绝不能经 invoke 返回（结构化克隆不支持 MessagePort）'
  )

  const pending = harness.starter.start()
  handshake(harness)
  await pending
  const after = handler() as Record<string, unknown>
  assert.equal(after.phase, 'ready')
  assert.equal(after.portPending, true)
  assert.equal(after.portDelivered, false)
})

/* -------------------------------------------------------------------------------------------- */
/* 9. 假宿主入口 fixture 的自检                                                                   */
/* -------------------------------------------------------------------------------------------- */

test('fixture：extension-host-entry.mjs 是合法 ESM，且按协议发 ready / 回 initialized / 响应 terminate', () => {
  const path = fileURLToPath(new URL('./fixtures/extension-host-entry.mjs', import.meta.url))
  const source = readFileSync(path, 'utf8')

  // 能被 utilityProcess.fork 拉起 = 至少是合法 JS
  execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
  assert.match(source, /parentPort/)
  assert.match(source, /t: 'ready'/)
  assert.match(source, /t: 'initialized'/)
  assert.match(source, /case 'terminate'/)
  // 协议版本要跟 EH-A1 对齐（fixture 是 .mjs，不能 import TS 常量）
  assert.match(source, new RegExp(`const protocolVersion = ${PROTOCOL_VERSION}`))
})

/* -------------------------------------------------------------------------------------------- */
/* 10. 崩溃文案                                                                                   */
/* -------------------------------------------------------------------------------------------- */

test('describeExtensionHostCrash：合成退出码有专属中文文案，真实退出码带退出码', () => {
  assert.match(
    describeExtensionHostCrash({ code: EXIT_CODE_HANDSHAKE_TIMEOUT, at: 0 }),
    /没有完成握手/
  )
  assert.match(describeExtensionHostCrash({ code: EXIT_CODE_FORK_FAILED, at: 0 }), /无法拉起/)
  assert.match(describeExtensionHostCrash({ code: 12, at: 0 }), /退出码 12/)
})
