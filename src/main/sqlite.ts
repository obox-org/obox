/**
 * 扩展数据库服务（node:sqlite 内置驱动，零依赖）。
 * - 扩展经 api.sqlite.open(name) 打开**相对路径**数据库 → userData/extensions/<扩展id>/data/<name>
 * - 拒绝绝对路径与路径穿越（.. / 空段 / 盘符）
 * - 上层行 API（表集合）：insert / update / get / get_all / get_by / del / del_by / clear
 * - exec 执行 SQL 脚本（建表/初始化，可多语句）；query 复杂查询
 * - 首次 insert 自动建表：id 主键自增，其余列按 JS 类型声明（number→INTEGER/REAL，boolean→INTEGER，string→TEXT）
 * - 列类型记录在 data 目录 .obox-meta.json：跨重启恢复 boolean/number 语义（读出时还原）
 */
import { app, ipcMain } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'

/** 打开的数据库句柄（key = <扩展id>:<相对路径>） */
interface SqliteHandle {
  extId: string
  name: string
  path: string
  raw: DatabaseSync
  /** 默认表名（= 数据库文件名去扩展名） */
  table: string
}

/** 持久化列类型元数据：{ [table]: { [col]: 'boolean' | 'number' | 'string' } } */
interface TableMeta {
  [table: string]: { [col: string]: 'boolean' | 'number' | 'string' }
}

const handles = new Map<string, SqliteHandle>()

/** 校验并规范化相对路径（拒绝绝对路径 / .. / 空段 / 盘符） */
function validateRelPath(name: string): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('数据库名必填（相对路径）')
  const n = name.trim()
  if (isAbsolute(n) || /^[a-zA-Z]:/.test(n)) throw new Error('数据库名必须是相对路径，不能是绝对路径')
  const parts = n.split(/[\\/]/)
  if (parts.some((p) => p === '..' || p === '')) throw new Error('数据库名不能包含 .. 或空路径段')
  return parts.join(sep)
}

/** 扩展数据目录：userData/extensions/<扩展id>/data */
function dataDirFor(extId: string): string {
  const dir = join(app.getPath('userData'), 'extensions', extId, 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 默认表名：文件名去扩展名（open('todo.db') → 表 'todo'） */
function defaultTable(name: string): string {
  const base = name.split(sep).pop() ?? name
  return base.replace(/\.[^.]+$/, '')
}

function metaPath(extId: string, name: string): string {
  return join(dataDirFor(extId), `.obox-meta-${defaultTable(name)}.json`)
}

function loadMeta(extId: string, name: string): TableMeta {
  try {
    return JSON.parse(readFileSync(metaPath(extId, name), 'utf8')) as TableMeta
  } catch {
    return {}
  }
}

function saveMeta(extId: string, name: string, meta: TableMeta): void {
  writeFileSync(metaPath(extId, name), JSON.stringify(meta, null, 2), 'utf8')
}

function sqlType(v: unknown): 'boolean' | 'number' | 'string' {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  return 'string'
}

function columnDecl(col: string, type: 'boolean' | 'number' | 'string'): string {
  // SQLite 类型亲和：INTEGER 列也能存浮点，统一用 INTEGER/TEXT 即可
  const sql = type === 'boolean' || type === 'number' ? 'INTEGER' : 'TEXT'
  return `"${col}" ${sql}`
}

/** 校验标识符（表名/列名），防 SQL 注入 */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`非法标识符: ${name}`)
  return name
}

/** 值写入规范化：boolean → 0/1；undefined → null；对象/数组 → JSON 字符串（SQLInputValue 兼容） */
function normalizeValue(v: unknown): string | number | bigint | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}

/** 值读出还原（按元数据列类型） */
function denormalizeValue(v: unknown, type: 'boolean' | 'number' | 'string'): unknown {
  if (type === 'boolean' && typeof v === 'number') return v !== 0
  return v
}

function keyOf(extId: string, name: string): string {
  return `${extId}:${name}`
}

function requireHandle(key: string): SqliteHandle {
  const h = handles.get(key)
  if (!h) throw new Error('数据库未打开（先调用 api.sqlite.open）')
  return h
}

/** 等值条件 → SQL WHERE 子句与参数（多键 AND） */
function buildWhere(
  where: Record<string, unknown>
): { sql: string; params: Array<string | number | bigint | null> } {
  const keys = Object.keys(where ?? {})
  if (keys.length === 0) return { sql: '', params: [] }
  const sql = keys.map((k) => `"${ident(k)}" = ?`).join(' AND ')
  return { sql, params: keys.map((k) => normalizeValue(where[k])) }
}

/** 自动建表（首次 insert）：id 主键 + 其余列按 JS 类型声明 */
function ensureTable(h: SqliteHandle, row: Record<string, unknown>): void {
  const meta = loadMeta(h.extId, h.name)
  const existing = meta[h.table]
  if (existing) {
    // 已有表：新增的列按当前值类型补列
    const addCols = Object.keys(row).filter((c) => c !== 'id' && !(c in existing))
    if (addCols.length > 0) {
      for (const c of addCols) {
        const t = sqlType(row[c])
        existing[c] = t
        h.raw.exec(`ALTER TABLE "${ident(h.table)}" ADD COLUMN ${columnDecl(c, t)}`)
      }
      saveMeta(h.extId, h.name, meta)
    }
    return
  }
  const cols = Object.keys(row).filter((c) => c !== 'id')
  const decls = ['id INTEGER PRIMARY KEY AUTOINCREMENT']
  const metaCols: { [col: string]: 'boolean' | 'number' | 'string' } = { id: 'number' }
  for (const c of cols) {
    const t = sqlType(row[c])
    metaCols[c] = t
    decls.push(columnDecl(c, t))
  }
  h.raw.exec(`CREATE TABLE IF NOT EXISTS "${ident(h.table)}" (${decls.join(', ')})`)
  meta[h.table] = metaCols
  saveMeta(h.extId, h.name, meta)
}

function openHandle(extId: string, name: string): SqliteHandle {
  const rel = validateRelPath(name)
  const key = keyOf(extId, rel)
  let h = handles.get(key)
  if (h) return h
  const dbPath = join(dataDirFor(extId), rel)
  mkdirSync(dbPath.slice(0, dbPath.lastIndexOf(sep)), { recursive: true })
  h = { extId, name: rel, path: dbPath, raw: new DatabaseSync(dbPath), table: defaultTable(rel) }
  handles.set(key, h)
  return h
}

function closeHandle(key: string): void {
  const h = handles.get(key)
  if (h) {
    try {
      h.raw.close()
    } catch {
      /* 已关闭 */
    }
    handles.delete(key)
  }
}

/** 关闭某扩展的全部数据库连接（扩展停用/卸载时调用） */
export function closeExtensionDbs(extId: string): void {
  for (const [key, h] of [...handles]) {
    if (h.extId === extId) closeHandle(key)
  }
}

/** 读取行并按元数据还原类型 */
function readRows(h: SqliteHandle, table: string, rows: unknown[]): unknown[] {
  const meta = loadMeta(h.extId, h.name)[table]
  if (!meta) return rows
  return rows.map((row) => {
    const r = row as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      out[k] = meta[k] ? denormalizeValue(v, meta[k]) : v
    }
    return out
  })
}

export function registerSqliteIpc(): void {
  ipcMain.handle('sqlite:open', (_e, extId: string, name: string): { ok: boolean; error?: string } => {
    try {
      openHandle(extId, name)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('sqlite:close', (_e, extId: string, name: string): void => {
    closeHandle(keyOf(extId, name))
  })

  // exec：执行 SQL 脚本（可多语句；不返回结果集）
  ipcMain.handle(
    'sqlite:exec',
    (_e, extId: string, name: string, sql: string): { ok: boolean; error?: string } => {
      try {
        const h = requireHandle(keyOf(extId, name))
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
    (_e, extId: string, name: string, sql: string, params: unknown[]): { ok: boolean; rows?: unknown[]; error?: string } => {
      try {
        const h = requireHandle(keyOf(extId, name))
        const rows = h.raw
          .prepare(String(sql))
          .all(...(Array.isArray(params) ? params : []).map(normalizeValue)) as unknown[]
        return { ok: true, rows }
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
        const h = requireHandle(keyOf(extId, name))
        if (!row || typeof row !== 'object') throw new Error('insert 参数必须是对象')
        ensureTable(h, row)
        const cols = Object.keys(row).filter((c) => c !== 'id')
        if (row.id !== undefined) {
          // upsert：id 存在则更新
          const set = cols.map((c) => `"${ident(c)}" = ?`).join(', ')
          const values = cols.map((c) => normalizeValue(row[c]))
          h.raw
            .prepare(`UPDATE "${ident(h.table)}" SET ${set} WHERE id = ?`)
            .run(...values, normalizeValue(row.id))
          const found = h.raw.prepare(`SELECT * FROM "${ident(h.table)}" WHERE id = ?`).get(normalizeValue(row.id))
          return { ok: true, row: readRows(h, h.table, [found])[0] }
        }
        const placeholders = cols.map(() => '?').join(', ')
        const values = cols.map((c) => normalizeValue(row[c]))
        const info = h.raw
          .prepare(`INSERT INTO "${ident(h.table)}" (${cols.map((c) => `"${ident(c)}"`).join(', ')}) VALUES (${placeholders})`)
          .run(...values)
        const found = h.raw.prepare(`SELECT * FROM "${ident(h.table)}" WHERE id = ?`).get(info.lastInsertRowid)
        return { ok: true, row: readRows(h, h.table, [found])[0] }
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
        const h = requireHandle(keyOf(extId, name))
        if (!patch || typeof patch !== 'object') throw new Error('update patch 必须是对象')
        const w = buildWhere(where ?? {})
        if (!w.sql) throw new Error('update 需要条件（where 不能为空）')
        const keys = Object.keys(patch).filter((k) => k !== 'id')
        if (keys.length === 0) throw new Error('update patch 不能为空')
        const set = keys.map((k) => `"${ident(k)}" = ?`).join(', ')
        const info = h.raw
          .prepare(`UPDATE "${ident(h.table)}" SET ${set} WHERE ${w.sql}`)
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
        const h = requireHandle(keyOf(extId, name))
        const found = h.raw.prepare(`SELECT * FROM "${ident(h.table)}" WHERE id = ?`).get(normalizeValue(id))
        return { ok: true, row: found ? readRows(h, h.table, [found])[0] : undefined }
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
        const h = requireHandle(keyOf(extId, name))
        const exists = h.raw
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
          .get(h.table)
        if (!exists) return { ok: true, rows: [] }
        const rows = h.raw.prepare(`SELECT * FROM "${ident(h.table)}"`).all() as unknown[]
        return { ok: true, rows: readRows(h, h.table, rows) }
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
        const h = requireHandle(keyOf(extId, name))
        const w = buildWhere(where ?? {})
        const exists = h.raw
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
          .get(h.table)
        if (!exists) return { ok: true, rows: [] }
        const sql = w.sql ? `SELECT * FROM "${ident(h.table)}" WHERE ${w.sql}` : `SELECT * FROM "${ident(h.table)}"`
        const rows = h.raw.prepare(sql).all(...w.params) as unknown[]
        return { ok: true, rows: readRows(h, h.table, rows) }
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
        const h = requireHandle(keyOf(extId, name))
        const info = h.raw.prepare(`DELETE FROM "${ident(h.table)}" WHERE id = ?`).run(normalizeValue(id))
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
        const h = requireHandle(keyOf(extId, name))
        const w = buildWhere(where ?? {})
        if (!w.sql) throw new Error('del_by 需要条件（where 不能为空）')
        const info = h.raw.prepare(`DELETE FROM "${ident(h.table)}" WHERE ${w.sql}`).run(...w.params)
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
        const h = requireHandle(keyOf(extId, name))
        const info = h.raw.prepare(`DELETE FROM "${ident(h.table)}"`).run()
        return { ok: true, changes: Number(info.changes) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
