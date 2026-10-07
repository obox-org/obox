/**
 * 扩展语言包单测（extensionI18n）。
 * 覆盖：未注册/缺 key 回退、按当前语言取值、语言缺省回退 zh、{param} 插值、多次注册合并、注销清理。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { i18n } from '../src/renderer/src/i18n'
import {
  clearExtensionMessages,
  registerExtensionMessages,
  translateExtension
} from '../src/renderer/src/core/extensionI18n'

describe('extensionI18n', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh'
    clearExtensionMessages('ext-i18n')
  })

  it('未注册扩展 → 返回 key 本身', () => {
    expect(translateExtension('ext-i18n', 'hello')).toBe('hello')
  })

  it('按当前语言取值；缺 key 返回 key', () => {
    registerExtensionMessages('ext-i18n', { zh: { hello: '你好' }, en: { hello: 'Hello' } })
    expect(translateExtension('ext-i18n', 'hello')).toBe('你好')
    i18n.global.locale.value = 'en'
    expect(translateExtension('ext-i18n', 'hello')).toBe('Hello')
    expect(translateExtension('ext-i18n', 'missing')).toBe('missing')
  })

  it('当前语言缺条目时回退 zh', () => {
    registerExtensionMessages('ext-i18n', { zh: { onlyZh: '仅中文' } })
    i18n.global.locale.value = 'en'
    expect(translateExtension('ext-i18n', 'onlyZh')).toBe('仅中文')
  })

  it('{param} 插值', () => {
    registerExtensionMessages('ext-i18n', { zh: { greet: '你好 {name}，共 {n} 条' } })
    expect(translateExtension('ext-i18n', 'greet', { name: 'Obox', n: 3 })).toBe('你好 Obox，共 3 条')
  })

  it('多次注册合并（新 key 追加，旧 key 保留）', () => {
    registerExtensionMessages('ext-i18n', { zh: { a: 'A' } })
    registerExtensionMessages('ext-i18n', { zh: { b: 'B' } })
    expect(translateExtension('ext-i18n', 'a')).toBe('A')
    expect(translateExtension('ext-i18n', 'b')).toBe('B')
  })

  it('注销后回到 key 本身', () => {
    registerExtensionMessages('ext-i18n', { zh: { hello: '你好' } })
    clearExtensionMessages('ext-i18n')
    expect(translateExtension('ext-i18n', 'hello')).toBe('hello')
  })

  it('扩展之间命名空间隔离', () => {
    registerExtensionMessages('ext-i18n', { zh: { hello: 'A 的你好' } })
    expect(translateExtension('ext-i18n-other', 'hello')).toBe('hello')
  })
})
