/**
 * 扩展设置页注册表单测（extensionSettingsStore）。
 * 覆盖：同 id 覆盖注册、按页 id 移除（api.settings.register 的 dispose 语义）、按扩展整体清理。
 */
import { describe, expect, it } from 'vitest'
import { extensionSettingsStore } from '../src/renderer/src/core/extensionSettings'

const page = (id: string, title = id): { id: string; title: string; fields: never[] } => ({
  id,
  title,
  fields: []
})

describe('extensionSettingsStore', () => {
  it('同 id 重复注册 → 原地更新，不新增条目', () => {
    extensionSettingsStore.register('ext-set-a', page('ext-set-a.page', '旧标题'))
    extensionSettingsStore.register('ext-set-a', page('ext-set-a.page', '新标题'))
    const rows = extensionSettingsStore.pages.filter((p) => p.id === 'ext-set-a.page')
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('新标题')
    extensionSettingsStore.deactivateExtension('ext-set-a')
  })

  it('removePage 只移除指定页（不影响同扩展其它页与 manifest 声明的页）', () => {
    extensionSettingsStore.register('ext-set-b', page('ext-set-b.manifest'))
    extensionSettingsStore.register('ext-set-b', page('ext-set-b.runtime'))
    extensionSettingsStore.removePage('ext-set-b.runtime')
    const remaining = extensionSettingsStore.byExtension('ext-set-b').map((p) => p.id)
    expect(remaining).toEqual(['ext-set-b.manifest'])
    extensionSettingsStore.deactivateExtension('ext-set-b')
  })

  it('deactivateExtension 清理该扩展全部设置页', () => {
    extensionSettingsStore.register('ext-set-c', page('ext-set-c.one'))
    extensionSettingsStore.register('ext-set-c', page('ext-set-c.two'))
    extensionSettingsStore.deactivateExtension('ext-set-c')
    expect(extensionSettingsStore.byExtension('ext-set-c')).toEqual([])
    expect(extensionSettingsStore.extensionIds).not.toContain('ext-set-c')
  })

  it('byExtension / extensionIds 按扩展归组', () => {
    extensionSettingsStore.register('ext-set-d', page('ext-set-d.one'))
    expect(extensionSettingsStore.byExtension('ext-set-d').map((p) => p.id)).toEqual([
      'ext-set-d.one'
    ])
    expect(extensionSettingsStore.extensionIds).toContain('ext-set-d')
    extensionSettingsStore.deactivateExtension('ext-set-d')
  })
})
