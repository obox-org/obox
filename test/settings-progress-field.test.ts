/**
 * 卡 04 · host-progress-field：设置页 `progress` 字段的全链门禁（渲染口径 / 字段链完整性 /
 * manifest 校验脚本 / 白名单差分）。
 *
 * 测试策略（为什么不是"挂载组件查 DOM"）：仓库 vitest 是 `environment: 'node'`，没有
 * jsdom / @vue/test-utils，也没有给 vitest 配 vue 插件（vitest.config.ts），**.vue 无法挂载**
 * ——先例：settings-view-wiring / settings-first-paint 都是"源码接线断言 + 行为模型"。
 * 本文件在该先例上多走一步：progress 的显示口径（钳制/取整/条宽/warn）是**从
 * SettingsView.vue 源码里原样提取真实实现**（progressMetrics / progressView / fieldValue /
 * fieldSlot / warnedProgressFields），经 typescript（devDependency，非新增依赖）转译后直接跑
 * ——测的就是组件用的同一段文本，不存在"测试里复制一份实现"的漂移。
 *
 * 断言分三层，编号对应任务卡验收项 ①-⑨：
 * 1) 接线层（读 .vue 源码）：① 只读渲染接线、② description 排除、⑦ 字段链完整；
 * 2) 行为层（跑提取的真实实现 + 真 stateStore + 真 vue 响应式）：③④⑤ 显示口径、⑥ 当帧刷新；
 * 3) 脚本层：⑧ validate-manifest.mjs（%TEMP% 临时 manifest 走 CLI；JSON 写不出的
 *    Infinity/NaN 夹具对象直喂导出的 validateManifest）、⑨ 白名单与宿主 SettingFieldType 差分。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { computed, ref, type Ref } from 'vue'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * localStorage 必须在 core/state 求值**之前**就位（快照在模块求值时读一次）；
 * 与 settings-first-paint.test.ts 同一做法。stubGlobal 先于下面的动态 import 执行。
 */
const storage: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage[k] ?? null,
  setItem: (k: string, v: string) => {
    storage[k] = v
  },
  removeItem: (k: string) => {
    delete storage[k]
  }
})
const { stateStore } = await import('../src/renderer/src/core/state')

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const settingsViewPath = join(
  repoRoot,
  'src',
  'renderer',
  'src',
  'extensions',
  'settings',
  'SettingsView.vue'
)
const scriptPath = join(repoRoot, 'scripts', 'validate-manifest.mjs')
const hostPath = join(repoRoot, 'src', 'renderer', 'src', 'core', 'host.ts')

// ---------------------------------------------------------------- 源码读取与字段链定位

/** 原始源码（含注释）：提取真实实现用 */
function rawSource(): string {
  return readFileSync(settingsViewPath, 'utf8')
}

/** 去注释源码（与 settings-view-wiring.test.ts 同形）：接线断言用，注释里的示例不喂假绿 */
function source(): string {
  return rawSource()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 折叠空白：prettier 换行不该让"接线是否存在"的断言假红 */
function flatten(src: string): string {
  return src.replace(/\s+/g, ' ')
}

/** 链尾兜底 `v-else`（独立成行；行内 `v-else …` 不算——与 wiring 门禁同一判据） */
function fallbackVElse(src: string): RegExpMatchArray | null {
  const all = [...src.matchAll(/^[ \t]*v-else[ \t]*$/gm)]
  return all.length > 0 ? all[all.length - 1] : null
}

/** 字段链区域：text 分支开标签的 `<` 起、到链尾兜底 `v-else` 止 */
function chainRegion(src: string): string {
  const first = src.indexOf("field.type === 'text'")
  expect(first).toBeGreaterThan(-1)
  const fallback = fallbackVElse(src)
  expect(fallback).not.toBeNull()
  const fallbackAt = fallback?.index ?? src.length
  expect(fallbackAt).toBeGreaterThan(first)
  return src.slice(src.lastIndexOf('<', first), fallbackAt)
}

/** progress 分支块：分支条件起、到 directory 分支开标签的 `<` 止（注释已剥 ⇒ 只含本分支标记） */
function progressBlock(src: string): string {
  const start = src.indexOf('field.type === PROGRESS_FIELD_TYPE')
  if (start < 0) return ''
  const dirAt = src.indexOf(`field.type === 'directory'`, start)
  expect(dirAt).toBeGreaterThan(start)
  return src.slice(start, src.lastIndexOf('<', dirAt))
}

// ---------------------------------------------------------------- 提取真实实现（行为层基座）

/** 从 .vue 源码提取一段顶层声明（找不到即红：实现被挪走/改名时必须同步本门禁） */
function extractDecl(src: string, pattern: RegExp): string {
  const m = pattern.exec(src)
  expect(m, `SettingsView.vue 源码中未找到声明：${pattern}`).not.toBeNull()
  return m ? m[0] : ''
}

/** progressMetrics 的输出契约（与组件内 interface ProgressMetrics 同形） */
interface ProgressMetrics {
  max: number
  numeric: boolean
  width: number
  now: number
  text: string
}

interface PageLike {
  id: string
}

interface FieldLike {
  key: string
  label?: string
  type?: string
  default?: unknown
  max?: number
}

interface ProgressRuntime {
  fieldValue(page: PageLike, key: string): unknown
  fieldSlot(page: PageLike, key: string): string
  warnedProgressFields: Set<string>
  progressMetrics(rawValue: unknown, declaredMax: unknown): ProgressMetrics
  progressView(page: PageLike, field: FieldLike): ProgressMetrics
}

/**
 * 把 SettingsView.vue 里 progress 用到的**真实声明**原样提取、经 typescript 转译成 JS 后装进
 * 一个注入环境（真 stateStore + 调用方给的 settingsRevision ref + warn 收集器）。
 * 每次调用得到**全新**的 warnedProgressFields（与组件模块级单例同形，但用例间互不串味）。
 */
function loadProgressRuntime(options: {
  settingsRevision: Ref<number>
  warns: string[]
}): ProgressRuntime {
  const src = rawSource()
  const decls = [
    extractDecl(src, /function fieldValue\([\s\S]*?\n}/),
    extractDecl(src, /function fieldSlot\([\s\S]*?\n}/),
    extractDecl(src, /const warnedProgressFields = new Set<string>\(\)/),
    extractDecl(src, /function progressMetrics\([\s\S]*?\n}/),
    extractDecl(src, /function progressView\([\s\S]*?\n}/)
  ]
  const js = ts.transpileModule(decls.join('\n\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  // 注入 stateStore / settingsRevision（fieldValue 的两个自由变量）与 console.warn 收集器；
  // `const console = …` 在函数作用域里遮蔽全局 console，progressView 的 warn 全部进收集器
  const factory = new Function(
    'stateStore',
    'settingsRevision',
    'collectWarn',
    `const console = { warn: collectWarn };\n${js}\nreturn { fieldValue, fieldSlot, warnedProgressFields, progressMetrics, progressView };`
  ) as (
    store: unknown,
    revision: Ref<number>,
    collectWarn: (message: string) => void
  ) => ProgressRuntime
  return factory(stateStore, options.settingsRevision, (message) => options.warns.push(message))
}

/** 每次装载一套全新运行时（独立 revision + 独立 warn 收集） */
function freshRuntime(): {
  runtime: ProgressRuntime
  warns: string[]
  settingsRevision: Ref<number>
} {
  const warns: string[] = []
  const settingsRevision = ref(0)
  return { runtime: loadProgressRuntime({ settingsRevision, warns }), warns, settingsRevision }
}

const page: PageLike = { id: 'demo.page' }

/** 造一个 progress 字段声明 */
function progressField(key: string, extra?: Partial<FieldLike>): FieldLike {
  return { key, label: '进度', type: 'progress', ...extra }
}

afterAll(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------- ① 只读渲染接线

describe('① progress 渲染接线：条 + {cur}/{max} 文本，零可编辑控件', () => {
  it('progress 是字段链上的 v-else-if 分支，且位于链尾兜底 v-else 之前', () => {
    const src = source()
    const start = src.indexOf('field.type === PROGRESS_FIELD_TYPE')
    expect(start).toBeGreaterThan(-1)
    // 分支指令必须是 v-else-if（链上分支；独立 v-if 会自立新链、把后面的分支全部挂歪）
    const tagStart = src.lastIndexOf('<', start)
    expect(src.slice(tagStart, start)).toContain('v-else-if=')
    // 必须在兜底之前：落到兜底 v-else 就渲染成可编辑文本框（unknownTypeValue），
    // 用户误编辑即覆盖扩展写的数值——这正是"三分支变三个可编辑框"的事故形态
    const fallback = fallbackVElse(src)
    expect(fallback).not.toBeNull()
    expect(fallback?.index ?? -1).toBeGreaterThan(start)
    // 常量确实是 'progress'（类型判断走常量是与 MODAL_FIELD_TYPE 相同的既有约定）
    const decl = extractDecl(rawSource(), /const PROGRESS_FIELD_TYPE[^\n]*\n/)
    expect(decl).toContain("'progress'")
  })

  it('分支内只有只读条与文本（track/fill/text + progressbar 语义），无任何可编辑控件与写值通路', () => {
    const block = flatten(progressBlock(source()))
    expect(block).not.toBe('')
    // 条 = 槽 + 填充；填充宽度绑定 progressView(...).width（未取整比例），文本绑定 .text
    expect(block).toContain('class="progress-track"')
    expect(block).toContain('class="progress-fill"')
    expect(block).toContain('role="progressbar"')
    expect(block).toContain('progressView(page, field).width')
    expect(block).toContain("+ '%'")
    expect(block).toContain('{{ progressView(page, field).text }}')
    // 无障碍：当前值/上限也走同一函数（aria 与可见文本不会各说各话）
    expect(block).toContain('aria-valuemax="progressView(page, field).max"')
    expect(block).toContain('aria-valuenow="progressView(page, field).now"')
    // 只读 = 零可编辑控件、零写值通路（与 status 分支同一套判据）
    expect(block).not.toContain('<input')
    expect(block).not.toContain('<select')
    expect(block).not.toContain('<button')
    expect(block).not.toContain('<textarea')
    expect(block).not.toContain('@change')
    expect(block).not.toContain('@click')
    expect(block).not.toContain('onFieldChange')
    expect(block).not.toContain('text-input')
    // 样式全走主题 token（宿主内置页面不得写死色值/新增 token；fallback 是文档默认值）
    const style = flatten(rawSource())
    expect(style).toContain('.config-row .progress-track')
    expect(style).toContain('var(--bg-input')
    expect(style).toContain('.config-row .progress-fill')
    expect(style).toContain('var(--accent')
    // 标签沿用既有 .config-row label（块级、左对齐）——分支内不另造 label/布局
    expect(block).not.toContain('<label')
  })
})

// ---------------------------------------------------------------- ② description 不渲染

describe('② description 即使声明也不显示（spec Requirement 2 的 MUST NOT）', () => {
  it('description <p> 的 v-if 排除 progress 类型，且 progress 分支内没有 description 节点', () => {
    const src = flatten(source())
    // 字段行的 description 是链外唯一的 <p v-if="field.description …">：条件必须排除 progress
    // （prettier 可能把属性折行，折叠空白后 `>` 前允许有空格）
    expect(src).toMatch(
      /<p v-if="field\.description && field\.type !== PROGRESS_FIELD_TYPE" class="config-desc"\s*>/
    )
    // progress 分支块内也不得自带 description 渲染（不能"上面排除了、下面又画回来"）
    expect(progressBlock(source())).not.toContain('description')
  })

  it('行为面：progressView 的输出只有显示口径字段，不携带 description', () => {
    const { runtime } = freshRuntime()
    stateStore.setSetting('demo.p.nodesc', 40)
    const metrics = runtime.progressView(page, progressField('demo.p.nodesc'))
    expect(Object.keys(metrics).sort()).toEqual(['max', 'now', 'numeric', 'text', 'width'])
  })
})

// ---------------------------------------------------------------- ③④⑤ 显示口径（真实实现）

describe('③ 取整口径：{cur} 向下取整、条宽用未取整比例', () => {
  it('cur=99.9 ⇒ 文本 99/100，条宽 99.9%（不取整——条与数字不得互相矛盾）', () => {
    const { runtime, warns } = freshRuntime()
    stateStore.setSetting('demo.p.floor', 99.9)
    const m = runtime.progressView(page, progressField('demo.p.floor'))
    expect(m.text).toBe('99/100')
    expect(m.now).toBe(99)
    // 条宽若也取整（99%）会与"接近满格"的数字对不上——spec 明确用未取整真实比例
    expect(m.width).toBeCloseTo(99.9, 10)
    expect(warns).toEqual([])
    // 纯函数口径一致（模板绑定的 width 字段就是它算出来的）
    expect(runtime.progressMetrics(99.9, 100).width).toBeCloseTo(99.9, 10)
    expect(runtime.progressMetrics(99.9, 100).text).toBe('99/100')
  })
})

describe('④ 钳制与自定义 max', () => {
  it('cur 越界：-5 ⇒ 0/100 条宽 0%；180 ⇒ 100/100 条宽 100%（钳到 [0,100]）', () => {
    const { runtime, warns } = freshRuntime()
    stateStore.setSetting('demo.p.neg', -5)
    stateStore.setSetting('demo.p.over', 180)
    const low = runtime.progressView(page, progressField('demo.p.neg'))
    const high = runtime.progressView(page, progressField('demo.p.over'))
    expect(low.text).toBe('0/100')
    expect(low.width).toBe(0)
    expect(high.text).toBe('100/100')
    expect(high.width).toBe(100)
    // 越界是"钳制"不是"非法值"：不 warn（与 design 口径一致——越界不报错）
    expect(warns).toEqual([])
  })

  it('max=50：文本 {cur}/50、条宽按 /50 算（25 ⇒ 50%；60 ⇒ 钳到 50/50、100%）', () => {
    const { runtime } = freshRuntime()
    stateStore.setSetting('demo.p.max50', 25)
    stateStore.setSetting('demo.p.max50over', 60)
    const half = runtime.progressView(page, progressField('demo.p.max50', { max: 50 }))
    const over = runtime.progressView(page, progressField('demo.p.max50over', { max: 50 }))
    expect(half.text).toBe('25/50')
    expect(half.width).toBeCloseTo(50, 10)
    expect(over.text).toBe('50/50')
    expect(over.width).toBe(100)
  })

  it('max 缺省 100；max 声明非法（0/-5/字符串/NaN/Infinity）⇒ 运行期回落 100（脚本层另行拦 error）', () => {
    const { runtime } = freshRuntime()
    stateStore.setSetting('demo.p.defmax', 30)
    expect(runtime.progressView(page, progressField('demo.p.defmax')).text).toBe('30/100')
    // manifest 校验本该拒绝这些 max（见 ⑧）；渲染层仍自保：回落 100，不崩、不出负宽/Infinity 宽
    for (const bad of [0, -5, '100', NaN, Infinity]) {
      const m = runtime.progressMetrics(30, bad)
      expect(m.max).toBe(100)
      expect(m.text).toBe('30/100')
      expect(m.width).toBeCloseTo(30, 10)
    }
  })
})

describe('⑤ 非数字值：按 0 渲染 + 恰好一条 warn，不崩', () => {
  it("'abc' / null / undefined / NaN / 布尔 / 对象 / Infinity ⇒ 0/100、条宽 0、numeric=false + warn", () => {
    const { runtime, warns } = freshRuntime()
    const cases: Array<[string, unknown]> = [
      ['demo.p.str', 'abc'],
      ['demo.p.null', null],
      ['demo.p.nan', NaN],
      ['demo.p.bool', true],
      ['demo.p.obj', { v: 1 }],
      ['demo.p.inf', Infinity]
    ]
    for (const [key, value] of cases) {
      stateStore.setSetting(key, value)
    }
    // demo.p.miss：不写值、字段也没有 default ⇒ raw = undefined
    for (const [key, value] of [...cases, ['demo.p.miss', undefined] as [string, unknown]]) {
      const m = runtime.progressView(page, progressField(key))
      expect(m.numeric, `${String(value)} 应判非数字`).toBe(false)
      expect(m.text, `${String(value)} 应渲染 0/100`).toBe('0/100')
      expect(m.width).toBe(0)
      expect(m.now).toBe(0)
    }
    // 每个槽位恰好一条 warn（去重：渲染期反复求值不得刷屏），且文案指向上键与修法
    expect(warns).toHaveLength(7)
    for (const w of warns) {
      expect(w).toContain('progress 字段')
      expect(w).toContain('不是有限数字')
      expect(w).toContain('已按 0 渲染')
    }
    // 同一字段重复求值不再追加 warn
    runtime.progressView(page, progressField('demo.p.str'))
    expect(warns).toHaveLength(7)
  })

  it('无值但声明了数字 default ⇒ 回退 default 展示且不 warn（default 是合法回退，不是坏值）', () => {
    const { runtime, warns } = freshRuntime()
    const m = runtime.progressView(page, progressField('demo.p.default', { default: 42 }))
    expect(m.text).toBe('42/100')
    expect(m.numeric).toBe(true)
    expect(warns).toEqual([])
  })
})

// ---------------------------------------------------------------- ⑥ 写后当帧刷新

describe('⑥ 扩展写值后设置页当帧刷新（不需要重进页面）', () => {
  it('setSetting（= api.settings.set）同步通知 ⇒ settingsRevision++ ⇒ 同一 computed 立即出新值', () => {
    const { runtime, settingsRevision } = freshRuntime()
    // 组件 onMounted 的同款订阅（SettingsView.vue：stateStore.onSettingsChanged → revision++）
    const off = stateStore.onSettingsChanged(() => {
      settingsRevision.value++
    })
    try {
      stateStore.setSetting('demo.p.live', 42)
      // "已打开的设置页" = 同一个 computed 实例（组件渲染效应的最小等价模型），不重新装载
      const text = computed(() => runtime.progressView(page, progressField('demo.p.live')).text)
      const width = computed(() => runtime.progressView(page, progressField('demo.p.live')).width)
      expect(text.value).toBe('42/100')
      // 扩展侧写值：api.settings.set = stateStore.setSetting（core/host.ts，见下方源码断言）
      stateStore.setSetting('demo.p.live', 57.8)
      // 当帧即新值：不重进页面、不重挂载、不手工通知
      expect(text.value).toBe('57/100')
      expect(width.value).toBeCloseTo(57.8, 10)
    } finally {
      off()
    }
  })

  it('机制接线（源码）：api.settings.set 落 stateStore.setSetting；progressView 走 fieldValue 的响应式路径', () => {
    const hostSrc = readFileSync(hostPath, 'utf8')
    // 扩展写值入口与设置页读值落在**同一个 stateStore**（当帧刷新的前提）
    expect(hostSrc).toContain('set: (key, value) => stateStore.setSetting(key, value)')

    const src = rawSource()
    // progressView 只经 fieldValue 取值（不许绕过 settingsRevision 直读 stateStore——
    // 直读不被追踪，computed/渲染效应不会失效，就是 issue #85 的"停旧值"形态）
    const view = flatten(extractDecl(src, /function progressView\([\s\S]*?\n}/))
    expect(view).toContain('fieldValue(page, field.key)')
    expect(view).toContain('field.default')
    expect(view).not.toContain('stateStore.getSetting')
    const fv = flatten(extractDecl(src, /function fieldValue\([\s\S]*?\n}/))
    expect(fv).toContain('void settingsRevision.value')
    expect(fv).toContain('stateStore.getSetting(key)')
    // 订阅接线：onSettingsChanged ⇒ settingsRevision++（任何字段写值都触发重渲染）
    expect(src).toContain('stateStore.onSettingsChanged')
    expect(src).toContain('settingsRevision.value++')
  })
})

// ---------------------------------------------------------------- ⑦ 字段链完整性

describe('⑦ 字段链完整：七种字段并存时每种恰好命中一个分支（回归"游离输入框"事故）', () => {
  it('链上分支按序各出现一次：text→number→boolean→select→progress→directory→status→兜底', () => {
    const region = chainRegion(source())
    // 分支条件（带引号字面量或 PROGRESS_FIELD_TYPE 常量）在链区内**恰好各一次**：
    // 重复 = 同一字段渲染两个控件；缺失 = 该类型落兜底变可编辑框
    const order = [
      ...region.matchAll(/v-(?:if|else-if)="field\.type === (?:'(\w+)'|PROGRESS_FIELD_TYPE)"/g)
    ].map((m) => m[1] ?? 'progress')
    expect(order).toEqual([
      'text',
      'number',
      'boolean',
      'select',
      'progress',
      'directory',
      'status'
    ])
    // 兜底仍在链尾（未知类型回落 text + warn 的既有语义不被 progress 挤掉）
    expect(fallbackVElse(source())).not.toBeNull()
  })

  it('progress 分支与前后分支紧邻：select→progress→directory 之间没有任何游离兄弟节点', () => {
    const region = chainRegion(source())
    // select 收尾 → progress 开标签：只有空白（注释已剥）。插了兄弟节点 = 每个字段多渲染一个控件
    const selectClose = region.indexOf('</select>')
    const progressAt = region.indexOf('field.type === PROGRESS_FIELD_TYPE')
    const progressTagStart = region.lastIndexOf('<', progressAt)
    expect(selectClose).toBeGreaterThan(-1)
    expect(region.slice(selectClose + '</select>'.length, progressTagStart).trim()).toBe('')
    // progress 分支自洽收尾 → directory 开标签：同样只有空白
    const dirTagStart = region.lastIndexOf('<', region.indexOf(`field.type === 'directory'`))
    const between = region.slice(progressTagStart, dirTagStart)
    expect(between.trimEnd().endsWith('</div>')).toBe(true)
    // 分支内标签配平（3 个 div：字段容器/槽/填充；1 个 span：{cur}/{max} 文本），无多余控件节点；
    // 条件指令只有本分支自己的 v-else-if（多一个 = 链内混进了游离分支/兄弟节点）
    expect(between.match(/<div\b/g) ?? []).toHaveLength(3)
    expect(between.match(/<\/div>/g) ?? []).toHaveLength(3)
    expect(between.match(/<span\b/g) ?? []).toHaveLength(1)
    expect(between.match(/v-(?:if|else-if|else)=/g) ?? []).toEqual(['v-else-if='])
    expect(between).not.toContain('<input')
    expect(between).not.toContain('<select')
    expect(between).not.toContain('<button')
    expect(between).not.toContain('<textarea')
    expect(between).not.toContain('<p ')
  })
})

// ---------------------------------------------------------------- ⑧ manifest 校验脚本

/** 跑脚本：exit 0 走返回值，非 0 会 throw（用 err.status/err.stdout 取回来） */
function runScript(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
    return { status: 0, stdout }
  } catch (err) {
    const failure = err as { status?: number | null; stdout?: string | null }
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '' }
  }
}

interface ScriptMessage {
  level: 'error' | 'warning'
  message: string
}

/** 校验一个临时 manifest（%TEMP% 下副本，绝不碰 extensions/pet/manifest.json），返回 error 消息 */
function validateTempManifest(fieldsJson: string, fileName: string): ScriptMessage[] {
  // fieldsJson 是**手写 JSON 片段**（不是 JSON.stringify 产物）：允许 1e999 这类字面量
  const manifest = `{
  "name": "progress-fixture",
  "version": "1.0.0",
  "apiVersion": 2,
  "main": "./index.js",
  "contributes": {
    "settings": { "id": "pf.settings", "title": "进度夹具", "fields": ${fieldsJson} }
  }
}`
  const file = join(tempDir, fileName)
  writeFileSync(file, manifest, 'utf8')
  const { status, stdout } = runScript([file, '--json'])
  const report = JSON.parse(stdout) as {
    files: Array<{ messages: ScriptMessage[] }>
    errorCount: number
  }
  const errors = report.files[0].messages.filter((m) => m.level === 'error')
  expect(status, `${fileName} 的退出码应与 errorCount 一致`).toBe(errors.length > 0 ? 1 : 0)
  expect(report.errorCount).toBe(errors.length)
  return errors
}

const tempDir = mkdtempSync(join(tmpdir(), 'obox-card04-progress-'))

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('⑧ validate-manifest.mjs：progress / max / default / 白名单规则', () => {
  it('含 progress 字段的 manifest（带 max / 不带 max / 带数字 default）⇒ 通过（0 error，exit 0）', () => {
    const errors = validateTempManifest(
      `[
        { "key": "pf.hunger", "label": "饥饿度", "type": "progress", "default": 100, "max": 100 },
        { "key": "pf.mood", "label": "心情", "type": "progress" }
      ]`,
      'ok-progress.json'
    )
    expect(errors).toEqual([])
  })

  it('未知类型（type:"gauge"）⇒ error：不在白名单，且文案列出全部合法类型', () => {
    const errors = validateTempManifest(
      `[{ "key": "pf.gauge", "label": "仪表", "type": "gauge" }]`,
      'bad-type-gauge.json'
    )
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe(
      '设置字段 "pf.gauge" 的 type "gauge" 非法（允许：text / number / boolean / select / directory / status / progress）'
    )
  })

  it('max:0 / max:-5 / max:"100" ⇒ error：max 必须为大于 0 的数字（任务卡示例文案逐字）', () => {
    const cases: Array<[string, string]> = [
      ['bad-max-zero.json', '{ "key": "pf.a", "label": "A", "type": "progress", "max": 0 }'],
      ['bad-max-negative.json', '{ "key": "pf.a", "label": "A", "type": "progress", "max": -5 }'],
      ['bad-max-string.json', `{ "key": "pf.a", "label": "A", "type": "progress", "max": "100" }`]
    ]
    for (const [file, field] of cases) {
      const errors = validateTempManifest(`[${field}]`, file)
      expect(errors, file).toHaveLength(1)
      expect(errors[0].message, file).toBe('设置字段 "pf.a" 的 max 必须为大于 0 的数字')
    }
  })

  it('max:1e999（JSON 里写得出的 Infinity）⇒ error（"大于 0 的数字"隐含有限）', () => {
    const errors = validateTempManifest(
      `[{ "key": "pf.a", "label": "A", "type": "progress", "max": 1e999 }]`,
      'bad-max-infinity-json.json'
    )
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('设置字段 "pf.a" 的 max 必须为大于 0 的数字')
  })

  it('progress 字段缺 key / 缺 label ⇒ error（文案可执行：指出第几项、缺什么）', () => {
    const noKey = validateTempManifest(
      `[{ "label": "无键", "type": "progress" }]`,
      'bad-no-key.json'
    )
    expect(noKey).toHaveLength(1)
    expect(noKey[0].message).toBe('设置字段 第 1 项 缺少 key（必须为非空字符串）')
    const noLabel = validateTempManifest(
      `[{ "key": "pf.nolabel", "type": "progress" }]`,
      'bad-no-label.json'
    )
    expect(noLabel).toHaveLength(1)
    expect(noLabel[0].message).toBe('设置字段 "pf.nolabel" 缺少 label（必须为非空字符串）')
  })

  it('progress 的 default 非数字 ⇒ error；越界 default ⇒ 不报错（渲染时钳制，与 design 口径一致）', () => {
    const badDefault = validateTempManifest(
      `[{ "key": "pf.d", "label": "D", "type": "progress", "default": "50" }]`,
      'bad-default-string.json'
    )
    expect(badDefault).toHaveLength(1)
    expect(badDefault[0].message).toContain('default 必须是数字')
    // 越界（150 > max 100）是"渲染时钳制"的显示口径问题，不构成清单错误
    const outOfRange = validateTempManifest(
      `[{ "key": "pf.d2", "label": "D2", "type": "progress", "default": 150, "max": 100 }]`,
      'ok-default-out-of-range.json'
    )
    expect(outOfRange).toEqual([])
  })

  it('JSON 写不出的夹具对象（max: Infinity / NaN）：直喂脚本导出的 validateManifest ⇒ 被拒', async () => {
    const { validateManifest } = (await import('../scripts/validate-manifest.mjs')) as {
      validateManifest: (raw: unknown, oboxApiVersion: number) => ScriptMessage[]
    }
    const base = {
      name: 'progress-fixture',
      version: '1.0.0',
      main: './index.js'
    }
    for (const bad of [Infinity, NaN, -Infinity]) {
      const messages = validateManifest(
        {
          ...base,
          contributes: {
            settings: {
              id: 'pf.settings',
              title: '进度夹具',
              fields: [{ key: 'pf.a', label: 'A', type: 'progress', max: bad }]
            }
          }
        },
        2
      )
      expect(
        messages.map((m) => m.message),
        `max=${String(bad)} 应被拒`
      ).toEqual(['设置字段 "pf.a" 的 max 必须为大于 0 的数字'])
    }
    // default: NaN 同样被拒（typeof NaN === 'number'，但不可渲染）
    const nanDefault = validateManifest(
      {
        ...base,
        contributes: {
          settings: {
            id: 'pf.settings',
            title: '进度夹具',
            fields: [{ key: 'pf.a', label: 'A', type: 'progress', default: NaN }]
          }
        }
      },
      2
    )
    expect(nanDefault.map((m) => m.message)).toEqual([
      '设置字段 "pf.a" 的 default 必须是数字（progress 越界不报错，宿主渲染时钳制到 0..max）'
    ])
    // 合法 progress 声明经同一入口 ⇒ 0 消息
    const ok = validateManifest(
      {
        ...base,
        contributes: {
          settings: {
            id: 'pf.settings',
            title: '进度夹具',
            fields: [{ key: 'pf.a', label: 'A', type: 'progress', max: 100 }]
          }
        }
      },
      2
    )
    expect(ok).toEqual([])
  })
})

// ---------------------------------------------------------------- ⑨ 白名单差分门禁

describe('⑨ 脚本白名单与宿主 SettingFieldType 白名单逐字相等（含 progress）', () => {
  it('两侧源码解析出的白名单一致（顺序也一致——脚本报错文案直接列出该顺序）', () => {
    // 宿主侧：src/api/contributions.ts 的联合类型声明（TS 类型没有运行时痕迹，只能解析源码）
    const apiSrc = readFileSync(join(repoRoot, 'src', 'api', 'contributions.ts'), 'utf8')
    const at = apiSrc.indexOf('export type SettingFieldType')
    expect(at).toBeGreaterThan(-1)
    const hostTypes = [...apiSrc.slice(at, apiSrc.indexOf('\n\n', at)).matchAll(/'([^']+)'/g)].map(
      (m) => m[1]
    )
    // 脚本侧：SETTING_FIELD_TYPES 数组
    const scriptSrc = readFileSync(scriptPath, 'utf8')
    const decl = /const SETTING_FIELD_TYPES = \[([\s\S]*?)\]/.exec(scriptSrc)?.[1] ?? ''
    const scriptTypes = [...decl.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(scriptTypes).toEqual(hostTypes)
    expect(hostTypes).toContain('progress')
    // 同一断言也钉在 test/manifest-script-parity.test.ts（差分门禁的正式归属地）
  })
})
