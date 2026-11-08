import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../src/renderer/src/core/manifest'
import { validateManifest as validateManifestScript } from '../scripts/validate-manifest.mjs'

/**
 * 系统扩展的「页面」贡献（change `system-extensions-from-install-dir` 任务 6.x 的前置）。
 *
 * 磁盘扩展只能提供 HTML 页面（拿不到壳子的 Vue 组件），所以 `contributes.navItems[]` 需要
 * `page`：相对扩展根目录的 HTML 入口，壳子用 iframe 渲染它。这里钉住两侧校验器同口径。
 */
function errors(raw: unknown): string[] {
  return validateManifest(raw)
    .filter((m) => m.severity === 'error')
    .map((m) => m.message)
}

function scriptErrors(raw: unknown): string[] {
  return validateManifestScript(raw, 4)
    .filter((m: { level: string }) => m.level === 'error')
    .map((m: { message: string }) => m.message)
}

const base = {
  name: 'app',
  author: 'obox',
  version: '1.0.0',
  main: './index.js',
  apiVersion: 4,
  contributes: {
    navItems: [{ id: 'app.home', title: '应用', icon: 'app', page: 'index.html' }]
  }
}

describe('navItems[].page', () => {
  it('合法 page（相对 HTML 路径）通过两侧校验', () => {
    expect(errors(base)).toEqual([])
    expect(scriptErrors(base)).toEqual([])
  })

  it('page 与 view 同时给出 → error（壳子无法决定渲染什么）', () => {
    const raw = {
      ...base,
      contributes: {
        navItems: [{ id: 'a', title: 'A', icon: 'x', page: 'index.html', view: 'obox.tree' }]
      }
    }
    expect(errors(raw).join()).toMatch(/page|view/)
    expect(scriptErrors(raw).join()).toMatch(/page|view/)
  })

  it('page 越界 / 非 HTML / 绝对路径 → error', () => {
    for (const page of ['../x.html', 'C:/x.html', 'x.js', '/abs.html']) {
      const raw = {
        ...base,
        contributes: { navItems: [{ id: 'a', title: 'A', icon: 'x', page }] }
      }
      expect(errors(raw).length, `renderer 侧应拒绝 ${page}`).toBeGreaterThan(0)
      expect(scriptErrors(raw).length, `脚本侧应拒绝 ${page}`).toBeGreaterThan(0)
    }
  })

  it('壳子的 ContentArea 有 iframe 渲染分支（源码门禁）', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/components/ContentArea.vue', import.meta.url)),
      'utf8'
    )
    expect(src).toContain('<iframe')
    expect(src).toContain('activePage')
  })

  it('壳子与子窗口都投递统一上下文，且保留旧主题协议（源码门禁，change unified-page-context 2.1/2.2）', () => {
    const content = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/components/ContentArea.vue', import.meta.url)),
      'utf8'
    )
    // 四个时机：load 走 onPageLoad、主题/语言走 onSettingsChanged、请求走 isPageContextRequest
    expect(content).toContain('pushWithLegacy')
    expect(content).toContain('onSettingsChanged')
    expect(content).toContain("key === 'theme'")
    expect(content).toContain('isPageContextRequest')
    expect(content).toContain('onPageLoad')

    const appWindow = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/AppWindow.vue', import.meta.url)),
      'utf8'
    )
    // 双发：旧 `obox-app` 主题消息 + 新上下文
    expect(appWindow).toContain('pushWithLegacy')
    expect(appWindow).toContain('buildThemeMessage')
    expect(appWindow).toContain("key === 'locale'")
  })
})
