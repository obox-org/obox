/**
 * 扩展全局定时器服务（主进程，不受渲染进程后台节流影响）。
 * - api.timer.setTimeout / setInterval(id, seconds, cb)：整数秒粒度（≥1s）
 * - 按扩展隔离（内部 key = <扩展id>:<id>），扩展停用/卸载时自动清理
 * - 到点经 'timer:fire' 事件广播到窗口，渲染进程宿主按 key 分发到扩展回调
 */
import { BrowserWindow, ipcMain } from 'electron'

interface TimerEntry {
  kind: 'timeout' | 'interval'
  handle: ReturnType<typeof setTimeout>
}

const timers = new Map<string, TimerEntry>()

function keyOf(extId: string, id: string): string {
  return `${extId}:${id}`
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function validateSeconds(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1) {
    throw new Error('定时器间隔必须是大于等于 1 的整数秒')
  }
  return seconds
}

function clearTimer(k: string): void {
  const t = timers.get(k)
  if (!t) return
  if (t.kind === 'timeout') clearTimeout(t.handle)
  else clearInterval(t.handle)
  timers.delete(k)
}

function setTimer(extId: string, id: string, seconds: number, kind: 'timeout' | 'interval'): void {
  const k = keyOf(extId, id)
  clearTimer(k)
  const fire = (): void => {
    broadcast('timer:fire', { key: k, kind })
    if (kind === 'timeout') timers.delete(k)
  }
  const handle = kind === 'timeout' ? setTimeout(fire, seconds * 1000) : setInterval(fire, seconds * 1000)
  timers.set(k, { kind, handle })
}

/** 关闭某扩展的全部定时器（扩展停用/卸载/重启时调用） */
export function closeExtensionTimers(extId: string): void {
  for (const k of [...timers.keys()]) {
    if (k.startsWith(`${extId}:`)) clearTimer(k)
  }
}

export function registerTimerIpc(): void {
  ipcMain.handle(
    'timer:set-timeout',
    (_e, extId: string, id: string, seconds: unknown): { ok: boolean; error?: string } => {
      try {
        setTimer(extId, String(id), validateSeconds(seconds), 'timeout')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle(
    'timer:set-interval',
    (_e, extId: string, id: string, seconds: unknown): { ok: boolean; error?: string } => {
      try {
        setTimer(extId, String(id), validateSeconds(seconds), 'interval')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle('timer:clear', (_e, extId: string, id: string): void => {
    clearTimer(keyOf(extId, String(id)))
  })
}
