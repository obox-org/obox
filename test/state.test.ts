/**
 * 状态持久化单测（stateStore）。
 * 覆盖：统一设置存储读写/默认值/undefined 删 key/变更通知与退订、禁用列表、Memento 命名空间隔离。
 *
 * 说明：node 环境下没有 localStorage，state.ts 的 load/save 都包了 try/catch，
 * 因此这里验证的是**内存态行为**（持久化本身依赖浏览器环境）。
 */
import { describe, expect, it } from 'vitest'
import { stateStore } from '../src/renderer/src/core/state'

describe('stateStore · 统一设置存储', () => {
  it('读取默认值 / 写入后读回 / undefined 删除 key', () => {
    expect(stateStore.getSetting<string>('st-test.a', 'def')).toBe('def')
    stateStore.setSetting('st-test.a', 'v1')
    expect(stateStore.getSetting('st-test.a')).toBe('v1')
    stateStore.setSetting('st-test.a', undefined)
    expect(stateStore.getSetting('st-test.a', 'def')).toBe('def')
  })

  it('变更通知可订阅/退订', () => {
    const calls: Array<string | undefined> = []
    const off = stateStore.onSettingsChanged((key) => calls.push(key))
    stateStore.setSetting('st-test.b', 1)
    expect(calls).toHaveLength(1)
    off()
    stateStore.setSetting('st-test.b', 2)
    expect(calls).toHaveLength(1)
    stateStore.setSetting('st-test.b', undefined)
  })

  it('emitSettingsChanged 触发通知（语言切换等无具体 key 的场景）', () => {
    let n = 0
    const off = stateStore.onSettingsChanged(() => {
      n++
    })
    stateStore.emitSettingsChanged()
    expect(n).toBe(1)
    off()
  })
})

describe('stateStore · 扩展禁用列表', () => {
  it('缺省即启用；设置禁用后可查；恢复启用后从列表移除', () => {
    expect(stateStore.isDisabled('st-test.ext')).toBe(false)
    stateStore.setDisabled('st-test.ext', true)
    expect(stateStore.isDisabled('st-test.ext')).toBe(true)
    expect(stateStore.disabledExtensions).toContain('st-test.ext')
    stateStore.setDisabled('st-test.ext', false)
    expect(stateStore.isDisabled('st-test.ext')).toBe(false)
  })
})

describe('stateStore · Memento', () => {
  it('按扩展命名空间读写、keys、undefined 删 key', async () => {
    const m = stateStore.memento('st-test.memento')
    expect(m.get<string>('k', 'def')).toBe('def')
    await m.update('k', 'v')
    expect(m.get('k')).toBe('v')
    expect(m.keys()).toContain('k')
    await m.update('k', undefined)
    expect(m.get('k', 'def')).toBe('def')
  })

  it('不同扩展的命名空间互不影响', async () => {
    const a = stateStore.memento('st-test.m1')
    const b = stateStore.memento('st-test.m2')
    await a.update('only', 1)
    expect(b.get('only')).toBeUndefined()
  })
})
