/**
 * 扩展**清单加载**：从 `init` 信封的 `HostedExtensionInfo[]` 建立宿主侧的扩展记录。
 *
 * 三条硬约束（ADR-0026 决策 8 + 本卡要求 3）：
 * 1. **不自己扫盘**：用户装了哪些扩展只有一处真相（main/渲染侧的安装器）。宿主只认 `init`
 *    里给的数组，装了什么就加载什么——两边各扫一遍目录迟早会出现「装了但宿主不知道」。
 * 2. **`apiVersion <= init.apiVersion`**：不满足则该扩展标记为**不可加载**（`rejected`），
 *    **不让宿主崩**、也不阻止其它扩展加载。为什么是「小于等于」：扩展声明的是「我需要的
 *    最小能力面」，宿主能提供 ≥ 它的版本即可；反过来宿主版本更旧时，扩展可能用到宿主没有的
 *    API（例如 v3 才有宿主进程），静默失败比拒绝加载更难排查。
 * 3. **入口用 `import()`**：用户扩展是纯 ESM（`.mjs` / `"type":"module"`），不能用 `require`。
 *
 * 入口路径由扩展自己的 `manifest.json` 的 `main` 决定（没有就用 `index.js`）——这是**读一个已知
 * 文件**，不是扫目录；清单摘要里没有 `main` 字段，所以只能从这里取。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EH_ERROR_TEXT,
  EhProtocolError,
  type HostedExtensionInfo
} from '../shared/extensionHostProtocol'
import { toErrorMessage } from './errors'
import type { HostLogger } from './log'

/** 扩展入口模块的**命名空间**（`import()` 的返回值；`default` 即 `plugin(api)`） */
export interface ExtensionEntryModule {
  readonly default?: unknown
  readonly [key: string]: unknown
}

/** 加载结果状态：`loadable` 可参与激活；`rejected` 连 `import()` 都不做 */
export type ExtensionLoadState = 'loadable' | 'rejected'

/** 一个扩展的加载记录（宿主侧） */
export interface LoadedExtension {
  /** `init` 里的清单摘要（权威） */
  readonly info: HostedExtensionInfo
  /** 是否可加载 */
  readonly state: ExtensionLoadState
  /** 入口文件的绝对路径 */
  readonly entryPath: string
  /** 不可加载的原因（`state === 'rejected'` 时必有） */
  readonly reason?: string
}

/** 可注入依赖（单测用；生产用默认实现） */
export interface ExtensionLoaderOptions {
  /** 宿主可用的能力面版本（= `init.apiVersion`） */
  hostApiVersion: number
  /** 宿主数据目录（扩展 data 目录的父目录） */
  dataDir: string
  /** 日志 */
  log: HostLogger
  /** 读扩展 `manifest.json` 的 `main`（缺省读磁盘；测试可注入） */
  readEntryMain?: (extensionDir: string) => string | null
  /** 动态 import（缺省真 `import()`；测试可注入） */
  importModule?: (url: string) => Promise<unknown>
}

/** 清单文件（扩展根目录内） */
const MANIFEST_FILE = 'manifest.json'

/** 清单没写 `main` 时的缺省入口 */
const DEFAULT_ENTRY = 'index.js'

/**
 * 合法扩展 id：字母数字开头，只含字母数字与 `.` `_` `-`。
 *
 * 这条校验不是洁癖：`id` 会被拼进**文件路径**（`<dataDir>/<id>`，见 `dataDirFor`），
 * 允许 `../` 就等于让一个畸形清单把扩展的 fs 根挪到别处。协议层只校验「非空字符串」，
 * 所以宿主侧必须自己把关。
 */
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** `target` 是否在 `root` 内（含 root 本身） */
function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * 默认实现：读 `<扩展目录>/manifest.json` 的 `main`。
 * 读不到/解析失败/没有 `main` 一律返回 `null`（由调用方回落到 `index.js`），
 * 并**不**在这里报错：入口是否真的存在要等 `import()` 才有结论。
 */
function readManifestEntryMain(extensionDir: string): string | null {
  try {
    const raw = readFileSync(path.join(extensionDir, MANIFEST_FILE), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const main = (parsed as { main?: unknown }).main
    if (typeof main !== 'string' || main.trim() === '') return null
    return main.trim()
  } catch {
    return null
  }
}

/** 默认实现：真 `import()`（`/* @vite-ignore *\/` 阻止打包器静态分析变量路径） */
function importFromUrl(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url)
}

/**
 * 宿主侧的扩展加载器。
 *
 * 生命周期：`init` → `prepare()`（校验 + 解析入口）→ 激活时 `loadEntry()`（懒 `import()`）。
 * 懒 import 是**有意**的：`onCommand:` / `onView:` 的扩展不该在启动时就被求值，
 * 否则 `activationEvents` 只能省掉 `plugin(api)`，省不掉模块顶层副作用。
 */
export class ExtensionLoader {
  private readonly hostApiVersion: number
  private readonly dataDir: string
  private readonly log: HostLogger
  private readonly readEntryMain: (extensionDir: string) => string | null
  private readonly importModule: (url: string) => Promise<unknown>
  private readonly records = new Map<string, LoadedExtension>()
  private readonly modules = new Map<string, ExtensionEntryModule>()

  constructor(options: ExtensionLoaderOptions) {
    this.hostApiVersion = options.hostApiVersion
    this.dataDir = options.dataDir
    this.log = options.log
    this.readEntryMain = options.readEntryMain ?? readManifestEntryMain
    this.importModule = options.importModule ?? importFromUrl
  }

  /**
   * 按清单摘要建立记录。**返回全部记录（含 rejected）**，调用方据此播种状态表。
   * 重复 id 只保留第一条并记一条 warn（协议层不保证唯一，宿主必须自己防）。
   */
  prepare(extensions: readonly HostedExtensionInfo[]): LoadedExtension[] {
    const prepared: LoadedExtension[] = []
    for (const info of extensions) {
      if (this.records.has(info.id)) {
        this.log('warn', `init 清单里出现重复扩展 id：${info.id}（忽略后一条）`)
        continue
      }
      const record = this.prepareOne(info)
      this.records.set(info.id, record)
      prepared.push(record)
      if (record.state === 'rejected') {
        this.log('warn', `扩展 ${info.id} 不可加载：${record.reason ?? '原因未知'}`)
      } else {
        this.log('info', `扩展 ${info.id} 入口已解析：${record.entryPath}`)
      }
    }
    return prepared
  }

  /** 全部记录（按 prepare 顺序） */
  all(): LoadedExtension[] {
    return [...this.records.values()]
  }

  /** 取一条记录 */
  get(extId: string): LoadedExtension | undefined {
    return this.records.get(extId)
  }

  /**
   * 扩展自己的数据目录（`fs` 能力的根，与旧版「`<userData>/extensions-data/<id>`」同构）。
   * 不做 mkdir：真正写文件时才建目录（`apiFactory` 的 `writeFile` 会递归建）。
   */
  dataDirFor(extId: string): string {
    return path.join(this.dataDir, extId)
  }

  /**
   * `import()` 扩展入口（带缓存）。
   * 失败一律转成 `EH_ACTIVATION_FAILED`（用户可操作：修好入口/重装扩展），
   * 但也保留原始错误文本与 URL，便于排查「入口不存在」与「入口语法错误」的区别。
   */
  async loadEntry(extId: string): Promise<ExtensionEntryModule> {
    const cached = this.modules.get(extId)
    if (cached) return cached

    const record = this.records.get(extId)
    if (!record) {
      throw new EhProtocolError(
        'EH_UNKNOWN_EXT',
        EH_ERROR_TEXT.EH_UNKNOWN_EXT,
        `扩展 ${extId} 不在 init 清单里`
      )
    }
    if (record.state === 'rejected') {
      throw new EhProtocolError(
        'EH_ACTIVATION_FAILED',
        `扩展 ${extId} 不可加载`,
        record.reason ?? '原因未知'
      )
    }

    const url = pathToFileURL(record.entryPath).href
    try {
      const imported = await this.importModule(url)
      if (typeof imported !== 'object' || imported === null) {
        throw new Error(`入口模块导出不是对象（收到 ${typeof imported}）`)
      }
      const module = imported as ExtensionEntryModule
      this.modules.set(extId, module)
      return module
    } catch (error) {
      if (error instanceof EhProtocolError) throw error
      throw new EhProtocolError(
        'EH_ACTIVATION_FAILED',
        `扩展入口模块加载失败：${extId}`,
        `${url}：${toErrorMessage(error)}`
      )
    }
  }

  /** 校验一条清单摘要并解析入口路径 */
  private prepareOne(info: HostedExtensionInfo): LoadedExtension {
    const entryMain = this.readEntryMain(info.path) ?? DEFAULT_ENTRY
    const entryPath = path.resolve(info.path, entryMain)

    const reject = (reason: string): LoadedExtension => ({
      info,
      state: 'rejected',
      entryPath,
      reason
    })

    if (!EXTENSION_ID_PATTERN.test(info.id)) {
      return reject(
        `扩展 id "${info.id}" 非法：只允许字母、数字与 . _ -，且必须以字母或数字开头（id 会被用作数据目录名）`
      )
    }
    if (info.apiVersion > this.hostApiVersion) {
      return reject(
        `扩展需要 obox API v${info.apiVersion} 或更高，当前宿主为 v${this.hostApiVersion}（请升级 obox）`
      )
    }
    if (!isInsideDirectory(path.resolve(info.path), entryPath)) {
      return reject(`入口路径越出扩展目录：${entryMain}`)
    }
    return { info, state: 'loadable', entryPath }
  }
}
