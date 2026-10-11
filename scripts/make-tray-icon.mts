/**
 * 由 `build/icon.png` 生成托盘图标 `resources/tray.ico`（ADR-0019 决策 3）。
 *
 *   node scripts/make-tray-icon.mts
 *
 * 为什么单独一份资源：Windows 通知区域的图标实际按 16×16（高 DPI 下 20/24/32）显示，
 * 直接用 256×256 的应用图标缩下去会糊。这里交给 `png-to-ico`（已是 devDependency）生成 ICO，
 * 产物**提交进仓库**（托盘图标是可见元素，不该依赖构建期联网/额外工具）。
 *
 * 注意：本脚本只依赖 `png-to-ico` 与 node:fs（不 import src/ 下的模块）——Node 原生跑 .mts 时
 * 无法解析 src 内部的无扩展名 import，这是踩过的坑（见 skills 的 troubleshooting）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pngToIco from 'png-to-ico'

const root = join(import.meta.dirname, '..')
const source = join(root, 'build', 'icon.png')
const target = join(root, 'resources', 'tray.ico')

const buffer = await pngToIco(source)
writeFileSync(target, buffer)
console.log(`[tray-icon] ${source} → ${target}（${buffer.length} 字节）`)
