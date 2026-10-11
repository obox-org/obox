/**
 * 状态持久化单测（stateStore）。
 * 覆盖：统一设置存储读写/默认值/undefined 删 key/变更通知与退订、禁用列表、Memento 命名空间隔离，
 * 以及**跨窗口快照合并**（`parsePersistedState` / `applyExternal` / `diffSettingsKeys` 与
 * 浏览器侧 `storage` 监听，见 ADR-0022 / 设计 §2.7.4）。
 *
 * 说明：node 环境下没有 localStorage，state.ts 的 load/save 都包了 try/catch，
 * 因此这里验证的是**内存态行为**（持久化本身依赖浏览器环境）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STORAGE_KEY,
  diffSettingsKeys,
  parsePersistedState,
  stateStore
} from '../src/renderer/src/core/state'

/** 造一份完整持久化快照的 JSON 字符串（applyExternal 的入参形状） */
function snapshot(settings: Record<string, unknown>): string {
  return JSON.stringify({
    disabledExtensions: [],
    notificationDisabledExtensions: [],
    memento: {},
    settings
  })
}

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

describe('stateStore · 跨窗口 storage 合并', () => {
  /**
   * 每个用例前把 settings 清成一份确定的基线；用例后恢复本文件其它用例可能留下的键，
   * 避免 applyExternal 的"整份替换"把同文件其它 describe 的键抹掉。
   */
  let before: string
  beforeEach(() => {
    before = JSON.stringify({
      disabledExtensions: stateStore.disabledExtensions,
      notificationDisabledExtensions: [],
      memento: {},
      settings: {}
    })
    stateStore.applyExternal(before)
  })
  afterEach(() => {
    stateStore.applyExternal(before)
    stateStore.setSetting('st-test.a', undefined)
    stateStore.setSetting('st-test.b', undefined)
  })

  it('parsePersistedState：null / 畸形 JSON / 非对象 → 全空结构（纯函数）', () => {
    const empty = {
      disabledExtensions: [],
      notificationDisabledExtensions: [],
      memento: {},
      settings: {}
    }
    for (const raw of [null, '', '{', 'null', '[]', '"x"', 'undefined']) {
      expect(parsePersistedState(raw as string | null)).toEqual(empty)
    }
  })

  it('parsePersistedState：结构不符的字段各自回落为空值', () => {
    const raw = JSON.stringify({
      disabledExtensions: 'nope',
      notificationDisabledExtensions: ['a'],
      memento: null,
      settings: { theme: 'theme-dark' }
    })
    expect(parsePersistedState(raw)).toEqual({
      disabledExtensions: [],
      notificationDisabledExtensions: ['a'],
      memento: {},
      settings: { theme: 'theme-dark' }
    })
  })

  it('diffSettingsKeys：新增 / 删除 / 改值都算变化，顺序稳定且不重复', () => {
    expect(diffSettingsKeys({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([])
    expect(diffSettingsKeys({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(['b'])
    expect(diffSettingsKeys({ a: 1 }, { a: 1, c: 3 })).toEqual(['c'])
    expect(diffSettingsKeys({ a: 1, b: 2 }, { b: 2 })).toEqual(['a'])
    // 对象值按深比较（快捷键映射这类嵌套值）
    expect(diffSettingsKeys({ k: { x: 1 } }, { k: { x: 1 } })).toEqual([])
    expect(diffSettingsKeys({ k: { x: 1 } }, { k: { x: 2 } })).toEqual(['k'])
  })

  it('applyExternal：合并另一窗口快照并按变更 key 通知', () => {
    stateStore.setSetting('theme', 'theme-dark')
    const keys: Array<string | undefined> = []
    const off = stateStore.onSettingsChanged((key) => keys.push(key))
    const changed = stateStore.applyExternal(snapshot({ theme: 'theme-light' }))
    expect(changed).toEqual(['theme'])
    expect(stateStore.getSetting('theme')).toBe('theme-light')
    expect(keys).toEqual(['theme'])
    off()
  })

  it('applyExternal：内容无变化时不通知', () => {
    stateStore.setSetting('theme', 'theme-dark')
    let calls = 0
    const off = stateStore.onSettingsChanged(() => {
      calls++
    })
    const changed = stateStore.applyExternal(snapshot({ theme: 'theme-dark' }))
    expect(changed).toEqual([])
    expect(calls).toBe(0)
    off()
  })

  it('applyExternal：只改非主题键时只通知该键', () => {
    stateStore.setSetting('theme', 'theme-dark')
    const keys: Array<string | undefined> = []
    const off = stateStore.onSettingsChanged((key) => keys.push(key))
    const changed = stateStore.applyExternal(
      snapshot({ theme: 'theme-dark', 'keybinding.x': 'Ctrl+X' })
    )
    expect(changed).toEqual(['keybinding.x'])
    expect(keys).toEqual(['keybinding.x'])
    expect(keys).not.toContain('theme')
    off()
  })

  it('applyExternal：畸形快照不抛错（全空替换，语义见函数注释）', () => {
    stateStore.setSetting('theme', 'theme-dark')
    for (const raw of ['{', 'null', '[]']) {
      expect(() => stateStore.applyExternal(raw)).not.toThrow()
    }
  })

  it('浏览器侧安装 storage 监听：仅本 key 的字符串快照触发合并', async () => {
    type Listener = (e: { key: string | null; newValue: string | null }) => void
    const listeners: Listener[] = []
    const fakeWindow = {
      addEventListener: (type: string, fn: Listener): void => {
        if (type === 'storage') listeners.push(fn)
      },
      removeEventListener: (): void => {}
    }
    vi.resetModules()
    vi.stubGlobal('window', fakeWindow)
    try {
      const fresh = (await import('../src/renderer/src/core/state')).stateStore
      expect(listeners).toHaveLength(1)
      const fire = (e: { key: string | null; newValue: string | null }): void => {
        listeners.forEach((l) => l(e))
      }
      // 非本 key / 非字符串 newValue（删除）一律忽略
      fresh.setSetting('theme', 'theme-dark')
      fire({ key: 'other:key', newValue: snapshot({ theme: 'theme-light' }) })
      fire({ key: STORAGE_KEY, newValue: null })
      expect(fresh.getSetting('theme')).toBe('theme-dark')
      // 本 key + 字符串快照 → 合并进来
      fire({ key: STORAGE_KEY, newValue: snapshot({ theme: 'theme-light' }) })
      expect(fresh.getSetting('theme')).toBe('theme-light')
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
