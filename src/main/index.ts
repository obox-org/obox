import { app, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createWindow, registerWindowIpc } from './window'
import { registerCapabilityIpc } from './capabilities'
import { registerExtensionProtocol } from './protocol'
import { registerAppWindowIpc, closeAllAppWindowsOnMainClose } from './appWindow'
import { registerOixIpc } from './oix'
import { registerUpdateIpc, onUpdateEvent } from './updater'
import { parseDebugExtensions, registerDebugIpc } from './debug'
import { registerSqliteIpc, closeExtensionDbs } from './sqlite'
import { registerTimerIpc, closeExtensionTimers } from './timer'
import { registerNotificationIpc } from './notification'
import { registerNetIpc } from './net'
import { registerFsIpc, closeExtensionWatchers } from './fs'
import { registerExtIpc } from './ext'
import { registerSecretsIpc } from './secrets'
import { registerUiIpc } from './ui'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.obox.app')

  // 调试扩展（--debug-extension <id>@<path>，可重复）：不做 .oix 安装，经 app://debug/<id>/ 加载
  const debugExtensions = parseDebugExtensions(process.argv)

  // 注册 app:// 自定义协议：供渲染进程加载用户扩展入口（app://extensions/<id>/...）
  registerExtensionProtocol(debugExtensions)

  // 窗口控制 + 能力服务 + App 子窗口 IPC + .oix 安装 + 更新服务 + 调试扩展 + 扩展能力（sqlite/定时器/通知）
  registerWindowIpc()
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

  // 扩展停用/卸载/重载时清理其主进程资源（定时器 + 数据库连接 + 文件监听）
  ipcMain.handle('extension:cleanup', (_e, extId: string): void => {
    closeExtensionTimers(String(extId))
    closeExtensionDbs(String(extId))
    closeExtensionWatchers(String(extId))
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

  const main = createWindow()
  // 主窗口关闭时关闭所有 App 子窗口
  closeAllAppWindowsOnMainClose(main)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
