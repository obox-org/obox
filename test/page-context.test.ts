/**
 * 页面上下文协议的单测（change `unified-page-context` 任务 1.1）。
 *
 * 覆盖判据：
 * - `buildPageContext`：版本固定、非法 token 名/空值/非字符串被清洗、`messages` 只留字符串、
 *   `locale` 缺失回退 zh、`colorScheme` 显式优先 / 缺省按 id 推断；
 * - `isPageContext`：合法载荷通过、缺字段/类型错/非法 token 名拒绝、**未知字段被忽略**；
 * - `isContextRequest`：只认动作名。
 */
import { describe, expect, it } from 'vitest'
import {
  buildPageContext,
  isContextRequest,
  isPageContext,
  PAGE_CONTEXT_REQUEST_TYPE,
  PAGE_CONTEXT_TYPE,
  PAGE_CONTEXT_VERSION,
  resolveColorScheme,
  sanitizeContextMessages,
  sanitizeContextTokens
} from '../src/shared/pageContext'

describe('pageContext · token 与词条清洗', () => {
  it('只留合法 token 名与非空字符串值', () => {
    expect(
      sanitizeContextTokens({
        '--bg': '#1e1e1e',
        '--fg': '  ',
        background: '#fff',
        '--accent': 42,
        '--ok': 'ok'
      })
    ).toEqual({ '--bg': '#1e1e1e', '--ok': 'ok' })
  })

  it('非对象 / 数组 / null 一律空表，不抛错', () => {
    for (const bad of [null, undefined, 'x', 5, ['--bg']]) {
      expect(sanitizeContextTokens(bad)).toEqual({})
    }
  })

  it('词条只留字符串值、丢掉空键与非字符串', () => {
    expect(sanitizeContextMessages({ a: 'A', '': 'x', b: 1, c: '', d: 'D' })).toEqual({
      a: 'A',
      c: '',
      d: 'D'
    })
  })
})

describe('pageContext · colorScheme 解析', () => {
  it('主题显式声明优先（包括与 id 相反的情况）', () => {
    expect(resolveColorScheme('light', 'theme-dark')).toBe('light')
    expect(resolveColorScheme('dark', 'theme-light')).toBe('dark')
  })

  it('缺省按 id 是否含 light 推断', () => {
    expect(resolveColorScheme(undefined, 'theme-light')).toBe('light')
    expect(resolveColorScheme(undefined, 'solarized')).toBe('dark')
    expect(resolveColorScheme('', 'x')).toBe('dark')
  })
})

describe('pageContext · buildPageContext', () => {
  it('固定 type/version，清洗 tokens/messages，缺省 locale 回退 zh', () => {
    const ctx = buildPageContext({
      themeId: 'theme-dark.dark',
      tokens: { '--bg': '#1e1e1e', nope: 'x' },
      messages: { hello: '你好', bad: 1 },
      // locale 缺省
      colorScheme: undefined
    })
    expect(ctx).toEqual({
      type: PAGE_CONTEXT_TYPE,
      version: PAGE_CONTEXT_VERSION,
      themeId: 'theme-dark.dark',
      colorScheme: 'dark',
      tokens: { '--bg': '#1e1e1e' },
      locale: 'zh',
      messages: { hello: '你好' }
    })
  })

  it('themeId 非字符串按空串处理；locale 空串回退 zh', () => {
    const ctx = buildPageContext({ themeId: 42, tokens: {}, locale: '', messages: {} })
    expect(ctx.themeId).toBe('')
    expect(ctx.locale).toBe('zh')
    expect(ctx.colorScheme).toBe('dark')
  })

  it('没有主题时 tokens 仍可为空表（组装侧负责给 全部主题 token 的生效值）', () => {
    expect(buildPageContext({ tokens: {}, messages: {} }).tokens).toEqual({})
  })
})

describe('pageContext · isPageContext', () => {
  const good = buildPageContext({
    themeId: 'theme-dark',
    colorScheme: 'dark',
    tokens: { '--bg': '#000' },
    locale: 'en',
    messages: { hello: 'Hello' }
  })

  it('接受自己组装的载荷', () => {
    expect(isPageContext(good)).toBe(true)
  })

  it('忽略未知字段（宿主加字段不该让老页面拒收）', () => {
    expect(isPageContext({ ...good, futureField: { a: 1 } })).toBe(true)
  })

  it('拒绝缺字段 / 类型不对 / 非法 token 名', () => {
    const cases: unknown[] = [
      null,
      'x',
      {},
      { ...good, type: 'obox:theme' },
      { ...good, version: '1' },
      { ...good, colorScheme: 'blue' },
      { ...good, themeId: 5 },
      { ...good, locale: 5 },
      { ...good, tokens: { background: '#fff' } },
      { ...good, tokens: { '--bg': 5 } },
      { ...good, messages: { '': 'x' } },
      { ...good, messages: { a: 5 } },
      { ...good, tokens: ['--bg'] }
    ]
    for (const [index, value] of cases.entries()) {
      expect(isPageContext(value), `case ${index}`).toBe(false)
    }
  })
})

describe('pageContext · isContextRequest', () => {
  it('只认动作名', () => {
    expect(isContextRequest({ type: PAGE_CONTEXT_REQUEST_TYPE })).toBe(true)
    expect(isContextRequest({ type: PAGE_CONTEXT_REQUEST_TYPE, extra: 1 })).toBe(true)
    expect(isContextRequest({ type: 'obox:context' })).toBe(false)
    expect(isContextRequest(null)).toBe(false)
  })
})
