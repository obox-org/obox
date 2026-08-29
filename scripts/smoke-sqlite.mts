// 冒烟：Electron 的 Node（v22.22）下跑 sqliteCore 全流程（临时脚本，验证真实运行）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWhere,
  closeHandle,
  insertRow,
  openSqlite,
  readRows
} from '../src/main/sqliteCore.ts'

const dir = mkdtempSync(join(tmpdir(), 'obox-smoke-'))
const db = openSqlite('ext', 'todo.db', dir)
const meta = join(dir, '.obox-meta-todo.json')

insertRow(db, meta, { title: '买菜', done: false })
insertRow(db, meta, { title: '交费', done: true })
const upserted = insertRow(db, meta, { id: 1, title: '买菜（改）', done: true })
const all = readRows(meta, 'todo', db.raw.prepare('SELECT * FROM "todo"').all())
const w = buildWhere({ done: true })
const filtered = readRows(meta, 'todo', db.raw.prepare(`SELECT * FROM "todo" WHERE ${w.sql}`).all(...w.params))
const upd = db.raw.prepare(`UPDATE "todo" SET done = ? WHERE ${w.sql}`).run(0, ...w.params)

console.log('rows:', JSON.stringify(all))
console.log('upsert id1:', JSON.stringify(upserted))
console.log('get_by done=true:', JSON.stringify(filtered))
console.log('update changes:', Number(upd.changes))
console.log('SMOKE OK on', process.version)

closeHandle(new Map([['k', db]]), 'k')
rmSync(dir, { recursive: true, force: true })
