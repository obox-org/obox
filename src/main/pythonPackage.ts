/**
 * Python 运行时的**打包规划**（不依赖 electron，可单测；见 issue #51 / ADR-0018）。
 *
 * 扩展作者在**打包扩展时**用这些纯函数（配合 `scripts/build-python-runtime.mts`）：
 * 取对应架构的 python-build-standalone 归档 → 解压 → 按 {@link planRuntimeTrim} 裁剪 →
 * 用 uv 预置 wheel（{@link uvWheelInstallArgs}）→ {@link summarizeTree} 检查是否撞上 `.oix` 限额。
 *
 * 裁剪档位是访谈定下的"基线 `install_only_stripped` + 只删确定安全的"：归档本身已去掉 `.pdb`，
 * 再删 `include/`、`libs/`、`Lib/idlelib/`、`Lib/turtledemo/`。
 *
 * **不要**再删这些（ADR-0018 的不可删清单）：`tkinter`/`tcl`（交互式绘图）、`Lib/ensurepip`/`Lib/venv`/
 * `Lib/tomllib`（pip 与 venv）、`python3.dll`（abi3 轮子）、`_ssl`/`libssl`/`libcrypto`（HTTPS 与 hashlib）、
 * `unicodedata`、`sqlite3` 三件套；也**不要**删 `Lib/__pycache__`——省下的体积在可写目录里会被重新生成。
 */
import { createHash } from 'node:crypto'
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES } from './oixCore'
import type { PythonArch } from './pythonCore'

/** python-build-standalone 的目标三元组（Windows） */
export function pythonTargetTriple(arch: PythonArch): string {
  return arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
}

export interface RuntimeArchiveInput {
  /** CPython 版本（含补丁号，如 `3.13.16`） */
  pythonVersion: string
  /** python-build-standalone 的 release tag（如 `20261003`） */
  release: string
  arch: PythonArch
}

/** 归档文件名：用 `install_only_stripped`（已去调试符号，体积约为 `install_only` 的一半） */
export function runtimeArchiveName(input: RuntimeArchiveInput): string {
  return `cpython-${input.pythonVersion}+${input.release}-${pythonTargetTriple(input.arch)}-install_only_stripped.tar.gz`
}

/** 归档下载地址（GitHub Releases） */
export function runtimeDownloadUrl(input: RuntimeArchiveInput): string {
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${input.release}/${runtimeArchiveName(input)}`
}

/** 裁剪清单：给定解压后的相对路径，返回要删与要保留的（原样保留传入字符串） */
export function planRuntimeTrim(relPaths: readonly string[]): { remove: string[]; keep: string[] } {
  const remove: string[] = []
  const keep: string[] = []
  for (const raw of relPaths) {
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    const doomed =
      p === 'include' ||
      p.startsWith('include/') ||
      p === 'libs' ||
      p.startsWith('libs/') ||
      p === 'Lib/idlelib' ||
      p.startsWith('Lib/idlelib/') ||
      p === 'Lib/turtledemo' ||
      p.startsWith('Lib/turtledemo/')
    if (doomed) remove.push(raw)
    else keep.push(raw)
  }
  return { remove, keep }
}

/** 裁剪涉及的目录（打包时**按目录整体删除**，避免把空目录打进包） */
export const RUNTIME_TRIM_DIRS: readonly string[] = [
  'include',
  'libs',
  'Lib/idlelib',
  'Lib/turtledemo'
]

/**
 * 从清单里算出"应整体删除的裁剪目录"。
 *
 * `planRuntimeTrim` 给的是**文件级**判断；若只按文件删，会留下空的 `include/`、`libs/`、
 * `Lib/idlelib/` 等目录（真机跑打包任务时踩到）。打包侧应当按这里返回的目录递归删除。
 */
export function runtimeTrimDirs(relPaths: readonly string[]): string[] {
  const normalized = relPaths.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''))
  return RUNTIME_TRIM_DIRS.filter((dir) =>
    normalized.some((p) => p === dir || p.startsWith(`${dir}/`))
  )
}

export interface TreeEntry {
  /** 相对路径（posix 分隔） */
  path: string
  size: number
}

export interface TreeSummary {
  fileCount: number
  totalBytes: number
  /** 撞上的 `.oix` 限额；空数组表示没超 */
  over: Array<'entries' | 'bytes'>
}

/**
 * 汇总目录并检查 `.oix` 限额。
 * 超出会在安装时被 `too-large` 拒绝——最好在打包阶段就发现（限额常量与安装器同源）。
 */
export function summarizeTree(
  entries: readonly TreeEntry[],
  limits?: { maxEntries?: number; maxTotalBytes?: number }
): TreeSummary {
  const fileCount = entries.length
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
  const maxEntries = limits?.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxTotalBytes = limits?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const over: Array<'entries' | 'bytes'> = []
  if (fileCount > maxEntries) over.push('entries')
  if (totalBytes > maxTotalBytes) over.push('bytes')
  return { fileCount, totalBytes, over }
}

/** 目录指纹：按路径排序后哈希 `path\0size`，给打包清单留一个可复现的树摘要 */
export function treeDigest(entries: readonly TreeEntry[]): string {
  const hash = createHash('sha256')
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const entry of sorted) hash.update(`${entry.path}\0${entry.size}\n`)
  return hash.digest('hex')
}

export interface WheelInstallInput {
  arch: PythonArch
  /** 目标 Python 主次版本（如 `3.13`） */
  pythonVersion: string
  /** 安装目标目录（扩展包内 `python/Lib/site-packages`） */
  target: string
  /** 要预置的包要求（如 `['matplotlib==3.11.2']`） */
  requirements: readonly string[]
}

/**
 * uv 预置 wheel 的参数：`--python-platform` 让 uv **交叉取对应架构的 wheel**
 * （实测能取到 win_arm64 的 matplotlib/numpy），`--only-binary :all:` 禁止源码构建（用户机器没有编译器）。
 */
export function uvWheelInstallArgs(input: WheelInstallInput): string[] {
  return [
    'pip',
    'install',
    '--target',
    input.target,
    '--python-platform',
    pythonTargetTriple(input.arch),
    '--python-version',
    input.pythonVersion,
    '--only-binary',
    ':all:',
    '--upgrade',
    ...input.requirements
  ]
}

/** 写进扩展 manifest 的声明片段（安装期据此拒绝错架构的包，见 oixCore） */
export function runtimeManifestFields(input: { arch: PythonArch; pythonVersion: string }): {
  arch: PythonArch
  python: string
} {
  return { arch: input.arch, python: input.pythonVersion }
}
