/**
 * 扩展网络请求服务：api.net.fetch。
 * 渲染进程 CSP（default-src 'self' app:）禁止扩展直接 fetch 外部网络，
 * 因此请求走主进程（Node 全局 fetch）并自动应用设置-网络代理（env 变量，与更新下载一致）。
 */
import { ipcMain } from 'electron'

interface NetRequest {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  json?: boolean
}

/** 应用代理 env（与 updater.ts 的 applyProxy 同策略；无配置时清空） */
function applyProxyEnv(proxy?: { enabled?: boolean; host?: string; port?: number; username?: string; password?: string; ignoreSSL?: boolean; noProxy?: string[] }): void {
  if (!proxy?.enabled || !proxy.host) {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.NO_PROXY
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    return
  }
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
    : ''
  const proxyUrl = `http://${auth}${proxy.host}${proxy.port ? ':' + proxy.port : ''}`
  process.env.HTTP_PROXY = proxyUrl
  process.env.HTTPS_PROXY = proxyUrl
  process.env.NO_PROXY = proxy.noProxy?.join(',') ?? ''
  if (proxy.ignoreSSL) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
}

export function registerNetIpc(): void {
  ipcMain.handle(
    'net:fetch',
    async (
      _e,
      req: NetRequest,
      proxy?: { enabled?: boolean; host?: string; port?: number; username?: string; password?: string; ignoreSSL?: boolean; noProxy?: string[] }
    ): Promise<{ ok: boolean; status?: number; statusText?: string; data?: unknown; error?: string }> => {
      if (!req?.url || !/^https?:\/\//i.test(req.url)) {
        return { ok: false, error: 'url 必须是 http/https 地址' }
      }
      applyProxyEnv(proxy)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        const headers: Record<string, string> = { ...(req.headers ?? {}) }
        let body: BodyInit | undefined
        if (req.body !== undefined) {
          body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
          if (!headers['Content-Type'] && typeof req.body !== 'string') {
            headers['Content-Type'] = 'application/json'
          }
        }
        const res = await fetch(req.url, {
          method: req.method ?? 'GET',
          headers,
          body,
          signal: controller.signal,
          redirect: 'follow'
        })
        const status = res.status
        const statusText = res.statusText
        let data: unknown
        const text = await res.text()
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
        return {
          ok: false,
          error: err instanceof Error ? (err.name === 'AbortError' ? '请求超时（30s）' : err.message) : String(err)
        }
      } finally {
        clearTimeout(timer)
      }
    }
  )
}
