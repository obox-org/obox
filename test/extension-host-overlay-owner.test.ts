/**
 * EH-D8b · 宿主创建的 overlay 收不到 `app.onMessage`（技术债 #13）单测。
 *
 * ## 缺陷（已被 pet 扩展的 D7 审计确认，后果是产品级）
 *
 * ```text
 * 宿主 api.overlay.create → main.createOverlayWindow(...)        ← 窗口真的建出来了
 * 渲染侧 overlayOwners（overlayId → extId）只在渲染进程自己的
 * api.overlay.create 路径里回填                                  ← 宿主路径完全没有这一步
 * 页面发 extension:message(appId = overlayId)
 *   → resolveMessageExtId 查不到归属 → 回「扩展未注册消息处理器」  ← 面板永远空、点击全无效
 * ```
 *
 * ## 本文件盯的就是那一条缝
 *
 * | 用例组 | 验什么 |
 * | --- | --- |
 * | 接缝（最重要） | **真** `ExtensionHostRuntime` + 真宿主侧 overlay 能力 + 假端口 + 真 consumer：宿主 `overlay.create` → 渲染侧 `overlayOwners` 登记 → 页面消息 → `app.onMessage` 到达该扩展 |
 * | 接缝（失败姿态） | 渲染侧端口未到 ⇒ `overlay.create` 抛 `EH_NOT_READY`，并且**回收**刚建的窗口（不留哑窗口） |
 * | 接缝（清理） | `overlayDestroy` / 扩展停用后归属被注销 |
 * | 接缝（隔离） | 两个扩展各建一个 overlay 不串号（A 的消息只到 A） |
 * | 宿主侧 | 归属通知的**时序**（create 结果返回前、RPC 成功后）、失败与清理路径 |
 * | ui-plane 出口 | 新 channel 常量两侧逐字一致、端口未到抛 `EH_NOT_READY` |
 * | 渲染侧 consumer | 登记 / 幂等注销 / 停用清理 / 脏载荷与缺适配器时**响亮** |
 * | `core/host.ts` | `registerHostedOverlayOwner` 进 `overlayOwners`，且旧注销函数不误删新归属 |
 *
 * 「真」的边界：`host-renderer` 端口与 `parentPort`（main）换成可编排的假件，其余全部是生产实现
 * ——这正是 EH-B3b 上断过两次（技术债 #17/#18）的那条缝，所以每次跨侧接线都带一条真回环。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'

// host.ts 顶层 import 了那个 SFC，node 环境里必须替掉才能 import 宿主（先例：test/overlay-window.test.ts）
vi.mock('../src/renderer/src/components/TreeView.vue', () => ({ default: {} }))

import {
  EhProtocolError,
  createDeactivateEnvelope,
  createEventEnvelope,
  createInitEnvelope,
  createRequestEnvelope,
  createResponseEnvelope,
  type Envelope,
  type HostedExtensionInfo,
  type RequestEnvelope
} from '../src/shared/extensionHostProtocol'
import {
  UI_PLANE_EVENT_CHANNELS,
  createUiPlaneHub,
  resetSharedUiPlaneHub,
  type UiPlaneHub
} from '../src/extension-host/capabilities/ui-plane'
import {
  HOST_MAIN_METHODS,
  createHostMainCapabilities,
  type HostMainCapabilities
} from '../src/extension-host/capabilities/host-main'
import type { HostMainBridge } from '../src/extension-host/capabilities/io'
import type { HostedExtensionApi } from '../src/extension-host/apiFactory'
import type { HostLogger } from '../src/extension-host/log'
import {
  createHostPortsFromParentPort,
  type HostRendererPortLike,
  type ParentPortLike
} from '../src/extension-host/port'
import { ExtensionHostRuntime } from '../src/extension-host/runtime'
import {
  HOSTED_UI_EVENT_CHANNELS,
  createExtensionHostConsumer,
  type ExtensionHostConsumer,
  type HostedUiHostAdapter,
  type HostedUiLogger,
  type HostedUiTransport
} from '../src/renderer/src/core/extensionHostConsumer'
import { host, resolveMessageExtId } from '../src/renderer/src/core/host'

/* -------------------------------------------------------------------------------------------- */
/* 夹具                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** 接缝测试的全局暂存：扩展入口把 `api` 放进来，用例从外面驱动它 */
interface D8bStash {
  apis: Map<string, HostedExtensionApi>
  hits: Array<{ extId: string; channel: string; payload: unknown }>
}

const tempDirs: string[] = []
const runtimes: ExtensionHostRuntime[] = []
const consumers: ExtensionHostConsumer[] = []
const hubs: UiPlaneHub[] = []
const uiLogs: Array<{ level: string; message: string }> = []

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

const hostLogger: HostLogger = (): void => undefined

function stash(): D8bStash {
  return (globalThis as unknown as { __oboxEhD8b: D8bStash }).__oboxEhD8b
}

/** host 私有成员的窄化视图（先例：test/overlay-window.test.ts 对 host 的 cast） */
const hostPriv = host as unknown as {
  handleExtensionMessage(e: {
    requestId: number
    appId: string
    channel: string
    payload: unknown
  }): void
  overlayOwners: Map<string, string>
  appMessageHandlers: Map<string, (channel: string, payload: unknown) => unknown>
}

/** 仿真 preload 暴露的 `window`（`handleExtensionMessage` 只读 `window.api.extensionReply`） */
interface ReplyRecorder {
  replies: Array<[number, { ok: boolean; data?: unknown; error?: string }]>
}

let rec: ReplyRecorder

function installWindow(): void {
  rec = { replies: [] }
  ;(globalThis as unknown as { window: unknown }).window = {
    events: {
      on: (): (() => void) => (): void => undefined
    },
    api: {
      env: { platform: 'win32', arch: 'x64', nodeVersion: 'v22.0.0' },
      extensionReply: (requestId: number, result: unknown): void => {
        rec.replies.push([requestId, result as never])
      }
    }
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { __oboxEhD8b: D8bStash }).__oboxEhD8b = {
    apis: new Map(),
    hits: []
  }
})

afterEach(async () => {
  for (const consumer of consumers.splice(0)) consumer.stop()
  for (const hub of hubs.splice(0)) hub.dispose()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  resetSharedUiPlaneHub()
  hostPriv.appMessageHandlers.clear()
  hostPriv.overlayOwners.clear()
  uiLogs.length = 0
  delete (globalThis as unknown as { window?: unknown }).window
  delete (globalThis as unknown as { __oboxEhD8b?: unknown }).__oboxEhD8b
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-d8b-'))
  tempDirs.push(dir)
  return dir
}

/** 造一个真扩展目录（manifest + 入口 ESM），`plugin(api)` 把 api 交出来并按需注册 `app.onMessage` */
async function makeExtension(
  root: string,
  id: string,
  options: { registerOnMessage?: boolean } = {}
): Promise<HostedExtensionInfo> {
  const dir = path.join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ name: id, main: 'index.mjs' }),
    'utf8'
  )
  const literal = JSON.stringify(id)
  const onMessage =
    (options.registerOnMessage ?? true)
      ? `  api.app.onMessage((channel, payload) => {
    globalThis.__oboxEhD8b.hits.push({ extId: ${literal}, channel, payload })
    return { from: ${literal}, echo: payload }
  })`
      : '  // 本用例不注册 app.onMessage（端口未到的场景里 app.onMessage 本身会抛 EH_NOT_READY）'
  await writeFile(
    path.join(dir, 'index.mjs'),
    `export default (api) => {
  globalThis.__oboxEhD8b.apis.set(${literal}, api)
${onMessage}
}
`,
    'utf8'
  )
  return { id, version: '1.0.0', path: dir, activationEvents: ['*'], apiVersion: 3 }
}

/** 让出几轮微任务/定时器（端口、RPC 与激活都是异步的） */
async function flush(rounds = 8): Promise<void> {
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
      setTimeout(resolve, 5)
    })
  }
}

/* ------------------------------ 宿主侧：假 parentPort（= main） ------------------------------ */

interface FakeParentPort {
  parentPort: ParentPortLike
  /** main → 宿主（`ports` 是 transfer 列表） */
  emit(data: unknown, ports?: unknown[]): void
  /** 宿主 → main 的信封 */
  posted: Envelope[]
  /** 覆盖某个 host.* 方法的应答（缺省 `{ok:true, value:null}`） */
  respond(method: string, result: unknown): void
  /** 宿主发过的 host.* RPC method 序列 */
  methods(): string[]
  /** 某 method 的全部 params */
  paramsOf(method: string): unknown[]
}

/**
 * 假 main：认得 `host.overlay.create` / `destroy`（与 `src/main/index.ts` 的注册同形），
 * 其余（`host.proxy.get` 预热等）回 `{ok:true, value:null}`。
 *
 * 应答走 `queueMicrotask`：模拟一次异步 RPC 往返，避免在宿主的发送栈里同步重入。
 */
function createFakeParentPort(): FakeParentPort {
  const handlers = new Set<(event: unknown) => void>()
  const posted: Envelope[] = []
  const responders = new Map<string, unknown>()
  const params = new Map<string, unknown[]>()
  const emitToHandlers = (event: unknown): void => {
    for (const handler of [...handlers]) handler(event)
  }
  const parentPort: ParentPortLike = {
    postMessage(message: unknown): void {
      const envelope = message as Envelope
      posted.push(envelope)
      if (envelope.t !== 'req') return
      const request = envelope as RequestEnvelope
      params.set(request.method, [...(params.get(request.method) ?? []), request.params])
      queueMicrotask(() => {
        const result = responders.has(request.method)
          ? responders.get(request.method)
          : { ok: true, value: null }
        emitToHandlers({ data: createResponseEnvelope(request.id, result) })
      })
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
  return {
    parentPort,
    posted,
    emit(data: unknown, ports?: unknown[]): void {
      // 真实 parentPort 的事件形状：`{ data, ports? }`（`init` 用它 transfer host-renderer 的 port1）
      emitToHandlers(ports === undefined ? { data } : { data, ports })
    },
    respond(method: string, result: unknown): void {
      responders.set(method, result)
    },
    methods(): string[] {
      return posted
        .filter((envelope) => envelope.t === 'req')
        .map((envelope) => (envelope as RequestEnvelope).method)
    },
    paramsOf(method: string): unknown[] {
      return params.get(method) ?? []
    }
  }
}

/* ------------------------------ 宿主侧：假 host-renderer 端口 ------------------------------ */

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
  requests: Array<{ method: string; params: unknown }>
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
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      requests.push({ method, params })
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

/* ------------------------------ 接缝夹具：真 runtime + 真 consumer ------------------------------ */

interface SeamHarness {
  runtime: ExtensionHostRuntime
  link: SeamPort
  parent: FakeParentPort
  transport: SeamTransport
  consumer: ExtensionHostConsumer
}

/**
 * 起一台**真实** `ExtensionHostRuntime`，两侧只把端口换成假件；渲染侧用**真**消费者、
 * 适配器是**真** `core/host.ts` 单例的首屏（链路末端就是 `overlayOwners`）。
 */
async function startHost(
  extensions: HostedExtensionInfo[],
  options: { withRendererPort?: boolean } = {}
): Promise<SeamHarness> {
  const withRendererPort = options.withRendererPort ?? true
  const dataDir = await makeTempDir()
  const parent = createFakeParentPort()
  const ports = createHostPortsFromParentPort(parent.parentPort)
  const link = createSeamPort()
  const runtime = new ExtensionHostRuntime({
    port: ports.main,
    rendererPort: (): HostRendererPortLike | null => (withRendererPort ? ports.renderer : null),
    hostId: 'eh-d8b-host',
    pid: 4242,
    echoLog: false
  })
  runtimes.push(runtime)
  runtime.start()

  // 消费者要在 `init` **之前**订阅：宿主的 `messageHandler` / `overlay-owner` 事件是单向
  // `event` 信封，晚订阅就会漏（假端口不排队）。
  const transport = createSeamTransport(link)
  const consumer = createExtensionHostConsumer({
    flag: '1',
    transport,
    // 真 host 单例：`overlayOwners` 就是生产那张表
    host: host as unknown as HostedUiHostAdapter,
    logger: uiLogger,
    readSettings: () => ({}),
    readLocale: () => 'zh',
    readThemeId: () => ''
  })
  consumers.push(consumer)

  parent.emit(createInitEnvelope({ apiVersion: 3, dataDir, extensions }), [link.port])
  await runtime.settled()
  await flush()
  return { runtime, link, parent, transport, consumer }
}

/** 取某个扩展被注入的 api（扩展入口在 `plugin(api)` 里交出来的） */
function apiOf(extId: string): HostedExtensionApi {
  const api = stash().apis.get(extId)
  assert.ok(api, `扩展 ${extId} 没有被激活（api 没交出来）`)
  return api
}

/** 从假端口收到的信封里挑出某 channel 的 `event` 载荷 */
function eventsOf(link: SeamPort, channel: string): unknown[] {
  return link.fromHost
    .filter((envelope) => envelope.t === 'event' && envelope.channel === channel)
    .map((envelope) => (envelope as { payload: unknown }).payload)
}

/** 造一条 `api.overlay.create` 的请求（尺寸/锚点取宠物窗口的典型值） */
const OVERLAY_REQUEST = {
  width: 220,
  height: 300,
  anchor: 'bottom-right' as const,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  url: 'app://extensions/overlay.html'
}

/* -------------------------------------------------------------------------------------------- */
/* 1. 接缝：宿主 create → 渲染侧 overlayOwners → 页面消息 → app.onMessage                          */
/* -------------------------------------------------------------------------------------------- */

describe('接缝：宿主 overlay.create → 渲染侧 overlayOwners → 页面消息 → app.onMessage', () => {
  test('完整链路：宿主建窗后归属入表，页面消息真的到达该扩展的 app.onMessage', async () => {
    installWindow()
    const root = await makeTempDir()
    const pet = await makeExtension(root, 'pet.ext')
    const seam = await startHost([pet])
    seam.parent.respond(HOST_MAIN_METHODS.overlayCreate, {
      ok: true,
      position: { x: 1000, y: 700 }
    })

    const api = apiOf('pet.ext')
    const created = await api.overlay.create({ id: 'pet.main', ...OVERLAY_REQUEST })
    assert.deepEqual(
      created,
      { ok: true, position: { x: 1000, y: 700 } },
      'create 结果原样回给扩展'
    )

    // 宿主 → main 的请求把 extId 绑死（扩展侧 API 没有这个参数）
    assert.deepEqual(seam.parent.paramsOf(HOST_MAIN_METHODS.overlayCreate), [
      { extId: 'pet.ext', request: { id: 'pet.main', ...OVERLAY_REQUEST } }
    ])

    // 归属在 create 结果回来之前就已排队（同一条 host-renderer 端口，顺序即契约）
    const bind = eventsOf(seam.link, UI_PLANE_EVENT_CHANNELS.overlayOwner)
    assert.deepEqual(bind, [{ v: 1, op: 'bind', extId: 'pet.ext', overlayId: 'pet.main' }])

    await flush()
    assert.equal(hostPriv.overlayOwners.get('pet.main'), 'pet.ext', '渲染侧 overlayOwners 已登记')
    // 归属查找与卡片路径复用同一个纯函数：overlayId 兜底命中
    assert.equal(
      resolveMessageExtId('pet.main', () => undefined, hostPriv.overlayOwners),
      'pet.ext'
    )

    // 页面（overlay 窗口）把 overlayId 当 appId 发第一条消息
    hostPriv.handleExtensionMessage({
      requestId: 1,
      appId: 'pet.main',
      channel: 'pet.hit',
      payload: { x: 12, y: 34 }
    })
    await waitFor(() => rec.replies.length === 1, 3000, '页面消息到达扩展并回包')

    assert.deepEqual(stash().hits, [
      { extId: 'pet.ext', channel: 'pet.hit', payload: { x: 12, y: 34 } }
    ])
    assert.deepEqual(rec.replies, [
      [1, { ok: true, data: { from: 'pet.ext', echo: { x: 12, y: 34 } } }]
    ])
  })

  test('端口未到：overlay.create 抛 EH_NOT_READY，并回收刚建的窗口（不建哑窗口）', async () => {
    installWindow()
    const root = await makeTempDir()
    const pet = await makeExtension(root, 'pet.ext', { registerOnMessage: false })
    const seam = await startHost([pet], { withRendererPort: false })
    seam.parent.respond(HOST_MAIN_METHODS.overlayCreate, {
      ok: true,
      position: { x: 10, y: 20 }
    })

    const api = apiOf('pet.ext')
    await assert.rejects(
      api.overlay.create({ id: 'pet.main', ...OVERLAY_REQUEST }),
      (error: unknown): boolean => {
        assert.ok(
          error instanceof EhProtocolError,
          '必须是 EhProtocolError（链路层，不是能力失败）'
        )
        assert.equal(error.code, 'EH_NOT_READY')
        return true
      }
    )

    // 窗口已经被 main 建出来了 → 宿主必须尽力回收，而不是留一个收不到页面消息的哑窗口
    const destroyed = seam.parent.paramsOf(HOST_MAIN_METHODS.overlayDestroy)
    assert.deepEqual(destroyed, [{ extId: 'pet.ext', id: 'pet.main' }])
    // 归属没有被登记，也没有留下"已创建"的登记（否则 dispose 时会朝一个不存在的窗口发 unbind）
    assert.equal(hostPriv.overlayOwners.has('pet.main'), false)
    assert.deepEqual(eventsOf(seam.link, UI_PLANE_EVENT_CHANNELS.overlayOwner), [])

    // 失败后 createdOverlays 已清空：停用时不该再为这个 id 发 unbind / 销毁
    seam.parent.emit(createDeactivateEnvelope('pet.ext'))
    await seam.runtime.settled()
    await flush()
    assert.deepEqual(
      eventsOf(seam.link, UI_PLANE_EVENT_CHANNELS.overlayOwner),
      [],
      '停用不该再发 unbind'
    )
    assert.deepEqual(seam.parent.paramsOf(HOST_MAIN_METHODS.overlayDestroy), [
      { extId: 'pet.ext', id: 'pet.main' }
    ])
  })

  test('overlayDestroy：归属跟着窗口一起注销，之后同一 id 的消息回既有错误', async () => {
    installWindow()
    const root = await makeTempDir()
    const pet = await makeExtension(root, 'pet.ext')
    const seam = await startHost([pet])
    seam.parent.respond(HOST_MAIN_METHODS.overlayCreate, { ok: true, position: { x: 1, y: 2 } })

    const api = apiOf('pet.ext')
    await api.overlay.create({ id: 'pet.main', ...OVERLAY_REQUEST })
    await flush()
    assert.equal(hostPriv.overlayOwners.get('pet.main'), 'pet.ext')

    const destroyed = await api.overlay.destroy('pet.main')
    assert.deepEqual(destroyed, { ok: true }, 'destroy 结果原样回给扩展')
    await flush()

    assert.equal(hostPriv.overlayOwners.has('pet.main'), false, '销毁后归属必须注销')
    assert.deepEqual(eventsOf(seam.link, UI_PLANE_EVENT_CHANNELS.overlayOwner), [
      { v: 1, op: 'bind', extId: 'pet.ext', overlayId: 'pet.main' },
      { v: 1, op: 'unbind', extId: 'pet.ext', overlayId: 'pet.main' }
    ])

    hostPriv.handleExtensionMessage({
      requestId: 2,
      appId: 'pet.main',
      channel: 'pet.hit',
      payload: null
    })
    await waitFor(() => rec.replies.length === 1, 3000, '未注册路由的回包')
    assert.deepEqual(rec.replies, [[2, { ok: false, error: '扩展未注册消息处理器' }]])
  })

  test('扩展停用（deactivate）：宿主回收窗口的同时注销归属，渲染侧表里不留脏 id', async () => {
    installWindow()
    const root = await makeTempDir()
    const pet = await makeExtension(root, 'pet.ext')
    const seam = await startHost([pet])
    seam.parent.respond(HOST_MAIN_METHODS.overlayCreate, { ok: true, position: { x: 1, y: 2 } })

    const api = apiOf('pet.ext')
    await api.overlay.create({ id: 'pet.main', ...OVERLAY_REQUEST })
    await flush()
    assert.equal(hostPriv.overlayOwners.get('pet.main'), 'pet.ext')

    seam.parent.respond(HOST_MAIN_METHODS.overlayDestroy, { ok: true })
    seam.parent.emit(createDeactivateEnvelope('pet.ext'))
    await seam.runtime.settled()
    await flush()

    assert.equal(hostPriv.overlayOwners.size, 0, '停用后归属必须清空')
    assert.deepEqual(
      eventsOf(seam.link, UI_PLANE_EVENT_CHANNELS.overlayOwner).filter(
        (payload) => (payload as { op?: unknown }).op === 'unbind'
      ),
      [{ v: 1, op: 'unbind', extId: 'pet.ext', overlayId: 'pet.main' }]
    )
    // 窗口也真的被回收了（v1 语义：停用/卸载即销毁窗体）
    assert.deepEqual(seam.parent.paramsOf(HOST_MAIN_METHODS.overlayDestroy), [
      { extId: 'pet.ext', id: 'pet.main' }
    ])
  })

  test('两个扩展各建一个 overlay 不串号：A 的消息只到 A', async () => {
    installWindow()
    const root = await makeTempDir()
    const alpha = await makeExtension(root, 'alpha.ext')
    const beta = await makeExtension(root, 'beta.ext')
    const seam = await startHost([alpha, beta])
    seam.parent.respond(HOST_MAIN_METHODS.overlayCreate, { ok: true, position: { x: 0, y: 0 } })

    await apiOf('alpha.ext').overlay.create({ id: 'alpha.main', ...OVERLAY_REQUEST })
    await apiOf('beta.ext').overlay.create({ id: 'beta.main', ...OVERLAY_REQUEST })
    await flush()

    assert.equal(hostPriv.overlayOwners.get('alpha.main'), 'alpha.ext')
    assert.equal(hostPriv.overlayOwners.get('beta.main'), 'beta.ext')

    hostPriv.handleExtensionMessage({
      requestId: 11,
      appId: 'alpha.main',
      channel: 'pet.hit',
      payload: { who: 'alpha' }
    })
    await waitFor(() => rec.replies.length === 1, 3000, 'A 的消息回包')

    assert.deepEqual(stash().hits, [
      { extId: 'alpha.ext', channel: 'pet.hit', payload: { who: 'alpha' } }
    ])
    assert.deepEqual(rec.replies, [
      [11, { ok: true, data: { from: 'alpha.ext', echo: { who: 'alpha' } } }]
    ])

    hostPriv.handleExtensionMessage({
      requestId: 12,
      appId: 'beta.main',
      channel: 'pet.subscribe',
      payload: { who: 'beta' }
    })
    await waitFor(() => rec.replies.length === 2, 3000, 'B 的消息回包')
    assert.deepEqual(stash().hits, [
      { extId: 'alpha.ext', channel: 'pet.hit', payload: { who: 'alpha' } },
      { extId: 'beta.ext', channel: 'pet.subscribe', payload: { who: 'beta' } }
    ])
    assert.deepEqual(rec.replies[1], [
      12,
      { ok: true, data: { from: 'beta.ext', echo: { who: 'beta' } } }
    ])
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 2. 宿主侧（host-main）：归属通知的时序、失败与清理                                            */
/* -------------------------------------------------------------------------------------------- */

interface RecordedCall {
  method: string
  params: unknown
}

interface FakeBridge extends HostMainBridge {
  calls: RecordedCall[]
  paramsOf(method: string, index?: number): unknown
}

function createFakeBridge(
  responder: (method: string, params: unknown) => unknown = () => ({ ok: true, value: null })
): FakeBridge {
  const calls: RecordedCall[] = []
  return {
    calls,
    request(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params })
      return Promise.resolve(
        method === 'host.proxy.get' ? { ok: true, value: null } : responder(method, params)
      )
    },
    paramsOf(method: string, index = 0): unknown {
      return calls.filter((call) => call.method === method)[index]?.params
    }
  }
}

interface OwnerHarness {
  caps: HostMainCapabilities
  bridge: FakeBridge
  /** 归属通知的记录（按发出顺序） */
  notifications: Array<[string, 'bind' | 'unbind']>
  /** 让归属通知抛错（模拟 ui-plane 端口未到） */
  failNotify(): void
  dispose(): void
}

const createdCaps: HostMainCapabilities[] = []

function createOwnerHarness(responder: (method: string, params: unknown) => unknown): OwnerHarness {
  const bridge = createFakeBridge(responder)
  const notifications: Array<[string, 'bind' | 'unbind']> = []
  let failing = false
  const caps = createHostMainCapabilities({
    extId: 'pet.ext',
    log: hostLogger,
    hostMain: bridge,
    notifyOverlayOwner: (overlayId, op): void => {
      if (failing) {
        throw new EhProtocolError(
          'EH_NOT_READY',
          'host-renderer 端口未到：宿主进程还没拿到渲染侧数据面通道'
        )
      }
      notifications.push([overlayId, op])
    }
  })
  createdCaps.push(caps)
  return {
    caps,
    bridge,
    notifications,
    failNotify(): void {
      failing = true
    },
    dispose(): void {
      caps.dispose()
    }
  }
}

afterEach(() => {
  for (const caps of createdCaps.splice(0)) caps.dispose()
})

describe('宿主侧：归属通知的时序与失败姿态', () => {
  test('create 成功 ⇒ RPC 之后、返回结果之前发 bind；失败（ok:false）⇒ 不发', async () => {
    const order: string[] = []
    let createResult: unknown = { ok: true, position: { x: 5, y: 6 } }
    const bridge = createFakeBridge((method) => {
      if (method === HOST_MAIN_METHODS.overlayCreate) {
        order.push('rpc:create')
        return createResult
      }
      return { ok: true }
    })
    const caps = createHostMainCapabilities({
      extId: 'pet.ext',
      log: hostLogger,
      hostMain: bridge,
      notifyOverlayOwner: (overlayId, op): void => {
        order.push(`notify:${op}:${overlayId}`)
      }
    })
    createdCaps.push(caps)

    const created = await caps.overlay.create({ id: 'pet.main', ...OVERLAY_REQUEST })
    assert.deepEqual(created, { ok: true, position: { x: 5, y: 6 } })
    assert.deepEqual(order, ['rpc:create', 'notify:bind:pet.main'], 'bind 必须在 RPC 成功之后发出')

    order.length = 0
    createResult = { ok: false, error: 'overlay id 已被扩展 other.ext 占用：pet.main' }
    const failed = await caps.overlay.create({ id: 'pet.main', ...OVERLAY_REQUEST })
    assert.equal(failed.ok, false)
    assert.deepEqual(order, ['rpc:create'], '建窗失败没有归属可登记，绝不发 bind')
  })

  test('归属通知抛错 ⇒ create 抛 EH_NOT_READY + 回收窗口；之后 dispose 不再为它发 unbind', async () => {
    const harness = createOwnerHarness((method) =>
      method === HOST_MAIN_METHODS.overlayCreate
        ? { ok: true, position: { x: 1, y: 1 } }
        : { ok: true }
    )
    harness.failNotify()

    await assert.rejects(
      harness.caps.overlay.create({ id: 'pet.main', ...OVERLAY_REQUEST }),
      (error: unknown): boolean => error instanceof EhProtocolError && error.code === 'EH_NOT_READY'
    )
    // 不建哑窗口：主进程收到同 id 的销毁（尽力而为）
    assert.deepEqual(harness.bridge.paramsOf(HOST_MAIN_METHODS.overlayDestroy, 0), {
      extId: 'pet.ext',
      id: 'pet.main'
    })
    assert.deepEqual(harness.notifications, [])

    harness.caps.dispose()
    assert.deepEqual(harness.bridge.paramsOf(HOST_MAIN_METHODS.overlayDestroy, 1), undefined)
    assert.deepEqual(harness.notifications, [])
  })

  test('destroy 成功 ⇒ unbind；越权被拒（ok:false）⇒ 不动别人的归属', async () => {
    const okHarness = createOwnerHarness((method) =>
      method === HOST_MAIN_METHODS.overlayCreate
        ? { ok: true, position: { x: 0, y: 0 } }
        : { ok: true }
    )
    await okHarness.caps.overlay.create({ id: 'pet.main', ...OVERLAY_REQUEST })
    assert.deepEqual(okHarness.notifications, [['pet.main', 'bind']])
    await okHarness.caps.overlay.destroy('pet.main')
    assert.deepEqual(okHarness.notifications, [
      ['pet.main', 'bind'],
      ['pet.main', 'unbind']
    ])

    const denied = createOwnerHarness(() => ({
      ok: false,
      error: '越权被拒：overlay pet.main 由扩展 other.ext 创建'
    }))
    const deniedResult = await denied.caps.overlay.destroy('pet.main')
    assert.equal(deniedResult.ok, false)
    assert.deepEqual(denied.notifications, [], '越权被拒不注销任何归属')
  })

  test('扩展停用（dispose）⇒ 每个已建 overlay 都发 unbind 并尽力销毁窗口', async () => {
    const harness = createOwnerHarness((method) =>
      method === HOST_MAIN_METHODS.overlayCreate
        ? { ok: true, position: { x: 0, y: 0 } }
        : { ok: true }
    )
    await harness.caps.overlay.create({ id: 'pet.main', ...OVERLAY_REQUEST })
    await harness.caps.overlay.create({ id: 'pet.panel', ...OVERLAY_REQUEST })
    assert.deepEqual(harness.notifications, [
      ['pet.main', 'bind'],
      ['pet.panel', 'bind']
    ])

    harness.caps.dispose()
    assert.deepEqual(
      harness.notifications.filter(([, op]) => op === 'unbind'),
      [
        ['pet.main', 'unbind'],
        ['pet.panel', 'unbind']
      ]
    )
    const destroys = harness.bridge.calls
      .filter((call) => call.method === HOST_MAIN_METHODS.overlayDestroy)
      .map((call) => call.params)
    assert.deepEqual(destroys, [
      { extId: 'pet.ext', id: 'pet.main' },
      { extId: 'pet.ext', id: 'pet.panel' }
    ])
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 3. ui-plane 出口：常量与端口未到                                                              */
/* -------------------------------------------------------------------------------------------- */

describe('ui-plane 出口：新 channel 与端口未到', () => {
  test('channel 名两侧逐字一致，payload 形状固定（bind / unbind）', async () => {
    assert.equal(UI_PLANE_EVENT_CHANNELS.overlayOwner, 'overlay-owner')
    assert.equal(HOSTED_UI_EVENT_CHANNELS.overlayOwner, UI_PLANE_EVENT_CHANNELS.overlayOwner)

    const sent: Envelope[] = []
    const hub = createUiPlaneHub({
      rendererPort: {
        postMessage(message: unknown): void {
          sent.push(message as Envelope)
        },
        onmessage: null
      },
      log: hostLogger
    })
    hubs.push(hub)

    hub.notifyOverlayOwner('pet.ext', 'pet.main', 'bind')
    hub.notifyOverlayOwner('pet.ext', 'pet.main', 'unbind')
    assert.deepEqual(
      sent.map((envelope) => (envelope as { channel?: unknown; payload?: unknown }).payload),
      [
        { v: 1, op: 'bind', extId: 'pet.ext', overlayId: 'pet.main' },
        { v: 1, op: 'unbind', extId: 'pet.ext', overlayId: 'pet.main' }
      ]
    )
    assert.equal((sent[0] as { channel: string }).channel, 'overlay-owner')
  })

  test('端口未到 ⇒ 抛 EH_NOT_READY（不静默），空 id 不发脏事件', () => {
    const hub = createUiPlaneHub({ rendererPort: null, log: hostLogger })
    hubs.push(hub)

    assert.throws(
      () => hub.notifyOverlayOwner('pet.ext', 'pet.main', 'bind'),
      (error: unknown): boolean => error instanceof EhProtocolError && error.code === 'EH_NOT_READY'
    )
    assert.equal(hub.sentCount(), 0)

    // 空 id 不该发一条渲染侧只能丢掉的脏事件（真正的校验在调用方与 main）
    hub.notifyOverlayOwner('', 'pet.main', 'bind')
    hub.notifyOverlayOwner('pet.ext', '', 'bind')
    assert.equal(hub.sentCount(), 0)
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 4. 渲染侧 consumer：登记 / 幂等注销 / 停用清理 / 响亮                                       */
/* -------------------------------------------------------------------------------------------- */

interface FakeTransport {
  transport: HostedUiTransport
  posted: Envelope[]
  push(raw: unknown): void
}

function createFakeTransport(): FakeTransport {
  const listeners = new Set<(raw: unknown) => void>()
  const posted: Envelope[] = []
  return {
    posted,
    transport: {
      post(envelope: Envelope): boolean {
        posted.push(envelope)
        return true
      },
      onEnvelope(listener) {
        listeners.add(listener)
        return (): void => {
          listeners.delete(listener)
        }
      },
      request<T>(method: string, params?: unknown): Promise<T> {
        // 本组用例只驱动事件通道，不驱动宿主发起的反向 RPC；回包形状无所谓，但要把入参用掉
        // （eslint 的 no-unused-vars 对未使用形参会报错）
        return Promise.resolve({ ok: true, method, params } as unknown as T)
      }
    },
    push(raw: unknown): void {
      for (const listener of [...listeners]) listener(raw)
    }
  }
}

interface FakeAdapter extends HostedUiHostAdapter {
  /** overlayId → extId（模拟 core/host.ts 的 overlayOwners） */
  owners: Map<string, string>
  /** 登记次数（幂等/重建用例用来断言"旧登记被撤销"） */
  registrations: number
  /** 不带 registerHostedOverlayOwner 的适配器（旧版/缺能力） */
  withoutOverlayOwner(): HostedUiHostAdapter
}

function createFakeAdapter(): FakeAdapter {
  const owners = new Map<string, string>()
  const handlers = new Map<string, (channel: string, payload: unknown) => unknown>()
  let registrations = 0
  return {
    owners,
    get registrations(): number {
      return registrations
    },
    registerHostedAppMessageHandler(extId, handler) {
      handlers.set(extId, handler)
      return (): void => {
        handlers.delete(extId)
      }
    },
    registerHostedOverlayOwner(extId, overlayId) {
      registrations += 1
      owners.set(overlayId, extId)
      return (): void => {
        if (owners.get(overlayId) === extId) owners.delete(overlayId)
      }
    },
    withoutOverlayOwner(): HostedUiHostAdapter {
      return {
        registerHostedAppMessageHandler: (): (() => void) => (): void => undefined
      }
    }
  }
}

function makeConsumer(hostAdapter: HostedUiHostAdapter | undefined): {
  consumer: ExtensionHostConsumer
  channel: FakeTransport
} {
  const channel = createFakeTransport()
  const consumer = createExtensionHostConsumer({
    flag: '1',
    transport: channel.transport,
    ...(hostAdapter === undefined ? {} : { host: hostAdapter }),
    logger: uiLogger,
    readSettings: () => ({}),
    readLocale: () => 'zh',
    readThemeId: () => ''
  })
  consumers.push(consumer)
  return { consumer, channel }
}

const OVERLAY_OWNER_CHANNEL = HOSTED_UI_EVENT_CHANNELS.overlayOwner

function pushOwnerEvent(channel: FakeTransport, payload: Record<string, unknown>): void {
  channel.push(createEventEnvelope(OVERLAY_OWNER_CHANNEL, payload))
}

describe('渲染侧 consumer：归属的登记、注销与响亮失败', () => {
  test('bind 登记 overlayId → extId；重复 bind 只留一条登记；unbind 幂等注销', () => {
    const adapter = createFakeAdapter()
    const { channel } = makeConsumer(adapter)

    pushOwnerEvent(channel, { v: 1, op: 'bind', extId: 'pet.ext', overlayId: 'pet.main' })
    assert.equal(adapter.owners.get('pet.main'), 'pet.ext')
    assert.equal(adapter.registrations, 1)

    pushOwnerEvent(channel, { v: 1, op: 'bind', extId: 'pet.ext', overlayId: 'pet.main' })
    assert.equal(adapter.registrations, 2, '重复 bind 会重新登记')
    assert.equal(adapter.owners.get('pet.main'), 'pet.ext')

    pushOwnerEvent(channel, { v: 1, op: 'unbind', extId: 'pet.ext', overlayId: 'pet.main' })
    assert.equal(adapter.owners.has('pet.main'), false)
    // 幂等：再收一条 unbind 什么都不做（不抛错、不误删别人的）
    pushOwnerEvent(channel, { v: 1, op: 'unbind', extId: 'pet.ext', overlayId: 'pet.main' })
    assert.equal(adapter.owners.size, 0)
  })

  test('disposeExtension ⇒ 该扩展的归属一并撤销（不留脏 id）', () => {
    const adapter = createFakeAdapter()
    const { channel } = makeConsumer(adapter)
    pushOwnerEvent(channel, { v: 1, op: 'bind', extId: 'pet.ext', overlayId: 'pet.main' })
    pushOwnerEvent(channel, { v: 1, op: 'bind', extId: 'pet.ext', overlayId: 'pet.panel' })
    pushOwnerEvent(channel, { v: 1, op: 'bind', extId: 'other.ext', overlayId: 'other.main' })
    assert.equal(adapter.owners.size, 3)

    channel.push(
      createEventEnvelope('statusBar', { v: 1, kind: 'disposeExtension', extId: 'pet.ext' })
    )
    assert.deepEqual([...adapter.owners.entries()], [['other.main', 'other.ext']])
  })

  test('脏载荷与缺适配器都**响亮**：warn 且不登记（绝不静默丢）', () => {
    const adapter = createFakeAdapter()
    const { channel } = makeConsumer(adapter)

    pushOwnerEvent(channel, { v: 1, op: 'bind', extId: '', overlayId: 'pet.main' })
    pushOwnerEvent(channel, { v: 1, op: 'bind', extId: 'pet.ext', overlayId: '  ' })
    pushOwnerEvent(channel, { v: 1, op: 'explode', extId: 'pet.ext', overlayId: 'pet.main' })
    assert.equal(adapter.registrations, 0)
    assert.equal(
      uiLogs.filter(
        (log) => log.level === 'warn' && log.message.includes('overlay-owner 载荷不合法')
      ).length,
      3
    )

    const legacy = createFakeAdapter()
    const legacyConsumer = makeConsumer(legacy.withoutOverlayOwner())
    pushOwnerEvent(legacyConsumer.channel, {
      v: 1,
      op: 'bind',
      extId: 'pet.ext',
      overlayId: 'pet.main'
    })
    assert.equal(legacy.owners.size, 0)
    assert.ok(
      uiLogs.some(
        (log) => log.level === 'warn' && log.message.includes('没有 registerHostedOverlayOwner')
      ),
      '缺适配器必须留一条 warn（否则又是"看起来什么都没配"的静默失败）'
    )
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 5. core/host.ts：内部入口                                                                     */
/* -------------------------------------------------------------------------------------------- */

describe('core/host.ts：registerHostedOverlayOwner', () => {
  test('登记进 overlayOwners 并被 resolveMessageExtId 命中；注销后不再命中', () => {
    const off = host.registerHostedOverlayOwner('pet.ext', 'pet.main')
    assert.equal(hostPriv.overlayOwners.get('pet.main'), 'pet.ext')
    assert.equal(
      resolveMessageExtId('pet.main', () => undefined, hostPriv.overlayOwners),
      'pet.ext'
    )

    off()
    assert.equal(hostPriv.overlayOwners.has('pet.main'), false)
    assert.equal(
      resolveMessageExtId('pet.main', () => undefined, hostPriv.overlayOwners),
      undefined
    )
  })

  test('旧注销函数不误删新归属（overlayId 全局唯一，但热重载会重新登记）', () => {
    const first = host.registerHostedOverlayOwner('pet.ext', 'pet.main')
    const second = host.registerHostedOverlayOwner('other.ext', 'pet.main')
    assert.equal(hostPriv.overlayOwners.get('pet.main'), 'other.ext')

    first()
    assert.equal(hostPriv.overlayOwners.get('pet.main'), 'other.ext', '旧注销不该删别人的归属')
    second()
    assert.equal(hostPriv.overlayOwners.has('pet.main'), false)
  })

  test('参数校验：空 extensionId / 空 overlayId 一律抛中文错误', () => {
    assert.throws(
      () => host.registerHostedOverlayOwner('', 'pet.main'),
      /extensionId 必须是非空字符串/
    )
    assert.throws(
      () => host.registerHostedOverlayOwner('pet.ext', '  '),
      /overlayId 必须是非空字符串/
    )
  })
})
