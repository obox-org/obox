/**
 * 主进程更新服务：基于 electron-updater（nsis），经 IPC 暴露给渲染进程。
 * - 更新源由"更新提供者扩展"决定（设置-更新选择），宿主不内置默认源
 * - 支持代理配置（http.proxy / username / password / ignoreSSL / noProxy）
 * - 事件（检查结果/下载进度/下载完成）经 IPC 转发渲染进程
 */
import { app, ipcMain } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { request as httpsRequest } from 'node:https'
import type { ProxyConfig } from '../shared/types'

/** 更新事件（主进程 → 渲染进程） */
export type UpdateEvent =
  | { type: 'update-available'; info: UpdateInfo }
  | { type: 'update-not-available' }
  | {
      type: 'download-progress'
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }
  | { type: 'update-downloaded'; version: string }
  | { type: 'error'; message: string }

let initialized = false
let listeners: ((e: UpdateEvent) => void)[] = []

/** 解析 GitHub 仓库"最后一次编译"的 release 更新源（按创建时间最新，不依赖 latest 标记） */
export async function resolveLatestRelease(
  repo: string
): Promise<{ ok: boolean; tag?: string; feedUrl?: string; publishedAt?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: 'api.github.com',
        path: `/repos/${repo}/releases?per_page=1`,
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'obox-updater'
        },
        timeout: 10_000
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, error: `GitHub API 返回 ${res.statusCode}` })
            return
          }
          try {
            const list = JSON.parse(body) as Array<{ tag_name?: string; published_at?: string; created_at?: string }>
            const latest = Array.isArray(list) ? list[0] : undefined
            if (!latest?.tag_name) {
              resolve({ ok: false, error: '仓库没有已发布的 release' })
              return
            }
            resolve({
              ok: true,
              tag: latest.tag_name,
              publishedAt: latest.published_at ?? latest.created_at,
              feedUrl: `https://github.com/${repo}/releases/download/${latest.tag_name}/`
            })
          } catch (err) {
            resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', (err) => resolve({ ok: false, error: err.message }))
    req.end()
  })
}

/** 应用当前代理配置到 electron-updater（每次检查前调用） */
function applyProxy(proxy?: ProxyConfig): void {
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
  // electron-updater 走 Node 网络栈，用环境变量代理
  process.env.HTTP_PROXY = proxyUrl
  process.env.HTTPS_PROXY = proxyUrl
  process.env.NO_PROXY = proxy.noProxy?.join(',') ?? ''
  if (proxy.ignoreSSL) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  } else {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  }
}

function ensureInit(): void {
  if (initialized) return
  initialized = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => {
    listeners.forEach((l) => l({ type: 'update-available', info }))
  })
  autoUpdater.on('update-not-available', () => {
    listeners.forEach((l) => l({ type: 'update-not-available' }))
  })
  autoUpdater.on('download-progress', (p) => {
    listeners.forEach((l) =>
      l({
        type: 'download-progress',
        percent: p.percent,
        bytesPerSecond: p.bytesPerSecond,
        transferred: p.transferred,
        total: p.total
      })
    )
  })
  autoUpdater.on('update-downloaded', (info) => {
    listeners.forEach((l) => l({ type: 'update-downloaded', version: info.version }))
  })
  autoUpdater.on('error', (err) => {
    listeners.forEach((l) => l({ type: 'error', message: err.message }))
  })
}

export function registerUpdateIpc(): void {
  ensureInit()

  ipcMain.handle('update:get-version', (): string => app.getVersion())

  // 解析最后一次编译的 release 更新源（obox-updater 扩展调用；仓库格式 "owner/repo"）
  ipcMain.handle(
    'update:resolve-feed',
    async (_e, repo: string): Promise<{ ok: boolean; tag?: string; feedUrl?: string; publishedAt?: string; error?: string }> => {
      try {
        if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          return { ok: false, error: '仓库格式非法（应为 owner/repo）' }
        }
        return await resolveLatestRelease(repo)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 检查更新：需要更新源 URL（由更新提供者扩展传入；无默认源）
  ipcMain.handle(
    'update:check',
    async (
      _e,
      opts: { feedUrl?: string; proxy?: ProxyConfig }
    ): Promise<{ ok: boolean; available?: string; error?: string }> => {
      try {
        if (!opts.feedUrl) return { ok: false, error: '未配置更新源（需在设置-更新选择更新扩展）' }
        applyProxy(opts.proxy)
        // Windows 上 electron-updater 不分架构固定读 latest.yml（x64 元数据）；
        // arm64 机器必须指定 channel 为 latest-arm64，否则会下载到 x64 安装包
        autoUpdater.setFeedURL({
          provider: 'generic',
          url: opts.feedUrl,
          channel: process.arch === 'arm64' ? 'latest-arm64' : 'latest'
        })
        const result = await autoUpdater.checkForUpdates()
        return { ok: true, available: result?.updateInfo.version }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // 下载更新（不自动安装，等 quitAndInstall）
  ipcMain.handle('update:download', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 安装并重启（下载完成后调用）
  ipcMain.handle('update:install', (): void => {
    autoUpdater.quitAndInstall()
  })
}

/** 渲染进程订阅更新事件（preload 经此转发） */
export function onUpdateEvent(listener: (e: UpdateEvent) => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}
