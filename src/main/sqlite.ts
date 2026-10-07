/**
 * 扩展数据库服务 IPC（electron 层）。
 * - data 目录解析：userData/extensions/<扩展id>/data
 * - 核心逻辑（路径校验/自动建表/表集合操作）在 sqliteCore.ts（不依赖 electron，可独立单测）
 * - 扩展经 api.sqlite.open(name) 打开**相对路径**数据库 → 扩展 data 目录（拒绝绝对路径/穿越）
 */
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  assertSafeSql,
  buildWhere,
  closeHandle,
  insertRow,
  normalizeDbName,
  normalizeValue,
  openSqlite,
  readRows,
  requireHandle,
  tableExists,
  type SqliteHandle
} from './sqliteCore'

const handles = new Map<string, SqliteHandle>()

/**
 * 句柄键：扩展 id + **归一化后**的库相对路径。
 * open 与所有后续操作必须用同一规则——否则 `a\b.db` / `a/b.db` / `./a.db` 会被当成不同库，
 * 表现为"open 成功但随后报数据库未打开"，或同一文件被双开连接。
 */
function handleKey(extId: string, name: string): string {
  return `${extId}:${normalizeDbName(name)}`
}

/** 扩展数据目录：userData/extensions/<扩展id>/data */
function dataDirFor(extId: string): string {
  return join(app.getPath('userData'), 'extensions', extId, 'data')
}

/**
 * 元数据文件路径（列类型表）。
 * 根目录下的库沿用旧命名 `.obox-meta-<table>.json`（兼容既有扩展数据，无需迁移）；
 * 子目录中的库加库路径前缀——否则 `a/todo.db` 与 `b/todo.db` 的同名表会共享元数据、列类型互串。
 */
function metaPathFor(extId: string, name: string): string {
  const h = requireHandle(handles, handleKey(extId, name))
  const dbKey = normalizeDbName(name)
  const prefix = dbKey.includes('/') ? `${dbKey.replace(/\//g, '__')}-` : ''
  return join(dataDirFor(extId), `.obox-meta-${prefix}${h.table}.json`)
}

/** 关闭某扩展的全部数据库连接（扩展停用/卸载时调用） */
export function closeExtensionDbs(extId: string): void {
  for (const key of [...handles.keys()]) {
    if (key.startsWith(`${extId}:`)) closeHandle(handles, key)
  }
}

export function registerSqliteIpc(): void {
  ipcMain.handle('sqlite:open', (_e, extId: string, name: string): { ok: boolean; error?: string } => {
    try {
      const key = handleKey(extId, name)
      // 同名重开：先关旧连接，否则旧 DatabaseSync 永不 close（句柄 / 文件锁泄漏）
      if (handles.has(key)) closeHandle(handles, key)
      const h = openSqlite(extId, name, dataDirFor(extId))
      // 句柄键统一用**归一化后的** name（handleKey）：open 与后续所有操作必须同一规则，
      // 否则 `a\b.db` / `a/b.db` / `./a.db` 会被当成不同库——Windows 上表现为
      // "open 成功但随后报数据库未打开"，或同一文件被双开连接
      handles.set(key, h)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('sqlite:close', (_e, extId: string, name: string): void => {
    closeHandle(handles, handleKey(extId, name))
  })

  // exec：执行 SQL 脚本（可多语句；不返回结果集）
  ipcMain.handle(
    'sqlite:exec',
    (_e, extId: string, name: string, sql: string): { ok: boolean; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        // 挡住 ATTACH / VACUUM INTO / load_extension 等可读写库外文件的语句（路径沙箱只覆盖库文件位置）
        assertSafeSql(String(sql))
        h.raw.exec(String(sql))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // query：复杂查询（SELECT/JOIN/聚合），返回对象数组
  ipcMain.handle(
    'sqlite:query',
    (
      _e,
      extId: string,
      name: string,
      sql: string,
      params: unknown[]
    ): { ok: boolean; rows?: unknown[]; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        assertSafeSql(String(sql))
        const normalized = (Array.isArray(params) ? params : []).map(normalizeValue)
        const rows = h.raw.prepare(String(sql)).all(...normalized) as unknown[]
        return { ok: true, rows: readRows(metaPathFor(extId, name), h.table, rows) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // insert：插入一行（自动建表；含 id 则 upsert），返回新行
  ipcMain.handle(
    'sqlite:insert',
    (
      _e,
      extId: string,
      name: string,
      row: Record<string, unknown>
    ): { ok: boolean; row?: unknown; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        if (!row || typeof row !== 'object') throw new Error('insert 参数必须是对象')
        return { ok: true, row: insertRow(h, metaPathFor(extId, name), row) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // update：按等值条件更新部分字段
  ipcMain.handle(
    'sqlite:update',
    (
      _e,
      extId: string,
      name: string,
      where: Record<string, unknown>,
      patch: Record<string, unknown>
    ): { ok: boolean; changes?: number; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        if (!patch || typeof patch !== 'object') throw new Error('update patch 必须是对象')
        const w = buildWhere(where ?? {})
        if (!w.sql) throw new Error('update 需要条件（where 不能为空）')
        const keys = Object.keys(patch).filter((k) => k !== 'id')
        if (keys.length === 0) throw new Error('update patch 不能为空')
        const set = keys.map((k) => `"${k}" = ?`).join(', ')
        const info = h.raw
          .prepare(`UPDATE "${h.table}" SET ${set} WHERE ${w.sql}`)
          .run(...keys.map((k) => normalizeValue(patch[k])), ...w.params)
        return { ok: true, changes: Number(info.changes) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // get：按 id 取单行
  ipcMain.handle(
    'sqlite:get',
    (_e, extId: string, name: string, id: unknown): { ok: boolean; row?: unknown; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        const found = h.raw.prepare(`SELECT * FROM "${h.table}" WHERE id = ?`).get(normalizeValue(id))
        return {
          ok: true,
          row: found ? readRows(metaPathFor(extId, name), h.table, [found])[0] : undefined
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // get_all：全部行
  ipcMain.handle(
    'sqlite:get-all',
    (_e, extId: string, name: string): { ok: boolean; rows?: unknown[]; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        if (!tableExists(h, h.table)) return { ok: true, rows: [] }
        const rows = h.raw.prepare(`SELECT * FROM "${h.table}"`).all() as unknown[]
        return { ok: true, rows: readRows(metaPathFor(extId, name), h.table, rows) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // get_by：等值条件匹配 → 数组
  ipcMain.handle(
    'sqlite:get-by',
    (
      _e,
      extId: string,
      name: string,
      where: Record<string, unknown>
    ): { ok: boolean; rows?: unknown[]; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        if (!tableExists(h, h.table)) return { ok: true, rows: [] }
        const w = buildWhere(where ?? {})
        const sql = w.sql ? `SELECT * FROM "${h.table}" WHERE ${w.sql}` : `SELECT * FROM "${h.table}"`
        const rows = h.raw.prepare(sql).all(...w.params) as unknown[]
        return { ok: true, rows: readRows(metaPathFor(extId, name), h.table, rows) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // del：按 id 删除
  ipcMain.handle(
    'sqlite:del',
    (_e, extId: string, name: string, id: unknown): { ok: boolean; changes?: number; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        const info = h.raw.prepare(`DELETE FROM "${h.table}" WHERE id = ?`).run(normalizeValue(id))
        return { ok: true, changes: Number(info.changes) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // del_by：按等值条件删除
  ipcMain.handle(
    'sqlite:del-by',
    (
      _e,
      extId: string,
      name: string,
      where: Record<string, unknown>
    ): { ok: boolean; changes?: number; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        const w = buildWhere(where ?? {})
        if (!w.sql) throw new Error('del_by 需要条件（where 不能为空）')
        const info = h.raw.prepare(`DELETE FROM "${h.table}" WHERE ${w.sql}`).run(...w.params)
        return { ok: true, changes: Number(info.changes) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // clear：清空表
  ipcMain.handle(
    'sqlite:clear',
    (_e, extId: string, name: string): { ok: boolean; changes?: number; error?: string } => {
      try {
        const h = requireHandle(handles, handleKey(extId, name))
        const info = h.raw.prepare(`DELETE FROM "${h.table}"`).run()
        return { ok: true, changes: Number(info.changes) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
