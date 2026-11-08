/**
 * 宿主页面运行时（change `unified-page-context` 任务 3.1/3.3）。
 *
 * 覆盖判据：
 * - 首帧同步写入默认 token + `colorScheme: dark`（不依赖任何消息）；
 * - 收到 `obox:context` 后：token 覆盖、旧键清理、`colorScheme`、`onChange`、`t()`；
 * - 同值去重：重复上下文不重复写 DOM、不重复回调；
 * - 缺 key：`t()` 回退 key 本身，每个 key 只 warn 一次；
 * - 老宿主（一直无上下文）：0/300/1000ms 各请求一次，最后 warn 一次并保留默认值；
 * - 迟到上下文：请求发出后到达，后续重试不再发请求；
 * - 旧协议（`obox-theme`）消息被静默忽略；高于运行时版本的上下文被忽略并 warn；
 * - `destroy()`：监听与定时器都被清理。
 *
 * 以及**协议契约测试**：`src/shared/pageContext.ts` 的 `buildPageContext` 产物必须被运行时接受。
 */
import { describe, expect, it } from 'vitest'
import { startPageContext } from '../src/page-runtime/page.js'
import { buildPageContext, PAGE_CONTEXT_VERSION } from '../src/shared/pageContext'

interface Harness {
  win: {
    addEventListener: (type: string, fn: (e: unknown) => void) => void
    removeEventListener: (type: string, fn: (e: unknown) => void) => void
    parent: { postMessage: (message: unknown) => void }
    listeners: Map<string, Array<(e: unknown) => void>>
  }
  doc: { documentElement: { style: Record<string, unknown> } }
  style: Map<string, string>
  setCalls: string[]
  requests: unknown[]
  changes: unknown[]
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
  warns: string[]
  dispatch: (data: unknown) => void
}

function harness(): Harness {
  const style = new Map<string, string>()
  const setCalls: string[] = []
  const requests: unknown[] = []
  const changes: unknown[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const warns: string[] = []
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  const doc = {
    documentElement: {
      style: {
        setProperty: (name: string, value: string): void => {
          setCalls.push(name)
          style.set(name, value)
        },
        removeProperty: (name: string): void => {
          style.delete(name)
        },
        colorScheme: ''
      }
    }
  }
  const win = {
    addEventListener: (type: string, fn: (e: unknown) => void): void => {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener: (type: string, fn: (e: unknown) => void): void => {
      const list = listeners.get(type) ?? []
      listeners.set(
        type,
        list.filter((item) => item !== fn)
      )
    },
    parent: { postMessage: (message: unknown): void => void requests.push(message) },
    listeners
  }
  const dispatch = (data: unknown): void => {
    for (const fn of listeners.get('message') ?? []) fn({ data, source: win.parent })
  }
  return {
    win,
    doc,
    style,
    setCalls,
    requests,
    changes,
    timers,
    warns,
    dispatch
  }
}

interface RuntimeHandle {
  destroy(): void
  t(key: string, params?: Record<string, unknown>): string
  getContext(): null | { themeId: string; locale: string; colorScheme?: string }
}

function start(h: Harness, overrides: Record<string, unknown> = {}): RuntimeHandle {
  const runtime = startPageContext({
    window: h.win,
    document: h.doc,
    onChange: (ctx: unknown) => void h.changes.push(ctx),
    warn: (message: string) => void h.warns.push(message),
    setTimeout: (fn: () => void, ms: number): number => {
      h.timers.push({ fn, ms, cleared: false })
      return h.timers.length - 1
    },
    clearTimeout: (id: number): void => {
      const timer = h.timers[id]
      if (timer) timer.cleared = true
    },
    requestDelaysMs: [0, 300, 1000],
    ...overrides
  })
  return runtime
}

const context = (overrides: Record<string, unknown> = {}): unknown => ({
  type: 'obox:context',
  version: PAGE_CONTEXT_VERSION,
  themeId: 'theme-light.light',
  colorScheme: 'light',
  tokens: { '--bg': '#ffffff', '--fg': '#111111' },
  locale: 'en',
  messages: { hello: 'Hello {name}' },
  ...overrides
})

describe('page-runtime · 首帧兜底与上下文应用', () => {
  it('启动即同步写入默认 token 与 dark colorScheme', () => {
    const h = harness()
    start(h)
    expect(h.style.get('--bg')).toBe('#1e1e1e')
    expect(h.style.get('--statusbar-bg')).toBe('#2a2a2a')
    expect(h.doc.documentElement.style.colorScheme).toBe('dark')
    expect(h.changes).toEqual([])
  })

  it('收到上下文：覆盖 token、清掉旧键、设 colorScheme、回调、t() 生效', () => {
    const h = harness()
    const runtime = start(h)
    h.dispatch(context())
    expect(h.style.get('--bg')).toBe('#ffffff')
    expect(h.style.get('--fg')).toBe('#111111')
    // 默认里有、上下文里没有的键被清掉（否则会残留上一份主题）
    expect(h.style.has('--statusbar-bg')).toBe(false)
    expect(h.doc.documentElement.style.colorScheme).toBe('light')
    expect(h.changes).toHaveLength(1)
    expect(runtime.getContext()).toMatchObject({ themeId: 'theme-light.light', locale: 'en' })
    expect(runtime.t('hello', { name: 'Obox' })).toBe('Hello Obox')
  })

  it('同值去重：重复上下文不再写 DOM、不再回调', () => {
    const h = harness()
    const runtime = start(h)
    h.dispatch(context())
    const setCount = h.setCalls.length
    h.dispatch(context())
    expect(h.setCalls.length).toBe(setCount)
    expect(h.changes).toHaveLength(1)
    expect(runtime.getContext()?.themeId).toBe('theme-light.light')
  })

  it('缺 key：返回 key 本身，每个 key 只 warn 一次', () => {
    const h = harness()
    const runtime = start(h)
    h.dispatch(context())
    expect(runtime.t('nope')).toBe('nope')
    expect(runtime.t('nope')).toBe('nope')
    expect(h.warns.filter((w) => w.includes('nope'))).toHaveLength(1)
  })

  it('旧协议消息与非法载荷被忽略（不抛错、不改状态）', () => {
    const h = harness()
    const runtime = start(h)
    h.dispatch({ type: 'obox-theme', tokens: { '--bg': '#000000' } })
    h.dispatch({ type: 'obox:context', version: 1, tokens: {} })
    expect(h.style.get('--bg')).toBe('#1e1e1e')
    expect(runtime.getContext()).toBeNull()
  })

  it('高于运行时版本的上下文被忽略并 warn 一次', () => {
    const h = harness()
    const runtime = start(h)
    h.dispatch(context({ version: PAGE_CONTEXT_VERSION + 1 }))
    h.dispatch(context({ version: PAGE_CONTEXT_VERSION + 1 }))
    expect(runtime.getContext()).toBeNull()
    expect(h.warns.filter((w) => w.includes('版本'))).toHaveLength(1)
  })

  it('非父窗口来源的消息被忽略', () => {
    const h = harness()
    const runtime = start(h)
    for (const fn of h.win.listeners.get('message') ?? []) {
      fn({ data: context(), source: { evil: true } })
    }
    expect(runtime.getContext()).toBeNull()
  })
})

describe('page-runtime · 请求重试与老宿主降级', () => {
  it('老宿主（一直无上下文）：按 0/300/1000 请求三次，最后 warn 一次，保留默认值', () => {
    const h = harness()
    start(h)
    expect(h.timers.map((t) => t.ms)).toEqual([0, 300, 1000])
    for (const timer of h.timers) timer.fn()
    expect(h.requests).toEqual([
      { type: 'obox:context-request' },
      { type: 'obox:context-request' },
      { type: 'obox:context-request' }
    ])
    expect(h.warns.filter((w) => w.includes('未收到宿主上下文'))).toHaveLength(1)
    expect(h.style.get('--bg')).toBe('#1e1e1e')
  })

  it('迟到上下文：到达后剩余重试不再发请求', () => {
    const h = harness()
    start(h)
    h.timers[0].fn()
    expect(h.requests).toHaveLength(1)
    h.dispatch(context())
    h.timers[1].fn()
    h.timers[2].fn()
    expect(h.requests).toHaveLength(1)
    expect(h.warns.filter((w) => w.includes('未收到宿主上下文'))).toHaveLength(0)
  })

  it('destroy() 清掉监听与定时器', () => {
    const h = harness()
    const runtime = start(h)
    runtime.destroy()
    expect(h.win.listeners.get('message')).toHaveLength(0)
    expect(h.timers.every((t) => t.cleared)).toBe(true)
    h.timers[0].fn()
    expect(h.requests).toHaveLength(0)
  })
})

describe('page-runtime · 与共享协议的契约', () => {
  it('shared buildPageContext 的产物被运行时接受', () => {
    const h = harness()
    const runtime = start(h)
    h.dispatch(
      buildPageContext({
        themeId: 'theme-dark.dark',
        colorScheme: 'dark',
        tokens: { '--bg': '#000000' },
        locale: 'zh',
        messages: { a: '甲' }
      })
    )
    expect(runtime.getContext()).toMatchObject({ themeId: 'theme-dark.dark', locale: 'zh' })
    expect(runtime.t('a')).toBe('甲')
  })
})
