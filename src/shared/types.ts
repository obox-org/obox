/**
 * 主进程 / preload / 渲染进程 共享的 IPC 契约类型。
 * 扩展 API 类型见 src/renderer/src/core/types.ts（面向扩展作者）。
 */

/** 窗口控制动作 */
export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'

/** 窗口状态快照（渲染进程自绘标题栏需要） */
export interface WindowState {
  isMaximized: boolean
  isFullScreen: boolean
  isFocused: boolean
}

/** 应用信息 */
export interface AppInfo {
  name: string
  version: string
}

/** 用户扩展目录下的一个扩展（由主进程扫描，供渲染进程加载/管理） */
export interface UserExtensionEntry {
  /** 目录名（= 扩展 id） */
  id: string
  /** 绝对路径（渲染进程经 app:// 协议访问，不可直接读盘） */
  path: string
}

/** 渲染进程 → 主进程 的调用（invoke） */
export interface MainApi {
  /** 窗口控制 */
  windowAction(action: WindowAction): Promise<void>
  getWindowState(): Promise<WindowState>
  /** 应用信息 */
  getAppInfo(): Promise<AppInfo>
  /** 用户扩展目录扫描（返回 userData/extensions 下的扩展目录清单） */
  listUserExtensions(): Promise<UserExtensionEntry[]>
  /** 卸载用户扩展（删除 userData/extensions/<id> 目录） */
  uninstallUserExtension(id: string): Promise<void>
  /** 运行用户扩展的卸载钩子（若有），返回是否成功 */
  runUninstallHook(id: string): Promise<boolean>
  /** 开发辅助：截图窗口内容到磁盘，返回保存路径 */
  capture(outPath: string): Promise<string>
  /** 开发辅助：在渲染进程执行 JS 并返回结果 */
  eval(script: string): Promise<unknown>
  /** 打开 App 子窗口（返回打开结果；单开时聚焦已有窗口） */
  openAppWindow(req: {
    appId: string
    title: string
    multiOpen?: boolean
    width?: number
    height?: number
  }): Promise<{ appId: string; sequence: number }>
}

/** 主进程 → 渲染进程 的事件（on） */
export interface MainEvents {
  /** 窗口状态变化（最大化/还原/全屏/聚焦） */
  'window:state-changed': (state: WindowState) => void
}
