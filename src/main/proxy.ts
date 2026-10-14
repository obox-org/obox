/**
 * 代理应用（主进程，Chromium session 层）：扩展联网（api.net.fetch）与更新下载共用。
 *
 * 为什么不是 env 变量：Node 的全局 `fetch`（undici）与 Electron `net.request`（Chromium）
 * **都不读** `HTTP_PROXY`/`HTTPS_PROXY` —— 早先的实现（写 env + `NODE_TLS_REJECT_UNAUTHORIZED`）
 * 对两条链路**都无效**（实测：把 HTTP_PROXY 指向不可达代理，fetch 仍直连成功）。
 * 正确做法是在真正发请求的 session 上调用 `setProxy` / `setCertificateVerifyProc`。
 *
 * 配置形态（1.0.12 起）：**单一代理 URL**（`http://127.0.0.1:7890`、`socks5://…`、
 * `http://user:pass@host:1080`），见 `ProxyConfig`。本文件是 **URL 解析与 Chromium 规则串派生的
 * 唯一实现**（纯函数，可单测）；旧形态（host/port/username/password）的迁移实现在
 * `src/shared/proxyConfig.ts`（渲染层也要用，不能 import 本文件——这里依赖 electron）。
 *
 * 凭据为什么不能进规则串：Chromium 的 `proxyRules` 语法里**没有** userinfo 位
 * （`http=host:port` 只认主机与端口），把账号密码拼进去会被当成非法主机名而整个规则失效。
 * 因此认证只能走 session 的 **login 事件**（electron-updater 把它抛成 `autoUpdater.on('login')`），
 * 由 `proxyCredentialsOf()` / `currentProxyCredentials()` 从 URL 的 `user:pass@` 里解析出来回填。
 *
 * session 划分：
 * - `obox-net`：扩展联网专用（内存 session，不共享页面 cookie/缓存）
 * - `electron-updater`：与 electron-updater 内部 `NET_SESSION_NAME` 同名，代理设置对它生效
 */
import { session, type Session } from 'electron'
import type { LegacyProxyConfig, ProxyConfig } from '../shared/types'
import { normalizeProxyConfig, type ProxyConfigInput } from '../shared/proxyConfig'

/** 扩展联网专用 session（内存态，不落盘、不与页面共享 cookie） */
export const NET_PARTITION = 'obox-net'
/** electron-updater 使用的 session 名（必须与其内部 NET_SESSION_NAME 一致） */
export const UPDATER_PARTITION = 'electron-updater'

/** 允许出现在代理 URL 里的协议 */
export type ProxyScheme = 'http' | 'https' | 'socks4' | 'socks5'

const SCHEMES: readonly ProxyScheme[] = ['http', 'https', 'socks4', 'socks5']

/** URL 省略端口时的缺省端口（http/https 是 URL 标准缺省；socks 取约定值 1080） */
const DEFAULT_PORTS: Record<ProxyScheme, number> = {
  http: 80,
  https: 443,
  socks4: 1080,
  socks5: 1080
}

/** `parseProxyUrl` 的结果：直连（空串）/ 解析成功 / 失败（含人类可读原因） */
export type ParsedProxyUrl =
  | { direct: true }
  | {
      direct: false
      scheme: ProxyScheme
      host: string
      /** 已按协议补全缺省端口，因此恒为具体端口号 */
      port: number
      /** 已 percent-decode 的用户名（URL 里有 userinfo 时才有） */
      username?: string
      /** 已 percent-decode 的密码（可能为空串） */
      password?: string
    }
  | { error: string }

/**
 * 解析代理 URL（纯函数）。
 *
 * - 空串 / 纯空白 = **直连**（`{ direct: true }`，不是错误）
 * - 支持 `http` / `https` / `socks4` / `socks5`；其余协议、缺协议前缀、带路径/查询/片段、
 *   端口越界、userinfo 百分号编码非法 → `{ error }`（原因是给人看的，可直接进日志/提示）
 */
export function parseProxyUrl(url?: string | null): ParsedProxyUrl {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (!raw) return { direct: true }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {
      error: `代理地址无法解析：「${raw}」（需要「协议://主机[:端口]」，如 http://127.0.0.1:7890）`
    }
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!SCHEMES.includes(scheme as ProxyScheme)) {
    return {
      error: `不支持的代理协议「${scheme}」（支持 ${SCHEMES.join(' / ')}）`
    }
  }
  if (!parsed.hostname) {
    return { error: `代理地址缺少主机：「${raw}」` }
  }
  // URL 解析会把空路径归一成 '/'（非特殊协议如 socks 则是 ''），所以只有真写了路径/查询/片段才非法
  if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    return { error: `代理地址不应带路径 / 查询 / 片段：「${raw}」` }
  }

  let username: string | undefined
  let password: string | undefined
  try {
    username = parsed.username ? decodeURIComponent(parsed.username) : undefined
    password = parsed.password ? decodeURIComponent(parsed.password) : undefined
  } catch {
    return { error: `代理地址里的账号或密码百分号编码非法：「${raw}」` }
  }

  const out: Extract<ParsedProxyUrl, { direct: false }> = {
    direct: false,
    scheme: scheme as ProxyScheme,
    host: parsed.hostname,
    // 显式写了协议缺省端口时 URL 会把它吃掉（port 为空串），此处按协议补回同样的值
    port: parsed.port ? Number(parsed.port) : DEFAULT_PORTS[scheme as ProxyScheme]
  }
  // 无 userinfo 时不写这两个键（保持"解析结果只有实际存在的信息"）
  if (username !== undefined) out.username = username
  if (password !== undefined) out.password = password
  return out
}

/** 最近一次应用的代理配置（新形态、已迁移；供 updater 的 `login` 事件取凭据——回调时拿不到入参配置） */
let current: ProxyConfig | undefined
export function currentProxy(): ProxyConfig | undefined {
  return current
}

/**
 * Chromium 代理规则串（纯函数）。**不含账号密码**（Chromium 规则语法没有 userinfo 位，见文件头）。
 *
 * - `http://` / `https://` 代理 → `http=<host>:<port>;https=<host>:<port>`（https 走 CONNECT，同一条 http 规则）
 * - `socks4://` → `socks=<host>:<port>`；`socks5://` → `socks5=<host>:<port>`
 * - 未启用 / 空 URL / 非法 URL → 空串（调用方据此走 `mode:'direct'`；非法原因见 `proxyConfigError`）
 */
export function proxyRulesOf(proxy?: ProxyConfigInput): string {
  const cfg = normalizeProxyConfig(proxy)
  if (!cfg.enabled) return ''
  const parsed = parseProxyUrl(cfg.url)
  if ('error' in parsed || parsed.direct) return ''
  const hostPort = `${parsed.host}:${parsed.port}`
  switch (parsed.scheme) {
    case 'socks4':
      return `socks=${hostPort}`
    case 'socks5':
      return `socks5=${hostPort}`
    default:
      return `http=${hostPort};https=${hostPort}`
  }
}

/**
 * 配置本身的问题（人类可读原因）；没有问题时返回 `undefined`。
 * 用于"启用了代理但地址非法"的诊断——此时会**回退直连**，不静默假装代理生效。
 */
export function proxyConfigError(proxy?: ProxyConfigInput): string | undefined {
  const cfg = normalizeProxyConfig(proxy)
  if (!cfg.enabled) return undefined
  const parsed = parseProxyUrl(cfg.url)
  return 'error' in parsed ? parsed.error : undefined
}

/**
 * 从配置里取代理认证凭据（纯函数）。凭据来自 URL 的 `user:pass@` 部分——
 * Chromium 规则串带不了凭据，认证只能靠 login 事件回填。
 * 未启用 / 直连 / 无用户名 → `undefined`（调用方应"不带参数回调"取消认证）。
 */
export function proxyCredentialsOf(
  proxy?: ProxyConfigInput
): { username: string; password: string } | undefined {
  const cfg = normalizeProxyConfig(proxy)
  if (!cfg.enabled) return undefined
  const parsed = parseProxyUrl(cfg.url)
  if ('error' in parsed || parsed.direct || !parsed.username) return undefined
  return { username: parsed.username, password: parsed.password ?? '' }
}

/** 最近一次应用配置里的代理凭据（updater 的 `login` 事件用；见 `proxyCredentialsOf`） */
export function currentProxyCredentials(): { username: string; password: string } | undefined {
  return proxyCredentialsOf(current)
}

export function netSession(): Session {
  return session.fromPartition(NET_PARTITION)
}

export function updaterSession(): Session {
  return session.fromPartition(UPDATER_PARTITION)
}

/** 每个 session 已应用的配置指纹：配置未变不重复调用（避免无谓的 setProxy 往返） */
const applied = new WeakMap<Session, string>()

/**
 * 把代理配置应用到指定 session（幂等）。
 * - 入参可以是**新形态**（URL）或**旧形态**（host/port/username/password，会被内部迁移成 URL，
 *   防止旧值从别处流入时静默失效）
 * - 未启用 / 空 URL → `mode: 'direct'`（直连）；URL 非法 → 同样直连，但先 `console.warn` 出原因
 * - `noProxy` → `proxyBypassRules`；`ignoreSSL` → `setCertificateVerifyProc` 放行全部证书
 * - 认证凭据不进规则串，由 login 事件经 `currentProxyCredentials()` 取（见文件头）
 */
export function applyProxyToSession(ses: Session, proxy?: ProxyConfig | LegacyProxyConfig): void {
  const cfg = proxy ? normalizeProxyConfig(proxy) : undefined
  current = cfg

  const issue = cfg ? proxyConfigError(cfg) : undefined
  if (issue) console.warn(`[proxy] ${issue}；本次按直连应用`)

  const rules = proxyRulesOf(cfg)
  const bypass = (cfg?.noProxy ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',')
  const key = `${rules}|${bypass}|${cfg?.ignoreSSL ? '1' : '0'}`
  if (applied.get(ses) === key) return
  applied.set(ses, key)

  if (rules) {
    // ⚠️ 换代理后必须让**新连接**走新配置：Chromium 会复用连接池里已建立的连接，否则"刚开启代理"
    // 的那段时间里已被池化的直连仍会被继续使用。实测（dev 实例 + CDP）：同一进程内把代理切到
    // 打不通的 `http://127.0.0.1:9`，更新源解析**照样成功**（复用旧直连）；而重启进程后同一配置
    // 立刻返回 `net::ERR_PROXY_CONNECTION_FAILED` ⇒ 代理配置本身没问题，是旧连接在生效。
    // `closeAllConnections()` 关掉既有连接，随后的请求必然重建 ⇒ 代理立即生效（也避免流量泄漏到直连）。
    void ses
      .setProxy({ proxyRules: rules, proxyBypassRules: bypass })
      .then(() => ses.closeAllConnections())
  } else {
    void ses.setProxy({ mode: 'direct' }).then(() => ses.closeAllConnections())
  }

  if (cfg?.ignoreSSL) {
    // 0 = 通过（不校验证书）；等效于原先的 NODE_TLS_REJECT_UNAUTHORIZED=0，但只作用于该 session
    ses.setCertificateVerifyProc((_request, callback) => callback(0))
  } else {
    ses.setCertificateVerifyProc(null)
  }
}

/** 把代理同时应用到扩展联网与更新两个 session（两者配置一致） */
export function applyProxy(proxy?: ProxyConfig | LegacyProxyConfig): void {
  applyProxyToSession(netSession(), proxy)
  applyProxyToSession(updaterSession(), proxy)
}
