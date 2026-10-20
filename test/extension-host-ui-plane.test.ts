/**
 * EH-B3b-1 · 注册面数据面单测（`ui-plane.ts` + `extensionHostConsumer.ts`）。
 *
 * 覆盖判据（任务卡要求 3 + 裁定 R68）：
 * 1. **接缝测试**（本卡最重要的一组）：main 把 `host-renderer` 的 port1 随 `init` transfer 给宿主
 *    → 宿主真的取到它 → `ui-plane` 真能在它上面 `postMessage`；以及**端口没到 ⇒ 抛
 *    `EH_NOT_READY`（文案含「host-renderer 端口未到」），绝不静默 no-op**。
 *    这条缝曾经断过（`port.ts` 只取 `event.data`、把 `ports` 丢了），而没人发现，因为每张卡都只测
 *    自己那一侧。所以这里**跨两侧**测：用真实的 `MessageEvent` 形状（`{ data, ports }`）喂进去。
 * 2. 每一类注册的**成功路径**：statusBar(5) / navbar.setBadge / registerCommand / executeCommand /
 *    views.registerTreeProvider / settings(4) / theme(2) / i18n(3) / app(2) / on·emit /
 *    workspaceState·globalState（memento 读写与隔离）。
 * 3. 渲染侧消费者把数据落到**正确的 store**（`registry` / `appStore` / `extensionSettingsStore` /
 *    `treeStore` / `stateStore`）。
 * 4. 回退开关关闭 ⇒ 消费者**不启动**（不订阅、不推快照）。
 * 5. 容错：未知 channel / 未知子操作 / 畸形信封一律记日志并丢弃，不抛错。
 *
 * 测试策略：宿主侧用**假端口**（不真起 utilityProcess），渲染侧用**假窄通道**（不真连 Electron），
 * 但两侧的载荷形状、channel 名、RPC method 名都是**真实常量**，并且有一条用例专门断言两侧常量一致
 * （防"改一边忘另一边"）。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'vitest'

import {
  EH_EVENT_CHANNELS,
  EhProtocolError,
  createEventEnvelope,
  createInitEnvelope,
  createRequestEnvelope,
  type Envelope,
  type EventEnvelope,
  type HostedExtensionInfo
} from '../src/shared/extensionHostProtocol'
import {
  createExtensionApi,
  listApiImplementation,
  type BuiltExtensionApi
} from '../src/extension-host/apiFactory'
import type { HostLogger } from '../src/extension-host/log'
import {
  createHostPortFromParentPort,
  createHostPortsFromParentPort,
  firstRendererPortOf,
  type HostRendererPortLike,
  type ParentPortLike
} from '../src/extension-host/port'
import { ExtensionHostRuntime } from '../src/extension-host/runtime'
import { createRunExtensionSafely } from '../src/extension-host/safety'
import {
  HOST_RENDERER_PORT_MISSING,
  UI_PLANE_PAYLOAD_VERSION,
  UI_PLANE_RPC,
  createMementoStore,
  createUiPlaneHub,
  ensureStateDir,
  parseUiPlaneManifest,
  readMementoFile,
  resetSharedUiPlaneHub,
  type UiPlaneHub
} from '../src/extension-host/capabilities/ui-plane'
import { appStore } from '../src/renderer/src/core/appStore'
import {
  HOSTED_UI_PAYLOAD_VERSION,
  HOSTED_UI_RPC,
  createExtensionHostConsumer,
  type ExtensionHostConsumer,
  type HostedUiHostAdapter,
  type HostedUiLogger,
  type HostedUiTransport
} from '../src/renderer/src/core/extensionHostConsumer'
import { extensionSettingsStore } from '../src/renderer/src/core/extensionSettings'
import { registry } from '../src/renderer/src/core/registry'
import { stateStore } from '../src/renderer/src/core/state'
import { treeStore } from '../src/renderer/src/core/treeStore'

/* -------------------------------------------------------------------------------------------- */
/* 夹具                                                                                          */
/* -------------------------------------------------------------------------------------------- */

const tempDirs: string[] = []
const createdHubs: UiPlaneHub[] = []
const createdConsumers: ExtensionHostConsumer[] = []
const logEntries: Array<{ level: string; message: string }> = []
/** 渲染侧消费者的日志（`HostedUiLogger` 形状：只有 message，没有 level 字段） */
const uiLogEntries: Array<{ level: string; message: string }> = []

const logger: HostLogger = (level, message, detail): void => {
  logEntries.push({ level, message: detail === undefined ? message : `${message}（${detail}）` })
}

const uiLogger: HostedUiLogger = {
  debug: (message): void => {
    uiLogEntries.push({ level: 'debug', message })
  },
  info: (message): void => {
    uiLogEntries.push({ level: 'info', message })
  },
  warn: (message): void => {
    uiLogEntries.push({ level: 'warn', message })
  },
  error: (message): void => {
    uiLogEntries.push({ level: 'error', message })
  }
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-b3b1-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async (): Promise<void> => {
  for (const consumer of createdConsumers.splice(0)) consumer.stop()
  for (const hub of createdHubs.splice(0)) hub.dispose()
  resetSharedUiPlaneHub()
  logEntries.length = 0
  uiLogEntries.length = 0
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 假渲染侧端口（`host-renderer` 的 port1）：记下宿主发出的信封，允许测试从"渲染侧"塞入站帧 */
interface FakeRendererPort {
  port: HostRendererPortLike
  /** 宿主 → 渲染侧：收到的信封（顺序） */
  received: Envelope[]
  /** 渲染侧 → 宿主：喂一条信封（模拟真实端口的 `{ data }` 事件） */
  receive(message: unknown): void
  /** 是否被 close（宿主退出时必须关端口） */
  closed(): boolean
}

function createFakeRendererPort(): FakeRendererPort {
  const received: Envelope[] = []
  let listener: ((event: unknown) => void) | null = null
  let closed = false
  const port: HostRendererPortLike = {
    postMessage(message: unknown): void {
      received.push(message as Envelope)
    },
    get onmessage(): ((event: unknown) => void) | null {
      return listener
    },
    set onmessage(value: ((event: unknown) => void) | null) {
      listener = value
    },
    close(): void {
      closed = true
      listener = null
    }
  }
  return {
    port,
    received,
    receive(message: unknown): void {
      // 真实 MessagePort 的事件形状是 `MessageEvent`：信封在 `data` 上
      listener?.({ data: message })
    },
    closed: (): boolean => closed
  }
}

/** 假 `process.parentPort`（只做 EventEmitter 的那点事：`on` / `off` / `postMessage`） */
interface FakeParentPort {
  parentPort: ParentPortLike
  /** main → 宿主：发一条消息事件（`ports` 是 transfer 列表） */
  emit(data: unknown, ports?: unknown[]): void
  /** 宿主 → main：收到的信封 */
  posted: unknown[]
}

function createFakeParentPort(): FakeParentPort {
  const handlers = new Set<(event: unknown) => void>()
  const posted: unknown[] = []
  return {
    parentPort: {
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
    },
    emit(data: unknown, ports?: unknown[]): void {
      const event = ports === undefined ? { data } : { data, ports }
      for (const handler of [...handlers]) handler(event)
    },
    posted
  }
}

/** 造一个纯数据扩展目录（写 manifest + 入口），返回 `HostedExtensionInfo` */
async function makeExtension(
  root: string,
  id: string,
  manifest?: Record<string, unknown>,
  source = 'export default () => {}\n'
): Promise<HostedExtensionInfo> {
  const dir = path.join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ name: id, main: 'index.mjs', ...manifest }),
    'utf8'
  )
  await writeFile(path.join(dir, 'index.mjs'), source, 'utf8')
  return { id, version: '1.0.0', path: dir, activationEvents: [], apiVersion: 3 }
}

/** 造一个绑定假端口的 hub 与那个假端口（每用例一份，互相隔离） */
function makeHub(port?: HostRendererPortLike): {
  hub: UiPlaneHub
  renderer: FakeRendererPort | null
} {
  const renderer = createFakeRendererPort()
  const target = port === undefined ? renderer.port : port
  const hub = createUiPlaneHub({ rendererPort: target, log: logger })
  createdHubs.push(hub)
  return { hub, renderer: target === renderer.port ? renderer : null }
}

/** 造一个**没有端口**的 hub（接缝/失败姿态用例） */
function makePortlessHub(): UiPlaneHub {
  const hub = createUiPlaneHub({ rendererPort: null, log: logger })
  createdHubs.push(hub)
  return hub
}

/** 造一个扩展级能力（走真实 `createExtensionApi`，只把 hub 换成注入的） */
async function makeApi(
  ext: HostedExtensionInfo,
  hub: UiPlaneHub,
  extra: Partial<Parameters<typeof createExtensionApi>[0]> = {}
): Promise<BuiltExtensionApi> {
  return createExtensionApi({
    ext,
    appInfo: { name: 'obox', version: '9.9.9' },
    locale: 'zh',
    log: logger,
    runSafely: createRunExtensionSafely(() => {}),
    uiPlane: hub,
    ...extra
  })
}

/** 取所有 `event` 信封里某个 channel 的载荷 */
function payloadsOf(received: Envelope[], channel: string): unknown[] {
  return received
    .filter((envelope): envelope is EventEnvelope => envelope.t === 'event')
    .filter((envelope) => envelope.channel === channel)
    .map((envelope) => envelope.payload)
}

/** 取第一个某 channel 的载荷（断言失败时给出更有用的消息） */
function firstPayload(received: Envelope[], channel: string): Record<string, unknown> {
  const payload = payloadsOf(received, channel)[0]
  assert.ok(payload !== undefined, `没有收到 channel=${channel} 的事件`)
  return payload as Record<string, unknown>
}

/** 让出几轮微任务（宿主的 `RpcServer` 处理 req 是异步的：`res` 在几跳之后才发） */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0)
    })
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 1. 接缝测试（main 放端口 → 宿主收端口 → ui-plane 真的发得出去）                                   */
/* -------------------------------------------------------------------------------------------- */

describe('接缝：host-renderer 端口（R68）', () => {
  test('init 的 MessageEvent.ports[0] 被取成渲染侧端口（不是被丢掉）', () => {
    const parent = createFakeParentPort()
    const ports = createHostPortsFromParentPort(parent.parentPort)
    const renderer = createFakeRendererPort()

    // 端口随 init 到达之前：明确为 null（不是"空对象"）
    assert.equal(ports.renderer, null)

    const received: unknown[] = []
    ports.main.subscribe((message) => received.push(message))

    const init = createInitEnvelope({ apiVersion: 3, dataDir: '/tmp/x', extensions: [] })
    parent.emit(init, [renderer.port])

    assert.deepEqual(received, [init], '主端口仍然拿到解包后的信封（既有语义不变）')
    assert.equal(ports.renderer, renderer.port, 'ports[0] 必须被取出来')
  })

  test('firstRendererPortOf：真实 MessageEvent 形状取端口；没带端口返回 null', () => {
    const renderer = createFakeRendererPort()
    assert.equal(firstRendererPortOf({ data: {}, ports: [renderer.port] }), renderer.port)
    assert.equal(firstRendererPortOf({ data: {} }), null, '没带 ports ⇒ null（不是抛错）')
    assert.equal(firstRendererPortOf({ data: {}, ports: [] }), null)
    assert.equal(firstRendererPortOf({ data: {}, ports: [{}] }), null, '形状不对的元素要跳过')
    assert.equal(firstRendererPortOf(null), null)
    assert.equal(firstRendererPortOf('nope'), null)
  })

  test('旧签名 createHostPortFromParentPort 仍可用（并同样捕获端口）', () => {
    const parent = createFakeParentPort()
    const port = createHostPortFromParentPort(parent.parentPort)
    const received: unknown[] = []
    port.subscribe((message) => received.push(message))
    const renderer = createFakeRendererPort()
    parent.emit({ t: 'x' }, [renderer.port])
    assert.deepEqual(received, [{ t: 'x' }])
    // 薄包装拿不到 renderer 句柄（签名只回 HostPort），但不应抛错：
    assert.equal(typeof port.post, 'function')
  })

  test('端口为空 ⇒ 送到渲染侧的调用抛 EH_NOT_READY（文案含「host-renderer 端口未到」）', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'no-port-ext')
    const hub = makePortlessHub()
    const built = await makeApi(ext, hub)

    assert.throws(
      () => built.api.statusBar.setText('x.item', 'hi'),
      (error: unknown): boolean => {
        assert.ok(error instanceof EhProtocolError, '必须是 EhProtocolError（可判定、可翻译）')
        assert.equal(error.code, 'EH_NOT_READY')
        assert.match(error.message, /host-renderer 端口未到/)
        return true
      },
      '端口没到必须响亮失败，不能静默 no-op'
    )
    assert.equal(HOST_RENDERER_PORT_MISSING.includes('host-renderer 端口未到'), true)
    // 端口没到时**不产生**任何信封（也不排队假成功）
    assert.equal(hub.sentCount(), 0)
  })

  test('ui-plane 在端口上 postMessage，端口另一端真的收到 event 信封', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'port-ext')
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    const built = await makeApi(ext, hub)

    built.api.statusBar.setText('port.item', '来自宿主')
    assert.equal(renderer.received.length, 1)
    const envelope = renderer.received[0] as EventEnvelope
    assert.equal(envelope.t, 'event')
    assert.equal(envelope.channel, EH_EVENT_CHANNELS.statusBar)
    assert.equal(hub.sentCount(), 1)
  })

  test('端到端接缝：真实 runtime 收到带端口的 init → 扩展的 statusBar 到达渲染侧', async () => {
    const dataDir = await makeTempDir()
    const ext = await makeExtension(
      dataDir,
      'seam-ext',
      { contributes: { statusBarItems: [{ id: 'seam.item', name: '接缝项' }] } },
      `export default (api) => {
  api.statusBar.setText('seam.item', '宿主里设置的文本')
  api.statusBar.show('seam.item')
}
`
    )
    const parent = createFakeParentPort()
    const ports = createHostPortsFromParentPort(parent.parentPort)
    const renderer = createFakeRendererPort()
    const runtime = new ExtensionHostRuntime({
      port: ports.main,
      rendererPort: () => ports.renderer,
      hostId: 'seam-host',
      pid: 4242,
      log: logger,
      echoLog: false
    })
    try {
      runtime.start()
      parent.emit(createInitEnvelope({ apiVersion: 3, dataDir, extensions: [ext] }), [
        renderer.port
      ])
      await runtime.settled()
      assert.equal(runtime.statusOf('seam-ext')?.state, 'active', '扩展必须被激活')

      const statusBarPayloads = payloadsOf(renderer.received, EH_EVENT_CHANNELS.statusBar)
      assert.ok(
        statusBarPayloads.length >= 2,
        `至少 setText + show 两条（实际 ${statusBarPayloads.length}）`
      )
      assert.deepEqual(statusBarPayloads[0], {
        v: UI_PLANE_PAYLOAD_VERSION,
        kind: 'setText',
        extId: 'seam-ext',
        id: 'seam.item',
        text: '宿主里设置的文本'
      })
      assert.deepEqual(statusBarPayloads[1], {
        v: UI_PLANE_PAYLOAD_VERSION,
        kind: 'setVisible',
        extId: 'seam-ext',
        id: 'seam.item',
        visible: true
      })
    } finally {
      runtime.dispose()
    }
  })

  test('宿主退出时关闭 host-renderer 端口（渲染侧才能知道链路断了）', () => {
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    assert.equal(renderer.closed(), false)
    hub.dispose()
    assert.equal(renderer.closed(), true)
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 2. statusBar（5 项）                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe('statusBar', () => {
  test('setText / setTooltip / show / hide 各发一条 statusBar 事件（带 extId 与项 id）', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'sb-ext')
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    const built = await makeApi(ext, hub)

    built.api.statusBar.setText('sb.item', '42%')
    built.api.statusBar.setTooltip('sb.item', '电量')
    built.api.statusBar.show('sb.item')
    built.api.statusBar.hide('sb.item')

    const applied = payloadsOf(renderer.received, EH_EVENT_CHANNELS.statusBar)
    assert.equal(applied.length, 4)
    assert.deepEqual(applied[0], {
      v: 1,
      kind: 'setText',
      extId: 'sb-ext',
      id: 'sb.item',
      text: '42%'
    })
    assert.deepEqual(applied[1], {
      v: 1,
      kind: 'setTooltip',
      extId: 'sb-ext',
      id: 'sb.item',
      tooltip: '电量'
    })
    assert.deepEqual(applied[2], {
      v: 1,
      kind: 'setVisible',
      extId: 'sb-ext',
      id: 'sb.item',
      visible: true
    })
    assert.deepEqual(applied[3], {
      v: 1,
      kind: 'setVisible',
      extId: 'sb-ext',
      id: 'sb.item',
      visible: false
    })
  })

  test('createItem：发 create 事件 + 句柄的 setter 继续发 setText/setTooltip/show/hide，dispose 发 dispose', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'sb-create')
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    const built = await makeApi(ext, hub)

    const item = built.api.statusBar.createItem({ text: '初始', alignment: 'left', priority: 5 })
    const created = firstPayload(renderer.received, EH_EVENT_CHANNELS.statusBar)
    assert.equal(created.kind, 'create')
    assert.equal(created.extId, 'sb-create')
    assert.deepEqual(created.init, { text: '初始', alignment: 'left', priority: 5 })
    const hostId = String(created.id)
    assert.match(hostId, /^host-runtime:sb-create:1$/, '宿主侧生成的项 id 必须按扩展隔离')

    assert.equal(item.text, '初始', '句柄读的是宿主侧影子值')
    item.text = '改过'
    item.tooltip = '提示'
    item.show()
    item.hide()
    item.dispose()

    const kinds = payloadsOf(renderer.received, EH_EVENT_CHANNELS.statusBar).map(
      (payload) => (payload as { kind: string }).kind
    )
    assert.deepEqual(kinds, [
      'create',
      'setText',
      'setTooltip',
      'setVisible',
      'setVisible',
      'dispose'
    ])
    // `undefined` 不能过桥：createItem({}) 也必须能发出去（字段缺省即不写）
    const second = built.api.statusBar.createItem()
    const createPayloads = payloadsOf(renderer.received, EH_EVENT_CHANNELS.statusBar).filter(
      (payload) => (payload as { kind: string }).kind === 'create'
    )
    assert.deepEqual(
      (createPayloads[1] as { init: unknown }).init,
      {},
      '缺省字段不能变成 undefined'
    )
    second.dispose()
  })

  test('statusBar 的文本必须是可传输的字符串（传函数 ⇒ EH_UNSERIALIZABLE + 字段路径）', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'sb-bad')
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    const built = await makeApi(ext, hub)

    assert.throws(
      () => built.api.statusBar.setText('sb.item', (() => {}) as unknown as string),
      (error: unknown): boolean => {
        assert.ok(error instanceof EhProtocolError)
        assert.equal(error.code, 'EH_UNSERIALIZABLE')
        assert.match(error.message, /payload\(statusBar\)\.text/)
        return true
      }
    )
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 3. navbar.setBadge / registerCommand / executeCommand                                          */
/* -------------------------------------------------------------------------------------------- */

describe('navbar 与命令', () => {
  test('navbar.setBadge 复用 views 通道（kind=navBadge；undefined ⇒ null）', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'nav-ext')
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    const built = await makeApi(ext, hub)

    built.api.navbar.setBadge('nav.item', 3)
    built.api.navbar.setBadge('nav.item', undefined)

    const applied = payloadsOf(renderer.received, EH_EVENT_CHANNELS.views)
    assert.deepEqual(applied, [
      { v: 1, kind: 'navBadge', extId: 'nav-ext', id: 'nav.item', count: 3 },
      { v: 1, kind: 'navBadge', extId: 'nav-ext', id: 'nav.item', count: null }
    ])
  })

  test('registerCommand：发 commands 事件（带 manifest 标题）；未声明时告警但不抛；dispose 发 dispose', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'cmd-ext', {
      contributes: { commands: [{ command: 'cmd-ext.run', title: '跑一下' }] }
    })
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    const built = await makeApi(ext, hub)

    const declared = built.api.registerCommand('cmd-ext.run', () => 'ok')
    assert.deepEqual(firstPayload(renderer.received, EH_EVENT_CHANNELS.commands), {
      v: 1,
      op: 'register',
      extId: 'cmd-ext',
      command: 'cmd-ext.run',
      title: '跑一下'
    })

    // 未在 manifest 声明的命令：宿主照旧登记（v1 同语义），但必须留下一条 warn
    const undeclared = built.api.registerCommand('cmd-ext.undeclared', () => 'x')
    assert.ok(
      logEntries.some(
        (entry) => entry.level === 'warn' && entry.message.includes('未在 manifest 声明')
      ),
      '未声明的命令要告警'
    )
    const registerPayloads = payloadsOf(renderer.received, EH_EVENT_CHANNELS.commands)
    assert.equal((registerPayloads[1] as { title?: string }).title, undefined)

    declared.dispose()
    undeclared.dispose()
    const ops = payloadsOf(renderer.received, EH_EVENT_CHANNELS.commands).map(
      (payload) => (payload as { op: string }).op
    )
    assert.deepEqual(ops, ['register', 'register', 'dispose', 'dispose'])
  })

  test('executeCommand 在宿主内跨扩展执行；未知命令抛 command not found（v1 文案）', async () => {
    const root = await makeTempDir()
    const alpha = await makeExtension(root, 'alpha')
    const beta = await makeExtension(root, 'beta')
    const { hub } = makeHub()
    const alphaApi = await makeApi(alpha, hub)
    const betaApi = await makeApi(beta, hub)

    alphaApi.api.registerCommand('alpha.greet', (name: unknown) => `hi ${String(name)}`)
    // 另一个扩展执行它（命令表是进程级共享的，与 v1 的 registry.commands 同语义）
    assert.equal(await betaApi.api.executeCommand('alpha.greet', 'bob'), 'hi bob')

    await assert.rejects(
      async () => await betaApi.api.executeCommand('nope.missing'),
      (error: unknown): boolean => {
        assert.match(String((error as Error).message), /command not found: nope\.missing/)
        return true
      }
    )
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 4. views.registerTreeProvider                                                                 */
/* -------------------------------------------------------------------------------------------- */

describe('views.registerTreeProvider', () => {
  test('注册发 views 事件；渲染侧经 ui.treeChildren 问回 provider；dispose 后报未知扩展', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'tree-ext')
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    const built = await makeApi(ext, hub)

    const provider = {
      getChildren: (element?: { id: string }): Array<{ id: string; label: string }> =>
        element ? [{ id: `${element.id}.child`, label: '子' }] : [{ id: 'root', label: '根' }]
    }
    const disposable = built.api.views.registerTreeProvider('tree-ext.view', provider)
    assert.deepEqual(firstPayload(renderer.received, EH_EVENT_CHANNELS.views), {
      v: 1,
      kind: 'treeProvider',
      op: 'register',
      extId: 'tree-ext',
      viewId: 'tree-ext.view'
    })

    // 反向调用（渲染侧 → 宿主）：走 req 信封，宿主的 RpcServer 应答
    renderer.receive(
      createRequestEnvelope(1, UI_PLANE_RPC.treeChildren, {
        extId: 'tree-ext',
        viewId: 'tree-ext.view',
        element: null
      })
    )
    await flush()
    const response = renderer.received.find((envelope) => envelope.t === 'res')
    assert.ok(response, '必须回 res 信封')
    assert.deepEqual((response as { result: unknown }).result, [{ id: 'root', label: '根' }])

    disposable.dispose()
    const ops = payloadsOf(renderer.received, EH_EVENT_CHANNELS.views).map(
      (payload) => (payload as { op?: string }).op
    )
    assert.deepEqual(ops, ['register', 'dispose'])
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 5. settings / theme / i18n                                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('settings', () => {
  test('快照到达前 get 返回缺省值并留痕；快照到达后读缓存，onChanged 只按变化的 key 通知', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'set-ext')
    const { hub } = makeHub()
    const built = await makeApi(ext, hub)

    assert.equal(built.api.settings.get('set.key', 'default'), 'default')
    assert.ok(
      logEntries.some(
        (entry) => entry.level === 'warn' && entry.message.includes('数据面快照还没到')
      ),
      '冷缓存读取必须留痕（不许静默返回缺省值）'
    )

    const changed: string[] = []
    built.api.settings.onChanged((key) => changed.push(key))

    // 第一次快照 = 初始化校准：**不**通知 onChanged（v1 的 onSettingsChanged 也不在加载时响一次）
    hub.handleRendererMessage(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'snapshot',
        settings: { 'set.key': 'from-renderer', 'other.key': 1 },
        locale: 'zh',
        themeId: 'theme-dark.dark'
      })
    )
    assert.equal(built.api.settings.get('set.key'), 'from-renderer')
    assert.deepEqual(changed, [], '初始化校准不算"变化"')

    // 只改一个键 ⇒ 只通知它（v1 的 onSettingsChanged 也带具体 key）
    hub.handleRendererMessage(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'snapshot',
        settings: { 'set.key': 'next', 'other.key': 1 },
        locale: 'zh',
        themeId: 'theme-dark.dark'
      })
    )
    assert.deepEqual(changed, ['set.key'])
    // 再推一份一模一样的：没有变化就不通知
    hub.handleRendererMessage(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'snapshot',
        settings: { 'set.key': 'next', 'other.key': 1 },
        locale: 'zh',
        themeId: 'theme-dark.dark'
      })
    )
    assert.deepEqual(changed, ['set.key'], '无变化时不得重复通知')
  })

  test('register 发 registerPage，dispose 只撤自己那一页；set / unset 发对应子操作', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'page-ext')
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    const built = await makeApi(ext, hub)

    const page = { id: 'page-ext.settings', title: '设置', fields: [] }
    const disposable = built.api.settings.register(page)
    assert.deepEqual(firstPayload(renderer.received, EH_EVENT_CHANNELS.settings), {
      v: 1,
      op: 'registerPage',
      extId: 'page-ext',
      page
    })
    built.api.settings.set('page-ext.enabled', true)
    built.api.settings.set('page-ext.enabled', undefined)
    disposable.dispose()

    const ops = payloadsOf(renderer.received, EH_EVENT_CHANNELS.settings).map(
      (payload) => (payload as { op: string }).op
    )
    assert.deepEqual(ops, ['registerPage', 'set', 'unset', 'disposePage'])
    assert.deepEqual(payloadsOf(renderer.received, EH_EVENT_CHANNELS.settings)[3], {
      v: 1,
      op: 'disposePage',
      extId: 'page-ext',
      pageId: 'page-ext.settings'
    })
  })
})

describe('theme', () => {
  test('getCurrent 读快照；onChanged 只在主题真的变化时通知', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'theme-ext')
    const { hub } = makeHub()
    const built = await makeApi(ext, hub)

    assert.equal(built.api.theme.getCurrent(), '', '快照未到时是空串（缓存未校准）')
    const changes: string[] = []
    built.api.theme.onChanged((id) => changes.push(id))

    // 第一次快照是校准，不通知（v1 的 theme.onChanged 也不在激活时响一次）
    hub.handleRendererMessage(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'snapshot',
        settings: {},
        locale: 'zh',
        themeId: 'theme-dark.dark'
      })
    )
    assert.equal(built.api.theme.getCurrent(), 'theme-dark.dark')
    assert.deepEqual(changes, [], '初始化校准不通知')

    // 真的换主题：通知一次
    hub.handleRendererMessage(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'snapshot',
        settings: {},
        locale: 'zh',
        themeId: 'theme-light.light'
      })
    )
    assert.deepEqual(changes, ['theme-light.light'])

    // 同一主题再推一次：不该再通知
    hub.handleRendererMessage(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'snapshot',
        settings: {},
        locale: 'zh',
        themeId: 'theme-light.light'
      })
    )
    assert.deepEqual(changes, ['theme-light.light'])
  })
})

describe('i18n', () => {
  test('t 用 manifest 语言包（含 {参数} 替换与 zh 回退）；registerMessages 追加；语言变化触发 onLocaleChanged', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'i18n-ext', {
      contributes: {
        i18n: { zh: { greet: '你好 {name}', only: '只有中文' }, en: { greet: 'Hello {name}' } }
      }
    })
    const { hub } = makeHub()
    const built = await makeApi(ext, hub)

    assert.equal(built.api.i18n.t('greet', { name: '世界' }), '你好 世界')
    assert.equal(built.api.i18n.t('only'), '只有中文')
    assert.equal(built.api.i18n.t('missing.key'), 'missing.key', '缺 key 返回 key 本身')

    built.api.i18n.registerMessages({ zh: { extra: '运行时追加' }, en: { extra: 'runtime' } })
    assert.equal(built.api.i18n.t('extra'), '运行时追加')

    const locales: string[] = []
    built.api.i18n.onLocaleChanged((locale) => locales.push(locale))
    // 第一次快照是校准（不通知）：先把 locale 校准成 zh
    hub.handleRendererMessage(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'snapshot',
        settings: {},
        locale: 'zh',
        themeId: ''
      })
    )
    assert.deepEqual(locales, [], '初始化校准不通知 onLocaleChanged')

    // 真的切到 en：通知一次
    hub.handleRendererMessage(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'snapshot',
        settings: {},
        locale: 'en',
        themeId: ''
      })
    )
    assert.equal(built.api.i18n.locale, 'en')
    assert.equal(built.api.i18n.t('greet', { name: 'World' }), 'Hello World')
    assert.equal(built.api.i18n.t('only'), '只有中文', 'en 缺这条时回退 zh')
    assert.deepEqual(locales, ['en'])
  })

  test('parseUiPlaneManifest：畸形清单退化成空清单（不抛）', () => {
    assert.deepEqual(parseUiPlaneManifest('{'), { messages: {}, commandTitles: new Map() })
    assert.deepEqual(parseUiPlaneManifest('[]'), { messages: {}, commandTitles: new Map() })
    const parsed = parseUiPlaneManifest(
      JSON.stringify({
        contributes: { i18n: { zh: { a: '1', bad: 2 } }, commands: [{ command: 'c', title: 't' }] }
      })
    )
    assert.deepEqual(parsed.messages, { zh: { a: '1' } }, '非字符串文案被丢掉')
    assert.equal(parsed.commandTitles.get('c'), 't')
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 6. app / 事件总线 / memento                                                                   */
/* -------------------------------------------------------------------------------------------- */

describe('app 与事件总线', () => {
  test('app.register 发 app.register 事件；onMessage 经 ui.appMessage 派发（结果回 res）', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'app-ext')
    const renderer = createFakeRendererPort()
    const { hub } = makeHub(renderer.port)
    const built = await makeApi(ext, hub)

    const registration = {
      id: 'app-ext.card',
      name: '卡片',
      version: '1.0.0',
      icon: '<svg/>',
      url: 'app://extensions/app-ext/index.html'
    }
    const disposable = built.api.app.register(registration)
    assert.deepEqual(firstPayload(renderer.received, EH_EVENT_CHANNELS.appRegister), {
      v: 1,
      op: 'register',
      extId: 'app-ext',
      registration
    })

    built.api.app.onMessage((channel, payload) => ({
      echo: `${channel}:${JSON.stringify(payload)}`
    }))
    // onMessage 必须先告诉渲染侧"消息可以往我这里寻址"（否则消息桥只会回「未注册消息处理器」）
    const appPayloads = payloadsOf(renderer.received, EH_EVENT_CHANNELS.appRegister)
    assert.deepEqual(appPayloads[1], {
      v: 1,
      op: 'messageHandler',
      extId: 'app-ext'
    })
    renderer.receive(
      createRequestEnvelope(7, UI_PLANE_RPC.appMessage, {
        extId: 'app-ext',
        channel: 'ping',
        payload: { a: 1 }
      })
    )
    await flush()
    const response = renderer.received.find((envelope) => envelope.t === 'res')
    assert.ok(response)
    assert.deepEqual((response as { result: unknown }).result, { echo: 'ping:{"a":1}' })

    // 没有注册处理器的扩展：回 err（EH_UNKNOWN_EXT），不是静默丢弃
    renderer.receive(
      createRequestEnvelope(8, UI_PLANE_RPC.appMessage, {
        extId: 'ghost',
        channel: 'x',
        payload: null
      })
    )
    await flush()
    const failure = renderer.received.find((envelope) => envelope.t === 'err')
    assert.ok(failure)
    assert.equal((failure as { code: string }).code, 'EH_UNKNOWN_EXT')

    disposable.dispose()
    // register + messageHandler + dispose 三条（顺序即契约）
    const appKinds = payloadsOf(renderer.received, EH_EVENT_CHANNELS.appRegister).map(
      (payload) => (payload as { op: string }).op
    )
    assert.deepEqual(appKinds, ['register', 'messageHandler', 'dispose'])
  })

  test('on / emit 是宿主内事件总线（跨扩展可见；订阅者抛错不打断别人）', async () => {
    const root = await makeTempDir()
    const alpha = await makeExtension(root, 'bus-alpha')
    const beta = await makeExtension(root, 'bus-beta')
    const { hub } = makeHub()
    const alphaApi = await makeApi(alpha, hub)
    const betaApi = await makeApi(beta, hub)

    const seen: string[] = []
    alphaApi.api.on('tick', (value) => seen.push(`alpha:${String(value)}`))
    betaApi.api.on('tick', (value) => {
      seen.push(`beta:${String(value)}`)
      throw new Error('订阅者抛错')
    })
    betaApi.api.emit('tick', 1)
    assert.deepEqual(seen, ['alpha:1', 'beta:1'], '两个订阅者都收到（抛错不影响别人）')
    assert.ok(
      logEntries.some((entry) => entry.level === 'error' && entry.message.includes('订阅者抛错'))
    )
  })
})

describe('memento（workspaceState / globalState）', () => {
  test('workspace 与 global 是两份文件、两套键空间（互相隔离）', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'memento-ext')
    const { hub } = makeHub()
    const built = await makeApi(ext, hub)

    await built.api.workspaceState.update('tab', 'workspace-value')
    await built.api.globalState.update('tab', 'global-value')

    assert.equal(built.api.workspaceState.get('tab'), 'workspace-value')
    assert.equal(built.api.globalState.get('tab'), 'global-value')
    assert.deepEqual(built.api.workspaceState.keys(), ['tab'])
    assert.deepEqual(built.api.globalState.keys(), ['tab'])

    const stateDir = ensureStateDir(path.join(ext.path, 'data'))
    const workspace = await readMementoFile(path.join(stateDir, 'workspace.json'))
    const global = await readMementoFile(path.join(stateDir, 'global.json'))
    assert.deepEqual(workspace, { tab: 'workspace-value' })
    assert.deepEqual(global, { tab: 'global-value' })

    // undefined = 删除（与 v1 的 `stateStore.memento().update` 同语义）
    await built.api.workspaceState.update('tab', undefined)
    assert.equal(built.api.workspaceState.get('tab', 'fallback'), 'fallback')
    assert.deepEqual(built.api.workspaceState.keys(), [])
  })

  test('跨扩展隔离：两个扩展各写各的 data 目录，键不串味', async () => {
    const root = await makeTempDir()
    const alpha = await makeExtension(root, 'memento-alpha')
    const beta = await makeExtension(root, 'memento-beta')
    const { hub } = makeHub()
    const alphaApi = await makeApi(alpha, hub)
    const betaApi = await makeApi(beta, hub)

    await alphaApi.api.globalState.update('who', 'alpha')
    await betaApi.api.globalState.update('who', 'beta')
    assert.equal(alphaApi.api.globalState.get('who'), 'alpha')
    assert.equal(betaApi.api.globalState.get('who'), 'beta')
    assert.notEqual(
      path.join(alpha.path, 'data'),
      path.join(beta.path, 'data'),
      '两个扩展的 data 目录必须不同'
    )
  })

  test('落盘后新实例能读到（重启语义）；畸形/缺失文件当空存储', async () => {
    const dir = await makeTempDir()
    const file = path.join(dir, 'state', 'global.json')
    const first = createMementoStore(file)
    await first.update('count', 3)
    assert.equal(first.get('count'), 3)

    const second = createMementoStore(file)
    assert.equal(second.get('count'), 3, '新实例（= 下次启动）必须读到已落盘的值')
    assert.deepEqual(second.keys(), ['count'])

    await writeFile(file, '{ 坏 JSON', 'utf8')
    const broken = createMementoStore(file)
    assert.deepEqual(broken.keys(), [], '畸形文件当空存储（不抛错，扩展照常激活）')
    const text = await readFile(file, 'utf8')
    assert.equal(text, '{ 坏 JSON', '读坏文件不改写它（留给用户/工具修）')
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 7. 渲染侧消费者                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** 假窄通道：记下推送、允许测试塞入站信封、可编排反向调用的返回值 */
interface FakeUiTransport {
  transport: HostedUiTransport
  posted: Envelope[]
  requests: Array<{ method: string; params: unknown }>
  push(raw: unknown): void
  firePort(): void
  subscribed(): boolean
  unsubscribeCount(): number
}

function createFakeUiTransport(): FakeUiTransport {
  const listeners = new Set<(raw: unknown) => void>()
  const portListeners = new Set<() => void>()
  const posted: Envelope[] = []
  const requests: Array<{ method: string; params: unknown }> = []
  let unsubscribeCount = 0
  return {
    posted,
    requests,
    transport: {
      post(envelope: Envelope): boolean {
        posted.push(envelope)
        return true
      },
      onEnvelope(listener) {
        listeners.add(listener)
        return (): void => {
          unsubscribeCount += 1
          listeners.delete(listener)
        }
      },
      request<T>(method: string, params?: unknown): Promise<T> {
        requests.push({ method, params })
        return Promise.resolve({ ok: true } as T)
      },
      onPort(listener) {
        portListeners.add(listener)
        return (): void => {
          unsubscribeCount += 1
          portListeners.delete(listener)
        }
      }
    },
    push(raw: unknown): void {
      for (const listener of [...listeners]) listener(raw)
    },
    firePort(): void {
      for (const listener of [...portListeners]) listener()
    },
    subscribed: (): boolean => listeners.size > 0,
    unsubscribeCount: (): number => unsubscribeCount
  }
}

/** 假 host 适配器（`core/host.ts` 的那一条内部入口） */
interface FakeHostAdapter extends HostedUiHostAdapter {
  handlers: Map<string, (channel: string, payload: unknown) => unknown | Promise<unknown>>
}

function createFakeHostAdapter(): FakeHostAdapter {
  const handlers = new Map<
    string,
    (channel: string, payload: unknown) => unknown | Promise<unknown>
  >()
  return {
    handlers,
    registerHostedAppMessageHandler(extensionId, handler) {
      handlers.set(extensionId, handler)
      return (): void => {
        if (handlers.get(extensionId) === handler) handlers.delete(extensionId)
      }
    }
  }
}

/** 造一个消费者（开关默认打开；注入一切依赖，单测不碰 window/localStorage） */
function makeConsumer(options: Partial<Parameters<typeof createExtensionHostConsumer>[0]> = {}): {
  consumer: ExtensionHostConsumer
  channel: FakeUiTransport
  host: FakeHostAdapter
} {
  const channel = createFakeUiTransport()
  const host = createFakeHostAdapter()
  const consumer = createExtensionHostConsumer({
    flag: '1',
    transport: channel.transport,
    host,
    logger: uiLogger,
    readSettings: () => ({ 'from.renderer': 1 }),
    readLocale: () => 'en',
    readThemeId: () => 'theme-dark.dark',
    ...options
  })
  createdConsumers.push(consumer)
  return { consumer, channel, host }
}

describe('消费者：开关与启动', () => {
  test('回退开关关闭 ⇒ 消费者不启动（不订阅、不推快照、不做任何事）', () => {
    for (const flag of [null, '', '0', 'false', 'yes']) {
      const channel = createFakeUiTransport()
      const consumer = createExtensionHostConsumer({
        flag,
        transport: channel.transport,
        logger: uiLogger,
        readSettings: () => ({})
      })
      createdConsumers.push(consumer)
      assert.equal(consumer.enabled, false, `flag=${String(flag)} 必须是关闭`)
      assert.equal(channel.posted.length, 0, '关闭时不许推快照')
      assert.equal(channel.subscribed(), false, '关闭时不许订阅')
      consumer.handleEnvelope(createEventEnvelope('statusBar', { kind: 'setText' }))
      assert.equal(consumer.stats().commands, 0, '关闭时空操作')
    }
  })

  test('开关打开 ⇒ 订阅 + 立刻推设置快照；端口到达与设置变化时再推', () => {
    const { channel, consumer } = makeConsumer()
    assert.equal(consumer.enabled, true)
    assert.equal(channel.subscribed(), true)
    assert.equal(channel.posted.length, 1, '启动即推一次快照')
    const first = channel.posted[0] as EventEnvelope
    assert.equal(first.t, 'event')
    assert.equal(first.channel, EH_EVENT_CHANNELS.settings)
    assert.deepEqual(first.payload, {
      v: HOSTED_UI_PAYLOAD_VERSION,
      op: 'snapshot',
      settings: { 'from.renderer': 1 },
      locale: 'en',
      themeId: 'theme-dark.dark'
    })

    channel.firePort()
    assert.equal(channel.posted.length, 2, '端口到达要补推（首次 post 一定失败）')

    stateStore.setSetting('eh-b3b1.consumer.key', 7)
    assert.equal(channel.posted.length, 3, '设置变化要再推一次快照')

    const before = channel.unsubscribeCount()
    consumer.stop()
    assert.ok(channel.unsubscribeCount() > before, 'stop 必须退订')
    consumer.stop()
    assert.equal(consumer.enabled, true)
  })
})

describe('消费者：状态栏落到 registry', () => {
  test('静态项原地改（setText/setTooltip/setVisible）；动态项 create/dispose 走 runtimeStatusBarItems', () => {
    const extId = 'consumer-sb'
    registry.registerStatusBarItem(extId, { id: 'consumer-sb.static', name: '静态项' })
    const { consumer, channel } = makeConsumer()

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.statusBar, {
        v: 1,
        kind: 'create',
        extId,
        id: 'host-1',
        init: { text: '动态', alignment: 'left', priority: 2 }
      })
    )
    assert.equal(consumer.stats().runtimeStatusBarItems, 1)
    const runtime = registry.runtimeStatusBarItems.find((item) => item.extensionId === extId)
    assert.ok(runtime, '动态项要进 runtimeStatusBarItems')
    assert.equal(runtime.text, '动态')
    assert.equal(runtime.alignment, 'left')

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.statusBar, {
        v: 1,
        kind: 'setText',
        extId,
        id: 'host-1',
        text: '动态改过'
      })
    )
    assert.equal(runtime.text, '动态改过')

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.statusBar, {
        v: 1,
        kind: 'setTooltip',
        extId,
        id: 'consumer-sb.static',
        tooltip: '静态提示'
      })
    )
    assert.equal(registry.getStatusBarItem('consumer-sb.static')?.tooltip, '静态提示')

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.statusBar, {
        v: 1,
        kind: 'setVisible',
        extId,
        id: 'consumer-sb.static',
        visible: false
      })
    )
    assert.equal(registry.getStatusBarItem('consumer-sb.static')?.visible, false)
    assert.equal(
      registry.getVisibleStatusBarItems('right').some((item) => item.id === 'consumer-sb.static'),
      false,
      'hidden 之后不再出现在可见列表里'
    )

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.statusBar, {
        v: 1,
        kind: 'dispose',
        extId,
        id: 'host-1'
      })
    )
    assert.equal(consumer.stats().runtimeStatusBarItems, 0)
    assert.equal(
      registry.runtimeStatusBarItems.some((item) => item.extensionId === extId),
      false
    )
  })

  test('导航徽标落到 registry.setNavBadge（null = 清除）', () => {
    const extId = 'consumer-nav'
    registry.registerNavItem(extId, { id: 'consumer-nav.item', title: '导航', icon: '<svg/>' })
    const { channel } = makeConsumer()

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.views, {
        v: 1,
        kind: 'navBadge',
        extId,
        id: 'consumer-nav.item',
        count: 4
      })
    )
    assert.equal(registry.navItems.find((item) => item.id === 'consumer-nav.item')?.badgeCount, 4)

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.views, {
        v: 1,
        kind: 'navBadge',
        extId,
        id: 'consumer-nav.item',
        count: null
      })
    )
    assert.equal(
      registry.navItems.find((item) => item.id === 'consumer-nav.item')?.badgeCount,
      undefined
    )
  })
})

describe('消费者：命令 / 树 / App / 设置页', () => {
  test('commands 事件给已声明命令绑 proxy handler；调用即 ui.executeCommand', async () => {
    const extId = 'consumer-cmd'
    registry.registerCommand(extId, { command: 'consumer-cmd.run', title: '跑' })
    const { consumer, channel } = makeConsumer()

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.commands, {
        v: 1,
        op: 'register',
        extId,
        command: 'consumer-cmd.run',
        title: '跑'
      })
    )
    assert.equal(consumer.stats().commands, 1)
    const found = registry.commands.find((command) => command.command === 'consumer-cmd.run')
    assert.ok(found?.handler, '命令必须有 handler 才能在命令面板里执行')

    await found.handler('a', 1)
    assert.deepEqual(channel.requests[0], {
      method: HOSTED_UI_RPC.executeCommand,
      params: { command: 'consumer-cmd.run', args: ['a', 1] }
    })

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.commands, {
        v: 1,
        op: 'dispose',
        extId,
        command: 'consumer-cmd.run'
      })
    )
    assert.equal(consumer.stats().commands, 0)
    assert.equal(
      registry.commands.find((command) => command.command === 'consumer-cmd.run')?.handler,
      undefined
    )
  })

  test('未声明的命令：告警但不抛（别的扩展照常绑定）', () => {
    const { channel } = makeConsumer()
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.commands, {
        v: 1,
        op: 'register',
        extId: 'consumer-cmd-undeclared',
        command: 'consumer-cmd-undeclared.nope'
      })
    )
    assert.ok(
      uiLogEntries.some((entry) => entry.level === 'warn' && entry.message.includes('无法绑定实现'))
    )
  })

  test('treeProvider 落到 treeStore，getChildren 经 ui.treeChildren 问回宿主', async () => {
    const extId = 'consumer-tree'
    const { channel } = makeConsumer()
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.views, {
        v: 1,
        kind: 'treeProvider',
        op: 'register',
        extId,
        viewId: 'consumer-tree.view'
      })
    )
    const provider = treeStore.getProvider('consumer-tree.view', extId)
    assert.ok(provider, 'provider 必须注册进 treeStore（按扩展隔离的键）')
    await provider.getChildren({ id: 'node-1', label: '节点' })
    assert.deepEqual(channel.requests[0], {
      method: HOSTED_UI_RPC.treeChildren,
      params: { extId, viewId: 'consumer-tree.view', element: { id: 'node-1', label: '节点' } }
    })

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.views, {
        v: 1,
        kind: 'treeProvider',
        op: 'dispose',
        extId,
        viewId: 'consumer-tree.view'
      })
    )
    assert.equal(treeStore.getProvider('consumer-tree.view', extId), undefined)
  })

  test('app.register 落到 appStore；messageHandler 经 host 适配器登记且能派发', async () => {
    const extId = 'consumer-app'
    const { channel, host } = makeConsumer()
    const registration = { id: 'consumer-app.card', name: '卡片', version: '1.0.0', icon: '<svg/>' }
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.appRegister, {
        v: 1,
        op: 'register',
        extId,
        registration
      })
    )
    assert.equal(appStore.findById('consumer-app.card')?.extensionId, extId)

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.appRegister, {
        v: 1,
        op: 'messageHandler',
        extId
      })
    )
    const handler = host.handlers.get(extId)
    assert.ok(handler, '消息处理器必须挂进 host（既有消息桥的归属路由）')
    await handler('ping', { n: 1 })
    assert.deepEqual(channel.requests[0], {
      method: HOSTED_UI_RPC.appMessage,
      params: { extId, channel: 'ping', payload: { n: 1 } }
    })

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.appRegister, {
        v: 1,
        op: 'dispose',
        extId,
        appId: 'consumer-app.card'
      })
    )
    assert.equal(appStore.findById('consumer-app.card'), undefined)
  })

  test('settings 页落到 extensionSettingsStore；set / unset 落到 stateStore', () => {
    const extId = 'consumer-page'
    const { channel } = makeConsumer()
    const page = { id: 'consumer-page.settings', title: '设置', fields: [] }
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'registerPage',
        extId,
        page
      })
    )
    assert.deepEqual(
      extensionSettingsStore.byExtension(extId).map((item) => item.id),
      ['consumer-page.settings']
    )

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'set',
        key: 'consumer-page.key',
        value: 'hello'
      })
    )
    assert.equal(stateStore.getSetting('consumer-page.key'), 'hello')

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'unset',
        key: 'consumer-page.key'
      })
    )
    assert.equal(stateStore.getSetting('consumer-page.key'), undefined)

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'disposePage',
        extId,
        pageId: 'consumer-page.settings'
      })
    )
    assert.deepEqual(extensionSettingsStore.byExtension(extId), [])
  })
})

describe('消费者：容错与整体清理', () => {
  test('未知 channel / 已知但不消费的 channel / 未知子操作 / 畸形信封都不抛错', () => {
    const { consumer, channel } = makeConsumer()
    assert.doesNotThrow(() => {
      channel.push(createEventEnvelope('future.channel', { anything: true }))
      channel.push(createEventEnvelope(EH_EVENT_CHANNELS.bubble, { text: '气泡' }))
      channel.push(createEventEnvelope(EH_EVENT_CHANNELS.cardIcon, { icon: '<svg/>' }))
      channel.push(createEventEnvelope(EH_EVENT_CHANNELS.statusBar, { kind: 'no-such-kind' }))
      channel.push(createEventEnvelope(EH_EVENT_CHANNELS.settings, { op: 'no-such-op' }))
      channel.push(createEventEnvelope(EH_EVENT_CHANNELS.statusBar, 'not-an-object'))
      // 畸形信封（缺 channel）
      channel.push({ v: 1, t: 'event' })
      // 完全不是信封
      channel.push({ hello: 'world' })
    })
    assert.ok(consumer.stats().commands === 0)
    assert.ok(
      uiLogEntries.some(
        (entry) => entry.level === 'debug' && entry.message.includes('未知 channel')
      ),
      '未知 channel 至少留一条 debug'
    )
    assert.ok(
      uiLogEntries.some((entry) => entry.level === 'warn' && entry.message.includes('畸形')),
      '畸形信封要 warn'
    )
  })

  test('disposeExtension 把该扩展的状态栏/命令/树/卡片/设置页/消息处理器全部撤掉', () => {
    const extId = 'consumer-cleanup'
    registry.registerCommand(extId, { command: 'consumer-cleanup.run', title: '跑' })
    registry.registerNavItem(extId, { id: 'consumer-cleanup.nav', title: '导航', icon: '<svg/>' })
    const { consumer, channel, host } = makeConsumer()

    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.statusBar, {
        v: 1,
        kind: 'create',
        extId,
        id: 'host-cleanup-1',
        init: { text: 'x' }
      })
    )
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.commands, {
        v: 1,
        op: 'register',
        extId,
        command: 'consumer-cleanup.run'
      })
    )
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.views, {
        v: 1,
        kind: 'treeProvider',
        op: 'register',
        extId,
        viewId: 'consumer-cleanup.view'
      })
    )
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.appRegister, {
        v: 1,
        op: 'register',
        extId,
        registration: {
          id: 'consumer-cleanup.card',
          name: '卡片',
          version: '1.0.0',
          icon: '<svg/>'
        }
      })
    )
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.settings, {
        v: 1,
        op: 'registerPage',
        extId,
        page: { id: 'consumer-cleanup.settings', title: '设置', fields: [] }
      })
    )
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.appRegister, { v: 1, op: 'messageHandler', extId })
    )

    assert.deepEqual(consumer.stats(), {
      runtimeStatusBarItems: 1,
      commands: 1,
      treeProviders: 1,
      appMessageHandlers: 1
    })

    // 宿主说"这个扩展没了"：一次 disposeExtension 全清（幂等）
    channel.push(
      createEventEnvelope(EH_EVENT_CHANNELS.statusBar, { v: 1, kind: 'disposeExtension', extId })
    )
    assert.deepEqual(consumer.stats(), {
      runtimeStatusBarItems: 0,
      commands: 0,
      treeProviders: 0,
      appMessageHandlers: 0
    })
    assert.equal(treeStore.getProvider('consumer-cleanup.view', extId), undefined)
    assert.equal(appStore.findById('consumer-cleanup.card'), undefined)
    assert.deepEqual(extensionSettingsStore.byExtension(extId), [])
    assert.equal(host.handlers.has(extId), false)

    assert.doesNotThrow(() => {
      channel.push(
        createEventEnvelope(EH_EVENT_CHANNELS.statusBar, { v: 1, kind: 'disposeExtension', extId })
      )
    })
  })
})

/* -------------------------------------------------------------------------------------------- */
/* 8. 两侧常量一致性 + 对照表                                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('两侧契约', () => {
  test('RPC method 名与载荷版本在两侧逐字一致（防"改一边忘另一边"）', () => {
    assert.deepEqual(UI_PLANE_RPC, HOSTED_UI_RPC)
    assert.equal(UI_PLANE_PAYLOAD_VERSION, HOSTED_UI_PAYLOAD_VERSION)
    // 用到的 channel 必须都是协议里已定义的（不新增 channel）
    const used = [
      EH_EVENT_CHANNELS.statusBar,
      EH_EVENT_CHANNELS.views,
      EH_EVENT_CHANNELS.commands,
      EH_EVENT_CHANNELS.appRegister,
      EH_EVENT_CHANNELS.settings
    ]
    assert.equal(new Set(used).size, 5)
    for (const channel of used) {
      assert.equal(typeof channel, 'string')
      assert.ok(channel.length > 0)
      assert.deepEqual(
        Object.values(EH_EVENT_CHANNELS).includes(channel as never),
        true,
        `${channel} 必须来自 EH_EVENT_CHANNELS`
      )
    }
  })

  test('对照表：EH-B3b-1 之后本卡 28 项全部是实现（不再抛「尚未迁移」）', async () => {
    const root = await makeTempDir()
    const ext = await makeExtension(root, 'table-b3b1')
    const { hub } = makeHub()
    const built = await makeApi(ext, hub)
    const rows = listApiImplementation(built.api)
    const thisCard = [
      'statusBar.setText',
      'statusBar.setTooltip',
      'statusBar.show',
      'statusBar.hide',
      'statusBar.createItem',
      'navbar.setBadge',
      'registerCommand',
      'executeCommand',
      'views.registerTreeProvider',
      'settings.register',
      'settings.get',
      'settings.set',
      'settings.onChanged',
      'theme.getCurrent',
      'theme.onChanged',
      'i18n.t',
      'i18n.onLocaleChanged',
      'i18n.registerMessages',
      'app.register',
      'app.onMessage',
      'on',
      'emit',
      'workspaceState.keys',
      'workspaceState.get',
      'workspaceState.update',
      'globalState.keys',
      'globalState.get',
      'globalState.update'
    ]
    assert.equal(thisCard.length, 28, '本卡共 28 项（不是卡面上写的 22：以 apiFactory 为准）')
    const statusByName = new Map(rows.map((row) => [row.capability, row.status]))
    for (const capability of thisCard) {
      assert.equal(statusByName.get(capability), 'implemented', `${capability} 必须已实现`)
    }
  })
})
