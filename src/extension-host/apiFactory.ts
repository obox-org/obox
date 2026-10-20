/**
 * 扩展 API 工厂：宿主进程按 `extId` **现场构造** `api`（ADR-0026 决策 4：保持 `plugin(api)` 写法不变）。
 *
 * 能力落地进度：
 * - **EH-A3**：`fs`（readFile/writeFile/readDir/exists/remove）/ `timer` + 只读信息（`appInfo` /
 *   `env` / `log`）；
 * - **EH-B1**：IO 族补齐——`fs.watch` / `fs.unwatch` / `net.fetch` / `clipboard.*`，实现落在
 *   `./capabilities/io.ts`（`env` 也搬过去，5 个成员在一处定义）；
 * - 其余仍是**显式桩**：抛 `EH_INTERNAL` + 「该能力尚未迁移，见 docs/extension-host-migration.md 阶段 B」。
 *
 * 为什么桩也要显式写出来，而不是「先不提供这些命名空间」：
 * - 形状必须与 `src/api/types.ts` 的 `ExtensionActivationApi` 对齐——扩展代码是按那个类型写的，
 *   缺命名空间会让 `api.statusBar` 变成 `undefined`，报错点在扩展里（`Cannot read properties of
 *   undefined`），排查成本远高于「能力尚未迁移」这句人话；
 * - 桩**当场抛**而不是返回假值：假的成功返回会让扩展以为写进去了，属于静默失败（ADR-0026
 *   明确要避免的降级风格）；
 * - 桩携带统一标记（`STUB_MARK`），因此「已实现 / 桩」对照表是**从 api 对象本身推导**出来的
 *   （`listApiImplementation`），不会与实现漂移。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Memento } from '../api/shared'
import type { ExtensionActivationApi } from '../api/types'
import type { HostedExtensionInfo, LogLevel } from '../shared/extensionHostProtocol'
import { createIoCapabilities, resolveInsideDataDir, type HostMainBridge } from './capabilities/io'
import { stubCapabilityError, toErrorMessage } from './errors'
import type { HostLogger } from './log'
import type { SafeRunner } from './safety'
import { unrefTimer } from './timers'

/* -------------------------------------------------------------------------------------------- */
/* 对照表（已实现 / 桩）                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** 一项能力的落地状态 */
export type ApiImplementationStatus = 'implemented' | 'stub'

/** 对照表的一行（`capability` 用 `fs.readFile` 这种点分路径） */
export interface ApiImplementationRow {
  capability: string
  status: ApiImplementationStatus
}

/**
 * 桩函数上的标记（能力名）。用字符串键而不是 Symbol：`Object.getOwnPropertySymbols` 在
 * 调试/日志里不可读，且函数对象上的自定义字符串属性不会被 `postMessage`/JSON 带到对端。
 */
const STUB_MARK = '__oboxExtensionHostStub'

/** 桩函数（同步）：**零参数**——少参数函数可赋给任意签名，避免为每个桩写一遍参数表 */
type StubSync = () => never

/** 桩函数（异步）：返回永远 reject 的 Promise，`await api.net.fetch()` 能被 try/catch 捕到 */
type StubAsync = () => Promise<never>

/** 造同步桩：调用即抛 `EH_INTERNAL` + 迁移提示 */
function stubSync(capability: string): StubSync {
  const fn = (): never => {
    throw stubCapabilityError(capability)
  }
  Object.defineProperty(fn, STUB_MARK, { value: capability, enumerable: false })
  return fn
}

/** 造异步桩：调用返回 rejected Promise（与真实能力的异步形状一致） */
function stubAsync(capability: string): StubAsync {
  const fn = async (): Promise<never> => {
    throw stubCapabilityError(capability)
  }
  Object.defineProperty(fn, STUB_MARK, { value: capability, enumerable: false })
  return fn
}

/** 该函数是否是桩（是则返回其能力名） */
function stubMarkerOf(value: unknown): string | undefined {
  if (typeof value !== 'function') return undefined
  const marker = (value as unknown as Record<string, unknown>)[STUB_MARK]
  return typeof marker === 'string' ? marker : undefined
}

/**
 * 从 api 对象**推导**「已实现 / 桩」对照表：递归遍历命名空间，函数看桩标记，
 * 常量（`env.platform` / `i18n.locale`）算已实现。
 */
export function listApiImplementation(api: HostedExtensionApi): ApiImplementationRow[] {
  const rows: ApiImplementationRow[] = []
  const walk = (prefix: string, value: unknown): void => {
    if (typeof value === 'function') {
      rows.push({
        capability: prefix,
        status: stubMarkerOf(value) === undefined ? 'implemented' : 'stub'
      })
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        walk(prefix === '' ? key : `${prefix}.${key}`, child)
      }
      return
    }
    rows.push({ capability: prefix, status: 'implemented' })
  }
  walk('', api)
  return rows
}

/**
 * 宿主实现在 `ExtensionActivationApi` 之外的**唯一**额外成员：扩展写宿主日志。
 *
 * 为什么加它：宿主进程的 stdout/stderr 打包后不可见（见 `log.ts` 文件头），而扩展在前几个阶段
 * 还没有 `api.output`（阶段 B5）。给一个最小的 `api.log(message)` 能让扩展在迁移期把关键信息
 * 送进宿主日志，且它的形状不会与将来的 `api.output` 冲突（`output` 是通道，不是单行日志）。
 */
export interface HostLoggingApi {
  /** 写一条宿主日志（`log` 信封；`level` 缺省 `info`） */
  log(message: string, level?: LogLevel): void
}

/** 宿主实际注入给扩展的 api：`ExtensionActivationApi` 的**子集实现 + 桩**，外加 `log` */
export type HostedExtensionApi = ExtensionActivationApi & HostLoggingApi

/* -------------------------------------------------------------------------------------------- */
/* fs 能力                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * 把 Node 的 errno 错误包成中文可读的错误（保留原始文本，便于排查）。
 *
 * 路径白名单（`resolveInsideDataDir`）本文件不再自己实现，统一在 `./capabilities/io.ts`：
 * `fs` 读写与 `fs.watch` 必须用**同一套**校验，抄两份迟早分叉。
 */
async function withFsError<T>(action: string, rel: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    throw new Error(`${action}失败（${rel}）：${toErrorMessage(error)}`)
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 工厂                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** `createExtensionApi` 的参数 */
export interface ExtensionApiOptions {
  /** 该扩展的清单摘要（`id` 用于日志与隔离归属） */
  ext: HostedExtensionInfo
  /** **扩展自己的** data 目录绝对路径（`loader.dataDirFor(extId)` 的结果） */
  extensionDataDir: string
  /** 应用信息（`api.appInfo` / `api.env.getOboxVersion` 的来源） */
  appInfo: { name: string; version: string }
  /** 当前 UI 语言（`api.env.language`） */
  locale: string
  /** 宿主日志（`api.log` 的落点） */
  log: HostLogger
  /**
   * 绑定了错误上报的隔离执行壳（`api.timer` / `api.fs.watch` 的回调经它跑）：
   * 扩展回调里抛错 → 落 `log` + 状态表，**不**升级成宿主级异常。
   */
  runSafely: SafeRunner
  /**
   * 宿主 → main 的请求通道（EH-B1）。
   *
   * 用途只有两处：`net.fetch` 读代理/忽略 SSL 设置（`host.proxyConfig`）、`clipboard` 转给 main
   * （`host.clipboard`）。**可选**：缺省时 `net.fetch` 回落环境变量、`clipboard` 明确报错，
   * 这样本文件在没有 main 侧的宿主里也能跑（单测与回退期都用这个分支）。
   */
  hostMain?: HostMainBridge
}

/** 构造结果：api + 对照表 + 清理 */
export interface BuiltExtensionApi {
  /** 注入给 `plugin(api)` 的对象 */
  readonly api: HostedExtensionApi
  /** 已实现 / 桩 对照表（从 `api` 对象推导，供宿主自检与文档核对） */
  readonly implementation: ApiImplementationRow[]
  /** 清掉该扩展的全部定时器与文件监听（停用/退出时调用；幂等） */
  dispose(): void
}

/** 一个扩展的定时器句柄 */
interface ExtensionTimer {
  readonly kind: 'timeout' | 'interval'
  readonly handle: ReturnType<typeof setTimeout>
}

/**
 * 按扩展构造 api。
 *
 * 输入全部由宿主注入（`extensionDataDir` / `appInfo` / `locale` / `log` / `runSafely`），
 * 因此本函数是**纯装配**，不含任何宿主状态，可单测（`test/extension-host-runtime.test.ts` 直接用它
 * 验 `fs` 与 `timer`）。
 */
export function createExtensionApi(options: ExtensionApiOptions): BuiltExtensionApi {
  const extId = options.ext.id
  const root = path.resolve(options.extensionDataDir)
  const timers = new Map<string, ExtensionTimer>()

  const clearTimer = (id: string): void => {
    const timer = timers.get(id)
    if (!timer) return
    timers.delete(id)
    if (timer.kind === 'timeout') clearTimeout(timer.handle)
    else clearInterval(timer.handle)
  }

  const assertSeconds = (api: string, seconds: number): void => {
    if (!Number.isInteger(seconds) || seconds < 1) {
      throw new Error(`${api} 的 seconds 必须是 ≥1 的整数（秒，宿主 timer 为秒粒度）`)
    }
  }

  const assertTimerId = (api: string, id: string): void => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${api} 的 id 必须是非空字符串`)
    }
  }

  const assertCallback = (api: string, callback: unknown): void => {
    if (typeof callback !== 'function') {
      throw new Error(`${api} 的 callback 必须是函数`)
    }
  }

  /* ---------------------------------- 已实现：IO 族 ---------------------------------- */

  // EH-B1：IO 族（fs.watch/unwatch、net、env、clipboard）的实现在 capabilities/io.ts。
  // 这里只装配：白名单（root）、隔离执行壳、main 通道全部由本函数注入，io.ts 不含宿主状态。
  const io = createIoCapabilities({
    extId,
    extensionDataDir: root,
    appInfo: options.appInfo,
    locale: options.locale,
    log: options.log,
    runSafely: options.runSafely,
    hostMain: options.hostMain
  })

  /* ---------------------------------- 已实现：fs ---------------------------------- */

  const fsApi: ExtensionActivationApi['fs'] = {
    async readFile(rel: string): Promise<string> {
      return withFsError('读取文件', rel, () => readFile(resolveInsideDataDir(root, rel), 'utf8'))
    },
    async writeFile(rel: string, content: string): Promise<void> {
      return withFsError('写入文件', rel, async () => {
        const absolute = resolveInsideDataDir(root, rel)
        await mkdir(path.dirname(absolute), { recursive: true })
        await writeFile(absolute, content, 'utf8')
      })
    },
    async readDir(rel: string): Promise<Array<{ name: string; isDir: boolean }>> {
      return withFsError('列出目录', rel, async () => {
        const entries = await readdir(resolveInsideDataDir(root, rel), { withFileTypes: true })
        return entries
          .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
          .sort((left, right) => left.name.localeCompare(right.name))
      })
    },
    async exists(rel: string): Promise<boolean> {
      // exists 刻意**不**把 ENOENT 当错误抛：它问的就是「在不在」。
      // 越界路径仍然抛（那是调用错误，不是「不存在」）。
      const absolute = resolveInsideDataDir(root, rel)
      try {
        await stat(absolute)
        return true
      } catch {
        return false
      }
    },
    async remove(rel: string): Promise<void> {
      return withFsError('删除', rel, async () => {
        await rm(resolveInsideDataDir(root, rel), { recursive: true, force: true })
      })
    },
    watch: io.fsWatch.watch,
    unwatch: io.fsWatch.unwatch
  }

  /* --------------------------------- 已实现：timer -------------------------------- */

  const timerApi: ExtensionActivationApi['timer'] = {
    setTimeout(id: string, seconds: number, callback: () => void): void {
      assertTimerId('timer.setTimeout', id)
      assertSeconds('timer.setTimeout', seconds)
      assertCallback('timer.setTimeout', callback)
      clearTimer(id) // 同 id 重复设置 = 重置（与既有 api 语义一致）
      const handle = setTimeout((): void => {
        clearTimer(id)
        // 回调经隔离壳跑：抛错落日志 + 状态表，不升级成宿主级异常
        void options.runSafely(extId, () => callback(), 'timer')
      }, seconds * 1000)
      unrefTimer(handle)
      timers.set(id, { kind: 'timeout', handle })
    },
    setInterval(id: string, seconds: number, callback: () => void): void {
      assertTimerId('timer.setInterval', id)
      assertSeconds('timer.setInterval', seconds)
      assertCallback('timer.setInterval', callback)
      clearTimer(id)
      const handle = setInterval((): void => {
        void options.runSafely(extId, () => callback(), 'timer')
      }, seconds * 1000)
      unrefTimer(handle)
      timers.set(id, { kind: 'interval', handle })
    },
    clearTimeout(id: string): void {
      if (timers.get(id)?.kind === 'timeout') clearTimer(id)
    },
    clearInterval(id: string): void {
      if (timers.get(id)?.kind === 'interval') clearTimer(id)
    }
  }

  /* ------------------------------ 已实现：appInfo / log ------------------------------ */

  const appInfo: ExtensionActivationApi['appInfo'] = {
    async get(): Promise<{ name: string; version: string }> {
      return { name: options.appInfo.name, version: options.appInfo.version }
    }
  }

  // `env` 由 capabilities/io.ts 统一给出（5 个成员与 `src/api/types.ts` 的声明一一对应）。
  const env: ExtensionActivationApi['env'] = io.env

  const log: HostLoggingApi['log'] = (message: string, level: LogLevel = 'info'): void => {
    options.log(level, `[${extId}] ${message}`)
  }

  /* ------------------------------------ 桩部分 ------------------------------------ */

  const mementoStub = (prefix: string): Memento => ({
    keys: stubSync(`${prefix}.keys`),
    get: stubSync(`${prefix}.get`),
    update: stubAsync(`${prefix}.update`)
  })

  const statusBarStub: ExtensionActivationApi['statusBar'] = {
    setText: stubSync('statusBar.setText'),
    setTooltip: stubSync('statusBar.setTooltip'),
    show: stubSync('statusBar.show'),
    hide: stubSync('statusBar.hide'),
    createItem: stubSync('statusBar.createItem')
  }

  const ipcStub: ExtensionActivationApi['ipc'] = {
    connect: stubAsync('ipc.connect'),
    listen: stubAsync('ipc.listen'),
    close: stubAsync('ipc.close'),
    channels: stubAsync('ipc.channels'),
    request: stubAsync('ipc.request'),
    notify: stubAsync('ipc.notify'),
    broadcast: stubAsync('ipc.broadcast'),
    onRequest: stubSync('ipc.onRequest'),
    onNotification: stubSync('ipc.onNotification'),
    onClose: stubSync('ipc.onClose'),
    onStderr: stubSync('ipc.onStderr'),
    onConnection: stubSync('ipc.onConnection'),
    onDisconnect: stubSync('ipc.onDisconnect'),
    onReconnect: stubSync('ipc.onReconnect')
  }

  const api: HostedExtensionApi = {
    registerCommand: stubSync('registerCommand'),
    executeCommand: stubAsync('executeCommand'),
    statusBar: statusBarStub,
    navbar: { setBadge: stubSync('navbar.setBadge') },
    workspaceState: mementoStub('workspaceState'),
    globalState: mementoStub('globalState'),
    on: stubSync('on'),
    emit: stubSync('emit'),
    window: {
      minimize: stubAsync('window.minimize'),
      toggleMaximize: stubAsync('window.toggleMaximize'),
      close: stubAsync('window.close'),
      isMaximized: stubAsync('window.isMaximized'),
      setProgressBar: stubAsync('window.setProgressBar'),
      isFocused: stubAsync('window.isFocused'),
      onFocusChanged: stubSync('window.onFocusChanged')
    },
    appInfo,
    app: {
      register: stubSync('app.register'),
      onMessage: stubSync('app.onMessage')
    },
    overlay: {
      create: stubAsync('overlay.create'),
      destroy: stubAsync('overlay.destroy'),
      setMouseThrough: stubAsync('overlay.setMouseThrough'),
      setPosition: stubAsync('overlay.setPosition')
    },
    i18n: {
      t: stubSync('i18n.t'),
      // `locale` 是只读常量，不是能力调用：直接给真实值（读它不该抛错），
      // 真正的翻译表迁移在阶段 B5。
      get locale(): string {
        return options.locale
      },
      onLocaleChanged: stubSync('i18n.onLocaleChanged'),
      registerMessages: stubSync('i18n.registerMessages')
    },
    settings: {
      register: stubSync('settings.register'),
      get: stubSync('settings.get'),
      set: stubSync('settings.set'),
      onChanged: stubSync('settings.onChanged')
    },
    update: {
      getVersion: stubAsync('update.getVersion'),
      resolveFeed: stubAsync('update.resolveFeed'),
      check: stubAsync('update.check'),
      download: stubAsync('update.download'),
      install: stubAsync('update.install'),
      onEvent: stubSync('update.onEvent')
    },
    proxy: { get: stubSync('proxy.get') },
    timer: timerApi,
    sqlite: { open: stubAsync('sqlite.open') },
    notification: { show: stubAsync('notification.show') },
    net: io.net,
    dialog: {
      showOpenDialog: stubAsync('dialog.showOpenDialog'),
      showSaveDialog: stubAsync('dialog.showSaveDialog'),
      showMessageBox: stubAsync('dialog.showMessageBox')
    },
    shell: {
      openExternal: stubAsync('shell.openExternal'),
      openPath: stubAsync('shell.openPath')
    },
    clipboard: io.clipboard,
    env,
    theme: {
      getCurrent: stubSync('theme.getCurrent'),
      onChanged: stubSync('theme.onChanged')
    },
    fs: fsApi,
    ui: {
      showQuickPick: stubAsync('ui.showQuickPick'),
      showInputBox: stubAsync('ui.showInputBox'),
      showMessage: stubSync('ui.showMessage'),
      showForm: stubAsync('ui.showForm'),
      withProgress: stubAsync('ui.withProgress')
    },
    ipc: ipcStub,
    output: { createChannel: stubSync('output.createChannel') },
    python: { run: stubAsync('python.run') },
    secrets: {
      get: stubAsync('secrets.get'),
      set: stubAsync('secrets.set'),
      delete: stubAsync('secrets.delete')
    },
    views: { registerTreeProvider: stubSync('views.registerTreeProvider') },
    log
  }

  let disposed = false
  return {
    api,
    implementation: listApiImplementation(api),
    dispose(): void {
      if (disposed) return
      disposed = true
      // 监听句柄必须真的关掉：漏一个 inotify/FSEvents 句柄会让宿主退出时被拖住
      io.dispose()
      for (const id of [...timers.keys()]) clearTimer(id)
    }
  }
}
