/**
 * 扩展文件系统服务：api.fs。
 * 与 api.sqlite 相同的安全模型：**相对路径**解析到 userData/extensions/<扩展id>/data/，
 * 拒绝绝对路径 / .. / 盘符；读写都限定在扩展自己的数据目录内。
 */
import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'

/** 校验并规范化相对路径（拒绝绝对路径 / .. / 空段 / 盘符） */
function validateRelPath(name: string): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('路径必填（相对路径）')
  const n = name.trim()
  if (isAbsolute(n) || /^[a-zA-Z]:/.test(n)) throw new Error('路径必须是相对路径，不能是绝对路径')
  const parts = n.split(/[\\/]/)
  if (parts.some((p) => p === '..' || p === '')) throw new Error('路径不能包含 .. 或空路径段')
  return parts.join(sep)
}

/** 扩展数据目录：userData/extensions/<扩展id>/data */
function dataDirFor(extId: string): string {
  return join(app.getPath('userData'), 'extensions', extId, 'data')
}

function resolvePath(extId: string, rel: string): string {
  return join(dataDirFor(extId), validateRelPath(rel))
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
        await fs.mkdir(p.slice(0, p.lastIndexOf(sep)), { recursive: true })
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
}
