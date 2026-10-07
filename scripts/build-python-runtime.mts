/**
 * 把 Python 运行时打进扩展包（扩展作者在**打包扩展时**运行；见 issue #51 / ADR-0018）。
 *
 *   node scripts/build-python-runtime.mts --arch x64 --python 3.13.16 --release 20261003 \
 *     --out extensions/my-py-ext --requirements matplotlib==3.11.2
 *
 * 做四件事：下载 `install_only_stripped` 归档 → 解压 → 按既定档位裁剪 → 用 uv 预置 wheel，
 * 最后写 `<out>/python-package.json`（树指纹 + 体积/条目 + 是否撞 `.oix` 限额）并在超限时退出码 1。
 *
 * 规划逻辑（三元组、裁剪清单、限额汇总、uv 参数）都在 `src/main/pythonPackage.ts`，有单测；
 * 这里只做 I/O，所以刻意保持薄。
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  planRuntimeTrim,
  runtimeArchiveName,
  runtimeDownloadUrl,
  summarizeTree,
  treeDigest,
  uvWheelInstallArgs,
  type TreeEntry
} from '../src/main/pythonPackage.ts'
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES } from '../src/main/oixCore.ts'
import type { PythonArch } from '../src/main/pythonCore.ts'

interface CliOptions {
  arch: PythonArch
  pythonVersion: string
  release: string
  out: string
  requirements: string[]
  archive?: string
  skipWheels: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const arch = get('arch') ?? 'x64'
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`--arch 只能是 x64 或 arm64（收到 ${arch}）`)
  }
  const pythonVersion = get('python')
  const release = get('release')
  const out = get('out')
  if (!pythonVersion || !release || !out) {
    throw new Error('必填：--python <3.13.16> --release <20261003> --out <扩展目录>')
  }
  const requirements = (get('requirements') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return {
    arch,
    pythonVersion,
    release,
    out: resolve(out),
    requirements,
    archive: get('archive'),
    skipWheels: argv.includes('--skip-wheels') || requirements.length === 0
  }
}

/** 递归列出目录（相对路径一律用 posix 分隔，便于跨平台比对） */
async function listTree(root: string, current = root): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  for (const item of await readdir(current, { withFileTypes: true })) {
    const abs = join(current, item.name)
    if (item.isDirectory()) {
      out.push(...(await listTree(root, abs)))
      continue
    }
    const info = await stat(abs)
    out.push({ path: relative(root, abs).split(sep).join('/'), size: info.size })
  }
  return out
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status} ${res.statusText}: ${url}`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
}

function run(program: string, args: string[], cwd?: string): void {
  const result = spawnSync(program, args, { cwd, stdio: 'inherit', shell: false })
  if (result.error) throw new Error(`无法执行 ${program}：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${program} 退出码 ${String(result.status)}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const pythonDir = join(options.out, 'python')
  const work = await mkdtemp(join(tmpdir(), 'obox-py-runtime-'))
  try {
    // 1) 取归档（默认下载；--archive 可指向本地文件，便于离线/复用）
    const archive = options.archive
      ? resolve(options.archive)
      : join(work, runtimeArchiveName(options))
    if (!options.archive) {
      const url = runtimeDownloadUrl(options)
      console.log(`[python] 下载 ${url}`)
      await download(url, archive)
    }
    const archiveInfo = await stat(archive)
    console.log(`[python] 归档 ${(archiveInfo.size / 1024 / 1024).toFixed(1)} MB`)

    // 2) 解压到 <out>/python（归档内是单层 python/ 目录）
    await rm(pythonDir, { recursive: true, force: true })
    run('tar', ['-xzf', archive, '-C', options.out])
    console.log(`[python] 已解压到 ${pythonDir}`)

    // 3) 裁剪（既定档位；规划逻辑有单测）
    const before = await listTree(pythonDir)
    const { remove } = planRuntimeTrim(before.map((entry) => entry.path))
    for (const rel of remove) await rm(join(pythonDir, rel), { recursive: true, force: true })
    const removedDirs = new Set(remove.map((p) => p.split('/')[0]))
    console.log(`[python] 裁剪 ${remove.length} 项（涉及 ${[...removedDirs].join(', ')}）`)

    // 4) 预置 wheel（交叉取对应架构；用户机器没有编译器，所以只允许 wheel）
    if (!options.skipWheels) {
      const target = join(pythonDir, 'Lib', 'site-packages')
      const args = uvWheelInstallArgs({
        arch: options.arch,
        pythonVersion: options.pythonVersion.replace(/\.\d+$/, ''),
        target,
        requirements: options.requirements
      })
      console.log(`[python] uv ${args.join(' ')}`)
      run('uv', args)
    }

    // 5) 汇总 + 留痕
    const after = await listTree(pythonDir)
    const summary = summarizeTree(after, {
      maxEntries: DEFAULT_MAX_ENTRIES,
      maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES
    })
    const manifest = {
      arch: options.arch,
      python: options.pythonVersion,
      release: options.release,
      fileCount: summary.fileCount,
      totalBytes: summary.totalBytes,
      treeDigest: treeDigest(after),
      requirements: options.requirements
    }
    await writeFile(
      join(options.out, 'python-package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    )
    console.log(
      `[python] ${summary.fileCount} 个文件 / ${(summary.totalBytes / 1024 / 1024).toFixed(1)} MB` +
        `（裁剪前 ${before.length} 个）`
    )
    console.log(
      `[python] manifest 需声明：{"arch": "${options.arch}", "python": "${options.pythonVersion}"}`
    )
    if (summary.over.length > 0) {
      console.error(
        `[python] ✗ 超出 .oix 限额：${summary.over.join(', ')}（安装时会被 too-large 拒绝）`
      )
      process.exitCode = 1
      return
    }
    console.log('[python] ✓ 在 .oix 限额内')
    console.log('[python] 下一步：把 manifest.json + 入口 + python/ 压平到 zip 根打包成 .oix')
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

await main()
