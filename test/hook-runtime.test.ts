/**
 * 渲染进程侧钩子执行的测试（issue #52）：skipped / 执行成功 / 失败归因 / 未加载不误记 / 同阶段互斥。
 */
import { describe, expect, it } from 'vitest'
import type { ExtensionHookRunRequest } from '../src/shared/types'
import {
  deferredHookResult,
  executeExtensionHook,
  hookFailureForActivation
} from '../src/renderer/src/core/hookRuntime'

const request = (over: Partial<ExtensionHookRunRequest> = {}): ExtensionHookRunRequest => ({
  requestId: 'r1',
  extId: 'demo_ext',
  phase: 'install',
  version: '1.0.0',
  upgraded: false,
  ...over
})

const loadOf = (module: unknown) => async (): Promise<unknown> => module

describe('executeExtensionHook', () => {
  it('入口未导出钩子 → ok + skipped（可选、可为空，属正常）', async () => {
    const result = await executeExtensionHook(request(), { load: loadOf({ default: () => {} }) })
    expect(result).toEqual({ requestId: 'r1', ok: true, skipped: true })
  })

  it('导出 install → 执行并把上下文原样传入', async () => {
    const seen: unknown[] = []
    const result = await executeExtensionHook(
      request({ upgraded: true, previousVersion: '0.9.0' }),
      {
        load: loadOf({
          install: (ctx: unknown) => {
            seen.push(ctx)
          }
        })
      }
    )
    expect(result).toEqual({ requestId: 'r1', ok: true, skipped: false })
    expect(seen[0]).toEqual({ extensionId: 'demo_ext', upgraded: true, previousVersion: '0.9.0' })
  })

  it('只跑对应阶段的钩子（install 请求不触发 uninstall）', async () => {
    let uninstallCalls = 0
    await executeExtensionHook(request({ phase: 'install' }), {
      load: loadOf({
        install: () => {},
        uninstall: () => {
          uninstallCalls += 1
        }
      })
    })
    expect(uninstallCalls).toBe(0)
  })

  it('钩子抛错 → ok:false 且原因为中文失败文案（可并入 activationError）', async () => {
    const result = await executeExtensionHook(request(), {
      load: loadOf({
        install: () => {
          throw new Error('依赖准备失败')
        }
      })
    })
    expect(result.ok).toBe(false)
    expect(result.deferred).toBeUndefined()
    expect(result.error).toBe('安装钩子执行失败：依赖准备失败')
  })

  it('入口加载失败 → deferred:true（不能记成"已跑过"）', async () => {
    const result = await executeExtensionHook(request(), {
      load: async () => {
        throw new Error('入口加载失败')
      }
    })
    expect(result).toMatchObject({
      requestId: 'r1',
      ok: false,
      deferred: true,
      error: '入口加载失败'
    })
  })

  it('同扩展同阶段不并发：后一个记 deferred，不排队', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = loadOf({
      install: async () => {
        await blocked
      }
    })
    const first = executeExtensionHook(request({ requestId: 'a' }), { load })
    const second = await executeExtensionHook(request({ requestId: 'b' }), { load })
    expect(second).toMatchObject({ requestId: 'b', ok: false, deferred: true })
    release?.()
    await expect(first).resolves.toEqual({ requestId: 'a', ok: true, skipped: false })
  })

  it('不同阶段互不阻塞（锁键含阶段）', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = loadOf({
      install: async () => {
        await blocked
      },
      uninstall: () => {}
    })
    const install = executeExtensionHook(request({ requestId: 'i', phase: 'install' }), { load })
    const uninstall = await executeExtensionHook(request({ requestId: 'u', phase: 'uninstall' }), {
      load
    })
    expect(uninstall).toEqual({ requestId: 'u', ok: true, skipped: false })
    release?.()
    await install
  })
})

describe('deferredHookResult / hookFailureForActivation', () => {
  it('deferred 结果带可读原因', () => {
    expect(deferredHookResult('r9')).toEqual({
      requestId: 'r9',
      ok: false,
      deferred: true,
      error: '扩展尚未加载到宿主，留待下次启动补跑'
    })
  })

  it('只有"执行过且失败"才产生激活失败文案', () => {
    expect(hookFailureForActivation({ requestId: 'r', ok: true, skipped: true })).toBeUndefined()
    expect(
      hookFailureForActivation({ requestId: 'r', ok: false, deferred: true, error: 'x' })
    ).toBeUndefined()
    expect(
      hookFailureForActivation({ requestId: 'r', ok: false, error: '安装钩子执行失败：x' })
    ).toBe('安装钩子执行失败：x')
    expect(hookFailureForActivation({ requestId: 'r', ok: false })).toBe('生命周期钩子执行失败')
  })
})
