/**
 * `api.net.download` 的**落盘策略**（纯逻辑，不依赖 electron / 真实网络）。
 *
 * 用户确认的语义：
 * - 目标路径是**相对扩展数据目录**的相对路径；
 * - 已存在文件时按 `onExist` 处理：`rename`（自动重命名，默认）/ `overwrite`（覆盖）/ `skip`（不操作）；
 * - 返回**相对路径**；`skip` 且文件已存在时返回 `undefined`。
 *
 * 为什么拆成纯函数：重命名规则（`a.zip` → `a (1).zip`）、越界路径拒绝、策略分支都必须可单测，
 * 否则只能靠"下载一次看看"来验证。
 */

export type DownloadOnExist = 'rename' | 'overwrite' | 'skip'

/** 解析结果：写到哪里 / 是否跳过 */
export type DownloadTarget =
  | { action: 'write'; relPath: string; absPath: string }
  | { action: 'skip'; relPath: string; absPath: string }
  | { action: 'error'; message: string }

/** 相对路径校验：拒绝绝对路径、盘符、`..`、空段 */
export function isSafeRelativePath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.trim() === '') return false
  const normalized = relPath.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(normalized)) return false
  const parts = normalized.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * 把 `name.ext` 加上序号：`name (1).ext`、`name (2).ext` …
 * 没有扩展名时序号追加在末尾：`name` → `name (1)`。
 */
export function numberedName(relPath: string, index: number): string {
  const normalized = relPath.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  const dir = slash >= 0 ? normalized.slice(0, slash + 1) : ''
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return `${dir}${base} (${index})`
  return `${dir}${base.slice(0, dot)} (${index})${base.slice(dot)}`
}

/**
 * 决定最终写盘目标。
 *
 * @param exists 目标是否已存在（注入，便于单测；`rename` 时会被重复调用）
 */
export function planDownload(
  relPath: string,
  onExist: DownloadOnExist,
  exists: (relPath: string) => boolean,
  joinAbs: (relPath: string) => string
): DownloadTarget {
  if (!isSafeRelativePath(relPath)) {
    return {
      action: 'error',
      message: `下载路径必须是扩展数据目录内的相对路径（不得绝对路径或含 ..）：${relPath}`
    }
  }
  const normalized = relPath.replace(/\\/g, '/')
  if (!exists(normalized)) {
    return { action: 'write', relPath: normalized, absPath: joinAbs(normalized) }
  }
  if (onExist === 'overwrite') {
    return { action: 'write', relPath: normalized, absPath: joinAbs(normalized) }
  }
  if (onExist === 'skip') {
    return { action: 'skip', relPath: normalized, absPath: joinAbs(normalized) }
  }
  // rename：找一个不存在的序号（上限 1000，避免病态目录把事件循环拖死）
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = numberedName(normalized, index)
    if (!exists(candidate)) {
      return { action: 'write', relPath: candidate, absPath: joinAbs(candidate) }
    }
  }
  return { action: 'error', message: `同名文件过多，无法自动重命名：${normalized}` }
}
