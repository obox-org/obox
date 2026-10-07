/**
 * 钩子桥的纯逻辑测试（issue #52）：送达/超时/不可用三态、结果回传、并发隔离、定时器注入。
 * 不涉及 electron：send 由测试提供，定时器可注入。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  createHookBridge,
  type HookRunRequest
} from '../src/main/hookBridge'

const baseInput = {
  extId: 'demo_ext',
  phase: 'install' as const,
  version: '1.0.0',
  upgraded: false
}

describe('createHookBridge · 正常送达', () => {
  it('请求带 requestId 送出；渲染进程回传后以求值结果返回', async () => {
    const sent: HookRunRequest[] = []
    const bridge = createHookBridge({ send: (request) => sent.push(request) })
    const promise = bridge.run(baseInput)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ ...baseInput, requestId: expect.any(String) })
    expect(bridge.pendingCount()).toBe(1)
    expect(bridge.settle({ requestId: sent[0].requestId, ok: true })).toBe(true)
    await expect(promise).resolves.toEqual({
      delivered: true,
      ok: true,
      skipped: undefined,
      error: undefined
    })
    expect(bridge.pendingCount()).toBe(0)
  })

  it('skipped 与 error 原样透传（未导出钩子 = 正常跳过）', async () => {
    const sent: HookRunRequest[] = []
    const bridge = createHookBridge({ send: (request) => sent.push(request) })
    const promise = bridge.run(baseInput)
    bridge.settle({ requestId: sent[0].requestId, ok: true, skipped: true })
    await expect(promise).resolves.toEqual({
      delivered: true,
      ok: true,
      skipped: true,
      error: undefined
    })

    const failing = createHookBridge({ send: (request) => sent.push(request) })
    const failed = failing.run(baseInput)
    failing.settle({ requestId: sent[1].requestId, ok: false, error: '依赖安装失败' })
    await expect(failed).resolves.toEqual({
      delivered: true,
      ok: false,
      skipped: undefined,
      error: '依赖安装失败'
    })
  })

  it('上行参数原样传递（升级标记与旧版本）', async () => {
    const sent: HookRunRequest[] = []
    const bridge = createHookBridge({ send: (request) => sent.push(request) })
    void bridge.run({
      extId: 'demo_ext',
      phase: 'install',
      version: '2.0.0',
      upgraded: true,
      previousVersion: '1.0.0'
    })
    expect(sent[0]).toMatchObject({ upgraded: true, previousVersion: '1.0.0', version: '2.0.0' })
  })
})

describe('createHookBridge · 超时与重复回传', () => {
  it('超时 → delivered:true / ok:false，错误文案含超时与毫秒数', async () => {
    const bridge = createHookBridge({ send: () => {}, timeoutMs: 15 })
    await expect(bridge.run(baseInput)).resolves.toEqual({
      delivered: true,
      ok: false,
      skipped: undefined,
      error: '钩子执行超时（15ms）'
    })
    expect(bridge.pendingCount()).toBe(0)
  })

  it('超时后才回传 → settle 返回 false（晚到的结果不会二次结算）', async () => {
    const sent: HookRunRequest[] = []
    const bridge = createHookBridge({ send: (request) => sent.push(request), timeoutMs: 10 })
    await bridge.run(baseInput)
    expect(bridge.settle({ requestId: sent[0].requestId, ok: true })).toBe(false)
  })

  it('未知 requestId 与重复回传都返回 false，不抛错', async () => {
    const sent: HookRunRequest[] = []
    const bridge = createHookBridge({ send: (request) => sent.push(request) })
    expect(bridge.settle({ requestId: 'nope', ok: true })).toBe(false)
    const promise = bridge.run(baseInput)
    expect(bridge.settle({ requestId: sent[0].requestId, ok: true })).toBe(true)
    expect(bridge.settle({ requestId: sent[0].requestId, ok: true })).toBe(false)
    await promise
  })

  it('缺省超时为 10 秒', () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(10_000)
  })

  it('定时器可注入：按 timeoutMs 注册，结算后清理', async () => {
    const setTimer = vi.fn(() => 'timer-handle')
    const clearTimer = vi.fn()
    const sent: HookRunRequest[] = []
    const bridge = createHookBridge({
      send: (request) => sent.push(request),
      timeoutMs: 4321,
      setTimer,
      clearTimer
    })
    const promise = bridge.run(baseInput)
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 4321)
    bridge.settle({ requestId: sent[0].requestId, ok: true })
    await promise
    expect(clearTimer).toHaveBeenCalledWith('timer-handle')
  })
})

describe('createHookBridge · 渲染进程不可用', () => {
  it('send 抛错 → delivered:false / renderer-unavailable（不等于钩子失败）', async () => {
    const bridge = createHookBridge({
      send: () => {
        throw new Error('窗口已销毁')
      }
    })
    await expect(bridge.run(baseInput)).resolves.toEqual({
      delivered: false,
      reason: 'renderer-unavailable',
      error: '窗口已销毁'
    })
    expect(bridge.pendingCount()).toBe(0)
  })

  it('send 抛非 Error 值也能得到可读原因', async () => {
    const bridge = createHookBridge({
      send: () => {
        throw 'no-window'
      }
    })
    const outcome = await bridge.run(baseInput)
    expect(outcome.delivered).toBe(false)
    expect(outcome.delivered === false && outcome.error).toBe('no-window')
  })
})

describe('createHookBridge · 并发隔离', () => {
  it('多个在途请求各自结算，互不影响', async () => {
    const sent: HookRunRequest[] = []
    const bridge = createHookBridge({ send: (request) => sent.push(request) })
    const first = bridge.run({ ...baseInput, extId: 'a' })
    const second = bridge.run({ ...baseInput, extId: 'b', phase: 'uninstall' })
    expect(bridge.pendingCount()).toBe(2)
    expect(sent[0].requestId).not.toBe(sent[1].requestId)
    bridge.settle({ requestId: sent[1].requestId, ok: false, error: '清理失败' })
    bridge.settle({ requestId: sent[0].requestId, ok: true })
    await expect(second).resolves.toMatchObject({ delivered: true, ok: false, error: '清理失败' })
    await expect(first).resolves.toMatchObject({ delivered: true, ok: true })
    expect(bridge.pendingCount()).toBe(0)
  })

  it('requestId 生成器可注入（便于日志/调试对齐）', async () => {
    let n = 0
    const sent: HookRunRequest[] = []
    const bridge = createHookBridge({
      send: (request) => sent.push(request),
      newRequestId: () => `fixed-${++n}`
    })
    void bridge.run(baseInput)
    void bridge.run(baseInput)
    expect(sent.map((item) => item.requestId)).toEqual(['fixed-1', 'fixed-2'])
  })
})
