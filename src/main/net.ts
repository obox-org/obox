/**
 * 扩展网络请求服务：api.net.fetch。
 * 渲染进程 CSP（default-src 'self' app:）禁止扩展直接 fetch 外部网络，因此请求走主进程。
 *
 * 实现要点：
 * - 走 **Chromium 栈**（专用 session `obox-net` 的 `fetch`），而不是 Node 全局 fetch——
 *   后者既不读代理 env，也无法应用 per-session 代理与证书策略（见 proxy.ts 顶部说明）
 * - 代理/忽略 SSL 由 `applyProxyToSession` 应用在该 session 上，真实生效
 * - 默认 30s 超时；URL 仅允许 http/https；响应按 Content-Type 自动解析（`json: true` 强制）
 * - 另注册宿主内部 IPC `proxy:apply`（见 `registerProxyIpc`）：代理是**两个** session（本模块的
 *   `obox-net` 与更新链路的 `electron-updater`）共用的配置，放这里随网络能力一起注册
 */
import { ipcMain } from 'electron'
import type { LegacyProxyConfig, ProxyConfig } from '../shared/types'
import { applyProxy, applyProxyToSession, currentProxy, netSession, proxyRulesOf } from './proxy'

interface NetRequest {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  json?: boolean
}

/** 响应体上限（防止扩展无意/有意拉取超大响应把主进程撑爆），默认 8MB */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * 宿主内部 IPC `proxy:apply`（**不在扩展 API 面内**，扩展读代理仍用 `api.proxy.get()`）。
 *
 * 渲染进程在**启动时**与**代理设置变化时**把当前代理（已过 `plainProxyConfig` 归一化）推给主进程，
 * 由 `applyProxy()` 一次性应用到扩展联网（`obox-net`）与更新（`electron-updater`）两个 session。
 *
 * 为什么必须有这条路径：`applyProxy()`（"把代理同时应用到两个 session"）此前**没有任何调用方**
 * ——于是两个 session 只在"某次请求恰好带了 proxy 参数"时才被配置，更新下载/安装是否走代理
 * 取决于"上一次 check 是否恰好配置过"这种偶然状态（obox-updater 报告的现象）。
 *
 * 参数语义与 `applyProxy()` 一致：`undefined` = 直连（用户关掉了代理，必须关得掉）；
 * 传入的垃圾值由 `normalizeProxyConfig()` 收敛（非 `enabled === true` 一律直连），不会抛错。
 */
export function registerProxyIpc(): void {
  ipcMain.handle('proxy:apply', (_e, proxy?: ProxyConfig | LegacyProxyConfig): void => {
    const rules = proxyRulesOf(proxy)
    console.log(`[proxy] 渲染进程推送代理配置：${rules || 'direct'}`)
    applyProxy(proxy)
  })
}

export function registerNetIpc(): void {
  registerProxyIpc()
  ipcMain.handle(
    'net:fetch',
    async (
      _e,
      req: NetRequest,
      proxy?: ProxyConfig
    ): Promise<{
      ok: boolean
      status?: number
      statusText?: string
      data?: unknown
      error?: string
    }> => {
      if (!req?.url || !/^https?:\/\//i.test(req.url)) {
        return { ok: false, error: 'url 必须是 http/https 地址' }
      }
      const ses = netSession()
      // 显式传入的代理优先；**未传**时回落「当前配置」（渲染进程启动/改设置时推入，或上一次调用
      // 留下的配置）——`applyProxyToSession(ses, undefined)` 的语义是"用户关掉了代理 ⇒ 直连"，
      // 调用方漏传时不能让它把 session 静默重置成直连（同类缺陷见 updater.ts 的 applyUpdaterProxy）
      applyProxyToSession(ses, proxy ?? currentProxy())
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        const headers: Record<string, string> = { ...(req.headers ?? {}) }
        let body: string | undefined
        if (req.body !== undefined) {
          body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
          if (!headers['Content-Type'] && typeof req.body !== 'string') {
            headers['Content-Type'] = 'application/json'
          }
        }
        const res = await ses.fetch(req.url, {
          method: req.method ?? 'GET',
          headers,
          body,
          signal: controller.signal,
          redirect: 'follow'
        })
        const status = res.status
        const statusText = res.statusText

        const declared = Number(res.headers.get('content-length') ?? '0')
        if (declared > MAX_BODY_BYTES) {
          return {
            ok: false,
            status,
            statusText,
            error: `响应体过大（${declared} 字节，上限 ${MAX_BODY_BYTES}）`
          }
        }
        const buf = await res.arrayBuffer()
        if (buf.byteLength > MAX_BODY_BYTES) {
          return {
            ok: false,
            status,
            statusText,
            error: `响应体过大（上限 ${MAX_BODY_BYTES} 字节）`
          }
        }
        const text = new TextDecoder().decode(buf)

        let data: unknown
        if (req.json === true || res.headers.get('content-type')?.includes('application/json')) {
          try {
            data = JSON.parse(text)
          } catch {
            data = text
          }
        } else {
          data = text
        }
        return { ok: true, status, statusText, data }
      } catch (err) {
        const aborted =
          err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
        return {
          ok: false,
          error: aborted ? '请求超时（30s）' : err instanceof Error ? err.message : String(err)
        }
      } finally {
        clearTimeout(timer)
      }
    }
  )
}
