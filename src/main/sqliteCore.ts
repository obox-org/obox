/**
 * 扩展数据库核心逻辑（**不依赖 electron**，可独立单测）。
 * sqlite.ts（electron 层）只负责 data 目录解析与 IPC 转发，其余逻辑都在这里。
 * 测试：vitest 下用 :memory: 数据库直接跑全流程。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'

/** 打开的数据库句柄 */
export interface SqliteHandle {
  extId: string
  name: string
  path: string
  raw: DatabaseSync
  /** 默认表名（= 数据库文件名去扩展名） */
  table: string
}

/** 持久化列类型元数据：{ [table]: { [col]: 'boolean' | 'number' | 'string' } } */
export interface TableMeta {
  [table: string]: { [col: string]: 'boolean' | 'number' | 'string' }
}

/** 校验并规范化相对路径（拒绝绝对路径 / .. / 空段 / 盘符） */
export function validateRelPath(name: string): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('路径必填（相对路径）')
  const n = name.trim()
  if (isAbsolute(n) || /^[a-zA-Z]:/.test(n)) throw new Error('路径必须是相对路径，不能是绝对路径')
  const parts = n.split(/[\\/]/)
  if (parts.some((p) => p === '..' || p === '')) throw new Error('路径不能包含 .. 或空路径段')
  return parts.join(sep)
}

/** 默认表名：文件名去扩展名（open('todo.db') → 表 'todo'） */
export function defaultTable(name: string): string {
  const base = name.split(sep).pop() ?? name
  return base.replace(/\.[^.]+$/, '')
}

export function loadTableMeta(metaFile: string): TableMeta {
  try {
    return JSON.parse(readFileSync(metaFile, 'utf8')) as TableMeta
  } catch {
    return {}
  }
}

export function saveTableMeta(metaFile: string, meta: TableMeta): void {
  mkdirSync(dirname(metaFile), { recursive: true })
  writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8')
}

export function sqlType(v: unknown): 'boolean' | 'number' | 'string' {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  return 'string'
}

export function columnDecl(col: string, type: 'boolean' | 'number' | 'string'): string {
  // SQLite 类型亲和：INTEGER 列也能存浮点，统一用 INTEGER/TEXT 即可
  const sql = type === 'boolean' || type === 'number' ? 'INTEGER' : 'TEXT'
  return `"${col}" ${sql}`
}

/** 校验标识符（表名/列名），防 SQL 注入 */
export function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`非法标识符: ${name}`)
  return name
}

/** 值写入规范化：boolean → 0/1；undefined → null；对象/数组 → JSON 字符串（SQLInputValue 兼容） */
export function normalizeValue(v: unknown): string | number | bigint | null {
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
export function denormalizeValue(v: unknown, type: 'boolean' | 'number' | 'string'): unknown {
  if (type === 'boolean' && typeof v === 'number') return v !== 0
  return v
}

/** 等值条件 → SQL WHERE 子句与参数（多键 AND） */
export function buildWhere(
  where: Record<string, unknown>
): { sql: string; params: Array<string | number | bigint | null> } {
  const keys = Object.keys(where ?? {})
  if (keys.length === 0) return { sql: '', params: [] }
  const sql = keys.map((k) => `"${ident(k)}" = ?`).join(' AND ')
  return { sql, params: keys.map((k) => normalizeValue(where[k])) }
}

/** 自动建表（首次 insert）：id 主键 + 其余列按 JS 类型声明 */
export function ensureTable(h: SqliteHandle, metaFile: string, row: Record<string, unknown>): void {
  const meta = loadTableMeta(metaFile)
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
      saveTableMeta(metaFile, meta)
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
  saveTableMeta(metaFile, meta)
}

/** 读取行并按元数据还原类型 */
export function readRows(metaFile: string, table: string, rows: unknown[]): unknown[] {
  const meta = loadTableMeta(metaFile)[table]
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

/** 打开数据库（dataDir 为扩展数据目录；自动建目录） */
export function openSqlite(extId: string, name: string, dataDir: string): SqliteHandle {
  const rel = validateRelPath(name)
  const dbPath = join(dataDir, rel)
  mkdirSync(dbPath.slice(0, dbPath.lastIndexOf(sep)), { recursive: true })
  return { extId, name: rel, path: dbPath, raw: new DatabaseSync(dbPath), table: defaultTable(rel) }
}

/** 从连接表取句柄（未打开抛错） */
export function requireHandle(handles: Map<string, SqliteHandle>, key: string): SqliteHandle {
  const h = handles.get(key)
  if (!h) throw new Error('数据库未打开（先调用 api.sqlite.open）')
  return h
}

/** 关闭并移除连接（幂等） */
export function closeHandle(handles: Map<string, SqliteHandle>, key: string): void {
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

/** 表是否存在 */
export function tableExists(h: SqliteHandle, table: string): boolean {
  return (
    h.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table) !==
    undefined
  )
}

/** insert：插入一行（自动建表；含 id 则 upsert），返回新行 */
export function insertRow(h: SqliteHandle, metaFile: string, row: Record<string, unknown>): unknown {
  ensureTable(h, metaFile, row)
  const cols = Object.keys(row).filter((c) => c !== 'id')
  if (row.id !== undefined) {
    const set = cols.map((c) => `"${ident(c)}" = ?`).join(', ')
    const values = cols.map((c) => normalizeValue(row[c]))
    h.raw.prepare(`UPDATE "${ident(h.table)}" SET ${set} WHERE id = ?`).run(...values, normalizeValue(row.id))
    const found = h.raw.prepare(`SELECT * FROM "${ident(h.table)}" WHERE id = ?`).get(normalizeValue(row.id))
    return readRows(metaFile, h.table, [found])[0]
  }
  const placeholders = cols.map(() => '?').join(', ')
  const values = cols.map((c) => normalizeValue(row[c]))
  const info = h.raw
    .prepare(
      `INSERT INTO "${ident(h.table)}" (${cols.map((c) => `"${ident(c)}"`).join(', ')}) VALUES (${placeholders})`
    )
    .run(...values)
  const found = h.raw.prepare(`SELECT * FROM "${ident(h.table)}" WHERE id = ?`).get(info.lastInsertRowid)
  return readRows(metaFile, h.table, [found])[0]
}
