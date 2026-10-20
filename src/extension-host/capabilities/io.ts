/**
 * **IO 能力族**（EH-B1）：`fs.watch` / `fs.unwatch` / `net.fetch` / `env` / `clipboard`。
 *
 * 位置与分工：`apiFactory.ts` 只做装配，本文件是这几项能力的**实现**（ADR-0026 交付方式不变，
 * 仍是 `plugin(api)` 传参）。为什么要单独成文件：阶段 B 的 EH-B1…EH-B5 各自落一个能力族，
 * 五条线**文件不相交**才能并行（见 `docs/extension-host-migration.md` 的「并行组」G4）。
 *
 * ## 哪些能力留在宿主，哪些仍回 main
 *
 * ADR-0026 决策 3 定的边界，这里逐条落地：
 * - **留在宿主**（宿主有完整 Node）：`fs.watch`（Node `fs.watch`）、`net.fetch`（Node `http`/`https`
 *   + 代理隧道）、`env`（`process.platform` 等）——不经 main，少一跳。
 * - **仍回 main**（宿主进程没有 Electron API）：`clipboard`（Electron `clipboard` 只在 main/renderer
 *   可用）、以及 `net.fetch` 需要的**代理与忽略 SSL 设置**（唯一真相在 main 的 `currentProxy()`，
 *   由渲染侧经 `proxy:apply` 推入）。
 *
 * ## 宿主 → main 的通道（`HostMainBridge`）
 *
 * 宿主经 `process.parentPort` 就能发 `req` 信封，但 main 侧要有人**应答**——那是
 * `src/main/extensionHostStarter.ts` 的 `registerMethod()`（EH-B1 的 main 部分，已随本卡落地），
 * 由 `src/main/index.ts` 注册两条**宿主内部 RPC**：
 *
 * | method | 参数 | 返回 |
 * | --- | --- | --- |
 * | `host.proxyConfig` | 无 | `{ proxy?: ProxyConfig; ignoreSSL: boolean }` |
 * | `host.clipboard` | `{ action: 'read' }` / `{ action: 'write', text }` | `{ ok: true, text? }` / `{ ok: false, error }` |
 *
 * 这两条**不进扩展 API 面**（扩展看到的是 `api.net.fetch` / `api.clipboard`），所以
 * `docs/extension-api/**` 不需要为它们改一个字；它们只是宿主实现能力的**内部**手段。
 *
 * ## 降级（`hostMain` 未接线时）
 *
 * 单独可测：`ExtensionApiOptions.hostMain` 是可选的，缺省时
 * - `net.fetch` **不残废**：代理回落环境变量（`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` /
 *   `NODE_TLS_REJECT_UNAUTHORIZED`），并**只 warn 一次**（每次 fetch 都刷日志会把 `log` 信封刷爆）；
 * - `clipboard` **明确失败**：抛 `EH_INTERNAL` + 「剪贴板需要主进程 IPC」。刻意不用「阶段 B」文案
 *   （`CAPABILITY_NOT_MIGRATED_HINT`）——它不是"还没迁移"，而是"桥没接上"，两者的排查方向不同。
 *
 * ## 为什么 `net.fetch` 不用全局 `fetch`
 *
 * Node 22 的全局 `fetch`（undici）**不读代理环境变量、也没暴露 dispatcher**（仓库里没有 `undici`
 * 依赖，本卡不允许加依赖）。而本卡硬要求"必须继承宿主的代理与忽略 SSL 设置"，因此这里用
 * `node:http` / `node:https` 自己发请求：http 目标走代理的**绝对 URI** 形式，https 目标走
 * **CONNECT 隧道** + `tls.connect`（`rejectUnauthorized: !ignoreSSL`）。代价是要自己处理重定向、
 * 超时与响应体上限——这些逻辑本来也得按 `src/main/net.ts` 的既有语义实现一遍。
 */
import { watch } from 'node:fs'
import http from 'node:http'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http'
import https from 'node:https'
import path from 'node:path'
import tls from 'node:tls'
import { FRAME_LIMIT_BYTES, EhProtocolError } from '../../shared/extensionHostProtocol'
import { normalizeProxyConfig, type ProxyConfigInput } from '../../shared/proxyConfig'
import type { ProxyConfig } from '../../shared/types'
import type { ExtensionActivationApi } from '../../api/types'
import { toErrorMessage } from '../errors'
import type { HostLogger } from '../log'
import type { SafeRunner } from '../safety'
import { unrefTimer } from '../timers'

/* -------------------------------------------------------------------------------------------- */
/* 常量                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** 宿主 → main：读代理配置（宿主内部 RPC，不进扩展 API 面） */
export const PROXY_CONFIG_METHOD = 'host.proxyConfig'

/** 宿主 → main：剪贴板读写（宿主内部 RPC，不进扩展 API 面） */
export const CLIPBOARD_METHOD = 'host.clipboard'

/** `net.fetch` 的默认超时（与 `src/main/net.ts` 的 30s 一致） */
export const DEFAULT_NET_TIMEOUT_MS = 30_000

/** 响应体上限：与协议帧上限同一个数字（8MB），避免"请求成功但帧发不出去" */
export const DEFAULT_MAX_BODY_BYTES = FRAME_LIMIT_BYTES

/** 单扩展并发监听上限（每个 watch 占一个 OS 句柄；与 `src/main/fs.ts` 一致） */
export const MAX_WATCHERS_PER_EXT = 16

/** 重定向跟随上限（超过即失败，不无限跟） */
export const MAX_REDIRECTS = 5

/* -------------------------------------------------------------------------------------------- */
/* 宿主 → main 桥                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * 宿主 → main 的请求通道（生产实现 = 宿主运行时的 `RpcClient.request`）。
 *
 * 只暴露一个 `request`：宿主侧不需要知道信封细节，main 侧的注册/分发由
 * `extensionHostStarter.registerMethod()` 负责。`reject` 即 main 回 `err`（或链路断开）。
 */
export interface HostMainBridge {
  request(method: string, params?: unknown): Promise<unknown>
}

/* -------------------------------------------------------------------------------------------- */
/* 路径白名单（fs 全族共用）                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * 把扩展给的相对路径解析成**扩展 data 目录内**的绝对路径。
 *
 * 越界一律抛错（不钳制、不静默回落到根）：`..`、绝对路径、`C:` 盘符都拒绝。
 * 扩展与宿主同上下文、无沙箱（ADR-0015），`fs` 的作用域本来就只是「防手滑」而非安全边界，
 * 但「手滑写坏 userData 其它文件」是真实风险，所以这层校验必须硬。
 *
 * 为什么导出：`apiFactory` 的 `readFile`/`writeFile`/… 与这里的 `watch` 必须**同一套**白名单，
 * 抄两份迟早分叉（一处放行 `..` 就是漏洞）。
 */
export function resolveInsideDataDir(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new Error('路径不能为空')
  }
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`只允许扩展 data 目录内的相对路径，收到绝对路径：${rel}`)
  }
  const absolute = path.resolve(root, rel)
  const relative = path.relative(root, absolute)
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`路径越出扩展 data 目录：${rel}`)
  }
  return absolute
}

/* -------------------------------------------------------------------------------------------- */
/* 代理配置                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** 代理与忽略 SSL 的合成结果（宿主内部形态，不是给扩展看的 `ProxyConfig`） */
export interface ProxySettings {
  /** 归一化后的代理配置；`undefined` = 没有配置（直连） */
  proxy?: ProxyConfig
  /** 是否放行所有证书（等价于 main 的 `setCertificateVerifyProc(0)`） */
  ignoreSSL: boolean
}

/** 宿主能拿到的环境变量表（单测注入；生产用 `process.env`） */
export type ProcessEnvLike = Record<string, string | undefined>

/**
 * 从**环境变量**推导代理配置（`hostMain` 未接线或读失败时的降级路径）。
 *
 * 与 main 的差异必须写清：环境变量**不是** obox 的"设置-网络"（那是 `stateStore` 的
 * `network.proxy`）。因此这条路径只是在桥没接上时不至于完全失去代理能力，值的优先级
 * `HTTPS_PROXY` > `HTTP_PROXY` > `ALL_PROXY`（大小写两种写法都认，Windows 上常见大写）。
 */
export function proxySettingsFromEnv(env: ProcessEnvLike): ProxySettings {
  const read = (name: string): string => {
    const upper = env[name.toUpperCase()]
    const lower = env[name.toLowerCase()]
    const value = upper ?? lower
    return typeof value === 'string' ? value.trim() : ''
  }
  const url = read('HTTPS_PROXY') || read('HTTP_PROXY') || read('ALL_PROXY')
  const noProxy = read('NO_PROXY')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  const ignoreSSL = read('NODE_TLS_REJECT_UNAUTHORIZED') === '0'
  if (url === '') return { ignoreSSL }
  return {
    proxy: normalizeProxyConfig({ enabled: true, url, noProxy, ignoreSSL }),
    ignoreSSL
  }
}

/**
 * 把 main 回的载荷归一化。允许三种形状（main 只发第一种，其余是容忍旧/简形态）：
 * 1. `{ proxy?: ProxyConfig, ignoreSSL?: boolean }`
 * 2. 裸 `ProxyConfig`（没有 `proxy` 包装）
 * 3. `null` / `undefined`（没配置）
 */
export function normalizeProxySettings(raw: unknown): ProxySettings {
  if (typeof raw !== 'object' || raw === null) return { ignoreSSL: false }
  const record = raw as { proxy?: unknown; ignoreSSL?: unknown; url?: unknown; host?: unknown }
  const wrapped = 'proxy' in record || 'ignoreSSL' in record
  const candidate = wrapped ? record.proxy : raw
  if (candidate === undefined || candidate === null) {
    return { ignoreSSL: record.ignoreSSL === true }
  }
  if (typeof candidate !== 'object') return { ignoreSSL: record.ignoreSSL === true }
  const normalized = normalizeProxyConfig(candidate as ProxyConfigInput)
  return {
    proxy: normalized,
    ignoreSSL: record.ignoreSSL === true || normalized.ignoreSSL === true
  }
}

/** 拆 `host[:port]`（支持 `[::1]:8080`）；没有端口时第二项为 `undefined` */
function splitHostPort(value: string): [string, string | undefined] {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end < 0) return [value, undefined]
    const host = value.slice(0, end + 1)
    const rest = value.slice(end + 1)
    return [host, rest.startsWith(':') ? rest.slice(1) : undefined]
  }
  const index = value.lastIndexOf(':')
  // 多于一个冒号且不带方括号 ⇒ 是裸 IPv6 字面量，整体当主机名
  if (index > 0 && value.indexOf(':') === index) {
    return [value.slice(0, index), value.slice(index + 1)]
  }
  return [value, undefined]
}

/**
 * `noProxy` 是否命中该目标。
 *
 * 支持（与浏览器习惯一致的子集）：`*`、`example.com`、`.example.com`（含子域）、
 * `*.example.com`、`example.com:8080`。**不支持 CIDR**（`10.0.0.0/8`）——宿主侧手写 CIDR 匹配
 * 容易出错，而写成 16 进制前缀也没人用；真需要时用域名规则。
 */
export function matchesNoProxy(
  hostname: string,
  port: string | undefined,
  rules: readonly string[]
): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of rules) {
    const rule = raw.trim().toLowerCase()
    if (rule === '') continue
    if (rule === '*') return true
    // 规则里写了协议前缀也认（`http://example.com`）
    const bare = rule.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    const [ruleHost, rulePort] = splitHostPort(bare)
    if (rulePort !== undefined && rulePort !== (port ?? '')) continue
    const normalized = ruleHost.replace(/^\[|\]$/g, '')
    if (normalized === '*') return true
    if (normalized.startsWith('*.')) {
      if (host.endsWith(normalized.slice(1))) return true
      continue
    }
    if (normalized.startsWith('.')) {
      if (host === normalized.slice(1) || host.endsWith(normalized)) return true
      continue
    }
    if (host === normalized) return true
  }
  return false
}

/** `pickProxy` 的结果：直连 / 走代理 / 配置非法（要给扩展一个 `{ok:false}`） */
export interface ProxyDecision {
  proxyUrl?: string
  error?: string
}

/**
 * 决定这一跳要不要走代理。
 *
 * 三种"不走代理"要分清：没配置、设置里关掉了（`enabled !== true`）、`noProxy` 命中——
 * 都不算错误，直接直连。而**配置了但不支持**（socks）或 URL 非法要回错误：
 * 静默直连等于把流量从用户要求的代理里漏出去（同 `src/main/proxy.ts` 文件头的判断）。
 */
export function pickProxy(proxy: ProxyConfig | undefined, target: URL): ProxyDecision {
  if (!proxy || proxy.enabled !== true) return {}
  const raw = typeof proxy.url === 'string' ? proxy.url.trim() : ''
  if (raw === '') return {}
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { error: `代理地址非法（${raw}）：请在设置-网络里填写形如 http://host:port 的地址` }
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    return {
      error: `宿主进程暂不支持 ${scheme} 代理：本卡只实现 http/https 代理，请在设置-网络里改用 http 代理`
    }
  }
  if (matchesNoProxy(target.hostname, target.port, proxy.noProxy ?? [])) return {}
  return { proxyUrl: parsed.href }
}

/* -------------------------------------------------------------------------------------------- */
/* HTTP 传输（单跳；重定向/JSON/上限由 net.fetch 组装）                                             */
/* -------------------------------------------------------------------------------------------- */

/** 一次单跳请求的参数（**不含重定向**：跟随由调用方做，便于单测编排） */
export interface TransportRequest {
  /** 完整 URL（http/https） */
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  /** 走代理时的代理 URL；缺省 = 直连 */
  proxyUrl?: string
  /** 放行所有证书（`rejectUnauthorized: false`） */
  ignoreSSL: boolean
  /** 本次单跳的超时（毫秒；调用方按总 deadline 递减） */
  timeoutMs: number
  /** 响应体上限（字节） */
  maxBodyBytes: number
}

/** 一次单跳的结果（响应体已完整读进内存；超上限会抛 `ResponseTooLargeError`） */
export interface TransportResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: Buffer
}

/** HTTP 传输（可注入：单测用假件断言代理/忽略 SSL 的接线，不真连外网） */
export type HttpTransport = (request: TransportRequest) => Promise<TransportResponse>

/** 响应体超过上限（带上 status，好让 `net.fetch` 照 main 的语义回 `{ok:false, status}`） */
export class ResponseTooLargeError extends Error {
  readonly status: number
  readonly statusText: string

  constructor(status: number, statusText: string, message: string) {
    super(message)
    this.name = 'ResponseTooLargeError'
    this.status = status
    this.statusText = statusText
  }
}

/** 大小写不敏感地判断是否已有某个头 */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === target)
}

/** 取头（大小写不敏感；没有则空串） */
function headerOf(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value
  }
  return ''
}

/** node 的 errno 错误带上 `code` 更好排查（`ECONNREFUSED` / `ENOTFOUND`） */
function describeTransportError(error: unknown): string {
  const message = toErrorMessage(error)
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code !== '' && !message.includes(code)) {
    return `${message}（${code}）`
  }
  return message
}

/** 把 `IncomingHttpHeaders` 收成 `Record<string, string>`（数组头用 `, ` 连接） */
function collectHeaders(source: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

/** 解析代理 URL 里的 `user:pass`（Chromium 用 login 事件，这里只能进 `Proxy-Authorization`） */
function proxyAuthorizationOf(proxy: URL): string | undefined {
  if (proxy.username === '' && proxy.password === '') return undefined
  let user = proxy.username
  let pass = proxy.password
  try {
    user = decodeURIComponent(proxy.username)
    pass = decodeURIComponent(proxy.password)
  } catch {
    // 百分号编码非法就按原样用（不让一个坏 URL 把请求整个废掉）
  }
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
}

/** 代理端口（协议缺省） */
function portOf(url: URL, fallback: number): number {
  if (url.port === '') return fallback
  const parsed = Number(url.port)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * 出站请求选项：`node:http` 的 `RequestOptions` + https 的证书开关。
 * `rejectUnauthorized` 在 http 请求里会被 node 忽略（不报错），所以两条路径共用一组选项。
 */
type OutgoingRequestOptions = RequestOptions & { rejectUnauthorized?: boolean }

/**
 * 生产传输：`node:http` / `node:https`，支持 http(s) 代理（http 目标走绝对 URI，https 目标走
 * CONNECT 隧道）与"忽略 SSL"。
 *
 * 只做**一跳**：不跟随重定向（`Location` 原样交给调用方）、不解析 JSON、不做业务错误文案——
 * 那些属于 `net.fetch` 的语义层，放在这里会让「重定向跟随」与「上限」两件事都没法单测。
 */
export const nodeHttpTransport: HttpTransport = (request) => {
  return new Promise<TransportResponse>((resolve, reject) => {
    let target: URL
    try {
      target = new URL(request.url)
    } catch {
      reject(new Error(`URL 非法：${request.url}`))
      return
    }

    const targetHttps = target.protocol === 'https:'
    const targetPort = portOf(target, targetHttps ? 443 : 80)
    const requestPath = `${target.pathname}${target.search}`
    const origins: Array<{ destroy: (error?: Error) => void }> = []
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const succeed = (value: TransportResponse): void => {
      if (settled) return
      settled = true
      clearTimer()
      resolve(value)
    }

    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      clearTimer()
      for (const origin of origins) {
        try {
          origin.destroy()
        } catch {
          // 已经关了：忽略
        }
      }
      reject(error instanceof Error ? error : new Error(toErrorMessage(error)))
    }

    /** 总超时：一次单跳（含 CONNECT 建链）共用这个预算 */
    timer = setTimeout(() => {
      fail(new Error(`请求超时（${Math.max(1, Math.round(request.timeoutMs / 1000))}s）`))
    }, request.timeoutMs)
    unrefTimer(timer)

    /** 出站头：补 `Host` / `Content-Length`，并压住压缩（不请求就不会有 gzip 要解） */
    const outgoingHeaders: Record<string, string> = { ...request.headers }
    if (!hasHeader(outgoingHeaders, 'host')) outgoingHeaders.Host = target.host
    if (request.body !== undefined && !hasHeader(outgoingHeaders, 'content-length')) {
      // 显式给 Content-Length：否则 node 用 chunked，部分代理/服务端处理起来更别扭
      outgoingHeaders['Content-Length'] = String(Buffer.byteLength(request.body, 'utf8'))
    }
    if (!hasHeader(outgoingHeaders, 'accept-encoding'))
      outgoingHeaders['Accept-Encoding'] = 'identity'

    const handleResponse = (response: IncomingMessage): void => {
      const status = response.statusCode ?? 0
      const statusText = response.statusMessage ?? ''
      const headers = collectHeaders(response.headers)
      const tooLarge = (declared: number): void => {
        response.destroy()
        fail(
          new ResponseTooLargeError(
            status,
            statusText,
            `响应体过大（${declared} 字节，上限 ${request.maxBodyBytes} 字节）`
          )
        )
      }

      const declared = Number(headerOf(headers, 'content-length'))
      if (Number.isFinite(declared) && declared > request.maxBodyBytes) {
        tooLarge(declared)
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        total += chunk.length
        if (total > request.maxBodyBytes) {
          // 声明里没有（chunked / 撒谎的 CL）：边读边数，超了立刻断
          response.destroy()
          fail(
            new ResponseTooLargeError(
              status,
              statusText,
              `响应体过大（上限 ${request.maxBodyBytes} 字节）`
            )
          )
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        succeed({ status, statusText, headers, body: Buffer.concat(chunks) })
      })
      response.on('error', (error) => {
        fail(error)
      })
    }

    /** 真正发请求（直连 / 代理两种形态）。`secure` 决定 `node:https` 还是 `node:http` */
    const send = (secure: boolean, options: OutgoingRequestOptions): void => {
      try {
        const req: ClientRequest = secure
          ? https.request(options, handleResponse)
          : http.request(options, handleResponse)
        origins.push(req)
        req.on('error', (error) => {
          fail(error)
        })
        if (request.body !== undefined) req.write(request.body)
        req.end()
      } catch (error) {
        fail(error)
      }
    }

    let proxy: URL | null = null
    if (request.proxyUrl !== undefined && request.proxyUrl !== '') {
      try {
        proxy = new URL(request.proxyUrl)
      } catch {
        fail(new Error(`代理地址非法：${request.proxyUrl}`))
        return
      }
      if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
        fail(new Error(`不支持的代理协议：${proxy.protocol.replace(/:$/, '')}`))
        return
      }
    }

    // 1) 直连
    if (proxy === null) {
      send(targetHttps, {
        method: request.method,
        hostname: target.hostname,
        port: targetPort,
        path: requestPath === '' ? '/' : requestPath,
        headers: outgoingHeaders,
        agent: false,
        rejectUnauthorized: request.ignoreSSL !== true
      })
      return
    }

    const proxySecure = proxy.protocol === 'https:'
    const proxyAuth = proxyAuthorizationOf(proxy)

    // 2) http 目标经代理：**绝对 URI** 形式（CONNECT 用在 80 端口会被多数代理拒绝）
    if (!targetHttps) {
      send(proxySecure, {
        method: request.method,
        hostname: proxy.hostname,
        port: portOf(proxy, proxySecure ? 443 : 80),
        // 直接给完整 URL（去掉 hash：它不该进请求行）
        path: `${target.protocol}//${target.host}${requestPath === '' ? '/' : requestPath}`,
        headers: {
          ...outgoingHeaders,
          ...(proxyAuth === undefined ? {} : { 'Proxy-Authorization': proxyAuth })
        },
        agent: false,
        rejectUnauthorized: request.ignoreSSL !== true
      })
      return
    }

    // 3) https 目标经代理：CONNECT 隧道 + 在隧道上做 TLS
    const connectOptions: OutgoingRequestOptions = {
      method: 'CONNECT',
      hostname: proxy.hostname,
      port: portOf(proxy, proxySecure ? 443 : 80),
      path: `${target.hostname}:${targetPort}`,
      headers: {
        Host: `${target.hostname}:${targetPort}`,
        ...(proxyAuth === undefined ? {} : { 'Proxy-Authorization': proxyAuth })
      },
      agent: false,
      rejectUnauthorized: request.ignoreSSL !== true
    }

    try {
      const connectRequest: ClientRequest = proxySecure
        ? https.request(connectOptions)
        : http.request(connectOptions)
      origins.push(connectRequest)
      connectRequest.on('error', (error) => {
        fail(error)
      })
      connectRequest.on('connect', (response, socket) => {
        if (settled) {
          socket.destroy()
          return
        }
        if ((response.statusCode ?? 0) !== 200) {
          socket.destroy()
          fail(new Error(`代理 CONNECT 失败（HTTP ${response.statusCode ?? 0}）`))
          return
        }
        const secured = tls.connect({
          socket,
          servername: target.hostname,
          rejectUnauthorized: request.ignoreSSL !== true
        })
        origins.push(secured)
        secured.on('error', (error) => {
          fail(error)
        })
        try {
          const req = https.request(
            {
              method: request.method,
              path: requestPath === '' ? '/' : requestPath,
              headers: outgoingHeaders,
              // ⚠️ 这里**不能**传 `agent`（连 `agent: false` 都不行）：传了之后 node 会新建一个
              // 默认 Agent 并**忽略** `createConnection`，于是它去连默认的 `localhost:443`
              // （实测报 `AggregateError（ECONNREFUSED）`）。"不传 agent + 提供 createConnection"
              // 才是 node 认可的「就用这条隧道的 socket」写法（`_http_client` 里只有这一条分支调它）。
              createConnection: () => secured
            },
            handleResponse
          )
          origins.push(req)
          req.on('error', (error) => {
            fail(error)
          })
          if (request.body !== undefined) req.write(request.body)
          req.end()
        } catch (error) {
          fail(error)
        }
      })
      connectRequest.end()
    } catch (error) {
      fail(error)
    }
  })
}

/* -------------------------------------------------------------------------------------------- */
/* fs.watch 后端                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** 一个监听句柄（`close()` 必须幂等：dispose 与 unwatch 可能都调） */
export interface WatchHandle {
  close(): void
}

/** 后端回调：`relPath` 相对被监听目录，分隔符统一成 `/` */
export interface WatchBackendOptions {
  onChange(relPath: string): void
  onError(error: unknown): void
}

/** `fs.watch` 的可注入后端（生产 = Node `fs.watch`；单测 = 可编排的假件） */
export interface WatchBackend {
  start(dir: string, options: WatchBackendOptions): WatchHandle
}

/**
 * 生产后端：Node `fs.watch(dir, { recursive: true })`。
 *
 * 三个坑：
 * 1. `recursive` 在 Linux 上要 Node ≥20.13（Electron 44 的 Node 22 满足）；不满足时 `watch` 会抛
 *    `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`，被上层包成「监听失败」而不是崩宿主。
 * 2. `filename` 在不同平台可能是相对路径也可能是绝对路径，两者都归一成"相对被监听目录"。
 * 3. **必须**接 `error` 事件：目录被删 / 权限变化会发 `error`，没人听就是 `uncaughtException`
 *    ——那会带走整个宿主（一个扩展删了自己的目录，全部扩展一起挂）。
 */
export const nodeWatchBackend: WatchBackend = {
  start(dir: string, options: WatchBackendOptions): WatchHandle {
    const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
      if (filename === null) return
      const raw = filename.toString()
      const relPath = (path.isAbsolute(raw) ? path.relative(dir, raw) : raw)
        .split(path.sep)
        .join('/')
      options.onChange(relPath)
    })
    watcher.on('error', (error) => {
      options.onError(error)
    })
    return {
      close(): void {
        watcher.close()
      }
    }
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 工厂                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** `createIoCapabilities` 的参数（全部由宿主注入，本函数是纯装配） */
export interface IoCapabilitiesOptions {
  /** 扩展 id（日志归属 + 隔离执行壳的 key） */
  extId: string
  /** 扩展自己的 data 目录绝对路径（`fs` 的根） */
  extensionDataDir: string
  /** 应用信息（`env.getOboxVersion`） */
  appInfo: { name: string; version: string }
  /** 当前 UI 语言（`env.language`） */
  locale: string
  /** 宿主日志 */
  log: HostLogger
  /** 隔离执行壳（watch 回调经它跑：回调抛错只上报，不杀宿主） */
  runSafely: SafeRunner
  /** 宿主 → main 通道（缺省 = 未接线：`net.fetch` 回落 env，`clipboard` 明确失败） */
  hostMain?: HostMainBridge
  /** 环境变量表（缺省 `process.env`；单测注入） */
  processEnv?: ProcessEnvLike
  /** HTTP 传输（缺省 `nodeHttpTransport`；单测注入假件） */
  transport?: HttpTransport
  /** `fs.watch` 后端（缺省 `nodeWatchBackend`；单测注入假件） */
  watchBackend?: WatchBackend
  /** `net.fetch` 超时（毫秒，缺省 30s） */
  netTimeoutMs?: number
  /** `net.fetch` 响应体上限（字节，缺省 `FRAME_LIMIT_BYTES` = 8MB） */
  maxBodyBytes?: number
}

/** 一项 `net.fetch` 的返回（与 `src/api/types.ts` 的声明逐字一致） */
export type NetFetchResult = Awaited<ReturnType<ExtensionActivationApi['net']['fetch']>>

/** IO 能力族 */
export interface IoCapabilities {
  /** `api.env`（声明里的 5 个成员全量） */
  readonly env: ExtensionActivationApi['env']
  /** `api.net` */
  readonly net: ExtensionActivationApi['net']
  /** `api.clipboard` */
  readonly clipboard: ExtensionActivationApi['clipboard']
  /** `api.fs.watch` / `api.fs.unwatch`（读写仍在 `apiFactory`，共用本文件的白名单） */
  readonly fsWatch: {
    watch(
      watchId: string,
      dir: string,
      callback: (event: { relPath: string }) => void
    ): Promise<void>
    unwatch(watchId: string): Promise<void>
    /** 当前活跃监听数（诊断/测试；dispose 后必为 0） */
    count(): number
  }
  /** 关闭全部监听（扩展停用/宿主退出时调用；幂等） */
  dispose(): void
}

/** 一个活跃监听 */
interface WatchEntry {
  readonly watchId: string
  readonly dir: string
  readonly handle: WatchHandle
}

/**
 * 按扩展构造 IO 能力族。
 *
 * 错误边界（贯穿全文件）：
 * - **配置/参数错误**（路径越界、watchId 空、url 非法、监听超限）→ 抛 `Error` / 回 `{ok:false}`，
 *   不要重试也不要静默降级；
 * - **扩展回调抛错**（watch 的 callback）→ 交 `runSafely` 上报 + 落日志，**绝不**升级成宿主级异常；
 * - **main 不可用**（`hostMain` 没接、RPC 超时）→ 不阻塞能力本身：`net.fetch` 降级、`clipboard` 报明确错。
 */
export function createIoCapabilities(options: IoCapabilitiesOptions): IoCapabilities {
  const extId = options.extId
  const root = path.resolve(options.extensionDataDir)
  const transport = options.transport ?? nodeHttpTransport
  const watchBackend = options.watchBackend ?? nodeWatchBackend
  const netTimeoutMs = options.netTimeoutMs ?? DEFAULT_NET_TIMEOUT_MS
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  const watchers = new Map<string, WatchEntry>()
  let disposed = false
  let warnedProxyFallback = false

  /* ------------------------------------- env（全量 5 项） ------------------------------------ */

  const env: ExtensionActivationApi['env'] = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    language: options.locale,
    async getOboxVersion(): Promise<string> {
      return options.appInfo.version
    }
  }

  /* -------------------------------------- 代理来源 -------------------------------------- */

  /**
   * 取当前代理与忽略 SSL 设置。
   *
   * 优先级（本卡口径）：`host.proxyConfig` → 失败或未接线时回落环境变量。
   * **永不抛错**：`net.fetch` 的语义是"请求失败回 `{ok:false}`"，不该因为读代理配置失败而
   * 让整个调用抛出去（那不区分"代理没读到"与"调用方参数错了"）。
   */
  const resolveProxySettings = async (): Promise<ProxySettings> => {
    if (options.hostMain !== undefined) {
      try {
        const raw = await options.hostMain.request(PROXY_CONFIG_METHOD, null)
        return normalizeProxySettings(raw)
      } catch (error) {
        if (!warnedProxyFallback) {
          warnedProxyFallback = true
          options.log(
            'warn',
            `[${extId}] 读取宿主代理配置失败，已回落环境变量（HTTPS_PROXY/HTTP_PROXY/NO_PROXY）`,
            toErrorMessage(error)
          )
        }
      }
    } else if (!warnedProxyFallback) {
      warnedProxyFallback = true
      options.log(
        'warn',
        `[${extId}] 未接入 host→main 通道：net.fetch 的代理只读环境变量（HTTPS_PROXY/HTTP_PROXY/NO_PROXY），` +
          '剪贴板不可用'
      )
    }
    return proxySettingsFromEnv(options.processEnv ?? process.env)
  }

  /* -------------------------------------- net.fetch -------------------------------------- */

  const isRedirect = (status: number): boolean =>
    status === 301 || status === 302 || status === 303 || status === 307 || status === 308

  /** 响应体 → `data`：`json: true` 或 `Content-Type: application/json` 时解析，失败回落文本 */
  const decodeBody = (response: TransportResponse, forceJson: boolean): unknown => {
    const text = response.body.toString('utf8')
    const contentType = headerOf(response.headers, 'content-type').toLowerCase()
    if (forceJson || contentType.includes('application/json')) {
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    }
    return text
  }

  const net: ExtensionActivationApi['net'] = {
    async fetch(url, opts = {}): Promise<NetFetchResult> {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return { ok: false, error: 'url 必须是 http/https 地址' }
      }
      let current: URL
      try {
        current = new URL(url)
      } catch {
        return { ok: false, error: `url 非法：${url}` }
      }

      const headers: Record<string, string> = { ...(opts.headers ?? {}) }
      let body: string | undefined
      if (opts.body !== undefined) {
        body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
        if (typeof opts.body !== 'string' && !hasHeader(headers, 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
      }

      const settings = await resolveProxySettings()
      const startedAt = Date.now()
      let method = (opts.method ?? 'GET').toUpperCase()
      let redirects = 0

      // 无限循环 + 显式"重定向计数"：每一跳要么 return 要么 continue，
      // 超过 `MAX_REDIRECTS` 就明确报错（而不是把 3xx 当成功结果回给扩展）。
      for (;;) {
        const remaining = netTimeoutMs - (Date.now() - startedAt)
        if (remaining <= 0) return { ok: false, error: `请求超时（${netTimeoutMs / 1000}s）` }

        const decision = pickProxy(settings.proxy, current)
        if (decision.error !== undefined) return { ok: false, error: decision.error }

        let response: TransportResponse
        try {
          response = await transport({
            url: current.href,
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            ...(decision.proxyUrl === undefined ? {} : { proxyUrl: decision.proxyUrl }),
            ignoreSSL: settings.ignoreSSL,
            timeoutMs: remaining,
            maxBodyBytes
          })
        } catch (error) {
          if (error instanceof ResponseTooLargeError) {
            return {
              ok: false,
              status: error.status,
              statusText: error.statusText,
              error: error.message
            }
          }
          return { ok: false, error: describeTransportError(error) }
        }

        const location = headerOf(response.headers, 'location')
        if (isRedirect(response.status) && location !== '') {
          if (redirects >= MAX_REDIRECTS) {
            return {
              ok: false,
              status: response.status,
              statusText: response.statusText,
              error: `重定向次数超过上限（${MAX_REDIRECTS}）`
            }
          }
          redirects += 1
          let next: URL
          try {
            next = new URL(location, current)
          } catch {
            return {
              ok: false,
              status: response.status,
              statusText: response.statusText,
              error: `重定向地址非法：${location}`
            }
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return {
              ok: false,
              status: response.status,
              statusText: response.statusText,
              error: `重定向到非 http(s) 协议已拒绝：${next.protocol}`
            }
          }
          // 303（以及 301/302 下的 POST）按浏览器习惯降级成 GET 并丢掉 body
          if (response.status === 303 || (response.status <= 302 && method === 'POST')) {
            method = 'GET'
            body = undefined
            for (const key of Object.keys(headers)) {
              const lower = key.toLowerCase()
              if (lower === 'content-type' || lower === 'content-length') delete headers[key]
            }
          }
          current = next
          continue
        }

        return {
          ok: true,
          status: response.status,
          statusText: response.statusText,
          data: decodeBody(response, opts.json === true)
        }
      }
    }
  }

  /* -------------------------------------- clipboard -------------------------------------- */

  const assertHostMain = (): HostMainBridge => {
    if (options.hostMain !== undefined) return options.hostMain
    throw new EhProtocolError(
      'EH_INTERNAL',
      '剪贴板需要主进程 IPC：宿主进程没有 Electron clipboard 模块',
      '缺桥：hostMain 未接线（需要 main 侧 host.clipboard 提供者 + runtime.ts 注入）'
    )
  }

  const callClipboard = async (params: unknown): Promise<unknown> => {
    const bridge = assertHostMain()
    try {
      return await bridge.request(CLIPBOARD_METHOD, params)
    } catch (error) {
      throw new Error(`剪贴板操作失败：${toErrorMessage(error)}`)
    }
  }

  const readClipboardResult = (raw: unknown): { ok: boolean; text?: string; error?: string } => {
    if (typeof raw === 'string') return { ok: true, text: raw }
    if (typeof raw !== 'object' || raw === null)
      return { ok: false, error: '主进程返回了无法识别的剪贴板结果' }
    const record = raw as { ok?: unknown; text?: unknown; error?: unknown }
    return {
      ok: record.ok === true,
      ...(typeof record.text === 'string' ? { text: record.text } : {}),
      ...(typeof record.error === 'string' ? { error: record.error } : {})
    }
  }

  const clipboard: ExtensionActivationApi['clipboard'] = {
    async readText(): Promise<string> {
      const result = readClipboardResult(await callClipboard({ action: 'read' }))
      if (!result.ok) throw new Error(result.error ?? '读取剪贴板失败')
      return result.text ?? ''
    },
    async writeText(text: string): Promise<void> {
      if (typeof text !== 'string') {
        throw new Error('clipboard.writeText 的 text 必须是字符串')
      }
      const result = readClipboardResult(await callClipboard({ action: 'write', text }))
      if (!result.ok) throw new Error(result.error ?? '写入剪贴板失败')
    }
  }

  /* ---------------------------------- fs.watch / unwatch ---------------------------------- */

  const requireWatchId = (api: string, watchId: unknown): string => {
    if (typeof watchId !== 'string' || watchId.trim() === '') {
      throw new Error(`${api} 的 watchId 必须是非空字符串`)
    }
    return watchId
  }

  const closeWatcher = (watchId: string): boolean => {
    const entry = watchers.get(watchId)
    if (!entry) return false
    watchers.delete(watchId)
    try {
      entry.handle.close()
    } catch (error) {
      // close() 失败（句柄已被系统回收）不该让 unwatch/dispose 抛出去
      options.log('warn', `[${extId}] 关闭文件监听失败：${watchId}`, toErrorMessage(error))
    }
    return true
  }

  const fsWatch: IoCapabilities['fsWatch'] = {
    async watch(watchId, dir, callback): Promise<void> {
      if (disposed) throw new Error('该扩展的 api 已释放（dispose 之后不能再 watch）')
      const id = requireWatchId('fs.watch', watchId)
      if (typeof callback !== 'function') {
        throw new Error('fs.watch 的 callback 必须是函数')
      }
      // 路径白名单与 fs 读写同一套（绝对路径/`..` 一律拒绝）
      const absolute = resolveInsideDataDir(root, dir)

      // 同 id 重复 watch = 重置（与老 api 语义一致），且**不占新增额度**
      const replaced = closeWatcher(id)
      if (!replaced && watchers.size >= MAX_WATCHERS_PER_EXT) {
        throw new Error(`监听数量已达上限（${MAX_WATCHERS_PER_EXT}）`)
      }

      let handle: WatchHandle
      try {
        handle = watchBackend.start(absolute, {
          onChange: (relPath: string): void => {
            if (disposed) return
            const current = watchers.get(id)
            if (!current) return // 已经 unwatch：不再回调
            // 回调经隔离壳跑：扩展回调抛错只上报，不杀宿主
            void options.runSafely(extId, () => callback({ relPath }), 'callback')
          },
          onError: (error: unknown): void => {
            options.log(
              'warn',
              `[${extId}] 文件监听出错，已自动关闭：${id}（${absolute}）`,
              toErrorMessage(error)
            )
            closeWatcher(id)
          }
        })
      } catch (error) {
        throw new Error(`监听目录失败（${dir}）：${toErrorMessage(error)}`)
      }

      watchers.set(id, { watchId: id, dir: absolute, handle })
    },

    async unwatch(watchId): Promise<void> {
      const id = requireWatchId('fs.unwatch', watchId)
      if (!closeWatcher(id)) {
        options.log('debug', `[${extId}] fs.unwatch 的 watchId 不存在（忽略）：${id}`)
      }
    },

    count(): number {
      return watchers.size
    }
  }

  return {
    env,
    net,
    clipboard,
    fsWatch,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const id of [...watchers.keys()]) closeWatcher(id)
    }
  }
}
