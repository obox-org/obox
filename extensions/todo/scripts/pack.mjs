/**
 * 打包 .oix：把扩展分发文件（manifest + 入口 + dist 子应用产物）zip 成 <name>-<version>.oix。
 * 产物输出到 out/。用法：npm run pack（先 npm run build 生成子应用产物到 dist/）。
 */
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const name = manifest.name
const version = manifest.version

// 入口固定文件
const rootFiles = ['manifest.json', 'index.js']
// dist 产物（css 可能不存在）
const distFiles = ['todo.html', 'todo.js', 'todo.css'].filter((f) => existsSync(join(dist, f)))

for (const f of ['todo.html', 'todo.js']) {
  if (!existsSync(join(dist, f))) {
    throw new Error(`缺少构建产物 dist/${f}（先运行 npm run build）`)
  }
}

const zip = new AdmZip()
for (const f of rootFiles) zip.addLocalFile(join(root, f))
for (const f of distFiles) zip.addLocalFile(join(dist, f))

const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `${name}-${version}.oix`)
zip.writeZip(outPath)
console.log(`已打包: ${outPath}（${[...rootFiles, ...distFiles].join(', ')}）`)
