/**
 * `%key%` 标签解析（change `unified-page-context` 任务 4.1）。
 *
 * 覆盖判据：
 * - 普通字符串原样返回；`%key%` 命中返回词条；缺 key 返回占位符原文；
 * - 缺 key 每个扩展每个 key 只告警一次（不同扩展/不同 key 各告警）；
 * - 非字符串按空串；空占位符 / 含 `%` 的非整串不解析；
 * - `resolveFieldLabels` 只改 `label`/`description`，其余字段原样保留。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetLabelWarnings,
  resolveExtensionLabel,
  resolveFieldLabels
} from '../src/renderer/src/core/extensionLabels'
import {
  clearExtensionMessages,
  registerExtensionMessages
} from '../src/renderer/src/core/extensionI18n'

afterEach(() => {
  resetLabelWarnings()
  clearExtensionMessages('ext-a')
  clearExtensionMessages('ext-b')
  vi.restoreAllMocks()
})

describe('resolveExtensionLabel · 解析', () => {
  it('普通字符串原样返回（不触发词条查找）', () => {
    expect(resolveExtensionLabel('深色', 'ext-a')).toBe('深色')
    expect(resolveExtensionLabel('100% 完成', 'ext-a')).toBe('100% 完成')
  })

  it('命中词条：按该扩展命名空间 + 当前语言', () => {
    registerExtensionMessages('ext-a', { zh: { 'nav.home': '应用' }, en: { 'nav.home': 'Apps' } })
    expect(resolveExtensionLabel('%nav.home%', 'ext-a', 'zh')).toBe('应用')
    expect(resolveExtensionLabel('%nav.home%', 'ext-a', 'en')).toBe('Apps')
  })

  it('扩展之间的词条互不串用', () => {
    registerExtensionMessages('ext-a', { zh: { k: 'A 的' } })
    registerExtensionMessages('ext-b', { zh: { k: 'B 的' } })
    expect(resolveExtensionLabel('%k%', 'ext-a')).toBe('A 的')
    expect(resolveExtensionLabel('%k%', 'ext-b')).toBe('B 的')
    expect(resolveExtensionLabel('%k%', 'ext-missing')).toBe('%k%')
  })

  it('非字符串按空串；空占位符不解析', () => {
    expect(resolveExtensionLabel(undefined, 'ext-a')).toBe('')
    expect(resolveExtensionLabel(42, 'ext-a')).toBe('')
    expect(resolveExtensionLabel('%%', 'ext-a')).toBe('%%')
  })
})

describe('resolveExtensionLabel · 缺 key', () => {
  it('返回占位符原文，并对同一 key 只告警一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerExtensionMessages('ext-a', { zh: { other: 'x' } })
    expect(resolveExtensionLabel('%nav.hom%', 'ext-a')).toBe('%nav.hom%')
    expect(resolveExtensionLabel('%nav.hom%', 'ext-a')).toBe('%nav.hom%')
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('nav.hom'))).toHaveLength(1)
  })

  it('不同扩展 / 不同 key 各自告警一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveExtensionLabel('%x%', 'ext-a')
    resolveExtensionLabel('%x%', 'ext-b')
    resolveExtensionLabel('%y%', 'ext-a')
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('`resetLabelWarnings` 后可以再次告警（测试隔离用）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveExtensionLabel('%x%', 'ext-a')
    resetLabelWarnings()
    resolveExtensionLabel('%x%', 'ext-a')
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('resolveFieldLabels', () => {
  it('只改 label/description，其余字段原样保留', () => {
    registerExtensionMessages('ext-a', { zh: { 'f.label': '间隔', 'f.desc': '秒' } })
    expect(
      resolveFieldLabels({ key: 'interval', label: '%f.label%', description: '%f.desc%', type: 'number' }, 'ext-a')
    ).toEqual({ key: 'interval', label: '间隔', description: '秒', type: 'number' })
  })

  it('缺字段不凭空添加', () => {
    expect(resolveFieldLabels({ key: 'k' }, 'ext-a')).toEqual({ key: 'k' })
  })
})
