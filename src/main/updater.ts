/**
 * 主进程更新服务：基于 electron-updater（nsis），经 IPC 暴露给渲染进程。
 * - 更新源由"更新提供者扩展"决定（设置-更新选择），宿主不内置默认源
 * - 代理 / 忽略 SSL 在 **session 层**应用（见 proxy.ts，对 electron-updater 的 net.request 真正生效）；
 *   代理认证经 autoUpdater 的 `login` 事件回填设置-网络里的账号密码
 * - 事件（检查结果/下载进度/下载完成）经 IPC 转发渲染进程
 */
import { app, ipcMain, shell } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import type { ProxyConfig } from '../shared/types'
import { applyProxyToSession, currentProxy, updaterSession } from './proxy'
import { buildAssetUrl, parseUpdateFeed, pickArtifact } from './updateFeed'

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

/** electron-builder 在 Windows 上固定生成的更新元数据文件名（无架构后缀，files 内含全部架构） */
const UPDATE_META_FILE = 'latest.yml'

interface ReleaseAsset {
  name?: string
}

interface ReleaseItem {
  tag_name?: string
  published_at?: string
  created_at?: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
}

/**
 * 解析 GitHub 仓库的更新源：取**最近若干 release 中第一个可用项**——
 * 非 draft、非 prerelease，且资产里含 `latest.yml`（只认"已编译出更新元数据"的 release）。
 * 不依赖 GitHub 的 latest 标记，避免它指向未完成编译（缺 latest.yml）的 release，也避免误取预发布。
 * 无可用项时返回 ok:false，由调用方（更新提供者扩展）决定是否回落 `releases/latest/download/`。
 */
export async function resolveLatestRelease(
  repo: string,
  proxy?: ProxyConfig
): Promise<{ ok: boolean; tag?: string; feedUrl?: string; publishedAt?: string; error?: string }> {
  const ses = updaterSession()
  applyProxyToSession(ses, proxy)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await ses.fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'obox-updater',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: controller.signal
    })
    if (!res.ok) {
      return { ok: false, error: `GitHub API 返回 ${res.status}` }
    }
    const list = (await res.json()) as ReleaseItem[]
    const pick = (Array.isArray(list) ? list : []).find(
      (r) =>
        r &&
        !r.draft &&
        !r.prerelease &&
        !!r.tag_name &&
        (r.assets ?? []).some((a) => a?.name === UPDATE_META_FILE)
    )
    if (!pick?.tag_name) {
      return { ok: false, error: `仓库没有含 ${UPDATE_META_FILE} 的正式 release` }
    }
    return {
      ok: true,
      tag: pick.tag_name,
      publishedAt: pick.published_at ?? pick.created_at,
      feedUrl: `https://github.com/${repo}/releases/download/${pick.tag_name}/`
    }
  } catch (err) {
    const aborted =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    return {
      ok: false,
      error: aborted ? '请求超时（10s）' : err instanceof Error ? err.message : String(err)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 仓库标识校验：`owner/repo`，两段都不允许 `.` / `..` */
function isValidRepo(repo: unknown): repo is string {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return false
  return !repo.split('/').some((seg) => seg === '.' || seg === '..')
}

function ensureInit(): void {
  if (initialized) return
  initialized = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // 代理认证：electron-updater 把代理/服务器的 401 作为 'login' 事件抛出，
  // 用设置-网络里的账号密码回填（否则认证代理下的检查/下载会失败）
  autoUpdater.on('login', (_authInfo, callback) => {
    const p = currentProxy()
    // 类型上 callback 要求两个参数；Electron 语义是"不带参数调用 = 取消认证"（无凭据时不重试）
    const respond = callback as (username?: string, password?: string) => void
    if (p?.username) respond(p.username, p.password ?? '')
    else respond()
  })

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

/** 进行中的检查/下载：并发调用复用同一结果（命令面板与状态栏可同时触发，避免重复下载/竞态） */
let activeCheck: Promise<{ ok: boolean; available?: string; error?: string }> | null = null
let activeDownload: Promise<{ ok: boolean; error?: string }> | null = null
/** 进行中的"强制重装/降级"下载 */
let activeForceInstall: Promise<{
  ok: boolean
  version?: string
  filePath?: string
  error?: string
}> | null = null

/**
 * 强制重装 / 降级：**绕开 electron-updater 的版本门控**。
 *
 * electron-updater 默认 `allowDowngrade = false`，且远端版本与本地**相等**时按 semver 判"无更新"——
 * 因此"修复损坏的安装（同版本重装）"和"回退到旧版本"都无法经它完成。
 * 这里直接从更新源读 `latest.yml` → 按本机架构挑产物 → 流式下载 → 校验 sha512 → 启动安装向导，
 * 由用户完成安装（NSIS 向导式安装器）；应用自身不退出。
 */
async function forceInstallFromFeed(opts: {
  feedUrl: string
  proxy?: ProxyConfig
}): Promise<{ ok: boolean; version?: string; filePath?: string; error?: string }> {
  const ses = updaterSession()
  applyProxyToSession(ses, opts.proxy)
  const feedBase = opts.feedUrl.endsWith('/') ? opts.feedUrl : `${opts.feedUrl}/`

  // 1) 取并解析更新元数据
  const metaRes = await ses.fetch(buildAssetUrl(feedBase, { url: 'latest.yml' }), {
    redirect: 'follow'
  })
  if (!metaRes.ok) {
    return { ok: false, error: `读取更新元数据失败（HTTP ${metaRes.status}）` }
  }
  const feed = parseUpdateFeed(await metaRes.text())

  // 2) 按架构挑产物（Windows 只有一份 latest.yml，两根架构的包都在 files 里）
  const file = pickArtifact(feed, process.arch)
  const url = buildAssetUrl(feedBase, file)
  const dir = join(app.getPath('userData'), 'updates')
  await mkdir(dir, { recursive: true })
  const dest = join(dir, file.url.split('/').pop() ?? 'obox-setup.exe')

  // 3) 流式下载（边下边算 sha512），限时 30 分钟；进度经既有 download-progress 事件透出
  const res = await ses.fetch(url, { redirect: 'follow' })
  if (!res.ok) return { ok: false, error: `下载安装包失败（HTTP ${res.status}）` }
  const total = Number(res.headers.get('content-length') ?? file.size ?? 0)
  const hash = createHash('sha512')
  let transferred = 0
  let lastEmit = 0
  const started = Date.now()
  const stream = Readable.fromWeb(
    res.body as unknown as Parameters<typeof Readable.fromWeb>[0]
  ) as Readable
  stream.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    transferred += chunk.length
    const now = Date.now()
    if (now - lastEmit < 200) return
    lastEmit = now
    const elapsed = Math.max(1, now - started) / 1000
    listeners.forEach((l) =>
      l({
        type: 'download-progress',
        percent: total > 0 ? (transferred / total) * 100 : 0,
        bytesPerSecond: transferred / elapsed,
        transferred,
        total
      })
    )
  })
  try {
    await pipeline(stream, createWriteStream(dest))
  } catch (err) {
    await rm(dest, { force: true })
    return {
      ok: false,
      error: `写入安装包失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  // 4) 校验 sha512（元数据里给了就必须匹配，否则删除并报错——不启动未校验的安装器）
  if (file.sha512) {
    const actual = hash.digest('base64')
    if (actual !== file.sha512) {
      await rm(dest, { force: true })
      return { ok: false, error: '安装包校验失败（sha512 不匹配），已删除下载文件' }
    }
  }
  const size = (await stat(dest)).size

  // 5) 启动安装向导（应用不退出：用户可在向导里选择安装目录/安装用户）
  const openResult = await shell.openPath(dest)
  if (openResult) {
    return { ok: false, error: `启动安装程序失败：${openResult}` }
  }
  listeners.forEach((l) => l({ type: 'update-downloaded', version: feed.version }))
  console.log(`[updater] 强制安装 ${feed.version}（${size} 字节）已启动：${dest}`)
  return { ok: true, version: feed.version, filePath: dest }
}

export function registerUpdateIpc(): void {
  ensureInit()

  ipcMain.handle('update:get-version', (): string => app.getVersion())

  // 解析更新源（更新提供者扩展调用）：仓库格式 "owner/repo"；代理与 check 走同一套 session 配置
  ipcMain.handle(
    'update:resolve-feed',
    async (
      _e,
      repo: string,
      proxy?: ProxyConfig
    ): Promise<{
      ok: boolean
      tag?: string
      feedUrl?: string
      publishedAt?: string
      error?: string
    }> => {
      try {
        if (!isValidRepo(repo)) {
          return { ok: false, error: '仓库格式非法（应为 owner/repo）' }
        }
        return await resolveLatestRelease(repo, proxy)
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
      if (!opts?.feedUrl) return { ok: false, error: '未配置更新源（需在设置-更新选择更新扩展）' }
      if (activeCheck) return activeCheck
      activeCheck = (async (): Promise<{ ok: boolean; available?: string; error?: string }> => {
        try {
          applyProxyToSession(updaterSession(), opts.proxy)
          // Windows 上 electron-builder 生成的更新元数据固定叫 latest.yml（无架构后缀），
          // 其中 files 含全部架构安装包；electron-updater 按机器架构自动选匹配的安装包。
          // 不要设 channel（arm64 不存在 latest-arm64.yml，设了会 404）。
          autoUpdater.setFeedURL({ provider: 'generic', url: opts.feedUrl })
          const result = await autoUpdater.checkForUpdates()
          return { ok: true, available: result?.updateInfo.version }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      })().finally(() => {
        activeCheck = null
      })
      return activeCheck
    }
  )

  // 下载更新（不自动安装，等 quitAndInstall）
  ipcMain.handle('update:download', async (): Promise<{ ok: boolean; error?: string }> => {
    if (activeDownload) return activeDownload
    activeDownload = (async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        await autoUpdater.downloadUpdate()
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })().finally(() => {
      activeDownload = null
    })
    return activeDownload
  })

  // 安装并重启（下载完成后调用）
  ipcMain.handle('update:install', (): void => {
    autoUpdater.quitAndInstall()
  })

  /**
   * 强制重装 / 降级：见 forceInstallFromFeed 的说明（绕开 electron-updater 的版本门控）。
   * 进行中互斥：重复调用复用同一结果。
   */
  ipcMain.handle(
    'update:force-install',
    async (
      _e,
      opts: { feedUrl?: string; proxy?: ProxyConfig; reason?: 'user' | 'auto' }
    ): Promise<{ ok: boolean; version?: string; filePath?: string; error?: string }> => {
      if (!opts?.feedUrl) return { ok: false, error: '未配置更新源（需在设置-更新选择更新扩展）' }
      if (activeForceInstall) return activeForceInstall
      // reason 目前只用于日志（后续可据此区分"用户主动"与"自动重试"的埋点/提示）
      console.log(`[updater] 强制安装请求（reason=${opts.reason ?? 'user'}）`)
      activeForceInstall = forceInstallFromFeed({
        feedUrl: opts.feedUrl,
        proxy: opts.proxy
      })
        .catch((err) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }))
        .finally(() => {
          activeForceInstall = null
        })
      return activeForceInstall
    }
  )
}

/** 渲染进程订阅更新事件（preload 经此转发） */
export function onUpdateEvent(listener: (e: UpdateEvent) => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}
