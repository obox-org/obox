#!/usr/bin/env node
/**
 * validate-manifest — 校验 Obox 扩展 manifest（内置扩展与用户扩展同一套规则）。
 *
 * 用法：
 *   node scripts/validate-manifest.mjs <manifest.json ...>
 *   node scripts/validate-manifest.mjs --all [--root <dir>]
 *   node scripts/validate-manifest.mjs --json [...]          # 机器可读
 *
 * 退出码：0 = 无 error（warning 允许）｜1 = 存在 error｜2 = 用法错误
 *
 * 位置无关：脚本默认把**自己所在目录的上一级**当仓库根（本仓库 = `scripts/` → 仓库根）。
 * 复制到用户扩展仓库时放在 `<扩展仓库>/scripts/` 即可直接跑；放在别处则用 `--root <dir>` 指定。
 *
 * 为什么是"自包含副本"而不是 import 宿主规则：Node 原生跑 .mjs/.mts 解析不了 src/ 内部
 * 的无扩展名 import（同 scripts/make-tray-icon.mts 头部记录的坑），而宿主 core/manifest.ts
 * 又会连带 import package.json 与 shared/ipcDeclaration。规则因此在这里重写一份，
 * 并用 test/manifest-script-parity.test.ts 的**差分门禁**保证两边逐字一致（同批 fixture 喂两边比对）。
 *
 * 规则镜像三处（报错文案与宿主逐字一致，改宿主必须同步这里）：
 *   - src/renderer/src/core/manifest.ts:15-129       → error
 *   - src/shared/ipcDeclaration.ts                    → contributes.ipcChannels 的 error
 *   - src/renderer/src/core/host.ts:131-230           → warning（仅取可由 manifest 静态判定的）
 *
 * 有两条宿主 warning **故意不实现**（它们依赖运行期状态，静态校验拿不到）：
 *   - `快捷键 X 已被 Y 占用（… 未注册）`：需要宿主 keybindingStore 的全局状态；
 *   - `导航项 … 声明的视图组件 … 未在扩展入口导出`：需要扩展入口模块的具名导出表。
 * 另外：数组形状本身已非法时不再追加"引用的命令未声明"warning（避免级联噪音）。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
/** 默认仓库根：scripts/ → 上一级（本仓库根；扩展仓库同样放 <仓库>/scripts/） */
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..')

/** 与 core/manifest.ts:11 一致（**不带 i**：大写 id 非法，issue #77） */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
/** 与 core/manifest.ts:12 一致 */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
/** 与 shared/ipcDeclaration.ts:40 一致 */
const IPC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const HELP = [
  '用法:',
  '  node scripts/validate-manifest.mjs <manifest.json ...>',
  '  node scripts/validate-manifest.mjs --all [--root <dir>]',
  '  node scripts/validate-manifest.mjs --json [...]',
  '',
  '选项:',
  '  --all          扫描 <root>/src/renderer/src/extensions/*/manifest.json',
  '                 与 <root>/extensions/*/manifest.json',
  '  --root <dir>   指定仓库根（默认：脚本所在目录的上一级）',
  '  --json         以 JSON 输出（stdout 只有 JSON）',
  '  -h, --help     显示本帮助',
  '',
  '退出码: 0 = 无 error｜1 = 存在 error｜2 = 用法错误'
].join('\n')

function fail(msg) {
  console.error(`[validate-manifest] 错误: ${msg}`)
  console.error(HELP)
  process.exit(2)
}

// ---------------------------------------------------------------- IPC 通道声明

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/** 镜像 shared/ipcDeclaration.ts:43-47 */
function isValidIpcName(raw) {
  if (typeof raw !== 'string') return false
  const value = raw.trim()
  return Boolean(value) && IPC_NAME_RE.test(value) && !value.includes('..')
}

/** 镜像 shared/ipcDeclaration.ts:54-103（不抛错，返回 { ok, message }） */
function validateIpcDeclaration(raw) {
  if (!isRecord(raw)) return { ok: false, message: '通道声明必须是对象' }
  if (!isValidIpcName(raw.id)) {
    return {
      ok: false,
      message: `通道 id 非法（只允许字母/数字/./_/-，且不能含 ..）: ${String(raw.id)}`
    }
  }
  const id = String(raw.id).trim()
  const transport = raw.transport
  if (transport !== 'stdio' && transport !== 'pipe') {
    return {
      ok: false,
      message: `通道 ${id} 的 transport 必须是 'stdio' 或 'pipe'（不支持 TCP/端口）`
    }
  }
  const framing = raw.framing
  if (framing !== undefined && framing !== 'content-length' && framing !== 'ndjson') {
    return { ok: false, message: `通道 ${id} 的 framing 非法: ${String(framing)}` }
  }
  if (transport === 'stdio') {
    const program = raw.program
    if (typeof program !== 'string' || !program.trim()) {
      return { ok: false, message: `stdio 通道 ${id} 必须声明 program` }
    }
    const normalized = program.replace(/\\/g, '/').replace(/^\.\//, '')
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      return {
        ok: false,
        message: `stdio 通道 ${id} 的 program 必须是扩展目录内的相对路径: ${program}`
      }
    }
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
        return { ok: false, message: `stdio 通道 ${id} 的 args 必须是字符串数组` }
      }
    }
  } else if (raw.program !== undefined || raw.args !== undefined) {
    return {
      ok: false,
      message: `pipe 通道 ${id} 不应声明 program/args（它是连接已在运行的进程）`
    }
  }
  return { ok: true }
}

/** 镜像 shared/ipcDeclaration.ts:120-137 */
function checkIpcChannelList(raw) {
  if (raw === undefined) return { ok: true }
  if (!Array.isArray(raw)) return { ok: false, message: '必须是数组' }
  const seen = new Set()
  for (let i = 0; i < raw.length; i++) {
    const checked = validateIpcDeclaration(raw[i])
    if (!checked.ok) return { ok: false, message: `第 ${i + 1} 项：${checked.message}` }
    const id = String(raw[i].id).trim()
    if (seen.has(id)) return { ok: false, message: `通道 id 重复: ${id}` }
    seen.add(id)
  }
  return { ok: true }
}

// ---------------------------------------------------------------- 宿主 warning（可静态判定的）

/** 只为"形状合法"的数组做交叉引用检查，避免级联噪音 */
function isValidKeybindingList(raw) {
  return (
    Array.isArray(raw) &&
    raw.every((k) => isRecord(k) && typeof k.command === 'string' && typeof k.key === 'string')
  )
}

function isValidMenuList(raw) {
  return Array.isArray(raw) && raw.every((m) => isRecord(m) && typeof m.command === 'string')
}

/** 镜像 host.ts:143-231 中**可由 manifest 静态判定**的 warning */
function collectWarnings(m, messages) {
  const c = m.contributes
  if (!c || typeof c !== 'object') return
  const asArray = (v) => (Array.isArray(v) ? v : [])

  for (const nav of asArray(c.navItems)) {
    if (!(nav && nav.id && nav.title && nav.icon)) {
      messages.push({
        level: 'warning',
        message: `导航项缺少 id/title/icon: ${JSON.stringify(nav)}`
      })
    }
  }
  for (const sb of asArray(c.statusBarItems)) {
    if (!(sb && sb.id && sb.name)) {
      messages.push({ level: 'warning', message: `状态栏项缺少 id/name: ${JSON.stringify(sb)}` })
    }
  }
  for (const cmd of asArray(c.commands)) {
    if (!(cmd && cmd.command && cmd.title)) {
      messages.push({ level: 'warning', message: `命令缺少 command/title: ${JSON.stringify(cmd)}` })
    }
  }
  for (const theme of asArray(c.themes)) {
    if (!(theme && theme.id && theme.label && theme.tokens)) {
      messages.push({
        level: 'warning',
        message: `主题缺少 id/label/tokens: ${JSON.stringify(theme)}`
      })
    }
  }

  const declared = new Set(
    asArray(c.commands)
      .map((x) => (x ? x.command : undefined))
      .filter((x) => typeof x === 'string')
  )
  if (isValidKeybindingList(c.keybindings)) {
    for (const kb of c.keybindings) {
      if (!declared.has(kb.command)) {
        messages.push({
          level: 'warning',
          message: `keybindings 引用的命令 ${kb.command} 未在 contributes.commands 声明`
        })
      }
    }
  }
  if (isValidMenuList(c.menus)) {
    for (const menu of c.menus) {
      if (!declared.has(menu.command)) {
        messages.push({
          level: 'warning',
          message: `menus 引用的命令 ${menu.command} 未在 contributes.commands 声明`
        })
      }
    }
  }
}

// ---------------------------------------------------------------- settings 字段（contributes.settings）

/**
 * 设置字段类型白名单：与宿主 `SettingFieldType`（src/api/contributions.ts）**逐字一致**。
 * 差分门禁（test/manifest-script-parity.test.ts）解析两边源码逐项比对——增删/改名类型必须两侧同步。
 */
const SETTING_FIELD_TYPES = [
  'text',
  'number',
  'boolean',
  'select',
  'directory',
  'status',
  'progress'
]

/** 字段定位名：有 key 用 `"key"`，没有（key 本身非法）用「第 N 项」，保证报错可执行 */
function settingFieldName(field, index) {
  return typeof field.key === 'string' && field.key.trim() ? `"${field.key}"` : `第 ${index + 1} 项`
}

/** 校验单个设置字段，返回 error 列表（规则依据见 checkSettings 的文档注释） */
function checkSettingsField(field, index) {
  if (!isRecord(field)) {
    return [{ level: 'error', message: `设置字段第 ${index + 1} 项必须是对象` }]
  }
  const messages = []
  const name = settingFieldName(field, index)
  if (typeof field.key !== 'string' || !field.key.trim()) {
    messages.push({ level: 'error', message: `设置字段 ${name} 缺少 key（必须为非空字符串）` })
  }
  if (typeof field.label !== 'string' || !field.label.trim()) {
    messages.push({ level: 'error', message: `设置字段 ${name} 缺少 label（必须为非空字符串）` })
  }
  if (typeof field.type !== 'string' || !SETTING_FIELD_TYPES.includes(field.type)) {
    messages.push({
      level: 'error',
      message: `设置字段 ${name} 的 type ${JSON.stringify(field.type)} 非法（允许：${SETTING_FIELD_TYPES.join(' / ')}）`
    })
  }
  // max 是可选键（progress 的值域上限，老宿主忽略它）：一旦出现就必须是**大于 0 的有限数字**。
  // 0/负数会让条宽除零或反向，'100' 这类字符串与 NaN/Infinity 都不是可渲染的上限。
  if (
    field.max !== undefined &&
    !(typeof field.max === 'number' && Number.isFinite(field.max) && field.max > 0)
  ) {
    messages.push({ level: 'error', message: `设置字段 ${name} 的 max 必须为大于 0 的数字` })
  }
  // progress 的 default 一旦出现必须是数字（它就是首屏回退展示的进度值）。
  // **越界不报错**：与 design 口径一致——宿主渲染时钳制到 [0, max]（default 150 等效于满格），
  // 不构成清单错误，报错反而会把"合法但会被钳制"的声明拦死。
  if (
    field.type === 'progress' &&
    field.default !== undefined &&
    !(typeof field.default === 'number' && Number.isFinite(field.default))
  ) {
    messages.push({
      level: 'error',
      message: `设置字段 ${name} 的 default 必须是数字（progress 越界不报错，宿主渲染时钳制到 0..max）`
    })
  }
  return messages
}

/**
 * 校验 contributes.settings（形状 = 单个 `{ id, title, fields }`，与 api.settings.register 同型）。
 *
 * ⚠️ 这一段是**脚本独有的静态收紧**——宿主 core/manifest.ts 的 validateManifest 不校验 settings：
 * 宿主对未知字段类型的策略是"渲染期兜底成可编辑 text + console.warn"（清单不报错）。
 * 但把 type 写错（如 'gauge'）的 manifest 一旦发布，用户装上后只读字段（status/progress）
 * 就变成**可编辑文本框**，误编辑即覆盖扩展写的状态——静态校验是发布前唯一的拦截点，
 * 所以脚本比宿主严。差分门禁不受影响：现有 parity fixtures 不含非法 settings
 * （ok-full.json 的 settings 声明合法，两侧都 0 error），白名单与宿主 SettingFieldType 的
 * 一致性另有专门的源码解析断言（见 test/manifest-script-parity.test.ts）。
 */
function checkSettings(settings) {
  if (!isRecord(settings)) {
    return [{ level: 'error', message: 'contributes.settings 必须是 {id, title, fields} 对象' }]
  }
  if (!Array.isArray(settings.fields)) {
    return [{ level: 'error', message: 'contributes.settings.fields 必须是数组' }]
  }
  return settings.fields.flatMap(checkSettingsField)
}

// ---------------------------------------------------------------- 规则本体

/**
 * 校验 manifest，返回 [{ level: 'error'|'warning', message }]。
 * 文案与宿主 core/manifest.ts 逐字一致（差分门禁会比对）；
 * 唯一例外是 contributes.settings 段（checkSettings）——那是**脚本独有的静态收紧**，
 * 宿主运行期对未知字段类型走"兜底渲染 + warn"而不是清单 error（理由见 checkSettings 注释）。
 * 导出供测试直喂 JSON 写不出的夹具对象（如 max: Infinity / NaN）；CLI 只在直接执行时跑（见文件尾）。
 */
export function validateManifest(raw, oboxApiVersion) {
  const messages = []
  if (!raw || typeof raw !== 'object') {
    return [{ level: 'error', message: 'manifest 必须是 JSON 对象' }]
  }
  const m = raw

  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) {
    messages.push({ level: 'error', message: 'name 必填，且只能含字母/数字/./_/-' })
  }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) {
    messages.push({ level: 'error', message: 'version 必填且必须是 semver（如 1.0.0）' })
  }
  if (m.apiVersion !== undefined) {
    const apiVersion = m.apiVersion
    if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 0) {
      messages.push({ level: 'error', message: 'apiVersion 必须是大于等于 0 的整数' })
    } else if (apiVersion > oboxApiVersion) {
      messages.push({
        level: 'error',
        message: `需要 obox API v${apiVersion} 或更高（当前 obox 为 v${oboxApiVersion}）`
      })
    }
  }
  if (typeof m.main !== 'string' || !m.main.trim()) {
    messages.push({ level: 'error', message: 'main（扩展入口）必填' })
  }
  if (m.contributes !== undefined && typeof m.contributes !== 'object') {
    messages.push({ level: 'error', message: 'contributes 必须是对象' })
  }
  const contributes = m.contributes
  if (contributes && typeof contributes === 'object' && contributes.ipcChannels !== undefined) {
    const checked = checkIpcChannelList(contributes.ipcChannels)
    if (!checked.ok) {
      messages.push({ level: 'error', message: `contributes.ipcChannels 非法：${checked.message}` })
    }
  }
  if (contributes && typeof contributes === 'object' && contributes.keybindings !== undefined) {
    const kb = contributes.keybindings
    if (
      !Array.isArray(kb) ||
      kb.some(
        (k) =>
          !k || typeof k !== 'object' || typeof k.command !== 'string' || typeof k.key !== 'string'
      )
    ) {
      messages.push({ level: 'error', message: 'keybindings 必须是 [{command, key}] 数组' })
    }
  }
  if (contributes && typeof contributes === 'object' && contributes.menus !== undefined) {
    const menus = contributes.menus
    if (
      !Array.isArray(menus) ||
      menus.some((x) => !x || typeof x !== 'object' || typeof x.command !== 'string')
    ) {
      messages.push({ level: 'error', message: 'menus 必须是 [{command, when?}] 数组' })
    }
  }
  if (contributes && typeof contributes === 'object' && contributes.views !== undefined) {
    const views = contributes.views
    if (
      !Array.isArray(views) ||
      views.some((v) => {
        const vv = v
        return (
          !vv ||
          typeof vv !== 'object' ||
          typeof vv.id !== 'string' ||
          typeof vv.title !== 'string' ||
          typeof vv.icon !== 'string'
        )
      })
    ) {
      messages.push({ level: 'error', message: 'views 必须是 [{id, title, icon, group?}] 数组' })
    }
  }
  // issue #84：与宿主 core/manifest.ts:105-119 同义——这四类此前不校验形状，`"navItems": {}`
  // 能过校验却让宿主注册期 `for...of` 抛 TypeError。只补"必须是数组"（逐项缺字段仍是宿主 warning）。
  if (contributes && typeof contributes === 'object' && contributes.navItems !== undefined) {
    if (!Array.isArray(contributes.navItems)) {
      messages.push({ level: 'error', message: 'navItems 必须是 [{id, title, icon, view?}] 数组' })
    }
  }
  if (contributes && typeof contributes === 'object' && contributes.statusBarItems !== undefined) {
    if (!Array.isArray(contributes.statusBarItems)) {
      messages.push({ level: 'error', message: 'statusBarItems 必须是 [{id, name}] 数组' })
    }
  }
  if (contributes && typeof contributes === 'object' && contributes.commands !== undefined) {
    if (!Array.isArray(contributes.commands)) {
      messages.push({ level: 'error', message: 'commands 必须是 [{command, title}] 数组' })
    }
  }
  if (contributes && typeof contributes === 'object' && contributes.themes !== undefined) {
    if (!Array.isArray(contributes.themes)) {
      messages.push({ level: 'error', message: 'themes 必须是 [{id, label, tokens}] 数组' })
    }
  }
  if (contributes && typeof contributes === 'object' && contributes.settings !== undefined) {
    messages.push(...checkSettings(contributes.settings))
  }
  if (m.extensionDependencies !== undefined) {
    const deps = m.extensionDependencies
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
      messages.push({ level: 'error', message: 'extensionDependencies 必须是字符串数组' })
    }
  }
  // 与宿主 core/manifest.ts:126 同义（issue #83 两侧语义对齐）：先判数组再查自身。
  // 旧写法用 `typeof …includes === 'function'` 探测，对 `{includes: fn}` 这类值会真的调它，
  // 与宿主的 `Array.isArray` 判据不等价；而宿主原本连形状都没判，非数组时直接抛 TypeError。
  if (Array.isArray(m.extensionDependencies) && m.extensionDependencies.includes(m.name)) {
    messages.push({ level: 'error', message: '扩展不能依赖自身' })
  }

  collectWarnings(m, messages)
  return messages
}

// ---------------------------------------------------------------- 读取与扫描

/** 去掉 UTF-8 BOM（Windows 记事本/PowerShell 写出的 JSON 常带） */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 读 <root>/package.json 的 apiVersion；缺失/损坏/BOM 都视为 0 并继续（绝不崩栈） */
async function readOboxApiVersion(root) {
  const pkgPath = join(root, 'package.json')
  let text
  try {
    text = await readFile(pkgPath, 'utf8')
  } catch {
    return { apiVersion: 0, note: `未找到 ${pkgPath}，apiVersion 视为 0` }
  }
  try {
    const pkg = JSON.parse(stripBom(text))
    const version = pkg && pkg.apiVersion
    if (typeof version === 'number' && Number.isInteger(version) && version >= 0) {
      return { apiVersion: version, note: null }
    }
    return { apiVersion: 0, note: `${pkgPath} 未声明合法的 apiVersion，视为 0` }
  } catch (err) {
    return {
      apiVersion: 0,
      note: `${pkgPath} 解析失败（${err instanceof Error ? err.message : String(err)}），apiVersion 视为 0`
    }
  }
}

/** 列出某目录下所有子目录的 manifest.json（目录不存在 = 空列表） */
async function listManifests(parentDir) {
  let entries
  try {
    entries = await readdir(parentDir, { withFileTypes: true })
  } catch {
    return { dir: parentDir, found: [], missingDir: true }
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(parentDir, entry.name, 'manifest.json')
    try {
      const info = await stat(manifestPath)
      if (info.isFile()) found.push(manifestPath)
      else console.error(`[validate-manifest] 跳过（manifest.json 不是文件）: ${manifestPath}`)
    } catch {
      console.error(`[validate-manifest] 跳过（无 manifest.json）: ${join(parentDir, entry.name)}`)
    }
  }
  found.sort()
  return { dir: parentDir, found, missingDir: false }
}

// ---------------------------------------------------------------- CLI

/**
 * 本模块是否被**直接执行**（`node scripts/validate-manifest.mjs …`）。
 *
 * 为什么要这个守卫：validateManifest 现在是具名导出，测试（test/settings-progress-field.test.ts）
 * 会以模块方式载入本文件、直喂 JSON 里**写不出**的夹具对象（如 `max: Infinity` / `NaN`）。
 * 被载入时绝不能跑 CLI：不消费 argv（测试进程的 argv 是 vitest 的）、不打印、不 process.exit
 * （否则会把测试工作进程整个杀掉）。直接执行与差分门禁（execFileSync）路径的行为完全不变。
 */
function isMainModule() {
  const entry = process.argv[1]
  if (typeof entry !== 'string') return false
  try {
    const self = fileURLToPath(import.meta.url)
    const resolved = resolve(entry)
    // Windows 下 argv[1] 与 import.meta.url 的路径大小写可能不一致，归一化后再比
    return process.platform === 'win32'
      ? resolved.toLowerCase() === self.toLowerCase()
      : resolved === self
  } catch {
    return false
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const files = []
  let rootArg
  let all = false
  let jsonMode = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') all = true
    else if (arg === '--json') jsonMode = true
    else if (arg === '-h' || arg === '--help') {
      console.log(HELP)
      process.exit(0)
    } else if (arg === '--root') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail('--root 需要一个目录参数')
      rootArg = argv[++i]
    } else if (arg.startsWith('--root=')) {
      rootArg = arg.slice('--root='.length)
    } else if (arg.startsWith('-') && arg !== '-') {
      fail(`未知选项: ${arg}`)
    } else {
      files.push(arg)
    }
  }

  const root = resolve(rootArg ? rootArg : DEFAULT_ROOT)
  const { apiVersion: oboxApiVersion, note } = await readOboxApiVersion(root)
  if (note) console.error(`[validate-manifest] 提示: ${note}`)

  if (!all && files.length === 0) fail('没有指定任何 manifest.json（用 --all 或给出文件路径）')
  if (all && files.length > 0) fail('--all 不能与具体文件路径同时使用')

  let targets = []
  if (all) {
    const builtinDir = join(root, 'src', 'renderer', 'src', 'extensions')
    const userDir = join(root, 'extensions')
    const builtin = await listManifests(builtinDir)
    const user = await listManifests(userDir)
    if (builtin.missingDir && user.missingDir) {
      fail(
        `--all 没找到任何扩展目录：${builtinDir} 与 ${userDir} 都不存在。` +
          '请用 --root 指向 obox 仓库根，或直接给出 manifest.json 路径'
      )
    }
    targets = [...builtin.found, ...user.found]
    if (targets.length === 0) {
      fail(
        `${builtinDir} 与 ${userDir} 下都没有扩展的 manifest.json。` +
          '请用 --root 指向 obox 仓库根，或直接给出 manifest.json 路径'
      )
    }
  } else {
    targets = files.map((f) => resolve(f))
    for (const target of targets) {
      try {
        const info = await stat(target)
        if (info.isDirectory()) fail(`这是一个目录，请给出 manifest.json 文件路径: ${target}`)
      } catch {
        fail(`文件不存在: ${target}`)
      }
    }
  }

  const report = { root, files: [], errorCount: 0, warningCount: 0 }

  for (const target of targets) {
    const messages = []
    try {
      const text = await readFile(target, 'utf8')
      let raw
      try {
        raw = JSON.parse(stripBom(text))
      } catch (err) {
        messages.push({
          level: 'error',
          message: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`
        })
      }
      if (raw !== undefined) messages.push(...validateManifest(raw, oboxApiVersion))
    } catch (err) {
      messages.push({
        level: 'error',
        message: `读取失败: ${err instanceof Error ? err.message : String(err)}`
      })
    }

    const errors = messages.filter((x) => x.level === 'error')
    const warnings = messages.filter((x) => x.level === 'warning')
    report.errorCount += errors.length
    report.warningCount += warnings.length
    report.files.push({ path: target, messages })

    if (!jsonMode) {
      if (messages.length === 0) {
        console.log(`[validate-manifest] ✓ ${target}: 通过`)
      }
      for (const msg of messages) {
        const mark = msg.level === 'error' ? '✗' : '⚠'
        console.log(`[validate-manifest] ${mark} ${target}: [${msg.level}] ${msg.message}`)
      }
    }
  }

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    const summary = `[validate-manifest] 共 ${report.files.length} 个 manifest：${report.errorCount} 个 error、${report.warningCount} 个 warning`
    console.log(summary)
  }

  process.exit(report.errorCount > 0 ? 1 : 0)
}

if (isMainModule()) await main()
