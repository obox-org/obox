/**
 * 扩展**源目录**解析（不依赖 electron，可独立单测）。
 *
 * 扩展文件有两个来源：
 * - **已安装**：`<userData>/extensions/<扩展id>/`（.oix 安装）
 * - **调试扩展**：`--debug-extension <id>@<本地绝对路径>` 指定的任意目录（不经安装、重启即消失）
 *
 * 之前 `api.python`（找 `<扩展>/python/python.exe`）与 `api.ipc`（stdio 程序）都**只**看 userData 目录，
 * 于是用调试扩展开发带 Python 运行时的扩展时找不到自己的运行时——GUI 级端到端验证时暴露的真实缺口。
 * 这里把"该扩展的文件到底在哪"收敛成一个来源。
 */
import { join } from 'node:path'

/** 调试扩展目录（由主进程启动时登记；重启即清空） */
const debugDirs = new Map<string, string>()

/** 登记调试扩展（重复登记覆盖；非绝对路径由调用方保证） */
export function registerDebugExtensionDirs(entries: Iterable<readonly [string, string]>): void {
  for (const [id, dir] of entries) {
    if (id && dir) debugDirs.set(id, dir)
  }
}

/** 调试扩展目录（未登记返回 undefined） */
export function debugExtensionDir(extId: string): string | undefined {
  return debugDirs.get(extId)
}

/**
 * 扩展源目录：**调试扩展优先**，否则回落到 `<userData>/extensions/<id>`。
 * `userExtensionsBaseDir` 由调用方给出（主进程是 `getUserExtensionsDir()`），保持本模块无 electron 依赖。
 */
export function resolveExtensionDir(
  extId: string,
  userExtensionsBaseDir: string,
  debugDir: (id: string) => string | undefined = debugExtensionDir
): string {
  return debugDir(extId) ?? join(userExtensionsBaseDir, extId)
}

/** 仅供测试：清空登记 */
export function clearDebugExtensionDirs(): void {
  debugDirs.clear()
}
