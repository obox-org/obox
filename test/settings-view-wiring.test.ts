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

/** 折叠空白：prettier 会把长属性换行，"这段接线是否存在"的断言不该被换行喂成假红 */
function flatten(src: string): string {
  return src.replace(/\s+/g, ' ')
}

/** 扩展设置字段渲染链的**末尾兜底 `v-else`**（独立成行的那种；`v-else-if` / 行内 `v-else class=` 不算） */
function fallbackVElse(src: string): RegExpMatchArray | null {
  const all = [...src.matchAll(/^[ \t]*v-else[ \t]*$/gm)]
  return all.length > 0 ? all[all.length - 1] : null
}

/** 扩展设置字段渲染链中 `directory` 那一段（到链尾兜底 `v-else` 之前为止） */
function directoryBlock(src: string): string {
  const start = src.indexOf("field.type === 'directory'")
  if (start < 0) return ''
  const end = fallbackVElse(src)
  return end && end.index !== undefined && end.index > start
    ? src.slice(start, end.index)
    : src.slice(start)
}

/** 扩展设置字段渲染链中 `status` 那一段（到链尾兜底分支的**标签起点**为止） */
function statusBlock(src: string): string {
  const start = src.indexOf("field.type === 'status'")
  if (start < 0) return ''
  const end = fallbackVElse(src)
  if (!end || end.index === undefined || end.index <= start) return src.slice(start)
  // 兜底的 `v-else` 写在 `<input … />` 标签**内部**：往回找该标签的 `<`，把兜底整段排除，
  // 否则"status 不含 input"这类断言会被兜底标签喂成假红
  const tagStart = src.lastIndexOf('<', end.index)
  return src.slice(start, tagStart > start ? tagStart : end.index)
}

/** 语言包源码（去注释；用于钉 `status` 空值占位文案的词条真的存在，而不是渲染出裸 key） */
function localeSource(file: 'zh' | 'en'): string {
  const path = fileURLToPath(
    new URL(`../src/renderer/src/i18n/locales/${file}.ts`, import.meta.url)
  )
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 链尾兜底分支（未知类型 → text）的源码片段：从 `v-else` 到该 `<input … />` 结束 */
function fallbackBlock(src: string): string {
  const last = fallbackVElse(src)
  if (!last || last.index === undefined) return ''
  const end = src.indexOf('/>', last.index)
  return end < 0 ? src.slice(last.index) : src.slice(last.index, end + 2)
}

/** `browseDirectory` 的函数体源码（`\n}` 锚定函数末尾的顶格花括号） */
function browseDirectoryBody(src: string): string {
  return /async function browseDirectory\([\s\S]*?\n}/.exec(src)?.[0] ?? ''
}

/**
 * 等待模态框那一段模板：从遮罩那个 `<div` 起、到 `</template>` 止（模态是模板里的**最后一个**
 * 节点，正是"不在字段链内"的形状）。取到 `</template>` 保证断言范围不越过模板边界。
 */
function modalBlock(src: string): string {
  const at = src.indexOf('class="settings-modal-overlay"')
  if (at < 0) return ''
  const tagStart = src.lastIndexOf('<', at)
  const end = src.indexOf('</template>', at)
  return src.slice(tagStart > 0 ? tagStart : at, end < 0 ? src.length : end)
}

/** 共享类型源码（**不**去注释：要断言注释里写明"只对 status 有意义 / 老宿主忽略"的降级语义） */
function apiSourceRaw(): string {
  return readFileSync(
    fileURLToPath(new URL('../src/api/contributions.ts', import.meta.url)),
    'utf8'
  )
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

  it('directory 字段渲染出**只读**文本框 +「浏览…」按钮，点输入框或按钮都弹目录选择器', () => {
    const src = source()
    // 折叠空白后再断言：prettier 会把长属性换行，换行不该让这条门禁假红
    const block = flatten(directoryBlock(src))
    expect(block).not.toBe('')
    // 文本框（沿用 text 的 class 与 @change 保存通路）
    expect(block).toContain('class="text-input"')
    expect(block).toContain(
      `onFieldChange(page, field.key, ($event.target as HTMLInputElement).value)`
    )
    // 值取数与 text 同一条响应式取值路径（首屏显示持久化值，而不是 field.default）
    expect(block).toContain(
      `(fieldValue(page, field.key) as string) ?? (field.default as string) ?? ''`
    )
    // 用户裁定：**点输入框即弹框** ⇒ 输入框 readonly + @click（值只能由目录选择器写入）
    const inputTag = /<input[\s\S]*?\/>/.exec(block)?.[0] ?? ''
    expect(inputTag).toContain('class="text-input"')
    expect(inputTag).toContain('readonly')
    expect(inputTag).toMatch(/@click="\s*browseDirectory\(page, field\)\s*"/)
    // 「浏览…」按钮保留（键盘可达性，用户裁定允许冗余）：输入框 + 按钮共 2 个入口，都走 browseDirectory
    expect(block).toContain('class="btn"')
    expect(block).toContain(`t('settings.extensionsSection.browse')`)
    expect(block.match(/@click="\s*browseDirectory\(page, field\)\s*"/g) ?? []).toHaveLength(2)
  })

  it('browseDirectory 弹的是目录选择器（openDirectory），不是文件选择器', () => {
    const src = source()
    const body = flatten(browseDirectoryBody(src))
    expect(body).not.toBe('')
    expect(body).toContain('window.api.dialogOpen(')
    expect(body).toContain(`properties: ['openDirectory']`)
    expect(body).not.toContain('openFile')
  })

  it('取消（canceled）不改动设置项：早退必须在写值之前', () => {
    const src = source()
    const body = flatten(browseDirectoryBody(src))
    const cancelAt = body.indexOf('result.canceled')
    const writeAt = body.indexOf('onFieldChange(')
    expect(cancelAt).toBeGreaterThan(-1)
    expect(writeAt).toBeGreaterThan(-1)
    // 顺序即语义：`if (result.canceled) return` 必须在唯一的写值点之前
    expect(cancelAt).toBeLessThan(writeAt)
    // 写值点只有一个（取消分支不会漏写/多写）
    expect(body.match(/onFieldChange\(/g) ?? []).toHaveLength(1)
    // 取消分支内不得把空串写进设置
    expect(/canceled[\s\S]{0,80}onFieldChange\(/.test(body)).toBe(false)
  })

  it('ok:false（含老宿主不支持/后端异常）不能静默：有可见错误 + console.error', () => {
    const src = source()
    const body = flatten(browseDirectoryBody(src))
    expect(body).toContain('!result.ok')
    expect(body).toContain('console.error')
    expect(body).toContain('directoryErrors.value')
    // 错误经模板渲染成可见提示（.config-error），不是只写控制台
    expect(flatten(src)).toContain(`directoryErrors[fieldSlot(page, field.key)]`)
    expect(flatten(src)).toContain('class="config-error"')
  })

  it('未知字段类型回落成文本框（末尾 v-else）+ console.warn，不会让设置项凭空消失', () => {
    const src = source()
    const raw = fallbackBlock(src)
    const block = flatten(raw)
    expect(block).not.toBe('')
    expect(block).toContain('v-else')
    expect(block).toContain('class="text-input"')
    expect(block).toContain('unknownTypeValue(page, field)')
    // 兜底分支同样走 text 的保存通路（可编辑、可保存）
    expect(block).toContain(
      `onFieldChange(page, field.key, ($event.target as HTMLInputElement).value)`
    )
    // 兜底是链尾：它之后不得再出现 v-else-if（否则"未知类型"会被后面的分支截走）
    const tail = src.slice(src.indexOf(raw) + raw.length)
    expect(tail).not.toBe('')
    expect(tail).not.toContain('v-else-if')

    const helper = flatten(/function unknownTypeValue\([\s\S]*?\n}/.exec(src)?.[0] ?? '')
    expect(helper).not.toBe('')
    expect(helper).toContain('console.warn')
    // 警告按字段去重（渲染期调用，不能每次渲染都刷屏）
    expect(helper).toContain('warnedUnknownFieldTypes')
    expect(helper).toContain('fieldValue(page, field.key)')
  })

  it('status 字段渲染为只读状态展示：无输入框、无按钮、无任何写值通路', () => {
    const src = source()
    const raw = statusBlock(src)
    const block = flatten(raw)
    expect(block).not.toBe('')
    expect(block).toContain(`field.type === 'status'`)
    // 只读 = 链上不得出现任何可编辑控件，也不得接上写值通路（onFieldChange / @change）
    expect(block).not.toContain('<input')
    expect(block).not.toContain('<button')
    expect(block).not.toContain('<select')
    expect(block).not.toContain('<textarea')
    expect(block).not.toContain('@click')
    expect(block).not.toContain('@change')
    expect(block).not.toContain('onFieldChange')
    expect(block).not.toContain('text-input')
    // 只读文本沿用既有 .config-value（配色/等宽字体由既有 token 决定，不自造色值）
    expect(block).toContain('class="config-value status-value"')
    // 模板取值只能走 statusLines（与下文"同源"用例一起钉住）
    expect(block).toContain('statusLines(page, field)')
  })

  it('status 字段多行按行渲染成列表，单行走一行文本（不是原样塞一段多行字符串）', () => {
    const src = source()
    const block = flatten(statusBlock(src))
    // 多行分支：含 \n 的值 → <ul class="status-lines"> + v-for 逐行 <li>
    expect(block).toMatch(/v-if="\s*statusLines\(page, field\)\.length > 1\s*"/)
    expect(block).toContain('<ul')
    expect(block).toContain('class="status-lines"')
    expect(block).toMatch(/v-for="\(line, idx\) in statusLines\(page, field\)"/)
    expect(block).toContain('<li')
    // 单行分支仍取同一个函数的值（不是另取一份/另一处存储）
    expect(block).toMatch(/<span v-else>\{\{ statusLines\(page, field\)\[0\] \}\}<\/span>/)
  })

  it('status 的取值与 text 同源（fieldValue）+ 换行拆行 + 空值占位', () => {
    const src = source()
    const helper = flatten(/function statusLines\([\s\S]*?\n}/.exec(src)?.[0] ?? '')
    expect(helper).not.toBe('')
    // 与其它字段同一条响应式取值路径：扩展写键 → settingsRevision++ → 渲染期重读
    expect(helper).toContain('fieldValue(page, field.key)')
    expect(helper).not.toContain('stateStore.getSetting') // 不许绕过 fieldValue 直读
    // 多行语义：CRLF 归一 + 按 \n 拆行
    expect(helper).toContain('replace(/\\r\\n?/g') // 源码里的正则字面量
    expect(helper).toContain(`split('\\n')`)
    // 空值 / 全空白 → 占位文案（字段下方不能一片空白看不出状态）
    expect(helper).toContain('settings.extensionsSection.noValue')
  })

  it('status 空值占位词条在 zh/en 两份语言包里都存在（否则渲染出裸 key）', () => {
    for (const file of ['zh', 'en'] as const) {
      expect(localeSource(file)).toContain('noValue:')
    }
  })

  it('status 分支位于 directory 之后、链尾兜底 v-else 之前（不回退既有分支）', () => {
    const src = source()
    const directoryAt = src.indexOf(`field.type === 'directory'`)
    const statusAt = src.indexOf(`field.type === 'status'`)
    const fallback = fallbackVElse(src)
    expect(directoryAt).toBeGreaterThan(-1)
    expect(statusAt).toBeGreaterThan(directoryAt)
    expect(fallback?.index ?? -1).toBeGreaterThan(statusAt)
    // 兜底仍是链尾、且仍是可编辑文本框（新分支不得挤掉未知类型的回落）
    const tail = src.slice((fallback?.index ?? 0) + 1)
    expect(tail).not.toContain('v-else-if')
    expect(flatten(fallbackBlock(src))).toContain('class="text-input"')
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

/**
 * modal 字段（等待模态框）的接线门禁：字段声明 `modal: true`（配 `type: 'status'`）后，
 * 宿主在设置页渲染一个**不可关闭**的进度模态框——值由扩展经 `api.settings.set` 写入，
 * 任务结束时写空串 ⇒ 模态框消失。仓库无法挂载 .vue（node 环境、无 @vue/test-utils），
 * 所以这里钉三件事：**渲染接线存在**、**关闭通路不存在**、**字段链没被新节点打断**。
 */
describe('SettingsView.vue · modal 字段（等待模态框）', () => {
  it('modal:true 且值非空 ⇒ 渲染全屏遮罩 + 对话框，label 与多行进度都在模态里', () => {
    const src = source()
    const block = flatten(modalBlock(src))
    expect(block).not.toBe('')
    // 门：只有 activeModal 非空才渲染；值为空 ⇒ 这一整块被 v-if 卸载（什么都不渲染）
    expect(block).toContain('v-if="activeModal"')
    expect(block).toContain('class="settings-modal-overlay"')
    // 无障碍语义：对话框 + aria-modal（遮罩在语义与指针事件上都"挡住背景"）
    expect(block).toContain('role="dialog"')
    expect(block).toContain('aria-modal="true"')
    // 字段 label 与多行值
    expect(block).toContain('activeModal.label')
    expect(block).toContain('activeModal.lines.length > 1')
    expect(block).toContain('v-for="(line, idx) in activeModal.lines"')
    expect(block).toContain('<li')
    // 单行也要有落点（不能只处理多行；行文本来自 statusLines）
    expect(block).toContain('activeModal.lines[0]')
  })

  it('modal 的值取自设置存储（复用 statusLines 拆分），空值/全空白 ⇒ 不渲染任何东西', () => {
    const src = source()
    // 显示判据：只取设置值、去空白后非空；**不**回退 field.default
    const gate = flatten(/function statusHasValue\([\s\S]*?\n}/.exec(src)?.[0] ?? '')
    expect(gate).not.toBe('')
    expect(gate).toContain('fieldValue(page, field.key)')
    expect(gate).toContain('raw === undefined || raw === null')
    expect(gate).toContain("trim() !== ''")
    expect(gate).not.toContain('field.default')
    // 扫**所有**已注册设置页（只在当前选中页扫 ⇒ 切左树节点就能"关掉"模态框），
    // 命中才返回内容、否则 null
    const modal = flatten(
      /const activeModal = computed<WaitModal \| null>\([\s\S]*?\n\}\)/.exec(src)?.[0] ?? ''
    )
    expect(modal).not.toBe('')
    expect(modal).toContain('extensionPages.value')
    expect(modal).toContain('statusHasValue(page, field)')
    expect(modal).toContain('statusLines(page, field)')
    expect(modal).toContain('return null')
    // 只对 status 字段生效（别的类型即使误写 modal:true 也不弹）
    const typeGate = flatten(/function isModalField\([\s\S]*?\n}/.exec(src)?.[0] ?? '')
    expect(typeGate).toContain('field.modal === true')
    expect(typeGate).toContain('field.type === MODAL_FIELD_TYPE')
  })

  it('模态框不可关闭：没有关闭按钮、没有 @click/@keydown（Esc 无效）、没有任何 dismiss 通路', () => {
    const src = source()
    const block = flatten(modalBlock(src))
    // 遮罩与对话框都不接事件 ⇒ 点遮罩/按 Esc 都不会触发任何"关闭"逻辑
    expect(block).not.toContain('@click')
    expect(block).not.toContain('@keydown')
    expect(block).not.toContain('@keyup')
    expect(block).not.toContain('Escape')
    // 模态里只有标题 + 进度行：没有按钮、没有取消/关闭文案
    expect(block).not.toContain('<button')
    expect(block).not.toContain('common.cancel')
    expect(block).not.toContain('dismiss')
    // 全源码里也不存在其它"关模态"出口（只有扩展清空值这一条路）
    expect(src).not.toContain('closeModal')
    expect(src).not.toContain('@keydown.esc')
    expect(src).not.toMatch(/activeModal\.value\s*=\s*null/)
    // 焦点约束：对话框可编程聚焦（tabindex="-1"），出现后显式 focus（不做完整 focus-trap）
    expect(block).toContain('tabindex="-1"')
    expect(block).toContain('ref="modalBox"')
    const watcher = flatten(/watch\(\s*activeModal,[\s\S]*?\n\)/.exec(src)?.[0] ?? '')
    expect(watcher).not.toBe('')
    expect(watcher).toContain('nextTick()')
    expect(watcher).toContain('modalBox.value?.focus()')
  })

  it('模态节点不在字段渲染链内：directory → status → 链尾兜底 v-else 仍相邻', () => {
    const src = source()
    const overlayAt = src.indexOf('class="settings-modal-overlay"')
    const fallback = fallbackVElse(src)
    expect(overlayAt).toBeGreaterThan(-1)
    expect(fallback?.index ?? -1).toBeGreaterThan(-1)
    // 模态在链尾兜底 `v-else` **之后**（视图根部的独立节点）：插进链中间会让后面的分支
    // 挂到它身上，非 status 字段就会多渲染一个兜底文本框并刷 console.warn
    expect(overlayAt).toBeGreaterThan(fallback?.index ?? -1)
    // 字段链那一段（directory → 兜底）里没有任何模态痕迹
    const chainStart = src.indexOf("field.type === 'directory'")
    const chain = src.slice(chainStart, fallback?.index ?? src.length)
    expect(chain).not.toContain('settings-modal')
    expect(chain).not.toContain('activeModal')
    // 链上分支仍**按序相邻**（text → number → boolean → select → directory → status）：
    // 中间若插进一个新分支节点，序列会多/少一项（链尾兜底是无谓词的裸 `v-else`，不在本序列里）
    const firstBranch = src.indexOf("field.type === 'text'")
    const chainRegion = src.slice(src.lastIndexOf('<', firstBranch), fallback?.index ?? src.length)
    const branches = [
      ...chainRegion.matchAll(/v-(?:if|else-if|else)="field\.type === '(\w+)'"/g)
    ].map((m) => m[1])
    expect(branches).toEqual(['text', 'number', 'boolean', 'select', 'directory', 'status'])
    // 相邻性：上一分支收尾到下一分支标签之间**不得**再出现任何分支指令——
    // 在链中间插一个带 `v-if` 的兄弟，它就会自立新链，后面的 `v-else-if` / `v-else` 全挂到它身上
    // （上一轮的事故：非 status 字段都多渲染一个兜底文本框并刷 console.warn）
    const dirClose = src.indexOf('</div>', src.indexOf("field.type === 'directory'"))
    const statusAt = src.indexOf("field.type === 'status'")
    expect(dirClose).toBeGreaterThan(-1)
    expect(src.slice(dirClose + '</div>'.length, src.lastIndexOf('<', statusAt))).not.toMatch(
      /v-(?:if|else-if|else)\b/
    )
    const statusClose = src.indexOf('</div>', statusAt)
    expect(statusClose).toBeGreaterThan(-1)
    expect(src.slice(statusClose + '</div>'.length, fallback?.index ?? src.length)).not.toMatch(
      /v-(?:if|else-if|else)\b/
    )
    // 兜底仍是**独立成行**的 `v-else`（模态里的 `v-else` 是行内属性，顶替不了它），
    // 且它之后不得再出现 v-else-if（否则"未知类型"会被后面的分支截走）
    expect(fallback?.[0].trim()).toBe('v-else')
    const afterFallback = src.slice((fallback?.index ?? 0) + (fallback?.[0].length ?? 0))
    expect(afterFallback).not.toContain('v-else-if')
  })

  it('modal 属性进了共享类型：只对 status 有意义、老宿主忽略（降级不崩）', () => {
    const api = apiSourceRaw()
    const at = api.indexOf('modal?: boolean')
    expect(at).toBeGreaterThan(-1)
    // 取该属性正上方的文档注释
    const doc = api.slice(api.lastIndexOf('/**', at), at)
    expect(doc).toContain("type: 'status'")
    expect(doc).toContain('不可关闭')
    expect(doc).toContain('api.settings.set')
    expect(doc).toContain('老宿主忽略它')
  })
})
