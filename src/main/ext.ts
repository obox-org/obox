/**
 * 扩展杂项能力：api.dialog / api.shell / api.clipboard / api.window.setProgressBar。
 * 都是 Electron 现成能力的薄 IPC 封装。
 */
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { DialogOpenOptions, DialogOpenResult, DialogProperty } from '../shared/types'

/** 归一后的对话框属性（顺序固定：openDirectory 模式在前，multiSelections 追加在后） */
export type NormalizedDialogProperties = Array<'openFile' | 'openDirectory' | 'multiSelections'>

/** `properties` 的合法取值（未知字符串一律忽略，不抛错） */
const KNOWN_DIALOG_PROPERTIES: readonly DialogProperty[] = [
  'openFile',
  'openDirectory',
  'multiSelections'
]

/**
 * 归一 `dialog:open` 的 `properties`（**纯函数**，不碰 Electron，单测直接调）。
 *
 * 规则（spec §9.11 H-1）：
 * - 不传 / 传空数组 ⇒ `['openFile']`（**既有默认行为逐字不变**）
 * - `openDirectory` 与 `openFile` **互斥**：出现 `openDirectory` 即按目录模式归一，
 *   只保留 `openDirectory`（+ 可选的 `multiSelections`），丢弃 `openFile`
 * - 未知值**忽略**（不得抛错）
 * - `multiSelect` 旧字段继续兼容（等价于 `multiSelections`）
 *
 * 注意：`filters` **不在这里处理**——目录模式下是否传 filters 由调用方按
 * `isDirectoryProperties()` 判定丢弃（Electron 不对目录应用过滤器）。
 */
export function normalizeDialogProperties(
  opts?: Pick<DialogOpenOptions, 'properties' | 'multiSelect'> | null
): NormalizedDialogProperties {
  const requested = Array.isArray(opts?.properties) ? opts.properties : []
  const known = requested.filter((p): p is DialogProperty =>
    KNOWN_DIALOG_PROPERTIES.includes(p as DialogProperty)
  )
  // 旧字段 `multiSelect` 继续兼容：与 properties 里的 `multiSelections` 等价
  const wantsMulti = known.includes('multiSelections') || opts?.multiSelect === true
  if (known.includes('openDirectory')) {
    return ['openDirectory', ...(wantsMulti ? ['multiSelections' as const] : [])]
  }
  return ['openFile', ...(wantsMulti ? ['multiSelections' as const] : [])]
}

/** 归一结果是否为"选目录"模式（目录模式下 filters 必须丢弃） */
export function isDirectoryProperties(props: NormalizedDialogProperties): boolean {
  return props.includes('openDirectory')
}

export function registerExtIpc(): void {
  // ---- 对话框 ----
  ipcMain.handle('dialog:open', async (_e, opts: DialogOpenOptions): Promise<DialogOpenResult> => {
    try {
      const properties = normalizeDialogProperties(opts)
      // 目录模式下丢弃 filters：Electron 不对目录应用过滤器
      const filters = isDirectoryProperties(properties) ? undefined : opts?.filters
      const win = BrowserWindow.getFocusedWindow()
      const result = win
        ? await dialog.showOpenDialog(win, { title: opts?.title, filters, properties })
        : await dialog.showOpenDialog({ title: opts?.title, filters, properties })
      return { ok: true, filePaths: result.filePaths, canceled: result.canceled }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'dialog:save',
    async (
      _e,
      opts: {
        title?: string
        defaultName?: string
        filters?: Array<{ name: string; extensions: string[] }>
      }
    ): Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }> => {
      try {
        const win = BrowserWindow.getFocusedWindow()
        const result = win
          ? await dialog.showSaveDialog(win, {
              title: opts?.title,
              defaultPath: opts?.defaultName,
              filters: opts?.filters
            })
          : await dialog.showSaveDialog({
              title: opts?.title,
              defaultPath: opts?.defaultName,
              filters: opts?.filters
            })
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
      opts: {
        type?: 'info' | 'warning' | 'error' | 'question'
        title?: string
        message?: string
        detail?: string
        buttons?: string[]
      }
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
        const result = win
          ? await dialog.showMessageBox(win, options)
          : await dialog.showMessageBox(options)
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

  // ---- 剪贴板（Electron 44 起主进程 clipboard 为异步 API：readText/writeText 返回 Promise）----
  ipcMain.handle('clipboard:read-text', (): Promise<string> => clipboard.readText())
  ipcMain.handle('clipboard:write-text', async (_e, text: string): Promise<void> => {
    await clipboard.writeText(String(text ?? ''))
  })

  // ---- 主窗口任务栏进度 ----
  ipcMain.handle('window:set-progress-bar', (_e, progress: number | null): void => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes('obox-window=app')
    )
    if (!win) return
    if (progress === null || progress === undefined) {
      win.setProgressBar(-1)
      return
    }
    win.setProgressBar(Math.min(1, Math.max(0, Number(progress))))
  })
}
