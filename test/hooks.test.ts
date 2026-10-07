/**
 * 扩展生命周期钩子的解析与执行（electron-free，见 issue #52）。
 * 覆盖：解析（函数/缺失/非函数/非法命名空间）、执行（跳过/成功/失败归因）、上下文透传、失败文案。
 */
import { describe, expect, it } from 'vitest'
import type { ExtensionActivationApi } from '../src/api'
import {
  formatHookFailure,
  normalizeHookError,
  resolveHooks,
  runHook,
  type HookContext,
  type HookName
} from '../src/renderer/src/core/hooks'

const apiStub = {} as ExtensionActivationApi
const ctx: HookContext = { extensionId: 'demo_ext', upgraded: false, api: apiStub }

describe('resolveHooks', () => {
  it('取出函数形式的 install / uninstall', () => {
    const install = (): void => {}
    const uninstall = (): void => {}
    const resolved = resolveHooks({ install, uninstall, activate: () => {} })
    expect(resolved.install).toBe(install)
    expect(resolved.uninstall).toBe(uninstall)
    expect(resolved.ignored).toEqual([])
  })

  it('两个钩子都可选：都没导出时为空且不报错', () => {
    const resolved = resolveHooks({ activate: () => {} })
    expect(resolved.install).toBeUndefined()
    expect(resolved.uninstall).toBeUndefined()
    expect(resolved.ignored).toEqual([])
  })

  it('同名非函数（含 null）视为未提供，并记入 ignored', () => {
    const resolved = resolveHooks({ install: 123, uninstall: null })
    expect(resolved.install).toBeUndefined()
    expect(resolved.uninstall).toBeUndefined()
    expect(resolved.ignored).toEqual(['install', 'uninstall'])
  })

  it('非对象命名空间（含 undefined / 原始值）不抛错', () => {
    for (const value of [undefined, null, 42, 'x']) {
      expect(resolveHooks(value)).toEqual({ ignored: [] })
    }
  })
})

describe('runHook', () => {
  it('钩子未导出 → skipped 且视为成功（可选、可为空）', async () => {
    const outcome = await runHook('install', undefined, ctx)
    expect(outcome).toEqual({ name: 'install', skipped: true, ok: true, durationMs: 0 })
  })

  it('同步钩子成功', async () => {
    const outcome = await runHook('install', () => {}, ctx)
    expect(outcome.skipped).toBe(false)
    expect(outcome.ok).toBe(true)
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('异步钩子成功', async () => {
    const outcome = await runHook(
      'uninstall',
      async () => {
        await Promise.resolve()
      },
      ctx
    )
    expect(outcome.ok).toBe(true)
  })

  it('上下文原样透传给钩子（含 upgraded 与 previousVersion）', async () => {
    const upgradeCtx: HookContext = {
      extensionId: 'demo_ext',
      upgraded: true,
      previousVersion: '1.0.0',
      api: apiStub
    }
    let seen: HookContext | undefined
    await runHook(
      'install',
      (received) => {
        seen = received
      },
      upgradeCtx
    )
    expect(seen).toEqual(upgradeCtx)
  })

  it('钩子抛错不向外抛，而是归因为 ok:false + 归一化原因', async () => {
    const outcome = await runHook(
      'install',
      () => {
        throw new Error('依赖安装失败\n第二行')
      },
      ctx
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('依赖安装失败 第二行')
  })

  it('拒绝（reject）同样被归因', async () => {
    const outcome = await runHook(
      'uninstall',
      async () => {
        throw '环境清理失败'
      },
      ctx
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('环境清理失败')
  })
})

describe('normalizeHookError', () => {
  it('Error 取 message 并压成单行', () => {
    expect(normalizeHookError(new Error('a\n  b'))).toBe('a b')
  })

  it('空 message 回退到 name', () => {
    const error = new Error('')
    error.name = 'HookError'
    expect(normalizeHookError(error)).toBe('HookError')
  })

  it('字符串与对象都可读，空值给“未知错误”', () => {
    expect(normalizeHookError('boom')).toBe('boom')
    expect(normalizeHookError({ code: 'EACCES', path: 'C:\\x' })).toContain('EACCES')
    expect(normalizeHookError(undefined)).toBe('未知错误')
    expect(normalizeHookError(null)).toBe('未知错误')
    expect(normalizeHookError('   ')).toBe('未知错误')
  })

  it('循环引用对象不抛错', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(typeof normalizeHookError(cyclic)).toBe('string')
  })
})

describe('formatHookFailure', () => {
  it('按钩子名给出中文文案', () => {
    const names: HookName[] = ['install', 'uninstall']
    const [install, uninstall] = names.map((name) =>
      formatHookFailure({ name, skipped: false, ok: false, error: 'boom', durationMs: 1 })
    )
    expect(install).toBe('安装钩子执行失败：boom')
    expect(uninstall).toBe('卸载钩子执行失败：boom')
  })
})
