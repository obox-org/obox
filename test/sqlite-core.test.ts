/**
 * sqlite 核心逻辑单测（sqliteCore，不依赖 electron）。
 * 用临时目录 + 真实 DatabaseSync 文件库跑全流程：自动建表/insert/update/get/get_by/del/boolean 还原/upsert/query。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildWhere,
  closeHandle,
  ensureTable,
  insertRow,
  loadTableMeta,
  openSqlite,
  readRows,
  type SqliteHandle
} from '../src/main/sqliteCore'

let dir: string
let db: SqliteHandle
let metaFile: string

function rowsOf(h: SqliteHandle, table: string, rows: unknown[]): unknown[] {
  return readRows(metaFile, table, rows)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obox-sqlite-'))
  db = openSqlite('ext-test', 'todo.db', dir)
  metaFile = join(dir, '.obox-meta-todo.json')
})

afterEach(() => {
  closeHandle(new Map([[`ext-test:todo.db`, db]]), `ext-test:todo.db`)
  rmSync(dir, { recursive: true, force: true })
})

describe('openSqlite 路径校验', () => {
  it('相对路径通过，默认表名 = 文件名去扩展名', () => {
    expect(db.table).toBe('todo')
    expect(db.path).toBe(join(dir, 'todo.db'))
  })

  it('子目录相对路径自动建目录', () => {
    const sub = openSqlite('ext-test', 'sub/a.db', dir)
    expect(sub.path).toBe(join(dir, 'sub', 'a.db'))
    closeHandle(new Map([['k', sub]]), 'k')
  })

  it('拒绝绝对路径 / .. / 盘符', () => {
    expect(() => openSqlite('e', 'C:\\x.db', dir)).toThrow()
    expect(() => openSqlite('e', '../x.db', dir)).toThrow()
    expect(() => openSqlite('e', 'a/../b.db', dir)).toThrow()
    expect(() => openSqlite('e', '/abs.db', dir)).toThrow()
  })
})

describe('buildWhere 等值条件编译', () => {
  it('多键 AND + 参数', () => {
    const w = buildWhere({ done: false, priority: 'high' })
    expect(w.sql).toBe('"done" = ? AND "priority" = ?')
    expect(w.params).toEqual([0, 'high']) // boolean → 0/1
  })

  it('空条件 → 空 sql/params', () => {
    expect(buildWhere({})).toEqual({ sql: '', params: [] })
  })

  it('标识符注入防护', () => {
    expect(() => buildWhere({ 'x"; DROP TABLE t;--': 1 })).toThrow()
  })
})

describe('insert 自动建表与类型', () => {
  it('首次 insert 自动建表并返回新行（含自增 id）', () => {
    const row = insertRow(db, metaFile, { title: '买菜', done: false, priority: 'high' })
    expect(row).toMatchObject({ id: 1, title: '买菜', done: false, priority: 'high' })
    // meta 记录列类型（boolean 还原）
    const meta = loadTableMeta(metaFile)
    expect(meta['todo']).toMatchObject({ id: 'number', done: 'boolean', priority: 'string' })
  })

  it('含 id 的 insert = upsert', () => {
    insertRow(db, metaFile, { title: 'a' })
    const updated = insertRow(db, metaFile, { id: 1, title: 'b' })
    expect(updated).toMatchObject({ id: 1, title: 'b' })
    const all = db.raw.prepare(`SELECT * FROM "todo"`).all() as unknown[]
    expect(all).toHaveLength(1)
  })

  it('追加新列自动 ALTER TABLE', () => {
    insertRow(db, metaFile, { title: 'a' })
    const row = insertRow(db, metaFile, { title: 'b', due: '2026-01-01' })
    expect(row).toMatchObject({ due: '2026-01-01' })
  })

  it('对象值序列化为 JSON 文本', () => {
    const row = insertRow(db, metaFile, { tags: ['x', 'y'] })
    expect((row as Record<string, unknown>).tags).toBe('["x","y"]')
  })
})

describe('读取与条件查询', () => {
  beforeEach(() => {
    insertRow(db, metaFile, { title: 'a', done: false })
    insertRow(db, metaFile, { title: 'b', done: true })
    insertRow(db, metaFile, { title: 'c', done: false })
  })

  it('get_all 返回全部（boolean 还原）', () => {
    const all = rowsOf(db, 'todo', db.raw.prepare(`SELECT * FROM "todo"`).all() as unknown[])
    expect(all).toHaveLength(3)
    expect(all.map((r) => (r as { done: boolean }).done)).toEqual([false, true, false])
  })

  it('get_by 等值匹配（多键 AND）', () => {
    const hit = rowsOf(
      db,
      'todo',
      db.raw.prepare(buildWhere({ done: false }).sql ? `SELECT * FROM "todo" WHERE ${buildWhere({ done: false }).sql}` : 'SELECT * FROM "todo"').all(...buildWhere({ done: false }).params) as unknown[]
    )
    expect(hit).toHaveLength(2)
  })

  it('update 按条件更新（boolean 值）', () => {
    const w = buildWhere({ title: 'a' })
    const info = db.raw
      .prepare(`UPDATE "todo" SET done = ? WHERE ${w.sql}`)
      .run(1, ...w.params)
    expect(Number(info.changes)).toBe(1)
    const after = rowsOf(db, 'todo', db.raw.prepare(`SELECT * FROM "todo"`).all() as unknown[])
    expect(after.find((r) => (r as { title: string }).title === 'a')).toMatchObject({ done: true })
  })
})

describe('删除与清空', () => {
  beforeEach(() => {
    insertRow(db, metaFile, { title: 'a' })
    insertRow(db, metaFile, { title: 'b' })
    insertRow(db, metaFile, { title: 'c' })
  })

  it('按 id 删除', () => {
    const info = db.raw.prepare(`DELETE FROM "todo" WHERE id = ?`).run(2)
    expect(Number(info.changes)).toBe(1)
    expect((db.raw.prepare(`SELECT COUNT(*) AS n FROM "todo"`).get() as { n: number }).n).toBe(2)
  })

  it('按条件删除 + 清空', () => {
    const w = buildWhere({ title: 'a' })
    expect(Number(db.raw.prepare(`DELETE FROM "todo" WHERE ${w.sql}`).run(...w.params).changes)).toBe(1)
    expect(Number(db.raw.prepare(`DELETE FROM "todo"`).run().changes)).toBe(2)
  })
})

describe('ensureTable 幂等', () => {
  it('重复 ensureTable 不重建/不报错', () => {
    ensureTable(db, metaFile, { title: 'a' })
    expect(() => ensureTable(db, metaFile, { title: 'b' })).not.toThrow()
  })
})
