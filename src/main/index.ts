import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createWindow, registerWindowIpc } from './window'
import { registerCapabilityIpc } from './capabilities'
import { registerExtensionProtocol } from './protocol'
import { registerAppWindowIpc, closeAllAppWindowsOnMainClose } from './appWindow'
import { registerOixIpc } from './oix'
import { registerUpdateIpc, onUpdateEvent } from './updater'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.obox.app')

  // 注册 app:// 自定义协议：供渲染进程加载用户扩展入口（app://extensions/<id>/...）
  registerExtensionProtocol()

  // 窗口控制 + 能力服务 + App 子窗口 IPC + .oix 安装 + 更新服务
  registerWindowIpc()
  registerCapabilityIpc()
  registerAppWindowIpc()
  registerOixIpc()
  registerUpdateIpc()

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
