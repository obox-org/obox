/**
 * 生命周期钩子的**主进程接线**（electron 薄壳，见 issue #52）。
 *
 * 职责边界：协议状态机（超时/结算/三态语义）在 `hookBridge.ts`（electron-free，有单测）；
 * 这里只做两件事：找主窗口把请求发出去、把渲染进程的回包交给桥结算。
 *
 * 为什么钩子必须在渲染进程执行：扩展入口只在渲染进程被 import（`app://extensions/<id>/` + Cordis 服务），
 * 主进程没有等价的加载路径（见 #52 的落点讨论）。
 */
import { BrowserWindow, ipcMain } from 'electron'
import { createHookBridge, type HookRunOutcome } from './hookBridge'
import type { ExtensionHookRunResult } from '../shared/types'

/** 主窗口（排除 App 子窗口）：钩子由主窗口的扩展宿主执行 */
function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && !w.webContents.getURL().includes('obox-window=app')
  )
}

const bridge = createHookBridge({
  send: (request) => {
    const win = mainWindow()
    if (!win) throw new Error('主窗口不可用')
    win.webContents.send('extension:hook-request', request)
  }
})

/** 注册渲染进程的回包通道（幂等：重复注册只是多挂一个 listener，实际只注册一次） */
export function registerHookIpc(): void {
  ipcMain.on('extension:hook-result', (_e, result: ExtensionHookRunResult): void => {
    bridge.settle(result)
  })
}

/**
 * 请渲染进程执行扩展钩子。
 * 三种结果都要区分对待（见 `HookRunOutcome`）：
 * - 送达且 ok → 记录"该版本已跑过"；
 * - 送达但失败 → 记录已跑过（失败）并把失败归为激活失败（渲染进程侧设置）；
 * - 未送达 / `deferred` → **保留 pendingInstall**，下次启动扫描期补跑。
 */
export function runExtensionHook(input: {
  extId: string
  phase: 'install' | 'uninstall'
  version: string
  upgraded: boolean
  previousVersion?: string
}): Promise<HookRunOutcome> {
  return bridge.run(input)
}
