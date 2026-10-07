/**
 * 钩子状态判定与互斥的纯函数测试（issue #52）。
 * 覆盖：安装时机/启动扫描期的判定矩阵、记录与 pending 的迁移、互斥锁与不等待语义。
 */
import { describe, expect, it } from 'vitest'
import {
  clearPendingInstall,
  createHookGate,
  decideInstallHook,
  hookLockKey,
  markPendingInstall,
  recordInstallHook,
  runExclusive,
  type HookState
} from '../src/renderer/src/core/hookState'

describe('decideInstallHook（安装时机）', () => {
  it('首次安装 → 要跑，reason=install', () => {
    expect(
      decideInstallHook({ state: {}, version: '1.0.0', upgraded: false, atInstallTime: true })
    ).toEqual({
      run: true,
      reason: 'install'
    })
  })

  it('覆盖安装（版本变化）→ 要跑，reason=upgrade', () => {
    const state: HookState = { install: { version: '1.0.0', at: 1, ok: true } }
    expect(
      decideInstallHook({ state, version: '1.1.0', upgraded: true, atInstallTime: true })
    ).toEqual({
      run: true,
      reason: 'upgrade'
    })
  })

  it('同一版本再次安装（重装）→ 不跑，reason=already-done（保证每次安装只跑一次）', () => {
    const state: HookState = { install: { version: '1.0.0', at: 1, ok: true } }
    expect(
      decideInstallHook({ state, version: '1.0.0', upgraded: false, atInstallTime: true })
    ).toEqual({
      run: false,
      reason: 'already-done'
    })
  })

  it('上一次执行失败也照样算已跑过（不因失败而无限重跑）', () => {
    const state: HookState = { install: { version: '1.0.0', at: 1, ok: false } }
    expect(
      decideInstallHook({ state, version: '1.0.0', upgraded: false, atInstallTime: true }).run
    ).toBe(false)
  })
})

describe('decideInstallHook（启动扫描期）', () => {
  it('存在同版本 pending → 补跑，reason=pending', () => {
    const state: HookState = { pendingInstall: { version: '1.0.0', at: 5 } }
    expect(
      decideInstallHook({ state, version: '1.0.0', upgraded: false, atInstallTime: false })
    ).toEqual({
      run: true,
      reason: 'pending'
    })
  })

  it('pending 版本与当前不一致（安装后又换过版本）→ 不补跑', () => {
    const state: HookState = { pendingInstall: { version: '0.9.0', at: 5 } }
    expect(
      decideInstallHook({ state, version: '1.0.0', upgraded: false, atInstallTime: false })
    ).toEqual({
      run: false,
      reason: 'nothing-to-do'
    })
  })

  it('无 pending（正常已跑过）→ 启动期不重复执行', () => {
    const state: HookState = { install: { version: '1.0.0', at: 1, ok: true } }
    expect(
      decideInstallHook({ state, version: '1.0.0', upgraded: false, atInstallTime: false })
    ).toEqual({
      run: false,
      reason: 'nothing-to-do'
    })
  })
})

describe('状态迁移', () => {
  it('recordInstallHook 记录版本/时间/结果，并覆盖旧记录', () => {
    const first = recordInstallHook({}, '1.0.0', 10, true)
    expect(first).toEqual({ install: { version: '1.0.0', at: 10, ok: true } })
    const second = recordInstallHook(first, '1.1.0', 20, false)
    expect(second).toEqual({ install: { version: '1.1.0', at: 20, ok: false } })
  })

  it('recordInstallHook 会清除待补跑标记（跑过就不再补跑，无论成败）', () => {
    const pending: HookState = { pendingInstall: { version: '1.1.0', at: 30 } }
    const done = recordInstallHook(pending, '1.1.0', 31, true)
    expect(done.pendingInstall).toBeUndefined()
    expect(done.install).toEqual({ version: '1.1.0', at: 31, ok: true })
    const failed = recordInstallHook(pending, '1.1.0', 32, false)
    expect(failed.pendingInstall).toBeUndefined()
    expect(failed.install?.ok).toBe(false)
  })

  it('markPendingInstall 保留既有记录；clearPendingInstall 只清 pending', () => {
    const state: HookState = { install: { version: '1.0.0', at: 1, ok: true } }
    const pending = markPendingInstall(state, '1.1.0', 30)
    expect(pending.install).toEqual({ version: '1.0.0', at: 1, ok: true })
    expect(pending.pendingInstall).toEqual({ version: '1.1.0', at: 30 })
    const cleared = clearPendingInstall(pending)
    expect(cleared.pendingInstall).toBeUndefined()
    expect(cleared.install).toEqual({ version: '1.0.0', at: 1, ok: true })
  })

  it('无 pending 时 clearPendingInstall 原样返回（不产生新对象）', () => {
    const state: HookState = { install: { version: '1.0.0', at: 1, ok: true } }
    expect(clearPendingInstall(state)).toBe(state)
  })
})

describe('hookLockKey', () => {
  it('按扩展 id 与阶段生成键（不同阶段不互斥）', () => {
    expect(hookLockKey('demo', 'install')).toBe('demo:install')
    expect(hookLockKey('demo', 'uninstall')).toBe('demo:uninstall')
    expect(hookLockKey('demo', 'install')).not.toBe(hookLockKey('demo', 'uninstall'))
  })

  it('空扩展 id 报错（编程错误，应当早暴露）', () => {
    expect(() => hookLockKey('', 'install')).toThrow()
  })
})

describe('createHookGate / runExclusive', () => {
  it('同一键重复占用失败，释放后可再占用', () => {
    const gate = createHookGate()
    expect(gate.tryAcquire('k')).toBe(true)
    expect(gate.tryAcquire('k')).toBe(false)
    expect(gate.isRunning('k')).toBe(true)
    gate.release('k')
    expect(gate.isRunning('k')).toBe(false)
    expect(gate.tryAcquire('k')).toBe(true)
  })

  it('不同键互不影响；释放未占用的键是无害空操作', () => {
    const gate = createHookGate()
    expect(gate.tryAcquire('a')).toBe(true)
    expect(gate.tryAcquire('b')).toBe(true)
    gate.release('never-acquired')
    expect(gate.isRunning('a')).toBe(true)
  })

  it('runExclusive 执行任务并释放锁（含抛错路径）', async () => {
    const gate = createHookGate()
    const ok = await runExclusive(gate, 'k', async () => 42)
    expect(ok).toEqual({ started: true, result: 42 })
    expect(gate.isRunning('k')).toBe(false)

    await expect(
      runExclusive(gate, 'k', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(gate.isRunning('k')).toBe(false)
  })

  it('已占用时 runExclusive 不等待，返回 started:false 且不执行任务', async () => {
    const gate = createHookGate()
    gate.tryAcquire('k')
    let called = false
    const outcome = await runExclusive(gate, 'k', async () => {
      called = true
      return 1
    })
    expect(outcome).toEqual({ started: false })
    expect(called).toBe(false)
    gate.release('k')
  })

  it('并发调用同一键时只有一个真正执行', async () => {
    const gate = createHookGate()
    let executions = 0
    const task = async (): Promise<void> => {
      executions += 1
      await Promise.resolve()
    }
    const results = await Promise.all([
      runExclusive(gate, 'k', task),
      runExclusive(gate, 'k', task),
      runExclusive(gate, 'k', task)
    ])
    expect(results.filter((item) => item.started)).toHaveLength(1)
    expect(executions).toBe(1)
  })
})
