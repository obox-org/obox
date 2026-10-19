/**
 * EH-A1 · 扩展宿主协议单测：信封往返、`validateEnvelope` 畸形矩阵、`checkSerializable` 守卫、
 * 二进制旁路、8 MB 帧上限、错误码文案与常量。
 *
 * 判据来自 `docs/adr/0026-extension-host-process.md` 与 `docs/extension-host-migration.md` 的
 * EH-A1 行：帧编解码往返、超长/畸形帧拒绝、错误码穷举。这里刻意**不测时序**（ready → init →
 * initialized 的先后属于 EH-A2/A3），只测「形状」与「能否过桥」。
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  ACK_TIMEOUT_MS,
  EH_ERROR_CODES,
  EH_ERROR_TEXT,
  EH_EVENT_CHANNELS,
  EH_LINK_CHANNELS,
  ENVELOPE_TYPES,
  FRAME_LIMIT_BYTES,
  FIRST_REQUEST_ID,
  EhProtocolError,
  PROTOCOL_VERSION,
  TERMINATE_GRACE_MS,
  assertFrameSize,
  checkFrameSize,
  checkSerializable,
  collectTransferables,
  createActivateEnvelope,
  createCancelEnvelope,
  createDeactivateEnvelope,
  createErrorEnvelope,
  createEventEnvelope,
  createInitEnvelope,
  createInitializedEnvelope,
  createLogEnvelope,
  createReadyEnvelope,
  createRequestEnvelope,
  createResponseEnvelope,
  createTerminateEnvelope,
  estimateSize,
  isActivationReason,
  isEhErrorCode,
  isEnvelope,
  isLogLevel,
  parseActivationEvent,
  validateActivationReason,
  validateEnvelope,
  type ActivationReason,
  type Envelope,
  type HostedExtensionInfo
} from '../src/shared/extensionHostProtocol'

/** 一条 `HostedExtensionInfo` 样本（覆盖 4 类激活事件） */
function sampleExtension(): HostedExtensionInfo {
  return {
    id: 'pet',
    version: '1.2.3',
    path: 'C:\\Users\\me\\AppData\\Roaming\\obox\\extensions\\pet',
    activationEvents: ['*', 'onStartupFinished', { command: 'pet.toggle' }, { view: 'pet.panel' }],
    apiVersion: 3
  }
}

/** 全部 12 种信封各一条样本（构造器产物） */
function sampleEnvelopes(): Envelope[] {
  return [
    createReadyEnvelope('host-7f3a', 4321),
    createInitEnvelope({
      apiVersion: 3,
      dataDir: 'C:\\Users\\me\\AppData\\Roaming\\obox',
      extensions: [sampleExtension()]
    }),
    createInitializedEnvelope(),
    createActivateEnvelope('pet', { command: 'pet.toggle' }),
    createDeactivateEnvelope('pet'),
    createRequestEnvelope(1, 'fs.readFile', { path: 'a.txt' }),
    createResponseEnvelope(1, { text: 'hello' }),
    createErrorEnvelope(2, 'EH_NOT_READY', '宿主未就绪', 'req#2 在 initialized 之前到达'),
    createCancelEnvelope(3),
    createEventEnvelope('statusBar', { extId: 'pet', text: '99+' }),
    createLogEnvelope('info', '宿主已启动'),
    createTerminateEnvelope()
  ]
}

/** 断言 `validateEnvelope` 失败并返回指定错误码（返回 `why` 便于继续断言路径） */
function expectInvalid(raw: unknown, code = 'EH_INTERNAL'): string {
  const result = validateEnvelope(raw)
  assert.equal(result.ok, false, `期望被拒：${JSON.stringify(raw)}`)
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.code, code)
  assert.ok(result.why.length > 0, 'why 必须给出可读原因')
  return result.why
}

/* -------------------------------------------------------------------------------------------- */
/* 常量与命名                                                                                    */
/* -------------------------------------------------------------------------------------------- */

test('常量：协议版本 1、帧上限 8 MB、ack 3 s、终止宽限 5 s、id 从 1 起', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.equal(FRAME_LIMIT_BYTES, 8 * 1024 * 1024)
  assert.equal(FRAME_LIMIT_BYTES, 8388608, '与 api.net.fetch 的响应上限同值')
  assert.equal(ACK_TIMEOUT_MS, 3000)
  assert.equal(TERMINATE_GRACE_MS, 5000)
  assert.equal(FIRST_REQUEST_ID, 1)
  assert.equal(createTerminateEnvelope().graceMs, TERMINATE_GRACE_MS, 'terminate 默认带 5 s 宽限')
  assert.equal(createTerminateEnvelope(0).graceMs, 0, '显式 0 也是合法宽限')
})

test('通道命名：host-main / host-renderer 两条逻辑通道 + UI 事件 channel 常量', () => {
  assert.equal(EH_LINK_CHANNELS.main, 'host-main')
  assert.equal(EH_LINK_CHANNELS.renderer, 'host-renderer')
  // UI 数据面（ADR-0026 决策 5）：气泡与卡片图标保留字符串
  assert.deepEqual(Object.values(EH_EVENT_CHANNELS).slice(0, 4), [
    'statusBar',
    'commands',
    'views',
    'app.register'
  ])
  assert.equal(EH_EVENT_CHANNELS.bubble, 'bubble')
  assert.equal(EH_EVENT_CHANNELS.cardIcon, 'cardIcon')
})

/* -------------------------------------------------------------------------------------------- */
/* 信封往返与类型守卫                                                                            */
/* -------------------------------------------------------------------------------------------- */

test('信封往返：12 种构造器产物过 structuredClone 后仍被 isEnvelope/validateEnvelope 接受', () => {
  const envelopes = sampleEnvelopes()
  assert.equal(envelopes.length, ENVELOPE_TYPES.length, '每种 t 都要有样本')
  assert.deepEqual(
    envelopes.map((env) => env.t),
    [...ENVELOPE_TYPES],
    '样本顺序与 ENVELOPE_TYPES 一致（覆盖穷举）'
  )
  for (const env of envelopes) {
    const cloned = structuredClone(env)
    assert.deepEqual(cloned, env, `${env.t} 往返后字段不变`)
    assert.equal(isEnvelope(cloned), true, `${env.t} 应通过守卫`)
    const result = validateEnvelope(cloned)
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.env, env, 'validateEnvelope 原样返回（不重建对象）')
  }
})

test('init 往返：扩展摘要含结构化激活事件（4 类齐全）', () => {
  const env = createInitEnvelope({
    apiVersion: 3,
    dataDir: '/home/me/.config/obox',
    extensions: [sampleExtension()]
  })
  const result = validateEnvelope(structuredClone(env))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.env, env)
  const init = result.env
  assert.equal(init.t, 'init')
  if (init.t !== 'init') return
  assert.deepEqual(init.extensions[0].activationEvents, [
    '*',
    'onStartupFinished',
    { command: 'pet.toggle' },
    { view: 'pet.panel' }
  ])
})

test('req/res/err 往返：id 配对、err.detail 不传就不出现字段', () => {
  const request = createRequestEnvelope(7, 'dialog.open', { title: '选文件' })
  assert.deepEqual(structuredClone(request), request)
  assert.equal(request.method, 'dialog.open')

  const plainError = createErrorEnvelope(7, 'EH_TIMEOUT', '超时')
  assert.equal('detail' in plainError, false, 'detail 缺省不写字段（避免 undefined 过不了守卫）')
  assert.equal(validateEnvelope(plainError).ok, true)

  const detailed = createErrorEnvelope(8, 'EH_ACTIVATION_FAILED', '激活失败', 'pet: boom')
  assert.equal(detailed.detail, 'pet: boom')
  assert.equal(validateEnvelope(detailed).ok, true)
})

test('isEnvelope：未知 t 被拒（含驼峰式错误命名）', () => {
  for (const t of ['rpc-request', 'response', 'REQ', '', 'readyy']) {
    assert.equal(isEnvelope({ v: 1, t }), false, `未知 t=${t} 必须被拒`)
    assert.equal(validateEnvelope({ v: 1, t }).ok, false)
  }
})

test('isEnvelope：错误 v 被拒（2 / 字符串 "1" / 缺失 / null）', () => {
  for (const v of [2, 0, '1', undefined, null]) {
    const candidate = { v, t: 'initialized' }
    assert.equal(isEnvelope(candidate), false, `v=${String(v)} 必须被拒`)
    const why = expectInvalid(candidate)
    assert.match(why, /协议版本|v=/)
  }
})

test('validateEnvelope：非对象输入矩阵（null / undefined / 字符串 / 数字 / 数组 / 布尔）', () => {
  for (const raw of [null, undefined, 'ready', 42, true, [], [1, 2], () => {}]) {
    const why = expectInvalid(raw)
    assert.match(why, /普通对象|信封/, `原因要指出期望普通对象：${why}`)
  }
  assert.equal(isEnvelope(null), false)
  assert.equal(isEnvelope([]), false)
})

test('validateEnvelope：空对象与「只有 v/t」的缺字段矩阵', () => {
  expectInvalid({})
  for (const t of ENVELOPE_TYPES) {
    const minimal = { v: 1, t }
    if (t === 'initialized') {
      assert.equal(validateEnvelope(minimal).ok, true, 'initialized 只有 v/t')
      continue
    }
    const why = expectInvalid(minimal)
    assert.match(why, /缺少必需字段/)
  }
})

test('validateEnvelope：多余字段被拒（含拼错字段名）', () => {
  const reqWhy = expectInvalid({ v: 1, t: 'req', id: 1, method: 'fs.stat', params: null, extra: 1 })
  assert.match(reqWhy, /不接受字段 "extra"/)

  // 把 hostId 拼成 hostID：严格校验必须当场报错（而不是收出 hostId === undefined）
  const typoWhy = expectInvalid({ v: 1, t: 'ready', hostID: 'h', pid: 1 })
  assert.match(typoWhy, /"hostID"/)

  const initWhy = expectInvalid({
    v: 1,
    t: 'init',
    apiVersion: 3,
    dataDir: '/tmp',
    extensions: [{ ...sampleExtension(), displayName: '宠物' }]
  })
  assert.match(initWhy, /init\.extensions\[0\] 不接受字段 "displayName"/)
})

test('validateEnvelope：id 必须是 ≥1 的整数（0 / 负数 / 小数 / 字符串 / null / NaN）', () => {
  /** 各类型的合法骨架（除 id 外都填对），用于单独暴露 id 校验 */
  const skeleton = (t: string): Record<string, unknown> => {
    switch (t) {
      case 'req':
        return { v: 1, t, method: 'm', params: null }
      case 'res':
        return { v: 1, t, result: null }
      case 'err':
        return { v: 1, t, code: 'EH_INTERNAL', message: 'msg' }
      default:
        return { v: 1, t }
    }
  }
  for (const t of ['req', 'res', 'err', 'cancel']) {
    for (const id of [0, -1, 1.5, '1', null, Number.NaN]) {
      const why = expectInvalid({ ...skeleton(t), id })
      assert.match(why, /id 必须是 ≥1 的整数/, `${t} id=${String(id)}：${why}`)
    }
  }
  assert.equal(validateEnvelope(createRequestEnvelope(FIRST_REQUEST_ID, 'm')).ok, true)
})

test('validateEnvelope：字段类型错误矩阵（ready / terminate / log / event / req / err）', () => {
  assert.match(expectInvalid({ v: 1, t: 'ready', hostId: '', pid: 1 }), /不能为空/)
  assert.match(expectInvalid({ v: 1, t: 'ready', hostId: 'h', pid: 0 }), /pid/)
  assert.match(expectInvalid({ v: 1, t: 'ready', hostId: 'h', pid: '4321' }), /pid/)
  assert.match(expectInvalid({ v: 1, t: 'terminate', graceMs: -1 }), /graceMs/)
  assert.match(expectInvalid({ v: 1, t: 'terminate', graceMs: 1.5 }), /graceMs/)
  assert.match(expectInvalid({ v: 1, t: 'terminate', graceMs: '5000' }), /graceMs/)
  assert.match(expectInvalid({ v: 1, t: 'log', level: 'trace', message: 'x' }), /log\.level/)
  assert.match(expectInvalid({ v: 1, t: 'log', level: 'info', message: 1 }), /log\.message/)
  assert.match(expectInvalid({ v: 1, t: 'event', channel: '', payload: null }), /channel/)
  assert.match(expectInvalid({ v: 1, t: 'req', id: 1, method: '', params: null }), /method/)
  assert.match(expectInvalid({ v: 1, t: 'err', id: 1, code: 'EH_NOPE', message: 'm' }), /err\.code/)
  assert.match(
    expectInvalid({ v: 1, t: 'err', id: 1, code: 'EH_INTERNAL', message: '' }),
    /message/
  )
  assert.match(
    expectInvalid({ v: 1, t: 'err', id: 1, code: 'EH_INTERNAL', message: 'm', detail: 1 }),
    /err\.detail/
  )
})

test('validateEnvelope：激活原因矩阵（4 类合法 / 清单字符串与畸形对象被拒）', () => {
  const valid: ActivationReason[] = [
    '*',
    'onStartupFinished',
    { command: 'pet.toggle' },
    { view: 'pet.panel' }
  ]
  for (const reason of valid) {
    assert.equal(isActivationReason(reason), true, `${JSON.stringify(reason)} 应合法`)
    const parsed = validateActivationReason(reason)
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.deepEqual(parsed.reason, reason)
    assert.equal(validateEnvelope(createActivateEnvelope('pet', reason)).ok, true)
  }

  const invalid: unknown[] = [
    'onCommand:pet.toggle', // 清单字符串不是内部结构
    'onView:pet.panel',
    {},
    { command: '' },
    { command: 'a', view: 'b' },
    { other: 'x' },
    42,
    null,
    []
  ]
  for (const reason of invalid) {
    assert.equal(isActivationReason(reason), false, `${JSON.stringify(reason)} 应被拒`)
    const why = expectInvalid({ v: 1, t: 'activate', extId: 'pet', reason })
    assert.match(why, /activate\.reason/)
  }
})

test('validateEnvelope：init.extensions 形状（非数组 / 缺字段 / 非法激活事件 / 空 id）', () => {
  const base = { v: 1, t: 'init', apiVersion: 3, dataDir: '/tmp', extensions: [] }
  assert.equal(validateEnvelope(base).ok, true, '空扩展列表合法（用户没装扩展）')

  assert.match(expectInvalid({ ...base, extensions: 'pet' }), /init\.extensions 必须是数组/)
  assert.match(
    expectInvalid({ ...base, extensions: [{ ...sampleExtension(), path: '' }] }),
    /init\.extensions\[0\]\.path 不能为空/
  )
  assert.match(
    expectInvalid({ ...base, extensions: [{ ...sampleExtension(), apiVersion: 0 }] }),
    /init\.extensions\[0\]\.apiVersion/
  )
  assert.match(
    expectInvalid({
      ...base,
      extensions: [{ ...sampleExtension(), activationEvents: ['onCommand:pet.toggle'] }]
    }),
    /init\.extensions\[0\]\.activationEvents\[0\]/
  )
  assert.match(
    expectInvalid({
      ...base,
      extensions: [{ ...sampleExtension(), id: '' }]
    }),
    /init\.extensions\[0\]\.id 不能为空/
  )
  assert.match(expectInvalid({ ...base, apiVersion: '3' }), /init\.apiVersion/)
})

/* -------------------------------------------------------------------------------------------- */
/* 序列化守卫                                                                                    */
/* -------------------------------------------------------------------------------------------- */

test('checkSerializable：纯数据通过（含嵌套数组、null、二进制旁路）', () => {
  const value = {
    id: 'pet',
    enabled: true,
    count: 3.14,
    nothing: null,
    tags: ['a', 'b'],
    nested: { deep: { items: [1, 2, { ok: true }] } },
    bytes: new Uint8Array([1, 2, 3]),
    raw: new ArrayBuffer(4)
  }
  assert.deepEqual(checkSerializable(value), { ok: true })
  // 纯数据 + 二进制也应当过得了桥
  assert.equal(
    validateEnvelope(createRequestEnvelope(1, 'fs.write', value)).ok,
    true,
    '信封形状与可传输性互不干扰'
  )
})

test('checkSerializable：嵌套函数给出精确路径 params.items[2].onClick', () => {
  const value = { items: [{ n: 1 }, { n: 2 }, { onClick: () => {} }] }
  const result = checkSerializable(value, 'params')
  assert.deepEqual(result, { ok: false, path: 'params.items[2].onClick', kind: 'function' })
  // 根路径默认 value
  assert.deepEqual(checkSerializable({ cb: () => {} }), {
    ok: false,
    path: 'value.cb',
    kind: 'function'
  })
})

test('checkSerializable：Symbol 值 / Symbol 键被拒（不会被静默丢掉）', () => {
  assert.deepEqual(checkSerializable(Symbol('s')), {
    ok: false,
    path: 'value',
    kind: 'symbol'
  })
  const withSymbolKey = { [Symbol('k')]: 1 }
  assert.deepEqual(checkSerializable(withSymbolKey), {
    ok: false,
    path: 'value',
    kind: 'symbol-key'
  })
  assert.deepEqual(checkSerializable({ a: [1, Symbol('x')] }, 'params'), {
    ok: false,
    path: 'params.a[1]',
    kind: 'symbol'
  })
})

test('checkSerializable：类实例（自定义类 / Date / RegExp / Error / Promise）被拒', () => {
  class Callback {
    handle(): number {
      return 1
    }
  }
  const cases: Array<[unknown, string]> = [
    [new Callback(), 'class-instance'],
    [new Date(), 'date'],
    [/re/g, 'regexp'],
    [new Error('boom'), 'error'],
    [Promise.resolve(1), 'promise']
  ]
  for (const [value, kind] of cases) {
    const result = checkSerializable({ payload: value }, 'params')
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.kind, kind)
    assert.equal(result.path, 'params.payload')
  }
})

test('checkSerializable：Map / Set / WeakMap / WeakSet 被拒', () => {
  const cases: Array<[unknown, string]> = [
    [new Map([['a', 1]]), 'map'],
    [new Set([1]), 'set'],
    [new WeakMap(), 'weakmap'],
    [new WeakSet(), 'weakset']
  ]
  for (const [value, kind] of cases) {
    assert.deepEqual(checkSerializable(value), { ok: false, path: 'value', kind })
  }
})

test('checkSerializable：循环引用被拒并给路径（对象 / 数组自引用）', () => {
  const obj: Record<string, unknown> = { name: 'loop' }
  obj.self = obj
  assert.deepEqual(checkSerializable(obj, 'params'), {
    ok: false,
    path: 'params.self',
    kind: 'circular'
  })

  const list: unknown[] = [1]
  list.push(list)
  assert.deepEqual(checkSerializable(list, 'params'), {
    ok: false,
    path: 'params[1]',
    kind: 'circular'
  })
})

test('checkSerializable：重复引用（非循环的 DAG）允许', () => {
  const shared = { id: 1 }
  assert.deepEqual(checkSerializable({ a: shared, b: shared }), { ok: true })
})

test('checkSerializable：bigint / undefined / NaN / Infinity 被拒', () => {
  assert.deepEqual(checkSerializable(10n), { ok: false, path: 'value', kind: 'bigint' })
  assert.deepEqual(checkSerializable(undefined), { ok: false, path: 'value', kind: 'undefined' })
  assert.deepEqual(checkSerializable({ a: 1, b: undefined }, 'params'), {
    ok: false,
    path: 'params.b',
    kind: 'undefined'
  })
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(checkSerializable(value), {
      ok: false,
      path: 'value',
      kind: 'non-finite-number'
    })
  }
})

test('checkSerializable：非 Uint8Array 的视图（Uint16Array / DataView）被拒', () => {
  assert.deepEqual(checkSerializable(new Uint16Array(2)), {
    ok: false,
    path: 'value',
    kind: 'typed-array'
  })
  assert.deepEqual(checkSerializable({ view: new DataView(new ArrayBuffer(2)) }), {
    ok: false,
    path: 'value.view',
    kind: 'typed-array'
  })
  // Uint8Array 是唯一放行的视图（Node Buffer 是它的子类）
  assert.deepEqual(checkSerializable(new Uint8Array(2)), { ok: true })
})

test('checkSerializable：稀疏数组被拒（JSON 化会把洞变 null，属静默降级）', () => {
  const sparse: unknown[] = new Array<unknown>(2)
  sparse[0] = 1
  const result = checkSerializable(sparse, 'params')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.kind, 'sparse-array')
  assert.equal(result.path, 'params[1]')
})

test('checkSerializable：怪异键名用 ["..."] 记路径（可复制到代码里定位）', () => {
  assert.deepEqual(checkSerializable({ 'a b': { 'x-y': () => {} } }, 'params'), {
    ok: false,
    path: 'params["a b"]["x-y"]',
    kind: 'function'
  })
})

test('二进制旁路：Uint8Array / ArrayBuffer 通过，collectTransferables 给出底层缓冲并去重', () => {
  const buffer = new ArrayBuffer(8)
  const view = new Uint8Array(buffer, 2, 4)
  assert.deepEqual(checkSerializable({ view, buffer }), { ok: true })

  const transferables = collectTransferables({ view, buffer, list: [new Uint8Array([9])] })
  assert.equal(transferables.length, 2, '同一 buffer 只出现一次')
  assert.equal(transferables[0], buffer, 'view 与其底层 buffer 去重为同一个')
  assert.deepEqual([...new Uint8Array(transferables[1])], [9], '第二个是 list 里的缓冲')
  assert.equal(collectTransferables({ a: 1 }).length, 0, '没有二进制就返回空数组')
})

/* -------------------------------------------------------------------------------------------- */
/* 帧大小与上限                                                                                  */
/* -------------------------------------------------------------------------------------------- */

test('estimateSize：字符串按 UTF-8、二进制精确计数、结构随内容增长', () => {
  assert.equal(estimateSize('abc'), 5, '3 字节 + 引号')
  assert.equal(estimateSize('中'), 5, '中 = 3 字节 UTF-8 + 引号')
  assert.equal(estimateSize('😀'), 6, 'emoji = 4 字节 + 引号')
  assert.equal(estimateSize(new Uint8Array(10)), 10, '二进制按 byteLength 精确计，不按 base64 膨胀')
  assert.equal(estimateSize(new ArrayBuffer(10)), 10)
  assert.equal(estimateSize(null), 4)
  assert.equal(estimateSize(1), 8)
  assert.equal(estimateSize(true), 5)
  assert.equal(estimateSize({ a: 1 }), 15, '容器 2 + 键 "a" 与冒号 5 + 数字 8')

  const small = estimateSize({ blob: new Uint8Array(16) })
  const large = estimateSize({ blob: new Uint8Array(4096) })
  assert.ok(large > small, '大二进制必须估得更大')
  assert.equal(large - small, 4096 - 16, '差值正好是字节数差')
})

test('帧上限：刚好超限的 Uint8Array 被拒 EH_FRAME_TOO_LARGE，上限内通过', () => {
  const justOver = new Uint8Array(FRAME_LIMIT_BYTES + 1)
  const over = checkFrameSize(justOver)
  assert.equal(over.ok, false)
  if (over.ok) return
  assert.equal(over.code, 'EH_FRAME_TOO_LARGE')
  assert.equal(over.size, FRAME_LIMIT_BYTES + 1)
  assert.match(over.why, /超过上限/)
  assert.equal(estimateSize(justOver), FRAME_LIMIT_BYTES + 1)

  // 8 MB 的载荷装进信封就已经超限（信封自身还有开销）
  const envelope = createRequestEnvelope(1, 'fs.write', { blob: new Uint8Array(FRAME_LIMIT_BYTES) })
  assert.equal(checkFrameSize(envelope).ok, false)
  assert.throws(
    () => assertFrameSize(envelope),
    (error: unknown) =>
      error instanceof EhProtocolError &&
      error.code === 'EH_FRAME_TOO_LARGE' &&
      error.message.includes(EH_ERROR_TEXT.EH_FRAME_TOO_LARGE)
  )

  // 上限内：留 1 KB 给信封开销
  const inside = createRequestEnvelope(1, 'fs.write', {
    blob: new Uint8Array(FRAME_LIMIT_BYTES - 1024)
  })
  const insideCheck = checkFrameSize(inside)
  assert.equal(insideCheck.ok, true)
  if (!insideCheck.ok) return
  assert.ok(insideCheck.size <= FRAME_LIMIT_BYTES)
  assert.equal(assertFrameSize(inside), insideCheck.size, 'assertFrameSize 返回估算字节数')

  // 自定义上限（便于测试与将来分片）
  assert.equal(estimateSize('abc'), 5)
  assert.equal(checkFrameSize('abc', 5).ok, true)
  assert.equal(checkFrameSize('abc', 4).ok, false)
  assert.equal(checkFrameSize(new Uint8Array(100), 99).ok, false)
})

/* -------------------------------------------------------------------------------------------- */
/* 错误码文案与解析                                                                              */
/* -------------------------------------------------------------------------------------------- */

test('EH_ERROR_TEXT：错误码全覆盖（8 条）、文案非空且为中文可执行说明', () => {
  assert.equal(EH_ERROR_CODES.length, 8)
  assert.equal(new Set(EH_ERROR_CODES).size, 8, '错误码不得重复')
  assert.deepEqual(
    Object.keys(EH_ERROR_TEXT).sort(),
    [...EH_ERROR_CODES].sort(),
    '文案表与错误码表必须一一对应（新增码必须补文案）'
  )
  for (const code of EH_ERROR_CODES) {
    const text = EH_ERROR_TEXT[code]
    assert.equal(typeof text, 'string')
    assert.ok(text.length >= 12, `${code} 的文案要能指导操作：${text}`)
    assert.match(text, /[\u4e00-\u9fff]/, `${code} 必须是中文文案`)
    assert.equal(isEhErrorCode(code), true)
  }
  assert.equal(isEhErrorCode('EH_NOPE'), false)
  assert.equal(isEhErrorCode(42), false)
  // 错误码与 err 信封联动
  for (const code of EH_ERROR_CODES) {
    assert.equal(validateEnvelope(createErrorEnvelope(1, code, 'x')).ok, true)
  }
})

test('EhProtocolError：携带 code 与可选 detail', () => {
  const withDetail = new EhProtocolError('EH_TIMEOUT', '超时', 'id=3 3000ms')
  assert.equal(withDetail.name, 'EhProtocolError')
  assert.equal(withDetail.code, 'EH_TIMEOUT')
  assert.equal(withDetail.detail, 'id=3 3000ms')
  assert.match(withDetail.message, /超时（id=3 3000ms）/)
  assert.ok(withDetail instanceof Error)

  const withoutDetail = new EhProtocolError('EH_INTERNAL', '内部错误')
  assert.equal(withoutDetail.detail, undefined)
  assert.equal(withoutDetail.message, '内部错误')
})

test('parseActivationEvent：4 类清单事件映射，未知/空后缀返回 null', () => {
  assert.equal(parseActivationEvent('*'), '*')
  assert.equal(parseActivationEvent('onStartupFinished'), 'onStartupFinished')
  assert.deepEqual(parseActivationEvent('onCommand:pet.toggle'), { command: 'pet.toggle' })
  assert.deepEqual(parseActivationEvent('onView:pet.panel'), { view: 'pet.panel' })
  for (const event of ['', 'onCommand:', 'onView:', 'onCommandx:a', 'startup', 'onStartup']) {
    assert.equal(parseActivationEvent(event), null, `${event} 应被拒（由清单层报错）`)
  }
})

test('isLogLevel / isEhErrorCode 守卫与信封联动', () => {
  for (const level of ['debug', 'info', 'warn', 'error']) {
    assert.equal(isLogLevel(level), true)
    assert.equal(validateEnvelope(createLogEnvelope(level, 'x')).ok, true)
  }
  for (const level of ['trace', 'silent', '', 1, null]) {
    assert.equal(isLogLevel(level), false)
  }
})
