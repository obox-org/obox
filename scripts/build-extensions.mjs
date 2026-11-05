/**
 * 系统扩展的构建（change `system-extensions-from-install-dir` 任务 4.1）。
 *
 * 为什么需要这一步：系统扩展在仓库里是源码目录（`system-extensions/<name>/`），
 * 而运行时只认"安装目录/扩展根"下的目录名 = 扩展 id。这里把它们**原样复制**到
 * `.extensions/<name>/`：
 * - 开发期：`getSystemExtensionsDir()` 指向 `.extensions`（与打包后同一套扫描规则）；
 * - 打包期：electron-builder `extraFiles` 把 `.extensions/*` 放进安装目录。
 *
 * 产物不入库：`.extensions/` 已在 .gitignore 里，构建一次即可。
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const sourceRoot = join(repo, 'system-extensions')
const outRoot = join(repo, '.extensions')

async function main() {
  await rm(outRoot, { recursive: true, force: true })
  await mkdir(outRoot, { recursive: true })
  let count = 0
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const from = join(sourceRoot, entry.name)
    const to = join(outRoot, entry.name)
    await cp(from, to, { recursive: true })
    count += 1
    console.log(`[build:extensions] ${entry.name} → .extensions/${entry.name}`)
  }
  console.log(`[build:extensions] 完成：${count} 个系统扩展`)
}

main().catch((error) => {
  console.error('[build:extensions] 失败：', error)
  process.exit(1)
})
