import { app, protocol, net } from 'electron'
import { realpathSync } from 'node:fs'
import { join, sep } from 'path'
import { pathToFileURL } from 'url'
import { getExtensionRoots, getPageRuntimeDir } from './paths'
import { resolveAppUrl } from './appUrlCore'
import { existsSync } from 'node:fs'
import type { DebugExtensionsMap } from './debug'

/**
 * 注册 app:// 自定义协议。
 * 用途：渲染进程动态 import 用户扩展入口（ESM 跨源加载受 file:// 限制，自定义协议可绕过）。
 *
 * 映射（解析逻辑在 `appUrlCore.ts`，本文件只做 Electron 接线）：
 *   app://extensions/<id>/<rest>  →  userData/extensions/<id>/<rest>（系统根优先）
 *   app://builtin/<id>/<rest>     →  resources/extensions/<id>/<rest>
 *   app://debug/<id>/<rest>       →  --debug-extension 声明的本地目录（调试扩展，不安装）
 *   app://obox/<rest>             →  宿主页面运行时目录（扩展页面的一行接入脚本）
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

export function registerExtensionProtocol(debugExtensions?: DebugExtensionsMap): void {
  app.whenReady().then(() => {
    protocol.handle('app', (request) => {
      const roots = getExtensionRoots()
      const resolved = resolveAppUrl(request.url, {
        systemRoot: roots.systemRoot,
        userRoot: roots.userRoot,
        pageRuntimeDir: getPageRuntimeDir(),
        debugExtensions,
        exists: (dir) => existsSync(join(dir, 'manifest.json'))
      })
      if (resolved.status !== 200) {
        return new Response(resolved.reason, { status: resolved.status })
      }

      const { filePath, root } = resolved
      // 符号链接防护：若目标存在，解析真实路径后再校验仍在原根内
      // （data 目录内若有指向外部的链接，仅靠字符串校验挡不住）
      try {
        const real = realpathSync(filePath)
        if (!real.startsWith(root + sep) && real !== root) {
          return new Response('forbidden', { status: 403 })
        }
      } catch {
        // 目标不存在：交给下面 file:// 的 fetch 返回 404
      }

      return net.fetch(pathToFileURL(filePath).toString())
    })
  })
}
