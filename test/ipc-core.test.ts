/**
 * 端口无关 IPC 核心单测（ipcCore）。
 *
 * 只断言对外行为：分帧结果、请求往返、错误码、事件顺序、关闭语义。
 * 先例：test/sqlite-core.test.ts / test/oix-install.test.ts（electron-free 核心 + 真实资源）、
 * test/ext-guard.test.ts（纯函数拒绝矩阵）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ContentLengthParser,
  IpcCoreError,
  JsonRpcChannel,
  NdjsonParser,
  createFrameParser,
  ipcEndpoint,
  isIpcCoreError,
  isWindowsNamedPipe,
  sanitizeIpcName,
  validateIpcDeclaration
} from '../src/main/ipcCore'

interface ChannelOptionsForTest {
  framing?: 'content-length' | 'ndjson'
  maxMessageBytes?: number
  defaultTimeoutMs?: number
  maxPendingRequests?: number
}

/** 造一个把发出的字节收集起来的通道，便于断言"宿主发出去什么" */
function makeChannel(opts: ChannelOptionsForTest = {}): {
  channel: JsonRpcChannel
  written: Buffer[]
} {
  return createChannel(opts)
}

function createChannel(opts: ChannelOptionsForTest): {
  channel: JsonRpcChannel
  written: Buffer[]
} {
  const written: Buffer[] = []
  const channel = new JsonRpcChannel({
    sendFrame: (frame) => written.push(frame),
    ...opts
  })
  return { channel, written }
}

/** 从"宿主写出的字节"里解析出 JSON 消息（默认 content-length 分帧） */
function parseWritten(written: Buffer[], parser = new ContentLengthParser()): unknown[] {
  const out: unknown[] = []
  for (const chunk of written) {
    const { messages } = parser.push(chunk)
    for (const m of messages) out.push(JSON.parse(m.toString('utf8')))
  }
  return out
}

/** 把一条 JSON-RPC 消息编码成对端发来的字节（content-length） */
function frame(message: unknown, parser = new ContentLengthParser()): Buffer {
  return parser.encode(Buffer.from(JSON.stringify(message), 'utf8'))
}

describe('分帧 · Content-Length（LSP 同款）', () => {
  it('往返：编码后可被解析回原载荷', () => {
    const p = new ContentLengthParser()
    const payload = Buffer.from('{"jsonrpc":"2.0","method":"ping"}', 'utf8')
    const { messages } = p.push(p.encode(payload))
    expect(messages).toHaveLength(1)
    expect(messages[0].toString('utf8')).toBe(payload.toString('utf8'))
  })

  it('半包：帧头与载荷分多次到达，未完整时不出消息', () => {
    const p = new ContentLengthParser()
    const payload = Buffer.from('{"a":1}', 'utf8')
    const full = p.encode(payload)
    expect(p.push(full.subarray(0, 5)).messages).toHaveLength(0)
    expect(p.push(full.subarray(5, 12)).messages).toHaveLength(0)
    const last = p.push(full.subarray(12))
    expect(last.messages).toHaveLength(1)
    expect(last.messages[0].toString('utf8')).toBe('{"a":1}')
  })

  it('粘包：一次到达含多条消息，全部按序解析', () => {
    const p = new ContentLengthParser()
    const chunk = Buffer.concat([
      p.encode(Buffer.from('{"n":1}', 'utf8')),
      p.encode(Buffer.from('{"n":2}', 'utf8')),
      p.encode(Buffer.from('{"n":3}', 'utf8'))
    ])
    const { messages } = p.push(chunk)
    expect(messages.map((m) => m.toString('utf8'))).toEqual(['{"n":1}', '{"n":2}', '{"n":3}'])
  })

  it('头部大小写不敏感且允许额外头部行', () => {
    const p = new ContentLengthParser()
    const body = '{"n":1}'
    const frameBytes = Buffer.from(
      `content-TYPE: application/json\r\nCONTENT-length: ${body.length}\r\n\r\n${body}`,
      'ascii'
    )
    const { messages, error } = p.push(frameBytes)
    expect(error).toBeUndefined()
    expect(messages[0].toString('utf8')).toBe(body)
  })

  it('帧头非法（缺 Content-Length）→ protocol-error', () => {
    const p = new ContentLengthParser()
    const { error } = p.push(Buffer.from('X-Other: 1\r\n\r\n{}', 'ascii'))
    expect(isIpcCoreError(error)).toBe(true)
    expect(error?.code).toBe('protocol-error')
  })

  it('声明的长度超过上限 → message-too-large（不分配巨缓冲）', () => {
    const p = new ContentLengthParser(1024)
    const { error } = p.push(Buffer.from('Content-Length: 999999999\r\n\r\n', 'ascii'))
    expect(error?.code).toBe('message-too-large')
  })

  it('帧头无限增长 → protocol-error（防"只发头部不发长度"）', () => {
    const p = new ContentLengthParser()
    const { error } = p.push(Buffer.alloc(9 * 1024, 0x41))
    expect(error?.code).toBe('protocol-error')
  })
})

describe('分帧 · NDJSON', () => {
  it('按行解析，容忍 CRLF 与空行', () => {
    const p = new NdjsonParser()
    const { messages } = p.push(Buffer.from('{"n":1}\r\n\r\n{"n":2}\n', 'utf8'))
    expect(messages.map((m) => m.toString('utf8'))).toEqual(['{"n":1}', '{"n":2}'])
  })

  it('半行暂存，补齐后才输出', () => {
    const p = new NdjsonParser()
    expect(p.push(Buffer.from('{"n":', 'utf8')).messages).toHaveLength(0)
    const { messages } = p.push(Buffer.from('1}\n', 'utf8'))
    expect(messages[0].toString('utf8')).toBe('{"n":1}')
  })

  it('一行超过上限 → message-too-large', () => {
    const p = new NdjsonParser(8)
    const { error } = p.push(Buffer.from('{"long":"xxxxxxxxxxxxxxxx"}', 'utf8'))
    expect(error?.code).toBe('message-too-large')
  })
})

describe('分帧 · createFrameParser', () => {
  it('默认 content-length，可选 ndjson', () => {
    expect(createFrameParser().encode(Buffer.from('{}')).toString('ascii')).toContain(
      'Content-Length: 2'
    )
    expect(createFrameParser('ndjson').encode(Buffer.from('{}')).toString('ascii')).toBe('{}\n')
  })
})

describe('通道 · 请求 / 通知 / 双向', () => {
  it('请求发出后带上自增 id 与 method/params；收到响应即 resolve', async () => {
    const { channel, written } = makeChannel()
    const promise = channel.request('sum', { a: 1, b: 2 })
    const [sent] = parseWritten(written) as Array<Record<string, unknown>>
    expect(sent).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'sum', params: { a: 1, b: 2 } })
    channel.accept(frame({ jsonrpc: '2.0', id: 1, result: 3 }))
    await expect(promise).resolves.toBe(3)
    expect(channel.pendingCount).toBe(0)
  })

  it('id 单调自增且不复用（重复 id 不会出现）', async () => {
    const { channel, written } = makeChannel()
    void channel.request('a')
    void channel.request('b')
    void channel.request('c')
    const ids = (parseWritten(written) as Array<{ id: number }>).map((m) => m.id)
    expect(ids).toEqual([1, 2, 3])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('乱序响应也能正确关联', async () => {
    const { channel } = makeChannel()
    const first = channel.request('slow')
    const second = channel.request('fast')
    channel.accept(frame({ jsonrpc: '2.0', id: 2, result: 'fast-result' }))
    channel.accept(frame({ jsonrpc: '2.0', id: 1, result: 'slow-result' }))
    await expect(second).resolves.toBe('fast-result')
    await expect(first).resolves.toBe('slow-result')
  })

  it('未知 id 的响应被忽略（对端可能迟到）', () => {
    const { channel } = makeChannel()
    expect(() => channel.accept(frame({ jsonrpc: '2.0', id: 999, result: 1 }))).not.toThrow()
    expect(channel.isClosed).toBe(false)
  })

  it('对端返回 error → 请求以错误码失败（不静默挂起）', async () => {
    const { channel } = makeChannel()
    const promise = channel.request('boom')
    channel.accept(frame({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: '对端拒绝' } }))
    await expect(promise).rejects.toMatchObject({ code: 'protocol-error' })
  })

  it('notify 只发不带 id 的通知', () => {
    const { channel, written } = makeChannel()
    channel.notify('log', { text: 'hi' })
    const [sent] = parseWritten(written) as Array<Record<string, unknown>>
    expect(sent).toEqual({ jsonrpc: '2.0', method: 'log', params: { text: 'hi' } })
    expect('id' in sent).toBe(false)
  })

  it('双向：对端发来请求 → 本端 handler 处理并回包', async () => {
    const { channel, written } = makeChannel()
    channel.handle('hostInfo', (params) => ({ echo: params }))
    channel.accept(frame({ jsonrpc: '2.0', id: 7, method: 'hostInfo', params: { q: 1 } }))
    await vi.waitFor(() => {
      expect(parseWritten(written)).toHaveLength(1)
    })
    expect(parseWritten(written)[0]).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { echo: { q: 1 } }
    })
  })

  it('双向：未注册方法 → 回 -32601 错误', async () => {
    const { channel, written } = makeChannel()
    channel.accept(frame({ jsonrpc: '2.0', id: 8, method: 'nope' }))
    await vi.waitFor(() => {
      expect(parseWritten(written)).toHaveLength(1)
    })
    expect(parseWritten(written)[0]).toMatchObject({ id: 8, error: { code: -32601 } })
  })

  it('双向：handler 抛错 → 回 -32603 且不影响通道', async () => {
    const { channel, written } = makeChannel()
    channel.handle('fail', () => {
      throw new Error('内部错误')
    })
    channel.accept(frame({ jsonrpc: '2.0', id: 9, method: 'fail' }))
    await vi.waitFor(() => {
      expect(parseWritten(written)).toHaveLength(1)
    })
    expect(parseWritten(written)[0]).toMatchObject({ id: 9, error: { code: -32603 } })
    expect(channel.isClosed).toBe(false)
  })

  it('对端通知 → 订阅者收到 method/params；退订后不再收到', () => {
    const { channel } = makeChannel()
    const seen: Array<[string, unknown]> = []
    const sub = channel.onNotification((method, params) => seen.push([method, params]))
    channel.accept(frame({ jsonrpc: '2.0', method: 'progress', params: { percent: 10 } }))
    expect(seen).toEqual([['progress', { percent: 10 }]])
    sub.dispose()
    channel.accept(frame({ jsonrpc: '2.0', method: 'progress', params: { percent: 20 } }))
    expect(seen).toHaveLength(1)
  })
})

describe('通道 · 超时 / 取消 / 限额', () => {
  it('超时 → timeout，且已从挂起表移除', async () => {
    const { channel } = makeChannel({ defaultTimeoutMs: 10 })
    await expect(channel.request('slow')).rejects.toMatchObject({ code: 'timeout' })
    expect(channel.pendingCount).toBe(0)
  })

  it('可逐请求覆盖超时', async () => {
    const { channel } = makeChannel({ defaultTimeoutMs: 1000 })
    await expect(channel.request('quick', undefined, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'timeout'
    })
  })

  it('取消（AbortSignal）→ cancelled，并向对端发 $/cancelRequest', async () => {
    const { channel, written } = makeChannel()
    const controller = new AbortController()
    const promise = channel.request('long', undefined, { signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' })
    const messages = parseWritten(written) as Array<Record<string, unknown>>
    expect(messages[1]).toEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } })
  })

  it('已中止的 signal → 立即 cancelled', async () => {
    const { channel } = makeChannel()
    const controller = new AbortController()
    controller.abort()
    await expect(
      channel.request('x', undefined, { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('并发请求超限 → too-many-requests', async () => {
    const { channel } = makeChannel({ maxPendingRequests: 2, defaultTimeoutMs: 0 })
    void channel.request('a')
    void channel.request('b')
    await expect(channel.request('c')).rejects.toMatchObject({ code: 'too-many-requests' })
  })

  it('待发送消息超过上限 → message-too-large（请求失败但不影响后续）', async () => {
    const { channel } = makeChannel({ maxMessageBytes: 32 })
    await expect(channel.request('big', { payload: 'x'.repeat(200) })).rejects.toMatchObject({
      code: 'message-too-large'
    })
    expect(channel.pendingCount).toBe(0)
  })

  it('收到的单条消息超过上限 → 通道以 message-too-large 关闭', () => {
    const { channel } = makeChannel({ maxMessageBytes: 64 })
    const reasons: Array<string | null> = []
    channel.onClose((err) => reasons.push(err?.code ?? null))
    channel.accept(frame({ jsonrpc: '2.0', method: 'log', params: { t: 'y'.repeat(200) } }))
    expect(channel.isClosed).toBe(true)
    expect(channel.closeReason?.code).toBe('message-too-large')
    expect(reasons).toEqual(['message-too-large'])
  })
})

describe('通道 · 协议错误与关闭语义', () => {
  it('非法 JSON → protocol-error 并关闭', () => {
    const { channel } = makeChannel()
    channel.accept(frame('not-json-object', new NdjsonParser()).subarray(0, 0)) // 空推送：不触发
    channel.accept(Buffer.from('Content-Length: 8\r\n\r\nnot-json', 'ascii'))
    expect(channel.isClosed).toBe(true)
    expect(channel.closeReason?.code).toBe('protocol-error')
  })

  it('缺少 jsonrpc: "2.0" → protocol-error', () => {
    const { channel } = makeChannel()
    channel.accept(frame({ id: 1, result: 1 }))
    expect(channel.closeReason?.code).toBe('protocol-error')
  })

  it('close() → 挂起请求以 channel-closed 失败，后续请求立即被拒', async () => {
    const { channel } = makeChannel()
    const pending = channel.request('never')
    const closedEvents: Array<string | null> = []
    channel.onClose((err) => closedEvents.push(err?.code ?? null))
    channel.close()
    await expect(pending).rejects.toMatchObject({ code: 'channel-closed' })
    await expect(channel.request('after')).rejects.toMatchObject({ code: 'channel-closed' })
    expect(() => channel.notify('after')).toThrow(IpcCoreError)
    expect(closedEvents).toEqual([null])
  })

  it('close(err) → 关闭事件带上原因；重复 close 只通知一次', () => {
    const { channel } = makeChannel()
    const events: Array<string | null> = []
    channel.onClose((err) => events.push(err?.code ?? null))
    channel.close(new IpcCoreError('peer-crashed', '对端进程退出'))
    channel.close()
    expect(events).toEqual(['peer-crashed'])
  })

  it('关闭后再收到字节不抛错（传输层可能滞后）', () => {
    const { channel } = makeChannel()
    channel.close()
    expect(() => channel.accept(frame({ jsonrpc: '2.0', method: 'x' }))).not.toThrow()
  })
})

describe('平台命名（不使用 TCP 端口）', () => {
  it('Windows → 命名管道路径（内核命名空间，无落盘文件）', () => {
    const endpoint = ipcEndpoint({
      platform: 'win32',
      socketDir: 'C:\\userData\\ipc',
      extensionId: 'todo_chenzhi',
      name: 'worker'
    })
    expect(endpoint).toBe('\\\\.\\pipe\\obox-todo_chenzhi-worker')
    expect(isWindowsNamedPipe(endpoint)).toBe(true)
    expect(endpoint).not.toMatch(/:\d/) // 不含端口
  })

  it('POSIX → 指定目录下的 .sock 文件', () => {
    const endpoint = ipcEndpoint({
      platform: 'linux',
      socketDir: '/home/u/.config/obox/ipc',
      extensionId: 'todo_chenzhi',
      name: 'worker'
    })
    expect(endpoint).toBe('/home/u/.config/obox/ipc/obox-todo_chenzhi-worker.sock')
    expect(isWindowsNamedPipe(endpoint)).toBe(false)
  })

  it('可选随机后缀（服务端多客户端场景；客户端拨号不传以保持稳定）', () => {
    const withSuffix = ipcEndpoint({
      platform: 'win32',
      socketDir: 'x',
      extensionId: 'e',
      name: 'n',
      suffix: 'a1b2'
    })
    expect(withSuffix).toBe('\\\\.\\pipe\\obox-e-n-a1b2')
  })

  it('扩展 id / 通道名非法（路径穿越等）→ invalid-declaration', () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '', 'a b', '..']) {
      expect(() => sanitizeIpcName(bad)).toThrowError(IpcCoreError)
      try {
        sanitizeIpcName(bad)
      } catch (err) {
        expect((err as IpcCoreError).code).toBe('invalid-declaration')
      }
    }
  })
})

describe('声明校验', () => {
  it('stdio：需要扩展目录内的相对 program；归一化 .\\ 前缀', () => {
    expect(
      validateIpcDeclaration({ id: 'worker', transport: 'stdio', program: './bin/worker.exe' })
    ).toEqual({ id: 'worker', transport: 'stdio', program: 'bin/worker.exe' })
    expect(
      validateIpcDeclaration({
        id: 'worker',
        transport: 'stdio',
        program: 'bin/worker.exe',
        args: ['--serve'],
        framing: 'ndjson'
      })
    ).toEqual({
      id: 'worker',
      transport: 'stdio',
      program: 'bin/worker.exe',
      args: ['--serve'],
      framing: 'ndjson'
    })
  })

  it('stdio：绝对路径 / 盘符 / .. / 缺 program → invalid-declaration', () => {
    const bad = [
      { id: 'w', transport: 'stdio' },
      { id: 'w', transport: 'stdio', program: 'C:\\evil.exe' },
      { id: 'w', transport: 'stdio', program: '/usr/bin/evil' },
      { id: 'w', transport: 'stdio', program: '../outside.exe' },
      { id: 'w', transport: 'stdio', program: 'bin/../../out.exe' }
    ]
    for (const decl of bad) {
      expect(() => validateIpcDeclaration(decl)).toThrowError(IpcCoreError)
    }
  })

  it('pipe：不接受 program/args（它是连接已在运行的进程）', () => {
    expect(validateIpcDeclaration({ id: 'svc', transport: 'pipe' })).toEqual({
      id: 'svc',
      transport: 'pipe'
    })
    expect(() =>
      validateIpcDeclaration({ id: 'svc', transport: 'pipe', program: 'x.exe' })
    ).toThrowError(IpcCoreError)
  })

  it('明确拒绝 TCP/端口类传输与非法 framing', () => {
    expect(() => validateIpcDeclaration({ id: 'x', transport: 'tcp' })).toThrowError(IpcCoreError)
    expect(() => validateIpcDeclaration({ id: 'x', transport: 'http' })).toThrowError(IpcCoreError)
    expect(() =>
      validateIpcDeclaration({ id: 'x', transport: 'pipe', framing: 'length-prefixed' })
    ).toThrowError(IpcCoreError)
  })

  it('非对象声明 → invalid-declaration', () => {
    for (const bad of [null, 42, 'worker', []]) {
      expect(() => validateIpcDeclaration(bad)).toThrowError(IpcCoreError)
    }
  })
})
