import { describe, expect, it } from 'vitest'
import {
  OVERLAY_THEME_CHANNEL,
  THEME_TOKENS_PUSH_CHANNEL,
  applyThemeTokens,
  isThemeTokensPayload
} from '../src/shared/themeTokens'

/**
 * overlay 浮层的主题 token 下发（2.0.1）。
 *
 * 背景：宠物面板在 2.0.0 上"透明"——浮层是主进程 new BrowserWindow 加载的独立文档，
 * CSS 自定义属性不跨文档继承，而宿主只把 25 个 token 注入在主窗口的 documentElement 上。
 * 修法是：渲染侧上报"当前生效 token" → 主进程缓存并广播 → preload 写到 documentElement。
 *
 * 本文件只测**纯逻辑**（载荷校验 + 应用），进程链路由 `overlay-theme-wiring` 的源码门禁覆盖。
 */

interface FakeStyle {
  values: Record<string, string>
  removed: string[]
  setProperty(name: string, value: string): void
  removeProperty(name: string): void
}

function fakeDoc(): { documentElement: { style: FakeStyle } } {
  const style: FakeStyle = {
    values: {},
    removed: [],
    setProperty(name, value) {
      this.values[name] = value
    },
    removeProperty(name) {
      delete this.values[name]
      this.removed.push(name)
    }
  }
  return { documentElement: { style } }
}

describe('themeTokens · 载荷校验', () => {
  it('接受合法载荷（--x 形状的名字 + 字符串值）', () => {
    expect(
      isThemeTokensPayload({ themeId: 'dark', tokens: { '--bg-panel': '#252526', '--fg': '#ccc' } })
    ).toBe(true)
  })

  it('themeId 空串也合法（= 当前没有主题扩展，仍要下发默认值）', () => {
    expect(isThemeTokensPayload({ themeId: '', tokens: {} })).toBe(true)
  })

  it('拒绝非对象 / 缺字段 / 名字不合法 / 值不是字符串', () => {
    expect(isThemeTokensPayload(null)).toBe(false)
    expect(isThemeTokensPayload('dark')).toBe(false)
    expect(isThemeTokensPayload({ tokens: {} })).toBe(false)
    expect(isThemeTokensPayload({ themeId: 'x' })).toBe(false)
    // 非 token 名的属性名必须被挡住（否则等于让渲染进程往 documentElement 写任意样式）
    expect(isThemeTokensPayload({ themeId: 'x', tokens: { background: 'red' } })).toBe(false)
    expect(isThemeTokensPayload({ themeId: 'x', tokens: { '--ok': 1 } })).toBe(false)
  })
})

describe('themeTokens · 应用', () => {
  it('把 token 写到 documentElement.style，并返回写入的名字', () => {
    const doc = fakeDoc()
    const applied = applyThemeTokens(doc, { themeId: 'dark', tokens: { '--bg-panel': '#252526' } })
    expect(applied).toEqual(['--bg-panel'])
    expect(doc.documentElement.style.values['--bg-panel']).toBe('#252526')
  })

  it('下一次下发会先清掉上次写的键（主题切换不留残影）', () => {
    const doc = fakeDoc()
    const first = applyThemeTokens(doc, { themeId: 'a', tokens: { '--bg-panel': '#111111' } })
    applyThemeTokens(doc, { themeId: 'b', tokens: { '--fg': '#222222' } }, first)
    expect(doc.documentElement.style.values['--bg-panel']).toBeUndefined()
    expect(doc.documentElement.style.values['--fg']).toBe('#222222')
  })

  it('payload 为 null ⇒ 清空（主题被卸载）', () => {
    const doc = fakeDoc()
    const first = applyThemeTokens(doc, { themeId: 'a', tokens: { '--fg': '#222222' } })
    const applied = applyThemeTokens(doc, null, first)
    expect(applied).toEqual([])
    expect(Object.keys(doc.documentElement.style.values)).toHaveLength(0)
  })

  it('非法名字 / 空值在应用阶段也被跳过（双保险）', () => {
    const doc = fakeDoc()
    const applied = applyThemeTokens(doc, {
      themeId: 'x',
      tokens: { '--ok': '#fff', background: 'red', '--empty': '   ' }
    })
    expect(applied).toEqual(['--ok'])
    expect(doc.documentElement.style.values.background).toBeUndefined()
    expect(doc.documentElement.style.values['--empty']).toBeUndefined()
  })

  it('document 不可用时静默返回（不抛错）', () => {
    expect(applyThemeTokens(null, { themeId: 'x', tokens: { '--fg': '#fff' } })).toEqual([])
    expect(applyThemeTokens(undefined, { themeId: 'x', tokens: {} })).toEqual([])
  })

  it('setProperty 抛错时不冒泡（主题下发失败不能白屏）', () => {
    const doc = {
      documentElement: {
        style: {
          setProperty() {
            throw new Error('boom')
          },
          removeProperty() {
            /* noop */
          }
        }
      }
    }
    expect(() => applyThemeTokens(doc, { themeId: 'x', tokens: { '--fg': '#fff' } })).not.toThrow()
  })

  it('两个频道名不同（上报方向与下发方向分开，避免同名双向）', () => {
    expect(OVERLAY_THEME_CHANNEL).toBe('theme:tokens')
    expect(THEME_TOKENS_PUSH_CHANNEL).toBe('theme:push-tokens')
    expect(OVERLAY_THEME_CHANNEL).not.toBe(THEME_TOKENS_PUSH_CHANNEL)
  })
})
