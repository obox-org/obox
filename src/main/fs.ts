/**
 * 扩展文件系统服务：api.fs。
 * 与 api.sqlite 相同的安全模型：**相对路径**解析到 userData/extensions/<扩展id>/data/，
 * 拒绝绝对路径 / .. / 盘符；读写都限定在扩展自己的数据目录内。
 * watch：监听扩展 data 目录内变化（相对路径事件广播到渲染进程）。
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { validateRelPath } from './sqliteCore'

/** 扩展数据目录：userData/extensions/<扩展id>/data */
function dataDirFor(extId: string): string {
  return join(app.getPath('userData'), 'extensions', extId, 'data')
}

function resolvePath(extId: string, rel: string): string {
  return join(dataDirFor(extId), validateRelPath(rel))
}

/** 文件监听器表（key = <扩展id>:<watchId>） */
const watchers = new Map<string, FSWatcher>()

function keyOf(extId: string, watchId: string): string {
  return `${extId}:${watchId}`
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 关闭某扩展的全部文件监听（扩展停用/卸载时调用） */
export function closeExtensionWatchers(extId: string): void {
  for (const key of [...watchers.keys()]) {
    if (key.startsWith(`${extId}:`)) {
      const w = watchers.get(key)
      w?.close()
      watchers.delete(key)
    }
  }
}

export function registerFsIpc(): void {
  ipcMain.handle(
    'fs:read-file',
    async (_e, extId: string, rel: string): Promise<{ ok: boolean; content?: string; error?: string }> => {
      try {
        const content = await fs.readFile(resolvePath(extId, rel), 'utf8')
        return { ok: true, content }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'fs:write-file',
    async (_e, extId: string, rel: string, content: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const p = resolvePath(extId, rel)
        await fs.mkdir(dirname(p), { recursive: true })
        await fs.writeFile(p, String(content ?? ''), 'utf8')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'fs:read-dir',
    async (
      _e,
      extId: string,
      rel: string
    ): Promise<{ ok: boolean; entries?: Array<{ name: string; isDir: boolean }>; error?: string }> => {
      try {
        const p = resolvePath(extId, rel)
        const dirents = await fs.readdir(p, { withFileTypes: true })
        return {
          ok: true,
          entries: dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'fs:exists',
    async (_e, extId: string, rel: string): Promise<{ ok: boolean; exists?: boolean; error?: string }> => {
      try {
        await fs.access(resolvePath(extId, rel))
        return { ok: true, exists: true }
      } catch {
        return { ok: true, exists: false }
      }
    }
  )

  ipcMain.handle(
    'fs:remove',
    async (_e, extId: string, rel: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        await fs.rm(resolvePath(extId, rel), { recursive: true, force: true })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // fs:watch：监听扩展 data 目录内变化（相对路径事件广播 'fs:watch-event'）
  ipcMain.handle(
    'fs:watch',
    (_e, extId: string, watchId: string, rel: string): { ok: boolean; error?: string } => {
      try {
        const key = keyOf(extId, watchId)
        watchers.get(key)?.close()
        const base = resolvePath(extId, rel)
        const watcher = watch(base, { recursive: true }, (_eventType, filename) => {
          if (!filename) return
          const relPath = relative(base, filename.toString()).split('\\').join('/')
          broadcast('fs:watch-event', { key, relPath })
        })
        watchers.set(key, watcher)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('fs:unwatch', (_e, extId: string, watchId: string): void => {
    const key = keyOf(extId, watchId)
    watchers.get(key)?.close()
    watchers.delete(key)
  })
}
