/**
 * 宿主「AI 选项」：**测试连接**（设置 → AI 的按钮；宿主内部 IPC `ai:test-connection`）。
 *
 * ## 为什么在主进程发请求
 * 与 `api.net.fetch`（`net.ts`）同一条路：**在 `netSession()`（`obox-net`）上发**。只有那个
 * session 上应用了用户配置的代理与「忽略 SSL」设置（`proxy.ts` 的 `applyProxyToSession`）。
 * 渲染进程自己 `fetch` 走默认 session、**不**经宿主代理——所以这个按钮的效果会随
 * 「设置 → 网络」里的代理变化，这正是用户要的"和别的联网能力同一条路"。
 *
 * ## 请求形状（最小）
 * `GET {baseUrl}/models` + `Authorization: Bearer <apiKey>`（key 为空则**不带**该头：不少
 * OpenAI 兼容的本地端点不要密钥）。带 10 秒超时（`AbortController`），失败**不抛错**，
 * 返回中文可执行原因（`AiConnectionResult`），且结果里**绝不回传 apiKey**。
 *
 * ## 为什么能单测（可注入）
 * `testAiConnection()` 的 `fetch` / `prepare` / `timeoutMs` 都可注入：默认实现打真实
 * `netSession()`，测试注入假响应即可覆盖 URL 拼接、请求头、超时与各错误分支，不需要 Electron
 * 运行时（先例：`test/updater-proxy.test.ts` 用 `vi.mock('electron')` 跑真实的 `net.ts`）。
 */
import { ipcMain } from 'electron'
import type { AiConnectionReason, AiConnectionRequest, AiConnectionResult } from '../shared/types'
import { applyProxyToSession, currentProxy, netSession } from './proxy'

/** 测试连接超时（毫秒）：端点不可达时按钮最多转 10 秒，不会一直挂住 */
export const AI_TEST_TIMEOUT_MS = 10_000

/** 响应体上限（与 `net.ts` 的 `MAX_BODY_BYTES` 同口径：防止超大响应撑爆主进程） */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 成功文案里最多列出几个模型名（其余用数量概括） */
const MAX_LISTED_MODELS = 3

/** 只用到 fetch 响应的这四个能力（便于测试注入假响应；真实 `Response` 结构上满足它） */
export interface AiHttpResponse {
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

/** 测试连接的可注入依赖（默认实现打真实 `netSession()`） */
export interface AiTestDeps {
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; signal: AbortSignal }
  ): Promise<AiHttpResponse>
  /** 发请求前把「当前代理」重新应用到 `netSession()`（不依赖渲染进程推送的时序） */
  prepare(): void
  /** 超时毫秒数（默认 `AI_TEST_TIMEOUT_MS`） */
  timeoutMs: number
}

/** 默认实现：在扩展联网专用的会话上发（⇒ 继承用户代理与忽略 SSL 设置） */
function defaultFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
): Promise<AiHttpResponse> {
  return netSession().fetch(url, init) as unknown as Promise<AiHttpResponse>
}

/**
 * 默认准备：把**当前生效的**代理配置重新应用到 `netSession()`。
 *
 * 语义与 `net.ts` 的 `proxy ?? currentProxy()` 一致：渲染进程在启动与改代理时都会经
 * `proxy:apply` 推送，但那是一条**异步且可能尚未到达**的路径；这里再兜一次，保证"按钮的效果
 * 取决于当前代理"这件事不依赖推送时序（`applyProxyToSession` 按配置指纹去重，重复调用无副作用）。
 */
function defaultPrepare(): void {
  applyProxyToSession(netSession(), currentProxy())
}

/**
 * 归一 `baseUrl`：
 * - 空 / 全空白 → `missing-base-url`（**不构造任何请求**，UI 侧也会先行早退）
 * - 非 `http(s)://` 开头 → `invalid-base-url`（拒绝，不猜协议）
 * - 能过 `new URL()` 且有主机名 → 去掉**一个或多个**尾斜杠后作为根（保留路径，如 `/v1`）
 */
export function normalizeBaseUrl(
  raw?: string
): { ok: true; base: string } | { ok: false; reason: AiConnectionReason; message: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) {
    return { ok: false, reason: 'missing-base-url', message: '请先填写 baseUrl' }
  }
  if (!/^https?:\/\//i.test(text)) {
    return {
      ok: false,
      reason: 'invalid-base-url',
      message: `baseUrl 必须以 http:// 或 https:// 开头（当前：「${text}」）`
    }
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return {
      ok: false,
      reason: 'invalid-base-url',
      message: `baseUrl 无法解析：「${text}」（形如 https://api.openai.com/v1）`
    }
  }
  if (!parsed.hostname) {
    return {
      ok: false,
      reason: 'invalid-base-url',
      message: `baseUrl 缺少主机名：「${text}」（形如 https://api.openai.com/v1）`
    }
  }
  return { ok: true, base: text.replace(/\/+$/, '') }
}

/** `{baseUrl}/models`（容忍有/无尾斜杠，含连续多个） */
export function modelsUrlOf(base: string): string {
  return `${(typeof base === 'string' ? base : '').trim().replace(/\/+$/, '')}/models`
}

/** 从响应体里取到的模型列表：`count` = 条目数，`ids` = 能认出来的模型名 */
interface ModelList {
  count: number
  ids: string[]
}

/**
 * 尽力从响应体里取 OpenAI 风格模型列表（`{object:'list', data:[{id:'gpt-4o-mini'}]}`）。
 * 返回 `undefined` ⇒ 不是"带 data 数组"的形状（调用方按"端点回答了但没给模型列表"处理）。
 */
function modelListOf(text: string): ModelList | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  const list = (data as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(list)) return undefined
  const ids = list
    .map((item) => {
      const id = (item as { id?: unknown } | null | undefined)?.id
      return typeof id === 'string' ? id : ''
    })
    .filter(Boolean)
  return { count: list.length, ids }
}

/** 200 里塞的错误对象（有些网关/反代会这么干）——取人类可读的一段 */
function errorDetailOf(text: string): string | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  const err = (data as { error?: unknown } | null | undefined)?.error
  if (err === undefined || err === null) return undefined
  if (typeof err === 'string') return err
  const message = (err as { message?: unknown }).message
  if (typeof message === 'string' && message) return message
  try {
    return JSON.stringify(err).slice(0, 200)
  } catch {
    return String(err)
  }
}

/** 超时文案里的人类可读时长（默认 10 秒 → 「10 秒」；测试注入的短值 → 「20 毫秒」） */
function durationLabel(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`
}

/**
 * 用一份 AI 配置发一次最小请求（`GET {baseUrl}/models`），返回中文结论。
 *
 * 分支与文案（`reason` 是稳定码，`message` 给人看）：
 * - 缺 / 非法 baseUrl → `missing-base-url` / `invalid-base-url`（**不发请求**）
 * - 401 → `unauthorized`（有 key：「密钥无效」；无 key：「端点要求密钥」）
 * - 403 → `forbidden`；404 → `not-found`（带上试的 URL，提示 baseUrl 该长什么样）
 * - 其余非 2xx → `http-error`（带状态码与 statusText）
 * - 2xx：带 `data` 数组 → 成功 + 「N 个模型可用」+ 前三个模型名；
 *   带 `error` 对象 → `bad-response`（端点返回错误）；都不是 → 成功但说明"未返回模型列表"
 * - 抛错：`AbortError`/`TimeoutError` → `timeout`；其余 → `network`（带原始错误名，
 *   Chromium 的代理错误形如 `net::ERR_PROXY_CONNECTION_FAILED`，正是排查代理的证据）
 */
export async function testAiConnection(
  req?: AiConnectionRequest,
  deps: Partial<AiTestDeps> = {}
): Promise<AiConnectionResult> {
  const base = normalizeBaseUrl(req?.baseUrl)
  if (!base.ok) return { ok: false, reason: base.reason, message: base.message }

  const url = modelsUrlOf(base.base)
  const apiKey = typeof req?.apiKey === 'string' ? req.apiKey.trim() : ''
  const headers: Record<string, string> = { Accept: 'application/json' }
  // key 为空 ⇒ 不带 Authorization（本地端点常不需要）；有 key ⇒ 标准 Bearer
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const timeoutMs = deps.timeoutMs ?? AI_TEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetcher = deps.fetch ?? defaultFetch
  const prepare = deps.prepare ?? defaultPrepare
  // 先把当前代理重新应用一次（默认实现；注入时由测试自己决定要不要碰 session）
  prepare()
  try {
    const res = await fetcher(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    })
    const status = res.status

    if (status === 401) {
      return {
        ok: false,
        status,
        reason: 'unauthorized',
        message: apiKey
          ? '密钥无效（HTTP 401）——请检查 apiKey 是否填对、是否已过期'
          : '端点要求密钥（HTTP 401）——请在 apiKey 里填写密钥（有些本地端点不需要，但该端点需要）'
      }
    }
    if (status === 403) {
      return {
        ok: false,
        status,
        reason: 'forbidden',
        // 与 401 同一口径：没填 key 时不能断言"密钥无权限"——403 也可能是网关/地区限制
        // （实测：经可用的宿主代理访问 https://api.openai.com/v1/models 会被 Cloudflare 回 403）
        message: apiKey
          ? '密钥无权限（HTTP 403）——请检查该密钥可访问的模型或组织权限'
          : '端点拒绝访问（HTTP 403）——该端点可能需要密钥（请在 apiKey 里填写），也可能被网关或地区限制拦截'
      }
    }
    if (status === 404) {
      return {
        ok: false,
        status,
        reason: 'not-found',
        message: `地址不对（HTTP 404）：${url} 不存在——请检查 baseUrl（OpenAI 兼容端点通常形如 https://api.openai.com/v1）`
      }
    }
    if (status < 200 || status >= 300) {
      const statusText = res.statusText ? ` ${res.statusText}` : ''
      return {
        ok: false,
        status,
        reason: 'http-error',
        message: `请求失败（HTTP ${status}${statusText}）`
      }
    }

    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_BODY_BYTES) {
      return {
        ok: false,
        status,
        reason: 'bad-response',
        message: `响应体过大（${declared} 字节，上限 ${MAX_BODY_BYTES}）`
      }
    }
    const text = await res.text()
    if (text.length > MAX_BODY_BYTES) {
      return {
        ok: false,
        status,
        reason: 'bad-response',
        message: `响应体过大（上限 ${MAX_BODY_BYTES} 字节）`
      }
    }

    const models = modelListOf(text)
    if (models) {
      const listed = models.ids.slice(0, MAX_LISTED_MODELS)
      const suffix = listed.length > 0 ? `，如：${listed.join('、')}` : ''
      return {
        ok: true,
        status,
        modelCount: models.count,
        models: listed,
        message: `连接成功（${models.count} 个模型可用）${suffix}`
      }
    }
    const detail = errorDetailOf(text)
    if (detail !== undefined) {
      return { ok: false, status, reason: 'bad-response', message: `端点返回错误：${detail}` }
    }
    return { ok: true, status, message: '连接成功（端点未返回模型列表）' }
  } catch (err) {
    const aborted =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    if (aborted) {
      return {
        ok: false,
        reason: 'timeout',
        message: `请求超时（${durationLabel(timeoutMs)}）——请检查网络，以及「设置 → 网络」里的代理是否可达`
      }
    }
    const detail = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      reason: 'network',
      message: `网络或代理错误：${detail}——请检查网络连接，以及「设置 → 网络」里的代理配置`
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 注册宿主内部 IPC `ai:test-connection`（**不在扩展 API 面内**：扩展那侧没有对应方法，
 * 与卡 20 的 `proxy:apply` 同形——只在 `MainApi` / preload 上，供内置设置页调用）。
 *
 * 日志里只记结论（成功/失败码 + 中文原因）：`message` 里不含 apiKey（见 `AiConnectionResult`）。
 */
export function registerAiIpc(): void {
  ipcMain.handle(
    'ai:test-connection',
    async (_e, req?: AiConnectionRequest): Promise<AiConnectionResult> => {
      const result = await testAiConnection(req)
      console.log(
        `[ai] 测试连接${result.ok ? '成功' : `失败（${result.reason ?? 'unknown'}）`}：${result.message}`
      )
      return result
    }
  )
}
