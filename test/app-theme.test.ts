/**
 * 宿主侧主题下发协议单测（core/appTheme.ts，设计 §7.4 / ADR-0022）。
 *
 * 覆盖：token 白名单与 main.css 的差分、快照收集、消息构造、载荷过滤、
 * 以及 `appFrameKey` —— 后者是「url 型卡片切主题不重渲染 / srcdoc 型仍重渲染」的判据：
 * Vue 的 `:key` 不变 ⇒ 元素不重建 ⇒ 不重渲染。
 *
 * 不用真实 iframe / 不用 jsdom（设计 §7.4 有论证）：`app://` 协议由主进程注册，
 * 单测无法复现；而"是否重渲染"在 Vue 里完全由 `:key` 决定，落成纯函数即等价且不脆弱。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  APP_THEME_PUSH_ACTION,
  APP_THEME_REQUEST_ACTION,
  HOST_THEME_TOKEN_NAMES,
  appFrameKey,
  buildThemeMessage,
  collectThemeTokens,
  isThemePush,
  isThemeRequest,
  isTokenName,
  sanitizeThemeTokens
} from '../src/renderer/src/core/appTheme'

const MAIN_CSS = fileURLToPath(new URL('../src/renderer/src/assets/main.css', import.meta.url))

/** 从 main.css 取 `:root { … }` 里的自定义属性名（保持出现顺序），先去掉注释避免注释里的示例被算进来 */
function readMainCssTokenNames(): string[] {
  const css = readFileSync(MAIN_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(css)
  if (!rootBlock) throw new Error('main.css 里找不到 :root 块')
  return [...rootBlock[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!)
}

describe('appTheme · token 白名单与快照', () => {
  it('HOST_THEME_TOKEN_NAMES 与 main.css 的 :root 逐条一致（集合与顺序）', () => {
    expect(HOST_THEME_TOKEN_NAMES).toEqual(readMainCssTokenNames())
    expect(HOST_THEME_TOKEN_NAMES).toHaveLength(25)
  })

  it('collectThemeTokens 按白名单逐个取值并跳过空值', () => {
    const values: Record<string, string> = {
      '--bg': '#1e1e1e',
      '--fg': '  #cccccc  ',
      '--accent': ''
    }
    const read = (name: string): string => values[name] ?? ''
    const tokens = collectThemeTokens(read)
    expect(tokens).toEqual({ '--bg': '#1e1e1e', '--fg': '#cccccc' })
    // 只收白名单内的名字，且不夹带任何未列出的键
    expect(Object.keys(tokens).every((k) => HOST_THEME_TOKEN_NAMES.includes(k))).toBe(true)
  })

  it('collectThemeTokens 可传自定义名单，read 抛错时跳过该名字而不抛出', () => {
    const read = (name: string): string => {
      if (name === '--bad') throw new Error('boom')
      return 'x'
    }
    expect(collectThemeTokens(read, ['--ok', '--bad', '--ok2'])).toEqual({
      '--ok': 'x',
      '--ok2': 'x'
    })
  })

  it('buildThemeMessage 生成 {source,action,themeId,tokens}', () => {
    const msg = buildThemeMessage('theme-dark', { '--bg': '#1e1e1e' })
    expect(msg).toEqual({
      source: 'obox-app',
      action: APP_THEME_PUSH_ACTION,
      themeId: 'theme-dark',
      tokens: { '--bg': '#1e1e1e' }
    })
    expect(APP_THEME_PUSH_ACTION).toBe('obox-theme')
    expect(APP_THEME_REQUEST_ACTION).toBe('obox-theme-request')
    // 无主题扩展时仍发空包（扩展保持兜底，不空白）
    expect(buildThemeMessage('', {})).toEqual({
      source: 'obox-app',
      action: 'obox-theme',
      themeId: '',
      tokens: {}
    })
    // 构造时顺带过滤非法载荷
    expect(
      buildThemeMessage('t', { '--x': 1 } as unknown as Record<string, string>).tokens
    ).toEqual({})
  })

  it('sanitizeThemeTokens 丢弃非法键名/非字符串/空串，且不抛错', () => {
    const input = { '--bg': '#fff', bg: 'x', '--x': 1, '--y': '', '--z': null, '--ok': '2px' }
    expect(sanitizeThemeTokens(input)).toEqual({ '--bg': '#fff', '--ok': '2px' })
    expect(sanitizeThemeTokens(null)).toEqual({})
    expect(sanitizeThemeTokens('x')).toEqual({})
    expect(sanitizeThemeTokens(['--bg'])).toEqual({})
    expect(isTokenName('--bg-panel')).toBe(true)
    expect(isTokenName('--Bg')).toBe(false)
    expect(isTokenName('bg')).toBe(false)
    expect(isTokenName(1)).toBe(false)
  })
})

describe('appTheme · appFrameKey（重渲染判据）', () => {
  it('url 型卡片与 themeId 无关：同 url + 两个主题 → 同一个 key（切主题不重渲染）', () => {
    const reg = { url: 'app://extensions/rdp/ui/index.html' }
    const a = appFrameKey(reg, 'theme-dark')
    const b = appFrameKey(reg, 'theme-light')
    expect(a).toBe(b)
    expect(a).toBe('url:app://extensions/rdp/ui/index.html')
  })

  it('srcdoc 型卡片随 themeId 变化：两个主题 → 两个不同 key（切主题重渲染）', () => {
    const reg = { html: '<p>x</p>' }
    expect(appFrameKey(reg, 'theme-dark')).toBe('srcdoc:theme-dark')
    expect(appFrameKey(reg, 'theme-light')).toBe('srcdoc:theme-light')
    expect(appFrameKey(reg, 'theme-dark')).not.toBe(appFrameKey(reg, 'theme-light'))
  })

  it('无 url 且无 html 时按 srcdoc 处理；url 为空串同样按 srcdoc 处理', () => {
    expect(appFrameKey(undefined, 'theme-dark')).toBe('srcdoc:theme-dark')
    expect(appFrameKey({}, 'theme-dark')).toBe('srcdoc:theme-dark')
    expect(appFrameKey({ url: '' }, 'theme-dark')).toBe('srcdoc:theme-dark')
  })
})

describe('appTheme · 消息形状判定', () => {
  it('isThemePush / isThemeRequest 只认本协议形状', () => {
    expect(
      isThemePush({ source: 'obox-app', action: 'obox-theme', themeId: 't', tokens: {} })
    ).toBe(true)
    expect(isThemeRequest({ source: 'obox-app', action: 'obox-theme-request' })).toBe(true)

    // 拒绝：null / 非对象 / 其它 source / 其它 action / 既有扩展桥消息
    for (const bad of [
      null,
      undefined,
      'obox-theme',
      42,
      {},
      { source: 'obox-app' },
      { action: 'obox-theme' },
      { source: 'other', action: 'obox-theme' },
      { source: 'obox-app', action: 'obox-extension' },
      { source: 'obox-app', action: 'obox-extension-reply' },
      { source: 'obox-app', action: 'minimize' }
    ]) {
      expect(isThemePush(bad)).toBe(false)
      expect(isThemeRequest(bad)).toBe(false)
    }
    // 两个判定互不串味
    expect(isThemePush({ source: 'obox-app', action: 'obox-theme-request' })).toBe(false)
    expect(isThemeRequest({ source: 'obox-app', action: 'obox-theme' })).toBe(false)
  })
})
