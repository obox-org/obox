import { app, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createWindow, getMainWindow, registerWindowIpc } from './window'
import { createTray, destroyTray, isTrayActive } from './tray'
import { registerAutoStartIpc, startedByAutoStart } from './autoStart'
import {
  installWindowBehavior,
  isQuitting,
  loadWindowBehavior,
  markQuitting,
  migrateLegacyPreferences,
  registerWindowBehaviorIpc,
  showAboutDialog
} from './windowBehavior'
import { cleanupAllExtensionResources, cleanupExtensionResources } from './extensionCleanup'
import { secondaryInstanceNotice } from './singleInstanceCore'
import { registerCapabilityIpc } from './capabilities'
import { registerExtensionProtocol } from './protocol'
import {
  registerAppWindowIpc,
  closeAllAppWindowsOnMainClose,
  registerOverlayIpc
} from './appWindow'
import { registerOixIpc } from './oix'
import { registerUpdateIpc, onUpdateEvent } from './updater'
import { parseDebugExtensions, registerDebugIpc } from './debug'
import { registerDebugExtensionDirs } from './extensionDirs'
import { registerSqliteIpc } from './sqlite'
import { registerTimerIpc } from './timer'
import { registerNotificationIpc } from './notification'
import { registerNetIpc } from './net'
import { registerAiIpc } from './ai'
import { registerFsIpc } from './fs'
import { registerExtIpc } from './ext'
import { registerSecretsIpc } from './secrets'
import { registerUiIpc } from './ui'
import { registerIpcBridge } from './ipc'
import { registerPythonIpc } from './python'

/**
 * 确保主窗口存在并可见（启动、托盘"打开/设置"、第二实例唤前台与 macOS activate 共用）。
 * 窗口被销毁时重建——托盘常驻模式下"窗口没了"不该等于"应用没了"（ADR-0019 决策 6）。
 */
function ensureMainWindow(options: { hidden?: boolean } = {}): BrowserWindow {
  const existing = getMainWindow()
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }
  const created = createWindow({ startHidden: options.hidden })
  // 关闭拦截（收进托盘/弹提示）与"主窗口关闭时关闭所有 App 子窗口"
  installWindowBehavior(created, { trayAvailable: isTrayActive })
  closeAllAppWindowsOnMainClose(created)
  return created
}

// 单实例（ADR-0019 决策 9）：第二个进程不转发参数，只把已有主窗口唤到前台，并把"参数被忽略"写进日志
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.warn('[single-instance] ' + secondaryInstanceNotice(process.argv.slice(1), app.getName()))
}
if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    // 开机自启拉起的第二实例：静默退出，不把窗口抢到前台（ADR-0019 决策 13）
    if (startedByAutoStart(argv)) {
      console.log('[auto-start] 已有实例在运行：本次开机自启静默退出（不唤前台）')
      return
    }
    console.warn('[single-instance] ' + secondaryInstanceNotice(argv, app.getName()))
    ensureMainWindow()
  })
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) {
    app.exit(0)
    return
  }
  electronApp.setAppUserModelId('com.obox.app')

  // 关闭行为偏好（ADR-0019）：在主窗口创建前读入，坏文件回落默认
  loadWindowBehavior()
  // 更名迁移：新偏好文件不存在时读一次旧 window-behavior.json
  migrateLegacyPreferences()

  // 调试扩展（--debug-extension <id>@<path>，可重复）：不做 .oix 安装，经 app://debug/<id>/ 加载
  const debugExtensions = parseDebugExtensions(process.argv)
  // 供 api.python / api.ipc 解析“扩展自己的文件在哪”（调试扩展优先于 userData）
  registerDebugExtensionDirs(debugExtensions)

  // 注册 app:// 自定义协议：供渲染进程加载用户扩展入口（app://extensions/<id>/...）
  registerExtensionProtocol(debugExtensions)

  // 窗口控制 + 能力服务 + App 子窗口 IPC + .oix 安装 + 更新服务 + 调试扩展 + 扩展能力（sqlite/定时器/通知）
  registerWindowIpc()
  registerWindowBehaviorIpc()
  registerAutoStartIpc()
  registerCapabilityIpc()
  registerAppWindowIpc()
  // overlay 窗体四条 IPC（create/destroy/set-mouse-through/set-position，卡 03/14）：桌面宠物类
  // 后台扩展的常驻桌面小窗；作用域（只能操作自己创建的 overlay）由主进程按扩展 id 校验
  registerOverlayIpc()
  registerOixIpc()
  registerUpdateIpc()
  registerDebugIpc(debugExtensions)
  registerSqliteIpc()
  registerTimerIpc()
  registerNotificationIpc()
  registerNetIpc()
  // 「设置 → AI」的测试连接（宿主内部；在 netSession 上发 ⇒ 与 api.net.fetch 同一条代理链路）
  registerAiIpc()
  registerFsIpc()
  registerExtIpc()
  registerSecretsIpc()
  registerUiIpc()
  registerIpcBridge()
  registerPythonIpc()

  // 扩展停用/卸载/重载时清理其主进程资源（定时器 + 数据库连接 + 文件监听 + 系统通知 + IPC 通道 + Python 进程）
  ipcMain.handle('extension:cleanup', (_e, extId: string): void => {
    cleanupExtensionResources(String(extId))
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

  // 开机自启（注册项带 --autostart）：静默启动，不显示主窗口（ADR-0019 决策 13）
  const hiddenAtStartup = startedByAutoStart(process.argv)
  if (hiddenAtStartup) console.log('[auto-start] 由开机自启拉起：静默启动，只创建托盘')
  ensureMainWindow({ hidden: hiddenAtStartup })

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

// 退出前统一清理（ADR-0019 决策 10）：遍历"已知扩展"跑与热移除同一组清理。
// 动机有实测证据：宿主被强杀时 Python 对端会成为孤儿进程并占住 IPC 端点，下次启动报 not-connected。
app.on('before-quit', () => {
  markQuitting()
  destroyTray()
  void cleanupAllExtensionResources().then((result) => {
    const tail =
      (result.failed ? '，失败 ' + result.failed : '') + (result.timedOut ? '（超时兜底）' : '')
    console.log('[quit] 主进程资源清理完成：' + result.cleaned + ' 个扩展' + tail)
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
