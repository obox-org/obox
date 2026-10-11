/**
 * `themeStore.apply()` 的旧 token 清理单测（issue #81）。
 *
 * 背景：`apply()` 此前只 `setProperty`、从不 `removeProperty`，从"全量主题"切到"部分 token 主题"时
 * 未声明的键会保留**上一个主题**的行内值，回不到 `assets/main.css` 的默认值。
 *
 * 为什么用假 document 而不是 jsdom：仓库 vitest 是 `environment: 'node'`、没有 jsdom / happy-dom
 * （见 `test/app-window-wiring.test.ts` 的说明）。`apply()` 只在调用时读 `document.documentElement`，
 * 因此这里注入一个只实现 `style.setProperty` / `style.removeProperty` 的最小假根节点，
 * 就能把"真实写入了什么、真实清掉了什么"钉住——比读源文件断言更强，且不引入依赖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredTheme } from '../src/renderer/src/core/theme'

interface FakeDom {
  /** 当前 `:root` 上的行内 token（被 removeProperty 掉的会从这里消失） */
  inline: Map<string, string>
  /** removeProperty 的调用序列 */
  removals: string[]
}

let dom: FakeDom

function installFakeDocument(): FakeDom {
  const inline = new Map<string, string>()
  const removals: string[] = []
  const style = {
    setProperty: (name: string, value: string): void => {
      inline.set(name, value)
    },
    removeProperty: (name: string): void => {
      removals.push(name)
      inline.delete(name)
    }
  }
  ;(globalThis as unknown as Record<string, unknown>).document = { documentElement: { style } }
  return { inline, removals }
}

function theme(id: string, tokens: Record<string, string>): RegisteredTheme {
  return { id, label: id, tokens, extensionId: 'theme-test' }
}

/**
 * 每个用例一个**新实例**：appliedTokenKeys 是实例级状态，用例间必须隔离。
 *
 * 时序要点：先 `import`（此刻还没有 `document`，Vue 的 `runtime-dom` 才走 `doc = null` 分支、
 * 不会在导入期调 `doc.createElement`），**再**安装假 document —— `apply()` 是调用时才读
 * `document.documentElement`，所以这样来得及。
 */
async function freshStore(): Promise<
  (typeof import('../src/renderer/src/core/theme'))['themeStore']
> {
  vi.resetModules()
  delete (globalThis as unknown as Record<string, unknown>).document
  const mod = await import('../src/renderer/src/core/theme')
  dom = installFakeDocument()
  return mod.themeStore
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).document
})

describe('themeStore.apply · 旧 token 清理（issue #81）', () => {
  it('首启（没有上一主题）：只写不删，不报错', async () => {
    const store = await freshStore()
    expect(() => store.apply(theme('t-full', { '--bg': '#111', '--fg': '#eee' }))).not.toThrow()
    expect(dom.inline).toEqual(
      new Map([
        ['--bg', '#111'],
        ['--fg', '#eee']
      ])
    )
    expect(dom.removals).toEqual([])
  })

  it('切换主题：上一主题写过、新主题不再声明的键被清除（回落 main.css 默认值）', async () => {
    const store = await freshStore()
    store.apply(theme('t-full', { '--bg': '#111', '--fg': '#eee', '--accent': '#0af' }))
    dom.removals.length = 0
    store.apply(theme('t-min', { '--bg': '#222' }))
    expect(dom.removals.sort()).toEqual(['--accent', '--fg'])
    expect(dom.inline).toEqual(new Map([['--bg', '#222']]))
  })

  it('同一主题重复 apply：不误删，值按最后一次声明覆盖', async () => {
    const store = await freshStore()
    store.apply(theme('t-a', { '--bg': '#111', '--fg': '#eee' }))
    dom.removals.length = 0
    store.apply(theme('t-a', { '--bg': '#333', '--fg': '#eee' }))
    expect(dom.removals).toEqual([])
    expect(dom.inline).toEqual(
      new Map([
        ['--bg', '#333'],
        ['--fg', '#eee']
      ])
    )
  })

  it('来回切换：最终只剩当前主题声明的键，不留任何历史残留', async () => {
    const store = await freshStore()
    const a = theme('t-a', { '--bg': '#111', '--fg': '#eee' })
    const b = theme('t-b', { '--fg': '#000' })
    store.apply(a)
    store.apply(b)
    expect(dom.inline).toEqual(new Map([['--fg', '#000']]))
    store.apply(a)
    expect(dom.inline).toEqual(
      new Map([
        ['--bg', '#111'],
        ['--fg', '#eee']
      ])
    )
  })

  it('新主题声明更多键：只写不删（集合只增不减时不触发 removeProperty）', async () => {
    const store = await freshStore()
    store.apply(theme('t-min', { '--bg': '#222' }))
    dom.removals.length = 0
    store.apply(theme('t-full', { '--bg': '#111', '--fg': '#eee' }))
    expect(dom.removals).toEqual([])
    expect(dom.inline.size).toBe(2)
  })

  it('setTheme 走同一条清理路径（设置页选主题的真实入口）', async () => {
    const store = await freshStore()
    store.register('theme-test', theme('t-a', { '--bg': '#111', '--fg': '#eee' }))
    store.register('theme-test', theme('t-b', { '--bg': '#222' }))
    store.setTheme('t-a')
    expect(store.currentId).toBe('t-a')
    dom.removals.length = 0
    store.setTheme('t-b')
    expect(store.currentId).toBe('t-b')
    expect(dom.removals).toEqual(['--fg'])
    expect(dom.inline).toEqual(new Map([['--bg', '#222']]))
  })
})
