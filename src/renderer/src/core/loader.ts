/**
 * 扩展加载器：组装 host.start() 的输入。
 * - 内置扩展：随应用打包（Vite import.meta.glob 静态收集，dev/prod 都可靠），只读不可卸载
 * - 用户扩展：userData/extensions 目录，主进程扫描清单，经 app:// 协议运行时动态 import
 */
import type { ExtensionInfo, ExtensionManifest, ExtensionModule } from './types'
import type { DebugExtensionEntry, ExtensionMeta } from '../../../shared/types'
import type { ActivationReason, HostedExtensionInfo } from '../../../shared/extensionHostProtocol'
import {
  analyzeActivationEvents,
  validateManifest,
  withDefaultActivation,
  type ManifestWithActivationEvents
} from './manifest'
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

/** 从任意 app:// 基址拉取 manifest（调试扩展用 app://debug/<id>/） */
async function fetchManifestFrom(base: string): Promise<ExtensionManifest | null> {
  try {
    const res = await fetch(`${base}manifest.json`)
    if (!res.ok) return null
    return (await res.json()) as ExtensionManifest
  } catch {
    return null
  }
}

/**
 * 调试扩展（--debug-extension <id>@<path> 声明）：本地目录直接加载，不做 .oix 安装。
 * 经 app://debug/<id>/ 访问其 manifest 与入口。
 */
export async function collectDebugExtensions(
  entries: DebugExtensionEntry[]
): Promise<ExtensionEntry[]> {
  const result: ExtensionEntry[] = []
  for (const entry of entries) {
    const base = `app://debug/${encodeURIComponent(entry.id)}/`
    const manifest = await fetchManifestFrom(base)
    if (!manifest) {
      console.warn(`[loader] 调试扩展 ${entry.id} manifest 读取失败或缺失（${entry.path}）`)
      continue
    }
    if (validateManifest(manifest).some((v) => v.severity === 'error')) continue
    result.push({
      id: entry.id,
      manifest,
      source: 'debug',
      load: () => import(/* @vite-ignore */ `${base}${manifest.main}`)
    })
  }
  return result
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
    const meta = await fetchExtensionMeta(entry.id)
    result.push({
      id: entry.id,
      manifest,
      source: 'user',
      // 宿主据此 `require`/`import` 入口（EH-A4 的清单交接要用它；只读展示路径不用）
      path: entry.path,
      installedTimestamp: meta.installedTimestamp,
      pendingInstall: meta.pendingInstall,
      previousInstallVersion: meta.install?.version,
      load: () =>
        import(
          /* @vite-ignore */ `app://extensions/${encodeURIComponent(entry.id)}/${manifest.main}`
        )
    })
  }
  return result
}

/**
 * 读取 .oix 安装时写入的 .obox-meta.json（安装时间戳 + 钩子状态；缺失返回空对象）。
 * 解析失败一律当空处理——旧安装没有钩子字段也照常工作（issue #52）。
 */
async function fetchExtensionMeta(id: string): Promise<ExtensionMeta> {
  try {
    const res = await fetch(`app://extensions/${encodeURIComponent(id)}/.obox-meta.json`)
    if (!res.ok) return {}
    const meta = (await res.json()) as ExtensionMeta
    return meta && typeof meta === 'object' ? meta : {}
  } catch {
    return {}
  }
}

/**
 * 热安装用：按目录名构造单个用户扩展条目（安装 .oix 后立即加载）。
 * 返回 null 表示该扩展不在 userData/extensions（或 manifest 无效）。
 */
export async function buildUserExtensionEntry(id: string): Promise<ExtensionEntry | null> {
  const entries = await window.api.listUserExtensions()
  const listed = entries.find((e) => e.id === id)
  if (!listed) return null
  const manifest = await fetchUserManifest(id)
  if (!manifest) return null
  if (validateManifest(manifest).some((v) => v.severity === 'error')) return null
  const meta = await fetchExtensionMeta(id)
  return {
    id,
    manifest,
    source: 'user',
    // 同上：宿主加载入口需要绝对路径
    path: listed.path,
    installedTimestamp: meta.installedTimestamp,
    pendingInstall: meta.pendingInstall,
    previousInstallVersion: meta.install?.version,
    load: () =>
      import(/* @vite-ignore */ `app://extensions/${encodeURIComponent(id)}/${manifest.main}`)
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 清单交接（EH-A4）：用户扩展 → 扩展宿主进程                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * 清单里缺失 `apiVersion` 时上报的版本。
 *
 * 协议要求 `apiVersion` 是 ≥1 的整数，而旧清单完全可能没有这个字段（`src/api/manifest.ts`：
 * "缺失视为 0（兼容所有）"）。上报 **1** 而不是宿主当前的 3：宿主据此判定"该扩展不挑版本"，
 * 报了 3 会让宿主以为它需要 v3 能力面。
 */
export const FALLBACK_HOSTED_API_VERSION = 1

/**
 * 清单里的激活事件 → 宿主要的结构化 `ActivationReason[]`（EH-C1 起清单校验已把这些规则升级成
 * **error**：带非法事件的扩展在 `collectUserExtensions` / `buildUserExtensionEntry` 就被判无效、
 * 不再进来。这里保留一遍"丢弃 + 告警"是纵深防御：热重载、旧清单快照、将来新增的读取点都可能绕过
 * 扫描期校验）。
 *
 * - 解析与校验**只走** `core/manifest.ts` 的 `analyzeActivationEvents`（内部复用宿主侧
 *   `parseActivationEvent`），本文件不写第二份解析；
 * - 缺失 / 空数组 / 全非法 ⇒ `['*']`（今天的默认行为：立即激活）。
 */
function hostedActivationEvents(manifest: ExtensionManifest): ActivationReason[] {
  const raw = (manifest as ManifestWithActivationEvents).activationEvents
  const { reasons, problems } = analyzeActivationEvents(raw)
  for (const problem of problems) {
    console.warn(`[loader] ${problem}（已忽略该条，其余照常上报）`)
  }
  return withDefaultActivation(reasons)
}

/** 清单声明的 apiVersion（缺失/非法回落 `FALLBACK_HOSTED_API_VERSION`） */
function hostedApiVersion(manifest: ExtensionManifest): number {
  const declared = manifest.apiVersion
  if (typeof declared === 'number' && Number.isInteger(declared) && declared >= 1) return declared
  return FALLBACK_HOSTED_API_VERSION
}

/**
 * 把用户扩展条目映射成宿主需要的清单摘要（`HostedExtensionInfo[]`，EH-A4 的交接载荷）。
 *
 * **纯映射，不读磁盘**：manifest 已在 `collectUserExtensions()` 里读好，`path` 由主进程的
 * `extensions:list-user` 给出（绝对路径）。内置扩展与调试扩展**不进这份清单**：
 * - 内置扩展继续在渲染进程执行（迁移计划的非目标：不改内置扩展构建方式）；
 * - 调试扩展是本地 dev 路径（`--debug-extension`），留给实机验证卡再定。
 *
 * **清单校验失败 ⇒ 不收集**（EH-C1）：三个 `collect*` / `buildUserExtensionEntry` 入口都在构造
 * `ExtensionEntry` 前跑过 `validateManifest`，`activationEvents` 写错的扩展根本到不了这里。这个
 * 保证留在过滤侧而不是这里，是为了让"无效扩展"的判定只有一个出处（`core/manifest.ts`）。
 */
export function collectHostedExtensions(entries: ExtensionEntry[]): HostedExtensionInfo[] {
  const hosted: HostedExtensionInfo[] = []
  for (const entry of entries) {
    if (entry.source !== 'user') continue
    if (!entry.path) {
      console.warn(`[loader] 用户扩展 ${entry.id} 没有目录路径（主进程清单缺 path），跳过清单交接`)
      continue
    }
    const version = entry.manifest.version
    hosted.push({
      id: entry.id,
      // 空/非字符串版本号会被信封校验拒掉（badText），这里先兜住
      version: typeof version === 'string' && version.trim() !== '' ? version : '0.0.0',
      path: entry.path,
      activationEvents: hostedActivationEvents(entry.manifest),
      apiVersion: hostedApiVersion(entry.manifest)
    })
  }
  return hosted
}

/** 供扩展管理器使用的完整信息（含用户扩展的安装时间等由宿主管理） */
export type { ExtensionInfo }
