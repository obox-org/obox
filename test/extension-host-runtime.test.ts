/**
 * EH-A3 · 宿主侧运行时骨架单测。
 *
 * 覆盖判据（`docs/extension-host-migration.md` 的 EH-A3 行 + 任务卡要求 1–6）：
 * - 入口时序：`ready` → `init` → `initialized` → `terminate`（含清理与退出码）
 * - 4 类激活事件（含缺省 `*`）
 * - `apiVersion` 超限 ⇒ 该扩展标记不可加载，宿主不崩
 * - 激活失败归类（未导出 default / `plugin` 抛错）且**一个扩展失败不影响另一个**
 * - 运行期（定时器回调）错误按扩展隔离
 * - RPC 往返：`req`/`res`/`err`/`cancel`/未知 method/超时
 * - `fs` 真能读写临时目录、`timer` 按秒触发并能被清理
 * - 「已实现 / 桩」对照表与桩行为一致（每个桩都抛 EH_INTERNAL + 阶段 B 提示）
 *
 * 刻意**不起真进程**：端口用可注入的假实现（`createFakeHostPort`），
 * 但扩展入口是**真的 ESM 文件**（临时目录里写 `index.mjs` + `manifest.json`，用真 `import()` 加载），
 * 这样测到的是「用户扩展是纯 ESM」这条真约束，而不是被 mock 掉的导入。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'

import {
  ACK_TIMEOUT_MS,
  EhProtocolError,
  createActivateEnvelope,
  createDeactivateEnvelope,
  createInitEnvelope,
  createRequestEnvelope,
  createResponseEnvelope,
  createTerminateEnvelope,
  type ActivationReason,
  type Envelope,
  type EnvelopeOf,
  type EnvelopeType,
  type HostedExtensionInfo
} from '../src/shared/extensionHostProtocol'
import {
  createExtensionApi,
  listApiImplementation,
  type BuiltExtensionApi
} from '../src/extension-host/apiFactory'
import { matchesActivationEvent } from '../src/extension-host/activator'
import { ExtensionLoader } from '../src/extension-host/loader'
import {
  createEnvelopeSink,
  createEnvelopeLogger,
  type HostLogger
} from '../src/extension-host/log'
import {
  createHostPortFromParentPort,
  type HostPort,
  type ParentPortLike
} from '../src/extension-host/port'
import { RpcClient, RpcServer } from '../src/extension-host/rpc'
import { ExtensionHostRuntime, type HostRuntimeOptions } from '../src/extension-host/runtime'
import { createRunExtensionSafely, type ExtensionRunPhase } from '../src/extension-host/safety'

/* -------------------------------------------------------------------------------------------- */
/* 假端口 / 日志 / 临时目录                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** 假宿主端口：收出站帧、允许测试从「main 侧」塞入站帧 */
interface FakeHostPort {
  port: HostPort
  /** 宿主发出去的帧（顺序） */
  sent: Envelope[]
  /** 从 main 侧送一帧给宿主 */
  receive(message: unknown): void
  /** 退订全部监听（断言退订用） */
  listenerCount(): number
}

function createFakeHostPort(): FakeHostPort {
  const listeners = new Set<(message: unknown) => void>()
  const sent: Envelope[] = []
  return {
    sent,
    port: {
      post(message: unknown): void {
        sent.push(message as Envelope)
      },
      subscribe(listener: (message: unknown) => void): () => void {
        listeners.add(listener)
        return (): void => {
          listeners.delete(listener)
        }
      }
    },
    receive(message: unknown): void {
      for (const listener of [...listeners]) listener(message)
    },
    listenerCount(): number {
      return listeners.size
    }
  }
}

/** 按 `t` 过滤信封（返回具体类型，避免每处都写类型断言） */
function envelopesOf<T extends EnvelopeType>(sent: Envelope[], type: T): Array<EnvelopeOf<T>> {
  return sent.filter((envelope): envelope is EnvelopeOf<T> => envelope.t === type)
}

/** 抓取日志的 HostLogger（单测不接信封时用） */
interface CapturedLog {
  level: string
  message: string
}

function createTestLogger(): { logger: HostLogger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = []
  const logger: HostLogger = (level, message, detail): void => {
    entries.push({ level, message: detail === undefined ? message : `${message}（${detail}）` })
  }
  return { entries, logger }
}

/** 扩展模块（真 ESM）共享的观察面：模块里写 `globalThis.__oboxEhTest` */
interface TestState {
  activations: string[]
  disposed: string[]
  fsRoundTrip?: string
  timerTicks: number
}

function resetTestState(): TestState {
  const holder = globalThis as unknown as { __oboxEhTest?: TestState }
  const state: TestState = { activations: [], disposed: [], timerTicks: 0 }
  holder.__oboxEhTest = state
  return state
}

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-a3-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 轮询等待（避免用固定 sleep 掩盖时序问题） */
async function waitFor(condition: () => boolean, timeoutMs = 3000, why = '条件'): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时：${why}`)
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 5)
    })
  }
}

/** 真 sleep（定时器用例需要真的等一秒） */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, ms)
  })
}

/* -------------------------------------------------------------------------------------------- */
/* 扩展夹具（真的写到临时目录）                                                                    */
/* -------------------------------------------------------------------------------------------- */

interface FixtureOptions {
  id: string
  source: string
  apiVersion?: number
  activationEvents?: ActivationReason[]
  entryName?: string
  /** `false` 时不写 manifest.json（测缺省入口 `index.js`） */
  manifest?: boolean
}

/** 在 `<root>/<id>/` 写入一个可 import 的扩展，返回清单摘要 */
async function createFixture(root: string, options: FixtureOptions): Promise<HostedExtensionInfo> {
  const dir = path.join(root, options.id)
  await mkdir(dir, { recursive: true })
  const entryName = options.entryName ?? 'index.mjs'
  await writeFile(path.join(dir, entryName), options.source, 'utf8')
  if (options.manifest !== false) {
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ name: options.id, main: entryName }),
      'utf8'
    )
  }
  return {
    id: options.id,
    version: '1.0.0',
    path: dir,
    activationEvents: options.activationEvents ?? [],
    apiVersion: options.apiVersion ?? 3
  }
}

/** 激活时把 id 记到观察面（验证「谁被激活了」） */
function sourceActivate(id: string): string {
  return `export default (api) => {
  globalThis.__oboxEhTest.activations.push(${JSON.stringify(id)})
}
`
}

/** 激活时记 id，并返回 `{ dispose }`（验证停用会跑扩展自己的清理） */
function sourceActivateWithDispose(id: string): string {
  return `export default (api) => {
  globalThis.__oboxEhTest.activations.push(${JSON.stringify(id)})
  return {
    dispose() {
      globalThis.__oboxEhTest.disposed.push(${JSON.stringify(id)})
    }
  }
}
`
}

/** 入口未导出 default */
function sourceNoDefault(): string {
  return `export const activate = () => {}
`
}

/** `plugin(api)` 抛错 */
function sourceThrowing(): string {
  return `export default () => {
  throw new Error('plugin 里的爆炸')
}
`
}

/** 真的用 `api.fs` 写再读（EH-A3 的验收场景） */
function sourceFsRoundTrip(): string {
  return `export default async (api) => {
  await api.fs.writeFile('hello.txt', 'hello from host')
  globalThis.__oboxEhTest.fsRoundTrip = await api.fs.readFile('hello.txt')
}
`
}

/** 定时器回调抛错（运行期错误隔离） */
function sourceCrashingTimer(): string {
  return `export default (api) => {
  api.timer.setInterval('boom', 1, () => {
    throw new Error('定时器里的爆炸')
  })
}
`
}

/* -------------------------------------------------------------------------------------------- */
/* 运行时夹具                                                                                     */
/* -------------------------------------------------------------------------------------------- */

interface RuntimeHarness {
  runtime: ExtensionHostRuntime
  host: FakeHostPort
  exits: number[]
}

function createRuntime(overrides: Omit<Partial<HostRuntimeOptions>, 'port'> = {}): RuntimeHarness {
  const host = createFakeHostPort()
  const exits: number[] = []
  const runtime = new ExtensionHostRuntime({
    port: host.port,
    hostId: 'host-test',
    pid: 4242,
    exit: (code: number): void => {
      exits.push(code)
    },
    ...overrides
  })
  return { runtime, host, exits }
}

/** 发 `init`（默认 apiVersion 3） */
function sendInit(
  harness: RuntimeHarness,
  dataDir: string,
  extensions: HostedExtensionInfo[],
  apiVersion = 3
): void {
  harness.host.receive(createInitEnvelope({ apiVersion, dataDir, extensions }))
}

/* -------------------------------------------------------------------------------------------- */
/* 1. 入口时序                                                                                    */
/* -------------------------------------------------------------------------------------------- */

test('parentPort 适配：解包 MessageEvent.data、可退订', () => {
  const posted: unknown[] = []
  const handlers: Array<(event: unknown) => void> = []
  const parentPort: ParentPortLike = {
    postMessage(message: unknown): void {
      posted.push(message)
    },
    on(_event: 'message', listener: (event: unknown) => void): unknown {
      handlers.push(listener)
      return undefined
    },
    off(_event: 'message', listener: (event: unknown) => void): unknown {
      const index = handlers.indexOf(listener)
      if (index >= 0) handlers.splice(index, 1)
      return undefined
    }
  }

  const port = createHostPortFromParentPort(parentPort)
  const received: unknown[] = []
  const unsubscribe = port.subscribe((message: unknown): void => {
    received.push(message)
  })

  port.post({ t: 'x' })
  assert.deepEqual(posted, [{ t: 'x' }], 'post 应转发到 parentPort.postMessage')

  handlers[0]?.({ data: { t: 'in' } })
  assert.deepEqual(received, [{ t: 'in' }], '入站消息应解包 MessageEvent.data')

  unsubscribe()
  assert.equal(handlers.length, 0, '退订必须移除 parentPort 监听')
})

test('时序：ready → init → initialized → activate → terminate（含清理与退出码）', async () => {
  const state = resetTestState()
  const dataDir = await makeTempDir()
  const alpha = await createFixture(dataDir, {
    id: 'alpha',
    source: sourceActivateWithDispose('alpha')
  })

  const harness = createRuntime()
  const { host, runtime, exits } = harness
  runtime.start()

  // ready：启动即发的第一封信
  const ready = envelopesOf(host.sent, 'ready')
  assert.equal(ready.length, 1, 'start() 必须立刻发一条 ready')
  assert.equal(ready[0].hostId, 'host-test')
  assert.equal(ready[0].pid, 4242)
  assert.equal(runtime.phase, 'ready')
  assert.equal(envelopesOf(host.sent, 'initialized').length, 0, 'init 之前不得发 initialized')

  // init → initialized
  sendInit(harness, dataDir, [alpha])
  assert.equal(runtime.phase, 'initialized')
  assert.equal(envelopesOf(host.sent, 'initialized').length, 1, 'init 之后必须发 initialized')

  // 启动即激活缺省 `*`
  await runtime.settled()
  assert.deepEqual(state.activations, ['alpha'])
  assert.equal(runtime.statusOf('alpha')?.state, 'active')

  // terminate → 停用（跑扩展清理）→ 退出码 0
  host.receive(createTerminateEnvelope(1000))
  await waitFor(() => exits.length === 1, 3000, '宿主退出')
  assert.deepEqual(exits, [0], '优雅退出码必须是 0')
  assert.equal(runtime.phase, 'terminated')
  assert.deepEqual(state.disposed, ['alpha'], '停用必须调用扩展返回的 dispose')
  assert.equal(runtime.statusOf('alpha')?.state, 'stopped')
  assert.equal(host.listenerCount(), 0, '退出时必须退订端口')

  // 收尾日志：清理完毕 + 退出，都要能在 log 信封里看到
  const logs = envelopesOf(host.sent, 'log')
  assert.ok(
    logs.some((entry) => entry.message.includes('清理完毕')),
    '退出前应有清理完毕日志'
  )
})

test('deactivate 信封：停用单个扩展（清理定时器 + 扩展 cleanup）', async () => {
  const state = resetTestState()
  const dataDir = await makeTempDir()
  const beta = await createFixture(dataDir, {
    id: 'beta',
    source: sourceActivateWithDispose('beta')
  })

  const harness = createRuntime()
  harness.runtime.start()
  sendInit(harness, dataDir, [beta])
  await harness.runtime.settled()
  assert.deepEqual(state.activations, ['beta'])

  harness.host.receive(createDeactivateEnvelope('beta'))
  await waitFor(() => harness.runtime.statusOf('beta')?.state === 'stopped', 3000, '停用')
  assert.deepEqual(state.disposed, ['beta'])
})

/* -------------------------------------------------------------------------------------------- */
/* 2. 激活事件（四类 + 缺省 `*`）                                                                  */
/* -------------------------------------------------------------------------------------------- */

test('激活事件匹配表：四类事件与缺省 *', () => {
  // 缺省（空数组）= `*`：任何触发都能激活
  assert.equal(matchesActivationEvent([], '*'), true)
  assert.equal(matchesActivationEvent([], 'onStartupFinished'), true)
  assert.equal(matchesActivationEvent([], { command: 'any' }), true)
  assert.equal(matchesActivationEvent([], { view: 'any' }), true)

  // 显式 `*`：同样是「任何触发」
  assert.equal(matchesActivationEvent(['*'], { command: 'any' }), true)

  // onStartupFinished：只认同名字符串
  assert.equal(matchesActivationEvent(['onStartupFinished'], 'onStartupFinished'), true)
  assert.equal(matchesActivationEvent(['onStartupFinished'], '*'), false)

  // onCommand / onView：按结构化字段比较
  assert.equal(matchesActivationEvent([{ command: 'a.run' }], { command: 'a.run' }), true)
  assert.equal(matchesActivationEvent([{ command: 'a.run' }], { command: 'b.run' }), false)
  assert.equal(matchesActivationEvent([{ command: 'a.run' }], { view: 'a.run' }), false)
  assert.equal(matchesActivationEvent([{ view: 'v.panel' }], { view: 'v.panel' }), true)
  assert.equal(matchesActivationEvent([{ view: 'v.panel' }], { view: 'other' }), false)

  // 混合声明：任一命中即可
  assert.equal(
    matchesActivationEvent(['onStartupFinished', { view: 'v.panel' }], { view: 'v.panel' }),
    true
  )
})

test('4 类激活事件：* 启动即激活，其余等自己的触发', async () => {
  const state = resetTestState()
  const dataDir = await makeTempDir()
  const star = await createFixture(dataDir, { id: 'star', source: sourceActivate('star') })
  const onStartup = await createFixture(dataDir, {
    id: 'on-startup',
    source: sourceActivate('on-startup'),
    activationEvents: ['onStartupFinished']
  })
  const onCommand = await createFixture(dataDir, {
    id: 'on-command',
    source: sourceActivate('on-command'),
    activationEvents: [{ command: 'on-command.run' }]
  })
  const onView = await createFixture(dataDir, {
    id: 'on-view',
    source: sourceActivate('on-view'),
    activationEvents: [{ view: 'on-view.panel' }]
  })

  const harness = createRuntime()
  harness.runtime.start()
  sendInit(harness, dataDir, [star, onStartup, onCommand, onView])
  await harness.runtime.settled()

  // 只有 `*`（缺省）在启动时激活
  assert.deepEqual(state.activations, ['star'])
  assert.equal(harness.runtime.statusOf('on-startup')?.state, 'pending')
  assert.equal(harness.runtime.statusOf('on-command')?.state, 'pending')
  assert.equal(harness.runtime.statusOf('on-view')?.state, 'pending')

  // onStartupFinished：`*` 扩展也在匹配集中（立即激活语义），但它已激活 → skipped
  const startupResults = await harness.runtime.dispatchActivation('onStartupFinished')
  assert.deepEqual(
    startupResults.map((result) => [result.extId, result.state]),
    [
      ['star', 'skipped'],
      ['on-startup', 'activated']
    ]
  )
  assert.ok(state.activations.includes('on-startup'))

  /** 只看「这次真正激活了谁」 */
  const activatedIds = (results: Array<{ extId: string; state: string }>): string[] =>
    results.filter((result) => result.state === 'activated').map((result) => result.extId)

  // onCommand:<id>：别的命令不触发
  const otherCommand = await harness.runtime.dispatchActivation({ command: 'other.run' })
  assert.deepEqual(activatedIds(otherCommand), [], '不匹配的命令不得激活任何扩展')
  assert.equal(harness.runtime.statusOf('on-command')?.state, 'pending')

  const commandResults = await harness.runtime.dispatchActivation({ command: 'on-command.run' })
  assert.deepEqual(activatedIds(commandResults), ['on-command'])
  assert.ok(state.activations.includes('on-command'))

  // onView:<id>
  const viewResults = await harness.runtime.dispatchActivation({ view: 'on-view.panel' })
  assert.deepEqual(activatedIds(viewResults), ['on-view'])
  assert.ok(state.activations.includes('on-view'))

  // 幂等：已激活的扩展再被触发 → skipped，不会重复 plugin(api)
  const again = await harness.runtime.dispatchActivation({ view: 'on-view.panel' })
  assert.deepEqual(activatedIds(again), [])
  assert.ok(again.every((result) => result.state === 'skipped'))
  assert.equal(state.activations.filter((id) => id === 'on-view').length, 1)
})

test('activate 信封按 extId + reason 激活（懒加载，不依赖扫描目录）', async () => {
  const state = resetTestState()
  const dataDir = await makeTempDir()
  const lazy = await createFixture(dataDir, {
    id: 'lazy',
    source: sourceActivate('lazy'),
    activationEvents: [{ command: 'lazy.run' }]
  })

  const harness = createRuntime()
  harness.runtime.start()
  sendInit(harness, dataDir, [lazy])
  await harness.runtime.settled()
  assert.deepEqual(state.activations, [], '懒激活扩展在启动时不该被 import')

  harness.host.receive(createActivateEnvelope('lazy', { command: 'lazy.run' }))
  await waitFor(() => harness.runtime.statusOf('lazy')?.state === 'active', 3000, 'lazy 激活')
  assert.deepEqual(state.activations, ['lazy'])
  assert.equal(harness.runtime.statusOf('lazy')?.lastActivation?.reason, 'onCommand:lazy.run')
})

test('运行时验收：在宿主里加载测试扩展并完成一次 fs 读写往返', async () => {
  const state = resetTestState()
  const dataDir = await makeTempDir()
  const roundTrip = await createFixture(dataDir, {
    id: 'roundtrip',
    source: sourceFsRoundTrip()
  })

  const harness = createRuntime()
  harness.runtime.start()
  sendInit(harness, dataDir, [roundTrip])
  await harness.runtime.settled()

  assert.equal(harness.runtime.statusOf('roundtrip')?.state, 'active')
  assert.equal(state.fsRoundTrip, 'hello from host', '扩展经 api.fs 读到的内容应与写入一致')

  // 落点必须是 `<dataDir>/<extId>/data/`——R62 起与 main 的 `dataDirFor` 逐字一致
  // （此前宿主写的是 `<dataDir>/<extId>/`，升级后老扩展的 fs 数据会"看不见"）
  const onDisk = await readFile(path.join(dataDir, 'roundtrip', 'data', 'hello.txt'), 'utf8')
  assert.equal(onDisk, 'hello from host')

  harness.host.receive(createTerminateEnvelope(1000))
  await waitFor(() => harness.exits.length === 1, 3000, '宿主退出')
})

/* -------------------------------------------------------------------------------------------- */
/* 3. 清单：apiVersion 门槛 / 非法 id / 缺省入口                                                   */
/* -------------------------------------------------------------------------------------------- */
test('apiVersion 超限的扩展被标记不可加载（不 import、不崩）', async () => {
  const state = resetTestState()
  const dataDir = await makeTempDir()
  const future = await createFixture(dataDir, {
    id: 'future',
    source: sourceActivate('future'),
    apiVersion: 4
  })
  const normal = await createFixture(dataDir, { id: 'normal', source: sourceActivate('normal') })

  const harness = createRuntime()
  harness.runtime.start()
  sendInit(harness, dataDir, [future, normal], 3)
  await harness.runtime.settled()

  const futureStatus = harness.runtime.statusOf('future')
  assert.equal(futureStatus?.state, 'rejected')
  assert.equal(futureStatus?.failure?.kind, 'not-loadable')
  assert.match(futureStatus?.failure?.message ?? '', /v4/)
  assert.equal(state.activations.includes('future'), false, '不可加载的扩展不得被激活')

  // 其它扩展不受影响
  assert.equal(harness.runtime.statusOf('normal')?.state, 'active')
  assert.deepEqual(state.activations, ['normal'])
  assert.ok(
    envelopesOf(harness.host.sent, 'log').some((entry) => entry.message.includes('不可加载')),
    '拒绝加载必须留日志'
  )
})

test('加载器：非法 id 拒绝、缺省入口 index.js、真 ESM import 取 default', async () => {
  const dataDir = await makeTempDir()
  const { logger, entries } = createTestLogger()

  // 非法 id（含路径分隔符）：直接拒绝，绝不拼进文件路径
  const unsafeLoader = new ExtensionLoader({ hostApiVersion: 3, dataDir, log: logger })
  const [unsafe] = unsafeLoader.prepare([
    {
      id: '../evil',
      version: '1.0.0',
      path: path.join(dataDir, 'evil'),
      activationEvents: [],
      apiVersion: 3
    }
  ])
  assert.equal(unsafe.state, 'rejected')
  assert.match(unsafe.reason ?? '', /非法/)

  // 没有 manifest.json → 缺省入口 index.js（合法入口，只是文件不存在）
  const plainLoader = new ExtensionLoader({ hostApiVersion: 3, dataDir, log: logger })
  const [plain] = plainLoader.prepare([
    {
      id: 'plain',
      version: '1.0.0',
      path: path.join(dataDir, 'plain'),
      activationEvents: [],
      apiVersion: 2
    }
  ])
  assert.equal(plain.state, 'loadable')
  assert.equal(plain.entryPath, path.join(dataDir, 'plain', 'index.js'))

  // 真 ESM（manifest.main 指向 index.mjs）
  const fixture = await createFixture(dataDir, { id: 'esm', source: sourceActivate('esm') })
  const esmLoader = new ExtensionLoader({ hostApiVersion: 3, dataDir, log: logger })
  const [esm] = esmLoader.prepare([fixture])
  assert.equal(esm.state, 'loadable')
  assert.equal(esm.entryPath, path.join(fixture.path, 'index.mjs'))
  const module = await esmLoader.loadEntry('esm')
  assert.equal(typeof module.default, 'function', 'default 应为 plugin(api)')

  // import 失败 → EH_ACTIVATION_FAILED（用户可修）
  const emptyLoader = new ExtensionLoader({ hostApiVersion: 3, dataDir, log: logger })
  emptyLoader.prepare([
    {
      id: 'missing',
      version: '1.0.0',
      path: path.join(dataDir, 'missing'),
      activationEvents: [],
      apiVersion: 3
    }
  ])
  await assert.rejects(emptyLoader.loadEntry('missing'), (error: unknown): boolean => {
    assert.ok(error instanceof EhProtocolError)
    assert.equal(error.code, 'EH_ACTIVATION_FAILED')
    return true
  })

  // 未知扩展 → EH_UNKNOWN_EXT
  await assert.rejects(emptyLoader.loadEntry('nobody'), (error: unknown): boolean => {
    assert.ok(error instanceof EhProtocolError)
    assert.equal(error.code, 'EH_UNKNOWN_EXT')
    return true
  })

  assert.ok(
    entries.some((entry) => entry.level === 'warn'),
    '拒绝/重复应留 warn 日志'
  )
})

/* -------------------------------------------------------------------------------------------- */
/* 4. 激活失败归类 + 错误隔离                                                                      */
/* -------------------------------------------------------------------------------------------- */

test('激活失败归类：未导出 default / plugin 抛错，且一个失败不影响另一个', async () => {
  const state = resetTestState()
  const dataDir = await makeTempDir()
  const good = await createFixture(dataDir, { id: 'good', source: sourceActivate('good') })
  const noDefault = await createFixture(dataDir, { id: 'no-default', source: sourceNoDefault() })
  const throwing = await createFixture(dataDir, { id: 'throwing', source: sourceThrowing() })

  const harness = createRuntime()
  harness.runtime.start()
  sendInit(harness, dataDir, [good, noDefault, throwing])
  await harness.runtime.settled()

  // 成功的仍然成功
  assert.equal(harness.runtime.statusOf('good')?.state, 'active')
  assert.deepEqual(state.activations, ['good'], '一个失败不能让其它扩展停摆')

  // 未导出 default
  const noDefaultStatus = harness.runtime.statusOf('no-default')
  assert.equal(noDefaultStatus?.state, 'failed')
  assert.equal(noDefaultStatus?.failure?.kind, 'no-default-export')
  assert.match(noDefaultStatus?.failure?.message ?? '', /default/)

  // plugin 抛错
  const throwingStatus = harness.runtime.statusOf('throwing')
  assert.equal(throwingStatus?.state, 'failed')
  assert.equal(throwingStatus?.failure?.kind, 'plugin-threw')
  assert.match(throwingStatus?.failure?.message ?? '', /plugin 里的爆炸/)

  // 两类失败都要有 error 级日志，并带上扩展 id
  const errorLogs = envelopesOf(harness.host.sent, 'log').filter((entry) => entry.level === 'error')
  assert.ok(errorLogs.some((entry) => entry.message.includes('no-default')))
  assert.ok(errorLogs.some((entry) => entry.message.includes('throwing')))
  assert.ok(errorLogs.some((entry) => entry.message.includes('plugin-threw')))

  // 宿主仍然活着：RPC 正常
  harness.host.receive(createRequestEnvelope(1, 'host.ping'))
  await waitFor(
    () => envelopesOf(harness.host.sent, 'res').some((entry) => entry.id === 1),
    3000,
    'ping 响应'
  )
  assert.equal(harness.runtime.phase, 'initialized')
})

test('运行期错误隔离：定时器回调抛错只落日志与状态表，不杀宿主、不改变 active', async () => {
  resetTestState()
  const dataDir = await makeTempDir()
  const crashy = await createFixture(dataDir, {
    id: 'crashy',
    source: sourceCrashingTimer()
  })
  const other = await createFixture(dataDir, { id: 'other', source: sourceActivate('other') })

  const harness = createRuntime()
  harness.runtime.start()
  sendInit(harness, dataDir, [crashy, other])
  await harness.runtime.settled()
  assert.equal(harness.runtime.statusOf('crashy')?.state, 'active')

  // 定时器是秒粒度（类型约定 ≥1s），等一次触发
  await waitFor(
    () => harness.runtime.statusOf('crashy')?.runtimeError !== undefined,
    4000,
    '运行期错误被记录'
  )

  const crashyStatus = harness.runtime.statusOf('crashy')
  assert.match(crashyStatus?.runtimeError?.message ?? '', /定时器里的爆炸/)
  assert.equal(crashyStatus?.runtimeError?.phase, 'timer')
  assert.equal(crashyStatus?.state, 'active', '回调抛错不该把扩展判死')
  assert.equal(harness.runtime.statusOf('other')?.state, 'active')
  assert.equal(harness.runtime.phase, 'initialized')

  const errorLogs = envelopesOf(harness.host.sent, 'log').filter((entry) => entry.level === 'error')
  assert.ok(
    errorLogs.some(
      (entry) => entry.message.includes('运行期错误') && entry.message.includes('crashy')
    ),
    '运行期错误必须进 log 信封'
  )

  // 仍能正常响应（进程没被带下去）
  harness.host.receive(createRequestEnvelope(7, 'host.status'))
  await waitFor(
    () => envelopesOf(harness.host.sent, 'res').some((entry) => entry.id === 7),
    3000,
    'status 响应'
  )

  harness.host.receive(createTerminateEnvelope(1000))
})

/* -------------------------------------------------------------------------------------------- */
/* 5. RPC                                                                                        */
/* -------------------------------------------------------------------------------------------- */

interface RpcHarness {
  client: RpcClient
  server: RpcServer
  logs: CapturedLog[]
  toServer: Envelope[]
  toClient: Envelope[]
}

/** 客户端/服务端直连的 RPC 夹具（同步泵送，不起进程） */
function createRpcHarness(options: { ackTimeoutMs?: number } = {}): RpcHarness {
  const { logger, entries } = createTestLogger()
  const toServer: Envelope[] = []
  const toClient: Envelope[] = []
  const holder: { client?: RpcClient } = {}

  const server = new RpcServer({
    send: (envelope): void => {
      toClient.push(envelope)
      if (envelope.t === 'res') holder.client?.handleResponse(envelope)
      else if (envelope.t === 'err') holder.client?.handleError(envelope)
      else if (envelope.t === 'cancel') holder.client?.handleCancel(envelope)
    },
    log: logger
  })

  const client = new RpcClient({
    send: (envelope): void => {
      toServer.push(envelope)
      if (envelope.t === 'req') server.handleRequest(envelope)
      else if (envelope.t === 'cancel') server.handleCancel(envelope)
    },
    log: logger,
    ackTimeoutMs: options.ackTimeoutMs
  })
  holder.client = client

  return { client, server, logs: entries, toServer, toClient }
}

test('RPC：req → res 往返', async () => {
  const harness = createRpcHarness()
  harness.server.register('echo', (params) => ({ echo: params }))

  const result = await harness.client.request('echo', { a: 1, b: ['x'] })
  assert.deepEqual(result, { echo: { a: 1, b: ['x'] } })

  const request = envelopesOf(harness.toServer, 'req')
  assert.equal(request.length, 1)
  assert.equal(request[0].method, 'echo')
  assert.equal(request[0].id, 1, 'id 从 FIRST_REQUEST_ID 起自增')

  const response = envelopesOf(harness.toClient, 'res')
  assert.equal(response.length, 1)
  assert.equal(response[0].id, request[0].id)
})

test('RPC：handler 抛错 → err（保留错误码与细节）', async () => {
  const harness = createRpcHarness()
  harness.server.register('boom', () => {
    throw new Error('服务端炸了')
  })

  await assert.rejects(harness.client.request('boom'), (error: unknown): boolean => {
    assert.ok(error instanceof EhProtocolError)
    assert.equal(error.code, 'EH_INTERNAL')
    assert.match(error.message, /服务端炸了/)
    return true
  })

  const errors = envelopesOf(harness.toClient, 'err')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'EH_INTERNAL')
})

test('RPC：未知 method → EH_INTERNAL 且带可用 method 列表', async () => {
  const harness = createRpcHarness()
  harness.server.register('host.ping', () => ({ pong: true }))

  await assert.rejects(harness.client.request('does.not.exist'), (error: unknown): boolean => {
    assert.ok(error instanceof EhProtocolError)
    assert.equal(error.code, 'EH_INTERNAL')
    return true
  })

  const errors = envelopesOf(harness.toClient, 'err')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /未知 RPC method/)
  assert.match(errors[0].detail ?? '', /host\.ping/, '必须告诉调用方有哪些 method 可用')
  assert.ok(
    harness.logs.some((entry) => entry.message.includes('未知 RPC method')),
    '未知 method 必须留日志'
  )
})

test('RPC：cancel 标记放弃——已完成回正常响应，放弃掉的回 EH_CANCELLED', async () => {
  const harness = createRpcHarness()
  let release: ((value: unknown) => void) | undefined
  let handlerSawCancelled: boolean | undefined
  harness.server.register(
    'slow',
    (_params, context) =>
      new Promise<unknown>((resolve): void => {
        release = resolve
        context.signal.addEventListener('abort', (): void => {
          handlerSawCancelled = true
        })
      })
  )

  const pending = harness.client.request('slow')
  const [id] = harness.client.pendingIds()
  assert.equal(typeof id, 'number')

  // 主动取消：本地立即以 EH_CANCELLED 结束，并补发 cancel 帧
  assert.equal(harness.client.cancel(id), true)
  await assert.rejects(pending, (error: unknown): boolean => {
    assert.ok(error instanceof EhProtocolError)
    assert.equal(error.code, 'EH_CANCELLED')
    return true
  })
  assert.equal(envelopesOf(harness.toServer, 'cancel').length, 1, '取消必须发 cancel 帧')
  assert.equal(handlerSawCancelled, true, '处理函数应能通过 signal 感知放弃')

  // 处理函数跑完后：回 EH_CANCELLED 而不是结果
  release?.('太晚了')
  await waitFor(() => envelopesOf(harness.toClient, 'err').length === 1, 3000, '取消响应')
  const errors = envelopesOf(harness.toClient, 'err')
  assert.equal(errors[0].code, 'EH_CANCELLED')
  assert.equal(envelopesOf(harness.toClient, 'res').length, 0, '被取消的请求不得回 res')
})

test('RPC：超时按 ACK_TIMEOUT_MS 语义（只观测，回 EH_TIMEOUT + 补发 cancel）', async () => {
  const { logger, entries } = createTestLogger()
  const sent: Envelope[] = []
  const client = new RpcClient({
    send: (envelope): void => {
      sent.push(envelope)
    },
    log: logger,
    ackTimeoutMs: 20
  })
  assert.equal(ACK_TIMEOUT_MS, 3000, '默认 ack 超时是 3 秒（协议层常量）')

  await assert.rejects(client.request('never.answers'), (error: unknown): boolean => {
    assert.ok(error instanceof EhProtocolError)
    assert.equal(error.code, 'EH_TIMEOUT')
    return true
  })

  assert.equal(envelopesOf(sent, 'cancel').length, 1, '超时后补发 cancel（对端可放弃）')
  assert.equal(client.pendingCount, 0, '超时后不得残留挂起请求')
  assert.ok(
    entries.some((entry) => entry.level === 'warn' && entry.message.includes('超时')),
    '超时必须留日志（只观测，不重启宿主）'
  )
})

test('RPC：链路断开时在途请求立即失败且不重放', async () => {
  const { logger } = createTestLogger()
  const client = new RpcClient({
    send: (): void => {
      /* 对端已消失 */
    },
    log: logger
  })
  const pending = client.request('whatever')
  client.rejectAll('EH_CANCELLED', '链路已断开')

  await assert.rejects(pending, (error: unknown): boolean => {
    assert.ok(error instanceof EhProtocolError)
    assert.equal(error.code, 'EH_CANCELLED')
    return true
  })
  assert.equal(client.pendingCount, 0)
})

/* -------------------------------------------------------------------------------------------- */
/* 6. 运行时 RPC 时序（init 之前 EH_NOT_READY / init 之后 req 正常）                                 */
/* -------------------------------------------------------------------------------------------- */

test('init 之前 req → EH_NOT_READY；init 之后 req/res 正常，宿主也能主动发请求', async () => {
  const dataDir = await makeTempDir()
  const harness = createRuntime()
  const { host, runtime } = harness
  runtime.start()

  // init 之前：一律 EH_NOT_READY
  host.receive(createRequestEnvelope(1, 'host.ping'))
  const notReady = envelopesOf(host.sent, 'err')
  assert.equal(notReady.length, 1)
  assert.equal(notReady[0].id, 1)
  assert.equal(notReady[0].code, 'EH_NOT_READY')

  sendInit(harness, dataDir, [])

  // init 之后：host.ping
  host.receive(createRequestEnvelope(2, 'host.ping'))
  await waitFor(
    () => envelopesOf(host.sent, 'res').some((entry) => entry.id === 2),
    3000,
    'ping 响应'
  )
  const ping = envelopesOf(host.sent, 'res').find((entry) => entry.id === 2)
  assert.deepEqual(ping?.result, { pong: true, hostId: 'host-test', phase: 'initialized' })

  // host.status：能一次看到状态表 + 可用 method
  host.receive(createRequestEnvelope(3, 'host.status'))
  await waitFor(
    () => envelopesOf(host.sent, 'res').some((entry) => entry.id === 3),
    3000,
    'status 响应'
  )
  const status = envelopesOf(host.sent, 'res').find((entry) => entry.id === 3)?.result as {
    phase: string
    apiVersion: number
    extensions: unknown[]
    rpcMethods: string[]
  }
  assert.equal(status.phase, 'initialized')
  assert.equal(status.apiVersion, 3)
  assert.deepEqual(status.extensions, [])
  assert.ok(status.rpcMethods.includes('host.ping'))
  assert.ok(status.rpcMethods.includes('host.status'))

  // 未知 method：列表里应含已注册的 method
  host.receive(createRequestEnvelope(4, 'host.nope'))
  await waitFor(
    () => envelopesOf(host.sent, 'err').some((entry) => entry.id === 4),
    3000,
    '未知 method 错误'
  )
  const unknown = envelopesOf(host.sent, 'err').find((entry) => entry.id === 4)
  assert.equal(unknown?.code, 'EH_INTERNAL')
  assert.match(unknown?.detail ?? '', /host\.status/)

  // 宿主 → 对端：主动请求经 res 配对完成
  const pending = runtime.request('ui.ping')
  const outgoing = envelopesOf(host.sent, 'req')
  assert.equal(outgoing.length, 1)
  host.receive(createResponseEnvelope(outgoing[0].id, { ok: true }))
  assert.deepEqual(await pending, { ok: true })
})

test('畸形信封不崩：可配对的 req 回 EH_INTERNAL，其它只记日志', async () => {
  const harness = createRuntime()
  harness.runtime.start()

  // 缺 params 的 req（协议层判畸形）——仍然能按 id 回一条 err
  harness.host.receive({ v: 1, t: 'req', id: 9, method: 'host.ping' })
  const errors = envelopesOf(harness.host.sent, 'err')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].id, 9)
  assert.equal(errors[0].code, 'EH_INTERNAL')

  // 完全不是信封：不抛、不崩
  harness.host.receive('垃圾数据')
  harness.host.receive(null)
  harness.host.receive({ t: 'log' })
  assert.equal(harness.runtime.phase, 'ready')
  assert.ok(
    envelopesOf(harness.host.sent, 'log').some((entry) => entry.level === 'error'),
    '畸形信封必须留错误日志'
  )
})

/* -------------------------------------------------------------------------------------------- */
/* 7. fs / timer / 对照表                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * 造一个直连 apiFactory 的扩展 api（不经运行时）。
 *
 * `extensionDataDir` 参数现在是**扩展目录**（R62 起 data 目录恒等于 `<扩展目录>/data`，
 * 由 `apiFactory.extensionDataDirOf()` 统一计算，见 `test/extension-host-python-sqlite.test.ts`
 * 的路径钉死用例）。
 */
function createApi(
  extensionDataDir: string,
  extId = 'fs-ext'
): {
  built: BuiltExtensionApi
  entries: CapturedLog[]
  reported: Array<{ extId: string; phase: ExtensionRunPhase }>
} {
  const { logger, entries } = createTestLogger()
  const reported: Array<{ extId: string; phase: ExtensionRunPhase }> = []
  const runSafely = createRunExtensionSafely((extId2, _error, phase): void => {
    reported.push({ extId: extId2, phase })
  })
  const built = createExtensionApi({
    ext: {
      id: extId,
      version: '1.0.0',
      path: extensionDataDir,
      activationEvents: [],
      apiVersion: 3
    },
    extensionDataDir,
    appInfo: { name: 'obox', version: '9.9.9' },
    locale: 'zh',
    log: logger,
    runSafely
  })
  return { built, entries, reported }
}

test('fs 能力：真的能读写扩展 data 目录，越界路径拒绝', async () => {
  const dataDir = await makeTempDir()
  const extensionDataDir = path.join(dataDir, 'fs-ext')
  const { built } = createApi(extensionDataDir)
  const fsApi = built.api.fs

  await fsApi.writeFile('sub/note.txt', '你好 obox')
  // R62：data 目录 = `<扩展目录>/data`（与 main 的 `dataDirFor` 逐字一致）
  const onDisk = await readFile(path.join(extensionDataDir, 'data', 'sub', 'note.txt'), 'utf8')
  assert.equal(onDisk, '你好 obox', 'writeFile 必须真的落盘（自动建目录）')
  assert.equal(await fsApi.readFile('sub/note.txt'), '你好 obox')

  assert.equal(await fsApi.exists('sub/note.txt'), true)
  assert.equal(await fsApi.exists('sub/missing.txt'), false)
  assert.deepEqual(await fsApi.readDir('sub'), [{ name: 'note.txt', isDir: false }])

  // 越界：相对路径逃逸 / 绝对路径都要拒绝（fs 的作用域是「防手滑」，不是安全边界）
  await assert.rejects(fsApi.readFile('../escape.txt'), /越出扩展 data 目录/)
  await assert.rejects(fsApi.writeFile(path.join(dataDir, 'abs.txt'), 'x'), /绝对路径/)
  await assert.rejects(fsApi.readFile(''), /不能为空/)

  await fsApi.remove('sub')
  assert.equal(await fsApi.exists('sub/note.txt'), false)
  await assert.rejects(fsApi.readFile('sub/note.txt'), /读取文件失败/)

  // appInfo / env 已实现
  assert.deepEqual(await built.api.appInfo.get(), { name: 'obox', version: '9.9.9' })
  assert.equal(await built.api.env.getOboxVersion(), '9.9.9')
  assert.equal(built.api.env.platform, process.platform)
  assert.equal(built.api.env.arch, process.arch)
  assert.equal(built.api.env.nodeVersion, process.versions.node)
  assert.equal(built.api.env.language, 'zh')

  // EH-B1：watch/unwatch 已从桩变实现（真 Node fs.watch，真事件见 test/extension-host-io.test.ts）。
  // 这里只验「不再是抛『尚未迁移』的桩」：注册得进、取消得掉。
  await built.api.fs.watch('w', '.', () => {})
  await built.api.fs.unwatch('w')
})

test('timer 能力：按秒触发、可 clear、dispose 清干净', async () => {
  const dataDir = await makeTempDir()
  const { built, reported } = createApi(path.join(dataDir, 'timer-ext'))
  const ticks: number[] = []
  const timer = built.api.timer

  // 秒粒度校验（类型约定 ≥1 的整数秒）
  assert.throws(() => timer.setInterval('bad', 0, () => {}), /≥1 的整数/)
  assert.throws(() => timer.setInterval('bad2', 1.5, () => {}), /≥1 的整数/)
  assert.throws(() => timer.setInterval('', 1, () => {}), /非空字符串/)

  // setInterval：约 1 秒触发一次
  timer.setInterval('tick', 1, () => {
    ticks.push(Date.now())
  })
  await sleep(1250)
  assert.ok(ticks.length >= 1, 'setInterval 必须按秒触发')
  timer.clearInterval('tick')
  const afterClear = ticks.length
  await sleep(1100)
  assert.equal(ticks.length, afterClear, 'clearInterval 之后不得再触发')

  // setTimeout：只触发一次
  let onceCount = 0
  timer.setTimeout('once', 1, () => {
    onceCount += 1
  })
  await sleep(1150)
  assert.equal(onceCount, 1, 'setTimeout 必须只触发一次')
  assert.equal(built.api.timer.setTimeout.length, 3, '参数形状与现有 api.timer 对齐')

  // dispose：清掉全部定时器
  let leaked = 0
  timer.setInterval('leak', 1, () => {
    leaked += 1
  })
  built.dispose()
  await sleep(1100)
  assert.equal(leaked, 0, 'dispose 必须清掉该扩展的全部定时器')

  // 回调抛错经 runSafely 上报（不冒泡到调用方）
  const crashing = createApi(path.join(dataDir, 'timer-crash'), 'timer-crash')
  crashing.built.api.timer.setTimeout('boom', 1, () => {
    throw new Error('回调爆炸')
  })
  await waitFor(
    () => crashing.reported.some((entry) => entry.phase === 'timer'),
    4000,
    '回调错误被隔离上报'
  )
  assert.equal(crashing.reported[0]?.extId, 'timer-crash')
  crashing.built.dispose()
  assert.deepEqual(reported, [], '未出错的扩展不该有上报')
}, 20000)

test('api 形状：与 ExtensionActivationApi 对齐，「已实现 / 桩」对照表可从对象推导', async () => {
  const dataDir = await makeTempDir()
  const { built } = createApi(path.join(dataDir, 'shape-ext'), 'shape-ext')
  const rows = listApiImplementation(built.api)

  const implemented = rows
    .filter((row) => row.status === 'implemented')
    .map((row) => row.capability)
    .sort()
  assert.deepEqual(implemented, [
    // EH-B3b-1：注册面数据面（28 项——app / i18n / navbar / on·emit / settings / statusBar /
    // theme / views / workspaceState / globalState / registerCommand / executeCommand）
    'app.onMessage',
    'app.register',
    'appInfo.get',
    'clipboard.readText',
    'clipboard.writeText',
    // EH-B3a：主进程类能力族（dialog 3 / notification 1 / overlay 4 / proxy.get /
    // secrets 3 / shell 2 / update 2 / window 7）
    'dialog.showMessageBox',
    'dialog.showOpenDialog',
    'dialog.showSaveDialog',
    'emit',
    'env.arch',
    'env.getOboxVersion',
    'env.language',
    'env.nodeVersion',
    'env.platform',
    'executeCommand',
    'fs.exists',
    'fs.readDir',
    'fs.readFile',
    'fs.remove',
    'fs.unwatch',
    'fs.watch',
    'fs.writeFile',
    'globalState.get',
    'globalState.keys',
    'globalState.update',
    'i18n.locale',
    'i18n.onLocaleChanged',
    'i18n.registerMessages',
    'i18n.t',
    // EH-B2：ipc 全量 14 项 + python.run + sqlite.open（进程与存储族）
    'ipc.broadcast',
    'ipc.channels',
    'ipc.close',
    'ipc.connect',
    'ipc.listen',
    'ipc.notify',
    'ipc.onClose',
    'ipc.onConnection',
    'ipc.onDisconnect',
    'ipc.onNotification',
    'ipc.onReconnect',
    'ipc.onRequest',
    'ipc.onStderr',
    'ipc.request',
    'log',
    'navbar.setBadge',
    'net.fetch',
    'notification.show',
    'on',
    'overlay.create',
    'overlay.destroy',
    'overlay.setMouseThrough',
    'overlay.setPosition',
    'proxy.get',
    'python.run',
    'registerCommand',
    'secrets.delete',
    'secrets.get',
    'secrets.set',
    'settings.get',
    'settings.onChanged',
    'settings.register',
    'settings.set',
    'shell.openExternal',
    'shell.openPath',
    'sqlite.open',
    'statusBar.createItem',
    'statusBar.hide',
    'statusBar.setText',
    'statusBar.setTooltip',
    'statusBar.show',
    'theme.getCurrent',
    'theme.onChanged',
    'timer.clearInterval',
    'timer.clearTimeout',
    'timer.setInterval',
    'timer.setTimeout',
    'update.getVersion',
    'update.onEvent',
    'views.registerTreeProvider',
    'window.close',
    'window.isFocused',
    'window.isMaximized',
    'window.minimize',
    'window.onFocusChanged',
    'window.setProgressBar',
    'window.toggleMaximize',
    'workspaceState.get',
    'workspaceState.keys',
    'workspaceState.update'
  ])

  const stubs = rows.filter((row) => row.status === 'stub')
  // 行数与分布锁死：阶段 B 把某个桩落地时这里会失败，提醒同步对照表（而不是悄悄少一行）
  assert.equal(rows.length, 99, '对照表共 99 项（89 已实现 + 10 桩）')
  assert.equal(
    stubs.length,
    10,
    '桩 10 项（ui 5 + output.createChannel 1 + update 4，全归 EH-B3b-2）'
  )
  assert.equal(
    rows.length,
    implemented.length + stubs.length,
    '对照表不得有既非已实现也非桩的第三类'
  )

  // 每个桩都必须：调用即 EH_INTERNAL + 「尚未迁移」+ 指向阶段 B 文档
  for (const row of stubs) {
    const member = resolveApiMember(built.api, row.capability)
    assert.equal(typeof member, 'function', `${row.capability} 应是函数`)
    const call = member as () => unknown
    await assert.rejects(
      async (): Promise<void> => {
        await call()
      },
      (error: unknown): boolean => {
        assert.ok(error instanceof EhProtocolError, `${row.capability} 应抛 EhProtocolError`)
        assert.equal(error.code, 'EH_INTERNAL')
        assert.match(error.message, /尚未迁移/)
        assert.match(error.message, /阶段 B/)
        return true
      }
    )
  }

  // 同步桩也当场抛（不是返回假值）
  // EH-B3b-1 之后 `statusBar` 不再是桩：本用例没给 `rendererPort`，抛的是「端口未到」而非「尚未迁移」
  assert.throws(() => built.api.statusBar.setText('a', 'b'), /host-renderer 端口未到/)
  // EH-B3a 之后 `window.onFocusChanged` 已是真实现（订阅类 API 不抛错，只是没有事件源）
  assert.doesNotThrow(() => built.api.window.onFocusChanged(() => {}).dispose())
  assert.throws(() => built.api.output.createChannel('x'), /尚未迁移/)
})

/** 按点分路径从 api 对象取成员 */
function resolveApiMember(api: unknown, capability: string): unknown {
  let current: unknown = api
  for (const key of capability.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/* -------------------------------------------------------------------------------------------- */
/* 8. ENTRY（可选扩展）——运行时日志信封出口                                                        */
/* -------------------------------------------------------------------------------------------- */

test('log 信封：EnvSink / Logger 可独立使用，且超限帧被丢弃而不是抛错', async () => {
  const sent: Envelope[] = []
  const port: HostPort = {
    post(message: unknown): void {
      sent.push(message as Envelope)
    },
    subscribe(): () => void {
      return (): void => {}
    }
  }
  const failures: string[] = []
  const sink = createEnvelopeSink(port, (message: string): void => {
    failures.push(message)
  })
  const logger = createEnvelopeLogger(sink)
  logger('warn', '一条日志', '带细节')

  const logs = envelopesOf(sent, 'log')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].level, 'warn')
  assert.match(logs[0].message, /一条日志（带细节）/)

  // 超过 8 MB 的帧：不发、不抛，只记失败
  sink({ v: 1, t: 'event', channel: 'big', payload: 'x'.repeat(9 * 1024 * 1024) })
  assert.equal(sent.length, 1, '超限帧必须被丢弃')
  assert.ok(failures.some((message) => message.includes('丢弃一帧')))
  assert.ok(logs.length === 1)
})
