import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toSerializable } from '../src/renderer/src/core/hostQuery'

/**
 * 系统扩展的**独立性门禁**（change 任务 6.5）与序列化清洗（真机踩到的问题）。
 */
const root = fileURLToPath(new URL('../system-extensions/', import.meta.url))

describe('系统扩展独立性（6.5）', () => {
  it('系统扩展的脚本不得 import 渲染进程内部单例（core/*）', () => {
    const offenders: string[] = []
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      for (const file of readdirSync(`${root}${dir.name}`)) {
        if (!/\.(js|mjs)$/.test(file)) continue
        const src = readFileSync(`${root}${dir.name}/${file}`, 'utf8')
        // 系统扩展是页面脚本：只能经 obox:page-call 调公共 API，不得碰壳子内部模块
        if (/from\s+['"].*core\//.test(src) || /import\(['"].*core\//.test(src)) {
          offenders.push(`${dir.name}/${file}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('三个系统扩展都有清单与入口，且 author 都是 obox', () => {
    for (const name of ['app', 'settings', 'ext-manager']) {
      const dir = `${root}${name}`
      expect(existsSync(`${dir}/manifest.json`), `${name} 缺清单`).toBe(true)
      expect(existsSync(`${dir}/index.html`), `${name} 缺页面`).toBe(true)
      const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')) as {
        name: string
        author: string
      }
      expect(manifest.author).toBe('obox')
      expect(manifest.name).toBe(name)
    }
  })
})

describe('查询结果可序列化（真机问题）', () => {
  it('去掉 Proxy/函数，只留纯数据', () => {
    const reactiveLike = new Proxy(
      { id: 'theme-dark', label: '深色', setTheme: (): void => undefined },
      {}
    )
    const plain = toSerializable(reactiveLike) as Record<string, unknown>
    expect(plain).toEqual({ id: 'theme-dark', label: '深色' })
  })

  it('undefined 原样返回、循环引用回退 null（不让整条调用失败）', () => {
    expect(toSerializable(undefined)).toBeUndefined()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(toSerializable(cyclic)).toBeNull()
  })
})
describe('更新事件桥（下载进度）', () => {
  it('壳子把 update:event 转给页面，页面按事件渲染进度', () => {
    const shell = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/components/ContentArea.vue', import.meta.url)),
      'utf8'
    )
    expect(shell).toContain("window.events.on('update:event'")
    expect(shell).toContain("type: 'obox-update-event'")

    const page = readFileSync(`${root}settings/page.js`, 'utf8')
    expect(page).toContain("data.type !== 'obox-update-event'")
    expect(page).toContain("ev.type === 'download-progress'")
  })
})
describe('主题与语言（页面运行时统一驱动）', () => {
  it('三个系统扩展页面都引入 app://obox/page.js，且不再自建 obox-theme 监听', () => {
    for (const name of ['app', 'settings', 'ext-manager']) {
      const src = readFileSync(`${root}${name}/page.js`, 'utf8')
      expect(src, `${name} 未引入页面运行时`).toContain("from 'app://obox/page.js'")
      expect(src, `${name} 仍手拼 -- 前缀（旧 bug）`).not.toContain('setProperty(`--${key}`')
      expect(src, `${name} 仍自建旧主题监听`).not.toContain("data.type !== 'obox-theme'")
    }
  })

  it('三个系统扩展页面代码里不再有中文字面量（注释除外，文案全部走 contributes.i18n）', () => {
    for (const name of ['app', 'settings', 'ext-manager']) {
      const raw = readFileSync(`${root}${name}/page.js`, 'utf8')
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\/.*$/gm, '')
      const cjk = [...code.matchAll(/[\u4e00-\u9fff][^\n'"`]*/g)].map((m) => m[0])
      expect(cjk, `${name} 仍含中文字面量：${cjk.slice(0, 3).join(' / ')}`).toEqual([])
    }
  })
})
describe('文档同步（扩展来源/打包路径变了）', () => {
  const readRepo = (rel: string): string =>
    readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')

  it('README 写明 system-extensions/ 与 .extensions/ 构建产物', () => {
    const readme = readRepo('README.md')
    expect(readme).toContain('system-extensions/')
    expect(readme).toContain('.extensions/')
    expect(readme).toContain('build:extensions')
    expect(readme).toContain('apiVersion: 4')
  })

  it('manifest-reference 有「扩展来源与目录命名」，troubleshooting 有 48 条', () => {
    expect(readRepo('docs/extension-api/manifest-reference.md')).toContain('扩展来源与目录命名')
    expect(readRepo('docs/extension-api/troubleshooting.md')).toContain('## 48.')
  })
})
describe('应用页卡片交互', () => {
  it('卡片支持右键菜单：打开 / 在扩展管理中查看', () => {
    const page = readFileSync(`${root}app/page.js`, 'utf8')
    expect(page).toContain("addEventListener('contextmenu'")
    expect(page).toContain("t('app.menu.open')")
    expect(page).toContain("pages.open', { pageId: 'ext-manager'")
  })
})
describe('扩展管理器详情', () => {
  it('行内详情展示版本/作者/入口/来源与校验错误', () => {
    const page = readFileSync(`${root}ext-manager/page.js`, 'utf8')
    expect(page).toContain("addRow(t('ext.detail.version')")
    expect(page).toContain("addRow(t('ext.detail.author')")
    expect(page).toContain("addRow(t('ext.detail.entry')")
    expect(page).toContain("addRow(t('ext.detail.source')")
    expect(page).toContain('validations')
    expect(page).toContain('ext-details')
  })
})
describe('开发运行时（Python）', () => {
  it('文档写明 runtime.json 标记与默认键', () => {
    const doc = readFileSync(
      fileURLToPath(new URL('../docs/extension-api/manifest-reference.md', import.meta.url)),
      'utf8'
    )
    expect(doc).toContain('runtime.json')
    expect(doc).toContain('devRuntime.python.default')
  })

  it('设置页有「开发运行时」分区与安装入口', () => {
    const page = readFileSync(`${root}settings/page.js`, 'utf8')
    expect(page).toContain('settings.section.devRuntime')
    expect(page).toContain("'extensions.installFromPath'")
    expect(page).toContain('devRuntime.python.default')
  })
})
