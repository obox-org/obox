/**
 * `api.net.download` 的 **main 侧**端到端单测（`downloadToExtensionDataDir`）：
 * 真正写盘、真正按 `planDownload` 决策，而不是只测规划函数。
 *
 * 为什么要这一层：`net:download` IPC 与宿主内部 RPC `host.netDownload` **共用**这个函数
 * （`src/main/net.ts` / `src/main/index.ts`），所以它是"下载落到扩展自己的 data 目录"的
 * 唯一实现点。规划函数（`test/net-download.test.ts`）只证明策略，不证明"真的写到了哪"。
 *
 * 依赖隔离：electron 只用到 `app.getPath('userData')` 与 `ipcMain.handle`；网络只用到
 * `netSession().fetch`（Chromium session 的 fetch），这里用假的 `Response` 代替 ——
 * 真代理/真 TLS 不在单测范围（代理继承由 `src/main/proxy.ts` 的既有用例覆盖）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  userData: '',
  /** 假 session.fetch 的行为（每用例重设） */
  fetchImpl: null as null | ((url: string) => Promise<unknown>),
  /** 记录 applyProxyToSession 收到的 session 与代理（验证"下载也应用代理"这条接线） */
  appliedProxy: [] as unknown[],
  handles: new Map<string, (event: unknown, req: unknown, proxy?: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string): string => (name === 'userData' ? state.userData : '') },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, req: unknown, proxy?: unknown) => unknown
    ) => {
      state.handles.set(channel, handler)
    }
  }
}))

vi.mock('../src/main/proxy', () => ({
  netSession: () => ({
    fetch: (url: string) => state.fetchImpl!(url)
  }),
  applyProxyToSession: (_session: unknown, proxy: unknown) => {
    state.appliedProxy.push(proxy)
  },
  currentProxy: () => ({ enabled: true, url: 'http://127.0.0.1:7890' }),
  applyProxy: () => {},
  proxyRulesOf: () => ''
}))

const { downloadToExtensionDataDir, registerNetIpc } = await import('../src/main/net')

const tempDirs: string[] = []

/** 假的 Chromium Response：够 `downloadToExtensionDataDir` 用（ok/status/statusText/body.getReader） */
function responseOf(chunks: string[], init: { ok?: boolean; status?: number } = {}): unknown {
  const encoder = new TextEncoder()
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.ok === false ? 'Not Found' : 'OK',
    body: new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    })
  }
}

async function makeUserData(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'obox-net-download-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(async (): Promise<void> => {
  state.userData = await makeUserData()
  state.fetchImpl = async () => responseOf(['hello ', 'world'])
  state.appliedProxy = []
  state.handles.clear()
})

afterEach(async (): Promise<void> => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('downloadToExtensionDataDir：写到扩展自己的 data 目录', () => {
  it('按 extId 定位目录、建子目录、流式写盘，并回相对路径与字节数', async () => {
    const result = await downloadToExtensionDataDir({
      extId: 'obox-updater.obox-org',
      url: 'https://example.com/a.zip',
      relPath: 'installers/a.zip',
      onExist: 'overwrite'
    })

    expect(result).toEqual({ ok: true, path: 'installers/a.zip', bytes: 11 })
    const abs = path.join(
      state.userData,
      'extensions',
      'obox-updater.obox-org',
      'data',
      'installers',
      'a.zip'
    )
    await expect(readFile(abs, 'utf8')).resolves.toBe('hello world')
  })

  it('默认 onExist=rename：目标已存在时改名，不覆盖原文件', async () => {
    const abs = path.join(state.userData, 'extensions', 'ext', 'data', 'a.zip')
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, 'OLD', 'utf8')

    const result = await downloadToExtensionDataDir({
      extId: 'ext',
      url: 'https://example.com/a.zip',
      relPath: 'a.zip'
    })
    expect(result).toEqual({ ok: true, path: 'a (1).zip', bytes: 11 })
    await expect(readFile(abs, 'utf8')).resolves.toBe('OLD')
  })

  it("onExist='skip' 且已存在 ⇒ { ok: true, skipped: true }，不发请求", async () => {
    const abs = path.join(state.userData, 'extensions', 'ext', 'data', 'a.zip')
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, 'OLD', 'utf8')
    let fetched = 0
    state.fetchImpl = async () => {
      fetched += 1
      return responseOf(['x'])
    }

    const result = await downloadToExtensionDataDir({
      extId: 'ext',
      url: 'https://example.com/a.zip',
      relPath: 'a.zip',
      onExist: 'skip'
    })
    expect(result).toEqual({ ok: true, skipped: true })
    expect(fetched).toBe(0)
  })

  it("onExist='overwrite' 覆盖已有文件", async () => {
    const abs = path.join(state.userData, 'extensions', 'ext', 'data', 'a.zip')
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, 'OLD', 'utf8')

    const result = await downloadToExtensionDataDir({
      extId: 'ext',
      url: 'https://example.com/a.zip',
      relPath: 'a.zip',
      onExist: 'overwrite'
    })
    expect(result).toEqual({ ok: true, path: 'a.zip', bytes: 11 })
    await expect(readFile(abs, 'utf8')).resolves.toBe('hello world')
  })
})

describe('downloadToExtensionDataDir：拒绝非法入参与越界路径（不写盘、不请求）', () => {
  it('非法 extId → { ok:false }', async () => {
    for (const extId of ['', '../etc', 'a b', '中文']) {
      const result = await downloadToExtensionDataDir({ extId, url: 'https://x/a', relPath: 'a' })
      expect(result.ok, extId).toBe(false)
    }
  })

  it('非 http(s) url → { ok:false }', async () => {
    const result = await downloadToExtensionDataDir({
      extId: 'ext',
      url: 'ftp://x/a',
      relPath: 'a'
    })
    expect(result).toEqual({ ok: false, error: 'url 必须是 http/https 地址' })
  })

  it('绝对路径 / .. 逃逸 → { ok:false }（planDownload 的 message 原样回给扩展）', async () => {
    for (const relPath of ['C:/Windows/a.zip', '../a.zip', '/a.zip', 'a/../../b.zip']) {
      const result = await downloadToExtensionDataDir({
        extId: 'ext',
        url: 'https://x/a',
        relPath
      })
      expect(result.ok, relPath).toBe(false)
    }
  })

  it('HTTP 非 2xx → { ok:false }（带状态码语义，但不落半截文件）', async () => {
    state.fetchImpl = async () => responseOf([], { ok: false, status: 404 })
    const result = await downloadToExtensionDataDir({
      extId: 'ext',
      url: 'https://x/missing.zip',
      relPath: 'missing.zip'
    })
    expect(result).toEqual({ ok: false, error: '下载失败：HTTP 404 Not Found' })
  })
})

describe('net:download IPC', () => {
  it('注册的 handler 与宿主内部 RPC 共用同一实现（extId 由调用方传入、代理走 applyProxyToSession）', async () => {
    registerNetIpc()
    const handler = state.handles.get('net:download')
    expect(typeof handler).toBe('function')

    const result = await handler!(
      {},
      { extId: 'ext', url: 'https://x/a.zip', relPath: 'a.zip' },
      { enabled: true, url: 'http://proxy:8080' }
    )
    expect(result).toEqual({ ok: true, path: 'a.zip', bytes: 11 })
    expect(state.appliedProxy).toEqual([{ enabled: true, url: 'http://proxy:8080' }])
  })
})
