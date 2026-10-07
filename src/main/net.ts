/**
 * 扩展网络请求服务：api.net.fetch。
 * 渲染进程 CSP（default-src 'self' app:）禁止扩展直接 fetch 外部网络，因此请求走主进程。
 *
 * 实现要点：
 * - 走 **Chromium 栈**（专用 session `obox-net` 的 `fetch`），而不是 Node 全局 fetch——
 *   后者既不读代理 env，也无法应用 per-session 代理与证书策略（见 proxy.ts 顶部说明）
 * - 代理/忽略 SSL 由 `applyProxyToSession` 应用在该 session 上，真实生效
 * - 默认 30s 超时；URL 仅允许 http/https；响应按 Content-Type 自动解析（`json: true` 强制）
 */
import { ipcMain } from 'electron'
import type { ProxyConfig } from '../shared/types'
import { applyProxyToSession, netSession } from './proxy'

interface NetRequest {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  json?: boolean
}

/** 响应体上限（防止扩展无意/有意拉取超大响应把主进程撑爆），默认 8MB */
const MAX_BODY_BYTES = 8 * 1024 * 1024

export function registerNetIpc(): void {
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
      applyProxyToSession(ses, proxy)
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
