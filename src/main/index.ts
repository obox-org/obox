import { app, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createWindow, getMainWindow, registerWindowIpc } from './window'
import { createTray, isTrayActive } from './tray'
import {
  installWindowBehavior,
  isQuitting,
  loadWindowBehavior,
  markQuitting,
  registerWindowBehaviorIpc,
  showAboutDialog
} from './windowBehavior'
import { registerCapabilityIpc } from './capabilities'
import { registerExtensionProtocol } from './protocol'
import { registerAppWindowIpc, closeAllAppWindowsOnMainClose } from './appWindow'
import { registerOixIpc } from './oix'
import { registerUpdateIpc, onUpdateEvent } from './updater'
import { parseDebugExtensions, registerDebugIpc } from './debug'
import { registerDebugExtensionDirs } from './extensionDirs'
import { registerSqliteIpc, closeExtensionDbs } from './sqlite'
import { registerTimerIpc, closeExtensionTimers } from './timer'
import { registerNotificationIpc, closeExtensionNotifications } from './notification'
import { registerNetIpc } from './net'
import { registerFsIpc, closeExtensionWatchers } from './fs'
import { registerExtIpc } from './ext'
import { registerSecretsIpc } from './secrets'
import { registerUiIpc } from './ui'
import { registerIpcBridge, closeExtensionIpc } from './ipc'
import { registerPythonIpc, closeExtensionPython } from './python'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.obox.app')

  // 关闭行为偏好（ADR-0019）：在主窗口创建前读入，坏文件回落默认
  loadWindowBehavior()

  // 调试扩展（--debug-extension <id>@<path>，可重复）：不做 .oix 安装，经 app://debug/<id>/ 加载
  const debugExtensions = parseDebugExtensions(process.argv)
  // 供 api.python / api.ipc 解析“扩展自己的文件在哪”（调试扩展优先于 userData）
  registerDebugExtensionDirs(debugExtensions)

  // 注册 app:// 自定义协议：供渲染进程加载用户扩展入口（app://extensions/<id>/...）
  registerExtensionProtocol(debugExtensions)

  // 窗口控制 + 能力服务 + App 子窗口 IPC + .oix 安装 + 更新服务 + 调试扩展 + 扩展能力（sqlite/定时器/通知）
  registerWindowIpc()
  registerWindowBehaviorIpc()
  registerCapabilityIpc()
  registerAppWindowIpc()
  registerOixIpc()
  registerUpdateIpc()
  registerDebugIpc(debugExtensions)
  registerSqliteIpc()
  registerTimerIpc()
  registerNotificationIpc()
  registerNetIpc()
  registerFsIpc()
  registerExtIpc()
  registerSecretsIpc()
  registerUiIpc()
  registerIpcBridge()
  registerPythonIpc()

  // 扩展停用/卸载/重载时清理其主进程资源（定时器 + 数据库连接 + 文件监听 + 系统通知 + IPC 通道 + Python 进程）
  ipcMain.handle('extension:cleanup', (_e, extId: string): void => {
    closeExtensionTimers(String(extId))
    closeExtensionDbs(String(extId))
    closeExtensionWatchers(String(extId))
    closeExtensionNotifications(String(extId))
    closeExtensionIpc(String(extId))
    closeExtensionPython(String(extId))
  })

  // 更新事件广播到所有窗口（渲染进程扩展订阅）
  onUpdateEvent((e) => {
    const payload = {
      type: e.type,
      info: e.type === 'update-available' ? e.info : undefined,
      percent: e.type === 'download-progress' ? (e as { percent: number }).percent : undefined,
      bytesPerSecond:
        e.type === 'download-progress'
          ? (e as { bytesPerSecond: number }).bytesPerSecond
          : undefined,
      transferred:
        e.type === 'download-progress' ? (e as { transferred: number }).transferred : undefined,
      total: e.type === 'download-progress' ? (e as { total: number }).total : undefined,
      message: e.type === 'error' ? (e as { message: string }).message : undefined,
      version: e.type === 'update-downloaded' ? (e as { version: string }).version : undefined
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('update:event', payload)
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  /**
   * 确保主窗口存在并可见（托盘"打开/设置"与 macOS activate 共用）。
   * 窗口被销毁时重建——托盘常驻模式下"窗口没了"不该等于"应用没了"（ADR-0019 决策 6）。
   */
  const ensureMainWindow = (): BrowserWindow => {
    const existing = getMainWindow()
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }
    const created = createWindow()
    // 关闭拦截（收进托盘/弹提示）与"主窗口关闭时关闭所有 App 子窗口"
    installWindowBehavior(created, { trayAvailable: isTrayActive })
    closeAllAppWindowsOnMainClose(created)
    return created
  }

  ensureMainWindow()

  // 系统托盘（仅 Windows）：右键 打开/设置/关于/退出，双击打开（ADR-0019 决策 3/4）
  const SETTINGS_NAV_ID = 'settings.main' // 内置 settings 扩展声明的导航项 id
  createTray({
    open: () => void ensureMainWindow(),
    settings: () => {
      const win = ensureMainWindow()
      win.webContents.send('nav:open', SETTINGS_NAV_ID)
    },
    about: () => showAboutDialog(getMainWindow() ?? undefined),
    quit: () => {
      markQuitting()
      app.quit()
    }
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) ensureMainWindow()
  })
})

app.on('window-all-closed', () => {
  // 托盘常驻 + 未在退出流程时，窗口被销毁不等于退出（ADR-0019 决策 6）；
  // 真正退出走托盘"退出"或偏好=退出（那时 quitting 已置位）
  if (isTrayActive() && !isQuitting()) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
