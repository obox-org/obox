/**
 * 主进程路径约定（独立成模块）。
 *
 * 存在的理由：`capabilities.ts` 需要调用 `hookRunner.ts` 的钩子执行，而 `hookRunner.ts` 需要扩展目录路径——
 * 若路径函数留在 `capabilities.ts`，两者就形成循环依赖。抽到这里后依赖是单向的。
 */
import { app } from 'electron'
import { join } from 'path'

/** 用户扩展目录：userData/extensions */
export function getUserExtensionsDir(): string {
  return join(app.getPath('userData'), 'extensions')
}

/** 内置扩展目录（打包后 resources/extensions；开发期返回 null，由渲染进程走 Vite） */
export function getBuiltinExtensionsDir(): string {
  return join(process.resourcesPath, 'extensions')
}
