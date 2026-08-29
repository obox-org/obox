/**
 * 扩展杂项能力：api.dialog / api.shell / api.clipboard / api.window.setProgressBar。
 * 都是 Electron 现成能力的薄 IPC 封装。
 */
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'

export function registerExtIpc(): void {
  // ---- 对话框 ----
  ipcMain.handle(
    'dialog:open',
    async (
      _e,
      opts: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; multiSelect?: boolean }
    ): Promise<{ ok: boolean; filePaths?: string[]; canceled?: boolean; error?: string }> => {
      try {
        const win = BrowserWindow.getFocusedWindow()
        const result = win
          ? await dialog.showOpenDialog(win, {
              title: opts?.title,
              filters: opts?.filters,
              properties: ['openFile', ...(opts?.multiSelect ? ['multiSelections' as const] : [])]
            })
          : await dialog.showOpenDialog({
              title: opts?.title,
              filters: opts?.filters,
              properties: ['openFile', ...(opts?.multiSelect ? ['multiSelections' as const] : [])]
            })
        return { ok: true, filePaths: result.filePaths, canceled: result.canceled }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'dialog:save',
    async (
      _e,
      opts: { title?: string; defaultName?: string; filters?: Array<{ name: string; extensions: string[] }> }
    ): Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }> => {
      try {
        const win = BrowserWindow.getFocusedWindow()
        const result = win
          ? await dialog.showSaveDialog(win, { title: opts?.title, defaultPath: opts?.defaultName, filters: opts?.filters })
          : await dialog.showSaveDialog({ title: opts?.title, defaultPath: opts?.defaultName, filters: opts?.filters })
        return { ok: true, filePath: result.filePath ?? undefined, canceled: result.canceled }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'dialog:message',
    async (
      _e,
      opts: { type?: 'info' | 'warning' | 'error' | 'question'; title?: string; message?: string; detail?: string; buttons?: string[] }
    ): Promise<{ ok: boolean; response?: number; error?: string }> => {
      try {
        const win = BrowserWindow.getFocusedWindow()
        const options = {
          type: opts?.type ?? 'info',
          title: opts?.title,
          message: opts?.message ?? '',
          detail: opts?.detail,
          buttons: opts?.buttons && opts.buttons.length > 0 ? opts.buttons : undefined
        }
        const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
        return { ok: true, response: result.response }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ---- 打开外部链接 / 路径 ----
  ipcMain.handle(
    'shell:open-external',
    async (_e, url: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: 'openExternal 仅支持 http/https 链接' }
        }
        await shell.openExternal(url)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'shell:open-path',
    async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (typeof p !== 'string' || !p) return { ok: false, error: 'path 必填' }
        const errMsg = await shell.openPath(p)
        return errMsg ? { ok: false, error: errMsg } : { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ---- 剪贴板 ----
  ipcMain.handle('clipboard:read-text', (): string => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (_e, text: string): void => {
    clipboard.writeText(String(text ?? ''))
  })

  // ---- 主窗口任务栏进度 ----
  ipcMain.handle(
    'window:set-progress-bar',
    (_e, progress: number | null): void => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !w.webContents.getURL().includes('obox-window=app')
      )
      if (!win) return
      if (progress === null || progress === undefined) {
        win.setProgressBar(-1)
        return
      }
      win.setProgressBar(Math.min(1, Math.max(0, Number(progress))))
    }
  )
}
