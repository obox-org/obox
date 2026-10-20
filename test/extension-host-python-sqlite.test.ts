/**
 * EH-B2 · `api.python.run` + `api.sqlite.open` 单测。
 *
 * 判据（任务卡 + R62）：
 * - **python**：宿主侧失败给稳定错误码的中文错误（`python-missing` / `launch-failed` /
 *   `invalid-declaration`）；`hostMain` 未接线时的降级文案**可执行**（指向 `host.pythonRuntime`）；
 *   真跑一个 sidecar（用**宿主自带的 Node** 冒充解释器，**不依赖 Python 与任何外部程序**）验证
 *   stdout / 退出码 / "脚本自身失败不抛错"；`opts.channel` 把进程注册成一条 `api.ipc` 通道并做一次
 *   JSON-RPC 往返；`dispose` 真的终止在跑进程；
 * - **sqlite**：建表/写入/查询/更新/删除/清空全链路、`exec` 的 `{ok:false}` 形状、同名重复 `open`、
 *   路径沙箱（绝对路径 / `..` 拒绝）、停用后关闭句柄；
 * - **R62 路径对齐**：扩展 data 目录逐字等于 `<init.dataDir>/extensions/<extId>/data`，且**旧数据能被
 *   读到**（在旧路径先放一份文件，再用新实现读）。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'

import {
  extensionDataDirOf,
  createExtensionApi,
  type BuiltExtensionApi
} from '../src/extension-host/apiFactory'
import { createIpcCapabilities, type IpcCapabilities } from '../src/extension-host/capabilities/ipc'
import {
  createPythonCapabilities,
  PYTHON_RUNTIME_METHOD,
  type HostPythonCapabilitiesOptions,
  type PythonCapabilities,
  type PythonRuntimeResponse
} from '../src/extension-host/capabilities/python'
import {
  createSqliteCapabilities,
  type SqliteCapabilities
} from '../src/extension-host/capabilities/sqlite'
import type { HostMainBridge } from '../src/extension-host/capabilities/io'
import { createRunExtensionSafely } from '../src/extension-host/safety'

/* -------------------------------------------------------------------------------------------- */
/* 夹具                                                                                          */
/* -------------------------------------------------------------------------------------------- */

const tempDirs: string[] = []
const disposables: Array<{ dispose(): void }> = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-b2-py-sqlite-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async (): Promise<void> => {
  for (const item of disposables.splice(0)) item.dispose()
  await Promise.all(tempDirs.splice(0).map((dir) => removeDir(dir)))
})

/** 删临时目录（尽力而为）：Windows 上被 kill 的子进程可能短暂锁住自己的 cwd */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch {
      await sleep(50)
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
}

/** 可注入的 `hostMain` 假件（只应答 `host.pythonRuntime`，记录调用参数） */
function createHostMain(
  reply: (params: unknown) => PythonRuntimeResponse | Promise<PythonRuntimeResponse>
): HostMainBridge & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    async request(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params })
      return await reply(params)
    }
  }
}

/** 当前进程环境 → 字符串表（冒充解释器跑 Node 脚本时需要 PATH/SystemRoot） */
function processEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/* -------------------------------------------------------------------------------------------- */
/* 1. python：宿主侧失败的降级与稳定错误码                                                         */
/* -------------------------------------------------------------------------------------------- */

interface PythonHarness {
  python: PythonCapabilities
  ipc: IpcCapabilities
  extensionDir: string
  hostMain: ReturnType<typeof createHostMain>
}

async function createPython(
  reply: (params: unknown) => PythonRuntimeResponse | Promise<PythonRuntimeResponse>,
  overrides: Partial<HostPythonCapabilitiesOptions> = {}
): Promise<PythonHarness> {
  const root = await makeTempDir()
  const extensionDir = path.join(root, 'py-ext')
  await mkdir(extensionDir, { recursive: true })
  const ipc = createIpcCapabilities({
    extId: 'py-ext',
    extensionDir,
    extensionDataDir: path.join(extensionDir, 'data'),
    log: (): void => {}
  })
  disposables.push(ipc)
  const hostMain = createHostMain(reply)
  const python = createPythonCapabilities({
    extId: 'py-ext',
    log: (): void => {},
    hostMain,
    ipc,
    ...overrides
  })
  disposables.push(python)
  return { python, ipc, extensionDir, hostMain }
}

test('python：hostMain 未接线 → [launch-failed] +「宿主未接入 host→main 通道」中文可执行错误', async () => {
  const { python } = await createPython(async () => ({
    ok: false,
    code: 'launch-failed',
    error: ''
  }))
  const bare = createPythonCapabilities({
    extId: 'py-ext',
    log: (): void => {},
    ipc: { registerStreamChannel: (): void => {}, closeChannel: (): void => {} }
  })
  disposables.push(bare)

  await assert.rejects(bare.api.run('scripts/main.py'), (error: unknown): boolean => {
    const message = String((error as Error).message)
    assert.match(message, /^\[launch-failed\]/, '必须是 python 的稳定错误码前缀')
    assert.match(message, /宿主未接入 host→main 通道/, '必须说清是"桥没接上"')
    assert.match(message, /host\.pythonRuntime/, '必须指向具体 RPC（可执行，而不是"未迁移"）')
    assert.doesNotMatch(message, /尚未迁移/)
    return true
  })
  // 未接线时也不该凭空调用 run
  assert.equal(python.runningCount(), 0)
})

test('python：RPC 回 python-missing → 抛 [python-missing]（脚本自身失败才不抛）', async () => {
  const harness = await createPython(async () => ({
    ok: false,
    code: 'python-missing',
    error: '扩展未自带该架构的 Python 运行时：<ext>/python/python.exe'
  }))
  await assert.rejects(harness.python.api.run('scripts/main.py'), /\[python-missing\]/)
  assert.deepEqual(
    harness.hostMain.calls.map((call) => call.method),
    [PYTHON_RUNTIME_METHOD],
    '必须走 host.pythonRuntime 这条宿主内部 RPC'
  )
  assert.deepEqual(harness.hostMain.calls[0]?.params, {
    extId: 'py-ext',
    script: 'scripts/main.py'
  })
})

test('python：RPC 本身失败 / 返回无法识别的形状 → [launch-failed] 中文错误', async () => {
  const failing = await createPython(() => {
    throw new Error('链路断开')
  })
  await assert.rejects(failing.python.api.run('a.py'), /\[launch-failed\] 读取 Python 运行时失败/)

  const garbage = await createPython(async () => ({ ok: true }) as unknown as PythonRuntimeResponse)
  await assert.rejects(garbage.python.api.run('a.py'), /\[python-missing\]/)
})

test('python：参数校验（空脚本 / 非法通道名）在请求 main 之前就失败', async () => {
  const harness = await createPython(async () => ({
    ok: true,
    exePath: process.execPath,
    scriptPath: 'whatever.js',
    env: processEnv(),
    cwd: tmpdir()
  }))

  await assert.rejects(harness.python.api.run('   '), /\[invalid-declaration\] 脚本路径不能为空/)
  await assert.rejects(
    harness.python.api.run('a.py', [], { channel: 'bad name!' }),
    /\[invalid-declaration\]/
  )
  assert.deepEqual(harness.hostMain.calls, [], '参数就错了：不该白问一次 main')
})

/* -------------------------------------------------------------------------------------------- */
/* 2. python：真跑一个 sidecar（用宿主自带的 Node 冒充解释器）                                       */
/* -------------------------------------------------------------------------------------------- */

test('python：真跑脚本 → 收 stdout/stderr 与退出码（脚本失败不抛错）', async () => {
  const root = await makeTempDir()
  const scriptPath = path.join(root, 'main.js')
  await writeFile(
    scriptPath,
    "console.log('hello from sidecar'); console.error('warn line'); process.exit(3)\n",
    'utf8'
  )
  const harness = await createPython(async () => ({
    ok: true,
    exePath: process.execPath,
    scriptPath,
    env: processEnv(),
    cwd: root
  }))

  const result = await harness.python.api.run('main.js')
  assert.equal(result.code, 3, '脚本自身失败要如实回退出码（不抛错）')
  assert.match(result.stdout, /hello from sidecar/)
  assert.match(result.stderr, /warn line/)
  assert.equal(harness.python.runningCount(), 0, '跑完必须从在跑集合里摘掉')
}, 30_000)

/** 冒充解释器的 JSON-RPC sidecar：回一条 `ping` 结果后退出（验证 `opts.channel`） */
const PY_CHANNEL_SIDECAR = `let buffered = Buffer.alloc(0)

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write('Content-Length: ' + payload.length + '\\r\\n\\r\\n')
  process.stdout.write(payload)
}

process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk])
  for (;;) {
    const headerEnd = buffered.indexOf('\\r\\n\\r\\n')
    if (headerEnd < 0) return
    const header = buffered.subarray(0, headerEnd).toString('ascii')
    const match = /Content-Length:\\s*(\\d+)/i.exec(header)
    if (!match) return
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buffered.length < bodyStart + length) return
    const payload = buffered.subarray(bodyStart, bodyStart + length).toString('utf8')
    buffered = buffered.subarray(bodyStart + length)
    const message = JSON.parse(payload)
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: { pong: message.params } })
      setTimeout(() => process.exit(0), 30)
    }
  }
})
`

test('python：opts.channel 把进程注册成 api.ipc 通道，可做一次 JSON-RPC 往返，进程结束后通道注销', async () => {
  const root = await makeTempDir()
  const scriptPath = path.join(root, 'channel.js')
  await writeFile(scriptPath, PY_CHANNEL_SIDECAR, 'utf8')
  const harness = await createPython(async () => ({
    ok: true,
    exePath: process.execPath,
    scriptPath,
    env: processEnv(),
    cwd: root
  }))

  const running = harness.python.api.run('channel.js', [], { channel: 'py' })
  await waitFor(() => harness.ipc.channelNames().includes('py'), 20_000, '通道被注册')
  assert.deepEqual(await harness.ipc.api.request('py', 'ping', { n: 1 }), { pong: { n: 1 } })

  const result = await running
  assert.equal(result.code, 0, '未传 args 时不能把 undefined 变成 ["undefined"]')
  await waitFor(() => !harness.ipc.channelNames().includes('py'), 10_000, '进程结束后通道注销')
}, 40_000)

test('python：dispose 真的终止在跑的进程（run 以 code=null 收尾，不是永远挂着）', async () => {
  const root = await makeTempDir()
  const scriptPath = path.join(root, 'forever.js')
  await writeFile(scriptPath, 'setInterval(() => {}, 1000)\n', 'utf8')
  const harness = await createPython(async () => ({
    ok: true,
    exePath: process.execPath,
    scriptPath,
    env: processEnv(),
    cwd: root
  }))

  const running = harness.python.api.run('forever.js')
  await waitFor(() => harness.python.runningCount() === 1, 20_000, '进程已起')
  harness.python.dispose()
  assert.equal(harness.python.runningCount(), 0, 'dispose 之后在跑集合必须为空')
  const result = await running
  // 被杀掉的进程：Windows 的 taskkill 让 cmd 包装层以 1 收尾、POSIX 下是 null——两者都算"非正常结束"，
  // 这里只钉"run 必须收尾、且不是成功退出"（反例：永不返回 / 回 code 0）
  assert.notEqual(result.code, 0, '被终止的进程不能报成功退出')
  // 幂等
  harness.python.dispose()
}, 40_000)

/* -------------------------------------------------------------------------------------------- */
/* 3. sqlite：全链路                                                                              */
/* -------------------------------------------------------------------------------------------- */

interface SqliteHarness {
  sqlite: SqliteCapabilities
  dataDir: string
}

async function createSqlite(): Promise<SqliteHarness> {
  const root = await makeTempDir()
  const dataDir = path.join(root, 'sql-ext', 'data')
  const sqlite = createSqliteCapabilities({
    extId: 'sql-ext',
    extensionDataDir: dataDir,
    log: (): void => {}
  })
  disposables.push(sqlite)
  return { sqlite, dataDir }
}

test('sqlite：exec 建表 → insert → get/get_all/query/get_by → update → del/del_by/clear', async () => {
  const { sqlite } = await createSqlite()
  const db = await sqlite.api.open('todo.db')

  assert.deepEqual(
    await db.exec('CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, t TEXT)'),
    {
      ok: true
    }
  )

  // 首次 insert 自动建表（默认表 = 文件名去扩展名 `todo`）＋ boolean/number 的类型还原
  const first = await db.insert({ t: '第一行', done: false, priority: 2 })
  assert.equal(typeof first?.id, 'number')
  assert.equal(first?.done, false, 'boolean 走 INTEGER 存 + 元数据还原')
  assert.equal(first?.priority, 2)

  const second = await db.insert({ t: '第二行', done: true })
  assert.equal(await db.get_all().then((rows) => rows.length), 2)

  const byId = await db.get(first?.id)
  assert.equal(byId?.t, '第一行')
  assert.equal(await db.get(999_999), null, '取不到必须是 null')

  assert.deepEqual(await db.get_by({ done: true }), [second], 'get_by 是等值多键 AND')

  const queried = await db.query('SELECT t FROM "todo" WHERE id = ?', [second?.id])
  assert.deepEqual(queried, [{ t: '第二行' }], 'query 是原样 SQL（含参数化）')

  assert.equal(await db.update({ id: first?.id }, { t: '改过了' }), 1)
  assert.equal((await db.get(first?.id))?.t, '改过了')

  assert.equal(await db.del(second?.id), 1)
  assert.equal(await db.del_by({ t: '改过了' }), 1)
  assert.equal(await db.get_all().then((rows) => rows.length), 0)

  await db.insert({ t: '再来一行' })
  assert.equal(await db.clear(), 1, 'clear 返回受影响行数')
}, 30_000)

test('sqlite：exec 回 {ok:false}（危险 SQL 被拦、未打开就操作抛错）', async () => {
  const { sqlite } = await createSqlite()
  const db = await sqlite.api.open('safe.db')

  const attached = await db.exec("ATTACH DATABASE 'C:/evil.db' AS evil")
  assert.equal(attached.ok, false)
  assert.match(attached.error ?? '', /不允许的 SQL 语句：ATTACH/)

  await assert.rejects(db.update({}, { a: 1 }), /update 需要条件/)
  await assert.rejects(db.del_by({}), /del_by 需要条件/)
  await assert.rejects(db.insert(null as unknown as Record<string, unknown>), /必须是对象/)
}, 30_000)

test('sqlite：同名重复 open 不双开连接（旧句柄仍指向新连接）', async () => {
  const { sqlite, dataDir } = await createSqlite()
  const first = await sqlite.api.open('again.db')
  await first.insert({ t: '一行' })
  assert.equal(sqlite.openCount(), 1)

  const second = await sqlite.api.open('./again.db')
  assert.equal(sqlite.openCount(), 1, '归一化后是同一个库：不得双开')

  // 旧句柄每次都按键现取连接 → 仍能继续操作（与 main 的 handler 语义一致）
  assert.equal(await first.get_all().then((rows) => rows.length), 1)
  assert.equal(await second.get_all().then((rows) => rows.length), 1)
  assert.ok(existsSync(path.join(dataDir, 'again.db')), '库文件落在扩展 data 目录')
}, 30_000)

test('sqlite：路径沙箱（绝对路径 / .. 拒绝）与子目录库自动建目录', async () => {
  const { sqlite, dataDir } = await createSqlite()
  await assert.rejects(sqlite.api.open('C:/evil.db'), /相对路径/)
  await assert.rejects(sqlite.api.open('../escape.db'), /\.\./)
  await assert.rejects(sqlite.api.open('   '), /name 必须是非空相对路径/)

  const nested = await sqlite.api.open('sub/nested.db')
  await nested.insert({ t: 'x' })
  assert.ok(existsSync(path.join(dataDir, 'sub', 'nested.db')), '子目录必须自动创建')
  // 子目录库的列类型元数据带库路径前缀（避免与根目录同名表互串）；
  // 文件名规则与 main 的 `metaPathFor` 逐字一致：`.obox-meta-<库路径 `/`→`__`>-<表名>.json`
  assert.ok(existsSync(path.join(dataDir, '.obox-meta-sub__nested.db-nested.json')))
}, 30_000)

test('sqlite：dispose 关掉全部连接（之后操作报"数据库未打开"）', async () => {
  const { sqlite } = await createSqlite()
  const db = await sqlite.api.open('close.db')
  await db.insert({ t: 'x' })
  assert.equal(sqlite.openCount(), 1)

  sqlite.dispose()
  assert.equal(sqlite.openCount(), 0)
  await assert.rejects(db.get_all(), /数据库未打开/)
  // 幂等
  sqlite.dispose()
}, 30_000)

/* -------------------------------------------------------------------------------------------- */
/* 4. R62：data 目录逐字对齐旧路径，且旧数据读得到                                                     */
/* -------------------------------------------------------------------------------------------- */

test('R62：扩展 data 目录 = <init.dataDir>/extensions/<extId>/data，旧路径的数据读得到', async () => {
  const root = await makeTempDir()
  // init.dataDir（userData）
  const userDataDir = path.join(root, 'userData')
  const extensionDir = path.join(userDataDir, 'extensions', 'legacy-ext')
  const legacyDataDir = path.join(extensionDir, 'data')
  await mkdir(legacyDataDir, { recursive: true })
  // 升级前老扩展写下的文件（旧实现按 `<userData>/extensions/<id>/data` 落盘）
  await writeFile(path.join(legacyDataDir, 'old.txt'), 'legacy payload', 'utf8')

  // 唯一计算点必须逐字等于 main 的 dataDirFor
  assert.equal(extensionDataDirOf(extensionDir), legacyDataDir)
  assert.equal(
    extensionDataDirOf(extensionDir),
    path.join(userDataDir, 'extensions', 'legacy-ext', 'data')
  )

  const built: BuiltExtensionApi = createExtensionApi({
    ext: {
      id: 'legacy-ext',
      version: '1.0.0',
      path: extensionDir,
      activationEvents: [],
      apiVersion: 3
    },
    appInfo: { name: 'obox', version: '9.9.9' },
    locale: 'zh',
    log: (): void => {},
    runSafely: createRunExtensionSafely((): void => {})
  })
  disposables.push(built)

  // 旧数据读得到（不是"文件消失了"，而是新代码去对了目录）
  assert.equal(await built.api.fs.readFile('old.txt'), 'legacy payload')
  // 新写入也落在同一个目录
  await built.api.fs.writeFile('new.txt', 'fresh')
  assert.equal(await readFile(path.join(legacyDataDir, 'new.txt'), 'utf8'), 'fresh')

  // sqlite 同样落在该目录（R62 的三条能力共用一个 root）
  const db = await built.api.sqlite.open('legacy.db')
  await db.insert({ t: 'row' })
  assert.ok(existsSync(path.join(legacyDataDir, 'legacy.db')))
}, 30_000)
