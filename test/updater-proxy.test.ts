/**
 * 卡 20 · fix-updater-proxy 门禁：**更新链路必须真正走代理**（用户报告"obox-updater 扩展没有使用代理"）。
 *
 * 三处缺陷（父代理只读定位，本文件逐条回归）：
 * 1. `applyProxy()`（"把代理同时应用到扩展联网与更新两个 session"）**没有调用方** ⇒ "启动/改设置时让两个
 *    session 处于已配置状态"这条路径从未执行。修复：渲染进程经新 IPC `proxy:apply` 推送
 *    （主进程 `registerProxyIpc`、preload `applyProxy`、渲染侧 `main.ts` 启动 + 设置变化时调用）。
 * 2. `update:download` / `update:install` 完全没碰代理 ⇒ 是否走代理取决于"上一次 check 是否恰好配置过"
 *    这种偶然状态。修复：两个动作前各自 `applyUpdaterProxy(undefined, 'current')`。
 * 3. `applyProxyToSession(ses, undefined)` 会把 session **重置成直连**并清空凭据缓存 ⇒ 调用方漏传 proxy
 *    时静默关掉代理。修复：所有调用点"显式覆盖 else 当前配置"（`updater.ts` 的 `applyUpdaterProxy`、
 *    `net.ts` 的 `proxy ?? currentProxy()`），**不动** `applyProxyToSession` 对 `undefined` 的语义
 *    ——用户关掉代理必须关得掉（下面有专门用例）。
 *
 * 测试方式：`vi.mock('electron')` + `vi.mock('electron-updater')` 后跑**真实的** `src/main/updater.ts`
 * / `src/main/net.ts`（先例：test/ipc-server.test.ts、test/overlay-window.test.ts）；假 session 逐次记录
 * `setProxy` / `setCertificateVerifyProc` / `closeAllConnections` / `fetch`，IPC 处理器从 mock 的
 * `ipcMain.handle` 注册表里取出后直接调用（不需要 Electron 运行时）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, test, vi } from 'vitest'

/** 假 session 的测试侧视图（与 mock 工厂里的 FakeSession 字段一一对应） */
interface SessionProbe {
  setProxyCalls: Array<{ proxyRules?: string; proxyBypassRules?: string; mode?: string }>
  certProcs: unknown[]
  closeAllCalls: number[]
  fetchCalls: string[]
  fetchImpl?: (url: string) => Promise<Response>
}

const NET = 'obox-net'
const UPDATER = 'electron-updater'
const RULES_7890 = 'http=127.0.0.1:7890;https=127.0.0.1:7890'
const RULES_DEAD = 'http=127.0.0.1:9;https=127.0.0.1:9'

const mock = vi.hoisted(() => {
  class FakeSession {
    setProxyCalls: Array<{ proxyRules?: string; proxyBypassRules?: string; mode?: string }> = []
    certProcs: unknown[] = []
    closeAllCalls: number[] = []
    fetchCalls: string[] = []
    fetchImpl: ((url: string) => Promise<Response>) | undefined
    setProxy(opts: {
      proxyRules?: string
      proxyBypassRules?: string
      mode?: string
    }): Promise<void> {
      this.setProxyCalls.push(opts)
      return Promise.resolve()
    }
    setCertificateVerifyProc(proc: unknown): void {
      this.certProcs.push(proc)
    }
    closeAllConnections(): void {
      this.closeAllCalls.push(1)
    }
    async fetch(url: string): Promise<Response> {
      this.fetchCalls.push(url)
      if (!this.fetchImpl) throw new Error('假 session 未设置 fetchImpl')
      return this.fetchImpl(url)
    }
  }

  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    listeners: new Map<string, Array<(...a: unknown[]) => void>>(),
    feedUrls: [] as unknown[],
    checkCalls: 0,
    downloadCalls: 0,
    installCalls: 0,
    on(ev: string, cb: (...a: unknown[]) => void): void {
      const list = this.listeners.get(ev) ?? []
      list.push(cb)
      this.listeners.set(ev, list)
    },
    /** 测试侧触发主进程注册的 electron-updater 事件（login / error / update-available …） */
    fire(ev: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(ev) ?? []) cb(...args)
    },
    setFeedURL(opts: unknown): void {
      this.feedUrls.push(opts)
    },
    async checkForUpdates(): Promise<{ updateInfo: { version: string } }> {
      this.checkCalls += 1
      return { updateInfo: { version: '1.0.17' } }
    },
    async downloadUpdate(): Promise<void> {
      this.downloadCalls += 1
    },
    quitAndInstall(): void {
      this.installCalls += 1
    }
  }

  return {
    sessions: new Map<string, InstanceType<typeof FakeSession>>(),
    handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
    updater,
    /** app.getPath('userData') 的假目录（force-install 会往里写安装包） */
    userDataDir: '',
    makeSession(partition: string): InstanceType<typeof FakeSession> {
      const ses = new FakeSession()
      this.sessions.set(partition, ses)
      return ses
    },
    reset(): void {
      // 注意：**不清 listeners** —— electron-updater 的 login/error 等监听是 ensureInit() 在
      // registerUpdateIpc() 时注册的一次性副作用，清掉会让后面的凭据用例假失败
      updater.feedUrls.length = 0
      updater.checkCalls = 0
      updater.downloadCalls = 0
      updater.installCalls = 0
      updater.autoDownload = true
      updater.autoInstallOnAppQuit = true
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (e: unknown, ...args: unknown[]) => unknown): void => {
      mock.handlers.set(channel, handler)
    }
  },
  app: {
    getVersion: (): string => '1.0.16',
    getPath: (): string => mock.userDataDir
  },
  shell: { openPath: async (): Promise<string> => '' },
  session: {
    // 每个 partition 一个假 session，且**同一用例内稳定返回同一对象**（指纹去重靠对象身份）
    fromPartition: (partition: string): unknown =>
      mock.sessions.get(partition) ?? mock.makeSession(partition)
  }
}))

vi.mock('electron-updater', () => ({ autoUpdater: mock.updater, UpdateInfo: {} }))

const { registerUpdateIpc } = await import('../src/main/updater')
const { registerNetIpc } = await import('../src/main/net')
const {
  applyProxy,
  applyProxyToSession,
  currentProxy,
  currentProxyCredentials,
  netSession,
  updaterSession
} = await import('../src/main/proxy')

registerUpdateIpc()
registerNetIpc()

/** 假 session 的调用记录（按 partition 取） */
function probe(partition: string): SessionProbe {
  const ses = partition === NET ? netSession() : updaterSession()
  return ses as unknown as SessionProbe
}

/** 直接调用 IPC 处理器（注册表由 mock 的 ipcMain.handle 填充） */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mock.handlers.get(channel)
  if (!handler) throw new Error(`未注册的 IPC：${channel}`)
  return (await handler({}, ...args)) as T
}

const proxy7890 = { enabled: true, url: 'http://127.0.0.1:7890', noProxy: [] }
const deadProxy = { enabled: true, url: 'http://127.0.0.1:9', noProxy: [] }
const directProxy = { enabled: false, url: '', noProxy: [] }
const noDirect = (calls: SessionProbe['setProxyCalls']): boolean =>
  calls.every((c) => c.mode !== 'direct')

beforeEach(() => {
  // 清掉模块级「当前配置」（作用在旧 session 上，随即被丢弃）——否则上个用例的配置会漏进本用例
  applyProxyToSession(updaterSession(), undefined)
  mock.sessions.clear()
  mock.reset()
})

describe('a) 显式传入代理 ⇒ 更新链路各动作前已把配置应用到 updater session', () => {
  test('update:resolve-feed', async () => {
    probe(UPDATER).fetchImpl = async () =>
      new Response(
        JSON.stringify([
          {
            tag_name: 'v1.0.17',
            published_at: '2026-10-16T00:00:00Z',
            draft: false,
            prerelease: false,
            assets: [{ name: 'latest.yml' }]
          }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    const r = await invoke<{ ok: boolean; tag?: string }>(
      'update:resolve-feed',
      'obox-org/obox',
      proxy7890
    )
    assert.equal(r.ok, true)
    assert.deepEqual(probe(UPDATER).setProxyCalls, [
      { proxyRules: RULES_7890, proxyBypassRules: '' }
    ])
    assert.ok(noDirect(probe(UPDATER).setProxyCalls), '不得出现 direct')
  })

  test('update:check', async () => {
    const r = await invoke<{ ok: boolean; available?: string }>('update:check', {
      feedUrl: 'https://example.com/feed/',
      proxy: proxy7890
    })
    assert.equal(r.ok, true)
    assert.equal(r.available, '1.0.17')
    assert.equal(mock.updater.checkCalls, 1)
    assert.deepEqual(probe(UPDATER).setProxyCalls, [
      { proxyRules: RULES_7890, proxyBypassRules: '' }
    ])
    assert.ok(noDirect(probe(UPDATER).setProxyCalls), '不得出现 direct')
  })

  test('update:force-install（走完下载 → 校验 → 启动安装向导）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'obox-updater-proxy-'))
    mock.userDataDir = dir
    try {
      probe(UPDATER).fetchImpl = async (url: string) =>
        url.endsWith('latest.yml')
          ? new Response(
              [
                'version: 1.0.17',
                'files:',
                '  - url: obox-1.0.17-x64-setup.exe',
                '    size: 5',
                'path: obox-1.0.17-x64-setup.exe',
                "releaseDate: '2026-10-16T00:00:00.000Z'"
              ].join('\n'),
              { status: 200 }
            )
          : new Response('hello', { status: 200 })
      const r = await invoke<{ ok: boolean; version?: string }>('update:force-install', {
        feedUrl: 'https://example.com/feed/',
        proxy: proxy7890,
        reason: 'user'
      })
      assert.equal(r.ok, true)
      assert.equal(r.version, '1.0.17')
      assert.deepEqual(probe(UPDATER).setProxyCalls, [
        { proxyRules: RULES_7890, proxyBypassRules: '' }
      ])
      assert.ok(noDirect(probe(UPDATER).setProxyCalls), '不得出现 direct')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('b/d) 调用方未传代理 ⇒ 回落「当前配置」/ 不依赖调用顺序', () => {
  test('update:download：本 IPC 不带 proxy ⇒ 回落当前配置，且不出现 direct', async () => {
    applyProxy(proxy7890) // = 渲染进程启动/改设置时推送（proxy:apply）
    assert.equal(mock.updater.downloadCalls, 0)
    const before = probe(UPDATER).setProxyCalls.length
    const r = await invoke<{ ok: boolean }>('update:download')
    assert.equal(r.ok, true)
    assert.equal(mock.updater.downloadCalls, 1)
    assert.equal(before, 1, '推送时已配置一次（下面的下载本身是幂等复用）')
    assert.deepEqual(probe(UPDATER).setProxyCalls, [
      { proxyRules: RULES_7890, proxyBypassRules: '' }
    ])
    assert.ok(noDirect(probe(UPDATER).setProxyCalls), '不得出现 direct')
  })

  test('update:install：同样补齐当前配置', async () => {
    applyProxy(proxy7890)
    await invoke('update:install')
    assert.equal(mock.updater.installCalls, 1)
    assert.deepEqual(probe(UPDATER).setProxyCalls, [
      { proxyRules: RULES_7890, proxyBypassRules: '' }
    ])
    assert.ok(noDirect(probe(UPDATER).setProxyCalls), '不得出现 direct')
  })

  test('从未 check 就直接 download：updater session 此前从未配置过，下载自己补上代理', async () => {
    // 只把配置应用到 **net** session（模拟"当前配置已推入、但 updater session 还没被任何 check 碰过"）
    applyProxyToSession(netSession(), proxy7890)
    assert.deepEqual(probe(UPDATER).setProxyCalls, [], 'download 之前 updater session 必须未被配置')
    assert.equal(probe(NET).setProxyCalls.length, 1)
    await invoke('update:download')
    assert.deepEqual(
      probe(UPDATER).setProxyCalls,
      [{ proxyRules: RULES_7890, proxyBypassRules: '' }],
      'download 必须自己应用代理，而不是指望上一次 check 留下的状态'
    )
  })

  test('net:fetch：调用方没传代理时同样回落当前配置（不静默关代理）', async () => {
    applyProxy(proxy7890)
    probe(NET).fetchImpl = async () => new Response('ok', { status: 200 })
    const r = await invoke<{ ok: boolean }>('net:fetch', { url: 'https://example.com/' })
    assert.equal(r.ok, true)
    assert.ok(noDirect(probe(NET).setProxyCalls), 'net session 不得被重置成 direct')
  })
})

describe('c) 用户关掉代理必须关得掉（防回归）', () => {
  test('applyProxy(undefined) ⇒ 两个 session 都变 direct', async () => {
    applyProxy(proxy7890)
    assert.ok(noDirect(probe(NET).setProxyCalls))
    applyProxy(undefined)
    assert.deepEqual(probe(NET).setProxyCalls.at(-1), { mode: 'direct' })
    assert.deepEqual(probe(UPDATER).setProxyCalls.at(-1), { mode: 'direct' })
    assert.equal(currentProxy(), undefined)
    assert.equal(currentProxyCredentials(), undefined)
  })

  test('推送 {enabled:false}（渲染进程的真实"关代理"形态）⇒ 两个 session 都 direct，且随后的 download 仍是 direct', async () => {
    await invoke('proxy:apply', proxy7890)
    await invoke('proxy:apply', directProxy)
    assert.deepEqual(probe(NET).setProxyCalls.at(-1), { mode: 'direct' })
    assert.deepEqual(probe(UPDATER).setProxyCalls.at(-1), { mode: 'direct' })
    const before = probe(UPDATER).setProxyCalls.length
    await invoke('update:download')
    assert.equal(probe(UPDATER).setProxyCalls.length, before, '直连配置指纹未变 ⇒ 不重复 setProxy')
    assert.deepEqual(probe(UPDATER).setProxyCalls.at(-1), { mode: 'direct' })
  })

  test('proxy:apply（IPC）把配置同时应用到两个 session —— applyProxy 不再是死代码', async () => {
    await invoke('proxy:apply', deadProxy)
    assert.deepEqual(probe(NET).setProxyCalls, [{ proxyRules: RULES_DEAD, proxyBypassRules: '' }])
    assert.deepEqual(probe(UPDATER).setProxyCalls, [
      { proxyRules: RULES_DEAD, proxyBypassRules: '' }
    ])
    assert.equal(currentProxy()?.url, 'http://127.0.0.1:9')
  })
})

describe('e) 指纹去重与凭据链路', () => {
  test('同一配置重复推送 + 抓一次 check + 一次 download ⇒ updater session 只 setProxy 一次', async () => {
    await invoke('proxy:apply', proxy7890)
    await invoke('proxy:apply', proxy7890)
    await invoke('update:check', { feedUrl: 'https://example.com/feed/', proxy: proxy7890 })
    await invoke('update:download')
    await invoke('update:install')
    assert.equal(probe(UPDATER).setProxyCalls.length, 1)
    assert.equal(probe(NET).setProxyCalls.length, 1)
    assert.equal(probe(UPDATER).closeAllCalls.length, 1, 'setProxy 之后必须 closeAllConnections')
  })

  test('代理认证凭据：check 与 download 两条路径上 autoUpdater 的 login 都拿得到', async () => {
    const cred = { enabled: true, url: 'http://u:p%40w@127.0.0.1:3128', noProxy: [] }
    await invoke('update:check', { feedUrl: 'https://example.com/feed/', proxy: cred })
    assert.deepEqual(currentProxyCredentials(), { username: 'u', password: 'p@w' })
    const viaCheck: Array<[string?, string?]> = []
    mock.updater.fire('login', {}, (...args: string[]) => viaCheck.push(args))
    assert.deepEqual(viaCheck, [['u', 'p@w']], 'check 路径必须能回填凭据')

    // 新会话：只经 proxy:apply（启动推送）+ download（不传代理）
    applyProxyToSession(updaterSession(), undefined)
    mock.sessions.clear()
    await invoke('proxy:apply', cred)
    await invoke('update:download')
    assert.deepEqual(currentProxyCredentials(), { username: 'u', password: 'p@w' })
    const viaDownload: Array<[string?, string?]> = []
    mock.updater.fire('login', {}, (...args: string[]) => viaDownload.push(args))
    assert.deepEqual(viaDownload, [['u', 'p@w']], 'download 路径必须能回填凭据')
  })
})

describe('负向自检', () => {
  test('代理 URL 非法 ⇒ 两个 session 按直连应用（warn 可见），download 不崩', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await invoke('proxy:apply', { enabled: true, url: '127.0.0.1:7890', noProxy: [] })
      assert.deepEqual(probe(NET).setProxyCalls, [{ mode: 'direct' }])
      assert.deepEqual(probe(UPDATER).setProxyCalls, [{ mode: 'direct' }])
      assert.ok(
        warn.mock.calls.some((c) => String(c[0]).includes('[proxy]')),
        '非法配置必须留下原因（console.warn）'
      )
      const r = await invoke<{ ok: boolean }>('update:download')
      assert.equal(r.ok, true, '非法配置回落直连，不应让 download 崩')
      assert.ok(
        log.mock.calls.some((c) => String(c[0]).includes('[updater] 代理：direct')),
        '更新链路必须留下代理诊断日志'
      )
    } finally {
      warn.mockRestore()
      log.mockRestore()
    }
  })

  test('从未配置过代理 ⇒ currentProxy() 为 undefined，download 回落直连而非崩溃', async () => {
    assert.equal(currentProxy(), undefined)
    assert.equal(await invoke<{ ok: boolean }>('update:download').then((r) => r.ok), true)
    assert.deepEqual(probe(UPDATER).setProxyCalls, [{ mode: 'direct' }])
  })

  test('noProxy / ignoreSSL 仍生效（规则串不变，bypass 与证书放行照旧）', async () => {
    await invoke('proxy:apply', {
      enabled: true,
      url: 'http://127.0.0.1:7890',
      ignoreSSL: true,
      noProxy: ['localhost', '127.0.0.1']
    })
    assert.deepEqual(probe(UPDATER).setProxyCalls, [
      { proxyRules: RULES_7890, proxyBypassRules: 'localhost,127.0.0.1' }
    ])
    assert.equal(probe(UPDATER).certProcs.length, 1)
    assert.ok(probe(UPDATER).certProcs[0], 'ignoreSSL ⇒ setCertificateVerifyProc 必须被装上')
  })

  test('旧形态（host/port）经 proxy:apply 也能迁移并生效（不因新 IPC 丢掉迁移）', async () => {
    await invoke('proxy:apply', { enabled: true, host: '127.0.0.1', port: 7890 } as never)
    assert.deepEqual(probe(UPDATER).setProxyCalls, [
      { proxyRules: RULES_7890, proxyBypassRules: '' }
    ])
  })
})

describe('源码门禁（接线与"不再静默重置为直连"的形状）', () => {
  const src = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

  test('渲染进程：启动时 + 设置变化时推送代理（且经 plainProxyConfig）', () => {
    const main = src('src/renderer/src/main.ts')
    assert.match(
      main,
      /window\.api\s*\n?\s*\.applyProxy\(plainProxyConfig\(/,
      '必须经 plainProxyConfig 推送'
    )
    assert.match(main, /stateStore\.onSettingsChanged\(/, '设置变化时必须重新推送')
    assert.match(main, /^pushProxyToHost\(\)$/m, '启动时必须推送一次')
    assert.ok(
      !/applyProxy\(\s*stateStore\.getSetting/.test(main),
      '不得把响应式设置直接透传给 IPC（历史缺陷：An object could not be cloned.）'
    )
  })

  test('主进程：net.ts 注册 proxy:apply；两个调用点都不再裸传可能为 undefined 的 proxy', () => {
    const net = src('src/main/net.ts')
    assert.match(net, /ipcMain\.handle\('proxy:apply'/)
    assert.match(net, /applyProxy\(proxy\)/, 'applyProxy 必须真的被调用（此前是死代码）')
    assert.match(net, /proxy \?\? currentProxy\(\)/, 'net:fetch 未传代理时回落当前配置')

    const updater = src('src/main/updater.ts')
    assert.match(updater, /applyProxyToSession\(updaterSession\(\), cfg\)/)
    assert.match(updater, /const cfg = proxy \?\? currentProxy\(\)/)
    assert.equal(
      (updater.match(/applyUpdaterProxy\(\)/g) ?? []).length,
      2,
      'download 与 install 两处都必须补配置（不传代理 ⇒ 回落当前配置）'
    )
    // 「来源」按"参数有没有传"判定（不是按调用点写死），否则 resolve-feed/check 漏传时会被误标成"显式"
    assert.match(updater, /proxy === undefined \? 'current' : 'explicit'/)
    assert.ok(
      !/applyProxyToSession\(ses, (proxy|opts\.proxy)\)/.test(updater),
      '调用点不得再裸传可能为 undefined 的 proxy（那会把 session 静默重置成直连）'
    )
  })

  test('桥接面：preload 与 MainApi 都暴露 applyProxy', () => {
    assert.match(
      src('src/preload/index.ts'),
      /applyProxy: \(proxy\) => ipcRenderer\.invoke\('proxy:apply'/
    )
    assert.match(src('src/shared/types.ts'), /applyProxy\(proxy\?: ProxyConfig\): Promise<void>/)
  })

  test('关代理没有被堵死：applyProxyToSession 对 undefined 的语义未被改动', () => {
    const proxy = src('src/main/proxy.ts')
    assert.match(proxy, /const cfg = proxy \? normalizeProxyConfig\(proxy\) : undefined/)
    assert.match(proxy, /void ses\.setProxy\(\{ mode: 'direct' \}\)/)
    assert.match(proxy, /export function applyProxy\(/)
  })
})
