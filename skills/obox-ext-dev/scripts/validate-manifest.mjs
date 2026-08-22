#!/usr/bin/env node
/**
 * validate-manifest — 校验 Obox 扩展 manifest。
 *
 * 用法：
 *   node skills/obox-ext-dev/scripts/validate-manifest.mjs <manifest.json 路径>...
 *   或
 *   node skills/obox-ext-dev/scripts/validate-manifest.mjs --all
 *     （校验 src/renderer/src/extensions 下全部内置扩展的 manifest.json）
 *
 * 校验规则与宿主 core/manifest.ts 保持一致：
 *   - name 必填且匹配 ^[a-z0-9][a-z0-9._-]*$
 *   - version 必填且为 semver
 *   - main 必填
 *   - contributes 必须是对象；extensionDependencies 是字符串数组；不能依赖自身
 *   - 导航项缺 id/title/icon、状态栏项缺 id/name、命令缺 command/title → warning
 *
 * 退出码：0=通过（warning 允许）；1=存在 error。
 */
import { readFile, access, readdir } from 'fs/promises'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..', '..', '..')

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

function validateManifest(raw) {
  const messages = []
  if (!raw || typeof raw !== 'object') {
    return [{ severity: 'error', message: 'manifest 必须是 JSON 对象' }]
  }
  const m = raw

  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) {
    messages.push({ severity: 'error', message: 'name 必填，且只能含字母/数字/./_/-' })
  }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) {
    messages.push({ severity: 'error', message: 'version 必填且必须是 semver（如 1.0.0）' })
  }
  if (typeof m.main !== 'string' || !m.main.trim()) {
    messages.push({ severity: 'error', message: 'main（扩展入口）必填' })
  }
  if (m.contributes !== undefined && typeof m.contributes !== 'object') {
    messages.push({ severity: 'error', message: 'contributes 必须是对象' })
  }
  if (m.extensionDependencies !== undefined) {
    if (!Array.isArray(m.extensionDependencies) || m.extensionDependencies.some((d) => typeof d !== 'string')) {
      messages.push({ severity: 'error', message: 'extensionDependencies 必须是字符串数组' })
    }
  }
  if (Array.isArray(m.extensionDependencies) && m.extensionDependencies.includes(m.name)) {
    messages.push({ severity: 'error', message: '扩展不能依赖自身' })
  }

  const c = m.contributes
  if (c) {
    for (const nav of c.navItems ?? []) {
      if (!nav.id || !nav.title || !nav.icon) {
        messages.push({ severity: 'warning', message: `导航项缺少 id/title/icon: ${JSON.stringify(nav)}` })
      }
    }
    for (const sb of c.statusBarItems ?? []) {
      if (!sb.id || !sb.name) {
        messages.push({ severity: 'warning', message: `状态栏项缺少 id/name: ${JSON.stringify(sb)}` })
      }
    }
    for (const cmd of c.commands ?? []) {
      if (!cmd.command || !cmd.title) {
        messages.push({ severity: 'warning', message: `命令缺少 command/title: ${JSON.stringify(cmd)}` })
      }
    }
  }
  return messages
}

async function validateFile(path) {
  let raw
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    console.error(`[validate] ✗ ${path}: JSON 解析失败 - ${err.message}`)
    return { hasError: true }
  }
  const messages = validateManifest(raw)
  let hasError = false
  for (const msg of messages) {
    const mark = msg.severity === 'error' ? '✗' : '⚠'
    if (msg.severity === 'error') hasError = true
    console.log(`[validate] ${mark} ${path}: [${msg.severity}] ${msg.message}`)
  }
  if (!messages.length) console.log(`[validate] ✓ ${path}: 通过`)
  return { hasError }
}

const args = process.argv.slice(2)
let files = []

if (args.includes('--all')) {
  const extDir = join(projectRoot, 'src', 'renderer', 'src', 'extensions')
  const dirs = await readdir(extDir, { withFileTypes: true })
  files = dirs
    .filter((d) => d.isDirectory())
    .map((d) => join(extDir, d.name, 'manifest.json'))
    .filter((p) => {
      try {
        access(p)
        return true
      } catch {
        console.warn(`[validate] 跳过（无 manifest.json）: ${p}`)
        return false
      }
    })
} else {
  files = args.filter((a) => !a.startsWith('--'))
}

if (!files.length) {
  console.error('用法: node validate-manifest.mjs <manifest.json...> | --all')
  process.exit(2)
}

let anyError = false
for (const f of files) {
  const r = await validateFile(f)
  if (r.hasError) anyError = true
}
process.exit(anyError ? 1 : 0)
