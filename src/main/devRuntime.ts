/**
 * 「开发运行时」的扫描（electron 侧接线；纯解析在 `pythonDiscovery.ts`）。
 *
 * 两路来源：
 * 1. **内置**：`<userData>/extensions/<id>/runtime.json`（marker 文件判定，见 `parseRuntimeMarker`）；
 * 2. **本机**：Windows `py -0p` 启动器（带默认标记），回退 `where python`；没有版本的再补 `-V`。
 *
 * 失败策略：任何一路失败都返回空数组而不是抛错——设置页只是列个表，扫不到不该让整个页面崩。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  normalizeCandidates,
  parsePyLauncherList,
  parseRuntimeMarker,
  parseWhereOutput,
  RUNTIME_MARKER_FILE,
  type BuiltinRuntime,
  type PythonCandidate
} from './pythonDiscovery'
import { getUserExtensionsDir } from './paths'

const execFileAsync = promisify(execFile)

/** 扫描结果（IPC 载荷） */
export interface DevRuntimeScanResult {
  builtin: BuiltinRuntime[]
  local: PythonCandidate[]
}

/** 内置运行时：遍历扩展目录，读 marker；缺 `python/python.exe` 标 hasExecutable=false */
export async function collectBuiltinRuntimes(extensionsDir: string): Promise<BuiltinRuntime[]> {
  let names: string[]
  try {
    names = await readdir(extensionsDir)
  } catch {
    return []
  }
  const result: BuiltinRuntime[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const dir = join(extensionsDir, name)
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(join(dir, RUNTIME_MARKER_FILE), 'utf8')) as unknown
    } catch {
      continue // 没有 marker：普通扩展，跳过
    }
    const marker = parseRuntimeMarker(raw)
    if (!marker) continue
    result.push({
      extensionId: name,
      dir,
      version: marker.version,
      language: marker.language,
      hasExecutable: existsSync(join(dir, 'python', 'python.exe'))
    })
  }
  return result.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
}

/** 跑一条命令返回 stdout；失败返回 null（不抛） */
async function tryRun(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, { windowsHide: true, timeout: 5000 })
    return stdout
  } catch {
    return null
  }
}

/** 本机解释器：py 启动器优先，回退 where；缺版本的补 `python -V` */
export async function collectLocalPythons(): Promise<PythonCandidate[]> {
  const pyList = await tryRun('py', ['-0p'])
  let candidates = pyList ? parsePyLauncherList(pyList) : []
  if (candidates.length === 0) {
    const whereOut = await tryRun('where', ['python'])
    candidates = whereOut ? parseWhereOutput(whereOut) : []
  }
  for (const candidate of candidates) {
    if (candidate.version) continue
    const versionOut = await tryRun(candidate.path, ['-V'])
    const match = versionOut?.match(/Python\s+(\d+\.\d+)/i)
    if (match) candidate.version = match[1]
  }
  return normalizeCandidates(candidates)
}

/** 一次扫描两路来源 */
export async function scanDevRuntimes(): Promise<DevRuntimeScanResult> {
  const [builtin, local] = await Promise.all([
    collectBuiltinRuntimes(getUserExtensionsDir()),
    collectLocalPythons()
  ])
  return { builtin, local }
}
