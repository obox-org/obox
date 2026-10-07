/**
 * IPC 传输层集成测试：**真实子进程**（stdio）与**真实命名管道 / Unix 域套接字**（pipe）。
 *
 * 全程不使用 TCP 端口：POSIX 用临时目录下的 .sock，Windows 用 `\\.\pipe\…`。
 * 对端由测试自己扮演（"第三方程序"）：一小段 Node 脚本 / 一个 net 服务器。
 * 先例：test/oix-install.test.ts（真实资源 + 临时目录）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import net from 'node:net'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IpcCoreError, type JsonRpcResponseMessage } from '../src/main/ipcCore'
import {
  openPipeClientTransport,
  openStdioTransport,
  resolveProgramInExtension
} from '../src/main/ipcTransport'

let workDir = ''
const cleanups: Array<() => void> = []

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'obox-ipc-'))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  // 子进程被杀后 Windows 可能短暂仍占用其 cwd（EBUSY）→ 等一下并带重试
  await new Promise((r) => setTimeout(r, 100))
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 })
})

/** 对端脚本：content-length 分帧的 JSON-RPC；支持 sum / 不回包的 slow；启动后主动发通知与请求 */
const ECHO_CHILD = `
let buf = Buffer.alloc(0)
function send(msg) {
  const p = Buffer.from(JSON.stringify(msg))
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + p.length + '\\r\\n\\r\\n'), p]))
}
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c])
  for (;;) {
    const i = buf.indexOf('\\r\\n\\r\\n')
    if (i < 0) return
    const m = /content-length:\\s*(\\d+)/i.exec(buf.subarray(0, i).toString())
    const len = Number(m[1])
    if (buf.length < i + 4 + len) return
    const payload = buf.subarray(i + 4, i + 4 + len)
    buf = buf.subarray(i + 4 + len)
    const msg = JSON.parse(payload.toString('utf8'))
    if (msg.method === 'sum') send({ jsonrpc: '2.0', id: msg.id, result: (msg.params.a || 0) + (msg.params.b || 0) })
    else if (msg.method === 'slow') { /* 故意不回，用于超时测试 */ }
    else if (msg.id !== undefined && msg.method === undefined) {
      // 收到宿主对 child-1 的回包 → 用通知告诉测试端（证明双向往返成功）
      send({ jsonrpc: '2.0', method: 'gotReply', params: { result: msg.result } })
    } else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no method' } })
  }
})
process.stderr.write('child-started\\n')
send({ jsonrpc: '2.0', method: 'ready', params: { pid: process.pid } })
send({ jsonrpc: '2.0', id: 'child-1', method: 'hostPing' })
`

async function writeChild(script: string): Promise<string> {
  const file = join(workDir, 'peer.cjs')
  await fs.writeFile(file, script, 'utf8')
  return file
}

/** content-length 分帧的极简服务端（测试扮演"已在运行的第三方程序"） */
function createServer(
  onMessage: (send: (msg: unknown) => void, msg: Record<string, unknown>) => void
): net.Server {
  const buffers = new Map<net.Socket, Buffer>()
  const server = net.createServer((socket) => {
    buffers.set(socket, Buffer.alloc(0))
    const send = (msg: unknown): void => {
      const payload = Buffer.from(JSON.stringify(msg), 'utf8')
      socket.write(
        Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload])
      )
    }
    socket.on('data', (chunk: Buffer) => {
      let buf = Buffer.concat([buffers.get(socket) ?? Buffer.alloc(0), chunk])
      for (;;) {
        const i = buf.indexOf('\r\n\r\n')
        if (i < 0) break
        const len = Number(
          /content-length:\s*(\d+)/i.exec(buf.subarray(0, i).toString())?.[1] ?? '0'
        )
        if (buf.length < i + 4 + len) break
        const payload = buf.subarray(i + 4, i + 4 + len)
        buf = buf.subarray(i + 4 + len)
        onMessage(send, JSON.parse(payload.toString('utf8')) as Record<string, unknown>)
      }
      buffers.set(socket, buf)
    })
    socket.on('close', () => buffers.delete(socket))
  })
  return server
}

function endpointFor(name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\obox-${name}`
    : join(workDir, `obox-${name}.sock`)
}

function listen(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(endpoint, () => resolvePromise())
  })
}

describe('stdio 传输（宿主拉起子进程）', () => {
  it('请求往返 + 对端主动通知 + 对端发来的请求（双向）', async () => {
    const script = await writeChild(ECHO_CHILD)
    const transport = openStdioTransport({
      program: process.execPath,
      args: [script],
      cwd: workDir
    })
    cleanups.push(() => transport.dispose())
    await transport.ready

    const notifications: Array<[string, unknown]> = []
    transport.channel.onNotification((method, params) => notifications.push([method, params]))
    // 宿主处理对端请求：证明"对端 → 宿主"方向
    transport.channel.handle('hostPing', () => 'pong')

    await expect(transport.channel.request('sum', { a: 2, b: 3 })).resolves.toBe(5)

    // 对端收到宿主回包后会回一条 gotReply 通知（端到端双向证据）
    await new Promise((r) => setTimeout(r, 100))
    expect(notifications.map(([m]) => m)).toContain('ready')
    const gotReply = notifications.find(([m]) => m === 'gotReply')
    expect(gotReply?.[1]).toEqual({ result: 'pong' })
  })

  it('对端 stderr 被捕获为日志文本', async () => {
    const script = await writeChild(ECHO_CHILD)
    const transport = openStdioTransport({
      program: process.execPath,
      args: [script],
      cwd: workDir
    })
    cleanups.push(() => transport.dispose())
    await transport.ready
    const logs: string[] = []
    transport.onStderr((text) => logs.push(text))
    await new Promise((r) => setTimeout(r, 120))
    expect(logs.join('')).toContain('child-started')
  })

  it('超时：对端不回包 → timeout', async () => {
    const script = await writeChild(ECHO_CHILD)
    const transport = openStdioTransport({
      program: process.execPath,
      args: [script],
      cwd: workDir,
      defaultTimeoutMs: 80
    })
    cleanups.push(() => transport.dispose())
    await transport.ready
    await expect(transport.channel.request('slow')).rejects.toMatchObject({ code: 'timeout' })
  })

  it('对端进程退出 → 通道以 peer-crashed 关闭', async () => {
    const script = await writeChild('process.exit(0)')
    const transport = openStdioTransport({
      program: process.execPath,
      args: [script],
      cwd: workDir
    })
    cleanups.push(() => transport.dispose())
    await transport.ready
    const reason = await new Promise<IpcCoreError | null>((resolve) => {
      transport.channel.onClose((err) => resolve(err))
    })
    expect(reason?.code).toBe('peer-crashed')
  })

  it('程序不存在 → ready 以 connect-failed 拒绝', async () => {
    const transport = openStdioTransport({ program: join(workDir, 'nope.exe'), cwd: workDir })
    cleanups.push(() => transport.dispose())
    await expect(transport.ready).rejects.toMatchObject({ code: 'connect-failed' })
  })

  it('program 越出扩展目录 → invalid-declaration', () => {
    expect(() => resolveProgramInExtension(workDir, '../outside.exe')).toThrowError(IpcCoreError)
    expect(resolveProgramInExtension(workDir, 'bin/peer.exe')).toBe(
      join(workDir, 'bin', 'peer.exe')
    )
  })
})

describe('pipe 传输（连接已在运行的进程；无 TCP 端口）', () => {
  it('连接真实命名管道/UDS：请求往返', async () => {
    const endpoint = endpointFor('pipe-test')
    const server = createServer((send, msg) => {
      if (msg.method === 'ping') send({ jsonrpc: '2.0', id: msg.id, result: 'pong' })
      if (msg.method === 'sum') {
        const p = (msg.params ?? {}) as { a?: number; b?: number }
        send({ jsonrpc: '2.0', id: msg.id, result: (p.a ?? 0) + (p.b ?? 0) })
      }
    })
    await listen(server, endpoint)
    cleanups.push(() => server.close())
    if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600)

    const transport = openPipeClientTransport({ endpoint })
    cleanups.push(() => transport.dispose())
    await transport.ready

    await expect(transport.channel.request('ping')).resolves.toBe('pong')
    await expect(transport.channel.request('sum', { a: 4, b: 6 })).resolves.toBe(10)
  })

  it('端点不存在 → ready 以 connect-failed 拒绝', async () => {
    const transport = openPipeClientTransport({ endpoint: endpointFor('missing-endpoint') })
    cleanups.push(() => transport.dispose())
    await expect(transport.ready).rejects.toMatchObject({ code: 'connect-failed' })
  })

  it('端点不是 TCP 端口（不含 host:port 形式）', () => {
    const endpoint = endpointFor('shape-check')
    expect(endpoint).not.toMatch(/:\d{2,5}$/)
    expect(endpoint.startsWith('\\\\') || endpoint.endsWith('.sock')).toBe(true)
  })
})

/** 用一条真实连接验证"服务器主动向客户端发请求"（双向） */
describe('pipe 传输 · 对端主动请求宿主', () => {
  it('服务器发请求 → 客户端 handler 应答 → 服务器收到结果', async () => {
    const endpoint = endpointFor('server-asks')
    let received: JsonRpcResponseMessage | null = null
    let serverSocket: net.Socket | null = null
    const server = createServer((send, msg) => {
      if (msg.method === 'ping') send({ jsonrpc: '2.0', id: msg.id, result: 'pong' })
      if (msg.id !== undefined && msg.method === undefined) received = msg as JsonRpcResponseMessage
    })
    server.on('connection', (socket) => {
      serverSocket = socket
    })
    await listen(server, endpoint)
    cleanups.push(() => server.close())

    const transport = openPipeClientTransport({ endpoint })
    cleanups.push(() => transport.dispose())
    await transport.ready
    transport.channel.handle('askHost', (params) => ({ echoed: params }))

    await expect(transport.channel.request('ping')).resolves.toBe('pong')

    // 服务器（对端）主动向客户端发请求
    const payload = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'askHost', params: { q: 1 } })
    )
    serverSocket?.write(
      Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload])
    )
    await new Promise((r) => setTimeout(r, 80))
    expect(received).toEqual({ jsonrpc: '2.0', id: 42, result: { echoed: { q: 1 } } })
  })
})
