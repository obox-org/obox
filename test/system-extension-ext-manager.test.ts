import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../scripts/validate-manifest.mjs'

/**
 * 第一个系统扩展 `ext-manager`（change 任务 6.1 的第一块）。
 *
 * 它同时是"系统扩展长什么样"的活文档：目录名 = id、author=obox、页面走 navItems[].page。
 * 这里钉住清单合法性与文件齐全，避免"改了路径但忘了文件"。
 */
const dir = fileURLToPath(new URL('../system-extensions/ext-manager/', import.meta.url))

describe('系统扩展 ext-manager', () => {
  it('目录名与清单 name 一致、author 是 obox、声明了 page 导航项', () => {
    const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8')) as {
      name: string
      author: string
      contributes: { navItems: Array<{ id: string; page?: string; view?: string }> }
    }
    expect(manifest.name).toBe('ext-manager')
    expect(manifest.author).toBe('obox')
    const nav = manifest.contributes.navItems[0]
    expect(nav.page).toBe('index.html')
    expect(nav.view).toBeUndefined()
  })

  it('清单通过脚本校验（与宿主同口径）', () => {
    const raw = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8')) as unknown
    const errors = validateManifest(raw, 4).filter(
      (m: { level: string }) => m.level === 'error'
    ) as unknown[]
    expect(errors).toEqual([])
  })

  it('页面文件齐全（HTML / 脚本 / 样式 / 入口）', () => {
    for (const file of ['index.html', 'page.js', 'page.css', 'index.js']) {
      expect(existsSync(`${dir}${file}`), `缺少 ${file}`).toBe(true)
    }
  })

  it('页面用 obox:page-call 协议调用壳子，且壳子有对应处理（源码门禁）', () => {
    expect(readFileSync(`${dir}page.js`, 'utf8')).toContain("type: 'obox:page-call'")
    const shell = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/components/ContentArea.vue', import.meta.url)),
      'utf8'
    )
    expect(shell).toContain("data.type !== 'obox:page-call'")
    expect(shell).toContain('runHostQuery(data.op, data.args, hostQueryDeps())')
    // 主题/语言统一走页面上下文（旧 `{type:'obox-theme'}` 由 pageContext 里的兼容消息承担）
    expect(shell).toContain('buildLegacySystemThemeMessage')
    expect(shell).toContain('pushWithLegacy')
  })
})
