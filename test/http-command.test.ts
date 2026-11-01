import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHttpCommandServer, type HttpCommandServerHandle } from '../src/main/httpServer'
import { HTTP_ENDPOINT_FILE, parseHttpCommandName } from '../src/shared/httpCommand'

/**
 * 宿主 HTTP 指令面（2.0.3）。
 *
 * 只覆盖服务端契约：随机端口、令牌鉴权、路由、端点文件、指令名校验。
 * "指令如何落到扩展"由分层测试覆盖（main → 渲染 → 宿主），这里不重复。
 */
const handles: HttpCommandServerHandle[] = []

async function start(
  dispatched: Array<{ command: string; payload: unknown }> = []
): Promise<{ handle: HttpCommandServerHandle; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'obox-http-'))
  const handle = await startHttpCommandServer({
    userDataDir: dir,
    version: '2.0.3-test',
    listCommands: (): string[] => ['pet_chenzhi:feed', 'pet_chenzhi:bathe'],
    dispatch: async (command, payload): Promise<{ ok: boolean; data?: unknown }> => {
      dispatched.push({ command, payload })
      return { ok: true, data: { echoed: command } }
    },
    token: 'test-token',
    log: (): void => undefined
  })
  handles.push(handle)
  return { handle, dir }
}

afterEach(async (): Promise<void> => {
  while (handles.length > 0) await handles.pop()?.close()
})

describe('http 指令面 · 服务端契约', () => {
  it('随机端口 + 端点文件：port 由系统分配，文件里有 url/token/version', async (): Promise<void> => {
    const { handle, dir } = await start()
    expect(handle.info.port).toBeGreaterThan(0)
    expect(handle.info.url).toBe(`http://127.0.0.1:${handle.info.port}`)
    const text = await readFile(join(dir, HTTP_ENDPOINT_FILE), 'utf8')
    const saved = JSON.parse(text) as { port: number; token: string; version: string; url: string }
    expect(saved.port).toBe(handle.info.port)
    expect(saved.token).toBe('test-token')
    expect(saved.version).toBe('2.0.3-test')
    expect(saved.url).toBe(handle.info.url)
    await rm(dir, { recursive: true, force: true })
  })

  it('GET /health 不需要令牌；其余接口缺令牌一律 401', async (): Promise<void> => {
    const { handle } = await start()
    const health = await fetch(`${handle.info.url}/health`)
    expect(health.status).toBe(200)
    expect((await health.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      app: 'obox'
    })

    const unauthorized = await fetch(`${handle.info.url}/commands`)
    expect(unauthorized.status).toBe(401)

    const authorized = await fetch(`${handle.info.url}/commands`, {
      headers: { 'x-obox-token': 'test-token' }
    })
    expect(authorized.status).toBe(200)
    expect((await authorized.json()) as { ok: boolean; commands: string[] }).toEqual({
      ok: true,
      commands: ['pet_chenzhi:feed', 'pet_chenzhi:bathe']
    })
  })

  it('POST /command 转发到扩展并回包；指令名非法/JSON 坏掉各自 400', async (): Promise<void> => {
    const dispatched: Array<{ command: string; payload: unknown }> = []
    const { handle } = await start(dispatched)
    const ok = await fetch(`${handle.info.url}/command`, {
      method: 'POST',
      headers: { 'x-obox-token': 'test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'pet_chenzhi:feed', payload: { amount: 1 } })
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      data: { echoed: 'pet_chenzhi:feed' }
    })
    expect(dispatched).toEqual([{ command: 'pet_chenzhi:feed', payload: { amount: 1 } }])

    const badName = await fetch(`${handle.info.url}/command`, {
      method: 'POST',
      headers: { 'x-obox-token': 'test-token' },
      body: JSON.stringify({ command: 'no-separator' })
    })
    expect(badName.status).toBe(400)

    const badJson = await fetch(`${handle.info.url}/command`, {
      method: 'POST',
      headers: { 'x-obox-token': 'test-token' },
      body: '{not json'
    })
    expect(badJson.status).toBe(400)
  })

  it('未知路径 404，且不回 CORS 头（浏览器页面读不到响应）', async (): Promise<void> => {
    const { handle } = await start()
    const res = await fetch(`${handle.info.url}/nope`, {
      headers: { 'x-obox-token': 'test-token' }
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('指令名解析：<extId>:<name>；空/缺分隔符/非法字符都拒绝', (): void => {
    expect(parseHttpCommandName('pet_chenzhi:feed')).toEqual({
      extId: 'pet_chenzhi',
      name: 'feed'
    })
    for (const bad of ['', 'feed', 'pet_chenzhi:', ':feed', 'Pet:feed', 'pet:fe ed']) {
      expect('error' in parseHttpCommandName(bad)).toBe(true)
    }
  })
})
