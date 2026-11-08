/**
 * 渲染侧页面上下文组装器（change `unified-page-context` 任务 1.2）。
 *
 * 覆盖判据：
 * - `createPageContextBuilder`：colorScheme 声明优先、未声明按 id 推断、`locale` 透传、
 *   `messages` 只来自接收页面的扩展（另一个扩展拿到空表）；
 * - `getExtensionMessages`：当前语言整包、当前语言缺失整包回退 zh、返回拷贝、未注册空表；
 * - `readEffectiveTokens`：无 DOM 时不抛错、有 DOM 时只收非空值。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLegacySystemThemeMessage,
  buildPageContextFor,
  createPageContextBuilder,
  isPageContextRequest,
  pushWithLegacy,
  readEffectiveTokens,
  type PageContextDeps
} from '../src/renderer/src/core/pageContext'
import type { PageContextMessage } from '../src/shared/pageContext'
import {
  getExtensionMessages,
  registerExtensionMessages,
  clearExtensionMessages
} from '../src/renderer/src/core/extensionI18n'

afterEach(() => {
  clearExtensionMessages('ext-a')
  clearExtensionMessages('ext-b')
  delete (globalThis as unknown as Record<string, unknown>).document
  delete (globalThis as unknown as Record<string, unknown>).getComputedStyle
})

describe('pageContext 组装 · colorScheme 与词条隔离', () => {
  const deps = (overrides: Partial<PageContextDeps> = {}): PageContextDeps => ({
    themeId: () => 'solarized',
    declaredColorScheme: () => undefined as 'dark' | 'light' | undefined,
    tokens: () => ({ '--bg': '#fdf6e3' }),
    locale: () => 'en',
    messages: (id: string) => (id === 'ext-a' ? { hello: 'Hi' } : {}),
    ...overrides
  })

  it('未声明 colorScheme：按 id 推断（solarized → dark）', () => {
    const build = createPageContextBuilder(deps())
    expect(build('ext-a').colorScheme).toBe('dark')
  })

  it('声明优先：id 不含 light 也能是浅色', () => {
    const build = createPageContextBuilder(deps({ declaredColorScheme: () => 'light' }))
    expect(build('ext-a').colorScheme).toBe('light')
  })

  it('词条只来自接收页面的扩展，locale/tokens 原样透传', () => {
    const build = createPageContextBuilder(deps())
    const a = build('ext-a')
    expect(a.messages).toEqual({ hello: 'Hi' })
    expect(a.locale).toBe('en')
    expect(a.tokens).toEqual({ '--bg': '#fdf6e3' })
    expect(a.themeId).toBe('solarized')
    expect(build('ext-b').messages).toEqual({})
  })

  it('生产组装器可调用（无 DOM 时不抛错）', () => {
    expect(() => buildPageContextFor('ext-a')).not.toThrow()
    expect(buildPageContextFor('ext-a').type).toBe('obox:context')
  })
})

describe('getExtensionMessages · 整包与回退', () => {
  it('当前语言有词条 ⇒ 返回该语言整包', () => {
    registerExtensionMessages('ext-a', { zh: { a: '甲', b: '乙' }, en: { a: 'A' } })
    expect(getExtensionMessages('ext-a', 'en')).toEqual({ a: 'A' })
  })

  it('当前语言无词条 ⇒ 整包回退 zh（避免中英混排）', () => {
    registerExtensionMessages('ext-a', { zh: { a: '甲' } })
    expect(getExtensionMessages('ext-a', 'en')).toEqual({ a: '甲' })
  })

  it('返回拷贝：改返回值不影响注册表', () => {
    registerExtensionMessages('ext-a', { zh: { a: '甲' } })
    const got = getExtensionMessages('ext-a', 'zh')
    got.a = '被改了'
    expect(getExtensionMessages('ext-a', 'zh')).toEqual({ a: '甲' })
  })

  it('未注册的扩展 ⇒ 空表', () => {
    expect(getExtensionMessages('ext-none', 'zh')).toEqual({})
  })
})

describe('readEffectiveTokens · 生效值快照', () => {
  it('无 DOM（node 单测）⇒ 空表，不抛错', () => {
    expect(readEffectiveTokens()).toEqual({})
  })

  it('有 DOM 时只收非空值', () => {
    ;(globalThis as unknown as Record<string, unknown>).document = {
      documentElement: {}
    }
    ;(globalThis as unknown as Record<string, unknown>).getComputedStyle = () => ({
      getPropertyValue: (name: string): string => (name === '--bg' ? ' #123456 ' : '')
    })
    expect(readEffectiveTokens()).toEqual({ '--bg': '#123456' })
  })
})

/**
 * 任务 2.3：旧协议与新上下文的**投递顺序**（旧先、新后），以及请求判定。
 * 用一个只记录消息的假窗口，不依赖 jsdom。
 */
describe('pushWithLegacy · 兼容投递顺序', () => {
  function capture(): { sent: unknown[]; win: { postMessage: (m: unknown) => void } } {
    const sent: unknown[] = []
    return { sent, win: { postMessage: (m: unknown): void => void sent.push(m) } }
  }

  it('旧消息先、obox:context 后（老页面先拿到认识的消息）', () => {
    const { sent, win } = capture()
    const legacy = { type: 'obox-theme', tokens: { '--bg': '#000' } }
    expect(pushWithLegacy(win, 'ext-a', legacy)).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual(legacy)
    expect((sent[1] as PageContextMessage).type).toBe('obox:context')
    expect((sent[1] as PageContextMessage).version).toBe(1)
  })

  it('只发新协议时 legacy 传 undefined：只有一条消息', () => {
    const { sent, win } = capture()
    pushWithLegacy(win, 'ext-a', undefined)
    expect(sent).toHaveLength(1)
    expect((sent[0] as PageContextMessage).type).toBe('obox:context')
  })

  it('窗口不可用 / postMessage 抛错：返回 false，不抛出去', () => {
    expect(pushWithLegacy(null, 'ext-a', undefined)).toBe(false)
    expect(
      pushWithLegacy(
        {
          postMessage: (): void => {
            throw new Error('destroyed')
          }
        },
        'ext-a',
        { type: 'obox-theme', tokens: {} }
      )
    ).toBe(false)
  })

  it('页面请求判定只认 obox:context-request', () => {
    expect(isPageContextRequest({ type: 'obox:context-request' })).toBe(true)
    expect(isPageContextRequest({ type: 'obox-theme' })).toBe(false)
    expect(isPageContextRequest({ type: 'obox:page-call', op: 'x' })).toBe(false)
    expect(isPageContextRequest(null)).toBe(false)
  })

  it('旧系统页主题消息形状稳定（type/tokens）', () => {
    expect(buildLegacySystemThemeMessage()).toEqual({ type: 'obox-theme', tokens: {} })
  })
})
