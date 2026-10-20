/**
 * EH-B3b-2 · 状态与 UI 面单测（`ui-plane.ts` 的宿主侧 `RpcClient` + `extensionHostConsumer.ts` 的
 * 渲染侧 `RpcServer`，以及 main 侧 `host.update.*` 的注册/复用与 R69 的 `OBOX_*` env 注入）。
 *
 * 覆盖判据（任务卡要求 + 技术债 #17 的教训「每张跨侧卡都必须带接缝测试」）：
 * 1. **接缝测试**（最重要）：宿主侧 `RpcClient` 与渲染侧 `RpcServer` 在**真实端口对象**上完成一次
 *    `ui.showMessage` 往返——两侧都是生产实现，只有"传输"是内存里的回环端口。
 * 2. `ui.withProgress` 的**进度帧**与**取消**（渲染侧取消 ⇒ 宿主 Promise reject `EH_CANCELLED`）。
 * 3. `update` 门控：非提供者被拒（v1 中文文案）、提供者放行后**真的**走到 main 的 RPC；
 *    其中一条走**真实 `RpcServer`**（宿主 → main 的 handler → 返回），不是只有假桥。
 * 4. `output.createChannel` 落到渲染侧 `outputStore`（含 append/appendLine/show/clear/dispose）。
 * 5. R69：`src/main/index.ts` fork 时注入 `OBOX_APP_NAME` / `OBOX_APP_VERSION` / `OBOX_LOCALE`，
 *    且**真实宿主入口**在注入后 `api.appInfo.get()` 返回真实版本（不依赖 settings 快照）。
 * 6. 对照表 **99 实现 + 0 桩**（本卡把最后 10 项落地）。
 *
 * 测试策略：宿主侧用**真实** `createExtensionApi` + 真实 `createUiPlaneHub`；渲染侧用**真实**
 * `createExtensionHostConsumer`；两侧通过一个"回环端口对"相连（`postMessage` 异步派发、`onmessage`
 * 订阅，语义与 Electron `MessagePort` 一致）。渲染侧的 UI store / output store / updater store 都是
 * 生产单例，断言直接看它们——"落到哪个 store"是这张卡的核心判据。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'vitest'

import type { HostedExtensionInfo } from '../src/shared/extensionHostProtocol'
import {
  createInitEnvelope,
  createRequestEnvelope,
  type Envelope
} from '../src/shared/extensionHostProtocol'
import type { ExtensionHostStatusSnapshot, ExtensionHostPortStatus } from '../src/shared/types'
import {
  createExtensionApi,
  listApiImplementation,
  type BuiltExtensionApi
} from '../src/extension-host/apiFactory'
import type { HostMainBridge } from '../src/extension-host/capabilities/io'
import {
  UI_MODAL_TIMEOUT_MS,
  UI_PLANE_EVENT_CHANNELS,
  UI_PLANE_RPC,
  UI_RENDERER_RPC,
  UI_WINDOW_MISSING,
  UPDATE_NOT_PROVIDER,
  createUiPlaneHub,
  resetSharedUiPlaneHub,
  type UiPlaneHub
} from '../src/extension-host/capabilities/ui-plane'
import type { HostLogger } from '../src/extension-host/log'
import type { HostRendererPortLike, ParentPortLike } from '../src/extension-host/port'
import { RpcClient, RpcServer } from '../src/extension-host/rpc'
import { createRunExtensionSafely } from '../src/extension-host/safety'
import {
  HOSTED_RENDERER_RPC,
  HOSTED_UI_EVENT_CHANNELS,
  HOSTED_UI_RPC,
  HOSTED_UI_WINDOW_MISSING,
  HOSTED_UPDATE_NOT_PROVIDER,
  createExtensionHostConsumer,
  type ExtensionHostConsumer,
  type HostedUiLogger,
  type HostedUiTransport
} from '../src/renderer/src/core/extensionHostConsumer'
import {
  createExtensionHostBridge,
  type ExtensionHostChannel
} from '../src/renderer/src/core/extensionHostBridge'
import { outputState } from '../src/renderer/src/core/outputStore'
import { uiState, uiStore } from '../src/renderer/src/core/uiStore'
import { updaterStore } from '../src/renderer/src/core/updaterStore'

/* -------------------------------------------------------------------------------------------- */
/* 夹具                                                                                          */
/* -------------------------------------------------------------------------------------------- */

const tempDirs: string[] = []
const createdHubs: UiPlaneHub[] = []
const createdConsumers: ExtensionHostConsumer[] = []
const hostLogs: Array<{ level: string; message: string }> = []
const uiLogs: Array<{ level: string; message: string }> = []

const logger: HostLogger = (level, message, detail): void => {
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

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-b3b2-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async (): Promise<void> => {
  for (const consumer of createdConsumers.splice(0)) consumer.stop()
  for (const hub of createdHubs.splice(0)) hub.dispose()
  resetSharedUiPlaneHub()
  // 渲染侧的三个 store 都是进程级单例：逐个复原，避免用例互相污染
  if (uiState.quickPick) uiStore.resolveQuickPick(undefined)
  if (uiState.inputBox) uiStore.resolveInputBox(undefined)
  if (uiState.form) uiStore.resolveForm(undefined)
  uiStore.hideProgress()
  uiState.toasts = []
  // 输出通道没有「重置全部」的 API（生产不需要）：测试直接复原 reactive 状态
  outputState.channels = []
  outputState.activeId = null
  outputState.visible = false
  updaterStore.deactivateExtension('b3b2-ext')
  // 只有真的设过提供者时才写回设置（`setActive(null)` 会触发持久化：node 环境没有 localStorage，
  // 白白刷一条 `[state] persist failed` 噪声）
  if (updaterStore.activeId !== undefined) updaterStore.setActive(null)
  hostLogs.length = 0
  uiLogs.length = 0
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 造一个扩展目录（manifest + 入口），返回 `HostedExtensionInfo` */
async function makeExtension(
  root: string,
  id: string,
  source = 'export default () => {}\n'
): Promise<HostedExtensionInfo> {
  const dir = path.join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ name: id, main: 'index.mjs' }),
    'utf8'
  )
  await writeFile(path.join(dir, 'index.mjs'), source, 'utf8')
  return { id, version: '1.0.0', path: dir, activationEvents: [], apiVersion: 3 }
}

/* --------------------------------- 回环端口对（真实 MessagePort 语义） ------------------------------- */

interface Loopback {
  port: HostRendererPortLike
  /** 本端收到的信封（顺序） */
  received: Envelope[]
  listeners: Set<(event: unknown) => void>
  closed: boolean
}

/**
 * 造一对**互相连通**的端口：`postMessage` 异步派发到对端的 `onmessage`（与 Electron `MessagePort`
 * 一样不在同一个 tick 里重入），`close()` 后不再派发。
 *
 * 这就是本卡"真实端口对象"的含义：两侧跑的都是生产实现（宿主 `RpcServer`/`RpcClient`、渲染侧
 * `RpcServer`/消费者），只有传输层换成了内存回环——技术债 #17 那类"两侧各自用假件、缝其实是断的"
 * 用例，正需要这样一条会真的把字节送到对面的链路。
 */
function createLoopbackPair(): { host: Loopback; renderer: Loopback } {
  const host: Loopback = { received: [], listeners: new Set(), closed: false, port: null as never }
  const renderer: Loopback = {
    received: [],
    listeners: new Set(),
    closed: false,
    port: null as never
  }
  const send = (from: Loopback, to: Loopback, message: unknown): void => {
    queueMicrotask((): void => {
      if (from.closed || to.closed) return
      to.received.push(message as Envelope)
      for (const listener of [...to.listeners]) listener({ data: message })
    })
  }
  for (const [self, other] of [
    [host, renderer],
    [renderer, host]
  ] as const) {
    self.port = {
      postMessage(message: unknown): void {
        send(self, other, message)
      },
      get onmessage(): null {
        return null
      },
      set onmessage(value: ((event: unknown) => void) | null) {
        if (value) self.listeners.add(value)
      },
      close(): void {
        self.closed = true
      }
    }
  }
  return { host, renderer }
}

/**
 * 渲染侧窄通道：`post` 走端口，`onEnvelope` 把端口的 `res`/`err`/`cancel` 交给渲染侧 `RpcClient`
 * （宿主 → 渲染侧请求的**回包**），其余信封（`event`/`req`）交给消费者。
 */
function createRendererTransport(renderer: Loopback): {
  transport: HostedUiTransport
  client: RpcClient
} {
  const client = new RpcClient({
    send: (envelope): void => {
      renderer.port.postMessage(envelope)
    },
    log: (): void => {}
  })
  const transport: HostedUiTransport = {
    post(envelope): boolean {
      renderer.port.postMessage(envelope)
      return true
    },
    onEnvelope(listener): () => void {
      renderer.port.onmessage = (event): void => {
        const raw = (event as { data: unknown }).data
        if (typeof raw === 'object' && raw !== null) {
          const t = (raw as { t?: unknown }).t
          if (t === 'res') {
            client.handleResponse(raw as never)
            return
          }
          if (t === 'err') {
            client.handleError(raw as never)
            return
          }
          if (t === 'cancel') {
            client.handleCancel(raw as never)
            return
          }
        }
        listener(raw)
      }
      return (): void => undefined
    },
    request<T>(method: string, params?: unknown): Promise<T> {
      return client.request(method, params) as Promise<T>
    }
  }
  return { transport, client }
}

/** 宿主 + 渲染侧一整套（真实实现，仅传输是回环端口） */
interface Harness {
  built: BuiltExtensionApi
  hub: UiPlaneHub
  consumer: ExtensionHostConsumer
  loopback: { host: Loopback; renderer: Loopback }
  /** 渲染侧收到的宿主请求（method 列表） */
  hostRequests(): string[]
}

async function makeHarness(
  options: {
    extId?: string
    /** 渲染侧是否有窗口（缺省 true） */
    hasWindow?: () => boolean
    /** 宿主 → main 的桥（缺省不接线） */
    hostMain?: HostMainBridge
    /** 模态框超时（毫秒） */
    modalTimeoutMs?: number
  } = {}
): Promise<Harness> {
  const extId = options.extId ?? 'b3b2-ext'
  const root = await makeTempDir()
  const ext = await makeExtension(root, extId)
  const loopback = createLoopbackPair()

  const hubOptions: Parameters<typeof createUiPlaneHub>[0] = {
    rendererPort: loopback.host.port,
    log: logger
  }
  if (options.modalTimeoutMs !== undefined) hubOptions.modalTimeoutMs = options.modalTimeoutMs
  const hub = createUiPlaneHub(hubOptions)
  createdHubs.push(hub)

  const { transport } = createRendererTransport(loopback.renderer)
  const consumer = createExtensionHostConsumer({
    flag: '1',
    transport,
    logger: uiLogger,
    readSettings: () => ({}),
    readLocale: () => 'zh',
    readThemeId: () => 'theme-dark.dark',
    hasWindow: options.hasWindow ?? ((): boolean => true)
  })
  createdConsumers.push(consumer)

  const built = createExtensionApi({
    ext,
    appInfo: { name: 'obox', version: '9.9.9' },
    locale: 'zh',
    log: logger,
    runSafely: createRunExtensionSafely((): void => {}),
    uiPlane: hub,
    ...(options.hostMain === undefined ? {} : { hostMain: options.hostMain })
  })

  return {
    built,
    hub,
    consumer,
    loopback,
    hostRequests: (): string[] =>
      loopback.renderer.received
        .filter((envelope) => envelope.t === 'req')
        .map((envelope) => (envelope as { method: string }).method)
  }
}

/** 让出若干轮微任务（回环端口 + RPC 都是异步的：一次往返要几跳） */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0)
    })
  }
}

/** 等条件成立（最多 timeoutMs） */
async function waitFor(check: () => boolean, timeoutMs = 3000, what = '条件'): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${what}`)
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 10)
    })
  }
}

/** 假 main 桥：记下 method/params，按 handler 回值（认得 `host.proxy.get` 的预热调用） */
interface FakeMainBridge extends HostMainBridge {
  calls: Array<{ method: string; params: unknown }>
  methods(): string[]
  paramsOf(method: string, index?: number): unknown
}

function createFakeMainBridge(
  handler: (method: string, params: unknown) => unknown = () => ({ ok: true })
): FakeMainBridge {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    methods(): string[] {
      return calls.map((call) => call.method)
    },
    paramsOf(method: string, index = 0): unknown {
      return calls.filter((call) => call.method === method)[index]?.params
    },
    request(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params })
      if (method === 'host.proxy.get') return Promise.resolve({ ok: true, value: null })
      return Promise.resolve(handler(method, params))
    }
  }
}

/**
 * **真实 `RpcServer` 的 main 侧**（不是假桥）：宿主 `RpcClient` → main `RpcServer` 的 handler →
 * `res` 回宿主。用来证明 `host.update.*` 真的成立在 RPC 上（而不只是"桥被调了一下"）。
 */
function createMainRpcBridge(): {
  bridge: HostMainBridge
  register(method: string, handler: (params: unknown) => unknown): void
  methods(): string[]
} {
  const calls: string[] = []
  /** 宿主 → main 的在途请求（由 main 的 `RpcServer` 用 `send` 回帧） */
  const client = new RpcClient({
    send: (envelope): void => {
      queueMicrotask((): void => server.handleRequest(envelope as never))
    },
    log: (): void => {}
  })
  const server: RpcServer = new RpcServer({
    send: (envelope): void => {
      queueMicrotask((): void => {
        if (envelope.t === 'res') client.handleResponse(envelope)
        else if (envelope.t === 'err') client.handleError(envelope)
        else if (envelope.t === 'cancel') client.handleCancel(envelope)
      })
    },
    log: (): void => {}
  })
  return {
    bridge: {
      request(method: string, params?: unknown): Promise<unknown> {
        calls.push(method)
        return client.request(method, params)
      }
    },
    register(method, handler): void {
      server.register(method, (params) => handler(params))
    },
    methods: (): string[] => [...calls]
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 1. 两侧契约（防"改一边忘另一边"）                                                               */
/* -------------------------------------------------------------------------------------------- */

describe('两侧契约', () => {
  test('RPC method / 事件 channel / 文案在两侧逐字一致', () => {
    assert.deepEqual(UI_RENDERER_RPC, HOSTED_RENDERER_RPC, '宿主 → 渲染侧的 8 条 method 必须同名')
    assert.deepEqual(
      UI_PLANE_RPC,
      HOSTED_UI_RPC,
      '渲染侧 → 宿主的 method（含 progressCancel）必须同名'
    )
    assert.deepEqual(UI_PLANE_EVENT_CHANNELS, HOSTED_UI_EVENT_CHANNELS, 'output channel 必须同名')
    assert.equal(UI_WINDOW_MISSING, HOSTED_UI_WINDOW_MISSING, '「窗口不在」文案必须一致')
    assert.equal(UPDATE_NOT_PROVIDER, HOSTED_UPDATE_NOT_PROVIDER, '门控拒绝文案必须一致')
    // 文案要点：中文 + 说清"为什么" + 可执行的下一步（不是内部路径/堆栈）
    assert.match(UI_WINDOW_MISSING, /界面窗口不在/)
    assert.match(UPDATE_NOT_PROVIDER, /不是生效的更新提供者/)
    assert.equal(UI_MODAL_TIMEOUT_MS, 60_000, '模态框等待上限与 v1 的 60s 一致')
  })

  test('渲染侧 RpcServer 注册的 method 恰好是 8 条宿主 → 渲染侧方法', async () => {
    const { consumer } = await makeHarness()
    assert.deepEqual(consumer.rendererRpcMethods(), Object.values(HOSTED_RENDERER_RPC).sort())
    assert.equal(consumer.rendererRpcMethods().length, 8)
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 2. 接缝：真实端口上的 ui.showMessage 往返                                                      */
/* -------------------------------------------------------------------------------------------- */

describe('接缝：宿主 RpcClient ↔ 渲染侧 RpcServer（真实端口对象）', () => {
  test('ui.showMessage 往返：宿主发出 req → 渲染侧 RpcServer 弹 toast → 回 res', async () => {
    const { built, loopback } = await makeHarness()
    assert.equal(uiState.toasts.length, 0)

    // v1 里这是同步 void（`uiStore.showToast`），宿主侧不等待结果
    built.api.ui.showMessage('构建完成', 'success')
    await waitFor(() => uiState.toasts.length === 1, 2000, 'toast 落到 uiStore')

    const toast = uiState.toasts[0]
    assert.equal(toast.message, '构建完成')
    assert.equal(toast.type, 'success')

    // 宿主 → 渲染侧：一条 req，method 与参数都对
    const requests = loopback.renderer.received.filter((envelope) => envelope.t === 'req')
    assert.equal(requests.length, 1, '宿主只该发一条 req')
    const request = requests[0] as { method: string; params: unknown; id: number }
    assert.equal(request.method, UI_RENDERER_RPC.showMessage)
    assert.deepEqual(request.params, { message: '构建完成', type: 'success' })

    // 渲染侧 → 宿主：同 id 的 res（往返闭合，不是单向 fire-and-forget）
    const responses = loopback.host.received.filter((envelope) => envelope.t === 'res')
    assert.equal(responses.length, 1, '渲染侧必须回 res')
    assert.equal((responses[0] as { id: number }).id, request.id)
    assert.deepEqual((responses[0] as { result: unknown }).result, { ok: true })
  })

  test('端口没到：ui / output / update 全部 EH_NOT_READY（不静默、不排队）', async () => {
    // 不建回环端口：宿主 hub 拿不到 rendererPort
    const hub = createUiPlaneHub({ rendererPort: null, log: logger })
    createdHubs.push(hub)
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'no-port')
    const built = createExtensionApi({
      ext,
      appInfo: { name: 'obox', version: '9.9.9' },
      locale: 'zh',
      log: logger,
      runSafely: createRunExtensionSafely((): void => {}),
      uiPlane: hub
    })

    assert.throws(
      () => built.api.ui.showMessage('x'),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /host-renderer 端口未到/)
        return true
      }
    )
    await assert.rejects(built.api.ui.showQuickPick([{ label: 'a' }]), /host-renderer 端口未到/)
    assert.throws(() => built.api.output.createChannel('构建'), /host-renderer 端口未到/)
    await assert.rejects(built.api.update.check('https://feed/'), /host-renderer 端口未到/)
    assert.equal(hub.sentCount(), 0, '端口没到时不许发任何帧')
  })

  test('窗口不在：渲染侧回 EH_NOT_READY + 中文错误（不是让宿主等到 60s 超时）', async () => {
    const { built } = await makeHarness({ hasWindow: (): boolean => false })
    await assert.rejects(
      built.api.ui.showQuickPick([{ label: 'a' }]),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /界面窗口不在/)
        assert.match(error.message, /没有 v1 的"本地渲染"兜底/)
        return true
      }
    )
    // 渲染侧把原因落进日志（宿主侧拿到的是同一条中文文案），便于排查"为什么没弹窗"
    assert.ok(
      uiLogs.some(
        (entry) =>
          entry.message.includes('RPC 处理失败') &&
          entry.message.includes(UI_RENDERER_RPC.showQuickPick) &&
          entry.message.includes('没有可用的 window')
      ),
      `渲染侧必须留痕：${uiLogs.map((entry) => entry.message).join(' | ')}`
    )
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 2b. 生产接缝：A4 的桥必须把宿主发起的 req 交给消费者（否则真机上永远 EH_INTERNAL）                    */
/* -------------------------------------------------------------------------------------------- */

interface FakeBridgeChannel {
  channel: ExtensionHostChannel
  /** 桥发出去的信封（渲染侧 → 宿主） */
  sent: Envelope[]
  /** 模拟宿主发来一条信封（会同时派给所有订阅者，与 preload 的 onMessage 一致） */
  push(raw: unknown): void
  subscriberCount(): number
}

function createFakeBridgeChannel(): FakeBridgeChannel {
  const listeners = new Set<(raw: unknown) => void>()
  const sent: Envelope[] = []
  return {
    sent,
    channel: {
      isReady: (): boolean => true,
      send(envelope): boolean {
        sent.push(envelope)
        return true
      },
      onEnvelope(listener): () => void {
        listeners.add(listener)
        return (): void => {
          listeners.delete(listener)
        }
      },
      onStatus: (): (() => void) => (): void => undefined,
      readStatus: async (): Promise<ExtensionHostStatusSnapshot | null> => null,
      readPortStatus: async (): Promise<ExtensionHostPortStatus | null> => null
    },
    push(raw: unknown): void {
      for (const listener of [...listeners]) listener(raw)
    },
    subscriberCount: (): number => listeners.size
  }
}

describe('生产接缝：A4 桥 <-> 渲染侧 RpcServer（宿主发起的 req）', () => {
  test('没注册接管者 ⇒ 保持 A4 的 EH_INTERNAL（老语义不破）', () => {
    const fake = createFakeBridgeChannel()
    const bridge = createExtensionHostBridge({ channel: fake.channel, logger: uiLogger })
    fake.push(createRequestEnvelope(7, 'ui.showMessage', { message: 'x' }))
    const errors = fake.sent.filter((envelope) => envelope.t === 'err')
    assert.equal(errors.length, 1)
    assert.equal((errors[0] as { id: number }).id, 7)
    assert.match(String((errors[0] as { message: string }).message), /没有接管/)
    bridge.dispose()
  })

  test('注册接管者 ⇒ req 交给它、桥不再回 EH_INTERNAL；注销后恢复原行为', () => {
    const fake = createFakeBridgeChannel()
    const bridge = createExtensionHostBridge({ channel: fake.channel, logger: uiLogger })
    const seen: number[] = []
    const off = bridge.setHostRequestHandler((envelope) => {
      seen.push(envelope.id)
      return true
    })
    fake.push(createRequestEnvelope(11, 'ui.updateGate', { extId: 'x' }))
    assert.deepEqual(seen, [11], '接管者必须收到那条 req')
    assert.equal(fake.sent.length, 0, '接管者自己回帧，桥不该再回 EH_INTERNAL')

    off()
    fake.push(createRequestEnvelope(12, 'ui.updateGate', { extId: 'x' }))
    assert.deepEqual(seen, [11], '注销之后不再接管')
    assert.equal(fake.sent.filter((envelope) => envelope.t === 'err').length, 1)
    bridge.dispose()
  })

  test('端到端：宿主 → 桥接管口 → 消费者 RpcServer → 回包（每个 id 只回一次）', async () => {
    // 拓扑与真机一致：宿主端口 ↔ preload ↔ （A4 桥 + 消费者）↔ 渲染侧
    const loopback = createLoopbackPair()
    const fake = createFakeBridgeChannel()
    // 桥的"发出去"进回环端口；端口的入站消息同时派给桥与消费者（preload 的 onMessage 语义）
    const bridge = createExtensionHostBridge({
      channel: {
        ...fake.channel,
        send(envelope): boolean {
          fake.sent.push(envelope)
          loopback.renderer.port.postMessage(envelope)
          return true
        }
      },
      logger: uiLogger
    })
    loopback.renderer.port.onmessage = (event): void => {
      fake.push((event as { data: unknown }).data)
    }

    const hub = createUiPlaneHub({ rendererPort: loopback.host.port, log: logger })
    createdHubs.push(hub)
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'bridge-seam')
    const consumer = createExtensionHostConsumer({
      flag: '1',
      transport: {
        post: (envelope): boolean => {
          loopback.renderer.port.postMessage(envelope)
          return true
        },
        onEnvelope: (listener): (() => void) => fake.channel.onEnvelope(listener),
        request: <T>(method: string, params?: unknown): Promise<T> =>
          bridge.request<T>(method, params),
        // 与 `createWindowUiTransport()` 同一接线：消费者的 RpcServer 接管桥的 req
        onHostRequest: (handler): (() => void) => bridge.setHostRequestHandler(handler)
      },
      logger: uiLogger,
      readSettings: () => ({}),
      hasWindow: (): boolean => true
    })
    createdConsumers.push(consumer)
    const built = createExtensionApi({
      ext,
      appInfo: { name: 'obox', version: '9.9.9' },
      locale: 'zh',
      log: logger,
      runSafely: createRunExtensionSafely((): void => {}),
      uiPlane: hub
    })

    // ① UI 请求走完整链路：宿主 → 桥 → 渲染侧 RpcServer → uiStore
    built.api.ui.showMessage('穿过桥', 'info')
    await waitFor(() => uiState.toasts.length === 1, 2000, 'toast 经桥到达 uiStore')
    assert.equal(uiState.toasts[0].message, '穿过桥')
    assert.equal(
      uiLogs.filter((entry) => entry.message.includes('没有接管者')).length,
      0,
      '不该再走 A4 的"没有接管者"分支'
    )

    // ② 同一个 id 只回一次（桥与消费者都订阅同一条 req ⇒ 必须只有一条路径处理）
    const replies = loopback.host.received.filter(
      (envelope) => envelope.t === 'res' || envelope.t === 'err'
    )
    const ids = replies.map((envelope) => (envelope as { id: number }).id)
    assert.equal(ids.length, new Set(ids).size, `每个 id 只能回一帧，实际：${ids.join(',')}`)
    assert.equal(
      fake.sent.filter((envelope) => envelope.t === 'err').length,
      0,
      '不应有 EH_INTERNAL 回包'
    )

    bridge.dispose()
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 3. 模态框语义（照抄 v1：取消 ⇒ undefined；60s 无结果 ⇒ 取消）                                     */
/* -------------------------------------------------------------------------------------------- */

describe('ui 模态框', () => {
  test('showQuickPick：返回选中项 label；取消 ⇒ undefined；opts 原样送到渲染侧', async () => {
    const { built, loopback } = await makeHarness()
    const pending = built.api.ui.showQuickPick(
      [{ label: '深色', description: 'd' }, { label: '浅色' }],
      { title: '选择主题', placeHolder: '主题', closeOnClickOutside: false }
    )
    await waitFor(() => uiState.quickPick !== null, 2000, '渲染侧弹出 quickPick')
    assert.equal(uiState.quickPick?.title, '选择主题')
    assert.equal(uiState.quickPick?.closeOnClickOutside, false)
    assert.equal(uiState.quickPick?.items.length, 2)

    const request = loopback.renderer.received.find((envelope) => envelope.t === 'req') as {
      params: unknown
    }
    assert.deepEqual(request.params, {
      items: [{ label: '深色', description: 'd' }, { label: '浅色' }],
      opts: { title: '选择主题', placeHolder: '主题', closeOnClickOutside: false }
    })

    uiStore.resolveQuickPick('浅色')
    assert.equal(await pending, '浅色')

    const cancelled = built.api.ui.showQuickPick([{ label: 'x' }])
    await waitFor(() => uiState.quickPick !== null, 2000, '第二次弹出')
    uiStore.resolveQuickPick(undefined)
    assert.equal(await cancelled, undefined, '取消 ⇒ undefined（v1 语义）')
  })

  test('showInputBox：返回输入值；密码框透传；取消 ⇒ undefined', async () => {
    const { built } = await makeHarness()
    const pending = built.api.ui.showInputBox({
      title: '名称',
      value: '旧值',
      password: true,
      placeHolder: '输入'
    })
    await waitFor(() => uiState.inputBox !== null, 2000, '渲染侧弹出 inputBox')
    assert.equal(uiState.inputBox?.password, true)
    assert.equal(uiState.inputBox?.value, '旧值')
    uiStore.resolveInputBox('新值')
    assert.equal(await pending, '新值')

    const cancelled = built.api.ui.showInputBox()
    await waitFor(() => uiState.inputBox !== null, 2000, '第二次弹出')
    uiStore.resolveInputBox(undefined)
    assert.equal(await cancelled, undefined)
  })

  test('showForm：返回字段值；取消 ⇒ undefined；字段顺序与默认值保持', async () => {
    const { built } = await makeHarness()
    const fields = [
      { key: 'name', label: '名称', type: 'text' as const },
      {
        key: 'tags',
        label: '标签',
        type: 'checkbox' as const,
        options: [{ value: 'a', label: 'A' }]
      }
    ]
    const pending = built.api.ui.showForm({ title: '新建', fields })
    await waitFor(() => uiState.form !== null, 2000, '渲染侧弹出 form')
    assert.deepEqual(
      uiState.form?.fields.map((field) => field.key),
      ['name', 'tags']
    )
    assert.deepEqual(uiState.form?.values, { name: '', tags: [] })
    uiStore.resolveForm({ name: 'obox', tags: ['a'] })
    assert.deepEqual(await pending, { name: 'obox', tags: ['a'] })

    const cancelled = built.api.ui.showForm({ fields })
    await waitFor(() => uiState.form !== null, 2000, '第二次弹出')
    uiStore.resolveForm(undefined)
    assert.equal(await cancelled, undefined)
  })

  test('模态框 60s 无结果 ⇒ 按 v1 当作取消（返回 undefined，不抛 EH_TIMEOUT）', async () => {
    // 直接把等待上限压到 15ms（生产是 60_000，见 UI_MODAL_TIMEOUT_MS）
    const { built } = await makeHarness({ modalTimeoutMs: 15 })
    const started = Date.now()
    const result = await built.api.ui.showInputBox({ title: '慢一点' })
    assert.equal(result, undefined, '超时按取消处理')
    assert.ok(Date.now() - started < 2000, '用的是注入的超时，不是 3 秒默认值')
    assert.ok(
      hostLogs.some((entry) => entry.level === 'warn' && entry.message.includes('当作取消')),
      '超时要在宿主日志里说出来（否则看起来像用户取消）'
    )
    uiStore.resolveInputBox(undefined)
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 4. ui.withProgress：进度帧 + 取消（EH_CANCELLED）                                              */
/* -------------------------------------------------------------------------------------------- */

describe('ui.withProgress', () => {
  test('进度帧真的到渲染侧（title + percent），结束拆掉进度条，返回任务结果', async () => {
    const { built } = await makeHarness()
    const result = await built.api.ui.withProgress('下载安装包', async (report) => {
      report(12.5)
      await flush(2)
      report(80)
      return 'done'
    })
    assert.equal(result, 'done')
    // 结束后进度条必须消失（v1 的 `finally { hideProgress() }`）
    await waitFor(() => uiState.progress === null, 2000, '进度条被拆掉')
    assert.equal(uiState.progress, null)
  })

  test('进度帧落到 uiStore：中间态能看到 title 与 percent', async () => {
    const { built } = await makeHarness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = built.api.ui.withProgress('编译中', async (report) => {
      report(42)
      await gate
      return 1
    })
    await waitFor(() => uiState.progress?.percent === 42, 2000, 'percent=42 的进度帧')
    assert.equal(uiState.progress?.title, '编译中')
    release()
    assert.equal(await pending, 1)
  })

  test('渲染侧取消 ⇒ 宿主 Promise reject EH_CANCELLED（并且进度条被拆掉）', async () => {
    const { built, consumer } = await makeHarness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = built.api.ui.withProgress('长任务', async (report) => {
      report(10)
      await gate
      return 'late'
    })
    await waitFor(() => uiState.progress !== null, 2000, '进度条出现')
    assert.equal(consumer.cancelProgress(), true, 'cancelProgress 必须命中当前进度')

    await assert.rejects(pending, (error: unknown): boolean => {
      assert.match(String(error), /EH_CANCELLED|进度已被界面取消/)
      return true
    })
    assert.equal(uiState.progress, null, '取消后进度条立即消失')
    // 让任务自己跑完，避免悬挂（取消之后它的结果不再有人接收）
    release()
    await flush(2)
    assert.equal(consumer.uiRuntime().progressActive, 0)
  })

  test('取消之后 report 不再发帧；progressEnd 仍会拆掉渲染侧进度条', async () => {
    const { built, consumer, loopback } = await makeHarness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = built.api.ui.withProgress('任务', async (report) => {
      report(5)
      await gate
      report(99)
      return 'x'
    })
    await waitFor(() => uiState.progress !== null, 2000, '进度条出现')
    consumer.cancelProgress()
    await assert.rejects(pending)
    const countFrames = (): number =>
      loopback.renderer.received.filter(
        (envelope) =>
          envelope.t === 'req' &&
          (envelope as { method: string }).method === UI_RENDERER_RPC.progressUpdate
      ).length
    const before = countFrames()
    release()
    await flush(4)
    assert.equal(countFrames(), before, '取消之后的 report 必须被丢弃')
    assert.equal(uiState.progress, null)
  })

  test('任务抛错：原错误上抛，进度条仍然被拆掉', async () => {
    const { built } = await makeHarness()
    await assert.rejects(
      built.api.ui.withProgress('会失败', async () => {
        throw new Error('任务爆炸')
      }),
      /任务爆炸/
    )
    await waitFor(() => uiState.progress === null, 2000, '失败路径也要拆进度条')
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 5. output.createChannel                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('output.createChannel', () => {
  test('通道落到 outputStore；append/appendLine/clear/show/dispose 全部生效', async () => {
    const { built, loopback } = await makeHarness()
    const channel = built.api.output.createChannel('构建日志')
    await waitFor(() => outputState.channels.length === 1, 2000, '通道落到 outputStore')
    const state = outputState.channels[0]
    assert.equal(state.name, '构建日志')
    assert.match(state.id, /^out-\d+$/, '渲染侧 id 仍是 outputStore 的既有规则')

    channel.append('a')
    channel.appendLine('b')
    await flush(2)
    assert.deepEqual(
      outputState.channels[0].lines,
      ['a', 'b\n'],
      'append 无换行、appendLine 补一个'
    )

    channel.show()
    await flush(2)
    assert.equal(outputState.visible, true)
    assert.equal(outputState.activeId, outputState.channels[0].id)

    channel.clear()
    await flush(2)
    assert.deepEqual(outputState.channels[0].lines, [])

    // 宿主侧的通道 id 是它自己生成的（同步返回句柄 ⇒ 必须当场有 id），并按扩展隔离
    const createPayload = loopback.renderer.received
      .filter((envelope) => envelope.t === 'event')
      .map((envelope) => (envelope as { payload: { op?: string; id?: string } }).payload)
      .find((payload) => payload.op === 'create')
    assert.equal(createPayload?.id, 'host-output:b3b2-ext:1')

    channel.dispose()
    await waitFor(() => outputState.channels.length === 0, 2000, 'dispose 后通道消失')
  })

  test('扩展停用 ⇒ 整批通道被拆掉（不留僵尸通道）', async () => {
    const { built, consumer } = await makeHarness()
    built.api.output.createChannel('一')
    built.api.output.createChannel('二')
    await waitFor(() => outputState.channels.length === 2, 2000, '两条通道')
    assert.equal(consumer.uiRuntime().outputChannels, 2)

    built.dispose() // = 扩展停用（宿主侧发 output disposeExtension）
    await waitFor(() => outputState.channels.length === 0, 2000, '停用后通道清空')
    assert.equal(consumer.uiRuntime().outputChannels, 0)
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 6. update 门控（渲染侧权威判定 + 放行后回 main）                                                 */
/* -------------------------------------------------------------------------------------------- */

/** 把某个扩展设成"当前生效的更新提供者"（渲染侧 `updaterStore`） */
function makeUpdateProvider(extId: string, feedUrl?: string): void {
  updaterStore.register(extId, feedUrl)
  updaterStore.setActive(extId)
}

describe('update 门控', () => {
  test('非提供者：抛 v1 中文错误，且**不碰 main**（门控在渲染侧先拦）', async () => {
    const bridge = createFakeMainBridge()
    const { built } = await makeHarness({ hostMain: bridge })
    await assert.rejects(built.api.update.check('https://feed/'), (error: unknown): boolean => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, UPDATE_NOT_PROVIDER)
      return true
    })
    assert.deepEqual(
      bridge.methods().filter((method) => method.startsWith('host.update.')),
      [],
      '门控没过时一条 host.update.* 都不许发'
    )
    assert.ok(
      hostLogs.some((entry) => entry.level === 'warn' && entry.message.includes('被拒')),
      '拒绝要在宿主日志里留痕'
    )
  })

  test('提供者放行：update.check 真的走到 main 的 RPC（含代理参数）', async () => {
    makeUpdateProvider('b3b2-ext')
    const bridge = createFakeMainBridge(() => ({ ok: true, available: '2.0.0' }))
    const { built } = await makeHarness({ hostMain: bridge })

    const result = await built.api.update.check('https://github.com/o/r/releases/download/v1/')
    assert.deepEqual(result, { ok: true, available: '2.0.0' })
    assert.deepEqual(bridge.paramsOf('host.update.check'), {
      feedUrl: 'https://github.com/o/r/releases/download/v1/',
      // 宿主侧代理来自 `host.proxy.get()` 的同步快照（`normalizeProxyConfig(undefined)` = 直连）
      proxy: { enabled: false, url: '', noProxy: [] }
    })
  })

  test('提供者放行：update.resolveFeed / download 的结果形状与 v1 一致', async () => {
    makeUpdateProvider('b3b2-ext')
    const bridge = createFakeMainBridge((method) => {
      if (method === 'host.update.resolve-feed') {
        return {
          ok: true,
          tag: 'v1.2.3',
          feedUrl: 'https://x/download/v1.2.3/',
          publishedAt: '2026-01-01'
        }
      }
      return { ok: true }
    })
    const { built } = await makeHarness({ hostMain: bridge })

    assert.deepEqual(await built.api.update.resolveFeed('o/r'), {
      ok: true,
      tag: 'v1.2.3',
      feedUrl: 'https://x/download/v1.2.3/',
      publishedAt: '2026-01-01'
    })
    assert.equal((bridge.paramsOf('host.update.resolve-feed') as { repo: string }).repo, 'o/r')
    assert.deepEqual(await built.api.update.download(), { ok: true })
    assert.ok(bridge.methods().includes('host.update.download'))
  })

  test('install：force 无更新源 ⇒ {ok:false} 中文错误（不发请求）；有提供者 feedUrl ⇒ 走 force', async () => {
    makeUpdateProvider('b3b2-ext')
    const bridge = createFakeMainBridge(() => ({ ok: true, version: '1.9.0' }))
    const { built } = await makeHarness({ hostMain: bridge })

    const noFeed = await built.api.update.install({ force: true })
    assert.deepEqual(noFeed, {
      ok: false,
      error: '强制重装需要更新源：请传入 feedUrl，或在 manifest 声明 contributes.updater.feedUrl'
    })
    assert.deepEqual(
      bridge.methods().filter((method) => method === 'host.update.install'),
      [],
      '没有更新源时不该发请求'
    )

    // 提供者 manifest 里声明的 feedUrl 由渲染侧随门控回包给出
    updaterStore.deactivateExtension('b3b2-ext')
    makeUpdateProvider('b3b2-ext', 'https://provider/feed/')
    assert.deepEqual(await built.api.update.install({ force: true }), {
      ok: true,
      version: '1.9.0'
    })
    const params = bridge.paramsOf('host.update.install') as {
      force: boolean
      feedUrl: string
      reason: string
    }
    assert.equal(params.force, true)
    assert.equal(params.feedUrl, 'https://provider/feed/')
    assert.equal(params.reason, 'user')

    // 非 force：只发一条 install，回值固定 {ok:true}（v1 的 quitAndInstall 不回头）
    assert.deepEqual(await built.api.update.install(), { ok: true })
    const installParams = bridge.paramsOf('host.update.install', 1) as { force: boolean }
    assert.equal(installParams.force, false)
  })

  test('没接 main 桥（provider 放行后）⇒ EH_INTERNAL + 「需要主进程 IPC」', async () => {
    makeUpdateProvider('b3b2-ext')
    const { built } = await makeHarness()
    await assert.rejects(built.api.update.download(), (error: unknown): boolean => {
      assert.match(String(error), /需要主进程 IPC/)
      return true
    })
  })

  test('真实 RpcServer 上的往返：宿主 → main 注册的 handler → 返回（不是只有假桥）', async () => {
    makeUpdateProvider('b3b2-ext')
    const main = createMainRpcBridge()
    main.register('host.proxy.get', () => ({ ok: true, value: null }))
    main.register('host.update.check', (params) => {
      const record = params as { feedUrl?: string }
      return { ok: true, available: `from-main:${record.feedUrl ?? ''}` }
    })
    const { built } = await makeHarness({ hostMain: main.bridge })

    const result = await built.api.update.check('https://feed.example/')
    assert.deepEqual(result, { ok: true, available: 'from-main:https://feed.example/' })
    assert.ok(main.methods().includes('host.update.check'), '宿主请求必须真的到 main 的 RpcServer')
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 7. 对照表：99 实现 + 0 桩                                                                      */
/* -------------------------------------------------------------------------------------------- */

describe('对照表', () => {
  test('EH-B3b-2 之后 99 已实现 + 0 桩（最后 10 项全部落地）', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'table-b3b2')
    const hub = createUiPlaneHub({ rendererPort: null, log: logger })
    createdHubs.push(hub)
    const built = createExtensionApi({
      ext,
      appInfo: { name: 'obox', version: '9.9.9' },
      locale: 'zh',
      log: logger,
      runSafely: createRunExtensionSafely((): void => {}),
      uiPlane: hub
    })
    const rows = listApiImplementation(built.api)
    const stubs = rows.filter((row) => row.status === 'stub')
    const implemented = rows.filter((row) => row.status === 'implemented')

    assert.equal(rows.length, 99, '对照表共 99 项')
    assert.equal(implemented.length, 99, '99 项全部已实现')
    assert.equal(stubs.length, 0, '桩必须为 0（阶段 B 的能力面已全部落地）')

    // 本卡的 10 项逐一确认存在
    const names = new Set(rows.map((row) => row.capability))
    for (const capability of [
      'ui.showQuickPick',
      'ui.showInputBox',
      'ui.showMessage',
      'ui.showForm',
      'ui.withProgress',
      'output.createChannel',
      'update.resolveFeed',
      'update.check',
      'update.download',
      'update.install'
    ]) {
      assert.ok(names.has(capability), `${capability} 必须在对照表里`)
    }
  })

  test('本卡 10 项不再是「尚未迁移」的桩：调用得到的是链路/形状错误而非迁移提示', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'no-stub')
    const hub = createUiPlaneHub({ rendererPort: null, log: logger })
    createdHubs.push(hub)
    const built = createExtensionApi({
      ext,
      appInfo: { name: 'obox', version: '9.9.9' },
      locale: 'zh',
      log: logger,
      runSafely: createRunExtensionSafely((): void => {}),
      uiPlane: hub
    })
    const calls: Array<() => Promise<unknown>> = [
      () => built.api.ui.showQuickPick([]),
      () => built.api.ui.showInputBox(),
      () => built.api.ui.showForm({ fields: [] }),
      () => built.api.ui.withProgress('t', async () => 1),
      () => built.api.update.resolveFeed('o/r'),
      () => built.api.update.check('https://x/'),
      () => built.api.update.download(),
      () => built.api.update.install()
    ]
    for (const call of calls) {
      await assert.rejects(call(), (error: unknown): boolean => {
        assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
        return true
      })
    }
    // 两条同步形状：同样不再是迁移提示
    assert.throws(
      () => built.api.ui.showMessage('x'),
      (error: unknown): boolean => {
        assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
        return true
      }
    )
    assert.throws(
      () => built.api.output.createChannel('x'),
      (error: unknown): boolean => {
        assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
        return true
      }
    )
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 8. R69：OBOX_* env 注入（修技术债 #12）                                                        */
/* -------------------------------------------------------------------------------------------- */

const ROOT = path.resolve(__dirname, '..')
/** 去掉注释再扫（源码注释里会**讨论** env 名字） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('R69：宿主 fork 时注入 OBOX_* env', () => {
  test('源码门禁：main 的 fork 参数里带 OBOX_APP_NAME / OBOX_APP_VERSION / OBOX_LOCALE', () => {
    const source = stripComments(readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8'))
    assert.match(source, /OBOX_APP_NAME:\s*app\.getName\(\)/)
    assert.match(source, /OBOX_APP_VERSION:\s*app\.getVersion\(\)/)
    assert.match(source, /OBOX_LOCALE:\s*hostLocaleEnv\(\)/)
    // 语言归一用主进程既有的 pickLocale（不另造一套 zh/en 判定），读不到就回 zh
    assert.match(source, /pickLocale\(app\.getLocale\(\)\)/)
    assert.match(source, /return 'zh'/)
  })

  test('env 链路：main 把三个 env 交给 starter，starter 用 extraEnv 覆盖进 fork 的 env', () => {
    // 为什么不做"起一次真 starter"的用例：`extensionHostStarter.ts` 直接 import electron
    // （`utilityProcess` / `MessageChannelMain` / 主窗口），在 node 环境里无法裸加载。
    // 但这条链的两端各自已被覆盖：`test/extension-host-starter.test.ts` 断言 `extraEnv` 会出现在
    // `fork` 的 env 里（`OBOX_TEST_FLAG` 那条），这里补上"main 确实把 OBOX_* 放进了 extraEnv"。
    const mainSource = stripComments(readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8'))
    const envBlock = mainSource.slice(mainSource.indexOf('env: {'))
    assert.match(envBlock, /OBOX_APP_NAME:\s*app\.getName\(\)/)
    assert.match(envBlock, /OBOX_APP_VERSION:\s*app\.getVersion\(\)/)
    assert.match(envBlock, /OBOX_LOCALE:\s*hostLocaleEnv\(\)/)

    const starterSource = stripComments(
      readFileSync(path.join(ROOT, 'src/main/extensionHostStarter.ts'), 'utf8')
    )
    // extraEnv **最后**展开 ⇒ 覆盖 process.env 里的同名变量（否则宿主机器的 OBOX_* 会赢）
    assert.match(
      starterSource,
      /\[EH_DATA_DIR_ENV\]: this\.dataDir,\s*\.\.\.this\.extraEnv/,
      'extraEnv 必须最后展开（覆盖 process.env 的同名值）'
    )
  })

  test('端到端：真实宿主入口在 OBOX_APP_VERSION 注入后 api.appInfo.get() 返回真实版本', async () => {
    // 这条是本卡对技术债 #12 的**行为**验收：不经过 settings 快照、不经过 init 字段，
    // 只靠 fork 时注入的 env，宿主入口构造出的 api 就已经是真实版本与语言。
    const dataDir = await makeTempDir()
    const ext = await makeExtension(
      dataDir,
      'r69-ext',
      `export default async (api) => {
  const info = await api.appInfo.get()
  api.log(\`R69 name=\${info.name} version=\${info.version} lang=\${api.env.language}\`)
}
`
    )

    const handlers = new Set<(event: unknown) => void>()
    const posted: unknown[] = []
    const parentPort: ParentPortLike = {
      postMessage(message: unknown): void {
        posted.push(message)
      },
      on(_event: 'message', listener: (event: unknown) => void): unknown {
        handlers.add(listener)
        return undefined
      },
      off(_event: 'message', listener: (event: unknown) => void): unknown {
        handlers.delete(listener)
        return undefined
      }
    }
    const previous = {
      appName: process.env.OBOX_APP_NAME,
      appVersion: process.env.OBOX_APP_VERSION,
      locale: process.env.OBOX_LOCALE
    }
    process.env.OBOX_APP_NAME = 'obox-desktop'
    process.env.OBOX_APP_VERSION = '2.5.0'
    process.env.OBOX_LOCALE = 'en'
    ;(process as unknown as { parentPort?: ParentPortLike }).parentPort = parentPort

    try {
      // 动态 import：入口在**模块求值**时读 env，所以 env 必须先设好
      await import('../src/extension-host/index')
      await waitFor(
        () => posted.some((message) => (message as { t?: unknown }).t === 'ready'),
        3000,
        '宿主入口发出 ready'
      )
      const init = createInitEnvelope({ apiVersion: 3, dataDir, extensions: [ext] })
      for (const handler of [...handlers]) handler({ data: init })
      await waitFor(
        () =>
          posted.some(
            (message) =>
              (message as { t?: unknown }).t === 'log' &&
              String((message as { message?: unknown }).message).includes('R69 ')
          ),
        5000,
        '扩展经 api.log 报出 appInfo/env'
      )
      const line = posted
        .map((message) => message as { t?: string; message?: string })
        .filter((message) => message.t === 'log')
        .map((message) => String(message.message))
        .find((message) => message.includes('R69 '))
      assert.ok(line, '必须收到那条 log')
      assert.match(line, /name=obox-desktop/)
      assert.match(line, /version=2\.5\.0/, 'api.appInfo.get() 必须返回真实版本（不依赖快照）')
      assert.match(line, /lang=en/, 'api.env.language 必须来自 OBOX_LOCALE')
    } finally {
      if (previous.appName === undefined) delete process.env.OBOX_APP_NAME
      else process.env.OBOX_APP_NAME = previous.appName
      if (previous.appVersion === undefined) delete process.env.OBOX_APP_VERSION
      else process.env.OBOX_APP_VERSION = previous.appVersion
      if (previous.locale === undefined) delete process.env.OBOX_LOCALE
      else process.env.OBOX_LOCALE = previous.locale
      delete (process as unknown as { parentPort?: ParentPortLike }).parentPort
    }
  })
})
