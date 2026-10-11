/**
 * SettingsView.vue 左树的接线门禁（读源文件断言关键接线）。
 *
 * 为什么读源文件而不是挂载组件：仓库 vitest 是 `environment: 'node'`，没有 jsdom / @vue/test-utils
 * （先例：test/app-window-wiring.test.ts 读 AppWindow.vue 源码断言接线）。这里钉住两件事——
 * 1) 每个 `tree-node` 都接了 `@click`：issue #80 就是「扩展」节点漏了 `@click`，而 `active` 初值为
 *    `'appearance'` 且全代码没有别处把它置为 `'extension'` → 该分区（含扩展列表）永远不显示；
 * 2) 点「扩展」节点回到**列表态**：同时清 `activeExt`，否则右侧仍停在上次打开的扩展页上。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 去掉块注释、HTML 注释与行注释，避免文档里的示例字符串把断言喂成假绿 */
function source(): string {
  const path = fileURLToPath(
    new URL('../src/renderer/src/extensions/settings/SettingsView.vue', import.meta.url)
  )
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('SettingsView.vue · 左树节点接线', () => {
  it('每个 tree-node 都绑定了 @click（漏一个就有一个分区点不进去）', () => {
    const src = source()
    const nodes = src.match(/class="tree-node[^"]*"[\s\S]*?>/g) ?? []
    // 外观/通用/语言/快捷键/更新/网络/通知/扩展 + 扩展列表子项（≥1）
    expect(nodes.length).toBeGreaterThanOrEqual(8)
    for (const node of nodes) {
      expect(node).toContain('@click=')
    }
  })

  it('「扩展」节点接了 selectExtensions，且该处理函数回到列表态（清 activeExt）', () => {
    const src = source()
    // 该节点的 :class 里同时有扩展分区与 activeExt 两个判据
    const node = /<div[^>]*class="tree-node"[^>]*activeExt[^>]*>/.exec(src)?.[0] ?? ''
    expect(node).toContain('@click="selectExtensions()"')
    // 高亮判据：选中子项时父节点不高亮
    expect(node).toContain("active === 'extension' && !activeExt")

    const body = /function selectExtensions\(\)[\s\S]*?\n}/.exec(src)?.[0] ?? ''
    expect(body).not.toBe('')
    expect(body).toContain("active.value = 'extension'")
    expect(body).toContain('activeExt.value = null')
  })

  it('扩展分区与列表态分支仍存在（入口补上后确实可达、不留空态）', () => {
    const src = source()
    expect(src).toContain(`v-if="active === 'extension'" class="tree-children"`)
    expect(src).toContain('settings.extensionsSection.select')
  })
})
