/**
 * EH-B2 · `api.ipc` 单测（14 个成员）。
 *
 * 判据（`docs/extension-host-migration.md` 的 EH-B2 行 + 任务卡要求）：
 * - **sidecar 启停**：`connect` 真的 spawn 一个 stdio 子进程（用**宿主自带的 Node** 跑一个
 *   测试脚本，**不依赖任何外部程序**），JSON-RPC 2.0 + `Content-Length` 分帧往返；
 * - **双向**：宿主 → 对端 `request`/`notify`；对端 → 宿主 `onRequest`（回包）、`onNotification`；
 * - **错误路径**：对端回错误帧、请求超时、进程意外退出（`peer-crashed` + `onClose`）；
 * - **清理**：`dispose()` 之后**子进程真的被杀**（用 `process.kill(pid, 0)` 断言，不是"调用过 kill"）；
 * - **限额与定向规则**：重名 / 每扩展上限 / client 带 `connectionId` / server 缺 `connectionId`；
 * - **清单静态声明**：`connect('<id>')` 读 `<扩展目录>/manifest.json` 的 `contributes.ipcChannels`，
 *   且**只读一次盘**（R61）；
 * - **server 通道**：`listen(pipe)` 接受连接、`connectionId` 定向请求、`broadcast`、`onDisconnect`。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'

import {
  createIpcCapabilities,
  MAX_CHANNELS_PER_EXTENSION,
  type HostIpcCapabilitiesOptions,
  type IpcCapabilities
} from '../src/extension-host/capabilities/ipc'
import { ipcEndpoint } from '../src/main/ipcCore'
import { openPipeClientTransport, type IpcTransportHandles } from '../src/main/ipcTransport'

/* -------------------------------------------------------------------------------------------- */
/* 夹具                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * 测试用 sidecar：**不依赖任何外部程序**（用宿主自带的 Node 跑），实现 JSON-RPC 2.0 +
 * `Content-Length` 分帧。行为：
 * - 启动即向宿主发一条请求 `hello`（验证宿主 `onRequest` 回包路径），拿到回包后发通知 `host-said`；
 * - `echo` → 回 `{ echo: params }`；`boom` → 回错误帧；`hang` → **不回包**（超时用例）；
 * - `crash` → 直接 `exit(3)`（意外退出用例）；
 * - 收到通知 `note` → 回通知 `noted`；
 * - 其余情况保持存活（等 stdin 关闭），供"清理时进程真被杀"用例使用。
 */
const ECHO_SIDECAR = `import { writeFileSync } from 'node:fs'

// 把 pid 写进 argv[1]（可选）：测试用它断言"清理时进程真被杀"
if (process.argv[2]) {
  try { writeFileSync(process.argv[2], String(process.pid), 'utf8') } catch {}
}

// 分帧必须按**字节**做（Content-Length 是字节数）：字符串索引遇到中文会把下一条帧啃掉。
let buffered = Buffer.alloc(0)

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write('Content-Length: ' + payload.length + '\\r\\n\\r\\n')
  process.stdout.write(payload)
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

function handle(message) {
  if (message.method === undefined) {
    // 宿主对"我发出去的请求"的回包
    notify('host-said', message.result === undefined ? null : message.result)
    return
  }
  const { id, method, params } = message
  if (id === undefined) {
    if (method === 'note') notify('noted', params)
    return
  }
  if (method === 'echo') { reply(id, { echo: params }); return }
  if (method === 'boom') { replyError(id, '对端故意失败'); return }
  if (method === 'hang') return
  if (method === 'crash') { process.exit(3) }
  replyError(id, '未知方法: ' + method)
}

process.stderr.write('sidecar-ready\\n')
// 主动向宿主发一条请求（验证 onRequest 双向）
send({ jsonrpc: '2.0', id: 900, method: 'hello', params: { from: 'sidecar' } })

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
    try { handle(JSON.parse(payload)) } catch (error) { process.stderr.write(String(error)) }
  }
})
`

const tempDirs: string[] = []
const created: IpcCapabilities[] = []
const peers: IpcTransportHandles[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-b2-ipc-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async (): Promise<void> => {
  for (const ipc of created.splice(0)) ipc.dispose()
  for (const peer of peers.splice(0)) peer.dispose()
  await Promise.all(tempDirs.splice(0).map((dir) => removeDir(dir)))
})

/**
 * 删临时目录（**尽力而为**）。
 *
 * Windows 上子进程被 kill 之后，它的 cwd（扩展 data 目录）可能还被内核短暂锁着，`rm` 会 EBUSY。
 * 这不是实现缺陷（进程确实在死），所以这里重试一小会儿；仍失败就放弃——临时目录由系统清理，
 * 不该把一条"实现正确"的用例刷成红色。
 */
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

interface CapturedLog {
  level: string
  message: string
  detail?: string
}

interface IpcHarness {
  ipc: IpcCapabilities
  /** 扩展根目录（`program` 的解析基准） */
  extensionDir: string
  /** 扩展 data 目录（stdio 的 cwd） */
  dataDir: string
  logs: CapturedLog[]
}

/** 造一份 IPC 能力族：扩展目录里放好测试 sidecar，manifest 由各用例自己写 */
async function createHarness(
  overrides: Partial<HostIpcCapabilitiesOptions> = {}
): Promise<IpcHarness> {
  const root = await makeTempDir()
  const extensionDir = path.join(root, 'ext')
  const dataDir = path.join(extensionDir, 'data')
  await mkdir(path.join(extensionDir, 'sidecar'), { recursive: true })
  await writeFile(path.join(extensionDir, 'sidecar', 'echo.mjs'), ECHO_SIDECAR, 'utf8')
  const logs: CapturedLog[] = []
  const ipc = createIpcCapabilities({
    extId: 'ipc-ext',
    extensionDir,
    extensionDataDir: dataDir,
    log: (level, message, detail): void => {
      logs.push({ level, message, ...(detail === undefined ? {} : { detail }) })
    },
    ...overrides
  })
  created.push(ipc)
  return { ipc, extensionDir, dataDir, logs }
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

/** 进程是否还活着（`kill(pid, 0)` 只探测不发送信号） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 1. stdio sidecar：启动、双向 JSON-RPC、stderr                                                        */
/* -------------------------------------------------------------------------------------------- */

test('stdio sidecar：connect 拉起子进程，request/notify/onNotification/onStderr/onRequest 全通', async () => {
  const harness = await createHarness()
  const stderr: string[] = []
  const notifications: Array<{ method: string; params: unknown }> = []
  const inbound: string[] = []

  harness.ipc.api.onStderr('echo', (text) => stderr.push(text))
  harness.ipc.api.onNotification('echo', (method, params) => {
    notifications.push({ method, params })
  })
  harness.ipc.api.onRequest('echo', (method, params) => {
    inbound.push(method)
    return { pong: params }
  })

  await harness.ipc.api.connect({
    id: 'echo',
    transport: 'stdio',
    program: 'sidecar/echo.mjs'
  })
  assert.deepEqual(await harness.ipc.api.channels(), ['echo'], 'channels() 只含已打开的通道名')

  // 对端启动时主动发的请求 → 宿主 handler 回包 → 对端把回包用通知报回来
  await waitFor(
    () => notifications.some((note) => note.method === 'host-said'),
    10_000,
    '对端收到宿主回包'
  )
  const hostSaid = notifications.find((note) => note.method === 'host-said')
  assert.deepEqual(hostSaid?.params, { pong: { from: 'sidecar' } }, '宿主回包内容必须原样回到对端')
  assert.deepEqual(inbound, ['hello'], 'onRequest 必须收到对端的 hello')

  // stderr → onStderr（stdio 的日志流）
  await waitFor(() => stderr.join('').includes('sidecar-ready'), 10_000, 'stderr 转发')

  // 宿主 → 对端：请求往返 + 通知
  assert.deepEqual(
    await harness.ipc.api.request('echo', 'echo', { a: 1, b: 'x' }),
    { echo: { a: 1, b: 'x' } },
    'request 的 result 必须是对端回的 JSON'
  )
  await harness.ipc.api.notify('echo', 'note', { n: 2 })
  await waitFor(() => notifications.some((note) => note.method === 'noted'), 10_000, '对端通知')
  assert.deepEqual(
    notifications.find((note) => note.method === 'noted')?.params,
    { n: 2 },
    'notify 的参数必须原样到达对端'
  )
}, 30_000)

test('错误帧：对端回 JSON-RPC error → 请求以 protocol-error 失败（通道不关）', async () => {
  const harness = await createHarness()
  await harness.ipc.api.connect({ id: 'echo', transport: 'stdio', program: 'sidecar/echo.mjs' })

  await assert.rejects(harness.ipc.api.request('echo', 'boom'), (error: unknown): boolean => {
    assert.match(String((error as Error).message), /对端返回错误/)
    return true
  })
  // 错误响应只结算那一条请求：通道仍然可用
  assert.deepEqual(await harness.ipc.api.channels(), ['echo'])
  assert.deepEqual(await harness.ipc.api.request('echo', 'echo', 1), { echo: 1 })
}, 30_000)

test('超时：opts.timeoutMs 生效，抛 timeout 且通道仍可用', async () => {
  const harness = await createHarness()
  await harness.ipc.api.connect({ id: 'echo', transport: 'stdio', program: 'sidecar/echo.mjs' })

  const startedAt = Date.now()
  await assert.rejects(
    harness.ipc.api.request('echo', 'hang', undefined, { timeoutMs: 120 }),
    /超时/
  )
  assert.ok(Date.now() - startedAt < 5000, '超时必须按 timeoutMs 生效（不是默认 30s）')
  assert.deepEqual(await harness.ipc.api.request('echo', 'echo', 'after-timeout'), {
    echo: 'after-timeout'
  })
}, 30_000)

test('进程意外退出：在途请求以 peer-crashed 失败、onClose 触发、通道从 channels() 消失', async () => {
  const harness = await createHarness()
  const closes: Array<{ code: string; message: string }> = []
  harness.ipc.api.onClose('echo', (error) => closes.push(error))
  await harness.ipc.api.connect({ id: 'echo', transport: 'stdio', program: 'sidecar/echo.mjs' })

  await assert.rejects(harness.ipc.api.request('echo', 'crash'), /peer-crashed/)
  await waitFor(() => closes.length > 0, 10_000, 'onClose')
  assert.equal(closes[0]?.code, 'peer-crashed', '断因必须是 peer-crashed')
  assert.deepEqual(await harness.ipc.api.channels(), [], '崩溃后通道必须从 channels() 消失')
}, 30_000)

test('并发请求：3 条同时发出，各自拿到自己的 result（不串包）', async () => {
  const harness = await createHarness()
  await harness.ipc.api.connect({ id: 'echo', transport: 'stdio', program: 'sidecar/echo.mjs' })

  const results = await Promise.all([
    harness.ipc.api.request('echo', 'echo', { n: 1 }),
    harness.ipc.api.request('echo', 'echo', { n: 2 }),
    harness.ipc.api.request('echo', 'echo', { n: 3 })
  ])
  assert.deepEqual(results, [{ echo: { n: 1 } }, { echo: { n: 2 } }, { echo: { n: 3 } }])
}, 30_000)

/* -------------------------------------------------------------------------------------------- */
/* 2. 声明校验与定向规则                                                                          */
/* -------------------------------------------------------------------------------------------- */

test('connect 失败路径：可执行文件不存在 → connect-failed；越界 → invalid-declaration', async () => {
  const harness = await createHarness()

  // 非 .js 的 program 直接执行：文件不存在 → spawn 失败 → connect-failed
  // （写成 .mjs 的话 spawn 会成功、再由 Node 报找不到模块，那是 peer-crashed 而不是 connect-failed）
  await assert.rejects(
    harness.ipc.api.connect({ id: 'missing', transport: 'stdio', program: 'sidecar/nope.exe' }),
    (error: unknown): boolean => {
      assert.match(String((error as Error).message), /connect-failed/)
      return true
    }
  )
  await assert.rejects(
    harness.ipc.api.connect({ id: 'escape', transport: 'stdio', program: '../evil.mjs' }),
    /invalid-declaration/
  )
  assert.deepEqual(await harness.ipc.api.channels(), [], '失败的首连不得留下通道')
}, 30_000)

test('定向规则：名字不存在 → not-connected；client 带 connectionId / broadcast → invalid-declaration', async () => {
  const harness = await createHarness()
  await assert.rejects(harness.ipc.api.request('missing', 'x'), /not-connected/)
  await assert.rejects(harness.ipc.api.notify('missing', 'x'), /not-connected/)

  await harness.ipc.api.connect({ id: 'echo', transport: 'stdio', program: 'sidecar/echo.mjs' })
  await assert.rejects(
    harness.ipc.api.request('echo', 'echo', {}, { connectionId: 1 }),
    /客户端通道/
  )
  await assert.rejects(
    harness.ipc.api.notify('echo', 'note', {}, { connectionId: 1 }),
    /客户端通道/
  )
  await assert.rejects(harness.ipc.api.broadcast('echo', 'tick'), /客户端通道/)
}, 30_000)

test('限额：重名 → invalid-declaration；超过每扩展上限 → too-many-channels', async () => {
  const harness = await createHarness({ maxChannels: 2 })
  assert.equal(MAX_CHANNELS_PER_EXTENSION, 4, '与 main 的限额一致（每扩展 4 条）')

  await harness.ipc.api.connect({ id: 'a', transport: 'stdio', program: 'sidecar/echo.mjs' })
  await assert.rejects(
    harness.ipc.api.connect({ id: 'a', transport: 'stdio', program: 'sidecar/echo.mjs' }),
    /已打开/
  )
  await harness.ipc.api.connect({ id: 'b', transport: 'stdio', program: 'sidecar/echo.mjs' })
  await assert.rejects(
    harness.ipc.api.connect({ id: 'c', transport: 'stdio', program: 'sidecar/echo.mjs' }),
    /too-many-channels/
  )
  await harness.ipc.api.close('a')
  assert.deepEqual(await harness.ipc.api.channels(), ['b'], 'close 之后额度应释放')
  await harness.ipc.api.connect({ id: 'c', transport: 'stdio', program: 'sidecar/echo.mjs' })
}, 30_000)

/* -------------------------------------------------------------------------------------------- */
/* 3. 清单静态声明（R61：宿主自己读 manifest.json，且只读一次盘）                                        */
/* -------------------------------------------------------------------------------------------- */

test("connect('<id>')：从 <扩展目录>/manifest.json 读 contributes.ipcChannels（真实文件）", async () => {
  const harness = await createHarness()
  await writeFile(
    path.join(harness.extensionDir, 'manifest.json'),
    JSON.stringify({
      name: 'ipc-ext',
      main: 'index.mjs',
      contributes: {
        ipcChannels: [{ id: 'echo', transport: 'stdio', program: 'sidecar/echo.mjs' }]
      }
    }),
    'utf8'
  )

  await harness.ipc.api.connect('echo')
  assert.deepEqual(await harness.ipc.api.channels(), ['echo'])
  assert.deepEqual(await harness.ipc.api.request('echo', 'echo', { via: 'manifest' }), {
    echo: { via: 'manifest' }
  })

  // 清单里没有的 id → 明确的中文错误（不影响对象形式）
  await assert.rejects(harness.ipc.api.connect('nope'), /清单里没有声明通道 nope/)
}, 30_000)

test('清单解析：只读一次盘（同一扩展多次 connect 不再读）+ 畸形清单给可执行的中文错误', async () => {
  let reads = 0
  const harness = await createHarness({
    readManifest: (): string => {
      reads += 1
      return JSON.stringify({
        contributes: {
          ipcChannels: [{ id: 'echo', transport: 'stdio', program: 'sidecar/echo.mjs' }]
        }
      })
    }
  })

  await harness.ipc.api.connect('echo')
  // 第二次同 id：先解析清单（命中缓存、不再读盘），再由槽位校验报"已打开"
  await assert.rejects(harness.ipc.api.connect('echo'), /已打开/)
  assert.equal(reads, 1, 'manifest.json 只能读一次（进程内缓存）')

  // 读不到清单
  const missing = await createHarness({
    readManifest: (): string => {
      throw new Error('ENOENT: no such file')
    }
  })
  await assert.rejects(missing.ipc.api.connect('echo'), /读取扩展清单失败/)
  // 非法 JSON
  const broken = await createHarness({ readManifest: (): string => '{ 不是 json' })
  await assert.rejects(broken.ipc.api.connect('echo'), /不是合法 JSON/)
  // ipcChannels 形状非法（复用清单校验器的文案）
  const invalid = await createHarness({
    readManifest: (): string =>
      JSON.stringify({ contributes: { ipcChannels: [{ id: 'x', transport: 'tcp' }] } })
  })
  await assert.rejects(invalid.ipc.api.connect('x'), /contributes\.ipcChannels 非法/)
}, 30_000)

/* -------------------------------------------------------------------------------------------- */
/* 4. 清理：进程真被杀                                                                             */
/* -------------------------------------------------------------------------------------------- */

test('dispose：杀光 sidecar 子进程（真 exit，不是"调用过 kill"）、清空通道、幂等', async () => {
  const harness = await createHarness()
  await harness.ipc.api.connect({ id: 'echo', transport: 'stdio', program: 'sidecar/echo.mjs' })
  const pids = harness.ipc.childPids()
  assert.equal(pids.length, 1, 'childPids 应报出那条 sidecar')
  const pid = pids[0]
  assert.ok(isAlive(pid), 'dispose 之前子进程必须活着')

  harness.ipc.dispose()
  // 先 kill 后宽限强杀：这里断言进程**真的结束**（Windows 上 TerminateProcess 同样生效）
  await waitFor(() => !isAlive(pid), 10_000, '子进程被杀死')
  assert.deepEqual(harness.ipc.childPids(), [], 'dispose 之后不得留下活动子进程')
  assert.deepEqual(await harness.ipc.api.channels(), [], 'dispose 之后通道表必须清空')

  // 幂等：重复 dispose 不抛错
  harness.ipc.dispose()
  // 释放之后不能再开通道
  await assert.rejects(
    harness.ipc.api.connect({ id: 'late', transport: 'stdio', program: 'sidecar/echo.mjs' }),
    /已释放/
  )
}, 30_000)

/* -------------------------------------------------------------------------------------------- */
/* 5. server 通道（listen / pipe）                                                                 */
/* -------------------------------------------------------------------------------------------- */

test('listen(pipe)：接受连接、connectionId 定向 request、broadcast、onDisconnect', async () => {
  const root = await makeTempDir()
  const socketDir = path.join(root, 'ipc')
  const harness = await createHarness({ socketDir })

  const connections: number[] = []
  const disconnects: Array<{ connectionId: number; code: string }> = []
  harness.ipc.api.onConnection('svc', (connectionId) => connections.push(connectionId))
  harness.ipc.api.onDisconnect('svc', (connectionId, error) => {
    disconnects.push({ connectionId, code: error.code })
  })
  harness.ipc.api.onRequest('svc', (method, params) => ({ from: 'host', method, params }))

  // listen 只支持 pipe
  await assert.rejects(harness.ipc.api.listen({ id: 'bad', transport: 'stdio' }), /只支持 pipe/)
  await harness.ipc.api.listen({ id: 'svc', transport: 'pipe' })
  assert.deepEqual(await harness.ipc.api.channels(), ['svc'])

  // 对端：直接用 main 的 pipe 客户端传输（同一套协议，证明两端可互通）
  const peer = openPipeClientTransport({
    endpoint: ipcEndpoint({ socketDir, extensionId: 'ipc-ext', name: 'svc' })
  })
  peers.push(peer)
  await peer.ready
  await waitFor(() => connections.length === 1, 10_000, 'onConnection')
  const connectionId = connections[0]
  assert.ok(connectionId > 0, 'connectionId 必须是正整数')

  // 宿主 → 对端（定向到该连接）
  peer.channel.setDefaultHandler((method, params) => ({ method, params }))
  assert.deepEqual(await harness.ipc.api.request('svc', 'ping', { n: 1 }, { connectionId }), {
    method: 'ping',
    params: { n: 1 }
  })

  // 对端 → 宿主（server 通道的对端请求走同一个 onRequest）
  assert.deepEqual(await peer.channel.request('who'), { from: 'host', method: 'who' })

  // broadcast：通知语义，不收集回包
  const notes: Array<{ method: string; params: unknown }> = []
  peer.channel.onNotification((method, params) => notes.push({ method, params }))
  await harness.ipc.api.broadcast('svc', 'tick', { n: 2 })
  await waitFor(() => notes.length === 1, 10_000, 'broadcast 到达对端')
  assert.deepEqual(notes[0], { method: 'tick', params: { n: 2 } })

  // 定向规则的另一半：server 名字省略 connectionId → invalid-declaration
  await assert.rejects(harness.ipc.api.request('svc', 'ping'), /必须指定 connectionId/)
  await assert.rejects(
    harness.ipc.api.request('svc', 'ping', {}, { connectionId: 999_999 }),
    /not-connected/
  )

  // 对端断开 → onDisconnect（每条连接恰好一次）
  peer.dispose()
  await waitFor(() => disconnects.length === 1, 10_000, 'onDisconnect')
  assert.equal(disconnects[0]?.connectionId, connectionId)
  assert.equal(disconnects[0]?.code, 'peer-crashed')
}, 30_000)

test('分帧：ndjson 透传到传输层（listen 与对端都用 ndjson 也能往返）', async () => {
  const root = await makeTempDir()
  const socketDir = path.join(root, 'ipc')
  const harness = await createHarness({ socketDir })

  const connections: number[] = []
  harness.ipc.api.onConnection('nd', (connectionId) => connections.push(connectionId))
  await harness.ipc.api.listen({ id: 'nd', transport: 'pipe', framing: 'ndjson' })

  const peer = openPipeClientTransport({
    endpoint: ipcEndpoint({ socketDir, extensionId: 'ipc-ext', name: 'nd' }),
    framing: 'ndjson'
  })
  peers.push(peer)
  await peer.ready
  await waitFor(() => connections.length === 1, 10_000, 'onConnection')

  peer.channel.setDefaultHandler((method, params) => ({ method, params }))
  assert.deepEqual(
    await harness.ipc.api.request('nd', 'ping', { n: 7 }, { connectionId: connections[0] }),
    { method: 'ping', params: { n: 7 } },
    'framing: "ndjson" 必须真的传给传输层（而不是被静默当成 content-length）'
  )
}, 30_000)
