/**
 * 主进程路径约定（独立成模块）。
 *
 * 存在的理由：`capabilities.ts` 需要调用 `hookRunner.ts` 的钩子执行，而 `hookRunner.ts` 需要扩展目录路径——
 * 若路径函数留在 `capabilities.ts`，两者就形成循环依赖。抽到这里后依赖是单向的。
 */
import { app } from 'electron'
import { join } from 'path'
import { resolveExtensionDir } from './extensionDirs'

/** 用户扩展目录：userData/extensions */
export function getUserExtensionsDir(): string {
  return join(app.getPath('userData'), 'extensions')
}

/** 内置扩展目录（打包后 resources/extensions；开发期返回 null，由渲染进程走 Vite） */
export function getBuiltinExtensionsDir(): string {
  return join(process.resourcesPath, 'extensions')
}

/**
 * 扩展**源目录**（扩展自己的文件在哪）：调试扩展（`--debug-extension <id>@<dir>`）优先，
 * 否则 `<userData>/extensions/<id>`。
 *
 * 用途：找 `<扩展>/python/python.exe`（api.python）与 stdio 通道的程序（api.ipc）。
 * 修复的真实缺口：调试扩展的文件在任意本地目录，之前这两处只看 userData，导致用调试扩展开发
 * 带运行时的扩展时找不到自己的文件（GUI 级端到端验证时暴露）。
 */
export function extensionSourceDir(extId: string): string {
  return resolveExtensionDir(extId, getUserExtensionsDir())
}
