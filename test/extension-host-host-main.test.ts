/**
 * EH-B3a · 主进程类能力族单测（`window` / `overlay` / `dialog` / `shell` / `notification` /
 * `secrets` / `update.getVersion` / `update.onEvent` / `proxy.get`）。
 *
 * 覆盖判据（任务卡 + 裁定 R64/R65/R66/R67）：
 * - 每条能力**一次成功路径 + 一次失败路径**（失败一律中文错误）；
 * - **overlay 越权被拒**：宿主把 `extId` 绑死在请求里，main 的越权判定原样生效
 *   （R66：`appWindow.ts` 只加了 `export`，校验一行未动）；
 * - `update` 的 4 条门控方法**是桩**（R64），且桩文案含「尚未迁移」「阶段 B」与 R64 指引；
 * - 事件源（R65）：`HostEventSource` 窄接口、**无订阅者不轮询**、只取新增事件（游标）、
 *   `dispose` 停轮询；
 * - 源码门禁：`HOST_MAIN_METHODS` 的每个 key 都在 `src/main/index.ts` 里注册；
 * - 对照表：EH-B3b-1 之后 **89 已实现 + 10 桩 = 99**。
 *
 * 刻意**不进 Electron**：宿主能力层只认 `HostMainBridge`（`request`），因此全部用假桥
 * 断言"宿主发了什么、怎么翻译回来的"；main 侧的真实实现由既有测试覆盖
 * （`test/overlay-window.test.ts` 已用 `vi.mock('electron')` 跑真实的 `appWindow.ts`，
 * 含越权矩阵）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'

import { EhProtocolError } from '../src/shared/extensionHostProtocol'
import { createExtensionApi, listApiImplementation } from '../src/extension-host/apiFactory'
import {
  DEFAULT_EVENT_POLL_INTERVAL_MS,
  HOST_MAIN_EVENT_CHANNELS,
  HOST_MAIN_METHODS,
  createHostMainCapabilities,
  createPollingEventSource,
  type EventPollTimers,
  type HostEvent,
  type HostEventSource,
  type HostMainCapabilities,
  type PollingEventSource
} from '../src/extension-host/capabilities/host-main'
import type { HostMainBridge } from '../src/extension-host/capabilities/io'
import type { HostLogger } from '../src/extension-host/log'
import { createRunExtensionSafely } from '../src/extension-host/safety'

/* -------------------------------------------------------------------------------------------- */
/* 假件：桥、事件源、定时器、日志                                                                  */
/* -------------------------------------------------------------------------------------------- */

interface RecordedCall {
  method: string
  params: unknown
}

/** main 侧应答函数：按 method 造返回值（可以抛错，模拟链路失败） */
type Responder = (method: string, params: unknown) => unknown

interface FakeBridge {
  bridge: HostMainBridge
  calls: RecordedCall[]
  /** 某方法的第 n 次调用参数 */
  paramsOf(method: string, index?: number): unknown
  methods(): string[]
}

function createFakeBridge(responder: Responder): FakeBridge {
  const calls: RecordedCall[] = []
  return {
    bridge: {
      async request(method: string, params?: unknown): Promise<unknown> {
        calls.push({ method, params })
        return await responder(method, params)
      }
    },
    calls,
    paramsOf(method: string, index = 0): unknown {
      return calls.filter((call) => call.method === method)[index]?.params
    },
    methods(): string[] {
      return calls.map((call) => call.method)
    }
  }
}

/** 假事件源：只记 start/stop 次数，测试用 `emit` 手动投递 */
interface FakeEventSource extends HostEventSource {
  emit(channel: string, payload: unknown): void
  starts(): number
  stops(): number
  emitting(): boolean
}

function createFakeEventSource(): FakeEventSource {
  let dispatch: ((event: HostEvent) => void) | null = null
  let starts = 0
  let stops = 0
  return {
    start(next: (event: HostEvent) => void): void {
      starts += 1
      dispatch = next
    },
    stop(): void {
      stops += 1
      dispatch = null
    },
    emit(channel: string, payload: unknown): void {
      dispatch?.({ channel, payload })
    },
    starts: (): number => starts,
    stops: (): number => stops,
    emitting: (): boolean => dispatch !== null
  }
}

/** 可编排的定时器（断言"没有订阅者时一次都没起定时器"） */
interface ManualTimers extends EventPollTimers {
  intervals(): number
  /** 当前活跃的间隔回调数 */
  active(): number
  tick(): void
}

function createManualTimers(): ManualTimers {
  const handles = new Map<number, () => void>()
  let seq = 0
  return {
    setInterval(callback: () => void): unknown {
      seq += 1
      handles.set(seq, callback)
      return seq
    },
    clearInterval(handle: unknown): void {
      handles.delete(handle as number)
    },
    intervals(): number {
      return seq
    },
    active(): number {
      return handles.size
    },
    tick(): void {
      for (const callback of [...handles.values()]) callback()
    }
  }
}

interface CapturedLog {
  level: string
  message: string
}

interface Harness {
  caps: HostMainCapabilities
  calls: FakeBridge
  events: FakeEventSource
  logs: CapturedLog[]
  dispose(): void
}

const createdCaps: HostMainCapabilities[] = []

function createHarness(
  responder: Responder,
  overrides: { extId?: string; bridge?: HostMainBridge; eventSource?: HostEventSource } = {}
): Harness {
  const fake = createFakeBridge(responder)
  const events = createFakeEventSource()
  const logs: CapturedLog[] = []
  const log: HostLogger = (level, message, detail): void => {
    logs.push({ level, message: detail === undefined ? message : `${message}（${detail}）` })
  }
  const caps = createHostMainCapabilities({
    extId: overrides.extId ?? 'ext-a',
    log,
    hostMain: overrides.bridge ?? fake.bridge,
    eventSource: overrides.eventSource ?? events
  })
  createdCaps.push(caps)
  return {
    caps,
    calls: fake,
    events,
    logs,
    dispose(): void {
      caps.dispose()
    }
  }
}

/** 成功应答：`{ok:true, ...extra}` */
function ok(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, ...extra }
}

/** 失败应答（中文错误） */
function fail(error: string): Record<string, unknown> {
  return { ok: false, error }
}

/**
 * 能力方法名序列（**剔除 `host.proxy.get`**）：`proxy` 是同步快照，构造时就会预热一次，
 * 因此每条能力的用例里都会多出这条探测请求——断言"我调了什么"时把它滤掉。
 */
function methodsOf(fake: FakeBridge): string[] {
  return fake.methods().filter((method) => method !== HOST_MAIN_METHODS.proxyGet)
}

afterEach((): void => {
  for (const caps of createdCaps.splice(0)) caps.dispose()
})

/* -------------------------------------------------------------------------------------------- */
/* 1. window(7)                                                                                  */
/* -------------------------------------------------------------------------------------------- */

test('window：6 条 RPC 成功路径的入参与返回值（含 setProgressBar 原样透传 null）', async (): Promise<void> => {
  const harness = createHarness((method) => {
    if (method === HOST_MAIN_METHODS.windowIsMaximized) return ok({ value: true })
    if (method === HOST_MAIN_METHODS.windowIsFocused) return ok({ value: false })
    return ok()
  })

  await harness.caps.window.minimize()
  await harness.caps.window.toggleMaximize()
  await harness.caps.window.close()
  assert.equal(await harness.caps.window.isMaximized(), true)
  assert.equal(await harness.caps.window.isFocused(), false)
  await harness.caps.window.setProgressBar(0.62)
  await harness.caps.window.setProgressBar(null)

  assert.deepEqual(methodsOf(harness.calls), [
    HOST_MAIN_METHODS.windowMinimize,
    HOST_MAIN_METHODS.windowToggleMaximize,
    HOST_MAIN_METHODS.windowClose,
    HOST_MAIN_METHODS.windowIsMaximized,
    HOST_MAIN_METHODS.windowIsFocused,
    HOST_MAIN_METHODS.windowSetProgressBar,
    HOST_MAIN_METHODS.windowSetProgressBar
  ])
  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.windowSetProgressBar, 0), {
    progress: 0.62
  })
  assert.deepEqual(
    harness.calls.paramsOf(HOST_MAIN_METHODS.windowSetProgressBar, 1),
    { progress: null },
    'null 必须原样传出（不是省略字段）'
  )
  assert.equal(
    harness.calls.paramsOf(HOST_MAIN_METHODS.windowMinimize),
    null,
    '无参能力发 null（协议层的缺省 params）'
  )
})

test('window：失败路径 —— main 回 {ok:false} ⇒ 抛中文错误；非法 progress 在宿主侧就被拒', async (): Promise<void> => {
  const harness = createHarness(() =>
    fail('window.minimize 未执行：没有可用窗口（主窗口可能正在关闭）')
  )

  await assert.rejects(harness.caps.window.minimize(), /没有可用窗口/)
  await assert.rejects(harness.caps.window.toggleMaximize(), /没有可用窗口/)
  await assert.rejects(harness.caps.window.close(), /没有可用窗口/)
  await assert.rejects(harness.caps.window.isMaximized(), /没有可用窗口/)
  await assert.rejects(harness.caps.window.isFocused(), /没有可用窗口/)

  // 参数错误**不发 RPC**（宿主侧当场拒），文案是中文
  const before = harness.calls.calls.length
  await assert.rejects(harness.caps.window.setProgressBar(Number.NaN), /必须是 0~1 的有限数字/)
  await assert.rejects(harness.caps.window.setProgressBar(Number.POSITIVE_INFINITY), /有限数字/)
  assert.equal(harness.calls.calls.length, before, '参数错误不该把请求发到 main')
})

test('window：main 回非布尔值 ⇒ 明确报错（不把 undefined 当 false 静默吞掉）', async (): Promise<void> => {
  const harness = createHarness(() => ok())
  await assert.rejects(harness.caps.window.isMaximized(), /没有返回布尔值/)
  await assert.rejects(harness.caps.window.isFocused(), /没有返回布尔值/)
})

test('window.onFocusChanged：订阅只在有监听者时起事件源，退订即停（R65 要求 2）', async (): Promise<void> => {
  const harness = createHarness(() => ok())
  assert.equal(harness.events.starts(), 0, '没有订阅者时不许起事件源')

  const seen: boolean[] = []
  const disposable = harness.caps.window.onFocusChanged((focused): void => {
    seen.push(focused)
  })
  assert.equal(harness.events.starts(), 1)
  assert.equal(harness.caps.isPolling(), true)

  harness.events.emit(HOST_MAIN_EVENT_CHANNELS.windowFocus, { focused: true })
  harness.events.emit(HOST_MAIN_EVENT_CHANNELS.windowFocus, { focused: false })
  // 坏形状被忽略（不抛错、不回调）
  harness.events.emit(HOST_MAIN_EVENT_CHANNELS.windowFocus, { focused: 'yes' })
  assert.deepEqual(seen, [true, false])

  disposable.dispose()
  assert.equal(harness.caps.isPolling(), false, '最后一个订阅者退订后必须停轮询')

  // 再订阅：重新起（不是永久关闭）
  harness.caps.window.onFocusChanged((): void => {})
  assert.equal(harness.events.starts(), 2)
  // 失败路径：callback 不是函数 ⇒ 中文错（同步抛，不静默订阅一个坏回调）
  assert.throws(
    () => harness.caps.window.onFocusChanged(null as unknown as () => void),
    /callback 必须是函数/
  )
  harness.caps.dispose()
  assert.equal(harness.caps.isPolling(), false, 'dispose 必须停轮询')
})

/* -------------------------------------------------------------------------------------------- */
/* 2. overlay(4) + 越权（R66 的关键验收）                                                          */
/* -------------------------------------------------------------------------------------------- */

test('overlay：extId 由宿主绑定 —— 扩展侧没有该参数，四个方法都只带调用方的 id', async (): Promise<void> => {
  const harness = createHarness((method) => {
    if (method === HOST_MAIN_METHODS.overlayCreate) return ok({ position: { x: 10, y: 20 } })
    return ok()
  })

  const created = await harness.caps.overlay.create({
    id: 'pet.overlay',
    url: 'app://extensions/ext-a/overlay.html',
    width: 200,
    height: 200,
    anchor: 'bottom-right'
  })
  assert.deepEqual(created, { ok: true, position: { x: 10, y: 20 } })

  await harness.caps.overlay.setMouseThrough('pet.overlay', true)
  await harness.caps.overlay.setPosition('pet.overlay', 100, 50)
  await harness.caps.overlay.destroy('pet.overlay')

  const createParams = harness.calls.paramsOf(HOST_MAIN_METHODS.overlayCreate) as {
    extId: string
    request: { id: string }
  }
  assert.equal(createParams.extId, 'ext-a', 'extId 必须由宿主注入')
  assert.equal(createParams.request.id, 'pet.overlay')
  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.overlaySetMouseThrough), {
    extId: 'ext-a',
    id: 'pet.overlay',
    through: true
  })
  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.overlaySetPosition), {
    extId: 'ext-a',
    id: 'pet.overlay',
    x: 100,
    y: 50
  })
  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.overlayDestroy), {
    extId: 'ext-a',
    id: 'pet.overlay'
  })
  // 不存在任何"扩展自报 extId"的入口：请求里只有宿主注入的那一个
  for (const call of harness.calls.calls) {
    if (call.method === HOST_MAIN_METHODS.proxyGet) continue
    const params = call.params as Record<string, unknown>
    assert.equal(params.extId, 'ext-a')
    assert.equal(Object.keys(params).includes('owner'), false)
  }
})

test('overlay：越权被拒 —— main 的「越权被拒」原样回给扩展，且不污染本扩展的登记表', async (): Promise<void> => {
  const ownerError =
    '越权被拒：overlay pet.overlay 由扩展 ext-b 创建，ext-a 只能操作自己创建的 overlay'
  const harness = createHarness((method) => {
    if (method === HOST_MAIN_METHODS.overlayDestroy) return fail(ownerError)
    return fail(ownerError)
  })

  const destroyed = await harness.caps.overlay.destroy('pet.overlay')
  assert.equal(destroyed.ok, false)
  assert.match(destroyed.error ?? '', /越权被拒/)
  assert.match(destroyed.error ?? '', /ext-b/, '错误要指认真实属主（复用 main 的文案）')

  const moved = await harness.caps.overlay.setPosition('pet.overlay', 10, 10)
  assert.equal(moved.ok, false)
  assert.match(moved.error ?? '', /越权被拒/)

  const through = await harness.caps.overlay.setMouseThrough('pet.overlay', false)
  assert.equal(through.ok, false)
  assert.match(through.error ?? '', /越权被拒/)
})

test('overlay：失败路径与参数校验（回值不抛错，v1 语义）+ 非法坐标不钳不猜', async (): Promise<void> => {
  const harness = createHarness(() =>
    fail("overlay id 已存在（重复创建）：pet.overlay；要重建请先 destroy('pet.overlay')")
  )

  const duplicate = await harness.caps.overlay.create({
    id: 'pet.overlay',
    url: 'app://extensions/ext-a/overlay.html',
    width: 200,
    height: 200,
    anchor: 'bottom-right'
  })
  assert.equal(duplicate.ok, false, 'overlay.create 失败**不抛错**（v1 的 {ok:false} 风格）')
  assert.match(duplicate.error ?? '', /已存在/)

  await assert.rejects(harness.caps.overlay.destroy(''), /id 必须是非空字符串/)
  await assert.rejects(harness.caps.overlay.setPosition('pet.overlay', Number.NaN, 0), /不钳不猜/)
  await assert.rejects(
    harness.caps.overlay.setMouseThrough('pet.overlay', 'yes' as unknown as boolean),
    /through 必须是布尔值/
  )
  const badShape = await harness.caps.overlay.destroy('pet.overlay')
  assert.equal(badShape.ok, false)
})

test('overlay：dispose 回收本扩展创建过的 overlay（停用即销毁窗体，v1 语义；幂等）', async (): Promise<void> => {
  const harness = createHarness(() => ok())
  await harness.caps.overlay.create({
    id: 'pet.a',
    url: 'app://extensions/ext-a/a.html',
    width: 100,
    height: 100,
    anchor: 'bottom-right'
  })
  await harness.caps.overlay.create({
    id: 'pet.b',
    url: 'app://extensions/ext-a/b.html',
    width: 100,
    height: 100,
    anchor: 'bottom-right'
  })

  const before = harness.calls.methods().filter((m) => m === HOST_MAIN_METHODS.overlayDestroy)
  assert.equal(before.length, 0)

  harness.caps.dispose()
  harness.caps.dispose() // 幂等：不重复发

  const destroys = harness.calls.calls.filter((c) => c.method === HOST_MAIN_METHODS.overlayDestroy)
  assert.equal(destroys.length, 2, '两个 overlay 各销毁一次（dispose 幂等）')
  assert.deepEqual(destroys.map((call) => (call.params as { id: string }).id).sort(), [
    'pet.a',
    'pet.b'
  ])
  for (const call of destroys) {
    assert.equal((call.params as { extId: string }).extId, 'ext-a')
  }
})

/* -------------------------------------------------------------------------------------------- */
/* 3. dialog(3) / shell(2)                                                                       */
/* -------------------------------------------------------------------------------------------- */

test('dialog：三条成功路径（opts 原样进 RPC，返回值收成 v1 形状）', async (): Promise<void> => {
  const harness = createHarness((method) => {
    if (method === HOST_MAIN_METHODS.dialogOpen) {
      return { ok: true, filePaths: ['C:/tmp/a.txt'], canceled: false }
    }
    if (method === HOST_MAIN_METHODS.dialogSave) {
      return { ok: true, filePath: 'C:/tmp/b.txt', canceled: false }
    }
    return { ok: true, response: 1 }
  })

  const opened = await harness.caps.dialog.showOpenDialog({ title: '选文件' })
  assert.deepEqual(opened, { ok: true, filePaths: ['C:/tmp/a.txt'], canceled: false })

  const saved = await harness.caps.dialog.showSaveDialog({ defaultName: 'b.txt' })
  assert.deepEqual(saved, { ok: true, filePath: 'C:/tmp/b.txt', canceled: false })

  const message = await harness.caps.dialog.showMessageBox({
    message: '继续？',
    buttons: ['是', '否']
  })
  assert.deepEqual(message, { ok: true, response: 1 })

  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.dialogOpen), {
    opts: { title: '选文件' }
  })
  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.dialogSave), {
    opts: { defaultName: 'b.txt' }
  })
})

test('dialog：失败路径 —— opts 形状非法（中文）与 main 的 {ok:false} 回值', async (): Promise<void> => {
  const harness = createHarness(() => fail('showErrorBox 之前被取消（模拟失败）'))

  await assert.rejects(
    harness.caps.dialog.showOpenDialog('oops' as unknown as undefined),
    /opts 必须是对象/
  )
  await assert.rejects(
    harness.caps.dialog.showSaveDialog([] as unknown as undefined),
    /opts 必须是对象/
  )

  const opened = await harness.caps.dialog.showOpenDialog()
  assert.equal(opened.ok, false, 'dialog 失败是回值（v1 风格），不抛错')
  assert.match(opened.error ?? '', /模拟失败/)

  const message = await harness.caps.dialog.showMessageBox()
  assert.equal(message.ok, false)
  const saved = await harness.caps.dialog.showSaveDialog()
  assert.equal(saved.ok, false)
})

test('shell：成功路径 + 中文失败路径（http/https 白名单在 main，空 url 在宿主侧拒）', async (): Promise<void> => {
  let reject = false
  const harness = createHarness((method) => {
    if (method === HOST_MAIN_METHODS.shellOpenExternal) {
      return reject ? fail('openExternal 仅支持 http/https 链接') : ok()
    }
    return ok()
  })

  assert.deepEqual(await harness.caps.shell.openExternal('https://example.com'), { ok: true })
  assert.deepEqual(await harness.caps.shell.openPath('C:/tmp'), { ok: true })
  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.shellOpenExternal), {
    url: 'https://example.com'
  })
  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.shellOpenPath), { path: 'C:/tmp' })

  reject = true
  const blocked = await harness.caps.shell.openExternal('file:///etc/passwd')
  assert.equal(blocked.ok, false)
  assert.match(blocked.error ?? '', /仅支持 http\/https/)

  await assert.rejects(harness.caps.shell.openExternal(''), /url 必须是非空字符串/)
  await assert.rejects(harness.caps.shell.openPath('  '), /path 必须是非空字符串/)
})

/* -------------------------------------------------------------------------------------------- */
/* 4. notification(1)（含 onClick 的批量一次性语义）                                                */
/* -------------------------------------------------------------------------------------------- */

test('notification：成功路径 —— onClick 不出宿主，靠 notifId 关联，点击后只触发一次', async (): Promise<void> => {
  const harness = createHarness((method) => {
    if (method === HOST_MAIN_METHODS.notificationShow) return { ok: true, id: 7 }
    return ok()
  })

  let clicks = 0
  const shown = await harness.caps.notification.show({
    title: '下载完成',
    body: 'v2.0.0',
    onClick: (): void => {
      clicks += 1
    }
  })
  assert.deepEqual(shown, { ok: true })

  const params = harness.calls.paramsOf(HOST_MAIN_METHODS.notificationShow) as {
    extId: string
    opts: Record<string, unknown>
  }
  assert.equal(params.extId, 'ext-a')
  assert.deepEqual(params.opts, { title: '下载完成', body: 'v2.0.0' })
  assert.equal('onClick' in params.opts, false, '函数不许进 RPC 帧')

  // 别的通知点击：不触发（按 notifId 过滤）
  harness.events.emit(HOST_MAIN_EVENT_CHANNELS.notificationClick, { notifId: 8 })
  assert.equal(clicks, 0)
  harness.events.emit(HOST_MAIN_EVENT_CHANNELS.notificationClick, { notifId: 7 })
  assert.equal(clicks, 1)
  // 第二次同 id 不再触发（v1 的 off() 一次性语义）
  harness.events.emit(HOST_MAIN_EVENT_CHANNELS.notificationClick, { notifId: 7 })
  assert.equal(clicks, 1)
  assert.equal(harness.caps.isPolling(), false, '一次性订阅结束 + 无其它订阅 ⇒ 停轮询')
})

test('notification：失败路径 —— title 缺失（中文）与 main 的 {ok:false}（保持回值）', async (): Promise<void> => {
  const harness = createHarness((method) =>
    method === HOST_MAIN_METHODS.notificationShow ? fail('通知 title 必填') : ok()
  )

  await assert.rejects(harness.caps.notification.show({ title: '   ' }), /title 必须是非空字符串/)
  await assert.rejects(
    harness.caps.notification.show(null as unknown as { title: string }),
    /opts 必须是对象/
  )

  const failed = await harness.caps.notification.show({ title: '标题' })
  assert.deepEqual(
    failed,
    { ok: false, error: '通知 title 必填' },
    'v1：notification 回 {ok:false}'
  )
})

/* -------------------------------------------------------------------------------------------- */
/* 5. secrets(3)                                                                                 */
/* -------------------------------------------------------------------------------------------- */

test('secrets：成功路径（extId+key 的绑定、undefined 透传）', async (): Promise<void> => {
  const harness = createHarness((method, params) => {
    if (method === HOST_MAIN_METHODS.secretsGet) {
      const key = (params as { key: string }).key
      return key === 'absent' ? ok({ value: undefined }) : ok({ value: 'token-123' })
    }
    return ok()
  })

  assert.equal(await harness.caps.secrets.get('token'), 'token-123')
  assert.equal(await harness.caps.secrets.get('absent'), undefined)
  await harness.caps.secrets.set('token', 'token-456')
  await harness.caps.secrets.delete('token')

  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.secretsGet), {
    extId: 'ext-a',
    key: 'token'
  })
  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.secretsSet), {
    extId: 'ext-a',
    key: 'token',
    value: 'token-456'
  })
  assert.deepEqual(harness.calls.paramsOf(HOST_MAIN_METHODS.secretsDelete), {
    extId: 'ext-a',
    key: 'token'
  })
})

test('secrets：失败路径 —— {ok:false} **抛错**（照抄 v1 的分类），空 key 与坏 value 在宿主侧拒', async (): Promise<void> => {
  const harness = createHarness((method) =>
    method === HOST_MAIN_METHODS.secretsGet ? fail('系统加密不可用（safeStorage）') : ok()
  )

  await assert.rejects(harness.caps.secrets.get('token'), /系统加密不可用（safeStorage）/)
  await assert.rejects(harness.caps.secrets.get(''), /key 必须是非空字符串/)
  await assert.rejects(
    harness.caps.secrets.set('token', 42 as unknown as string),
    /value 必须是字符串/
  )
  await assert.rejects(harness.caps.secrets.delete(' '), /key 必须是非空字符串/)
})

/* -------------------------------------------------------------------------------------------- */
/* 6. update.getVersion / update.onEvent（4 条门控方法是桩 → 见第 8 节）                              */
/* -------------------------------------------------------------------------------------------- */

test('update.getVersion：返回版本字符串；坏值明确报错', async (): Promise<void> => {
  let value: unknown = '2.0.0'
  const harness = createHarness(() => ok({ value }))
  assert.equal(await harness.caps.update.getVersion(), '2.0.0')

  value = undefined
  await assert.rejects(harness.caps.update.getVersion(), /没有返回版本字符串/)
  value = ''
  await assert.rejects(harness.caps.update.getVersion(), /没有返回版本字符串/)
  assert.equal(methodsOf(harness.calls)[0], HOST_MAIN_METHODS.updateVersion)
})

test('update.onEvent：订阅 update 事件（载荷原样交给回调），退订即停', async (): Promise<void> => {
  const harness = createHarness(() => ok())
  const seen: unknown[] = []
  const disposable = harness.caps.update.onEvent((event): void => {
    seen.push(event)
  })
  assert.equal(harness.caps.isPolling(), true)

  const payload = {
    type: 'download-progress',
    percent: 42,
    bytesPerSecond: 1,
    transferred: 2,
    total: 4
  }
  harness.events.emit(HOST_MAIN_EVENT_CHANNELS.updateEvent, payload)
  harness.events.emit(HOST_MAIN_EVENT_CHANNELS.updateEvent, 'not-an-object')
  assert.deepEqual(seen, [payload])

  disposable.dispose()
  assert.equal(harness.caps.isPolling(), false)

  // 失败路径：callback 不是函数 ⇒ 中文错（同步抛）
  assert.throws(
    () => harness.caps.update.onEvent(undefined as unknown as () => void),
    /callback 必须是函数/
  )
})

/* -------------------------------------------------------------------------------------------- */
/* 7. proxy.get（同步 + 缓存快照）                                                                 */
/* -------------------------------------------------------------------------------------------- */

test('proxy.get：同步返回缓存快照 —— 构造预热、过期刷新、坏形状降级为直连并 warn（TTL=0 便于断言）', async (): Promise<void> => {
  let answer: unknown = ok({
    value: { enabled: true, url: 'http://127.0.0.1:7890', noProxy: ['localhost'] }
  })
  const fake = createFakeBridge((method) => (method === HOST_MAIN_METHODS.proxyGet ? answer : ok()))
  const events = createFakeEventSource()
  const logs: CapturedLog[] = []
  const caps = createHostMainCapabilities({
    extId: 'ext-a',
    log: (level, message): void => {
      logs.push({ level, message })
    },
    hostMain: fake.bridge,
    eventSource: events,
    // TTL=0 ⇒ 每次 get() 都刷新（生产默认 1s，见 DEFAULT_PROXY_CACHE_TTL_MS）
    proxyCacheTtlMs: 0
  })
  createdCaps.push(caps)

  // 预热是异步的：等一轮事件循环
  await new Promise<void>((resolve) => setImmediate(resolve))
  const warm = caps.proxy.get()
  assert.equal(warm.enabled, true, '预热完成后同步读得到真值')
  assert.equal(warm.url, 'http://127.0.0.1:7890')
  assert.deepEqual(warm.noProxy, ['localhost'])
  await new Promise<void>((resolve) => setImmediate(resolve))

  // 主进程侧改了配置：过期后的一次读会顺手刷新，随后就读到新值
  answer = ok({ value: { enabled: false, url: 'http://127.0.0.1:9999' } })
  caps.proxy.get()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const refreshed = caps.proxy.get()
  assert.equal(refreshed.enabled, false)
  assert.equal(refreshed.url, 'http://127.0.0.1:9999')
  await new Promise<void>((resolve) => setImmediate(resolve))

  // 坏形状：回落默认（直连）+ 一条中文 warn（不静默）
  answer = ok({ value: 'not-a-config' })
  caps.proxy.get()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const degraded = caps.proxy.get()
  assert.equal(degraded.enabled, false)
  assert.equal(degraded.url, '')
  assert.ok(
    logs.some((entry) => entry.level === 'warn' && /代理配置形状无法识别/.test(entry.message)),
    '降级必须有中文 warn'
  )
  assert.equal(
    fake.methods().every((m) => m === HOST_MAIN_METHODS.proxyGet),
    true
  )
  assert.ok(fake.calls.length >= 4, '每次过期读都会发一条 host.proxy.get')
})

/* -------------------------------------------------------------------------------------------- */
/* 8. 缺桥 / RPC 链路错误 / 桩（update 4 条）                                                      */
/* -------------------------------------------------------------------------------------------- */

test('缺桥（hostMain 未接线）：每一步都抛 EH_INTERNAL +「需要主进程 IPC」，不抛「尚未迁移」', async (): Promise<void> => {
  const logs: CapturedLog[] = []
  const caps = createHostMainCapabilities({
    extId: 'ext-a',
    log: (level, message): void => {
      logs.push({ level, message })
    }
  })
  createdCaps.push(caps)

  for (const call of [
    (): Promise<unknown> => caps.window.minimize(),
    (): Promise<unknown> => caps.window.isFocused(),
    (): Promise<unknown> => caps.dialog.showOpenDialog(),
    (): Promise<unknown> => caps.shell.openExternal('https://example.com'),
    (): Promise<unknown> => caps.notification.show({ title: 'x' }),
    (): Promise<unknown> => caps.secrets.get('k'),
    (): Promise<unknown> => caps.update.getVersion(),
    (): Promise<unknown> => caps.overlay.destroy('pet.overlay')
  ]) {
    await assert.rejects(call, (error: unknown): boolean => {
      assert.ok(error instanceof EhProtocolError)
      assert.equal(error.code, 'EH_INTERNAL')
      assert.match(error.message, /需要主进程 IPC/)
      assert.doesNotMatch(error.message, /尚未迁移/, '缺桥不是"未迁移"，文案不能混用')
      return true
    })
  }
  // 订阅类 API 不抛错（v1 语义），但没有事件源 ⇒ 不起轮询
  const disposable = caps.window.onFocusChanged((): void => {})
  assert.equal(caps.isPolling(), false)
  disposable.dispose()
})

test('RPC 链路错误（EhProtocolError）：超时/取消原样抛，不被包成"能力失败"', async (): Promise<void> => {
  const harness = createHarness(() => {
    throw new EhProtocolError(
      'EH_TIMEOUT',
      '对端在超时时间内没有响应。',
      'method=host.window.close'
    )
  })
  await assert.rejects(harness.caps.window.close(), (error: unknown): boolean => {
    assert.ok(error instanceof EhProtocolError)
    assert.equal(error.code, 'EH_TIMEOUT', '超时语义必须保留（可重试判断靠它）')
    return true
  })

  // 非协议错误则包成中文上下文
  const broken = createHarness(() => {
    throw new Error('pipe closed')
  })
  await assert.rejects(broken.caps.window.close(), /window.close 失败：pipe closed/)
})

test('兜底读值：main 回非对象 / 缺 ok 时按失败处理（不猜成功）', async (): Promise<void> => {
  const harness = createHarness(() => 'garbage')
  await assert.rejects(harness.caps.window.close(), /无法识别的结果/)
  await assert.rejects(harness.caps.secrets.get('k'), /无法识别的结果/)
  const overlay = await harness.caps.overlay.destroy('pet.overlay')
  assert.equal(overlay.ok, false)
  assert.match(overlay.error ?? '', /无法识别的结果/)
})

test('update 的 4 条门控方法（EH-B3b-2 起）：先问渲染侧，端口不在就 EH_NOT_READY（不再是桩）', async (): Promise<void> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-b3b2-gate-'))
  try {
    const built = createExtensionApi({
      ext: {
        id: 'gate-ext',
        version: '1.0.0',
        path: path.join(dir, 'gate-ext'),
        activationEvents: [],
        apiVersion: 3
      },
      appInfo: { name: 'obox', version: '2.0.0' },
      locale: 'zh',
      log: (): void => {},
      runSafely: createRunExtensionSafely((): void => {})
    })
    // 本用例没有渲染侧端口：门控请求发不出去 ⇒ 响亮失败（「host-renderer 端口未到」），
    // 而不是 v1 阶段 B 那句「尚未迁移」——门控判定已经搬到渲染侧，链路问题要和"没实现"区分开。
    for (const call of [
      (): Promise<unknown> => built.api.update.resolveFeed('owner/repo'),
      (): Promise<unknown> => built.api.update.check('https://example.com/'),
      (): Promise<unknown> => built.api.update.download(),
      (): Promise<unknown> => built.api.update.install({ force: true })
    ]) {
      await assert.rejects(call, (error: unknown): boolean => {
        assert.match(String((error as Error).message), /host-renderer 端口未到/)
        assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
        return true
      })
    }
    built.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------------------------- */
/* 9. 事件源（R65）：窄接口 + 无订阅者不轮询 + 只取新增                                              */
/* -------------------------------------------------------------------------------------------- */

test('轮询事件源：首个订阅才起定时器、退订即停、poll 参数带 extId 与游标', async (): Promise<void> => {
  const timers = createManualTimers()
  const replies = [
    // 第一跳（cursor=null）：只回当前游标，不回放历史
    { cursor: 12, events: [] },
    // 第二跳：只回 seq>12 的新事件
    {
      cursor: 13,
      events: [{ channel: HOST_MAIN_EVENT_CHANNELS.windowFocus, payload: { focused: true } }]
    },
    // 第三跳：没有新事件
    { cursor: 13, events: [] }
  ]
  let index = 0
  const fake = createFakeBridge(() => replies[Math.min(index++, replies.length - 1)])
  const source: PollingEventSource = createPollingEventSource({
    bridge: fake.bridge,
    extId: 'ext-a',
    log: (): void => {},
    intervalMs: 250,
    timers
  })

  assert.equal(source.isRunning(), false, '没有订阅者时不许起定时器（R65 要求 2）')
  assert.equal(timers.intervals(), 0)

  const seen: HostEvent[] = []
  source.start((event): void => {
    seen.push(event)
  })
  assert.equal(source.isRunning(), true)
  assert.equal(timers.intervals(), 1)
  // start 会立刻拉第一跳（只定位游标）：先让它跑完
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(fake.paramsOf(HOST_MAIN_METHODS.eventsPoll, 0), {
    extId: 'ext-a',
    cursor: null
  })
  assert.deepEqual(seen, [], '第一跳不许回放历史事件')
  assert.equal(source.cursor(), 12)

  // 第二跳：带上一跳的游标，只回新增事件
  await source.pollNow()
  assert.deepEqual(fake.paramsOf(HOST_MAIN_METHODS.eventsPoll, 1), { extId: 'ext-a', cursor: 12 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].channel, HOST_MAIN_EVENT_CHANNELS.windowFocus)
  assert.equal(source.cursor(), 13)

  // 第三跳：游标已推进，同一批事件不会重放
  await source.pollNow()
  assert.deepEqual(fake.paramsOf(HOST_MAIN_METHODS.eventsPoll, 2), { extId: 'ext-a', cursor: 13 })
  assert.equal(seen.length, 1, '同一事件不许重放（游标单调推进）')

  source.stop()
  assert.equal(source.isRunning(), false)
  assert.equal(timers.active(), 0, 'stop 必须清掉定时器')
  assert.equal(DEFAULT_EVENT_POLL_INTERVAL_MS, 250)
})

test('轮询事件源：轮询失败只 warn 一次并继续重试（不炸掉宿主）', async (): Promise<void> => {
  const timers = createManualTimers()
  const logs: CapturedLog[] = []
  let failNext = true
  const fake = createFakeBridge(() => {
    if (failNext) throw new Error('socket hang up')
    return { cursor: 1, events: [] }
  })
  const source = createPollingEventSource({
    bridge: fake.bridge,
    extId: 'ext-a',
    log: (level, message): void => {
      logs.push({ level, message })
    },
    timers
  })
  source.start((): void => {})
  await source.pollNow()
  await source.pollNow()
  const warnings = logs.filter((entry) => entry.level === 'warn')
  assert.equal(warnings.length, 1, '连续失败只 warn 一次（避免刷爆宿主日志）')
  assert.match(warnings[0].message, /轮询失败/)
  assert.match(warnings[0].message, /轮询降级/, '说明这是推送的降级实现')

  failNext = false
  await source.pollNow()
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, 1, '成功后不重复 warn')
  source.stop()
})

test('轮询事件源：坏包（非对象 / 游标非法）不抛错、不推进游标', async (): Promise<void> => {
  const timers = createManualTimers()
  const replies = [{ cursor: 'x' }, { cursor: 3, events: 'nope' }, { cursor: 4, events: [{}] }]
  let index = 0
  const fake = createFakeBridge(() => replies[Math.min(index++, replies.length - 1)])
  const source = createPollingEventSource({
    bridge: fake.bridge,
    extId: 'ext-a',
    log: (): void => {},
    timers
  })
  const seen: HostEvent[] = []
  source.start((event): void => {
    seen.push(event)
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(source.cursor(), null, '首跳只定位游标（坏包/空响应都不推进）')

  await source.pollNow() // cursor: 3（合法）+ events: 'nope'（不是数组 ⇒ 按空处理）
  assert.equal(source.cursor(), 3, '游标合法就推进；事件列表坏掉只丢事件')
  await source.pollNow() // cursor: 4 + events: [{}]（缺 channel ⇒ 丢弃）
  assert.equal(source.cursor(), 4)
  assert.deepEqual(seen, [], '事件项缺少 channel 时丢弃')
  source.stop()
})

/* -------------------------------------------------------------------------------------------- */
/* 10. 源码门禁：方法名常量 ↔ main 注册 / safeStorage / 无 electron 依赖                            */
/* -------------------------------------------------------------------------------------------- */

const ROOT = path.resolve(__dirname, '..')

function readSource(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

/** 去掉注释再扫（源码里的注释会**讨论** electron，例如"这里不能 require('electron')"） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('源码门禁：HOST_MAIN_METHODS 的每个 key 都在 src/main/index.ts 里注册（防两边漂移）', (): void => {
  const mainSource = readSource('src/main/index.ts')
  const keys = Object.keys(HOST_MAIN_METHODS)
  assert.equal(
    keys.length,
    26,
    '方法名常量共 26 条（23 项 B3a 能力 + EH-B3b-2 的 4 条 update 门控；onFocusChanged/onEvent 走事件）'
  )

  for (const key of keys) {
    // 允许换行/缩进：prettier 会把长调用折成多行（`registerMethod(` 与常量之间可以有空白）
    const pattern = new RegExp(`registerMethod\\(\\s*HOST_MAIN_METHODS\\.${key}\\b`)
    assert.ok(
      pattern.test(mainSource),
      `src/main/index.ts 里必须 registerMethod(HOST_MAIN_METHODS.${key})`
    )
  }
  // 反向：main 里不许出现手写的 'host.' 字面量方法名（那会绕过常量门禁）
  assert.doesNotMatch(
    mainSource,
    /registerMethod\(\s*'host\./,
    'main 侧不许手写 host.* 方法名字面量'
  )
  // 每个 method 都以 host. 前缀打头，且互不重复
  const values = Object.values(HOST_MAIN_METHODS)
  assert.equal(new Set(values).size, values.length, '方法名不许重复')
  for (const value of values) assert.match(value, /^host\.[a-z-]+(\.[a-z-]+)+$/)
})

test('源码门禁：secrets 在 main 侧仍然只走 safeStorage（index.ts 与 secrets.ts 同规则）', (): void => {
  const mainSource = readSource('src/main/index.ts')
  const secretsSource = readSource('src/main/secrets.ts')
  for (const [name, source] of [
    ['src/main/index.ts', mainSource],
    ['src/main/secrets.ts', secretsSource]
  ] as const) {
    assert.match(source, /safeStorage\.encryptString\(/, `${name} 必须用 safeStorage.encryptString`)
    assert.match(source, /safeStorage\.decryptString\(/, `${name} 必须用 safeStorage.decryptString`)
    assert.match(
      source,
      /isEncryptionAvailable\(\)/,
      `${name} 必须检查加密可用性（fail-closed，不落明文）`
    )
  }
  // 宿主的 secrets 能力层不许自己碰文件/加密（它只能发 RPC）
  const hostSource = stripComments(readSource('src/extension-host/capabilities/host-main.ts'))
  assert.doesNotMatch(hostSource, /safeStorage/, '宿主侧不许出现 safeStorage（那是 main 的能力）')
  assert.doesNotMatch(hostSource, /from 'electron'/)
  assert.doesNotMatch(hostSource, /require\('electron'\)/)
})

test('源码门禁：宿主能力文件不 import electron（extension-host.js 里不能出现 require(electron)）', (): void => {
  const hostSource = stripComments(readSource('src/extension-host/capabilities/host-main.ts'))
  assert.doesNotMatch(hostSource, /from 'electron'/)
  assert.doesNotMatch(hostSource, /require\('electron'\)/)
  // 宿主只看纯类型/纯函数：ProxyConfig 归一化来自 shared（三端共享的纯模块）
  assert.match(hostSource, /from '\.\.\/\.\.\/shared\/proxyConfig'/)
})

/* -------------------------------------------------------------------------------------------- */
/* 11. 对照表（EH-B3b-1 之后）                                                                     */
/* -------------------------------------------------------------------------------------------- */

test('对照表：EH-B3b-2 之后 99 已实现 + 0 桩 = 99（阶段 B 能力面收口）', async (): Promise<void> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-b3a-table-'))
  try {
    const built = createExtensionApi({
      ext: {
        id: 'table-ext',
        version: '1.0.0',
        path: path.join(dir, 'table-ext'),
        activationEvents: [],
        apiVersion: 3
      },
      appInfo: { name: 'obox', version: '2.0.0' },
      locale: 'zh',
      log: (): void => {},
      runSafely: createRunExtensionSafely((): void => {})
    })
    const rows = listApiImplementation(built.api)
    const implemented = rows
      .filter((row) => row.status === 'implemented')
      .map((row) => row.capability)
      .sort()
    const stubs = rows.filter((row) => row.status === 'stub')

    assert.deepEqual(implemented, [
      // EH-B3b-1：注册面数据面（28 项——app / i18n / navbar / on·emit / settings / statusBar /
      // theme / views / workspaceState / globalState / registerCommand / executeCommand）
      'app.onMessage',
      'app.register',
      'appInfo.get',
      'clipboard.readText',
      'clipboard.writeText',
      // EH-B3a：dialog 3 + notification 1 + overlay 4 + proxy.get + secrets 3 + shell 2
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
      // EH-B3b-2：输出通道（渲染侧 outputStore 持有）
      'output.createChannel',
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
      // EH-B3b-2：交互 UI 5 项（渲染侧 uiStore 渲染）
      'ui.showForm',
      'ui.showInputBox',
      'ui.showMessage',
      'ui.showQuickPick',
      'ui.withProgress',
      // EH-B3b-2：更新门控 4 条（渲染侧判定 + 放行后回 main）
      'update.check',
      'update.download',
      'update.getVersion',
      'update.install',
      'update.onEvent',
      'update.resolveFeed',
      'views.registerTreeProvider',
      // EH-B3a：window 7 项
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
    assert.equal(rows.length, 99, '对照表共 99 项')
    assert.equal(implemented.length, 99, '已实现 99 项（61 + EH-B3b-1 的 28 + EH-B3b-2 的 10）')
    assert.equal(stubs.length, 0, '桩 0 项（ui 5 / output 1 / update 4 已在 EH-B3b-2 落地）')

    // 本卡落地的能力不许再抛「尚未迁移」
    await assert.rejects(built.api.secrets.get('k'), (error: unknown): boolean => {
      assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
      return true
    })
    await assert.rejects(built.api.update.getVersion(), (error: unknown): boolean => {
      assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
      return true
    })
    // EH-B3b-2：output / ui / update 门控同样不再是桩（本用例没有渲染侧端口 ⇒ 端口未到）
    assert.throws((): void => built.api.output.createChannel('x'), /host-renderer 端口未到/)
    assert.throws((): void => built.api.ui.showMessage('x'), /host-renderer 端口未到/)

    built.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
