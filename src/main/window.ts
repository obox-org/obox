import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { WindowAction, WindowState } from '../shared/types'

let mainWindow: BrowserWindow | null = null

function getState(win: BrowserWindow): WindowState {
  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
    isFocused: win.isFocused()
  }
}

function pushState(win: BrowserWindow): void {
  if (!win.isDestroyed()) {
    win.webContents.send('window:state-changed', getState(win))
  }
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 400,
    show: false,
    // 无边框窗口：自绘标题栏
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    ...(process.platform === 'linux' ? { icon: join(__dirname, '../../resources/icon.png') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow = win

  win.on('ready-to-show', () => win.show())

  win.on('maximize', () => pushState(win))
  win.on('unmaximize', () => pushState(win))
  win.on('enter-full-screen', () => pushState(win))
  win.on('leave-full-screen', () => pushState(win))
  win.on('focus', () => pushState(win))
  win.on('blur', () => pushState(win))
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // 外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    void import('electron').then(({ shell }) => shell.openExternal(url))
    return { action: 'deny' }
  })

  // 渲染进程日志转发到主进程控制台（开发期观察扩展宿主运行）
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event
    const tag = `[renderer:${level}] ${sourceId}:${lineNumber}`
    // Electron 39 起 level 是字符串：'info' | 'warning' | 'error' | 'debug'
    if (level === 'error' || level === 'warning') console.error(tag, message)
    else console.log(tag, message)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer-gone]', details.reason, details.exitCode)
  })

  // HMR / 生产加载
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

export function registerWindowIpc(): void {
  ipcMain.handle('window:action', (_event, action: WindowAction): void => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (!win || win.isDestroyed()) return
    switch (action) {
      case 'minimize':
        win.minimize()
        break
      case 'toggle-maximize':
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
        break
      case 'close':
        win.close()
        break
    }
  })

  ipcMain.handle('window:get-state', (): WindowState | null => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    return win && !win.isDestroyed() ? getState(win) : null
  })

  // 开发辅助：渲染进程请求截图保存到磁盘（用于验证 UI）
  ipcMain.handle('window:capture', async (_e, outPath: string): Promise<string> => {
    const win = mainWindow
    if (!win || win.isDestroyed()) throw new Error('no window')
    const image = await win.webContents.capturePage()
    const { writeFile } = await import('fs/promises')
    await writeFile(outPath, image.toPNG())
    return outPath
  })

  // 开发辅助：在渲染进程执行 JS 并返回结果（用于验证 UI 状态）
  ipcMain.handle('window:eval', async (_e, script: string): Promise<unknown> => {
    const win = mainWindow
    if (!win || win.isDestroyed()) throw new Error('no window')
    return win.webContents.executeJavaScript(script)
  })
}
