/**
 * `app://` 请求的**纯解析**（不依赖 electron / 文件系统；change `unified-page-context` 任务 3.2）。
 *
 * 从 `src/main/protocol.ts` 抽出来的原因：协议处理器本身要 `protocol.handle` + `net.fetch` +
 * realpath，没法在 node 单测里跑；而"URL → 磁盘路径 + 越界拒绝"才是安全相关的关键逻辑，
 * 必须能确定性断言（尤其是新加的 `app://obox/` 命名空间）。
 *
 * 映射（与 `docs/extension-api/**` 的说明一致）：
 *   app://extensions/<id>/<rest>  →  系统根优先、用户根兜底的 `<root>/<id>/<rest>`
 *   app://builtin/<rest>          →  系统扩展根 `<rest>`
 *   app://debug/<id>/<rest>       →  `--debug-extension` 声明的目录
 *   app://obox/<rest>             →  宿主页面运行时目录（只读）
 */
import { join, normalize, sep } from 'node:path'
import { resolveExtensionRoot } from './extensionSources'

/** 解析成功：磁盘上的绝对路径 + 它所属的根（realpath 二次校验用） */
export interface AppUrlResolved {
  status: 200
  filePath: string
  root: string
}

/** 解析失败：可直接回给渲染进程的 HTTP 状态 */
export interface AppUrlRejected {
  status: 400 | 403 | 404
  reason: string
}

export type AppUrlResolution = AppUrlResolved | AppUrlRejected

export interface AppUrlContext {
  systemRoot: string
  userRoot: string
  /** 宿主页面运行时所在目录（`app://obox/`） */
  pageRuntimeDir: string
  /** 调试扩展：id → 本地目录 */
  debugExtensions?: ReadonlyMap<string, string>
  /** 系统/用户根解析时用的"该目录是否像一个扩展"判据（生产传 manifest.json 存在性） */
  exists: (dir: string) => boolean
}

const reject = (status: 400 | 403 | 404, reason: string): AppUrlRejected => ({ status, reason })

/**
 * 把一条 `app://` URL 解析成磁盘路径。
 *
 * 安全边界（与旧实现逐条对齐，只增不减）：
 * - 非法百分号转义 → 400（`decodeURIComponent` 会抛 `URIError`，不能让异常逃出协议处理器）；
 * - `..` 段、空路径、未知 host、根解析不到 → 404；
 * - 规范化后必须仍在根目录之下 → 403（防 `%2e%2e` 绕过与盘符拼接）。
 */
export function resolveAppUrl(rawUrl: string, ctx: AppUrlContext): AppUrlResolution {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return reject(400, 'bad url')
  }
  const { hostname, pathname } = url
  let rest: string
  try {
    rest = decodeURIComponent(pathname.replace(/^\/+/, ''))
  } catch {
    return reject(400, 'bad request')
  }

  let root: string | null = null
  if (hostname === 'extensions') {
    const slash = rest.indexOf('/')
    const id = slash < 0 ? rest : rest.slice(0, slash)
    root = resolveExtensionRoot(
      id,
      { systemRoot: ctx.systemRoot, userRoot: ctx.userRoot },
      ctx.exists
    )
  } else if (hostname === 'builtin') {
    root = ctx.systemRoot
  } else if (hostname === 'debug') {
    const slash = rest.indexOf('/')
    const id = slash < 0 ? rest : rest.slice(0, slash)
    const sub = slash < 0 ? '' : rest.slice(slash + 1)
    const dir = ctx.debugExtensions?.get(id)
    if (dir) {
      root = dir
      rest = sub
    }
  } else if (hostname === 'obox') {
    root = ctx.pageRuntimeDir
  }

  if (!root || !rest || rest.includes('..')) {
    return reject(404, 'not found')
  }

  const filePath = normalize(join(root, rest))
  // 二次防护：规范化后必须在 root 之下
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    return reject(403, 'forbidden')
  }
  return { status: 200, filePath, root }
}
