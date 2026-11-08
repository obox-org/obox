/**
 * 组件库样式表的运行时注入（change `component-css-library` 任务 8.2）。
 *
 * 覆盖判据：
 * - 默认注入**恰好一个** `<link rel="stylesheet" href="app://obox/ui.css" data-obox-ui>`；
 * - 重复 `startPageContext` 不重复注入（幂等）；
 * - `disableUiCss: true` 不注入；
 * - 页面自己已经写过该 `<link>`（带 `data-obox-ui`）时不再追加；
 * - 注入发生在首帧（不依赖 `obox:context` 何时到达）。
 */
import { describe, expect, it } from 'vitest'
import { startPageContext } from '../src/page-runtime/page.js'

interface FakeLink {
  rel: string
  href: string
  attrs: Map<string, string>
  setAttribute(name: string, value: string): void
}

function harness(): {
  dom: Record<string, unknown>
  links: FakeLink[]
  start: (options?: Record<string, unknown>) => { destroy(): void }
} {
  const links: FakeLink[] = []
  const head = {
    appendChild(node: FakeLink): void {
      links.push(node)
    }
  }
  const doc = {
    head,
    documentElement: {
      style: { setProperty: () => {}, removeProperty: () => {}, colorScheme: '' }
    },
    createElement: (): FakeLink => {
      const attrs = new Map<string, string>()
      const link: FakeLink = {
        rel: '',
        href: '',
        attrs,
        setAttribute: (name: string, value: string): void => void attrs.set(name, value)
      }
      return link
    },
    querySelector: (selector: string): FakeLink | null => {
      if (selector !== 'link[data-obox-ui]') return null
      return links.find((link) => link.attrs.has('data-obox-ui')) ?? null
    }
  }
  const win = {
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    parent: { postMessage: (): void => {} }
  }
  return {
    dom: { window: win, document: doc },
    links,
    start: (options = {}) =>
      startPageContext({
        ...(options as object),
        window: win,
        document: doc,
        // 不真的排定时器
        setTimeout: () => 0,
        clearTimeout: () => {}
      }) as { destroy(): void }
  }
}

describe('组件库样式表注入', () => {
  it('默认注入一个 link（rel/href/data 标记都对）', () => {
    const h = harness()
    h.start()
    expect(h.links).toHaveLength(1)
    expect(h.links[0].rel).toBe('stylesheet')
    expect(h.links[0].href).toBe('app://obox/ui.css')
    expect(h.links[0].attrs.has('data-obox-ui')).toBe(true)
  })

  it('重复启动不重复注入（幂等）', () => {
    const h = harness()
    const first = h.start()
    h.start()
    expect(h.links).toHaveLength(1)
    first.destroy()
  })

  it('disableUiCss: true 不注入', () => {
    const h = harness()
    h.start({ disableUiCss: true })
    expect(h.links).toHaveLength(0)
  })

  it('页面自己写过该 link 时不再追加', () => {
    const h = harness()
    // 模拟页面手写 `<link data-obox-ui rel=stylesheet href=app://obox/ui.css>`
    const own: FakeLink = {
      rel: 'stylesheet',
      href: 'app://obox/ui.css',
      attrs: new Map([['data-obox-ui', '']]),
      setAttribute: (): void => {}
    }
    h.links.push(own)
    h.start()
    expect(h.links).toHaveLength(1)
  })

  it('注入发生在首帧（不需要等上下文到达）', () => {
    const h = harness()
    const handle = h.start()
    // 一条消息都没发
    expect(h.links).toHaveLength(1)
    handle.destroy()
  })
})
