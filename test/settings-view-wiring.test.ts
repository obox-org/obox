/**
 * SettingsView.vue 左树的接线门禁（读源文件断言关键接线）。
 *
 * 为什么读源文件而不是挂载组件：仓库 vitest 是 `environment: 'node'`，没有 jsdom / @vue/test-utils
 * （先例：test/app-window-wiring.test.ts 读 AppWindow.vue 源码断言接线）。这里钉住三件事——
 * 1) 每个 `tree-node` 都接了 `@click`：issue #80 就是「扩展」节点漏了 `@click`，而 `active` 初值为
 *    `'appearance'` 且全代码没有别处把它置为 `'extension'` → 该分区（含扩展列表）永远不显示；
 * 2) 点「扩展」节点回到**列表态**：同时清 `activeExt`，否则右侧仍停在上次打开的扩展页上；
 * 3) 改键捕获（issue #85）：捕获框必须**真的获焦**（覆盖层是 `v-if` 出来的，不 `nextTick` + `focus()`
 *    就永远收不到 keydown），且捕获态要经 `keybindingStore.setCapturing` 让**全局**处理器让路。
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

/** App.vue 源码（同样去掉注释） */
function appSource(): string {
  const path = fileURLToPath(new URL('../src/renderer/src/App.vue', import.meta.url))
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

/**
 * 改键捕获的接线门禁（issue #85 缺陷 3）。仓库无法挂载 .vue（node 环境、无 @vue/test-utils），
 * 所以这里钉"接线存在"，运行时行为由 test/keybindings.test.ts 的捕获态守卫用例覆盖。
 */
describe('SettingsView.vue · 改键捕获接线（issue #85）', () => {
  it('覆盖层是 v-if 出来的：startCapture 必须 await nextTick 后 focus 捕获框', () => {
    const src = source()
    const body = /async function startCapture\(command: string\)[\s\S]*?\n}/.exec(src)?.[0] ?? ''
    expect(body).not.toBe('')
    expect(body).toContain('await nextTick()')
    expect(body).toContain('captureBox.value?.focus()')
    // 捕获态要经 store 暴露给全局处理器，不能只在组件内部挡
    expect(body).toContain('keybindingStore.setCapturing(true)')
  })

  it('捕获框绑定了 ref 与 @keydown（元素拿不到则 focus 无效）', () => {
    const src = source()
    const box = /<div[\s\S]*?class="capture-box"[\s\S]*?>/.exec(src)?.[0] ?? ''
    expect(box).not.toBe('')
    expect(box).toContain('ref="captureBox"')
    expect(box).toContain('@keydown="onCaptureKeydown"')
    expect(box).toContain('tabindex="0"')
  })

  it('退出捕获统一走 cancelCapture（Esc / 取消按钮 / 改键成功 / 卸载），不会把守卫卡住', () => {
    const src = source()
    const body = /function cancelCapture\(\)[\s\S]*?\n}/.exec(src)?.[0] ?? ''
    expect(body).toContain('capturing.value = null')
    expect(body).toContain('keybindingStore.setCapturing(false)')
    // 取消按钮与覆盖层点击都走同一个出口，不允许直接写 capturing = null
    expect(src).not.toContain('@click="capturing = null"')
    expect(src).toContain('@click="cancelCapture"')
    // 卸载时释放守卫
    const unmount = /onUnmounted\(\(\) => \{[\s\S]*?\}\)/.exec(src)?.[0] ?? ''
    expect(unmount).toContain('keybindingStore.setCapturing(false)')
  })

  it('网络/通用分区不再是"一次性快照"：订阅设置变更并同步', () => {
    const src = source()
    expect(src).toContain('stateStore.onSettingsChanged')
    expect(src).toContain('syncProxyFromStore')
    // 代理表单改为 reactive（不再是 ref 快照 + 手工 .value 解包）
    expect(src).toContain('reactive<ProxyConfig>(readProxyConfig())')
  })

  it('快捷键表格依赖设置变更计数（改完键立刻显示新按键，不会停在旧值）', () => {
    const src = source()
    const body = /const keybindings = computed\(\(\) => \{[\s\S]*?\}\)/.exec(src)?.[0] ?? ''
    expect(body).not.toBe('')
    // 实测复现（issue #85 复核）：只依赖 keybindingStore.entries 时，"改键写盘"不会让
    // computed 重算 → 表格仍显示旧按键，必须再依赖设置变更计数
    expect(body).toContain('settingsRevision.value')
    expect(body).toContain('keybindingStore.list()')
  })

  it('App.vue 的全局 keydown 处理器在读捕获态时早退（捕获期间快捷键不触发）', () => {
    const src = appSource()
    const handler = /function onGlobalKeydown\(e: KeyboardEvent\)[\s\S]*?\n}/.exec(src)?.[0] ?? ''
    expect(handler).not.toBe('')
    expect(handler).toContain('keybindingStore.isCapturing')
    // 早退必须在 matchKeydown 之前（否则命令已经被执行了）
    expect(handler.indexOf('isCapturing')).toBeLessThan(handler.indexOf('matchKeydown'))
  })
})
