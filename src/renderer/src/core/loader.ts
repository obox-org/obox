/**
 * 扩展加载器：组装 host.start() 的输入。
 * - 内置扩展：随应用打包（Vite import.meta.glob 静态收集，dev/prod 都可靠），只读不可卸载
 * - 用户扩展：userData/extensions 目录，主进程扫描清单，经 app:// 协议运行时动态 import
 */
import type { ExtensionInfo, ExtensionManifest, ExtensionModule } from './types'
import { validateManifest } from './manifest'
import type { ExtensionEntry } from './host'

// ---- 内置扩展：Vite 静态收集（manifest + 入口同目录） ----

// 注意：glob 模式匹配的是相对本文件的路径；扩展目录位于 src/renderer/src/extensions/
// 不指定 import: 'default'：loader() 必须返回完整模块（default 插件 + 具名导出视图组件）
const builtinModules = import.meta.glob<ExtensionModule>('../extensions/*/index.ts', {
  eager: false
})

async function loadBuiltinManifest(id: string): Promise<ExtensionManifest | null> {
  // 用 import.meta.glob 拉 manifest（eager JSON）
  const manifests = import.meta.glob<ExtensionManifest>('../extensions/*/manifest.json', {
    eager: true,
    import: 'default'
  })
  for (const [path, manifest] of Object.entries(manifests)) {
    if (path.includes(`/extensions/${id}/`)) return manifest
  }
  return null
}

export async function collectBuiltinExtensions(): Promise<ExtensionEntry[]> {
  const result: ExtensionEntry[] = []
  const seen = new Set<string>()
  for (const [path, loader] of Object.entries(builtinModules)) {
    const match = path.match(/\/extensions\/([^/]+)\/index\.ts$/)
    if (!match) continue
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    const manifest = await loadBuiltinManifest(id)
    if (!manifest) {
      console.warn(`[loader] 内置扩展 ${id} 缺少 manifest.json`)
      continue
    }
    result.push({ id, manifest, source: 'builtin', load: () => loader() })
  }
  return result
}

// ---- 用户扩展：主进程扫描 + app:// 动态 import ----

async function fetchUserManifest(id: string): Promise<ExtensionManifest | null> {
  try {
    const res = await fetch(`app://extensions/${encodeURIComponent(id)}/manifest.json`)
    if (!res.ok) return null
    return (await res.json()) as ExtensionManifest
  } catch {
    return null
  }
}

/** 主进程返回用户扩展清单（目录名 → manifest），过滤无效项 */
export async function collectUserExtensions(): Promise<ExtensionEntry[]> {
  const entries = await window.api.listUserExtensions()
  const result: ExtensionEntry[] = []
  for (const entry of entries) {
    const manifest = await fetchUserManifest(entry.id)
    if (!manifest) {
      console.warn(`[loader] 用户扩展 ${entry.id} manifest 读取失败或缺失`)
      continue
    }
    if (validateManifest(manifest).some((v) => v.severity === 'error')) continue
    result.push({
      id: entry.id,
      manifest,
      source: 'user',
      load: () =>
        import(
          /* @vite-ignore */ `app://extensions/${encodeURIComponent(entry.id)}/${manifest.main}`
        )
    })
  }
  return result
}

/** 供扩展管理器使用的完整信息（含用户扩展的安装时间等由宿主管理） */
export type { ExtensionInfo }
