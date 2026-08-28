/**
 * 扩展系统提醒服务（操作系统通知 API）。
 * - api.notification.show({title, body, icon?, onClick?})
 * - 点击通知 → 聚焦主窗口 + 'notification:click' 事件（渲染进程宿主分发 onClick 回调）
 * - icon 支持 app:// URL / http(s) URL / data: URI / 本地路径（解析失败则忽略图标）
 * - 通知禁用状态由渲染进程设置页管控，host 在调用前检查（禁用则不调 IPC）
 */
import { BrowserWindow, ipcMain, nativeImage, Notification } from 'electron'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

async function resolveIcon(icon?: string): Promise<Electron.NativeImage | undefined> {
  if (!icon) return undefined
  try {
    if (icon.startsWith('data:')) {
      const img = nativeImage.createFromDataURL(icon)
      return img.isEmpty() ? undefined : img
    }
    if (icon.startsWith('app://') || icon.startsWith('http:') || icon.startsWith('https:')) {
      const res = await fetch(icon)
      const buf = Buffer.from(await res.arrayBuffer())
      const img = nativeImage.createFromBuffer(buf)
      return img.isEmpty() ? undefined : img
    }
    const img = nativeImage.createFromPath(icon)
    return img.isEmpty() ? undefined : img
  } catch {
    return undefined
  }
}

let notifSeq = 0

export function registerNotificationIpc(): void {
  ipcMain.handle(
    'notification:show',
    async (
      _e,
      extId: string,
      opts: { title?: string; body?: string; icon?: string }
    ): Promise<{ ok: boolean; id?: number; error?: string }> => {
      try {
        if (!opts || typeof opts !== 'object') throw new Error('通知参数必须是对象')
        if (!opts.title || !String(opts.title).trim()) throw new Error('通知 title 必填')
        const icon = await resolveIcon(opts.icon)
        const notification = new Notification({
          title: String(opts.title),
          body: String(opts.body ?? ''),
          icon
        })
        const notifId = ++notifSeq
        notification.on('click', () => {
          // 点击通知：聚焦主窗口（URL 无 obox-window=app 参数的即主窗口），并把点击事件交给扩展
          const main = BrowserWindow.getAllWindows().find(
            (w) => !w.isDestroyed() && !w.webContents.getURL().includes('obox-window=app')
          )
          if (main) {
            if (main.isMinimized()) main.restore()
            main.focus()
          }
          broadcast('notification:click', { notifId, extId, title: String(opts.title) })
        })
        notification.show()
        return { ok: true, id: notifId }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
