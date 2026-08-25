/**
 * 调试扩展能力（主进程）：解析 `--debug-extension <id>@<绝对路径>`（可重复）。
 * 调试扩展**不做 .oix 安装**：不写 userData、无安装时间戳，仅按参数把本地目录
 * 作为扩展源，经 app://debug/<id>/ 协议加载；重启后消失。
 */
import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { resolve } from 'path'
import type { DebugExtensionEntry } from '../shared/types'

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i

/** 调试扩展映射：id → 本地目录绝对路径 */
export type DebugExtensionsMap = Map<string, string>

/** 解析 --debug-extension <id>@<path>（可重复；非法项静默跳过） */
export function parseDebugExtensions(argv: string[]): DebugExtensionsMap {
  const map: DebugExtensionsMap = new Map()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--debug-extension') continue
    const spec = argv[i + 1]
    if (!spec) continue
    const at = spec.lastIndexOf('@')
    if (at <= 0 || at === spec.length - 1) continue
    const id = spec.slice(0, at)
    const path = spec.slice(at + 1)
    if (!ID_RE.test(id)) {
      console.warn(`[debug] 忽略非法调试扩展 id: ${id}`)
      continue
    }
    const abs = resolve(path)
    if (!existsSync(abs)) {
      console.warn(`[debug] 调试扩展路径不存在，忽略: ${id}@${abs}`)
      continue
    }
    map.set(id, abs)
  }
  return map
}

export function registerDebugIpc(debugExtensions: DebugExtensionsMap): void {
  ipcMain.handle('extensions:list-debug', (): DebugExtensionEntry[] =>
    [...debugExtensions.entries()].map(([id, path]) => ({ id, path }))
  )
}
