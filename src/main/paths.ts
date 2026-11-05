/**
 * 主进程路径约定（独立成模块）。
 *
 * 存在的理由：`capabilities.ts` 需要调用 `hookRunner.ts` 的钩子执行，而 `hookRunner.ts` 需要扩展目录路径——
 * 若路径函数留在 `capabilities.ts`，两者就形成循环依赖。抽到这里后依赖是单向的。
 */
import { app } from 'electron'
import { dirname, join } from 'path'
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
/**
 * 系统扩展目录（提案 `system-extensions-from-install-dir` D-1/D-6）：
 * - 打包后：`<安装目录>/extensions`（electron-builder `extraFiles` 落在 exe 同级）
 * - 开发期：`<仓库>/.build/extensions`（`npm run build:extensions` 的产物）
 *
 * 为什么不复用 `resources/extensions`：`process.resourcesPath` 指向 `resources/`，
 * 而需求要求系统扩展放在**安装目录**下；`extraFiles` 正好落在 exe 旁边。
 * 开发期回落到 `.build/extensions` 而不是仓库 `extensions/`：后者是**用户扩展**的开发副本，
 * 按 author 会被判成用户扩展，混在一起会误报"系统扩展 author 不是 obox"。
 */
export function getSystemExtensionsDir(): string {
  return app.isPackaged
    ? join(dirname(process.execPath), 'extensions')
    : // 开发期用 cwd：`app.getAppPath()` 在 `electron out/main/index.js` 下等于入口目录
      // （`<repo>/out/main`），拿不到仓库根；electron-vite dev/preview 的 cwd 就是仓库根。
      join(process.cwd(), '.build', 'extensions')
}

/** 两个扩展根（扫描、协议解析、卸载都从这里取，避免各处各拼一次） */
export function getExtensionRoots(): { systemRoot: string; userRoot: string } {
  return { systemRoot: getSystemExtensionsDir(), userRoot: getUserExtensionsDir() }
}
