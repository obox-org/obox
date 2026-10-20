/**
 * 扩展 API 工厂：宿主进程按 `extId` **现场构造** `api`（ADR-0026 决策 4：保持 `plugin(api)` 写法不变）。
 *
 * 能力落地进度：
 * - **EH-A3**：`fs`（readFile/writeFile/readDir/exists/remove）/ `timer` + 只读信息（`appInfo` /
 *   `env` / `log`）；
 * - **EH-B1**：IO 族补齐——`fs.watch` / `fs.unwatch` / `net.fetch` / `clipboard.*`，实现落在
 *   `./capabilities/io.ts`（`env` 也搬过去，5 个成员在一处定义）；
 * - **EH-B2**：进程与存储族补齐——`ipc.*`（14 项，`./capabilities/ipc.ts`）、`python.run`
 *   （`./capabilities/python.ts`）、`sqlite.open`（`./capabilities/sqlite.ts`）；
 * - **EH-B3a**：主进程类能力族——`window`(7) / `overlay`(4) / `dialog`(3) / `shell`(2) /
 *   `notification`(1) / `secrets`(3) / `update.getVersion` / `update.onEvent` / `proxy.get`，
 *   实现落在 `./capabilities/host-main.ts`（全部经宿主内部 RPC 回 main）；
 * - 其余仍是**显式桩**：抛 `EH_INTERNAL` + 「该能力尚未迁移，见 docs/extension-host-migration.md 阶段 B」。
 *
 * ## 扩展 data 目录（R62）：唯一计算点
 *
 * 宿主曾经把 `loader.dataDirFor()`（= `<init.dataDir>/<extId>`）直接当扩展 data 目录，而 main 的
 * 约定一直是 `<userData>/extensions/<extId>/data`——两者**不是同一个目录**，照旧路径升级后用户会
 * 发现"扩展的 fs 数据与 `.db` 都不见了"（文件其实还在磁盘上，只是新代码去错了地方）。
 *
 * 唯一权威现在是 `extensionDataDirOf(ext.path)`（`<扩展目录>/data`，与 main 的 `dataDirFor`
 * 逐字一致，`ext.path` 就是 `init.extensions[].path` = `<userData>/extensions/<id>`）。
 * `ExtensionApiOptions.extensionDataDir` 因此**不再参与计算**（保留在签名里是为了不改
 * `runtime.ts` 的调用点，见该字段的注释）。
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
import { mkdirSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Memento } from '../api/shared'
import type { ExtensionActivationApi } from '../api/types'
import {
  EhProtocolError,
  type HostedExtensionInfo,
  type LogLevel
} from '../shared/extensionHostProtocol'
import { createHostMainCapabilities } from './capabilities/host-main'
import { createIoCapabilities, resolveInsideDataDir, type HostMainBridge } from './capabilities/io'
import { createIpcCapabilities } from './capabilities/ipc'
import { createPythonCapabilities } from './capabilities/python'
import { createSqliteCapabilities } from './capabilities/sqlite'
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

/**
 * 造"原因已查清"的异步桩（EH-B3a 的 4 条 `update` 门控方法用）。
 *
 * 为什么不是普通桩：这 4 条不是"还没轮到"，而是**在宿主架构下无法在本卡实现**——门控是
 * "当前生效的更新提供者"，该选择只存在于渲染进程（`stateStore` 的 `update.provider`，
 * 见 `updaterStore.isActive()`），main 与宿主都拿不到（裁定 R64）。
 *
 * 文案仍必须同时含「尚未迁移」与「阶段 B」：那是 `test/extension-host-runtime.test.ts` 对
 * **每一个桩**的统一断言，也是扩展作者查 `docs/extension-host-migration.md` 的入口；
 * 额外补上"该等哪个卡"，避免作者以为是自己的配置问题。
 */
function stubWithReason(capability: string, reason: string): StubAsync {
  const fn = async (): Promise<never> => {
    throw new EhProtocolError('EH_INTERNAL', reason, `api.${capability} 在扩展宿主进程里只有桩`)
  }
  Object.defineProperty(fn, STUB_MARK, { value: capability, enumerable: false })
  return fn
}

/** 同 {@link stubWithReason}，但保持**同步**形状（`ui.showMessage` / `output.createChannel` 在 v1 是同步返回） */
function stubSyncWithReason(capability: string, reason: string): StubSync {
  const fn = (): never => {
    throw new EhProtocolError('EH_INTERNAL', reason, `api.${capability} 在扩展宿主进程里只有桩`)
  }
  Object.defineProperty(fn, STUB_MARK, { value: capability, enumerable: false })
  return fn
}

/**
 * `update` 的 4 条门控方法在宿主里的统一文案（裁定 R64：留桩，不做 fail-closed）。
 *
 * 为什么不 fail-closed（"能调但永远失败"）：那会把它们记成"已实现"，对照表与文档都失真；
 * 扩展作者看到 `EH_INTERNAL`+「尚未迁移」会去查迁移计划，看到「无法确认提供者」会以为是自己
 * 配错了。**语义诚实优先于形状真实。**
 */
const UPDATE_PROVIDER_GATE_REASON =
  'update 的这条方法尚未迁移：它的门控是"当前生效的更新提供者"，而该选择只存在于渲染进程' +
  '（设置-更新的 update.provider），main 与宿主进程都读不到。按裁定 R64 留待 EH-B3b ' +
  '由渲染侧权威判定（真相在哪就在哪判定），见 docs/extension-host-migration.md 阶段 B'

/**
 * `ui` / `output` 在宿主里的统一文案（裁定 R67：归 EH-B3b 的 host-renderer 通道）。
 *
 * 事实：`ui` 的模态框/toast 由渲染进程的 `uiStore` 渲染，`output` 的通道与底部面板由
 * `outputStore` 持有；`src/main/ui.ts` 只会把请求转发给 App 子窗口或回 `{local:true}` 让
 * 渲染侧自己渲染，**main 自己没有任何 UI 渲染能力**。所以宿主扩展要用这两族，必须等
 * 宿主→渲染侧的数据面通道（ADR-0026 的 `host-renderer`，EH-B5 / B3b）落地。
 */
const HOST_RENDERER_DATA_PLANE_REASON =
  '该能力尚未迁移：它属于宿主 → 渲染侧的 UI 数据面（状态栏/面板/toast 等由渲染进程渲染），' +
  '需要 host-renderer 通道，本卡（EH-B3a）只动 main 侧 RPC，按裁定 R67 归阶段 B 的 EH-B3b'

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
/* 扩展 data 目录（R62 的唯一计算点）                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * 扩展 data 目录（**全宿主唯一计算点**）：`<扩展目录>/data`。
 *
 * 为什么必须有这么一个函数而不是各处拼字符串：main 的两处（`src/main/python.ts` 的 `dataDirFor`、
 * `src/main/sqlite.ts` 的 `dataDirFor`）与宿主的 fs / sqlite / python(cwd) 必须**逐字同一个目录**，
 * 否则升级后用户的 fs 数据与 `.db` 会"消失"（见文件头的 R62 说明）。`io` 与 `sqlite` 都从这里拿到
 * 同一个值（`apiFactory` 算一次、注入两处），不存在第二份拼接。
 *
 * 期望 `extensionDir` = `init.extensions[].path`（= `<userData>/extensions/<id>`），于是结果与 main
 * 的 `join(app.getPath('userData'), 'extensions', id, 'data')` 完全一致。
 */
export function extensionDataDirOf(extensionDir: string): string {
  return path.join(path.resolve(extensionDir), 'data')
}

/* -------------------------------------------------------------------------------------------- */
/* 工厂                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** `createExtensionApi` 的参数 */
export interface ExtensionApiOptions {
  /** 该扩展的清单摘要（`id` 用于日志与隔离归属；`path` 是 data 目录的计算基准） */
  ext: HostedExtensionInfo
  /**
   * **已不参与任何计算**（R62）：扩展 data 目录的唯一权威是 {@link extensionDataDirOf}
   * （`<扩展目录>/data` = main 的 `<userData>/extensions/<extId>/data`）。保留该字段只为
   * "没有 `init` 清单"的嵌入场景（单测直接造 api）不改调用方签名；`runtime.ts` 传进来的
   * `loader.dataDirFor()`（`<init.dataDir>/<extId>`）**不会被用来算 data 目录**。
   */
  extensionDataDir?: string
  /**
   * POSIX 套接字目录（`<userData>/ipc`，与 main 的 `ipcSocketDir()` 逐字一致）。
   * R63：由 `runtime.ts` 显式透传 `join(init.dataDir, 'ipc')`；未给时退回 `<扩展 data 目录>/ipc`
   * （仅测试/工具路径会走到）。**不再**从 `extensionDataDir` 反推 userData——那是隐式约定。
   */
  socketDir?: string
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
 * 输入全部由宿主注入（`ext` / `appInfo` / `locale` / `log` / `runSafely` / `hostMain`），
 * 因此本函数是**纯装配**，不含任何宿主状态，可单测（`test/extension-host-runtime.test.ts` 直接用它
 * 验 `fs` 与 `timer`）。
 */
export function createExtensionApi(options: ExtensionApiOptions): BuiltExtensionApi {
  const extId = options.ext.id
  // R62：data 目录只在这里算一次（`<扩展目录>/data`），io / sqlite / python(cwd) 共用同一个值。
  // `mkdir -p`：main 以前在 dataDirFor 之后由各自的 IPC 顺手建，宿主侧统一在装配时建好，
  // 免得"能力没用到就没人建目录"。
  const extensionDir = path.resolve(options.ext.path)
  const root = extensionDataDirOf(extensionDir)
  mkdirSync(root, { recursive: true })
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

  /* ------------------------- 已实现：进程族（ipc / python）与存储族（sqlite） ------------------------- */

  // EH-B2：三条能力族各自一个文件（阶段 B 的并行组 G4 要求文件不相交）：
  // - ipc.ts：stdio sidecar（宿主 spawn）/ pipe、JSON-RPC 2.0、两种分帧、超时、事件与重连；
  //           `extensionDir` 是 `program` 的解析基准（来自 init 清单的 `path`），
  //           `contributes.ipcChannels` 也是宿主自己从该目录的 manifest.json 读的（R61）。
  //           POSIX 套接字目录由 `runtime.ts` 显式透传（R63：`join(init.dataDir, 'ipc')`），
  //           不再从 extensionDataDir 反推 userData（隐式约定，布局一换就静默算错）。
  // - python.ts：经宿主内部 RPC `host.pythonRuntime` 向 main 要 exe/env/cwd，进程与流归宿主。
  // - sqlite.ts：宿主内 `node:sqlite`，路径与建表语义全部复用 main 的 sqliteCore 纯函数。
  const ipc = createIpcCapabilities({
    extId,
    extensionDir,
    extensionDataDir: root,
    ...(options.socketDir === undefined ? {} : { socketDir: options.socketDir }),
    log: options.log
  })
  const python = createPythonCapabilities({
    extId,
    log: options.log,
    hostMain: options.hostMain,
    ipc
  })
  const sqlite = createSqliteCapabilities({ extId, extensionDataDir: root, log: options.log })

  /* ------------------------- 已实现：主进程类能力族（EH-B3a） ------------------------- */

  // EH-B3a：window / overlay / dialog / shell / notification / secrets /
  // update.getVersion / update.onEvent / proxy.get 的实现全部在 capabilities/host-main.ts。
  // 这些能力只在 main 有实现（宿主进程没有 Electron 模块），所以统一走宿主内部 RPC；
  // `extId` 在这里绑定（overlay / secrets / notification 的作用域就靠它，扩展侧拿不到该参数）。
  const hostMain = createHostMainCapabilities({
    extId,
    log: options.log,
    hostMain: options.hostMain,
    runSafely: options.runSafely
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

  const api: HostedExtensionApi = {
    registerCommand: stubSync('registerCommand'),
    executeCommand: stubAsync('executeCommand'),
    statusBar: statusBarStub,
    navbar: { setBadge: stubSync('navbar.setBadge') },
    workspaceState: mementoStub('workspaceState'),
    globalState: mementoStub('globalState'),
    on: stubSync('on'),
    emit: stubSync('emit'),
    // EH-B3a：window 全量 7 项（6 条 RPC + `onFocusChanged` 走 main 的聚焦事件）
    window: hostMain.window,
    appInfo,
    app: {
      register: stubSync('app.register'),
      onMessage: stubSync('app.onMessage')
    },
    // EH-B3a：overlay 4 项（`extId` 由宿主绑定，越权判定在 main 里复用既有那一份）
    overlay: hostMain.overlay,
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
      // EH-B3a：v1 里这两项**没有**提供者门控（`getVersion` 直接读 app 版本；`onEvent` 只订阅），
      // 因此可以照原样搬过来。剩下 4 条带门控的见下面的显式桩（裁定 R64）。
      getVersion: hostMain.update.getVersion,
      resolveFeed: stubWithReason('update.resolveFeed', UPDATE_PROVIDER_GATE_REASON),
      check: stubWithReason('update.check', UPDATE_PROVIDER_GATE_REASON),
      download: stubWithReason('update.download', UPDATE_PROVIDER_GATE_REASON),
      install: stubWithReason('update.install', UPDATE_PROVIDER_GATE_REASON),
      onEvent: hostMain.update.onEvent
    },
    // EH-B3a：同步读缓存快照（构造预热 + 读时刷新，语义见 capabilities/host-main.ts）
    proxy: hostMain.proxy,
    timer: timerApi,
    sqlite: sqlite.api,
    notification: hostMain.notification,
    net: io.net,
    dialog: hostMain.dialog,
    shell: hostMain.shell,
    clipboard: io.clipboard,
    env,
    theme: {
      getCurrent: stubSync('theme.getCurrent'),
      onChanged: stubSync('theme.onChanged')
    },
    fs: fsApi,
    ui: {
      // R67：ui 的模态框/toast 由渲染进程的 uiStore 渲染，main 没有 UI 渲染能力 ⇒ 归 B3b 的
      // host-renderer 通道。四条异步 + 一条同步形状各自保持（v1 的 showMessage 是同步 void）。
      showQuickPick: stubWithReason('ui.showQuickPick', HOST_RENDERER_DATA_PLANE_REASON),
      showInputBox: stubWithReason('ui.showInputBox', HOST_RENDERER_DATA_PLANE_REASON),
      showMessage: stubSyncWithReason('ui.showMessage', HOST_RENDERER_DATA_PLANE_REASON),
      showForm: stubWithReason('ui.showForm', HOST_RENDERER_DATA_PLANE_REASON),
      withProgress: stubWithReason('ui.withProgress', HOST_RENDERER_DATA_PLANE_REASON)
    },
    ipc: ipc.api,
    output: {
      // R67：输出通道与底部面板都在渲染侧 outputStore ⇒ 同上
      createChannel: stubSyncWithReason('output.createChannel', HOST_RENDERER_DATA_PLANE_REASON)
    },
    python: python.api,
    // EH-B3a：secrets 3 项（main 侧仍走 safeStorage，宿主只管把 extId+key 送过去）
    secrets: hostMain.secrets,
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
      // 顺序有意：先停"还在产生事件"的东西（通道/子进程/事件订阅），再关被动句柄。
      // 四条都幂等，且都各自负责自己的 `unref`（不拖住宿主退出）。
      ipc.dispose()
      python.dispose()
      sqlite.dispose()
      // 停 main 事件轮询 + 回收本扩展创建过的 overlay（v1：停用即销毁窗体）
      hostMain.dispose()
      // 监听句柄必须真的关掉：漏一个 inotify/FSEvents 句柄会让宿主退出时被拖住
      io.dispose()
      for (const id of [...timers.keys()]) clearTimer(id)
    }
  }
}
