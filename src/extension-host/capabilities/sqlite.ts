/**
 * **存储族**：`api.sqlite`（EH-B2 / EH-B3 行）——宿主内直接用 `node:sqlite` 打开扩展数据库。
 *
 * ## 为什么复用 `src/main/sqliteCore.ts`
 *
 * 那 15 个纯函数（`validateRelPath` / `normalizeDbName` / `assertSafeSql` / `ensureTable` /
 * `insertRow` / `buildWhere` / `readRows` / `openSqlite` / …）在 main 里已被完整单测覆盖，且
 * **语义细节全是坑**：相对路径归一化（`a\b.db` 与 `a/b.db` 必须同一句柄）、首次写入自动建表、
 * `boolean` 用 INTEGER 存 + 元数据文件还原、`ATTACH`/`VACUUM`/`load_extension` 一律拦下。
 * 抄一份必然分叉——所以本文件**只负责"按扩展绑定 + 生命周期"**，语义一行都不重写。
 *
 * `src/main/sqlite.ts` 不能直接用（它 import electron 且整份是 `ipcMain.handle` 薄壳），因此这里
 * 把它的 11 个 handler **逐条**翻译成 `SqliteDb` 的 11 个方法，并保留它的两条路径规则：
 *
 * 1. **库文件**：`<扩展 data 目录>/<相对路径>`（`openSqlite` 内部 `mkdir -p`，绝对路径/`..` 拒绝）；
 * 2. **列类型元数据**：根目录下的库沿用旧命名 `.obox-meta-<table>.json`（老扩展数据无需迁移），
 *    子目录里的库加库路径前缀（否则 `a/todo.db` 与 `b/todo.db` 的同名表会共享元数据、列类型互串）。
 *
 * ## 句柄语义（与 main 逐条一致）
 *
 * - 句柄键 = **归一化后的**库相对路径：`open` 与后续所有操作必须同一规则，否则 `./a.db` 会被当成
 *   另一个库（Windows 上表现为"open 成功但随后报数据库未打开"）；
 * - **同名重复 `open`**：先关旧连接再开（`DatabaseSync` 不 close 会漏句柄/文件锁），返回**新句柄**；
 *   已拿到的旧 `SqliteDb` 对象仍可用——它每次操作都按**键**现取句柄，因此自动指向新连接；
 * - 扩展停用 → `dispose()` 关全部连接（不关会被文件锁/句柄拖住宿主退出）。
 */
import path from 'node:path'
import type { ExtensionActivationApi, SqliteRow, SqliteWhere } from '../../api/types'
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
} from '../../main/sqliteCore'
import type { HostLogger } from '../log'
import { toErrorMessage } from '../errors'

/* -------------------------------------------------------------------------------------------- */
/* 参数与返回值                                                                                  */
/* -------------------------------------------------------------------------------------------- */

export interface HostSqliteCapabilitiesOptions {
  /** 扩展 id（日志归属；句柄键前缀） */
  extId: string
  /** 扩展 data 目录（**库文件的根**；由 apiFactory 统一按 `<扩展目录>/data` 计算，见 R62） */
  extensionDataDir: string
  /** 宿主日志（只在关闭失败时写一条 warn） */
  log?: HostLogger
}

/** 存储能力族 */
export interface SqliteCapabilities {
  /** `api.sqlite`（声明里的 1 个成员） */
  readonly api: ExtensionActivationApi['sqlite']
  /** 当前打开的连接数（诊断/测试；dispose 后必为 0） */
  openCount(): number
  /** 关掉该扩展的全部连接（扩展停用/宿主退出；幂等） */
  dispose(): void
}

/* -------------------------------------------------------------------------------------------- */
/* 工厂                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** `api.sqlite.open` 的返回（与 `src/api/types.ts` 的声明逐字一致） */
type SqliteDbResult = Awaited<ReturnType<ExtensionActivationApi['sqlite']['open']>>

/**
 * 按扩展构造 sqlite 能力。
 *
 * 错误边界：
 * - **调用方式错**（未 open 就操作、where/patch 为空、SQL 带禁用关键字、路径越界）→ 抛 `Error`，
 *   消息与 main 的返回值**逐字相同**（扩展从渲染进程迁过来时错误文案不变）；
 * - **只有 `exec` 不抛错**：它在类型声明里就返回 `{ ok, error? }`（声明形状优先于"统一抛错"）。
 */
export function createSqliteCapabilities(
  options: HostSqliteCapabilitiesOptions
): SqliteCapabilities {
  const extId = options.extId
  const dataDir = path.resolve(options.extensionDataDir)
  const handles = new Map<string, SqliteHandle>()
  let disposed = false

  /**
   * 句柄键：扩展 id + **归一化后**的库相对路径（与 main 的 `handleKey` 同一规则）。
   *
   * 每个能力实例本来就只服务一个扩展，带 `extId` 只是让日志/诊断里的键自解释，同时保证与 main
   * 的键形状一致（两处 dump 出来能直接对照）。
   */
  const handleKey = (name: string): string => `${extId}:${normalizeDbName(name)}`

  /**
   * 列类型元数据文件路径（逐字照抄 `src/main/sqlite.ts` 的 `metaPathFor`）。
   * 根目录库沿用旧命名、子目录库加前缀——两条都是"老扩展数据零迁移"的硬要求。
   */
  const metaPathFor = (name: string): string => {
    const handle = requireHandle(handles, handleKey(name))
    const dbKey = normalizeDbName(name)
    const prefix = dbKey.includes('/') ? `${dbKey.replace(/\//g, '__')}-` : ''
    return path.join(dataDir, `.obox-meta-${prefix}${handle.table}.json`)
  }

  /** 取句柄（未打开 → 与 main 同一句中文错） */
  const handleOf = (name: string): SqliteHandle => requireHandle(handles, handleKey(name))

  /** 把任意错误变成 `Error`（`node:sqlite` 抛的是普通 Error，但 `throw` 可以抛任何值） */
  const asError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(toErrorMessage(error))

  /* -------------------------------------- 打开 / 关闭 -------------------------------------- */

  const open = async (name: string): Promise<SqliteDbResult> => {
    if (disposed) throw new Error('该扩展的 api 已释放（dispose 之后不能再 sqlite.open）')
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('api.sqlite.open 的 name 必须是非空相对路径（如 "todo.db"）')
    }
    const key = handleKey(name)
    // 同名重开：先关旧连接，否则旧 DatabaseSync 永不 close（句柄 / 文件锁泄漏）
    if (handles.has(key)) closeHandle(handles, key)
    const handle = openSqlite(extId, name, dataDir)
    handles.set(key, handle)

    // 每个方法都在**调用时**按键现取句柄（不是闭包捕获）：同名重开之后旧对象仍然指向新连接，
    // 这正是 main 的 ipc handler 的语义（每次 invoke 都 `requireHandle(handles, key)`）。
    const db: SqliteDbResult = {
      async exec(sql: string): Promise<{ ok: boolean; error?: string }> {
        try {
          const current = handleOf(name)
          // 挡住 ATTACH / VACUUM INTO / load_extension 等可读写库外文件的语句
          // （路径沙箱只覆盖库文件位置，兜不住这些语句）
          assertSafeSql(String(sql))
          current.raw.exec(String(sql))
          return { ok: true }
        } catch (error) {
          return { ok: false, error: toErrorMessage(asError(error)) }
        }
      },

      async query(sql: string, params?: unknown[]): Promise<SqliteRow[]> {
        try {
          const current = handleOf(name)
          assertSafeSql(String(sql))
          const normalized = (Array.isArray(params) ? params : []).map(normalizeValue)
          const rows = current.raw.prepare(String(sql)).all(...normalized) as unknown[]
          return readRows(metaPathFor(name), current.table, rows) as SqliteRow[]
        } catch (error) {
          throw asError(error)
        }
      },

      async insert(row: Record<string, unknown>): Promise<SqliteRow | null> {
        try {
          const current = handleOf(name)
          if (!row || typeof row !== 'object') throw new Error('insert 参数必须是对象')
          const inserted = insertRow(current, metaPathFor(name), row) as SqliteRow | undefined
          return inserted ?? null
        } catch (error) {
          throw asError(error)
        }
      },

      async update(where: SqliteWhere, patch: Record<string, unknown>): Promise<number> {
        try {
          const current = handleOf(name)
          if (!patch || typeof patch !== 'object') throw new Error('update patch 必须是对象')
          const condition = buildWhere(where ?? {})
          if (!condition.sql) throw new Error('update 需要条件（where 不能为空）')
          const keys = Object.keys(patch).filter((key) => key !== 'id')
          if (keys.length === 0) throw new Error('update patch 不能为空')
          const set = keys.map((key) => `"${key}" = ?`).join(', ')
          const info = current.raw
            .prepare(`UPDATE "${current.table}" SET ${set} WHERE ${condition.sql}`)
            .run(...keys.map((key) => normalizeValue(patch[key])), ...condition.params)
          return Number(info.changes)
        } catch (error) {
          throw asError(error)
        }
      },

      async get(id: unknown): Promise<SqliteRow | null> {
        try {
          const current = handleOf(name)
          const found = current.raw
            .prepare(`SELECT * FROM "${current.table}" WHERE id = ?`)
            .get(normalizeValue(id))
          if (!found) return null
          return (readRows(metaPathFor(name), current.table, [found])[0] as SqliteRow) ?? null
        } catch (error) {
          throw asError(error)
        }
      },

      async get_all(): Promise<SqliteRow[]> {
        try {
          const current = handleOf(name)
          if (!tableExists(current, current.table)) return []
          const rows = current.raw.prepare(`SELECT * FROM "${current.table}"`).all() as unknown[]
          return readRows(metaPathFor(name), current.table, rows) as SqliteRow[]
        } catch (error) {
          throw asError(error)
        }
      },

      async get_by(where: SqliteWhere): Promise<SqliteRow[]> {
        try {
          const current = handleOf(name)
          if (!tableExists(current, current.table)) return []
          const condition = buildWhere(where ?? {})
          const sql = condition.sql
            ? `SELECT * FROM "${current.table}" WHERE ${condition.sql}`
            : `SELECT * FROM "${current.table}"`
          const rows = current.raw.prepare(sql).all(...condition.params) as unknown[]
          return readRows(metaPathFor(name), current.table, rows) as SqliteRow[]
        } catch (error) {
          throw asError(error)
        }
      },

      async del(id: unknown): Promise<number> {
        try {
          const current = handleOf(name)
          const info = current.raw
            .prepare(`DELETE FROM "${current.table}" WHERE id = ?`)
            .run(normalizeValue(id))
          return Number(info.changes)
        } catch (error) {
          throw asError(error)
        }
      },

      async del_by(where: SqliteWhere): Promise<number> {
        try {
          const current = handleOf(name)
          const condition = buildWhere(where ?? {})
          if (!condition.sql) throw new Error('del_by 需要条件（where 不能为空）')
          const info = current.raw
            .prepare(`DELETE FROM "${current.table}" WHERE ${condition.sql}`)
            .run(...condition.params)
          return Number(info.changes)
        } catch (error) {
          throw asError(error)
        }
      },

      async clear(): Promise<number> {
        try {
          const current = handleOf(name)
          const info = current.raw.prepare(`DELETE FROM "${current.table}"`).run()
          return Number(info.changes)
        } catch (error) {
          throw asError(error)
        }
      },

      async close(): Promise<void> {
        closeHandle(handles, handleKey(name))
      }
    }
    return db
  }

  return {
    api: { open },
    openCount: (): number => handles.size,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const key of [...handles.keys()]) {
        try {
          closeHandle(handles, key)
        } catch (error) {
          // 关不掉不该让停用流程卡住：记一条 warn 就够了（句柄由进程退出兜底）
          options.log?.('warn', `[${extId}] 关闭数据库失败：${key}`, toErrorMessage(error))
        }
      }
      handles.clear()
    }
  }
}
