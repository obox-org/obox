/**
 * EH-B1 · IO 能力族单测（`fs.watch` / `fs.unwatch` / `net.fetch` / `env` / `clipboard`）。
 *
 * 覆盖判据（`docs/extension-host-migration.md` 的 EH-B1 行 + 任务卡要求）：
 * - `fs.watch`：真的能收到变更事件、路径白名单（绝对路径 / `..` 拒绝）、回调抛错不杀宿主、
 *   `dispose` 后不再回调且句柄已关、16 个上限与同 id 重置、后端报错自动关闭；
 * - `net.fetch`：成功 / 超时 / 超 8MB（声明与流式两种）/ 非 2xx / 重定向 / JSON 解析；
 * - 代理继承：`host.proxyConfig` → main 回的配置真的被用上（真本地代理服务器收绝对 URI）、
 *   读失败时降级环境变量（`HTTP_PROXY`）且只 warn 一次、`noProxy` 命中即直连、`ignoreSSL` 透传；
 * - `clipboard`：经注入的 `hostMain` 假件读写；未接线时抛 `EH_INTERNAL` + 「剪贴板需要主进程 IPC」
 *   （**不是**「阶段 B 尚未迁移」）；
 * - `env`：与 `src/api/types.ts` 的 5 个成员一致；
 * - 对照表：`fs.watch` 等 5 项从桩变实现，`已实现 + 桩 = 99` 仍成立（EH-B3b-1 之后是 89 + 10）。
 *
 * **不真连外网**：所有网络用例要么打本地 `http` server，要么注入 `transport` 假件；
 * `fs.watch` 的真事件用临时目录，行为类用例注入假后端（可编排 error / 计数 close）。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, test } from 'vitest'

import { EhProtocolError } from '../src/shared/extensionHostProtocol'
import { createExtensionApi, listApiImplementation } from '../src/extension-host/apiFactory'
import {
  CLIPBOARD_METHOD,
  DEFAULT_MAX_BODY_BYTES,
  MAX_WATCHERS_PER_EXT,
  PROXY_CONFIG_METHOD,
  createIoCapabilities,
  matchesNoProxy,
  pickProxy,
  proxySettingsFromEnv,
  resolveInsideDataDir,
  type HostMainBridge,
  type HttpTransport,
  type IoCapabilities,
  type IoCapabilitiesOptions,
  type TransportRequest,
  type TransportResponse,
  type WatchBackend,
  type WatchBackendOptions
} from '../src/extension-host/capabilities/io'
import type { HostLogger } from '../src/extension-host/log'
import { createRunExtensionSafely, type ExtensionRunPhase } from '../src/extension-host/safety'

/* -------------------------------------------------------------------------------------------- */
/* 临时目录 / 日志 / 隔离壳                                                                        */
/* -------------------------------------------------------------------------------------------- */

const tempDirs: string[] = []
const servers: http.Server[] = []
const createdIos: IoCapabilities[] = []
/** CONNECT 隧道里的裸 socket（不是 http server 的连接，必须自己销毁，否则 close 永远等不到回调） */
const tunnels: Duplex[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-eh-b1-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async (): Promise<void> => {
  for (const io of createdIos.splice(0)) io.dispose()
  for (const socket of tunnels.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve): void => {
      server.close((): void => resolve())
    })
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface CapturedLog {
  level: string
  message: string
}

interface IoHarness {
  io: IoCapabilities
  logs: CapturedLog[]
  reported: Array<{ extId: string; phase: ExtensionRunPhase }>
  /** 扩展 data 目录（fs 的根） */
  dir: string
}

/**
 * 造一份 IO 能力族。
 *
 * `processEnv` 默认给**空对象**：开发机上可能真的设了 `HTTP_PROXY`，不挡住会让用例
 * "时好时坏"（尤其代理相关的断言）。
 */
async function createIo(overrides: Partial<IoCapabilitiesOptions> = {}): Promise<IoHarness> {
  const root = await makeTempDir()
  const dir = overrides.extensionDataDir ?? path.join(root, 'io-ext')
  await mkdir(dir, { recursive: true })
  const logs: CapturedLog[] = []
  const logger: HostLogger = (level, message): void => {
    logs.push({ level, message })
  }
  const reported: Array<{ extId: string; phase: ExtensionRunPhase }> = []
  const runSafely = createRunExtensionSafely((extId, _error, phase): void => {
    reported.push({ extId, phase })
  })
  const io = createIoCapabilities({
    extId: 'io-ext',
    extensionDataDir: dir,
    appInfo: { name: 'obox', version: '9.9.9' },
    locale: 'zh',
    log: logger,
    runSafely,
    processEnv: {},
    ...overrides
  })
  createdIos.push(io)
  return { io, logs, reported, dir }
}

/** 轮询等待（不用固定 sleep 掩盖时序问题） */
async function waitFor(condition: () => boolean, timeoutMs = 3000, why = '条件'): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时：${why}`)
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 5)
    })
  }
}

/** 真 sleep（断言"之后不再回调"用） */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, ms)
  })
}

/* -------------------------------------------------------------------------------------------- */
/* 假后端 / 本地服务器                                                                            */
/* -------------------------------------------------------------------------------------------- */

interface FakeWatchBackend {
  backend: WatchBackend
  dirs: string[]
  handles: Array<{ options: WatchBackendOptions; closed: boolean }>
  closedCount(): number
  /** 让第 `index` 个句柄收到一次变更 */
  emit(index: number, relPath: string): void
  /** 让**最后一个**句柄收到一次变更 */
  emitLatest(relPath: string): void
  /** 让**最后一个**句柄报错 */
  failLatest(error: unknown): void
}

function createFakeWatchBackend(): FakeWatchBackend {
  const dirs: string[] = []
  const handles: Array<{ options: WatchBackendOptions; closed: boolean }> = []
  const fake: FakeWatchBackend = {
    dirs,
    handles,
    backend: {
      start(dir: string, options: WatchBackendOptions): { close(): void } {
        dirs.push(dir)
        const handle = { options, closed: false }
        handles.push(handle)
        return {
          close(): void {
            handle.closed = true
          }
        }
      }
    },
    closedCount(): number {
      return handles.filter((handle) => handle.closed).length
    },
    emit(index: number, relPath: string): void {
      handles[index]?.options.onChange(relPath)
    },
    emitLatest(relPath: string): void {
      handles[handles.length - 1]?.options.onChange(relPath)
    },
    failLatest(error: unknown): void {
      handles[handles.length - 1]?.options.onError(error)
    }
  }
  return fake
}

interface LocalServer {
  url: string
  port: number
  /** 收到的请求（按到达顺序） */
  requests: Array<{
    method?: string
    url?: string
    headers: http.IncomingHttpHeaders
    body: string
  }>
}

/** 起一个本地 http server（127.0.0.1 随机端口；afterEach 统一关，不连外网） */
async function startServer(handler: http.RequestListener): Promise<LocalServer> {
  const requests: LocalServer['requests'] = []
  const server = http.createServer((req, res): void => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer): void => {
      chunks.push(chunk)
    })
    req.on('end', (): void => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      })
      handler(req, res)
    })
  })
  server.on('clientError', (): void => {
    // 客户端主动断（超 8MB 用例会这样）：不是测试失败
  })
  servers.push(server)
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', (): void => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, port, requests }
}

/** 造一个只会回一条文本响应的 server */
async function startTextServer(text: string, status = 200): Promise<LocalServer> {
  return startServer((_req, res): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(text)
  })
}

/* -------------------------------------------------------------------------------------------- */
/* 1. fs.watch / fs.unwatch                                                                       */
/* -------------------------------------------------------------------------------------------- */

test('fs.watch：真 Node fs.watch 收到变更事件，relPath 相对被监听目录', async (): Promise<void> => {
  const { io, dir } = await createIo()
  const events: Array<{ relPath: string }> = []
  await io.fsWatch.watch('w1', '.', (event): void => {
    events.push(event)
  })
  assert.equal(io.fsWatch.count(), 1)

  await writeFile(path.join(dir, 'note.txt'), 'hello', 'utf8')
  await waitFor(() => events.length > 0, 5000, '收到 note.txt 的变更')
  assert.match(events[0]?.relPath ?? '', /note\.txt/, 'relPath 必须是相对监听目录的路径')

  // 子目录监听：事件是相对**被监听目录**的（不带 sub/ 前缀）
  const subEvents: string[] = []
  await mkdir(path.join(dir, 'sub'), { recursive: true })
  await io.fsWatch.watch('w2', 'sub', (event): void => {
    subEvents.push(event.relPath)
  })
  await writeFile(path.join(dir, 'sub', 'a.txt'), 'x', 'utf8')
  await waitFor(
    () => subEvents.some((relPath) => relPath.includes('a.txt')),
    5000,
    '收到 sub/a.txt'
  )
})

test('fs.watch：路径白名单与参数校验（绝对路径 / .. / 空 watchId / 非函数回调）', async (): Promise<void> => {
  const { io, dir } = await createIo()
  const outside = path.join(path.dirname(dir), 'abs')

  await assert.rejects(
    io.fsWatch.watch('w', '../escape', (): void => {}),
    /越出扩展 data 目录/
  )
  await assert.rejects(
    io.fsWatch.watch('w', outside, (): void => {}),
    /绝对路径/
  )
  await assert.rejects(
    io.fsWatch.watch('', '.', (): void => {}),
    /watchId 必须是非空字符串/
  )
  await assert.rejects(
    io.fsWatch.watch('w', '.', 'nope' as unknown as (event: { relPath: string }) => void),
    /callback 必须是函数/
  )
  assert.equal(io.fsWatch.count(), 0, '参数校验失败不得留下监听')
  // 导出的白名单与 fs 读写同一套语义（`..` 逃逸被拒；正常相对路径通过）
  assert.throws((): string => resolveInsideDataDir('/root/ext', '../b'), /越出扩展 data 目录/)
  assert.equal(resolveInsideDataDir('/root/ext', 'a/b.txt'), path.resolve('/root/ext', 'a/b.txt'))
})

test('fs.watch：扩展回调抛错经隔离壳上报（按扩展归属、phase=callback），不杀宿主', async (): Promise<void> => {
  const fake = createFakeWatchBackend()
  const { io, reported } = await createIo({ watchBackend: fake.backend })
  await io.fsWatch.watch('boom', '.', (): void => {
    throw new Error('回调爆炸')
  })

  fake.emitLatest('a.txt')
  await waitFor(() => reported.length === 1, 2000, '回调错误被上报')
  assert.deepEqual(reported[0], { extId: 'io-ext', phase: 'callback' })
  assert.equal(io.fsWatch.count(), 1, '回调抛错不得关掉监听')
})

test('fs.unwatch / dispose：句柄真的关掉，之后不再回调；两者都幂等', async (): Promise<void> => {
  const fake = createFakeWatchBackend()
  const { io } = await createIo({ watchBackend: fake.backend })
  const events: string[] = []
  const callback = (event: { relPath: string }): void => {
    events.push(event.relPath)
  }

  await io.fsWatch.watch('a', '.', callback)
  await io.fsWatch.watch('b', '.', callback)
  assert.equal(io.fsWatch.count(), 2)

  await io.fsWatch.unwatch('a')
  assert.equal(io.fsWatch.count(), 1)
  assert.equal(fake.closedCount(), 1, 'unwatch 必须 close 句柄')

  // 对称断言：'a' 已停 → 不再回调；'b' 仍在 → 照常回调
  fake.emit(0, 'after-unwatch.txt')
  fake.emit(1, 'still-watched.txt')
  await sleep(20)
  assert.deepEqual(events, ['still-watched.txt'], 'unwatch 之后该 id 不得再回调，其它监听不受影响')

  events.length = 0
  io.dispose()
  assert.equal(io.fsWatch.count(), 0, 'dispose 必须清空全部监听')
  assert.equal(fake.closedCount(), 2)
  fake.emit(1, 'after-dispose.txt')
  await sleep(20)
  assert.deepEqual(events, [], 'dispose 之后不得再回调')

  // 幂等：再 dispose 一次不会重复 close
  io.dispose()
  assert.equal(fake.closedCount(), 2)
  // 未注册的 watchId 静默忽略（老 api 语义）
  await io.fsWatch.unwatch('never-existed')
})

test('fs.watch：单扩展 16 个上限，同 id 重复 watch 是重置（不占新增额度）', async (): Promise<void> => {
  const fake = createFakeWatchBackend()
  const { io } = await createIo({ watchBackend: fake.backend })
  const callback = (): void => {}

  for (let index = 0; index < MAX_WATCHERS_PER_EXT; index += 1) {
    await io.fsWatch.watch(`w${index}`, '.', callback)
  }
  assert.equal(io.fsWatch.count(), MAX_WATCHERS_PER_EXT)
  await assert.rejects(
    io.fsWatch.watch('extra', '.', callback),
    new RegExp(`监听数量已达上限（${MAX_WATCHERS_PER_EXT}）`)
  )

  // 同 id 重置：先关旧句柄、不占新增额度，所以 17 个 id 也能成功
  await io.fsWatch.watch('w0', '.', callback)
  assert.equal(io.fsWatch.count(), MAX_WATCHERS_PER_EXT)
  assert.equal(fake.closedCount(), 1)
})

test('fs.watch：后端报错（目录被删/权限）自动关闭该监听并记 warn，不崩宿主', async (): Promise<void> => {
  const fake = createFakeWatchBackend()
  const { io, logs } = await createIo({ watchBackend: fake.backend })
  await io.fsWatch.watch('w1', '.', (): void => {})
  fake.failLatest(new Error('ENOENT: 目录被删除'))

  assert.equal(io.fsWatch.count(), 0, '出错后必须把监听从表里移除')
  assert.equal(fake.closedCount(), 1)
  assert.ok(
    logs.some((entry) => entry.message.includes('文件监听出错')),
    '必须留下一条 warn 日志'
  )
})

test('fs.watch：监听不存在的目录 → 抛「监听目录失败」（不崩宿主）', async (): Promise<void> => {
  const { io } = await createIo()
  await assert.rejects(
    io.fsWatch.watch('w1', 'missing-dir', (): void => {}),
    /监听目录失败/
  )
  assert.equal(io.fsWatch.count(), 0)
})

/* -------------------------------------------------------------------------------------------- */
/* 2. net.fetch                                                                                  */
/* -------------------------------------------------------------------------------------------- */

test('net.fetch：GET 成功，按 Content-Type 解析 JSON（本地 server）', async (): Promise<void> => {
  const server = await startServer((_req, res): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [1, 2] }))
  })
  const { io } = await createIo()

  const result = await io.net.fetch(`${server.url}/items?page=1`)
  assert.deepEqual(result, { ok: true, status: 200, statusText: 'OK', data: { items: [1, 2] } })
  assert.equal(server.requests[0]?.url, '/items?page=1')
})

test('net.fetch：对象 body 自动 JSON 序列化并补 Content-Type；text 响应按文本返回', async (): Promise<void> => {
  const server = await startServer((_req, res): void => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('done')
  })
  const { io } = await createIo()

  const result = await io.net.fetch(`${server.url}/post`, {
    method: 'POST',
    body: { page: 2 }
  })
  assert.equal(result.ok, true)
  assert.equal(result.data, 'done')
  assert.equal(server.requests[0]?.method, 'POST')
  assert.equal(server.requests[0]?.body, '{"page":2}')
  assert.match(String(server.requests[0]?.headers['content-type'] ?? ''), /application\/json/)
  assert.equal(server.requests[0]?.headers['content-length'], '10')
})

test('net.fetch：非 2xx 仍回 ok:true + status（与 src/main/net.ts 的既有语义一致）', async (): Promise<void> => {
  const server = await startTextServer('not found', 404)
  const { io } = await createIo()

  const result = await io.net.fetch(`${server.url}/missing`)
  assert.equal(result.ok, true, 'ok 表示"请求完成"，不是"2xx"')
  assert.equal(result.status, 404)
  assert.equal(result.data, 'not found')
})

test('net.fetch：超时回 {ok:false, error}（本地 server 一直不回）', async (): Promise<void> => {
  const server = await startServer((): void => {
    // 故意不响应
  })
  const { io } = await createIo({ netTimeoutMs: 60 })

  const result = await io.net.fetch(`${server.url}/slow`)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /请求超时/)
})

test('net.fetch：响应体超过 8MB（声明 Content-Length）被拒绝', async (): Promise<void> => {
  const payload = Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1, 0x61)
  const server = await startServer((_req, res): void => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-length': String(payload.byteLength)
    })
    res.end(payload)
  })
  const { io } = await createIo()

  const result = await io.net.fetch(`${server.url}/huge`)
  assert.equal(result.ok, false)
  assert.equal(result.status, 200)
  assert.match(result.error ?? '', /响应体过大/)
  assert.equal(DEFAULT_MAX_BODY_BYTES, 8 * 1024 * 1024, '上限必须与协议 FRAME_LIMIT_BYTES 一致')
})

test('net.fetch：流式响应（无 Content-Length）边读边数，超上限立刻拒绝', async (): Promise<void> => {
  const server = await startServer((_req, res): void => {
    res.writeHead(200, { 'content-type': 'text/plain' }) // chunked：没有 content-length
    res.write('a'.repeat(48))
    res.write('b'.repeat(48))
    res.end()
  })
  const { io } = await createIo({ maxBodyBytes: 64 })

  const result = await io.net.fetch(`${server.url}/chunked`)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /响应体过大（上限 64 字节）/)
})

test('net.fetch：跟随重定向（Location 相对路径解析），超过上限即失败', async (): Promise<void> => {
  const target = await startTextServer('arrived')
  const server = await startServer((req, res): void => {
    if (req.url === '/start') {
      res.writeHead(302, { location: `${target.url}/final` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('arrived')
  })
  const { io } = await createIo()

  const result = await io.net.fetch(`${server.url}/start`)
  assert.equal(result.ok, true)
  assert.equal(result.data, 'arrived')
  assert.equal(server.requests.length, 1)
  assert.equal(target.requests.length, 1, '第二跳必须打到 target')

  // 重定向到非 http(s) 协议：拒绝（不让 file:// 之类的地址混进来）
  const bad = await startServer((_req, res): void => {
    res.writeHead(301, { location: 'file:///etc/passwd' })
    res.end()
  })
  const rejected = await io.net.fetch(`${bad.url}/x`)
  assert.equal(rejected.ok, false)
  assert.match(rejected.error ?? '', /非 http\(s\) 协议/)
})

test('net.fetch：重定向死循环命中上限（5 次跟随）后报错，不无限跟', async (): Promise<void> => {
  const server = await startServer((_req, res): void => {
    res.writeHead(302, { location: '/loop' })
    res.end()
  })
  const { io } = await createIo()

  const result = await io.net.fetch(`${server.url}/loop`)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /重定向次数超过上限（5）/)
  assert.equal(server.requests.length, 6, '首跳 + 5 次跟随，第 6 次收到 3xx 就报错')
})

test('net.fetch：url 非法 / 不支持的代理协议 → {ok:false}（不抛）', async (): Promise<void> => {
  const { io } = await createIo()
  assert.deepEqual(await io.net.fetch('ftp://example.com/x'), {
    ok: false,
    error: 'url 必须是 http/https 地址'
  })

  const socks = await createIo({
    hostMain: {
      request: async (): Promise<unknown> => ({
        proxy: { enabled: true, url: 'socks5://127.0.0.1:1080', noProxy: [] },
        ignoreSSL: false
      })
    }
  })
  const result = await socks.io.net.fetch('http://example.invalid/x')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /不支持 socks\d* 代理/)
})

/* -------------------------------------------------------------------------------------------- */
/* 3. 代理继承（host.proxyConfig / env 降级 / noProxy / ignoreSSL）                                 */
/* -------------------------------------------------------------------------------------------- */

test('代理继承：main 回的配置被真正使用（本地代理 server 收到绝对 URI，Host 是目标）', async (): Promise<void> => {
  const proxy = await startTextServer('via-proxy')
  const seen: Array<{ method: string; params: unknown }> = []
  const hostMain: HostMainBridge = {
    request: async (method, params): Promise<unknown> => {
      seen.push({ method, params: params ?? null })
      return { proxy: { enabled: true, url: proxy.url, noProxy: [] }, ignoreSSL: false }
    }
  }
  const { io } = await createIo({ hostMain })

  const result = await io.net.fetch('http://example.invalid/hello')
  assert.equal(result.ok, true)
  assert.equal(result.data, 'via-proxy')
  assert.deepEqual(seen[0], { method: PROXY_CONFIG_METHOD, params: null })
  assert.equal(proxy.requests.length, 1, '请求必须打到代理')
  assert.equal(proxy.requests[0]?.url, 'http://example.invalid/hello', 'http 目标用绝对 URI')
  assert.equal(proxy.requests[0]?.headers.host, 'example.invalid', 'Host 是目标主机')
})

test('代理降级：读 main 失败 → 回落 HTTP_PROXY 环境变量，并只 warn 一次', async (): Promise<void> => {
  const proxy = await startTextServer('env-proxy')
  const hostMain: HostMainBridge = {
    request: async (): Promise<unknown> => {
      throw new Error('main 不可用')
    }
  }
  const { io, logs } = await createIo({
    hostMain,
    processEnv: { HTTP_PROXY: proxy.url }
  })

  const first = await io.net.fetch('http://fallback.invalid/a')
  const second = await io.net.fetch('http://fallback.invalid/b')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(proxy.requests.length, 2, '降级后仍然走 env 里的代理')
  assert.equal(
    logs.filter((entry) => entry.message.includes('回落环境变量')).length,
    1,
    '降级日志只打一次'
  )
})

test('代理降级：hostMain 未接线 → 环境变量代理照样生效（不残废）', async (): Promise<void> => {
  const proxy = await startTextServer('no-bridge-but-proxy')
  const { io, logs } = await createIo({ processEnv: { HTTPS_PROXY: proxy.url } })

  const result = await io.net.fetch('http://example.invalid/x')
  assert.equal(result.ok, true)
  assert.equal(result.data, 'no-bridge-but-proxy')
  assert.equal(proxy.requests.length, 1)
  assert.ok(logs.some((entry) => entry.message.includes('未接入 host→main 通道')))
})

test('代理：noProxy 命中目标主机 → 直连（代理不该收到请求）', async (): Promise<void> => {
  const target = await startTextServer('direct')
  const proxy = await startTextServer('proxied')
  const { io } = await createIo({
    hostMain: {
      request: async (): Promise<unknown> => ({
        proxy: { enabled: true, url: proxy.url, noProxy: ['127.0.0.1'] },
        ignoreSSL: false
      })
    }
  })

  const result = await io.net.fetch(target.url)
  assert.equal(result.ok, true)
  assert.equal(result.data, 'direct')
  assert.equal(proxy.requests.length, 0, 'noProxy 命中必须直连')
})

test('代理：ignoreSSL 与代理决策原样传给 transport（注入假件断言接线）', async (): Promise<void> => {
  const requests: TransportRequest[] = []
  const transport: HttpTransport = async (request): Promise<TransportResponse> => {
    requests.push(request)
    return {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('fake')
    }
  }
  const { io } = await createIo({
    transport,
    hostMain: {
      request: async (): Promise<unknown> => ({
        proxy: { enabled: true, url: 'http://127.0.0.1:9', noProxy: [] },
        ignoreSSL: true
      })
    }
  })

  const result = await io.net.fetch('https://secure.invalid/x')
  assert.equal(result.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(
    requests[0]?.ignoreSSL,
    true,
    'ignoreSSL 必须透传（https 下 rejectUnauthorized:false）'
  )
  assert.equal(requests[0]?.proxyUrl, 'http://127.0.0.1:9/', 'https 目标应走代理（CONNECT 隧道）')
  assert.equal(requests[0]?.method, 'GET')
})

/* -------------------------------------------------------------------------------------------- */
/* 3b. 代理：https 目标经 CONNECT 隧道（真 TLS，自签证书夹具）                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * 单测专用的**自签证书**（CN=localhost，SAN `localhost` + `127.0.0.1`，有效期到 2126 年）。
 *
 * 为什么内联在测试里：`net.fetch` 对 https 目标要建 CONNECT 隧道再在隧道里做 TLS，这条路径
 * 只有"真 TLS"能测出来（本卡实现时正是在这里踩到 `createConnection` 被 `agent:false` 吞掉、
 * 结果去连 `localhost:443` 的缺陷）。内联 PEM 就不依赖 openssl、也不连外网。
 * **这是公开的测试夹具私钥，不是任何真实凭证**，除了本文件的 HTTPS 夹具之外没有用处。
 */
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDuRnDcjRBIIrHz
OiotgxK9S8n0M6NbGOs9rtUcf+7k8X5lEj/QxtcJpALBnx5y1z1ldfDzpoSTygEQ
AXKRWCNNGcvO/8G4BNSIxNxJ7HDkUaFUazAeK7isuwibQyeiLZaKqjOoRNqzavUL
hjegnZpr+EQUyoNxxUwtTT6hti7o+FP3ZIjF+v8bX+O0tUD8VEL2EfVVZNT/AaFt
rUXQr7qdz/6RSWKD+d4mNgGxiMTp+4xgyO9z5tjKcE8ydJi0qwXPpP0wvLgix+Wh
Xo//V3oe72Yc3TWhZcO2ZJpGnN9IQNwidBNXWO0T8tR6TUgHq0VFxUCSyKD9gNQx
FRElcQHJAgMBAAECggEAAJwzEUmD5tY+eqA4HICCh8991l02xej7UYRL6p+Wh3vp
isSATYwrFpX7Uxxj4ORVkPMyVLllC01pKFtxKcUwZs9SEK30e4CLYOz+srOesNCy
1yst0B1k52t5DDRy/0ha0SeVx1m1gGALfaqZf6cdYPAv2U0RB1EEs3SRbr2Bp5pH
WlrVlPSH0AV0wckS2wBWdb7UyGBVRJM4kHnY5UC6hepNjyWXx4XFuyXr/NaJ6NG+
+MczgqhXQyvNR6b9RDW8NSY93Hy/9FR0Lc4chhjDoTmhLURzm1LHnJ2e1I7DSieP
JOqs0EkSB+gmtJU4w2eKtkNJNjqMywVWJmSupJcXoQKBgQD6CS3vmO3b8uuzGOlo
9J37iik8tYdXwm3KYtboBW+jf4xsLWVfCA9NQOL1h4/aKmuoOvsW1HLILK7Jv7GU
QVMtv1Nc5XPkq+MEtImt/Dim40gjfmp3TjjQRSjqrrEZJJZqtZqQ378N9VhsYzr7
4PNQYfifFarJy808a+xn4T1mmQKBgQDz9XIh3BYnYgKqYjJ8jae8zqwmvP+lXWQs
7cVmvUcUHs05/eQEZcXlTA7Llynz2FTFxAWFKFC4gRxOAN61QpTS2Knd8VUeTo4+
Elxqtgc3ffDZMciF5n+WK07x804EC5k1JyxnO6/VrLw7D0h3iuCHoRCbCaf3xh/b
FVYmpPrisQKBgQDd5xWoha3bvVynZx2Hc0leO0DbyzNhlIGB03RtGJ36mbFTNHq5
+1oxMrv6MiRd97Xx6N58ZXG068r37DO6orsiZ6GhWVYghNgGjf9+tNDGdAHK1l/A
oGBVnntwxDcSXGFONPwHRTu3NJ4UG4D2l675EOnorf8T9tafoByAGOs4SQKBgQCW
ZQ/xU87MhJ2EEHlzU5i+yuJSF126wjJJiGOTjMhO3RZD1ANHur4fN54/YHdaflj0
en20sz/gHqgmZl7le6Bnw24lBuwkfOUv2v3iQ0l7qkZaf1hRQ+IP368RdZ7423Wd
0QKMub0SiySXfDp+h70Xn/GuwmssUpW86BBuTnLkYQKBgH7hNU/R46mea2dFWVFA
wWupp+WUgQvEjBQzNeWZLjF4gUWbkUnF+w3OjktukZnijpYYFqy2FaLBD7KmeITt
xZESGdWM5Rys8kdO4y41L4nMXDVNPpYCZzjcpTNfMMpIMACNkkt+hfq0fVmwsyeS
qizh/sJQZvGmnrUYIppFiuAr
-----END PRIVATE KEY-----`

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUGMfwKwRtg1xu0kFkQPRyhtHPnlkwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyMDExMzg1OFoYDzIxMjYw
OTI2MTEzODU4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDuRnDcjRBIIrHzOiotgxK9S8n0M6NbGOs9rtUcf+7k
8X5lEj/QxtcJpALBnx5y1z1ldfDzpoSTygEQAXKRWCNNGcvO/8G4BNSIxNxJ7HDk
UaFUazAeK7isuwibQyeiLZaKqjOoRNqzavULhjegnZpr+EQUyoNxxUwtTT6hti7o
+FP3ZIjF+v8bX+O0tUD8VEL2EfVVZNT/AaFtrUXQr7qdz/6RSWKD+d4mNgGxiMTp
+4xgyO9z5tjKcE8ydJi0qwXPpP0wvLgix+WhXo//V3oe72Yc3TWhZcO2ZJpGnN9I
QNwidBNXWO0T8tR6TUgHq0VFxUCSyKD9gNQxFRElcQHJAgMBAAGjbzBtMB0GA1Ud
DgQWBBRDb7kGEmwjHQKG8xRZRHpqC9HwYTAfBgNVHSMEGDAWgBRDb7kGEmwjHQKG
8xRZRHpqC9HwYTAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAjKqxu0MxEyW91lVw92oawzKwA0Od
hECXQ9+MdqdSwcmEwj1abZ2z7yFX2PGlQpT6D/wQihgp3bQWlbUQCnWVW42EBjGI
15jUIvHH6PVhCY+G/a8I0cU1Y+zptdMI/pB8/scRA1lqESZFv1UwbLg8Ib1o322X
U877HnXVMyy/URDOhJRfPF6jSFlQlvIZkMlJhkbvSu1NSG4aJrWhJ8UUodIF3Qdz
CNmfeIZXpBLzWvrCtzvuxm08aeqZ6ffUWuyULs2reKac8sN6+Y+FbY8MXg24frLJ
WLT/8aia29fHlaSZHmX8UrhK5cPSWqyj55Ep/7GcOMHRMclM0LDDuM8M6g==
-----END CERTIFICATE-----`

/** 起一个 CONNECT 代理（真隧道，不是假响应），返回代理 URL 与 CONNECT 次数读取器 */
async function startConnectProxy(): Promise<{ url: string; connects(): number }> {
  const proxy = http.createServer((_req, res): void => {
    res.writeHead(405)
    res.end()
  })
  let connects = 0
  proxy.on('connect', (request, clientSocket: Duplex, head: Buffer) => {
    connects += 1
    tunnels.push(clientSocket)
    const [hostname, port] = String(request.url ?? '').split(':')
    const upstream = net.connect(Number(port), hostname, (): void => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    tunnels.push(upstream)
    upstream.on('error', (): void => clientSocket.destroy())
    clientSocket.on('error', (): void => upstream.destroy())
  })
  servers.push(proxy)
  await new Promise<void>((resolve): void => {
    proxy.listen(0, '127.0.0.1', (): void => resolve())
  })
  const port = (proxy.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    connects: (): number => connects
  }
}

test('代理：https 目标经 CONNECT 隧道（真 TLS）——ignoreSSL 开则通，关则拒自签证书', async (): Promise<void> => {
  const secure = https.createServer(
    { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
    (_req, res): void => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('secure-ok')
    }
  )
  servers.push(secure)
  await new Promise<void>((resolve): void => {
    secure.listen(0, '127.0.0.1', (): void => resolve())
  })
  const securePort = (secure.address() as AddressInfo).port
  const target = `https://localhost:${securePort}/x`

  const proxy = await startConnectProxy()
  const proxyConfig = { proxy: { enabled: true, url: proxy.url, noProxy: [] } }

  const ignoring = await createIo({
    hostMain: {
      request: async (): Promise<unknown> => ({ ...proxyConfig, ignoreSSL: true })
    }
  })
  const ok = await ignoring.io.net.fetch(target)
  assert.equal(ok.ok, true, 'CONNECT 隧道 + 忽略 SSL 必须真的拿到响应')
  assert.equal(ok.data, 'secure-ok')
  assert.equal(proxy.connects(), 1, 'https 目标必须走 CONNECT 隧道（不是绝对 URI）')

  const strict = await createIo({
    hostMain: {
      request: async (): Promise<unknown> => ({ ...proxyConfig, ignoreSSL: false })
    }
  })
  const rejected = await strict.io.net.fetch(target)
  assert.equal(rejected.ok, false, '不忽略 SSL 时自签证书必须被拒')
  assert.match(rejected.error ?? '', /self.signed|certificate/i)
})

test('代理配置工具：env 推导 / noProxy 匹配 / 非法 URL 与 socks 拒绝', (): void => {
  assert.deepEqual(proxySettingsFromEnv({}), { ignoreSSL: false })
  const fromEnv = proxySettingsFromEnv({
    HTTPS_PROXY: 'http://user:pass@127.0.0.1:7890',
    NO_PROXY: 'localhost, .internal.example',
    NODE_TLS_REJECT_UNAUTHORIZED: '0'
  })
  assert.equal(fromEnv.proxy?.enabled, true)
  assert.equal(fromEnv.proxy?.url, 'http://user:pass@127.0.0.1:7890')
  assert.deepEqual(fromEnv.proxy?.noProxy, ['localhost', '.internal.example'])
  assert.equal(fromEnv.ignoreSSL, true, 'NODE_TLS_REJECT_UNAUTHORIZED=0 等于忽略 SSL')

  assert.equal(matchesNoProxy('api.example.com', undefined, ['example.com']), false)
  assert.equal(matchesNoProxy('api.example.com', undefined, ['*.example.com']), true)
  assert.equal(matchesNoProxy('example.com', undefined, ['.example.com']), true)
  assert.equal(matchesNoProxy('127.0.0.1', '8080', ['127.0.0.1:8080']), true)
  assert.equal(matchesNoProxy('127.0.0.1', '8081', ['127.0.0.1:8080']), false)
  assert.equal(matchesNoProxy('anything', undefined, ['*']), true)

  const target = new URL('https://example.com/x')
  assert.deepEqual(pickProxy(undefined, target), {})
  assert.deepEqual(pickProxy({ enabled: false, url: 'http://p:1' }, target), {})
  const proxyDecision = pickProxy({ enabled: true, url: 'http://p:1', noProxy: [] }, target)
  assert.equal(proxyDecision.proxyUrl, 'http://p:1/')
  assert.match(
    pickProxy({ enabled: true, url: 'socks4://p:1', noProxy: [] }, target).error ?? '',
    /不支持 socks4 代理/
  )
  assert.match(
    pickProxy({ enabled: true, url: '::不是URL::', noProxy: [] }, target).error ?? '',
    /代理地址非法/
  )
})

/* -------------------------------------------------------------------------------------------- */
/* 4. clipboard（经 hostMain 假件；未接线时明确报错）                                                */
/* -------------------------------------------------------------------------------------------- */

test('clipboard：读写经 host.clipboard 转给 main（参数形状固定）', async (): Promise<void> => {
  const calls: Array<{ method: string; params: unknown }> = []
  const hostMain: HostMainBridge = {
    request: async (method, params): Promise<unknown> => {
      calls.push({ method, params })
      if ((params as { action?: string }).action === 'read') return { ok: true, text: '来自 main' }
      return { ok: true }
    }
  }
  const { io } = await createIo({ hostMain })

  assert.equal(await io.clipboard.readText(), '来自 main')
  await io.clipboard.writeText('hello')
  assert.deepEqual(calls, [
    { method: CLIPBOARD_METHOD, params: { action: 'read' } },
    { method: CLIPBOARD_METHOD, params: { action: 'write', text: 'hello' } }
  ])
})

test('clipboard：hostMain 未接线 → EH_INTERNAL +「剪贴板需要主进程 IPC」（不是「尚未迁移」）', async (): Promise<void> => {
  const { io } = await createIo()

  await assert.rejects(io.clipboard.readText(), (error: unknown): boolean => {
    assert.ok(error instanceof EhProtocolError, '应抛 EhProtocolError（带错误码）')
    assert.equal(error.code, 'EH_INTERNAL')
    assert.match(error.message, /剪贴板需要主进程 IPC/)
    assert.doesNotMatch(error.message, /尚未迁移/, '缺桥不是"未迁移"，文案不能混用')
    return true
  })
  await assert.rejects(io.clipboard.writeText('x'), /剪贴板需要主进程 IPC/)
})

test('clipboard：main 回 {ok:false} / 桥抛错 / 非字符串入参 → 抛可读错误', async (): Promise<void> => {
  const failing: HostMainBridge = {
    request: async (): Promise<unknown> => ({ ok: false, error: '剪贴板被占用' })
  }
  const { io } = await createIo({ hostMain: failing })
  await assert.rejects(io.clipboard.readText(), /剪贴板被占用/)

  const throwing: HostMainBridge = {
    request: async (): Promise<unknown> => {
      throw new Error('RPC 超时')
    }
  }
  const second = await createIo({ hostMain: throwing })
  await assert.rejects(second.io.clipboard.writeText('x'), /剪贴板操作失败：RPC 超时/)

  const third = await createIo({
    hostMain: { request: async (): Promise<unknown> => ({ ok: true }) }
  })
  await assert.rejects(third.io.clipboard.writeText(42 as unknown as string), /text 必须是字符串/)
})

/* -------------------------------------------------------------------------------------------- */
/* 5. env 全量                                                                                    */
/* -------------------------------------------------------------------------------------------- */

test('env：5 个成员与 src/api/types.ts 的声明一一对应（语言来自注入、版本来自 appInfo）', async (): Promise<void> => {
  const { io } = await createIo({ locale: 'en' })
  assert.deepEqual(Object.keys(io.env).sort(), [
    'arch',
    'getOboxVersion',
    'language',
    'nodeVersion',
    'platform'
  ])
  assert.equal(io.env.platform, process.platform)
  assert.equal(io.env.arch, process.arch)
  assert.equal(io.env.nodeVersion, process.versions.node)
  assert.equal(io.env.language, 'en')
  assert.equal(await io.env.getOboxVersion(), '9.9.9')
})

/* -------------------------------------------------------------------------------------------- */
/* 6. apiFactory 装配与「已实现 / 桩」对照表                                                        */
/* -------------------------------------------------------------------------------------------- */

test('对照表：EH-B3b-1 之后 89 已实现 + 10 桩 = 99（B1/B2/B3a/B3b-1 带走的能力都不再是桩）', async (): Promise<void> => {
  const root = await makeTempDir()
  const built = createExtensionApi({
    ext: {
      id: 'table-ext',
      version: '1.0.0',
      path: path.join(root, 'table-ext'),
      activationEvents: [],
      apiVersion: 3
    },
    extensionDataDir: path.join(root, 'table-ext'),
    appInfo: { name: 'obox', version: '9.9.9' },
    locale: 'zh',
    log: (): void => {},
    runSafely: createRunExtensionSafely((): void => {})
  })

  const rows = listApiImplementation(built.api)
  const implemented = rows
    .filter((row) => row.status === 'implemented')
    .map((row) => row.capability)
    .sort()
  const stubs = rows.filter((row) => row.status === 'stub')

  assert.deepEqual(implemented, [
    // EH-B3b-1：注册面数据面（28 项——app / i18n / navbar / on·emit / settings / statusBar /
    // theme / views / workspaceState / globalState / registerCommand / executeCommand）
    'app.onMessage',
    'app.register',
    'appInfo.get',
    'clipboard.readText',
    'clipboard.writeText',
    // EH-B3a：主进程类能力（dialog 3 / notification 1 / overlay 4 / proxy.get /
    // secrets 3 / shell 2 / update 2 / window 7）
    'dialog.showMessageBox',
    'dialog.showOpenDialog',
    'dialog.showSaveDialog',
    'emit',
    'env.arch',
    'env.getOboxVersion',
    'env.language',
    'env.nodeVersion',
    'env.platform',
    'executeCommand',
    'fs.exists',
    'fs.readDir',
    'fs.readFile',
    'fs.remove',
    'fs.unwatch',
    'fs.watch',
    'fs.writeFile',
    'globalState.get',
    'globalState.keys',
    'globalState.update',
    'i18n.locale',
    'i18n.onLocaleChanged',
    'i18n.registerMessages',
    'i18n.t',
    // EH-B2：ipc 14 项 + python.run + sqlite.open
    'ipc.broadcast',
    'ipc.channels',
    'ipc.close',
    'ipc.connect',
    'ipc.listen',
    'ipc.notify',
    'ipc.onClose',
    'ipc.onConnection',
    'ipc.onDisconnect',
    'ipc.onNotification',
    'ipc.onReconnect',
    'ipc.onRequest',
    'ipc.onStderr',
    'ipc.request',
    'log',
    'navbar.setBadge',
    'net.fetch',
    'notification.show',
    'on',
    'overlay.create',
    'overlay.destroy',
    'overlay.setMouseThrough',
    'overlay.setPosition',
    'proxy.get',
    'python.run',
    'registerCommand',
    'secrets.delete',
    'secrets.get',
    'secrets.set',
    'settings.get',
    'settings.onChanged',
    'settings.register',
    'settings.set',
    'shell.openExternal',
    'shell.openPath',
    'sqlite.open',
    'statusBar.createItem',
    'statusBar.hide',
    'statusBar.setText',
    'statusBar.setTooltip',
    'statusBar.show',
    'theme.getCurrent',
    'theme.onChanged',
    'timer.clearInterval',
    'timer.clearTimeout',
    'timer.setInterval',
    'timer.setTimeout',
    'update.getVersion',
    'update.onEvent',
    'views.registerTreeProvider',
    'window.close',
    'window.isFocused',
    'window.isMaximized',
    'window.minimize',
    'window.onFocusChanged',
    'window.setProgressBar',
    'window.toggleMaximize',
    'workspaceState.get',
    'workspaceState.keys',
    'workspaceState.update'
  ])
  assert.equal(rows.length, 99, '对照表共 99 项')
  assert.equal(
    implemented.length,
    89,
    '已实现 89 项（EH-A3 的 17 + EH-B1 的 5 + EH-B2 的 16 + EH-B3a 的 23 + EH-B3b-1 的 28）'
  )
  assert.equal(
    stubs.length,
    10,
    '桩 10 项（ui 5 + output.createChannel 1 + update 的 4 条门控，全部归 EH-B3b-2）'
  )
  assert.equal(rows.length, implemented.length + stubs.length, '不得出现第三类')

  // 5 项新实现不能再抛「阶段 B」：调用它们应当是形状/网络错误，而不是迁移提示
  await assert.rejects(
    built.api.fs.watch('w', '../x', (): void => {}),
    (error: unknown): boolean => {
      assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
      return true
    }
  )
  const netResult = await built.api.net.fetch('not-a-url')
  assert.equal(netResult.ok, false)
  assert.doesNotMatch(netResult.error ?? '', /尚未迁移/)

  // B2 的 16 项同样不能再抛迁移提示（这里挑三项形状错误，全部止步于参数/桥校验）
  await assert.rejects(built.api.ipc.request('nope', 'ping'), (error: unknown): boolean => {
    assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
    return true
  })
  await assert.rejects(built.api.python.run(''), (error: unknown): boolean => {
    assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
    return true
  })
  await assert.rejects(built.api.sqlite.open('../escape.db'), (error: unknown): boolean => {
    assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
    return true
  })

  // B3a 的 23 项也不能再抛迁移提示（挑三条：形状/参数错误 + 缺桥）
  await assert.rejects(built.api.secrets.get('k'), (error: unknown): boolean => {
    // 缺桥（本用例没注入 hostMain）⇒ EH_INTERNAL +「需要主进程 IPC」，不是「尚未迁移」
    assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
    return true
  })
  await assert.rejects(built.api.window.setProgressBar(Number.NaN), (error: unknown): boolean => {
    assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
    return true
  })
  await assert.rejects(built.api.shell.openExternal(''), (error: unknown): boolean => {
    assert.doesNotMatch(String((error as Error).message), /尚未迁移/)
    return true
  })

  // 剩余桩仍然当场抛「尚未迁移」（ui / output / update 的 4 条门控方法归 B3b-2）
  // EH-B3b-1 之后 `statusBar.setText` 不再是桩：本用例没有注入 `rendererPort`，所以它抛的是
  // 「host-renderer 端口未到」——响亮失败，而不是静默成功（更不是"尚未迁移"）。
  assert.throws((): void => built.api.statusBar.setText('a', 'b'), /host-renderer 端口未到/)
  assert.throws((): void => built.api.output.createChannel('x'), /尚未迁移/)
  await assert.rejects(async (): Promise<unknown> => built.api.update.check('feed'), /尚未迁移/)
  built.dispose()
})

test('apiFactory：dispose 会关掉该扩展的全部文件监听（句柄不泄漏）', async (): Promise<void> => {
  const root = await makeTempDir()
  const dir = path.join(root, 'dispose-ext')
  await mkdir(dir, { recursive: true })
  const events: string[] = []
  const built = createExtensionApi({
    ext: {
      id: 'dispose-ext',
      version: '1.0.0',
      path: dir,
      activationEvents: [],
      apiVersion: 3
    },
    extensionDataDir: dir,
    appInfo: { name: 'obox', version: '9.9.9' },
    locale: 'zh',
    log: (): void => {},
    runSafely: createRunExtensionSafely((): void => {})
  })

  await built.api.fs.watch('w1', '.', (event): void => {
    events.push(event.relPath)
  })
  built.dispose()

  await writeFile(path.join(dir, 'after-dispose.txt'), 'x', 'utf8')
  await sleep(80)
  assert.deepEqual(events, [], 'dispose 之后不得再回调')
})
