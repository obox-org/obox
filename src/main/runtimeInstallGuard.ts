/**
 * 运行时包安装守卫（change「开发运行时」）。
 *
 * 规则（用户确认）：**同一个 Python 版本只允许一个内置运行时包**。
 * 这里只做两件纯 fs 的事，便于单测、也能在 `oixCore`（不依赖 electron）里复用：
 * 1. 读某个目录的 `runtime.json`；
 * 2. 在扩展根目录里找同版本的其他运行时包。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRuntimeMarker, RUNTIME_MARKER_FILE } from './pythonDiscovery'

/** 读目录里的运行时 marker；没有/坏 JSON/非 python 都返回 null */
export async function readRuntimeMarker(dir: string): Promise<{ version: string } | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, RUNTIME_MARKER_FILE), 'utf8')) as unknown
    const marker = parseRuntimeMarker(raw)
    return marker ? { version: marker.version } : null
  } catch {
    return null
  }
}

/** 在扩展根里找同版本运行时（`ignoreDirName` 用于覆盖安装自身） */
export async function findRuntimeVersionConflict(
  extensionsDir: string,
  version: string,
  ignoreDirName?: string
): Promise<string | null> {
  const target = version.trim()
  if (!target) return null
  let names: string[]
  try {
    names = await readdir(extensionsDir)
  } catch {
    return null
  }
  for (const name of names) {
    if (name.startsWith('.') || name === ignoreDirName) continue
    const marker = await readRuntimeMarker(join(extensionsDir, name))
    if (marker && marker.version === target) return name
  }
  return null
}
