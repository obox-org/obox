#!/usr/bin/env node
/**
 * create-extension — Obox **内置扩展**脚手架。
 *
 * 用法：
 *   node skills/obox-ext-init/scripts/create-extension.mjs <id> [--title "显示名"] [--desc "简介"]
 *
 * 在**当前 obox 仓库**的 src/renderer/src/extensions/<id>/ 生成：
 *   manifest.json + index.ts（default 插件函数 + 具名导出视图）+ <Pascal>View.vue（scoped + 主题 token）
 * 若 <id> 已存在则中止，不覆盖。
 *
 * 退出码：0 = 生成成功｜1 = 生成失败（id 非法 / 目录已存在 / 不在 obox 仓库内）｜2 = 用法错误
 *
 * 为什么先断言"必须在 obox 仓库内"：这个脚本会被复制到别处（skill 是自包含的），
 * 以前在任意裸目录都能静默生成一份谁也跑不起来的骨架。现在要求
 * <root>/package.json 的 name === 'obox' 且存在 <root>/src/renderer/src/extensions/。
 *
 * 用户扩展（纯 ESM JS + .oix）用 create-user-extension.mjs，不要用本脚本。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
/** 仓库根：skills/obox-ext-init/scripts → 上三级 */
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..', '..')

/**
 * 脚手架自己的 id 校验：与宿主 `src/renderer/src/core/manifest.ts:11` 的 `NAME_RE`
 * 及仓库校验脚本 `scripts/validate-manifest.mjs:39` 的 `NAME_RE` **逐字一致** ——
 * 三者都是 `/^[a-z0-9][a-z0-9._-]*$/`，**不带 `i`**（大写 id 非法，issue #77）。
 *
 * 为什么必须同源收紧：脚本一旦接受大写 id，生成的 manifest 会被宿主判「清单无效」，
 * 而脚本自己 exit 0 —— 门禁等于形同虚设。宁可在这里快速失败。
 */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

const HELP = [
  '用法:',
  '  node skills/obox-ext-init/scripts/create-extension.mjs <id> [--title "显示名"] [--desc "简介"]',
  '',
  '说明: 在 <obox 仓库>/src/renderer/src/extensions/<id>/ 生成内置扩展骨架。',
  '      <id> 须匹配 ^[a-z0-9][a-z0-9._-]*$（只小写；与宿主 NAME_RE 逐字一致，含大写即清单无效）。',
  '      用户扩展（纯 ESM + .oix）请用 create-user-extension.mjs',
  '',
  '退出码: 0 = 成功｜1 = 生成失败｜2 = 用法错误'
].join('\n')

function fail(msg, code = 1) {
  console.error(`[create-extension] 错误: ${msg}`)
  if (code === 2) console.error(HELP)
  process.exit(code)
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** JS 标识符安全化：NAME_RE 允许首字符是数字（如 `2cool`），但标识符不行 */
function safeIdentifier(name) {
  return /^[0-9]/.test(name) ? `_${name}` : name
}

/** 把任意字符串安全嵌入生成的 JS/TS 源码（JSON 字符串字面量就是合法的 JS 字面量） */
function jsLiteral(value) {
  return JSON.stringify(String(value))
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 断言这里确实是 obox 仓库；返回内置扩展目录 */
async function assertOboxRepo(root) {
  const pkgPath = join(root, 'package.json')
  let text
  try {
    text = await readFile(pkgPath, 'utf8')
  } catch {
    fail(`这里不是 obox 仓库：找不到 ${pkgPath}（本脚本只能给 obox 内置扩展搭骨架）`)
  }
  let pkg
  try {
    pkg = JSON.parse(stripBom(text))
  } catch (err) {
    fail(`${pkgPath} 无法解析：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!pkg || pkg.name !== 'obox') {
    fail(
      `这里不是 obox 仓库：${pkgPath} 的 name 是 ${JSON.stringify(pkg ? pkg.name : undefined)}，期望 "obox"`
    )
  }
  const extensionsDir = join(root, 'src', 'renderer', 'src', 'extensions')
  try {
    const info = await stat(extensionsDir)
    if (!info.isDirectory()) fail(`这里不是 obox 仓库：${extensionsDir} 不是目录`)
  } catch {
    fail(`这里不是 obox 仓库：找不到 ${extensionsDir}`)
  }
  return extensionsDir
}

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2)
const positionals = []
let title
let description

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '-h' || arg === '--help') {
    console.log(HELP)
    process.exit(0)
  } else if (arg === '--title' || arg === '--desc') {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail(`${arg} 需要一个字符串参数`, 2)
    if (arg === '--title') title = argv[++i]
    else description = argv[++i]
  } else if (arg.startsWith('-') && arg !== '-') {
    fail(`未知选项: ${arg}`, 2)
  } else {
    positionals.push(arg)
  }
}

if (positionals.length === 0) fail('缺少扩展 id', 2)
if (positionals.length > 1) fail(`只接受一个扩展 id，多给了: ${positionals.slice(1).join(' ')}`, 2)

const id = positionals[0]
const displayName = title ?? id
const desc = description ?? ''

if (!ID_RE.test(id)) {
  fail(
    `扩展 id 非法: ${id}\n` +
      '  规则：name 只能小写字母/数字/./_/-，且首字符必须是字母或数字（^[a-z0-9][a-z0-9._-]*$）。\n' +
      '  出处：宿主 src/renderer/src/core/manifest.ts:11 的 NAME_RE 与 scripts/validate-manifest.mjs:39\n' +
      '        的 NAME_RE 逐字相同，都不带 i —— 大写 id 会被宿主判「清单无效」。\n' +
      '  宿主校验器对同样内容的 name 会报（原文）：\n' +
      '    [validate-manifest] ✗ <manifest.json>: [error] name 必填，且只能含字母/数字/./_/-\n' +
      '  请改用全小写 id（kebab-case，如 my-ext）。'
  )
}

const extensionsDir = await assertOboxRepo(PROJECT_ROOT)
const extDir = join(extensionsDir, id)

try {
  await stat(extDir)
  fail(`扩展目录已存在: ${extDir}`)
} catch (err) {
  if (err && err.code !== 'ENOENT') fail(`无法检查目录 ${extDir}: ${err.message}`)
}

const pascal = capitalize(id)
/** JS 标识符安全化：NAME_RE 允许首字符是数字（如 `2cool`），但标识符不行 */
const viewIdent = `${safeIdentifier(pascal)}View`
const camelName = safeIdentifier(camel(id))
/** 导航项语言包 key：内置扩展与宿主共用语言包（NavBar 用宿主 t() 解析 titleKey） */
const navTitleKey = `${id}.nav`

const icon =
  "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'><rect x='3' y='3' width='18' height='18' rx='2'/></svg>"

const manifest = {
  name: id,
  version: '1.0.0',
  displayName,
  author: 'Obox',
  description: desc,
  main: './index.ts',
  contributes: {
    navItems: [
      {
        id: `${id}.main`,
        title: displayName,
        // 内置扩展的 titleKey 走**宿主语言包**（src/renderer/src/i18n/locales/{zh,en}.ts），
        // 不加词条时导航项会显示原始 key —— 脚本运行结束会打印要加的片段。
        titleKey: navTitleKey,
        icon,
        group: 'top',
        view: viewIdent
      }
    ],
    commands: [
      {
        command: `${id}.hello`,
        title: '打个招呼',
        category: displayName,
        palette: true
      }
    ]
  }
}

const indexTs = `/**
 * ${id} 内置扩展入口。
 * - default 导出插件函数（宿主 apply）：命令**必须先在 manifest 的 contributes.commands 声明**，
 *   否则 api.registerCommand 会抛错（不是 warning），扩展在扩展管理器里标红 activationError。
 * - 具名导出视图组件：manifest 的 navItems[].view 按名字引用（本文件 re-export ${viewIdent}）。
 */
import type { ExtensionActivationApi } from '../../../../api'
import ${viewIdent} from './${pascal}View.vue'

export { ${viewIdent} }

export default function ${camelName}(api: ExtensionActivationApi): () => void {
  const hello = api.registerCommand('${id}.hello', async () => {
    return 'hello from ${id}'
  })

  // 宿主停用扩展时调用：事件订阅 / 定时器 / 子进程都要在这里释放
  return () => {
    hello.dispose()
  }
}
`

const viewVue = `<script setup lang="ts">
// ${pascal}View — 导航项 ${id}.main 的内容栏视图。
// 需要本地化文案时：const { t } = useI18n()（内置扩展与宿主共用语言包）。
const title = ${jsLiteral(displayName)}
</script>

<template>
  <div class="page">
    <h1 class="page-title">{{ title }}</h1>
    <p class="page-desc">${htmlEscape(desc || '这是一个 Obox 内置扩展视图')}</p>
  </div>
</template>

<style scoped>
/* 主题 token 一律写成 var(--token, fallback)：主题扩展缺该 token 时仍然可读（token 表见 docs/extension-api/themes-settings.md） */
.page {
  height: 100%;
  padding: 16px;
  color: var(--fg, #cccccc);
  background: var(--bg, #1e1e1e);
}

.page-title {
  margin: 0 0 8px;
  font-size: var(--font-size-lg, 16px);
  color: var(--fg-bright, #ffffff);
}

.page-desc {
  margin: 0;
  color: var(--fg-dim, #6e6e6e);
}
</style>
`

await mkdir(extDir, { recursive: true })
await writeFile(join(extDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(join(extDir, 'index.ts'), indexTs, 'utf8')
await writeFile(join(extDir, `${pascal}View.vue`), viewVue, 'utf8')

console.log(`[create-extension] 已生成内置扩展骨架:
  ${join(extDir, 'manifest.json')}
  ${join(extDir, 'index.ts')}
  ${join(extDir, `${pascal}View.vue`)}

i18n（不补词条时导航项会显示原始 key ${navTitleKey}）：把下面的片段加进宿主语言包
  src/renderer/src/i18n/locales/zh.ts →  ${id}: { nav: ${jsLiteral(displayName)} },
  src/renderer/src/i18n/locales/en.ts →  ${id}: { nav: '<English title>' },

下一步：
  - 编辑 manifest.json 声明贡献点（navItems/statusBarItems/commands/views/keybindings/menus）
  - 编辑 index.ts 绑定命令实现、注册事件、可选 api.app.register 注册到应用
  - 校验 manifest：node scripts/validate-manifest.mjs ${join(extDir, 'manifest.json')}
  - 质量门禁：npm run typecheck && npm run lint && npm test；npm run dev 实机验证
  - 开发流程与文档：docs/extension-workflow.md；内置扩展路线：docs/extension-api/guides-builtin.md`)

function capitalize(s) {
  // 按分隔符分词，各词首字母大写（test-scaffold → TestScaffold）
  return s
    .split(/[-._]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
}

function camel(s) {
  // 首词小写，后续词首字母大写（test-scaffold → testScaffold）
  const parts = capitalize(s)
  return parts[0].toLowerCase() + parts.slice(1)
}
