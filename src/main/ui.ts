/**
 * 窗口化 ui 模态框服务：扩展的 api.ui 模态框（quickPick/inputBox/form）按焦点窗口显示。
 * - 焦点在 App 子窗口：转发 'ui:show' 到该窗口渲染，结果经 'ui:result' 回传（requestId 关联，60s 超时）
 * - 否则：返回 { local: true }，主窗口宿主用本地 uiStore 渲染（现状）
 */
import { BrowserWindow, ipcMain } from 'electron'

interface PendingUi {
  resolve: (r: { local: boolean; canceled?: boolean; value?: unknown }) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<number, PendingUi>()
let seq = 0

export function registerUiIpc(): void {
  ipcMain.handle(
    'ui:show',
    (
      _e,
      req: { kind: string; payload: unknown }
    ): Promise<{ local: boolean; canceled?: boolean; value?: unknown }> => {
      const focused = BrowserWindow.getFocusedWindow()
      const isChild =
        focused && !focused.isDestroyed() && focused.webContents.getURL().includes('obox-window=app')
      if (!isChild) {
        // 主窗口（或无可聚焦子窗口）：主窗口宿主本地渲染
        return Promise.resolve({ local: true })
      }
      return new Promise((resolve) => {
        const requestId = ++seq
        const timer = setTimeout(() => {
          pending.delete(requestId)
          resolve({ local: false, canceled: true })
        }, 60_000)
        pending.set(requestId, { resolve, timer })
        focused.webContents.send('ui:show', {
          requestId,
          kind: req.kind,
          payload: req.payload
        })
      })
    }
  )

  ipcMain.on(
    'ui:result',
    (_e, r: { requestId: number; canceled: boolean; value?: unknown }): void => {
      const p = pending.get(r.requestId)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(r.requestId)
      p.resolve({ local: false, canceled: r.canceled, value: r.value })
    }
  )
}
