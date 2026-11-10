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

  /**
   * change `component-css-library` 任务 9.x：三页必须**使用**组件库，且不再各自定义通用组件外观，
   * 否则"一份样式多处定义"的漂移会立刻回来。
   */
  it('三个系统扩展页面都使用组件库的 obox-* class', () => {
    const expected: Record<string, string[]> = {
      app: ['obox-card', 'obox-input', 'obox-menu', 'obox-title'],
      settings: [
        'obox-tree__node',
        'obox-form-item',
        'obox-input',
        'obox-select',
        'obox-btn',
        'obox-radio-card'
      ],
      'ext-manager': ['obox-card', 'obox-btn', 'obox-tag', 'obox-desc']
    }
    for (const [name, classes] of Object.entries(expected)) {
      // 静态骨架写在 index.html、动态节点写在 page.js，两边合起来看
      const src =
        readFileSync(`${root}${name}/page.js`, 'utf8') +
        readFileSync(`${root}${name}/index.html`, 'utf8')
      for (const cls of classes) {
        expect(src, `${name} 未使用 ${cls}`).toContain(cls)
      }
    }
  })

  it('三页 page.css 不再定义按钮/输入/下拉的通用外观（只留布局与专有样式）', () => {
    for (const name of ['app', 'settings', 'ext-manager']) {
      const css = readFileSync(`${root}${name}/page.css`, 'utf8')
      const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
      // 旧的通用组件类名（迁移前每页各写一份）
      for (const legacy of [
        '.btn ',
        '.btn{',
        '.btn,',
        '.text ',
        '.textarea ',
        'select,',
        'select:focus'
      ]) {
        expect(code, `${name}/page.css 仍在定义 ${legacy}`).not.toContain(legacy)
      }
      // 也不应再写裸元素选择器去改通用外观
      expect(code, `${name}/page.css 有裸 select 规则`).not.toMatch(/^select\s*\{/m)
      expect(code, `${name}/page.css 有裸 button 规则`).not.toMatch(/^button\s*\{/m)
      expect(code, `${name}/page.css 有裸 input 规则`).not.toMatch(/^input\s*\{/m)
    }
  })

  /**
   * 回归（真机踩到）：`dev`/`start` 只跑 `electron-vite`，不重建 `.extensions/`，于是开发态
   * 一直加载**上一次构建**的系统扩展页——改了 `system-extensions/` 却"怎么都不生效"。
   * 现在两个脚本都先跑 `build:extensions`；这条用例防止有人把前缀去掉。
   */
  it('dev / start 脚本先构建系统扩展（否则 dev 读 .extensions 旧产物）', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    ) as { scripts: Record<string, string> }
    expect(pkg.scripts.dev).toContain('build:extensions')
    expect(pkg.scripts.start).toContain('build:extensions')
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
