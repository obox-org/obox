import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { join } from 'path'
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
import { currentProxy } from './proxy'
import { registerAiIpc } from './ai'
import { registerFsIpc } from './fs'
import { registerExtIpc } from './ext'
import { registerSecretsIpc } from './secrets'
import { registerUiIpc } from './ui'
import { registerIpcBridge } from './ipc'
import { registerPythonIpc } from './python'
import {
  DEFAULT_HOST_API_VERSION,
  createExtensionHostStarter,
  type ExtensionHostStarter
} from './extensionHostStarter'
import {
  createInitEnvelope,
  validateEnvelope,
  type HostedExtensionInfo
} from '../shared/extensionHostProtocol'
// EH-B1：这两条是**宿主内部 RPC**（宿主进程 → main），不进扩展 API 面——扩展看到的是
// `api.net.fetch` / `api.clipboard`，这里只是宿主实现它们时向 main 借的两样东西。
import { CLIPBOARD_METHOD, PROXY_CONFIG_METHOD } from '../extension-host/capabilities/io'
import type {
  ExtensionHostStartOutcome,
  ExtensionHostStatusSnapshot,
  ProxyConfig
} from '../shared/types'

/**
 * 扩展宿主进程启动器（ADR-0026 / EH-A2）。**只注册、不启动**：`start()` 必须由渲染侧经
 * `eh:start` 主动请求（EH-A4 的交接），默认配置下永远不触发。
 * 放在模块级是因为退出清理（`before-quit`）在 `whenReady` 之外。
 */
let extensionHost: ExtensionHostStarter | null = null

/* -------------------------------------------------------------------------------------------- */
/* 扩展宿主 IPC（EH-A4）：名字与 preload 的 invoke 一一对应                                       */
/* -------------------------------------------------------------------------------------------- */

/** 渲染侧请求启动宿主（载荷 = `HostedExtensionInfo[]`） */
export const EH_START_IPC = 'eh:start'

/** 渲染侧主动停止宿主（幂等） */
export const EH_STOP_IPC = 'eh:stop'

/** 读状态快照（含崩溃原因）；端口状态另有 A2 的 `eh:get-port` */
export const EH_STATUS_IPC = 'eh:get-status'

/** 状态迁移的广播 channel（渲染侧 `window.eh.onStatus` 与 `window.events` 都听它） */
export const EH_STATUS_CHANNEL = 'eh:status'

/** 把宿主状态迁移广播给所有窗口（单个窗口抛错不得打断其它窗口） */
function broadcastExtensionHostStatus(status: ExtensionHostStatusSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(EH_STATUS_CHANNEL, status)
    } catch {
      // 窗口正在销毁：这次状态没人收，等下一次迁移
    }
  }
}

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
  const mainWindow = ensureMainWindow({ hidden: hiddenAtStartup })

  // 扩展宿主进程（ADR-0026 / EH-A2）的**注册接线**：通道 IPC（eh:get-port）+ 与主窗口同生共死
  // （closed ⇒ terminate/kill，宽限后强杀）。本卡不启动宿主，现有行为不变。
  const starter = createExtensionHostStarter({
    entryPoint: join(__dirname, 'extension-host.js'),
    dataDir: app.getPath('userData')
  })
  starter.registerIpc()
  starter.bindWindow(mainWindow)
  extensionHost = starter

  // ---- EH-A4：渲染侧请求式启动（回退开关的"开"这一半；"关"这一半在渲染侧，这里一次都不触发） ----
  // 为什么不在 whenReady 里无条件 start()：宿主能力目前多数是桩（会抛 EH_INTERNAL），默认必须让
  // 用户扩展继续在渲染进程执行。于是 main 只提供入口，**触发权在渲染侧的 `ehStart`**。
  ipcMain.handle(
    EH_START_IPC,
    async (_event, rawExtensions: unknown): Promise<ExtensionHostStartOutcome> => {
      if (!Array.isArray(rawExtensions)) {
        return {
          ok: false,
          code: 'EH_INTERNAL',
          message: 'eh:start 的载荷必须是用户扩展清单数组（HostedExtensionInfo[]）'
        }
      }
      const extensions = rawExtensions as HostedExtensionInfo[]
      // 形状兜底：借用协议自己的 init 信封校验（渲染侧已经校验过一遍，main 不信单侧）
      const probe = validateEnvelope(
        createInitEnvelope({
          apiVersion: DEFAULT_HOST_API_VERSION,
          dataDir: app.getPath('userData'),
          extensions
        })
      )
      if (!probe.ok) {
        return {
          ok: false,
          code: probe.code,
          message: '扩展清单形状不合法，已拒绝启动扩展宿主',
          detail: probe.why
        }
      }
      if (probe.env.t !== 'init') {
        // 不可能发生（上面构造的就是 init），写出来只是为了让类型收窄成 InitEnvelope
        return {
          ok: false,
          code: 'EH_INTERNAL',
          message: '扩展清单校验没有产出 init 信封（内部实现错误）'
        }
      }
      return await starter.start(probe.env.extensions)
    }
  )
  ipcMain.handle(EH_STOP_IPC, async (): Promise<void> => {
    await starter.stop()
  })
  ipcMain.handle(EH_STATUS_IPC, (): ExtensionHostStatusSnapshot => starter.getStatus())
  // 状态迁移（idle → starting → ready → …）推给窗口：A5 / 扩展管理器据此展示 phase 与崩溃原因
  starter.onStatus(broadcastExtensionHostStatus)

  // ---- EH-B1：宿主 → main 的两条内部 RPC（宿主能力实现用，不进扩展 API 面） ----
  // 1) 代理配置：宿主进程没有 Chromium session，`net.fetch` 只能自己应用代理/忽略 SSL，
  //    而唯一真相是 main 的 `currentProxy()`（渲染侧启动与改设置时经 `proxy:apply` 推入）。
  starter.registerMethod(PROXY_CONFIG_METHOD, (): { proxy?: ProxyConfig; ignoreSSL: boolean } => {
    const proxy = currentProxy()
    // `ignoreSSL` 是**独立开关**（与 main 的 `applyProxyToSession` 一致）：只看 `ignoreSSL === true`、
    // 不看 `enabled`，所以"关掉代理但仍忽略证书"这种组合也照原样继承过来。
    return { proxy: proxy ?? undefined, ignoreSSL: proxy?.ignoreSSL === true }
  })
  // 2) 剪贴板：Electron `clipboard` 只在 main/renderer 可用，宿主进程（utilityProcess）没有该模块
  starter.registerMethod(CLIPBOARD_METHOD, (params: unknown) => {
    const record: { action?: unknown; text?: unknown } =
      typeof params === 'object' && params !== null
        ? (params as { action?: unknown; text?: unknown })
        : {}
    try {
      if (record.action === 'read') return { ok: true, text: clipboard.readText() }
      if (record.action === 'write') {
        if (typeof record.text !== 'string') {
          return { ok: false, error: '写入剪贴板需要字符串 text' }
        }
        clipboard.writeText(record.text)
        return { ok: true }
      }
      return {
        ok: false,
        error: `未知的剪贴板操作（${String(record.action)}）：只支持 read / write`
      }
    } catch (error) {
      return {
        ok: false,
        error: `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  })

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
  // 扩展宿主随应用退出一起清理（幂等：窗口 closed 时可能已经清过；不 await 以免拖住退出）
  void extensionHost?.dispose()
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
