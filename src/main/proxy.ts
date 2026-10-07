/**
 * 代理应用（主进程，Chromium session 层）：扩展联网（api.net.fetch）与更新下载共用。
 *
 * 为什么不是 env 变量：Node 的全局 `fetch`（undici）与 Electron `net.request`（Chromium）
 * **都不读** `HTTP_PROXY`/`HTTPS_PROXY` —— 早先的实现（写 env + `NODE_TLS_REJECT_UNAUTHORIZED`）
 * 对两条链路**都无效**（实测：把 HTTP_PROXY 指向不可达代理，fetch 仍直连成功）。
 * 正确做法是在真正发请求的 session 上调用 `setProxy` / `setCertificateVerifyProc`。
 *
 * session 划分：
 * - `obox-net`：扩展联网专用（内存 session，不共享页面 cookie/缓存）
 * - `electron-updater`：与 electron-updater 内部 `NET_SESSION_NAME` 同名，代理设置对它生效
 */
import { session, type Session } from 'electron'
import type { ProxyConfig } from '../shared/types'

/** 扩展联网专用 session（内存态，不落盘、不与页面共享 cookie） */
export const NET_PARTITION = 'obox-net'
/** electron-updater 使用的 session 名（必须与其内部 NET_SESSION_NAME 一致） */
export const UPDATER_PARTITION = 'electron-updater'

export function netSession(): Session {
  return session.fromPartition(NET_PARTITION)
}

export function updaterSession(): Session {
  return session.fromPartition(UPDATER_PARTITION)
}

/** 最近一次应用的代理配置（供 updater 的 `login` 事件取凭据——回调时拿不到入参配置） */
let current: ProxyConfig | undefined
export function currentProxy(): ProxyConfig | undefined {
  return current
}

/** Chromium 代理规则串（host:port；不支持在规则里携带账号密码，认证走 login 事件） */
function proxyRulesOf(proxy?: ProxyConfig): string {
  if (!proxy?.enabled || !proxy.host) return ''
  return `http://${proxy.host}${proxy.port ? `:${proxy.port}` : ''}`
}

/** 每个 session 已应用的配置指纹：配置未变不重复调用（避免无谓的 setProxy 往返） */
const applied = new WeakMap<Session, string>()

/**
 * 把代理配置应用到指定 session（幂等）。
 * - 未启用/无 host → `mode: 'direct'`（直连）
 * - `noProxy` → `proxyBypassRules`
 * - `ignoreSSL` → `setCertificateVerifyProc` 放行全部证书（关掉时恢复默认校验）
 */
export function applyProxyToSession(ses: Session, proxy?: ProxyConfig): void {
  current = proxy
  const rules = proxyRulesOf(proxy)
  const bypass = (proxy?.noProxy ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',')
  const key = `${rules}|${bypass}|${proxy?.ignoreSSL ? '1' : '0'}`
  if (applied.get(ses) === key) return
  applied.set(ses, key)

  if (rules) {
    void ses.setProxy({ proxyRules: rules, proxyBypassRules: bypass })
  } else {
    void ses.setProxy({ mode: 'direct' })
  }

  if (proxy?.ignoreSSL) {
    // 0 = 通过（不校验证书）；等效于原先的 NODE_TLS_REJECT_UNAUTHORIZED=0，但只作用于该 session
    ses.setCertificateVerifyProc((_request, callback) => callback(0))
  } else {
    ses.setCertificateVerifyProc(null)
  }
}

/** 把代理同时应用到扩展联网与更新两个 session（两者配置一致） */
export function applyProxy(proxy?: ProxyConfig): void {
  applyProxyToSession(netSession(), proxy)
  applyProxyToSession(updaterSession(), proxy)
}
