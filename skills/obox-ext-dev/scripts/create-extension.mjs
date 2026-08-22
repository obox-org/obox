#!/usr/bin/env node
/**
 * create-extension — Obox 内置扩展脚手架。
 *
 * 用法：
 *   node skills/obox-ext-dev/scripts/create-extension.mjs <id> [--title "显示名"] [--desc "简介"]
 *
 * 在当前项目 src/renderer/src/extensions/<id>/ 生成：
 *   manifest.json + index.ts（模板，含 default 插件函数 + 具名导出视图）
 * 若 <id> 已存在则中止，不覆盖。
 */
import { mkdir, writeFile, access } from 'fs/promises'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// 项目根：skills/obox-ext-dev/scripts → 上三级
const projectRoot = resolve(scriptDir, '..', '..', '..')

const args = process.argv.slice(2)
const id = args[0]
const flagOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const title = flagOf('--title') ?? id
const description = flagOf('--desc') ?? ''

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

function fail(msg) {
  console.error(`[create-extension] 错误: ${msg}`)
  process.exit(1)
}

if (!id) fail('缺少扩展 id，用法: node create-extension.mjs <id> [--title "显示名"]')
if (!ID_RE.test(id)) fail(`扩展 id 非法: ${id}（须匹配 ^[a-z0-9][a-z0-9._-]*$）`)

const extDir = join(projectRoot, 'src', 'renderer', 'src', 'extensions', id)

try {
  await access(extDir)
  fail(`扩展目录已存在: ${extDir}`)
} catch {
  /* 不存在，继续 */
}

const manifest = {
  name: id,
  version: '1.0.0',
  displayName: title,
  author: 'Obox',
  description,
  main: './index.ts',
  contributes: {
    navItems: [
      {
        id: `${id}.main`,
        title,
        icon: `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'><rect x='3' y='3' width='18' height='18' rx='2'/></svg>`,
        group: 'top',
        view: `${capitalize(id)}View`
      }
    ],
    commands: [
      {
        command: `${id}.hello`,
        title: '打个招呼',
        category: title,
        palette: true
      }
    ]
  }
}

const indexTs = `/**
 * ${id} 扩展入口。
 * default 导出插件函数（宿主 apply），具名导出视图组件（导航项 view 字段引用）。
 */
import type { ExtensionActivationApi } from '../../core/types'
import ${capitalize(id)}View from './${capitalize(id)}View.vue'

export { ${capitalize(id)}View }

export default function ${camel(id)}(api: ExtensionActivationApi): () => void {
  const hello = api.registerCommand('${id}.hello', async () => {
    return 'hello from ${id}'
  })

  return () => {
    hello.dispose()
  }
}
`

const viewVue = `<script setup lang="ts">
// ${capitalize(id)}View — 导航项 ${id}.main 的内容栏视图
</script>

<template>
  <div style="padding: 16px">
    <h1>${title}</h1>
    <p>${description || '这是一个 Obox 扩展视图'}</p>
  </div>
</template>
`

await mkdir(extDir, { recursive: true })
await writeFile(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
await writeFile(join(extDir, 'index.ts'), indexTs, 'utf8')
await writeFile(join(extDir, `${capitalize(id)}View.vue`), viewVue, 'utf8')

console.log(`[create-extension] 已生成扩展骨架:
  ${extDir}/manifest.json
  ${extDir}/index.ts
  ${extDir}/${capitalize(id)}View.vue

下一步：
  - 编辑 manifest.json 声明贡献点（navItems/statusBarItems/commands）
  - 编辑 index.ts 绑定命令实现、注册事件、可选 api.app.register 注册到应用
  - npm run dev 验证；npm run typecheck && npm run lint 保证质量`)

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
