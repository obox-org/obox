import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/** 打开子窗口的请求（渲染进程 App 视图发起） */
export interface OpenAppWindowRequest {
  /** 插件卡片 id */
  appId: string
  /** 窗口标题（插件名） */
  title: string
  /** 是否允许多开 */
  multiOpen?: boolean
  /** 子窗口宽（默认 900） */
  width?: number
  /** 子窗口高（默认 640） */
  height?: number
}

/** 已打开的子窗口跟踪：appId → [BrowserWindow] */
const appWindows = new Map<string, BrowserWindow[]>()

function urlForChild(query: string): string {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}?${query}`
  }
  return `file://${join(__dirname, '../renderer/index.html').replace(/\\/g, '/')}?${query}`
}

function openChildWindow(req: OpenAppWindowRequest): BrowserWindow {
  const width = req.width ?? 900
  const height = req.height ?? 640
  const multiOpen = req.multiOpen ?? false
  const list = appWindows.get(req.appId) ?? []

  // 单开且已有窗口：聚焦并返回
  if (!multiOpen && list.length > 0) {
    const existing = list[list.length - 1]
    if (!existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return existing
    }
  }

  // 多开序号：当前数量 + 1
  const sequence = list.filter((w) => !w.isDestroyed()).length + 1

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 400,
    minHeight: 300,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    title: multiOpen && sequence > 1 ? `${req.title} ${sequence}` : req.title,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 子窗口参数：obox-window=app + appId + sequence
  const query = new URLSearchParams({
    'obox-window': 'app',
    appId: req.appId,
    sequence: String(sequence)
  })
  void win.loadURL(urlForChild(query.toString()))

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    const remaining = (appWindows.get(req.appId) ?? []).filter((w) => w !== win && !w.isDestroyed())
    if (remaining.length) appWindows.set(req.appId, remaining)
    else appWindows.delete(req.appId)
  })

  list.push(win)
  appWindows.set(req.appId, list)

  // 复用主窗口的渲染日志转发
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event
    const tag = `[child-renderer:${level}] ${sourceId}:${lineNumber}`
    if (level === 'error' || level === 'warning') console.error(tag, message)
    else console.log(tag, message)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[child-renderer-gone]', details.reason, details.exitCode)
  })

  return win
}

export function registerAppWindowIpc(): void {
  ipcMain.handle(
    'app:open-window',
    (_e, req: OpenAppWindowRequest): { appId: string; sequence: number } => {
      const win = openChildWindow(req)
      const list = appWindows.get(req.appId) ?? []
      return { appId: req.appId, sequence: list.indexOf(win) + 1 }
    }
  )
}

/** 主窗口关闭时关闭所有子窗口（在 createWindow 之后调用） */
export function closeAllAppWindowsOnMainClose(main: BrowserWindow): void {
  main.on('closed', () => {
    for (const list of appWindows.values()) {
      for (const win of list) {
        if (!win.isDestroyed()) win.close()
      }
    }
    appWindows.clear()
  })
}
