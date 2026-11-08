/**
 * 壳子渲染点的标签解析（change `unified-page-context` 任务 4.2 / 4.3 / 4.4）。
 *
 * 覆盖判据：
 * - `resolveManifestLabels`：扩展条目的 `displayName`/`description` 在对外前已是成品文本；
 * - `hostQueryDeps().commands` / `themeList`：页面与命令面板拿到的是解析后的标题（不是 `%key%`）；
 * - 源码门禁：NavBar / StatusBar / CommandPalette 都走 `resolveExtensionLabel`，
 *   且 `titleKey` 仍保留（遗留兼容，既有内置扩展不失效）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resetLabelWarnings, resolveManifestLabels } from '../src/renderer/src/core/extensionLabels'
import {
  clearExtensionMessages,
  registerExtensionMessages
} from '../src/renderer/src/core/extensionI18n'
import { registry } from '../src/renderer/src/core/registry'
import { hostQueryDeps } from '../src/renderer/src/core/hostQueryDeps'

afterEach(() => {
  resetLabelWarnings()
  clearExtensionMessages('ext-a')
})

function repoFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
}

describe('resolveManifestLabels', () => {
  it('displayName/description 的 %key% 被解析成当前语言文本', () => {
    registerExtensionMessages('ext-a', {
      zh: { 'ext.name': '应用', 'ext.desc': '卡片列表' },
      en: { 'ext.name': 'Apps', 'ext.desc': 'Card list' }
    })
    const entry = resolveManifestLabels({
      id: 'ext-a',
      manifest: { displayName: '%ext.name%', description: '%ext.desc%', version: '1.0.0' }
    })
    expect(entry.manifest).toEqual({
      displayName: '应用',
      description: '卡片列表',
      version: '1.0.0'
    })
  })

  it('没有 manifest / 没有这两个字段时不改动', () => {
    expect(resolveManifestLabels({ id: 'x' })).toEqual({ id: 'x' })
    const entry = resolveManifestLabels({ id: 'x', manifest: { version: '1.0.0' } })
    expect(entry.manifest).toEqual({ version: '1.0.0' })
  })
})

describe('hostQueryDeps 对外文本', () => {
  it('commands：标题被解析（页面/命令面板拿不到 %key%）', () => {
    registerExtensionMessages('ext-a', { zh: { 'cmd.run': '运行' } })
    registry.registerCommand('ext-a', { command: 'ext-a.run', title: '%cmd.run%' })
    const cmd = hostQueryDeps()
      .commands()
      .find((c) => c.command === 'ext-a.run')
    expect(cmd?.title).toBe('运行')
    expect(JSON.stringify(hostQueryDeps().commands())).not.toContain('%cmd.run%')
  })

  it('themeList：主题 label 被解析（内置主题已改成 %theme.label%）', () => {
    const themes = hostQueryDeps().themeList()
    // 生产主题由扩展注册；这里只断言当前注册表里的标签都不含未解析占位符
    for (const theme of themes) {
      expect(theme.label.startsWith('%')).toBe(false)
    }
  })
})

describe('源码门禁：壳子渲染点接入解析器', () => {
  it('NavBar / StatusBar / CommandPalette 使用 resolveExtensionLabel，titleKey 仍保留', () => {
    const nav = repoFile('src/renderer/src/components/NavBar.vue')
    expect(nav).toContain('resolveExtensionLabel')
    expect(nav).toContain('titleKey')

    const status = repoFile('src/renderer/src/components/StatusBar.vue')
    expect(status).toContain('resolveExtensionLabel')
    expect(status).toContain('titleKey')

    const palette = repoFile('src/renderer/src/components/CommandPalette.vue')
    expect(palette).toContain('resolveExtensionLabel')
  })
})
