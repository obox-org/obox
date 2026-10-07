/**
 * 流式传输（`openStreamTransport`）的测试：不 spawn 子进程、不开端口，
 * 用一对 `PassThrough` 把两个 `JsonRpcChannel` 接成环回，验证双向请求、通知与 dispose 回调。
 */
import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { IpcCoreError, JsonRpcChannel } from '../src/main/ipcCore'
import { openStreamTransport } from '../src/main/ipcTransport'

/** 把宿主传输与一个"对端通道"用两条管道对接 */
function loopback(): {
  host: ReturnType<typeof openStreamTransport>
  peer: JsonRpcChannel
  toHost: PassThrough
  toPeer: PassThrough
} {
  const toHost = new PassThrough()
  const toPeer = new PassThrough()
  let disposed = 0
  const host = openStreamTransport({
    readable: toHost,
    writable: toPeer,
    onDispose: () => {
      disposed += 1
    }
  })
  const peer = new JsonRpcChannel({
    sendFrame: (frame) => toHost.write(frame)
  })
  // 宿主 → 对端的字节喂给对端通道
  toPeer.on('data', (chunk: Buffer) => peer.accept(chunk))
  void disposed
  return { host, peer, toHost, toPeer }
}

describe('openStreamTransport', () => {
  it('宿主向对端发请求并拿到结果（content-length 分帧）', async () => {
    const { host, peer } = loopback()
    peer.handle('sum', (params) => {
      const p = params as { a: number; b: number }
      return p.a + p.b
    })
    await host.ready
    await expect(host.channel.request('sum', { a: 2, b: 3 })).resolves.toBe(5)
  })

  it('对端也能向宿主发请求（双向）', async () => {
    const { host, peer } = loopback()
    host.channel.handle('hostInfo', () => ({ version: '1.0.0' }))
    await host.ready
    await expect(peer.request('hostInfo')).resolves.toEqual({ version: '1.0.0' })
  })

  it('通知不入结果通道，能被对端收到', async () => {
    const { host, peer } = loopback()
    const seen: Array<[string, unknown]> = []
    peer.onNotification((method, params) => seen.push([method, params]))
    await host.ready
    host.channel.notify('log', { text: 'hi' })
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toEqual([['log', { text: 'hi' }]])
  })

  it('ndjson 分帧可选', async () => {
    const toHost = new PassThrough()
    const toPeer = new PassThrough()
    const host = openStreamTransport({ readable: toHost, writable: toPeer, framing: 'ndjson' })
    const peer = new JsonRpcChannel({
      framing: 'ndjson',
      sendFrame: (frame) => toHost.write(frame)
    })
    toPeer.on('data', (chunk: Buffer) => peer.accept(chunk))
    peer.handle('ping', () => 'pong')
    await expect(host.channel.request('ping')).resolves.toBe('pong')
  })

  it('对端流不可写 → 请求以 not-connected 抛错', async () => {
    const toHost = new PassThrough()
    const toPeer = new PassThrough()
    const host = openStreamTransport({ readable: toHost, writable: toPeer })
    toPeer.end()
    await expect(host.channel.request('anything')).rejects.toMatchObject({ code: 'not-connected' })
  })

  it('dispose() 关闭通道并调用清理回调（幂等由调用方保证）', () => {
    let disposed = 0
    const host = openStreamTransport({
      readable: new PassThrough(),
      writable: new PassThrough(),
      onDispose: () => {
        disposed += 1
      }
    })
    const reasons: Array<string | null> = []
    host.channel.onClose((err) => reasons.push(err?.code ?? null))
    host.dispose()
    expect(disposed).toBe(1)
    expect(host.channel.isClosed).toBe(true)
    expect(reasons.length).toBe(1)
  })

  it('调用方可把对端退出归因为 peer-crashed（供 ipc.ts 广播与注销）', () => {
    const host = openStreamTransport({
      readable: new PassThrough(),
      writable: new PassThrough()
    })
    const seen: Array<IpcCoreError | null> = []
    host.channel.onClose((err) => seen.push(err))
    host.channel.close(new IpcCoreError('peer-crashed', '对端进程退出（code=1）'))
    expect(seen[0]?.code).toBe('peer-crashed')
    expect(seen[0]?.message).toContain('code=1')
  })
})
