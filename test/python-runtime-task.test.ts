/**
 * 打包任务的**真机执行**（issue #51）：把运行时归档解压、按既定档位裁剪、汇总并写出
 * `python-package.json`，最后断言仍在 `.oix` 限额内。
 *
 * **默认跳过**，只在设置了输出目录时运行（CI 不依赖下载、`npm test` 也不变慢）：
 *
 *   $env:OBOX_PACK_RUNTIME_OUT = "$env:TEMP\py-pack"
 *   $env:OBOX_PYTHON_ARCHIVE  = "$env:TEMP\obox-python-real\runtime.tar.gz"   # 可选：复用本地归档
 *   npx vitest run test/python-runtime-task.test.ts
 *
 * 为什么是"任务测试"而不是 `scripts/*.mts` CLI：Node 原生跑 `.mts` 时无法解析 `src/` 内部的无扩展名
 * import（项目风格就是无扩展名，`ipcTransport.ts` 里的 `'./ipcCore'` 就是例子），而 vitest 走 Vite 解析，
 * 可以直接复用 `src/main/pythonPackage.ts` 里那些**已有单测**的规划函数——不然就得把逻辑抄一份到脚本里。
 *
 * 需要 `uv` 在 PATH 上时才会预置 wheel（`OBOX_PACK_REQUIREMENTS`，逗号分隔）；否则只做裁剪与汇总。
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  planRuntimeTrim,
  runtimeTrimDirs,
  summarizeTree,
  treeDigest,
  uvWheelInstallArgs,
  type TreeEntry
} from '../src/main/pythonPackage'
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES } from '../src/main/oixCore'
import type { PythonArch } from '../src/main/pythonCore'

const outDir = process.env.OBOX_PACK_RUNTIME_OUT
const archive = process.env.OBOX_PYTHON_ARCHIVE
const arch = (process.env.OBOX_PACK_ARCH ?? 'x64') as PythonArch

async function listTree(root: string, current = root): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  for (const item of await fs.readdir(current, { withFileTypes: true })) {
    const abs = join(current, item.name)
    if (item.isDirectory()) {
      out.push(...(await listTree(root, abs)))
      continue
    }
    out.push({ path: relative(root, abs).split(sep).join('/'), size: (await fs.stat(abs)).size })
  }
  return out
}

describe.skipIf(!outDir)('打包任务：真实运行时归档 → 裁剪 → 汇总', () => {
  it('解压后裁剪，汇总结果在 .oix 限额内，并写出 python-package.json', async () => {
    const target = outDir as string
    // 注意：**不清理产物目录**——`<out>/python` 与 `python-package.json` 就是这个任务的交付物，
    // 作者随后要拿它去打包 .oix（清理掉就没意义了）
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(target, { recursive: true })

    // 1) 解压（有本地归档就用本地，否则要求调用方先准备好目录，避免测试里偷偷下载几十 MB）
    const pythonDir = join(target, 'python')
    if (archive) {
      const result = spawnSync('tar', ['-xzf', archive, '-C', target], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }
    expect(
      await fs
        .stat(pythonDir)
        .then(() => true)
        .catch(() => false)
    ).toBe(true)

    const before = await listTree(pythonDir)
    expect(before.length).toBeGreaterThan(1000)

    // 2) 裁剪：用与打包脚本同一份规划函数（有单测）。
    //    必须按**目录**整删——只按文件删会留下空目录，第一次真机跑这里就失败了
    const { remove } = planRuntimeTrim(before.map((entry) => entry.path))
    for (const dir of runtimeTrimDirs(before.map((entry) => entry.path))) {
      await fs.rm(join(pythonDir, ...dir.split('/')), { recursive: true, force: true })
    }
    expect(remove.length).toBeGreaterThan(0)
    for (const gone of ['include', 'libs', 'Lib/idlelib', 'Lib/turtledemo']) {
      const exists = await fs
        .stat(join(pythonDir, ...gone.split('/')))
        .then(() => true)
        .catch(() => false)
      expect(exists, `${gone} 应已被裁剪`).toBe(false)
    }

    // 3) 可选：预置 wheel（需要 uv 在 PATH 上）
    const requirements = (process.env.OBOX_PACK_REQUIREMENTS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (requirements.length > 0) {
      const args = uvWheelInstallArgs({
        arch,
        pythonVersion: process.env.OBOX_PACK_PYTHON ?? '3.13',
        target: join(pythonDir, 'Lib', 'site-packages'),
        requirements
      })
      const result = spawnSync('uv', args, { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }

    // 4) 汇总 + 留痕（限额常量与安装器同源）
    const after = await listTree(pythonDir)
    const summary = summarizeTree(after, {
      maxEntries: DEFAULT_MAX_ENTRIES,
      maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES
    })
    const manifest = {
      arch,
      python: process.env.OBOX_PACK_PYTHON ?? '3.13.16',
      fileCount: summary.fileCount,
      totalBytes: summary.totalBytes,
      treeDigest: treeDigest(after),
      requirements
    }
    await fs.writeFile(
      join(target, 'python-package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    )
    console.log(
      `[pack] 裁剪前 ${before.length} 个 → 裁剪后 ${summary.fileCount} 个 / ` +
        `${(summary.totalBytes / 1024 / 1024).toFixed(1)} MB，指纹 ${manifest.treeDigest.slice(0, 12)}…`
    )
    expect(summary.over, '不应超出 .oix 限额').toEqual([])
  }, 180_000)
})
