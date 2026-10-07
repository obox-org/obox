/**
 * 更新元数据（latest.yml）解析与产物挑选（**不依赖 electron**，可独立单测）。
 *
 * 用途：为"强制重装 / 降级"提供入口——electron-updater 在 `allowDowngrade = false` 且
 * 远端版本与本地**相等**时直接判定"无更新"（semver 比较），因此同版本重装与降级无法经它完成。
 * 这里改为直接读更新源里的 `latest.yml`，挑出匹配本机架构的安装包，下载并校验后启动安装向导。
 *
 * latest.yml 由 electron-builder 生成，结构稳定且简单：
 * ```yaml
 * version: 1.0.3
 * files:
 *   - url: obox-1.0.3-x64-setup.exe
 *     sha512: <base64>
 *     size: 103015503
 * path: obox-1.0.3-setup.exe
 * sha512: <base64>
 * releaseDate: '2026-08-31T10:05:00.518Z'
 * ```
 * 因此用一个聚焦的解析器即可，不引入 YAML 依赖（保持零依赖与可测）。
 */

export interface UpdateFeedFile {
  url: string
  sha512?: string
  size?: number
}

export interface UpdateFeed {
  version: string
  files: UpdateFeedFile[]
  /** 默认产物（顶层 path），通常是无架构后缀的那份 */
  path?: string
}

export class UpdateFeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateFeedError'
  }
}

function unquote(raw: string): string {
  const v = raw.trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1)
  }
  return v
}

/** 解析 latest.yml；缺 version 或 files 为空即视为无效元数据 */
export function parseUpdateFeed(text: string): UpdateFeed {
  if (typeof text !== 'string' || !text.trim()) {
    throw new UpdateFeedError('更新元数据为空')
  }
  let version = ''
  let path: string | undefined
  const files: UpdateFeedFile[] = []
  let current: UpdateFeedFile | null = null
  let inFiles = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) continue
    const topLevel = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line)
    if (topLevel) {
      const key = topLevel[1]
      const value = topLevel[2]
      inFiles = key === 'files'
      if (key === 'version') version = unquote(value)
      if (key === 'path') path = unquote(value)
      continue
    }
    const itemStart = /^\s*-\s*([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line)
    if (inFiles && itemStart) {
      current = { url: '' }
      files.push(current)
      const key = itemStart[1]
      const value = unquote(itemStart[2])
      if (key === 'url') current.url = value
      if (key === 'sha512') current.sha512 = value
      if (key === 'size') current.size = Number(value) || undefined
      continue
    }
    const itemField = /^\s+([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line)
    if (inFiles && current && itemField) {
      const key = itemField[1]
      const value = unquote(itemField[2])
      if (key === 'url') current.url = value
      if (key === 'sha512') current.sha512 = value
      if (key === 'size') current.size = Number(value) || undefined
    }
  }

  const valid = files.filter((f) => !!f.url)
  if (!version) throw new UpdateFeedError('更新元数据缺少 version')
  if (valid.length === 0) throw new UpdateFeedError('更新元数据没有可用的安装包条目')
  return { version, files: valid, path }
}

/** 版本归一化：去掉 v 前缀，便于展示与比较（不做完整 semver 语义） */
export function normalizeVersion(version: string): string {
  return String(version ?? '')
    .replace(/^v/i, '')
    .trim()
}

/**
 * 按架构挑选安装包。
 * 优先"文件名含 `-<arch>-setup.`"的精确匹配；退回到无架构后缀的默认产物（顶层 `path`），
 * 再退回 `files` 中的第一项——与 electron-updater 的挑选意图一致（Windows 只有一份 latest.yml）。
 */
export function pickArtifact(feed: UpdateFeed, arch: string): UpdateFeedFile {
  const matches = (f: UpdateFeedFile, pattern: RegExp): boolean => pattern.test(f.url)
  const archRe = new RegExp(`-${arch}-setup\\.[A-Za-z0-9]+$`, 'i')
  const exact = feed.files.find((f) => matches(f, archRe))
  if (exact) return exact
  if (feed.path) {
    const viaPath = feed.files.find((f) => f.url === feed.path)
    if (viaPath) return viaPath
  }
  return feed.files[0]
}

/** 把 feed 基址与条目 url 拼成绝对下载地址（url 已是绝对地址时原样返回） */
export function buildAssetUrl(feedUrl: string, file: UpdateFeedFile): string {
  if (/^https?:\/\//i.test(file.url)) return file.url
  const base = feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`
  return `${base}${file.url.replace(/^\.?\//, '')}`
}
