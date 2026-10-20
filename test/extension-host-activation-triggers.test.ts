/**
 * EH-C2 · 激活触发接线（`onStartupFinished` / `onCommand:<id>` / `onView:<id>`）单测。
 *
 * 三条要验的链路：
 *
 * ```text
 * 启动：init → initialized → dispatch('*') → dispatch('onStartupFinished')   （宿主 runtime.ts）
 * 命令：executeCommand(id) → 归属宿主的扩展未激活 ⇒ ensureActivated(ext, {command})
 * 视图：导航项打开 → ensureActivated(ext, {view}) → 再渲染
 * ```
 *
 * 覆盖判据（任务卡「必须实现」1-5）：
 * 1. **接缝测试**（本卡最重要的一条）：渲染侧 `ensureActivated` → 宿主 `host.activate` RPC →
 *    `Activator.activate()` → `plugin(api)` **恰好一次** → 后续命令执行拿到结果。
 *    两侧都用**真实实现**（真 runtime、真 consumer），只把"端口"换成可编排的假端口 —— 这条缝
 *    在 EH-B3b 上断过两次（技术债 #17/#18），所以每次跨侧接线都必须带一条真回环。
 * 2. `onStartupFinished` **恰好**分派一次，且不阻塞 `initialized` 握手。
 * 3. `onCommand` 未激活 ⇒ 先激活后执行；激活失败 ⇒ 中文错误 + **命令未执行**。
 * 4. 并发：两次 `ensureActivated` 只触发一次激活（渲染侧合并 + 宿主侧去重）。
 * 5. 回退开关关闭 ⇒ **零请求**（默认行为零变化）。
 *
 * 另外覆盖：视图触发（`ensureViewActivated` + `nav:open` 接线）、超时预算、已激活缓存、
 * 停用后缓存失效、回包形状不合法、宿主未挂激活入口（`EH_NOT_READY`）。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'

// host.ts 顶层 import 了那个 SFC，node 环境里必须替掉才能 import 宿主（先例：test/overlay-window.test.ts）
vi.mock('../src/renderer/src/components/TreeView.vue', () => ({ default: {} }))

import {
  EH_EVENT_CHANNELS,
  EhProtocolError,
  createEventEnvelope,
  createInitEnvelope,
  createRequestEnvelope,
  parseActivationEvent,
  type ActivationReason,
  type Envelope,
  type HostedExtensionInfo
} from '../src/shared/extensionHostProtocol'
import {
  UI_PLANE_RPC,
  createUiPlaneHub,
  resetSharedUiPlaneHub
} from '../src/extension-host/capabilities/ui-plane'
import type { HostLogger } from '../src/extension-host/log'
import {
  createHostPortsFromParentPort,
  type HostRendererPortLike,
  type ParentPortLike
} from '../src/extension-host/port'
import { ExtensionHostRuntime } from '../src/extension-host/runtime'
import {
  ACTIVATION_TIMEOUT_MS,
  HOSTED_UI_RPC,
  createExtensionHostConsumer,
  type ExtensionHostConsumer,
  type HostedActivationPort,
  type HostedUiHostAdapter,
  type HostedUiLogger,
  type HostedUiTransport
} from '../src/renderer/src/core/extensionHostConsumer'
import { host } from '../src/renderer/src/core/host'
import type { ExtensionActivationApi } from '../src/renderer/src/core/types'
import { registry } from '../src/renderer/src/core/registry'

/* -------------------------------------------------------------------------------------------- */
/* 夹具                                                                                          */
/* -------------------------------------------------------------------------------------------- */

const tempDirs: string[] = []
const runtimes: ExtensionHostRuntime[] = []
const consumers: ExtensionHostConsumer[] = []
const hostLogs: Array<{ level: string; message: string }> = []
const uiLogs: Array<{ level: string; message: string }> = []
/**
 * 扩展入口在被 `import()` / `plugin(api)` 时写进来的记号（`<id>:import` / `<id>:activate`）。
 * 用它同时证明两件事：**懒激活**（启动时没被 import）与**恰好一次**（activate 只出现一条）。
 */
const activationLog: string[] = []

const hostLogger: HostLogger = (level, message, detail): void => {
  hostLogs.push({ level, message: detail === undefined ? message : `${message}（${detail}）` })
}

const uiLogger: HostedUiLogger = {
  debug: (message): void => {
    uiLogs.push({ level: 'debug', message })
  },
  info: (message): void => {
    uiLogs.push({ level: 'info', message })
  },
  warn: (message): void => {
    uiLogs.push({ level: 'warn', message })
  },
  error: (message): void => {
    uiLogs.push({ level: 'error', message })
  }
}

beforeEach(() => {
  // 扩展入口（真 ESM）读它：每个用例重置，避免跨用例串味
  ;(globalThis as unknown as { __oboxEhActivation?: string[] }).__oboxEhActivation = activationLog
})

afterEach(async () => {
  for (const consumer of consumers.splice(0)) consumer.stop()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  resetSharedUiPlaneHub()
  hostLogs.length = 0
  uiLogs.length = 0
  activationLog.length = 0
  delete (globalThis as unknown as { window?: unknown }).window
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-c2-'))
  tempDirs.push(dir)
  return dir
}

/** 造一个真扩展目录（manifest + 入口 ESM），返回宿主需要的清单摘要 */
async function makeExtension(
  root: string,
  id: string,
  manifest: Record<string, unknown> = {},
  source?: string
): Promise<HostedExtensionInfo> {
  const dir = path.join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ name: id, main: 'index.mjs', ...manifest }),
    'utf8'
  )
  await writeFile(
    path.join(dir, 'index.mjs'),
    source ??
      `globalThis.__oboxEhActivation.push('${id}:import')
export default () => { globalThis.__oboxEhActivation.push('${id}:activate') }
`,
    'utf8'
  )
  const declared = manifest.activationEvents
  // 清单里是字符串（`onCommand:x`），协议层要的是**结构化** reason（`{command:'x'}`）：
  // 这一步正是生产链路里 `core/loader.ts` 的 `analyzeActivationEvents` 干的活。
  const activationEvents: ActivationReason[] =
    Array.isArray(declared) && declared.length > 0
      ? declared.map((event) => {
          const parsed = parseActivationEvent(String(event))
          assert.ok(parsed !== null, `清单里的激活事件 ${String(event)} 不合法（用例自己写错了）`)
          return parsed
        })
      : ['*']
  return {
    id,
    version: '1.0.0',
    path: dir,
    activationEvents,
    apiVersion: 3
  }
}

/** 让出几轮微任务/定时器（宿主的 RpcServer 处理 req 与激活都是异步的） */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0)
    })
  }
}

/** 宿主发出的 `log` 信封文案（宿主的日志出口就是 `log` 信封，不是可注入的 logger） */
function logMessages(posted: Envelope[]): string[] {
  return posted
    .filter((envelope) => envelope.t === 'log')
    .map((envelope) => (envelope as { message: string }).message)
}

/* ------------------------------ 宿主侧：假 parentPort / 假渲染侧端口 ------------------------------ */

interface FakeParentPort {
  parentPort: ParentPortLike
  /** main → 宿主（`ports` 是 transfer 列表） */
  emit(data: unknown, ports?: unknown[]): void
  /** 宿主 → main 的信封 */
  posted: Envelope[]
}

function createFakeParentPort(): FakeParentPort {
  const handlers = new Set<(event: unknown) => void>()
  const posted: Envelope[] = []
  return {
    parentPort: {
      postMessage(message: unknown): void {
        posted.push(message as Envelope)
      },
      on(_event: 'message', listener: (event: unknown) => void): unknown {
        handlers.add(listener)
        return undefined
      },
      off(_event: 'message', listener: (event: unknown) => void): unknown {
        handlers.delete(listener)
        return undefined
      }
    },
    emit(data: unknown, ports?: unknown[]): void {
      const event = ports === undefined ? { data } : { data, ports }
      for (const handler of [...handlers]) handler(event)
    },
    posted
  }
}

/**
 * `host-renderer` 的 port1（宿主侧句柄）+ 它的两端：
 * - `postMessage`：宿主 → 渲染侧（写 `fromHost` 并通知渲染侧订阅者）
 * - `toHost`：渲染侧 → 宿主（喂给宿主挂的 `onmessage`，形状是真实 `MessageEvent`）
 */
interface SeamPort {
  port: HostRendererPortLike
  fromHost: Envelope[]
  toHost(envelope: unknown): void
  onFromHost(listener: (raw: unknown) => void): () => void
  closed(): boolean
}

function createSeamPort(): SeamPort {
  const fromHost: Envelope[] = []
  const listeners = new Set<(raw: unknown) => void>()
  let hostHandler: ((event: unknown) => void) | null = null
  let closed = false
  const port: HostRendererPortLike = {
    postMessage(message: unknown): void {
      fromHost.push(message as Envelope)
      for (const listener of [...listeners]) listener(message)
    },
    get onmessage(): ((event: unknown) => void) | null {
      return hostHandler
    },
    set onmessage(value: ((event: unknown) => void) | null) {
      hostHandler = value
    },
    close(): void {
      closed = true
    }
  }
  return {
    port,
    fromHost,
    toHost(envelope: unknown): void {
      // 真实 MessagePort 的事件形状：信封在 `data` 上
      hostHandler?.({ data: envelope })
    },
    onFromHost(listener: (raw: unknown) => void): () => void {
      listeners.add(listener)
      return (): void => {
        listeners.delete(listener)
      }
    },
    closed: (): boolean => closed
  }
}

/** 渲染侧窄通道：`request` 真的把 `req` 信封喂给宿主端口，并在 `res`/`err` 回来后结算 */
interface SeamTransport extends HostedUiTransport {
  requests: Array<{ method: string; params: unknown; timeoutMs?: number }>
}

function createSeamTransport(link: SeamPort): SeamTransport {
  const requests: SeamTransport['requests'] = []
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: EhProtocolError): void }
  >()
  let nextId = 1
  link.onFromHost((raw) => {
    const envelope = raw as Envelope
    if (envelope.t !== 'res' && envelope.t !== 'err') return
    const entry = pending.get(envelope.id)
    if (!entry) return
    pending.delete(envelope.id)
    if (envelope.t === 'res') entry.resolve(envelope.result)
    else entry.reject(new EhProtocolError(envelope.code, envelope.message, envelope.detail))
  })
  return {
    requests,
    post: (envelope: Envelope): boolean => {
      link.toHost(envelope)
      return true
    },
    onEnvelope: (listener: (raw: unknown) => void): (() => void) => link.onFromHost(listener),
    onPort: (): (() => void) => (): void => undefined,
    request<T = unknown>(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number }
    ): Promise<T> {
      requests.push({
        method,
        params,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
      })
      return new Promise<T>((resolve, reject) => {
        const id = nextId++
        pending.set(id, {
          resolve: (value: unknown): void => {
            resolve(value as T)
          },
          reject
        })
        link.toHost(createRequestEnvelope(id, method, params ?? null))
      })
    }
  }
}

/** 假 host 适配器（`app.onMessage` 用；本卡不关心它） */
function createNoopHostAdapter(): HostedUiHostAdapter {
  return {
    registerHostedAppMessageHandler: (): (() => void) => (): void => undefined
  }
}

/** 起一台**真实** runtime + 一条真回环（渲染侧只换了端口实现） */
interface SeamHarness {
  runtime: ExtensionHostRuntime
  link: SeamPort
  transport: SeamTransport
  parent: FakeParentPort
}

async function startSeamHost(extensions: HostedExtensionInfo[]): Promise<SeamHarness> {
  const dataDir = await makeTempDir()
  const parent = createFakeParentPort()
  const ports = createHostPortsFromParentPort(parent.parentPort)
  const link = createSeamPort()
  const runtime = new ExtensionHostRuntime({
    port: ports.main,
    rendererPort: (): HostRendererPortLike | null => ports.renderer,
    hostId: 'eh-c2-host',
    pid: 4242,
    echoLog: false
  })
  runtimes.push(runtime)
  runtime.start()
  parent.emit(createInitEnvelope({ apiVersion: 3, dataDir, extensions }), [link.port])
  await runtime.settled()
  return { runtime, link, transport: createSeamTransport(link), parent }
}

/** 造一个消费者（开关打开；注入一切依赖，不碰 window/localStorage） */
function makeConsumer(
  transport: HostedUiTransport,
  flag: string | null = '1'
): ExtensionHostConsumer {
  const consumer = createExtensionHostConsumer({
    flag,
    transport,
    host: createNoopHostAdapter(),
    logger: uiLogger,
    readSettings: () => ({}),
    readLocale: () => 'zh',
    readThemeId: () => ''
  })
  consumers.push(consumer)
  return consumer
}

/* -------------------------------------------------------------------------------------------- */
/* 1. 启动完成：`*` 与 `onStartupFinished`（宿主侧）                                              */
/* -------------------------------------------------------------------------------------------- */

describe('启动完成：init 之后按顺序分派 * 与 onStartupFinished（各一次）', () => {
  test('onStartupFinished 恰好分派一次，且不阻塞 initialized 握手', async () => {
    const dataDir = await makeTempDir()
    const ext = await makeExtension(dataDir, 'sf-ext', { activationEvents: ['onStartupFinished'] })
    const parent = createFakeParentPort()
    const ports = createHostPortsFromParentPort(parent.parentPort)
    const runtime = new ExtensionHostRuntime({
      port: ports.main,
      rendererPort: (): HostRendererPortLike | null => ports.renderer,
      hostId: 'sf-host',
      pid: 1,
      echoLog: false
    })
    runtimes.push(runtime)

    runtime.start()
    parent.emit(createInitEnvelope({ apiVersion: 3, dataDir, extensions: [ext] }))

    // ① 握手先完成：init 是同步处理的，`initialized` 已经发出，但扩展还没跑
    assert.equal(
      parent.posted.filter((envelope) => envelope.t === 'initialized').length,
      1,
      'initialized 必须先于任何激活发出（激活是后台任务）'
    )
    assert.deepEqual(activationLog, [], 'onStartupFinished 的扩展不应在握手期间就被 import')

    await runtime.settled()
    // ② 恰好一次：import 一次、activate 一次
    assert.deepEqual(activationLog, ['sf-ext:import', 'sf-ext:activate'])
    assert.equal(runtime.statusOf('sf-ext')?.state, 'active')

    // ③ 再手动分派同一事件 ⇒ 宿主侧去重成 skipped，不会跑第二遍
    const again = await runtime.dispatchActivation('onStartupFinished')
    assert.deepEqual(
      again.map((result) => result.state),
      ['skipped']
    )
    assert.equal(
      activationLog.filter((line) => line === 'sf-ext:activate').length,
      1,
      'plugin(api) 只能跑一次'
    )
  })

  test('分派顺序：先 *（立即激活）再 onStartupFinished', async () => {
    const dataDir = await makeTempDir()
    const eager = await makeExtension(dataDir, 'a-eager', { activationEvents: ['*'] })
    const lazy = await makeExtension(dataDir, 'b-lazy', { activationEvents: ['onStartupFinished'] })
    const parent = createFakeParentPort()
    const ports = createHostPortsFromParentPort(parent.parentPort)
    const runtime = new ExtensionHostRuntime({
      port: ports.main,
      rendererPort: (): HostRendererPortLike | null => ports.renderer,
      hostId: 'order-host',
      pid: 1,
      echoLog: false
    })
    runtimes.push(runtime)

    runtime.start()
    parent.emit(createInitEnvelope({ apiVersion: 3, dataDir, extensions: [eager, lazy] }))
    await runtime.settled()

    assert.deepEqual(activationLog, [
      'a-eager:import',
      'a-eager:activate',
      'b-lazy:import',
      'b-lazy:activate'
    ])
    const messages = logMessages(parent.posted)
    const eagerLine = messages.findIndex((message) => message.startsWith('启动激活完成'))
    const startupLine = messages.findIndex((message) => message.startsWith('启动后激活完成'))
    assert.ok(eagerLine >= 0, '必须有一行「启动激活完成」')
    assert.ok(startupLine >= 0, '必须有一行「启动后激活完成（onStartupFinished）」')
    assert.ok(eagerLine < startupLine, '`*` 的完成日志必须早于 onStartupFinished')
  })

  test('已由 * 激活的扩展在 onStartupFinished 那一轮只是 skipped，不会跑第二遍', async () => {
    const dataDir = await makeTempDir()
    const ext = await makeExtension(dataDir, 'only-star', { activationEvents: ['*'] })
    const parent = createFakeParentPort()
    const ports = createHostPortsFromParentPort(parent.parentPort)
    const runtime = new ExtensionHostRuntime({
      port: ports.main,
      rendererPort: (): HostRendererPortLike | null => ports.renderer,
      hostId: 'star-host',
      pid: 1,
      echoLog: false
    })
    runtimes.push(runtime)

    runtime.start()
    parent.emit(createInitEnvelope({ apiVersion: 3, dataDir, extensions: [ext] }))
    await runtime.settled()

    assert.equal(activationLog.filter((line) => line === 'only-star:activate').length, 1)
    // `*` 匹配任何触发 ⇒ onStartupFinished 那一轮会**看到**它，但只回 skipped
    const results = await runtime.dispatchActivation('onStartupFinished')
    assert.deepEqual(
      results.map((result) => [result.extId, result.state]),
      [['only-star', 'skipped']]
    )
    assert.equal(activationLog.filter((line) => line === 'only-star:activate').length, 1)
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 2. 接缝：渲染侧 ensureActivated → 宿主 activate → plugin(api) → 后续命令拿到结果               */
/* -------------------------------------------------------------------------------------------- */

describe('接缝：渲染侧 ensureActivated 真的驱动宿主激活', () => {
  test('ensureActivated → 宿主 host.activate → plugin(api) 一次 → 后续命令执行拿到结果', async () => {
    const dataDir = await makeTempDir()
    const ext = await makeExtension(
      dataDir,
      'seam-ext',
      {
        activationEvents: ['onCommand:seam-ext.hello'],
        contributes: { commands: [{ command: 'seam-ext.hello', title: 'Hello' }] }
      },
      `globalThis.__oboxEhActivation.push('seam-ext:import')
export default (api) => {
  globalThis.__oboxEhActivation.push('seam-ext:activate')
  api.registerCommand('seam-ext.hello', () => 'hello-from-host')
}
`
    )
    const harness = await startSeamHost([ext])
    const consumer = makeConsumer(harness.transport)

    // ① 启动完成时它**没有**被激活（onCommand 是懒激活）
    assert.deepEqual(activationLog, [])
    assert.equal(harness.runtime.statusOf('seam-ext')?.state, 'pending')

    // ② 渲染侧请求激活（走真端口、真 RPC、真 Activator）
    const outcome = await consumer.ensureActivated('seam-ext', { command: 'seam-ext.hello' })
    assert.equal(outcome.state, 'activated')
    assert.equal(outcome.extId, 'seam-ext')
    assert.deepEqual(activationLog, ['seam-ext:import', 'seam-ext:activate'])
    assert.equal(harness.runtime.statusOf('seam-ext')?.state, 'active', '宿主状态表必须显示 active')

    // ③ 这条请求用的 method / 参数 / 超时都对（超时是 10 秒的激活预算，不是桥的 3 秒）
    assert.equal(harness.transport.requests[0]?.method, HOSTED_UI_RPC.activate)
    assert.deepEqual(harness.transport.requests[0]?.params, {
      extId: 'seam-ext',
      reason: { command: 'seam-ext.hello' }
    })
    assert.equal(harness.transport.requests[0]?.timeoutMs, ACTIVATION_TIMEOUT_MS)

    // ④ 后续动作拿到结果：命令已在宿主的命令表里，渲染侧经同一端口执行它能拿到返回值
    const value = await harness.transport.request('ui.executeCommand', {
      command: 'seam-ext.hello',
      args: []
    })
    assert.equal(value, 'hello-from-host')
  })

  test('宿主没挂激活入口 ⇒ host.activate 回 EH_NOT_READY（不静默、不假装成功）', async () => {
    const link = createSeamPort()
    const hub = createUiPlaneHub({ rendererPort: link.port, log: hostLogger })
    try {
      hub.handleRendererMessage(
        createRequestEnvelope(7, UI_PLANE_RPC.activate, { extId: 'x', reason: { command: 'x.a' } })
      )
      await flush(2)
      const error = link.fromHost.find((envelope) => envelope.t === 'err')
      assert.ok(error !== undefined, '必须回一条 err 信封（否则渲染侧只能等到超时）')
      assert.equal((error as { id: number }).id, 7)
      assert.equal((error as { code: string }).code, 'EH_NOT_READY')
      assert.match((error as { message: string }).message, /激活入口/)
    } finally {
      hub.dispose()
    }
  })

  test('extId / reason 不合法 ⇒ 回 EH_INTERNAL + 中文说明（不把脏参数喂给激活器）', async () => {
    const link = createSeamPort()
    const hub = createUiPlaneHub({ rendererPort: link.port, log: hostLogger })
    hub.setActivateHandler(async (extId) => ({ extId, reason: '*', state: 'activated' }))
    try {
      hub.handleRendererMessage(createRequestEnvelope(8, UI_PLANE_RPC.activate, { extId: '' }))
      hub.handleRendererMessage(
        createRequestEnvelope(9, UI_PLANE_RPC.activate, { extId: 'x', reason: 'bogus' })
      )
      await flush(2)
      const errors = link.fromHost.filter((envelope) => envelope.t === 'err') as Array<{
        id: number
        code: string
        message: string
      }>
      assert.equal(errors.length, 2)
      assert.deepEqual(
        errors.map((entry) => [entry.id, entry.code]),
        [
          [8, 'EH_INTERNAL'],
          [9, 'EH_INTERNAL']
        ]
      )
      assert.match(errors[1].message, /reason 不合法/)
    } finally {
      hub.dispose()
    }
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 3. 渲染侧消费者：合并 / 缓存 / 失败 / 超时 / 回退开关                                           */
/* -------------------------------------------------------------------------------------------- */

interface StubTransport {
  transport: HostedUiTransport
  requests: Array<{ method: string; params: unknown; timeoutMs?: number }>
  posts: Envelope[]
}

/** 让用例自己决定 `request` 怎么回（记账 + 可控结果） */
function createStubTransport(
  respond: (method: string, params: unknown) => Promise<unknown>
): StubTransport {
  const requests: StubTransport['requests'] = []
  const posts: Envelope[] = []
  return {
    requests,
    posts,
    transport: {
      post: (envelope: Envelope): boolean => {
        posts.push(envelope)
        return true
      },
      onEnvelope: (): (() => void) => (): void => undefined,
      onPort: (): (() => void) => (): void => undefined,
      request: <T = unknown>(
        method: string,
        params?: unknown,
        options?: { timeoutMs?: number }
      ): Promise<T> => {
        requests.push({
          method,
          params,
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        })
        return respond(method, params) as Promise<T>
      }
    }
  }
}

describe('消费者 ensureActivated：合并 / 缓存 / 失败 / 超时', () => {
  test('并发两次 ensureActivated（同一扩展）只触发一次激活', async () => {
    const stub = createStubTransport(async (): Promise<unknown> => ({
      extId: 'conc-ext',
      reason: '*',
      state: 'activated'
    }))
    const consumer = makeConsumer(stub.transport)
    const [left, right] = await Promise.all([
      consumer.ensureActivated('conc-ext', { command: 'conc.a' }),
      consumer.ensureActivated('conc-ext', { command: 'conc.a' })
    ])
    assert.equal(stub.requests.length, 1, '同一扩展的并发请求必须合并成一条')
    assert.equal(left.state, 'activated')
    assert.equal(right.state, 'activated')
  })

  test('已激活过 ⇒ 第二次零请求（宿主回 activated 之后进本地缓存）', async () => {
    const stub = createStubTransport(async (): Promise<unknown> => ({
      extId: 'cache-ext',
      reason: '*',
      state: 'activated'
    }))
    const consumer = makeConsumer(stub.transport)
    assert.equal(
      (await consumer.ensureActivated('cache-ext', { view: 'v.panel' })).state,
      'activated'
    )
    const second = await consumer.ensureActivated('cache-ext', { view: 'v.panel' })
    assert.equal(second.state, 'skipped')
    assert.equal(stub.requests.length, 1, '缓存命中后不许再发请求')
  })

  test('宿主说 failed ⇒ 抛中文错误（含扩展 id / 触发事件 / 失败归类），不返回假成功', async () => {
    const stub = createStubTransport(async (): Promise<unknown> => ({
      extId: 'bad-ext',
      reason: 'onCommand:bad.cmd',
      state: 'failed',
      failure: { kind: 'plugin-threw', message: 'boom' }
    }))
    const consumer = makeConsumer(stub.transport)
    await assert.rejects(
      consumer.ensureActivated('bad-ext', { command: 'bad.cmd' }),
      (error: unknown): boolean => {
        assert.ok(error instanceof EhProtocolError)
        assert.equal(error.code, 'EH_ACTIVATION_FAILED')
        assert.match(error.message, /宿主扩展 bad-ext 激活失败/)
        assert.match(error.message, /onCommand:bad\.cmd/)
        assert.match(error.message, /plugin-threw/)
        assert.match(error.message, /boom/)
        return true
      }
    )
  })

  test('激活超时（桥回 EH_TIMEOUT）⇒ 中文错误保留错误码并带上扩展 id', async () => {
    const stub = createStubTransport(async (): Promise<unknown> => {
      throw new EhProtocolError('EH_TIMEOUT', '对端在超时时间内没有响应。')
    })
    const consumer = makeConsumer(stub.transport)
    await assert.rejects(
      consumer.ensureActivated('slow-ext', { view: 'slow.panel' }),
      (error: unknown): boolean => {
        assert.ok(error instanceof EhProtocolError)
        assert.equal(error.code, 'EH_TIMEOUT', '错误码必须保留（调用方据此决定是否重试）')
        assert.match(error.message, /slow-ext/)
        assert.match(error.message, /激活请求没有成功/)
        return true
      }
    )
    assert.equal(stub.requests[0]?.timeoutMs, ACTIVATION_TIMEOUT_MS)
  })

  test('回包形状不合法 ⇒ EH_INTERNAL（不按 as 硬转后当真）', async () => {
    const stub = createStubTransport(async (): Promise<unknown> => ({ ok: true }))
    const consumer = makeConsumer(stub.transport)
    await assert.rejects(
      consumer.ensureActivated('shape-ext', { command: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof EhProtocolError)
        assert.equal(error.code, 'EH_INTERNAL')
        assert.match(error.message, /回包形状不对/)
        return true
      }
    )
  })

  test('停用扩展（disposeExtension）后缓存失效 ⇒ 下次仍然发激活请求', async () => {
    let calls = 0
    const stub = createStubTransport(async (): Promise<unknown> => {
      calls += 1
      return { extId: 're-ext', reason: '*', state: 'activated' }
    })
    const consumer = makeConsumer(stub.transport)
    await consumer.ensureActivated('re-ext', { command: 're.cmd' })
    consumer.handleEnvelope(
      createEventEnvelope(EH_EVENT_CHANNELS.statusBar, {
        v: 1,
        kind: 'disposeExtension',
        extId: 're-ext'
      })
    )
    await consumer.ensureActivated('re-ext', { command: 're.cmd' })
    assert.equal(calls, 2)
  })

  test('回退开关关闭 ⇒ 消费者是空壳，ensureActivated 零请求', async () => {
    const stub = createStubTransport(async (): Promise<unknown> => {
      throw new Error('开关关闭时不许发任何请求')
    })
    const consumer = makeConsumer(stub.transport, '0')
    assert.equal(consumer.enabled, false)
    const outcome = await consumer.ensureActivated('off-ext', { command: 'off.cmd' })
    assert.equal(outcome.state, 'skipped')
    assert.equal(stub.requests.length, 0, '零请求')
    assert.equal(stub.posts.length, 0, '关闭态连快照都不推')
  })

  test('extId 为空 ⇒ EH_INTERNAL（调用方 bug 要当场暴露）', async () => {
    const stub = createStubTransport(async (): Promise<unknown> => ({ state: 'activated' }))
    const consumer = makeConsumer(stub.transport)
    await assert.rejects(consumer.ensureActivated('  ', { command: 'x' }), (error: unknown) => {
      assert.ok(error instanceof EhProtocolError)
      assert.equal(error.code, 'EH_INTERNAL')
      return true
    })
    assert.equal(stub.requests.length, 0)
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 4. 渲染侧 host.ts：onCommand / onView 的激活前置                                              */
/* -------------------------------------------------------------------------------------------- */

/** 可编排的假激活端口（模拟宿主消费者：记账 + 可控失败 + 模拟"激活后注册命令"） */
interface FakeActivationHost extends HostedActivationPort {
  requests: Array<{ extId: string; reason: ActivationReason }>
  onActivate(handler: (extId: string) => void): void
}

function makeActivationHost(options: { fail?: (extId: string) => string | null } = {}): {
  port: FakeActivationHost
  requests: FakeActivationHost['requests']
} {
  const requests: FakeActivationHost['requests'] = []
  let onActivate: (extId: string) => void = (): void => undefined
  const failWith: (extId: string) => string | null = options.fail ?? ((): string | null => null)
  const port: FakeActivationHost = {
    enabled: true,
    requests,
    onActivate(handler): void {
      onActivate = handler
    },
    async ensureActivated(extId, reason) {
      requests.push({ extId, reason })
      const failure = failWith(extId)
      if (failure !== null) throw new Error(failure)
      onActivate(extId)
      return { extId, reason, state: 'activated' }
    }
  }
  return { port, requests }
}

/** 装一个假的 `window`（host.ts 只读 `window.api` / `window.events` / `window.eh`） */
interface WindowStub {
  /** 已注册的 `nav:open` 监听数 */
  readonly navOpenListeners: number
  /** 模拟主进程请求切页 */
  emitNavOpen(navId: string): void
}

function installWindow(flag: string | null): WindowStub {
  const listeners = new Map<string, Array<(...args: never[]) => void>>()
  let navOpenListeners = 0
  const eh = {
    extensionHostFlag: flag,
    hasPort: (): boolean => false,
    onPort: (): (() => void) => (): void => undefined,
    onMessage: (): (() => void) => (): void => undefined,
    post: (): boolean => false,
    onStatus: (): (() => void) => (): void => undefined
  }
  const status = {
    phase: 'idle',
    hostId: null,
    pid: null,
    crashCount: 0,
    lastCrash: null,
    lastAckAt: null
  }
  ;(globalThis as unknown as { window?: unknown }).window = {
    eh,
    events: {
      on: (event: string, listener: (...args: never[]) => void): (() => void) => {
        if (event === 'nav:open') navOpenListeners += 1
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return (): void => undefined
      }
    },
    api: {
      env: { platform: 'win32', arch: 'x64', nodeVersion: '20.0.0' },
      ehStart: async (): Promise<unknown> => ({ ok: true, hostId: 'h', pid: 1 }),
      ehGetPort: async (): Promise<unknown> => ({
        phase: 'idle',
        portDelivered: false,
        portPending: false,
        hostId: null,
        pid: null,
        channel: 'eh:port',
        protocolVersion: 1
      }),
      ehGetStatus: async (): Promise<unknown> => status,
      ehStop: async (): Promise<void> => undefined
    }
  }
  return {
    get navOpenListeners(): number {
      return navOpenListeners
    },
    emitNavOpen(navId: string): void {
      for (const listener of listeners.get('nav:open') ?? []) {
        ;(listener as unknown as (id: string) => void)(navId)
      }
    }
  }
}

type HostStartOptions = Parameters<typeof host.start>[0]
type HostEntry = HostStartOptions['builtins'][number]

/** 造一个会被 host.start 载入的条目 */
function hostEntry(options: {
  id: string
  source: 'builtin' | 'user'
  activated: string[]
  path?: string
  manifest?: Record<string, unknown>
  /** 渲染侧激活时做的事（宿主模式下用户扩展不会走到这里） */
  plugin?: (api: ExtensionActivationApi) => void
}): HostEntry {
  const manifest = {
    name: options.id,
    version: '1.0.0',
    main: 'index.js',
    ...(options.manifest ?? {})
  } as unknown as HostEntry['manifest']
  return {
    id: options.id,
    source: options.source,
    ...(options.path === undefined ? {} : { path: options.path }),
    manifest,
    load: async () => ({
      default: (api: ExtensionActivationApi): void => {
        options.activated.push(options.id)
        options.plugin?.(api)
      }
    })
  }
}

describe('host.executeCommand：onCommand 的激活前置', () => {
  test('目标属于未激活的宿主扩展 ⇒ 先 ensureActivated({command})，再执行命令', async () => {
    installWindow('1')
    const activated: string[] = []
    const fake = makeActivationHost()
    // 宿主激活后会把它 plugin(api) 里注册的命令送回来（模拟 commands 事件落到 registry）
    fake.port.onActivate((extId) => {
      registry.setCommandHandler(`${extId}.hello`, () => 'hosted-result', extId)
    })
    const user = hostEntry({
      id: 'cmd.hosted',
      source: 'user',
      activated,
      path: '/extensions/cmd.hosted',
      manifest: { contributes: { commands: [{ command: 'cmd.hosted.hello', title: 'Hello' }] } }
    })
    await host.start({ builtins: [], userExtensions: [user], activationHost: fake.port })

    assert.deepEqual(fake.requests, [], '启动阶段不该触发任何激活请求')

    const result = await host.executeCommand('cmd.hosted.hello')
    assert.equal(result, 'hosted-result')
    assert.deepEqual(fake.requests, [
      { extId: 'cmd.hosted', reason: { command: 'cmd.hosted.hello' } }
    ])
    // 渲染侧没有激活它（宿主模式下跳过）
    assert.deepEqual(activated, [])
  })

  test('激活失败 ⇒ 抛中文错误且命令**没有**执行', async () => {
    installWindow('1')
    const fake = makeActivationHost({ fail: () => 'plugin(api) 抛错：boom' })
    let executed = 0
    const user = hostEntry({
      id: 'broken',
      source: 'user',
      activated: [],
      path: '/extensions/broken',
      manifest: { contributes: { commands: [{ command: 'broken.cmd', title: 'Broken' }] } }
    })
    await host.start({ builtins: [], userExtensions: [user], activationHost: fake.port })
    // 故意先绑上 handler：激活失败时**也不能**执行（否则等于拿一个没就绪的扩展去跑）。
    // 绑定必须在 start 之后：命令条目是阶段一按 manifest 声明的，未声明时 setCommandHandler 会抛。
    registry.setCommandHandler(
      'broken.cmd',
      () => {
        executed += 1
        return 'should-not-run'
      },
      'broken'
    )

    await assert.rejects(host.executeCommand('broken.cmd'), (error: unknown): boolean => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /命令 broken\.cmd 属于宿主扩展 broken/)
      assert.match(error.message, /激活失败/)
      assert.match(error.message, /命令没有执行/)
      assert.match(error.message, /boom/)
      return true
    })
    assert.equal(executed, 0, '激活失败后命令 handler 一次都不许跑')
    assert.equal(fake.requests.length, 1)
  })

  test('已激活（宿主回 skipped/activated）⇒ 照常执行', async () => {
    installWindow('1')
    const fake = makeActivationHost()
    const user = hostEntry({
      id: 'ready',
      source: 'user',
      activated: [],
      path: '/extensions/ready',
      manifest: { contributes: { commands: [{ command: 'ready.cmd', title: 'Ready' }] } }
    })
    await host.start({ builtins: [], userExtensions: [user], activationHost: fake.port })
    registry.setCommandHandler('ready.cmd', () => 'ok', 'ready')

    assert.equal(await host.executeCommand('ready.cmd'), 'ok')
    assert.equal(fake.requests.length, 1)
  })

  test('命令属于内置扩展（渲染侧）⇒ 零激活请求', async () => {
    installWindow('1')
    const activated: string[] = []
    const fake = makeActivationHost()
    const builtin = hostEntry({
      id: 'builtin.ext',
      source: 'builtin',
      activated,
      manifest: { contributes: { commands: [{ command: 'builtin.cmd', title: 'Builtin' }] } },
      plugin: (api) => {
        api.registerCommand('builtin.cmd', () => 'builtin-result')
      }
    })
    const user = hostEntry({
      id: 'user.ext',
      source: 'user',
      activated,
      path: '/extensions/user.ext'
    })
    await host.start({ builtins: [builtin], userExtensions: [user], activationHost: fake.port })

    assert.equal(await host.executeCommand('builtin.cmd'), 'builtin-result')
    assert.deepEqual(fake.requests, [], '内置扩展的行为必须一点不变')
    assert.deepEqual(activated, ['builtin.ext'])
  })

  test('回退开关关闭 ⇒ 用户扩展照旧在渲染侧激活，零激活请求', async () => {
    installWindow(null)
    const activated: string[] = []
    const fake = makeActivationHost()
    const user = hostEntry({
      id: 'off.user',
      source: 'user',
      activated,
      path: '/extensions/off.user',
      manifest: { contributes: { commands: [{ command: 'off.user.cmd', title: 'Off' }] } },
      plugin: (api) => {
        api.registerCommand('off.user.cmd', () => 'renderer-result')
      }
    })
    await host.start({ builtins: [], userExtensions: [user], activationHost: fake.port })

    assert.equal(await host.executeCommand('off.user.cmd'), 'renderer-result')
    assert.deepEqual(fake.requests, [], '开关关闭时这条路径必须完全不生效')
    assert.deepEqual(activated, ['off.user'], '渲染侧激活的既有路径不变')
  })
})

describe('host 的视图触发：onView 的激活前置', () => {
  test('ensureViewActivated：目标属于宿主扩展 ⇒ 请求 {view} 并返回 true', async () => {
    installWindow('1')
    const fake = makeActivationHost()
    const user = hostEntry({
      id: 'panel.ext',
      source: 'user',
      activated: [],
      path: '/extensions/panel.ext',
      manifest: {
        contributes: { views: [{ id: 'panel.ext.panel', title: 'Panel', icon: '<svg></svg>' }] }
      }
    })
    await host.start({ builtins: [], userExtensions: [user], activationHost: fake.port })

    assert.equal(await host.ensureViewActivated('panel.ext.panel'), true)
    assert.deepEqual(fake.requests, [{ extId: 'panel.ext', reason: { view: 'panel.ext.panel' } }])
  })

  test('nav:open（主进程请求切页）会驱动视图激活', async () => {
    const stub = installWindow('1')
    const fake = makeActivationHost()
    const user = hostEntry({
      id: 'nav.ext',
      source: 'user',
      activated: [],
      path: '/extensions/nav.ext',
      manifest: {
        contributes: { views: [{ id: 'nav.ext.tree', title: 'Tree', icon: '<svg></svg>' }] }
      }
    })
    await host.start({ builtins: [], userExtensions: [user], activationHost: fake.port })
    assert.equal(stub.navOpenListeners, 1, '宿主模式必须挂上 nav:open 的监听')

    stub.emitNavOpen('nav.ext.tree')
    await flush(2)
    assert.deepEqual(fake.requests, [{ extId: 'nav.ext', reason: { view: 'nav.ext.tree' } }])
  })

  test('ensureViewActivated：内置视图 / 未知导航项 ⇒ false 且零请求', async () => {
    installWindow('1')
    const fake = makeActivationHost()
    const builtin = hostEntry({
      id: 'app',
      source: 'builtin',
      activated: [],
      manifest: {
        contributes: { navItems: [{ id: 'app.main', title: 'Apps', icon: '<svg></svg>' }] }
      }
    })
    const user = hostEntry({
      id: 'u.ext',
      source: 'user',
      activated: [],
      path: '/extensions/u.ext'
    })
    await host.start({ builtins: [builtin], userExtensions: [user], activationHost: fake.port })

    assert.equal(await host.ensureViewActivated('app.main'), false)
    assert.equal(await host.ensureViewActivated('no.such.nav'), false)
    assert.deepEqual(fake.requests, [])
  })

  test('ensureViewActivated：激活失败 ⇒ 返回 false 但不抛（UI 是 fire-and-forget）', async () => {
    installWindow('1')
    const fake = makeActivationHost({ fail: () => '视图 provider 初始化失败' })
    const user = hostEntry({
      id: 'slow.ext',
      source: 'user',
      activated: [],
      path: '/extensions/slow.ext',
      manifest: {
        contributes: { views: [{ id: 'slow.ext.tree', title: 'Slow', icon: '<svg></svg>' }] }
      }
    })
    await host.start({ builtins: [], userExtensions: [user], activationHost: fake.port })

    assert.equal(await host.ensureViewActivated('slow.ext.tree'), false)
    assert.equal(fake.requests.length, 1)
  })
})
