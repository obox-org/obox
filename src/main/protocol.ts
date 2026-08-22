import { app, protocol, net } from 'electron'
import { join, normalize, sep } from 'path'
import { pathToFileURL } from 'url'
import { getUserExtensionsDir } from './capabilities'

/**
 * 注册 app:// 自定义协议。
 * 用途：渲染进程动态 import 用户扩展入口（ESM 跨源加载受 file:// 限制，自定义协议可绕过）。
 *
 * 映射：
 *   app://extensions/<id>/<rest>  →  userData/extensions/<id>/<rest>
 *   app://builtin/<id>/<rest>     →  resources/extensions/<id>/<rest>
 */
// scheme 权限必须在 app ready 前注册（顶层执行）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

export function registerExtensionProtocol(): void {
  app.whenReady().then(() => {
    protocol.handle('app', (request) => {
      const url = new URL(request.url)
      const { hostname, pathname } = url
      const rest = decodeURIComponent(pathname.replace(/^\/+/, ''))

      let root: string | null = null
      if (hostname === 'extensions') root = getUserExtensionsDir()
      else if (hostname === 'builtin') root = join(process.resourcesPath, 'extensions')

      if (!root || !rest || rest.includes('..')) {
        return new Response('not found', { status: 404 })
      }

      const filePath = normalize(join(root, rest))
      // 二次防护：规范化后必须在 root 之下
      if (!filePath.startsWith(root + sep) && filePath !== root) {
        return new Response('forbidden', { status: 403 })
      }

      return net.fetch(pathToFileURL(filePath).toString())
    })
  })
}
