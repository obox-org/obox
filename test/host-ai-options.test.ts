/**
 * 卡 21 · host-ai-options：设置里新增内置页「AI」（OpenAI 兼容参数 + 掩码 + 测试连接）的门禁。
 *
 * 测什么（对应任务卡验收项）：
 * 1) **i18n**：中英键一一对应（新键两侧都要有）、`settings.tree.ai` 两侧都是「AI」；
 * 2) **归一策略**（从 `SettingsView.vue` 源码**原样提取真实实现**后直接跑，避免"测试里复制一份
 *    实现"的漂移——先例 `test/settings-progress-field.test.ts`）：`contextLen` 空/非法/0/负数/超大
 *    的落点，`dailyLimit` 的**空（=不限）与 0（=额度 0）之分**；
 * 3) **测试连接**：跑真实的 `src/main/ai.ts`，请求构造（baseUrl 有无尾斜杠、Authorization 头、
 *    GET、AbortSignal）与各错误分支的中文文案（缺 baseUrl / 401 / 403 / 404 / 5xx / 网络 / 超时）、
 *    **结果不回传 apiKey**；
 * 4) **走代理**：`vi.mock('electron')` 后跑真实的 `registerAiIpc()` + `proxy.ts`，证明测试连接在
 *    `netSession()` 上发请求（⇒ 继承「设置 → 网络」的代理；渲染进程自己 fetch 不经代理）；
 * 5) **掩码不泄漏**：默认渲染（`showApiKey === false`）的分支里**没有**密钥取值绑定，密钥不作
 *    文本插值；切换只改组件内 ref（不写设置、不落盘），密钥输入走 `@input` 逐键落库（切换/失焦
 *    不丢输入）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiConnectionResult } from '../src/shared/types'
import type { AiHttpResponse, AiTestDeps } from '../src/main/ai'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const settingsViewPath = join(
  repoRoot,
  'src',
  'renderer',
  'src',
  'extensions',
  'settings',
  'SettingsView.vue'
)

/** 原始源码（含注释）：提取真实实现用 */
function rawSettingsSource(): string {
  return readFileSync(settingsViewPath, 'utf8')
}

/** 去块注释 / HTML 注释 / 行注释后的源码：接线断言用（文档里的示例不得喂成假绿） */
function settingsSource(): string {
  return rawSettingsSource()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 折叠空白：prettier 会把长属性换行，"接线存在"的断言不该被换行喂成假红 */
function flatten(src: string): string {
  return src.replace(/\s+/g, ' ')
}

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

// ---------------------------------------------------------------- localStorage / stateStore

/**
 * localStorage 必须在 `core/state` 求值**之前**就位（快照在模块求值时读一次）；
 * 与 test/settings-progress-field.test.ts 同一做法。
 */
const storage: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage[k] ?? null,
  setItem: (k: string, v: string) => {
    storage[k] = v
  },
  removeItem: (k: string) => {
    delete storage[k]
  }
})

// ---------------------------------------------------------------- 假 Electron session（走代理的证据）

interface SessionProbe {
  setProxyCalls: Array<{ proxyRules?: string; proxyBypassRules?: string; mode?: string }>
  fetchCalls: Array<{ url: string; init?: unknown }>
  fetchImpl?: (url: string, init?: unknown) => Promise<Response>
}

const NET = 'obox-net'
const RULES_DEAD = 'http=127.0.0.1:9;https=127.0.0.1:9'

const mock = vi.hoisted(() => {
  class FakeSession {
    setProxyCalls: Array<{ proxyRules?: string; proxyBypassRules?: string; mode?: string }> = []
    certProcs: unknown[] = []
    closeAllCalls: number[] = []
    fetchCalls: Array<{ url: string; init?: unknown }> = []
    fetchImpl: ((url: string, init?: unknown) => Promise<Response>) | undefined
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
    async fetch(url: string, init?: unknown): Promise<Response> {
      this.fetchCalls.push({ url, init })
      if (!this.fetchImpl) throw new Error('假 session 未设置 fetchImpl')
      return this.fetchImpl(url, init)
    }
  }

  return {
    sessions: new Map<string, InstanceType<typeof FakeSession>>(),
    handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
    makeSession(partition: string): InstanceType<typeof FakeSession> {
      const ses = new FakeSession()
      this.sessions.set(partition, ses)
      return ses
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (e: unknown, ...args: unknown[]) => unknown): void => {
      mock.handlers.set(channel, handler)
    }
  },
  // 每个 partition 一个假 session，且同一用例内稳定返回同一对象（应用指纹去重靠对象身份）
  session: {
    fromPartition: (partition: string): unknown =>
      mock.sessions.get(partition) ?? mock.makeSession(partition)
  }
}))

const { AI_TEST_TIMEOUT_MS, modelsUrlOf, normalizeBaseUrl, registerAiIpc, testAiConnection } =
  await import('../src/main/ai')
const { applyProxy, applyProxyToSession, netSession, updaterSession } =
  await import('../src/main/proxy')
const { stateStore } = await import('../src/renderer/src/core/state')

registerAiIpc()

/** 假 session 的调用记录 */
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

beforeEach(() => {
  // 清掉模块级「当前配置」（作用在旧 session 上，随即被丢弃），否则上个用例的代理会漏进本用例
  applyProxyToSession(updaterSession(), undefined)
  applyProxyToSession(netSession(), undefined)
  mock.sessions.clear()
})

// ---------------------------------------------------------------- 提取 .vue 里的真实归一实现

/** 从 .vue 源码提取一段顶层声明（找不到即红：实现被挪走/改名时必须同步本门禁） */
function extractDecl(src: string, pattern: RegExp): string {
  const m = pattern.exec(src)
  expect(m, `SettingsView.vue 源码中未找到声明：${pattern}`).not.toBeNull()
  return m ? m[0] : ''
}

interface AiNormRuntime {
  DEFAULT_CONTEXT_LEN: number
  MAX_CONTEXT_LEN: number
  normalizeContextLen(raw: unknown): number
  normalizeDailyLimit(raw: unknown): number | null
}

/** 把 SettingsView.vue 里 AI 用到的**真实声明**原样提取、经 typescript 转译后装进一个环境 */
function loadAiNormRuntime(): AiNormRuntime {
  const src = rawSettingsSource()
  const decls = [
    extractDecl(src, /const DEFAULT_CONTEXT_LEN = \d+/),
    extractDecl(src, /const MAX_CONTEXT_LEN = [\d_]+/),
    extractDecl(src, /function normalizeContextLen\([\s\S]*?\n}/),
    extractDecl(src, /function normalizeDailyLimit\([\s\S]*?\n}/)
  ]
  const js = ts.transpileModule(decls.join('\n\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const factory = new Function(
    `${js}\nreturn { DEFAULT_CONTEXT_LEN, MAX_CONTEXT_LEN, normalizeContextLen, normalizeDailyLimit };`
  ) as () => AiNormRuntime
  return factory()
}

const aiNorm = loadAiNormRuntime()

// ---------------------------------------------------------------- 注入假 fetch 跑真实 main/ai.ts

interface FetchCall {
  url: string
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
}

/** 收集调用 + 按给定实现作答的假 fetch */
function collector(
  impl: (url: string, init: FetchCall['init']) => Promise<AiHttpResponse> | AiHttpResponse
): { calls: FetchCall[]; fetch: AiTestDeps['fetch'] } {
  const calls: FetchCall[] = []
  const fetch: AiTestDeps['fetch'] = async (url, init) => {
    calls.push({ url, init: init as FetchCall['init'] })
    return impl(url, init as FetchCall['init'])
  }
  return { calls, fetch }
}

/** OpenAI 风格响应 */
function modelsResponse(ids: string[], status = 200): Response {
  return new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** 默认依赖：不碰 session（本组用例只测请求构造与文案） */
function deps(
  fetchImpl: AiTestDeps['fetch'],
  extra: Partial<AiTestDeps> = {}
): Partial<AiTestDeps> {
  return { fetch: fetchImpl, prepare: () => {}, timeoutMs: 1000, ...extra }
}

const BASE = 'https://api.openai.com/v1'

// ================================================================ ① i18n

describe('① i18n：中英键一一对应 + AI 页文案齐备', () => {
  /** 收集所有叶子键（`a.b.c`；数组与字符串都是叶子） */
  function leafKeys(value: unknown, prefix = ''): string[] {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return prefix ? [prefix] : []
    }
    const out: string[] = []
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...leafKeys(v, key))
      else out.push(key)
    }
    return out
  }

  it('两份语言包的叶子键集合逐一对应（新键必须两侧都有，否则渲染出裸 key）', async () => {
    const zh = (await import('../src/renderer/src/i18n/locales/zh')).default as unknown as Record<
      string,
      unknown
    >
    const en = (await import('../src/renderer/src/i18n/locales/en')).default as unknown as Record<
      string,
      unknown
    >
    const zhKeys = leafKeys(zh).sort()
    const enKeys = leafKeys(en).sort()
    expect(zhKeys.filter((k) => !enKeys.includes(k))).toEqual([])
    expect(enKeys.filter((k) => !zhKeys.includes(k))).toEqual([])
  })

  it('settings.ai.* 的键在两侧都齐备（模板里用到的每一个都不能缺）', async () => {
    const zh = flatten(readRepo('src/renderer/src/i18n/locales/zh.ts'))
    const en = flatten(readRepo('src/renderer/src/i18n/locales/en.ts'))
    const keys = [
      'title',
      'intro',
      'baseUrl',
      'baseUrlPlaceholder',
      'baseUrlHint',
      'apiKey',
      'apiKeyEmpty',
      'apiKeyHint',
      'show',
      'hide',
      'model',
      'modelPlaceholder',
      'contextLen',
      'contextLenHint',
      'dailyLimit',
      'dailyLimitHint',
      'test',
      'testing',
      'testHint',
      'needBaseUrl',
      'invalidBaseUrl',
      'testFailed'
    ]
    for (const key of keys) {
      expect(zh, `zh 缺 settings.ai.${key}`).toContain(`${key}:`)
      expect(en, `en 缺 settings.ai.${key}`).toContain(`${key}:`)
    }
  })

  it('树节点文案两侧都是「AI」（中英一致，产品名不翻译）', async () => {
    const zh = (await import('../src/renderer/src/i18n/locales/zh')).default as {
      settings: { tree: Record<string, string> }
    }
    const en = (await import('../src/renderer/src/i18n/locales/en')).default as {
      settings: { tree: Record<string, string> }
    }
    expect(zh.settings.tree.ai).toBe('AI')
    expect(en.settings.tree.ai).toBe('AI')
  })

  it('模板里用到的 AI 文案键都能在语言包里找到（防拼错成裸 key）', () => {
    const src = settingsSource()
    const used = [...src.matchAll(/t\('settings\.(ai|tree)\.[\w.]+'/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(0)
    const zh = flatten(readRepo('src/renderer/src/i18n/locales/zh.ts'))
    for (const key of new Set(
      [...src.matchAll(/t\('(settings\.ai\.[\w.]+)'/g)].map((m) => m[1].replace('settings.ai.', ''))
    )) {
      expect(zh, `zh 缺 settings.ai.${key}`).toContain(`${key}:`)
    }
  })
})

// ================================================================ ② 归一策略

describe('② contextLen 归一（空/非法/0/负数/超大）', () => {
  const D = aiNorm.DEFAULT_CONTEXT_LEN

  it('空 / 全空白 / null / undefined ⇒ 默认 8192', () => {
    for (const raw of ['', '   ', null, undefined]) {
      expect(aiNorm.normalizeContextLen(raw), `raw=${String(raw)}`).toBe(8192)
    }
    expect(D).toBe(8192)
  })

  it('非数字 / NaN / ±Infinity ⇒ 默认 8192（绝不写进一个非数字值）', () => {
    for (const raw of ['abc', '8e', {}, [], NaN, Infinity, -Infinity]) {
      expect(aiNorm.normalizeContextLen(raw), `raw=${String(raw)}`).toBe(D)
    }
  })

  it('0 与负数 ⇒ 默认 8192（"1 token 上下文"没有意义，回落到可用默认）', () => {
    for (const raw of [0, '0', -5, '-100']) {
      expect(aiNorm.normalizeContextLen(raw), `raw=${String(raw)}`).toBe(D)
    }
  })

  it('合法值：字符串数字可用、小数向下取整、边界 1 保留', () => {
    expect(aiNorm.normalizeContextLen('8192')).toBe(8192)
    expect(aiNorm.normalizeContextLen(' 4096 ')).toBe(4096)
    expect(aiNorm.normalizeContextLen(1000.9)).toBe(1000)
    expect(aiNorm.normalizeContextLen(1)).toBe(1)
  })

  it('超大 ⇒ 钳到上限 1048576（不原样存荒谬值，也不静默丢弃）', () => {
    expect(aiNorm.MAX_CONTEXT_LEN).toBe(1_048_576)
    expect(aiNorm.normalizeContextLen(aiNorm.MAX_CONTEXT_LEN + 1)).toBe(aiNorm.MAX_CONTEXT_LEN)
    expect(aiNorm.normalizeContextLen(Number.MAX_SAFE_INTEGER)).toBe(aiNorm.MAX_CONTEXT_LEN)
  })
})

describe('② dailyLimit 归一（空 = 不限 vs 0 = 额度 0）', () => {
  it('空 / 全空白 / null / undefined ⇒ null（不限）', () => {
    for (const raw of ['', '   ', null, undefined]) {
      expect(aiNorm.normalizeDailyLimit(raw), `raw=${String(raw)}`).toBeNull()
    }
  })

  it('0 与 "0" ⇒ 0（**不是 null**：额度 0 与"不限"是两回事）', () => {
    expect(aiNorm.normalizeDailyLimit(0)).toBe(0)
    expect(aiNorm.normalizeDailyLimit('0')).toBe(0)
    // 区分钉死：两者不同值、不同类型
    expect(aiNorm.normalizeDailyLimit('')).not.toBe(aiNorm.normalizeDailyLimit('0'))
    expect(aiNorm.normalizeDailyLimit('')).toBeNull()
  })

  it('负数 / 非数字 / NaN / Infinity ⇒ null（归一到"不限"，不归一成 0：那会把误填变成"禁止使用"）', () => {
    for (const raw of ['-1', -100, 'abc', {}, NaN, Infinity, -Infinity]) {
      expect(aiNorm.normalizeDailyLimit(raw), `raw=${String(raw)}`).toBeNull()
    }
  })

  it('正整数可用、小数向下取整', () => {
    expect(aiNorm.normalizeDailyLimit(100)).toBe(100)
    expect(aiNorm.normalizeDailyLimit('100')).toBe(100)
    expect(aiNorm.normalizeDailyLimit(10.9)).toBe(10)
  })

  it('经真实 stateStore 落库：空 ⇒ 存 null 且不报错；0 ⇒ 存 0（读回来可区分）', () => {
    stateStore.setSetting('ai.dailyLimit', aiNorm.normalizeDailyLimit(''))
    expect(stateStore.getSetting('ai.dailyLimit')).toBeNull()
    stateStore.setSetting('ai.dailyLimit', aiNorm.normalizeDailyLimit('0'))
    expect(stateStore.getSetting('ai.dailyLimit')).toBe(0)
    // 键确实存在（不是被 undefined 删掉）：JSON 里 null 与 0 都在
    const raw = JSON.parse(storage['obox:state:v1']) as { settings: Record<string, unknown> }
    expect('ai.dailyLimit' in raw.settings).toBe(true)
    expect(raw.settings['ai.dailyLimit']).toBe(0)
  })

  it('经真实 stateStore 落库：contextLen 空 ⇒ 存默认 8192（数字，不是空）', () => {
    stateStore.setSetting('ai.contextLen', aiNorm.normalizeContextLen(''))
    expect(stateStore.getSetting('ai.contextLen')).toBe(8192)
  })
})

// ================================================================ ③ 测试连接：请求构造 + 中文文案

describe('③ 测试连接 · 请求构造', () => {
  it('baseUrl 有/无尾斜杠都拼成 `{base}/models`（含连续多个尾斜杠与首尾空白）', () => {
    expect(modelsUrlOf('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models')
    expect(modelsUrlOf('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/models')
    expect(modelsUrlOf('https://api.openai.com/v1///')).toBe('https://api.openai.com/v1/models')
    expect(modelsUrlOf(' https://api.openai.com ')).toBe('https://api.openai.com/models')
    expect(modelsUrlOf('https://api.openai.com')).toBe('https://api.openai.com/models')
  })

  it('两种 baseUrl 拼法发出去的实际 URL 一致（GET，无 body，带 AbortSignal）', async () => {
    for (const raw of [BASE, `${BASE}/`, `${BASE}//`]) {
      const { calls, fetch } = collector(() => modelsResponse(['gpt-4o-mini']))
      const r = await testAiConnection({ baseUrl: raw, apiKey: 'sk-1' }, deps(fetch))
      expect(r.ok, `baseUrl=${raw}`).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(`${BASE}/models`)
      expect(calls[0].init.method).toBe('GET')
      expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
      expect(calls[0].init).not.toHaveProperty('body')
    }
  })

  it('apiKey 非空 ⇒ `Authorization: Bearer <key>`（并 trim 首尾空白）', async () => {
    const { calls, fetch } = collector(() => modelsResponse([]))
    await testAiConnection({ baseUrl: BASE, apiKey: '  sk-abc  ' }, deps(fetch))
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-abc')
    expect(calls[0].init.headers.Accept).toBe('application/json')
  })

  it('apiKey 为空 / 全空白 ⇒ **不带** Authorization 头（本地端点常不需要密钥），仍发请求', async () => {
    for (const apiKey of ['', '   ', undefined]) {
      const { calls, fetch } = collector(() => modelsResponse(['m']))
      const r = await testAiConnection({ baseUrl: BASE, apiKey }, deps(fetch))
      expect(r.ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect('Authorization' in calls[0].init.headers).toBe(false)
    }
  })

  it('发请求前会重新应用「当前代理」（默认 prepare 的注入点被调用）', async () => {
    const { fetch } = collector(() => modelsResponse([]))
    const prepare = vi.fn()
    await testAiConnection({ baseUrl: BASE }, { fetch, prepare, timeoutMs: 1000 })
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('缺 baseUrl ⇒ **不发请求**，中文提示「请先填写 baseUrl」', async () => {
    for (const baseUrl of ['', '   ', undefined]) {
      const { calls, fetch } = collector(() => modelsResponse([]))
      const r = await testAiConnection({ baseUrl }, deps(fetch))
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('missing-base-url')
      expect(r.message).toBe('请先填写 baseUrl')
      expect(calls).toHaveLength(0)
    }
  })

  it('baseUrl 非 http(s) ⇒ **不发请求**，中文拒绝原因（含当前值）', async () => {
    for (const baseUrl of ['ftp://x/v1', 'api.openai.com/v1', 'ws://x', '//x/v1']) {
      const { calls, fetch } = collector(() => modelsResponse([]))
      const r = await testAiConnection({ baseUrl }, deps(fetch))
      expect(r.ok, `baseUrl=${baseUrl}`).toBe(false)
      expect(r.reason).toBe('invalid-base-url')
      expect(r.message).toContain('http://')
      expect(r.message).toContain('https://')
      expect(calls).toHaveLength(0)
    }
    // 可直接单测归一函数
    expect(normalizeBaseUrl('ftp://x').ok).toBe(false)
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toEqual({
      ok: true,
      base: 'https://api.openai.com/v1'
    })
  })
})

describe('③ 测试连接 · 成功路径', () => {
  it('200 + OpenAI 形状 ⇒ 「连接成功（N 个模型可用）」并列出前三个模型名', async () => {
    const { fetch } = collector(() => modelsResponse(['gpt-4o-mini', 'gpt-4o', 'o3', 'o4-mini']))
    const r = await testAiConnection({ baseUrl: BASE, apiKey: 'sk-x' }, deps(fetch))
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.modelCount).toBe(4)
    expect(r.models).toEqual(['gpt-4o-mini', 'gpt-4o', 'o3'])
    expect(r.message).toBe('连接成功（4 个模型可用），如：gpt-4o-mini、gpt-4o、o3')
  })

  it('200 但没有模型列表（非 JSON / 无 data 数组）⇒ 仍算连上，文案说明"未返回模型列表"', async () => {
    for (const body of ['hello', '{"ok":true}', '[]']) {
      const { fetch } = collector(
        () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })
      )
      const r = await testAiConnection({ baseUrl: BASE }, deps(fetch))
      expect(r.ok, `body=${body}`).toBe(true)
      expect(r.message).toContain('连接成功')
      expect(r.message).toContain('未返回模型列表')
    }
  })

  it('结果**绝不回传 apiKey**（UI 文案/日志都不会出现密钥）', async () => {
    const { fetch } = collector(() => modelsResponse(['m']))
    const r = await testAiConnection({ baseUrl: BASE, apiKey: 'sk-super-secret' }, deps(fetch))
    expect(JSON.stringify(r)).not.toContain('sk-super-secret')
  })

  it('200 里塞的错误对象 ⇒ 判失败（有些网关会 200 + error）', async () => {
    const { fetch } = collector(
      () =>
        new Response(JSON.stringify({ error: { message: 'model list disabled' } }), { status: 200 })
    )
    const r = await testAiConnection({ baseUrl: BASE }, deps(fetch))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bad-response')
    expect(r.message).toContain('端点返回错误')
    expect(r.message).toContain('model list disabled')
  })

  it('响应体过大（content-length 声明）⇒ 判失败，不把主进程撑爆', async () => {
    const { fetch } = collector(
      () =>
        new Response('{}', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } })
    )
    const r = await testAiConnection({ baseUrl: BASE }, deps(fetch))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bad-response')
    expect(r.message).toContain('响应体过大')
  })
})

describe('③ 测试连接 · 失败分支的中文文案', () => {
  it('401（有 key）⇒ 「密钥无效」+ 状态码', async () => {
    const { fetch } = collector(() => new Response('unauthorized', { status: 401 }))
    const r = await testAiConnection({ baseUrl: BASE, apiKey: 'sk-bad' }, deps(fetch))
    expect(r).toMatchObject({ ok: false, status: 401, reason: 'unauthorized' })
    expect(r.message).toContain('密钥无效')
    expect(r.message).toContain('401')
    expect(r.message).toContain('apiKey')
  })

  it('401（无 key）⇒ 提示该端点需要密钥（而不是"密钥无效"）', async () => {
    const { fetch } = collector(() => new Response('unauthorized', { status: 401 }))
    const r = await testAiConnection({ baseUrl: BASE, apiKey: '' }, deps(fetch))
    expect(r.reason).toBe('unauthorized')
    expect(r.message).toContain('端点要求密钥')
  })

  it('403 ⇒ 有 key 时「密钥无权限」；无 key 时说明也可能是网关/地区限制（不当成密钥问题）', async () => {
    const { fetch } = collector(() => new Response('forbidden', { status: 403 }))
    const withKey = await testAiConnection({ baseUrl: BASE, apiKey: 'sk-x' }, deps(fetch))
    expect(withKey).toMatchObject({ ok: false, status: 403, reason: 'forbidden' })
    expect(withKey.message).toContain('密钥无权限')

    // 实测：经可用的宿主代理访问 https://api.openai.com/v1/models 会被 Cloudflare 回 403，
    // 此时说"密钥无权限"是误导（我们根本没带密钥）
    const { fetch: fetch2 } = collector(() => new Response('forbidden', { status: 403 }))
    const noKey = await testAiConnection({ baseUrl: BASE, apiKey: '' }, deps(fetch2))
    expect(noKey.reason).toBe('forbidden')
    expect(noKey.message).toContain('端点拒绝访问')
    expect(noKey.message).not.toContain('密钥无权限')
  })

  it('404 ⇒ 「地址不对」并带上试过的 URL（提示 baseUrl 该长什么样）', async () => {
    const { fetch } = collector(() => new Response('not found', { status: 404 }))
    const r = await testAiConnection({ baseUrl: BASE }, deps(fetch))
    expect(r).toMatchObject({ ok: false, status: 404, reason: 'not-found' })
    expect(r.message).toContain('地址不对')
    expect(r.message).toContain(`${BASE}/models`)
    expect(r.message).toContain('https://api.openai.com/v1')
  })

  it('其它非 2xx（500）⇒ 「请求失败（HTTP 500 …）」', async () => {
    const { fetch } = collector(
      () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })
    )
    const r = await testAiConnection({ baseUrl: BASE }, deps(fetch))
    expect(r).toMatchObject({ ok: false, status: 500, reason: 'http-error' })
    expect(r.message).toContain('请求失败（HTTP 500')
    expect(r.message).toContain('Internal Server Error')
  })

  it('网络/代理错误 ⇒ 中文原因 + 原始 Chromium 错误名（代理问题的证据）+ 指向「设置 → 网络」', async () => {
    const { fetch } = collector(() => {
      throw new Error('net::ERR_PROXY_CONNECTION_FAILED')
    })
    const r = await testAiConnection({ baseUrl: BASE }, deps(fetch))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('network')
    expect(r.message).toContain('网络或代理错误')
    expect(r.message).toContain('net::ERR_PROXY_CONNECTION_FAILED')
    expect(r.message).toContain('设置 → 网络')
  })

  it('超时 ⇒ 「请求超时（10 秒）」；默认超时常量是 10 秒', async () => {
    expect(AI_TEST_TIMEOUT_MS).toBe(10_000)
    // fetch 直接以 AbortError 结束（等效于我们的 AbortController 触发），走默认超时 ⇒ 文案写 10 秒
    const { fetch } = collector(() => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    })
    const r = await testAiConnection({ baseUrl: BASE }, { fetch, prepare: () => {} })
    expect(r).toMatchObject({ ok: false, reason: 'timeout' })
    expect(r.message).toContain('请求超时（10 秒）')
    expect(r.message).toContain('设置 → 网络')
  })

  it('超时真的会被 AbortController 触发（注入 20ms 超时 + 挂住的请求）', async () => {
    const { fetch } = collector(
      (_url, init) =>
        new Promise<AiHttpResponse>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
    )
    const r = await testAiConnection({ baseUrl: BASE }, { fetch, prepare: () => {}, timeoutMs: 20 })
    expect(r).toMatchObject({ ok: false, reason: 'timeout' })
    expect(r.message).toContain('请求超时（20 毫秒）')
  })
})

// ================================================================ ④ 走代理（netSession）与桥接接线

describe('④ 测试连接在 netSession 上发 ⇒ 继承宿主代理', () => {
  it('IPC 处理器在 net session 上发请求（updater session 不参与）并返回中文结论', async () => {
    probe(NET).fetchImpl = async () => modelsResponse(['m1', 'm2'])
    const r = await invoke<AiConnectionResult>('ai:test-connection', {
      baseUrl: BASE,
      apiKey: 'sk-1'
    })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('连接成功（2 个模型可用）')
    expect(probe(NET).fetchCalls).toHaveLength(1)
    expect(probe(NET).fetchCalls[0].url).toBe(`${BASE}/models`)
    expect(probe('electron-updater').fetchCalls).toHaveLength(0)
  })

  it('把宿主代理设成打不通的地址 ⇒ 测试连接落在该代理规则上（这正是"按钮走了宿主代理"的证据）', async () => {
    // 模拟渲染进程经 proxy:apply 推送（applyProxy = 同一实现的模块级入口）
    applyProxy({ enabled: true, url: 'http://127.0.0.1:9', noProxy: [] })
    expect(probe(NET).setProxyCalls).toEqual([{ proxyRules: RULES_DEAD, proxyBypassRules: '' }])
    probe(NET).fetchImpl = async () => {
      throw new Error('net::ERR_PROXY_CONNECTION_FAILED')
    }
    const r = await invoke<AiConnectionResult>('ai:test-connection', { baseUrl: BASE })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('network')
    expect(r.message).toContain('net::ERR_PROXY_CONNECTION_FAILED')
    // 请求确实发在那个已配置代理的 session 上
    expect(probe(NET).fetchCalls).toHaveLength(1)
  })

  it('渲染进程那侧的 fetch **不经**宿主代理 ⇒ 测试连接不得用渲染进程 fetch（源码门禁）', () => {
    const view = settingsSource()
    expect(view).toContain('window.api.aiTestConnection(')
    // 不得出现裸 fetch(（渲染进程 CSP 也禁外网；且它走默认 session、不经我们的代理）
    expect(/\bfetch\s*\(/.test(view.replace(/window\.api\./g, ''))).toBe(false)

    const ai = readRepo('src/main/ai.ts')
    expect(ai).toContain("import { applyProxyToSession, currentProxy, netSession } from './proxy'")
    expect(ai).toContain('netSession().fetch(')
    expect(ai).toContain('applyProxyToSession(netSession(), currentProxy())')
    // 主进程也不得改用 Node 全局 fetch（不读代理、无法应用 per-session 证书策略）
    expect(ai).not.toContain('globalThis.fetch')
  })

  it('处理器把结论写进日志，但不含密钥；`ai:test-connection` 已注册', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      probe(NET).fetchImpl = async () => modelsResponse(['m'])
      const r = await invoke<AiConnectionResult>('ai:test-connection', {
        baseUrl: BASE,
        apiKey: 'sk-log-secret'
      })
      expect(r.ok).toBe(true)
      const logged = log.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logged).toContain('[ai] 测试连接成功')
      expect(logged).not.toContain('sk-log-secret')
    } finally {
      log.mockRestore()
    }
  })

  it('缺 baseUrl 时处理器同样不发请求（IPC 侧兜底，防绕过渲染层校验）', async () => {
    const r = await invoke<AiConnectionResult>('ai:test-connection', { baseUrl: '' })
    expect(r).toMatchObject({ ok: false, reason: 'missing-base-url' })
    expect(probe(NET).fetchCalls).toHaveLength(0)
  })

  it('主进程注册进 registerAiIpc 且被 index.ts 调用；preload/MainApi 都暴露该方法', () => {
    const index = readRepo('src/main/index.ts')
    expect(index).toContain("import { registerAiIpc } from './ai'")
    expect(index).toContain('registerAiIpc()')

    expect(readRepo('src/preload/index.ts')).toMatch(
      /aiTestConnection: \(req\) => ipcRenderer\.invoke\('ai:test-connection', req\)/
    )
    const types = readRepo('src/shared/types.ts')
    expect(types).toMatch(
      /aiTestConnection\(req: AiConnectionRequest\): Promise<AiConnectionResult>/
    )
    // 标注为宿主内部（不属扩展 API 面）——与卡 20 的 proxy:apply 同形
    expect(flatten(types)).toContain('不属扩展 API 面')
    // 结果类型里没有 apiKey 字段（不回传密钥）
    const resultIface = types.slice(
      types.indexOf('export interface AiConnectionResult {'),
      types.indexOf('\n}', types.indexOf('export interface AiConnectionResult {'))
    )
    expect(resultIface).not.toContain('apiKey')
  })
})

// ================================================================ ⑤ 掩码不泄漏 / 切换不写值

describe('⑤ apiKey 掩码专用控件', () => {
  /** 掩码态分支（`v-if="!showApiKey"` 到 `v-else` 之间） */
  function maskedBlock(src: string): string {
    const start = src.indexOf('v-if="!showApiKey"')
    if (start < 0) return ''
    const next = src.indexOf('v-else', start)
    return src.slice(start, next < 0 ? src.length : next)
  }

  /** 显示态分支（`v-else` 到「隐藏」按钮之后） */
  function revealedBlock(src: string): string {
    const start = src.indexOf('v-if="!showApiKey"')
    const elseAt = src.indexOf('v-else', start)
    if (elseAt < 0) return ''
    const end = src.indexOf('settings.ai.hide', elseAt)
    return src.slice(elseAt, end < 0 ? src.length : end)
  }

  it('默认是掩码态（showApiKey 初值 false），且掩码态只渲染固定圆点串', () => {
    const src = rawSettingsSource()
    expect(src).toContain('const showApiKey = ref(false)')
    expect(src).toMatch(/const MASKED_KEY = '••••••••'/)
    const masked = flatten(maskedBlock(src))
    expect(masked).not.toBe('')
    expect(masked).toContain('MASKED_KEY')
    // 固定 8 个点、与密钥长度无关（不泄漏长度）
    expect(masked).not.toContain('.length')
    expect(masked).not.toContain('repeat(')
  })

  it('掩码态**没有**密钥取值绑定（DOM 里根本没有明文，比 type=password 更硬）', () => {
    const src = rawSettingsSource()
    const masked = flatten(maskedBlock(src))
    expect(masked).not.toContain('aiTextOf(AI_KEYS.apiKey)')
    // 掩码态只暴露一个布尔量（配没配），不暴露内容
    expect(masked).toContain('hasApiKey()')
    // 明文输入框在显示态分支里（v-else）
    const revealed = flatten(revealedBlock(src))
    expect(revealed).toContain('aiTextOf(AI_KEYS.apiKey)')
    expect(revealed).toContain('type="text"')
  })

  it('密钥从不作为文本插值渲染（不会出现在可见文本里）', () => {
    const src = rawSettingsSource()
    expect(src).not.toMatch(/\{\{[^}]*aiTextOf\(AI_KEYS\.apiKey\)[^}]*\}\}/)
    expect(src).not.toMatch(/\{\{[^}]*aiStored\([^}]*\)[^}]*\}\}/)
    // 掩码行的文本插值只可能是圆点串或「未配置」
    const masked = flatten(maskedBlock(src))
    const interpolations = [...masked.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1].trim())
    expect(interpolations).toContain("hasApiKey() ? MASKED_KEY : t('settings.ai.apiKeyEmpty')")
  })

  it('掩码切换只改组件内 ref（不写设置、不落盘、不触发保存）', () => {
    const src = settingsSource()
    const clicks = [...src.matchAll(/@click="([^"]*)"/g)]
      .map((m) => m[1].trim())
      .filter((v) => v.includes('showApiKey'))
    expect(clicks).toEqual(['showApiKey = true', 'showApiKey = false'])
    // 没有任何"切换即保存"的通路
    expect(src).not.toContain('toggleApiKey')
    const toggleFns = [...src.matchAll(/function \w*[Aa]piKey\w*\([\s\S]*?\n}/g)].map((m) => m[0])
    for (const fn of toggleFns) {
      expect(fn).not.toContain('showApiKey')
    }
    // showApiKey 不是设置键（不落盘）
    expect(src).not.toContain("'ai.showApiKey'")
    expect(src).not.toContain("setSetting('ai.showApiKey'")
  })

  it('密钥输入走 @input 逐键落库（切换重建输入框 / 失焦都不可能丢输入）', () => {
    const src = settingsSource()
    const revealed = flatten(revealedBlock(src))
    expect(revealed).toContain('@input="onApiKeyInput"')
    expect(revealed).not.toContain('@change')
    const body = flatten(/function onApiKeyInput\([\s\S]*?\n}/.exec(src)?.[0] ?? '')
    expect(body).toContain('stateStore.setSetting(AI_KEYS.apiKey')
    expect(body).toContain('(e.target as HTMLInputElement).value')
  })

  it('页内明写「密钥以明文保存在本机配置中」', async () => {
    const zh = (await import('../src/renderer/src/i18n/locales/zh')).default as {
      settings: { ai: Record<string, string> }
    }
    const en = (await import('../src/renderer/src/i18n/locales/en')).default as {
      settings: { ai: Record<string, string> }
    }
    expect(zh.settings.ai.apiKeyHint).toContain('明文保存在本机配置中')
    expect(en.settings.ai.apiKeyHint).toContain('plain text')
  })
})

// ================================================================ ⑥ 左树与渲染接线 + 负向自检

describe('⑥ 左树节点与渲染接线', () => {
  it("TreeKey 含 'ai'，树节点绑定 @click，右侧有对应分支", () => {
    const src = settingsSource()
    expect(src).toMatch(/type TreeKey =[\s\S]*?'ai'[\s\S]*?\| 'extension'/)
    expect(src).toContain(':class="{ active: active === \'ai\' }" @click="active = \'ai\'"')
    expect(src).toContain('v-else-if="active === \'ai\'" class="config-block ai-block"')
    expect(src).toContain("t('settings.tree.ai')")
  })

  it('AI 节点位于「网络」之后、「通知」之前（与代理相邻，符合排查路径）', () => {
    const src = settingsSource()
    const tree = src.slice(src.indexOf('class="settings-tree"'), src.indexOf('</aside>'))
    const networkAt = tree.indexOf("active === 'network'")
    const aiAt = tree.indexOf("active === 'ai'")
    const notificationAt = tree.indexOf("active === 'notification'")
    expect(networkAt).toBeGreaterThan(-1)
    expect(aiAt).toBeGreaterThan(networkAt)
    expect(notificationAt).toBeGreaterThan(aiAt)
  })

  it('五个 AI 设置键都用 stateStore（前缀 ai.），且模板绑定到对应键', () => {
    const src = settingsSource()
    for (const key of ['baseUrl', 'apiKey', 'model', 'contextLen', 'dailyLimit']) {
      expect(src, `AI_KEYS 缺 ${key}`).toContain(`${key}: 'ai.${key}'`)
    }
    for (const key of ['baseUrl', 'model', 'contextLen', 'dailyLimit']) {
      expect(src, `模板未绑定 ${key}`).toContain(`AI_KEYS.${key}`)
    }
    // 落库一律经 stateStore.setSetting（不直写 localStorage）
    expect(src).toContain('stateStore.setSetting(AI_KEYS.')
    expect(src).not.toContain('localStorage.setItem')
  })

  it('「测试连接」：本地快速失败在 IPC 调用**之前**，且空 baseUrl 分支直接 return（不发请求）', () => {
    const body = flatten(
      /async function testAiConnection\(\)[\s\S]*?\n}/.exec(settingsSource())?.[0] ?? ''
    )
    expect(body).not.toBe('')
    const emptyCheck = body.indexOf('if (!baseUrl)')
    const schemeCheck = body.indexOf('https?:\\/\\/')
    const ipcCall = body.indexOf('window.api.aiTestConnection(')
    expect(emptyCheck).toBeGreaterThan(-1)
    expect(schemeCheck).toBeGreaterThan(-1)
    expect(ipcCall).toBeGreaterThan(-1)
    expect(emptyCheck).toBeLessThan(ipcCall)
    expect(schemeCheck).toBeLessThan(ipcCall)
    // 空 baseUrl 的分支里必须 return（否则会继续往下发请求）
    expect(body.slice(emptyCheck, schemeCheck)).toContain('return')
    // 文案键两侧都有（中文要求是「请先填写 baseUrl」）
    expect(body).toContain("t('settings.ai.needBaseUrl')")
    expect(body).toContain("t('settings.ai.invalidBaseUrl')")
  })

  it('按钮进 loading 态（testing 文案 + disabled），结果文案按成功/失败着色', () => {
    const src = settingsSource()
    expect(src).toContain("aiTestState === 'testing'")
    expect(src).toContain("t('settings.ai.testing')")
    expect(src).toContain(':disabled="aiTestState === \'testing\'"')
    expect(flatten(src)).toContain(":class=\"aiTestOk ? 'config-success' : 'config-error'\"")
    // IPC 异常兜底（老宿主没有该方法时不白屏）
    expect(src).toContain("t('settings.ai.testFailed'")
  })

  it('「每日限额」说明留空表示不限、且与 0 不同', async () => {
    const zh = (await import('../src/renderer/src/i18n/locales/zh')).default as {
      settings: { ai: Record<string, string> }
    }
    expect(zh.settings.ai.dailyLimitHint).toContain('留空表示不限')
    expect(zh.settings.ai.dailyLimitHint).toContain('0')
  })
})
