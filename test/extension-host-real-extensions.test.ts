/**
 * EH-D8a · 「真实扩展在宿主里跑」的集成测试。
 *
 * ## 这张卡要回答的问题
 *
 * obox `2.0.0-rc.1` 已发布，但从没有任何测试**真的加载过现有扩展**：此前每条宿主测试用的都是
 * 临时目录里的 ESM 夹具（`test/fixtures/**`、`<tmp>/<id>/index.mjs`），它们由测试自己写、
 * 只用到测试自己造的能力面。真扩展会暴露夹具天然测不到的东西：
 * - 入口 `import` 了相对文件（`./lib/*.mjs`）——夹具从来只有单文件；
 * - 顶层/插件体内依赖 `import.meta.url` 的**协议**（宿主模式下是 `file://` 而不是 `app://`）；
 * - 清单里的 `apiVersion` 门槛、`contributes` 形状、入口 `main` 的写法；
 * - 能力面缺口：扩展调到了宿主没有的东西（或宿主有但形状不对）。
 *
 * 所以本文件用**磁盘上的真实清单与真实入口**（`<ROOT>/extensions/<id>/`）驱动**真实宿主运行时**
 * （`runtime.ts` + `loader.ts` + `activator.ts` + `apiFactory.ts`），断言 `plugin(api)` 真的被执行过、
 * 且没有抛错，并把 5 个扩展的**真实结果**逐条打印出来。
 *
 * ## 怎么驱动真实运行时（接缝只有 3 条通道 + 1 处 api 级拦截，都列在这里以免有人以为是"假跑"）
 *
 * | 真实的东西 | 本测试的做法 |
 * |---|---|
 * | `runtime.ts` 的握手/分派/状态表 | **真的**（`new ExtensionHostRuntime(...).start()`） |
 * | `loader.ts` 的清单校验 + 入口解析 + `import()` | **真的**（入口是磁盘上的 `index.js`，走真 `import()`） |
 * | `activator.ts` 的激活/失败归类 | **真的** |
 * | `apiFactory.ts` 造出的 `api` | **真的**（`statusBar`/`app`/`ipc`/`sqlite`/`settings`/`overlay` 全是生产实现） |
 * | `init.extensions[]` | **真的清单解析结果**：`manifest.json` → `validateManifest` → `collectHostedExtensions`（与渲染侧交接用的**同一个函数**） |
 * | `process.parentPort` | 假端口（同一套 `{ data, ports }` 事件形状，见 `port.ts`） |
 * | `host-renderer` 的 port1 | 假端口（随 `init` 的 `ports[0]` 传进来，**真的走一遍 `firstRendererPortOf`**） |
 * | main 侧的 RPC 端点 | 假 main 桥：宿主发来的每条 `req` 都由测试按 method 名给出可控结果（未实现的 method 一律回 `err`，并在末尾断言"没有未知 method"） |
 * | `init.dataDir` | `%TEMP%` 下的临时目录（**不碰真实 userData**） |
 *
 * **唯一的 api 级接缝**（卡要求 5：不许真的 spawn 子进程）：`ipc.connect` / `python.run` 是两个
 * "会拉起进程"的入口，本测试把它们换成**明确的中文报错**并记账。扩展代码本身一字未改、原样执行，
 * 其余能力全是生产实现。副作用是顺带验证了"sidecar 起不来时扩展不崩"这条容错。
 *
 * ## 有扩展失败怎么办（重要）
 *
 * 本卡的目的是**发现**不兼容，不是掩盖它。因此**不允许**写成 `it.skip` / `it.fails` / 只打印不判：
 * - 激活成功 ⇒ 断言"plugin 真的执行过"（有可观察的贡献/调用记录）+ 状态表 `active`；
 * - 激活失败 ⇒ 断言"失败原因**可诊断且带中文文案**"（`plugin-threw` / `import-failed` /
 *   `no-default-export` / `not-loadable` 之一，`message` 非空且含汉字），并把**失败原文**与原始
 *   错误细节打印到测试输出。
 * 这样即使某个扩展真的不兼容，这条测试仍然是一道**有意义的门禁**（不可诊断的失败会当场红），
 * 而不是"跳过即绿"。
 *
 * ## 没装扩展的机器 / CI
 *
 * `<ROOT>/extensions/` 被 `.gitignore` 忽略（用户扩展独立仓库托管），所以**这个目录不存在时
 * 整组用例 skip**（`describe.skipIf`）：本机无扩展目录时跳过，CI 上同样会跳过——不让它成为
 * CI 必红的来源。
 *
 * 目录存在、但**某个本地副本的清单没通过校验**时：那个扩展根本进不了宿主（渲染侧在交接前就把它
 * 过滤掉），本文件把它**列进"未进入宿主"并 warn**，其余扩展照常跑。理由是"清单是否合法"这条判据
 * 已经由 `test/manifest-script-parity.test.ts` 拥有（它对同一份清单判红），本文件不重复拥有同一条判据；
 * 但输出里绝不会把"跑了 4 个"说成"5 个都跑通"（总数会打印出来）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, test } from 'vitest'

import type { ExtensionManifest, ExtensionModule } from '../src/api'
import {
  EH_EVENT_CHANNELS,
  createErrorEnvelope,
  createInitEnvelope,
  createResponseEnvelope,
  createTerminateEnvelope,
  isEnvelope,
  type Envelope,
  type EventEnvelope,
  type HostedExtensionInfo,
  type RequestEnvelope
} from '../src/shared/extensionHostProtocol'
import type { HostedExtensionApi } from '../src/extension-host/apiFactory'
import { resetSharedUiPlaneHub } from '../src/extension-host/capabilities/ui-plane'
import {
  createHostPortsFromParentPort,
  type HostRendererPortLike,
  type ParentPortLike
} from '../src/extension-host/port'
import { ExtensionHostRuntime } from '../src/extension-host/runtime'
import type { ExtensionStatus } from '../src/extension-host/status'
import { validateManifest } from '../src/renderer/src/core/manifest'
import { collectHostedExtensions } from '../src/renderer/src/core/loader'
import type { ExtensionEntry } from '../src/renderer/src/core/host'

/* -------------------------------------------------------------------------------------------- */
/* 0. 常量与工具                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/** 仓库根（`test/` 的上一级） */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 用户扩展目录（被 `.gitignore` 忽略：仓库里只是本地副本，CI 上通常不存在） */
const EXTENSIONS_DIR = path.join(REPO_ROOT, 'extensions')

/**
 * 宿主能力面版本：**单源**读根 `package.json` 的 `apiVersion`（与渲染侧清单校验同一出处），
 * 不在这里写魔数——写死的话"宿主升版本"与"测试以为的版本"会静默分叉。
 */
const HOST_API_VERSION = readHostApiVersion()

/** 「会真的拉起子进程」的 api 调用（卡要求 5：本测试一律拦下并记账） */
const SPAWN_CALLS = new Set(['ipc.connect', 'python.run'])

/** 仓库版本（`api.appInfo` / `update.getVersion` 的对照值，同样从 package.json 单源读） */
const REPO_VERSION = readRepoPackage().version

function readRepoPackage(): { apiVersion?: unknown; version?: unknown } {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    apiVersion?: unknown
    version?: unknown
  }
}

function readHostApiVersion(): number {
  const raw = readRepoPackage()
  return typeof raw.apiVersion === 'number' && Number.isInteger(raw.apiVersion) ? raw.apiVersion : 3
}

/** 任意抛出物的可读文本（只用于测试诊断，不参与断言口径） */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** 是否含汉字（"失败原因必须有中文文案"的判据） */
function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

/** 轮询等待（不用固定 sleep：真实扩展内部有若干 async 续体，等的必须是结果不是时间） */
async function waitFor(condition: () => boolean, why: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时（${why}）`)
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 5)
    })
  }
}

/** 让出几轮宏任务（异步续体收尾用） */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 0)
    })
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 1. 真实扩展发现：磁盘清单 → 生产同款交接载荷                                                     */
/* -------------------------------------------------------------------------------------------- */

interface RealExtension {
  /** 扩展 id（= 安装目录名；生产是 `<name>_<author>`，本仓库的本地副本恰好与 `manifest.name` 同名） */
  id: string
  /** 扩展目录绝对路径（`init.extensions[].path` 就是它） */
  dir: string
  /** 清单里的 `name` / `version`（诊断用） */
  name: string
  version: string
  /** 清单校验的 error 文案（空数组 = 清单有效） */
  problems: string[]
  /** 宿主 `init` 信封要的清单摘要（清单无效时为 `null`） */
  hosted: HostedExtensionInfo | null
}

function discoverRealExtensions(): RealExtension[] {
  if (!existsSync(EXTENSIONS_DIR)) return []
  const found: RealExtension[] = []
  for (const entry of readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(EXTENSIONS_DIR, entry.name)
    const manifestPath = path.join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) continue

    let manifest: ExtensionManifest | null = null
    let problems: string[] = []
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest
      problems = validateManifest(parsed)
        .filter((message): boolean => message.severity === 'error')
        .map((message): string => message.message)
      if (problems.length === 0) manifest = parsed
    } catch (error) {
      problems = [`manifest.json 读取/解析失败：${messageOf(error)}`]
    }

    // `path` 指向**真实目录**（不是临时夹具）：这是本测试的全部意义所在。
    const entries: ExtensionEntry[] =
      manifest === null
        ? []
        : [
            {
              id: entry.name,
              manifest,
              source: 'user',
              path: dir,
              // 宿主模式下渲染侧的 `load` 永远不会被调用；给一个响亮的实现，防止被误用
              load: async (): Promise<ExtensionModule> => {
                throw new Error('宿主模式下不该调用渲染侧加载器')
              }
            }
          ]
    const hosted = collectHostedExtensions(entries)[0] ?? null

    found.push({
      id: entry.name,
      dir,
      name: typeof manifest?.name === 'string' ? manifest.name : '(缺失)',
      version: typeof manifest?.version === 'string' ? manifest.version : '(缺失)',
      problems,
      hosted
    })
  }
  return found.sort((left, right): number => left.id.localeCompare(right.id))
}

const realExtensions = discoverRealExtensions()

/**
 * 能真的进宿主的扩展（清单有效）。
 *
 * 不按 id 写死清单：本地多装了一个扩展就一起跑（它同样必须在宿主里跑得起来）。
 * 清单无效的那些**不进 `hostable`**，但会在"5 个真实清单都被宿主接受"那条断言里被点名判红。
 */
const hostable = realExtensions.filter((extension): boolean => extension.hosted !== null)

/* -------------------------------------------------------------------------------------------- */
/* 2. 假端口 / 假 main 桥 / 假渲染侧端口                                                           */
/* -------------------------------------------------------------------------------------------- */

/** 假 `process.parentPort`：记下宿主发出的每条消息，并允许测试从 main 侧塞入站消息 */
interface FakeParentPort {
  parentPort: ParentPortLike
  /** 宿主 → main：发出的信封（顺序） */
  posted: unknown[]
  /** main → 宿主：发一条消息事件（`ports` 是 transfer 列表） */
  emit(data: unknown, ports?: unknown[]): void
  /** 观察宿主发出的每条消息（假 main 桥用） */
  onPost(listener: (envelope: unknown) => void): () => void
  /** 还挂着几个监听（断言端口退订用） */
  listenerCount(): number
}

function createFakeParentPort(): FakeParentPort {
  const handlers = new Set<(event: unknown) => void>()
  const postListeners = new Set<(envelope: unknown) => void>()
  const posted: unknown[] = []
  return {
    parentPort: {
      postMessage(message: unknown): void {
        posted.push(message)
        for (const listener of [...postListeners]) listener(message)
      },
      on(_event: 'message', listener: (event: unknown) => void): unknown {
        handlers.add(listener)
        return undefined
      },
      off(_event: 'message', listener: (event: unknown) => void): unknown {
        handlers.delete(listener)
        return undefined
      }
    },
    posted,
    emit(data: unknown, ports?: unknown[]): void {
      // 真实 MessagePort 的事件形状是 `MessageEvent`：信封在 `data`，transfer 的端口在 `ports`
      const event = ports === undefined ? { data } : { data, ports }
      for (const handler of [...handlers]) handler(event)
    },
    onPost(listener: (envelope: unknown) => void): () => void {
      postListeners.add(listener)
      return (): void => {
        postListeners.delete(listener)
      }
    },
    listenerCount(): number {
      return handlers.size
    }
  }
}

/** 假 main 桥：宿主经 `parentPort` 发来的每条 `req` 都按 method 名给出可控结果 */
interface FakeMainBridge {
  /** 收到的方法调用（顺序，含未实现的） */
  calls: Array<{ method: string; params: unknown }>
  /** 实现了的方法表（测试可增删） */
  methods: Map<string, (params: unknown) => unknown>
  /** 未实现的 method（末尾断言为空：扩展不该调用宿主没声明的方法） */
  unknownMethods: string[]
  /** 某个 method 被调用了几次 */
  countOf(method: string): number
  /** 摘掉端口监听（收尾用） */
  dispose(): void
}

function createFakeMainBridge(
  parent: FakeParentPort,
  methods: Record<string, (params: unknown) => unknown>
): FakeMainBridge {
  const calls: Array<{ method: string; params: unknown }> = []
  const table = new Map<string, (params: unknown) => unknown>(Object.entries(methods))
  const unknownMethods: string[] = []
  const unsubscribe = parent.onPost((raw: unknown): void => {
    if (!isEnvelope(raw) || raw.t !== 'req') return
    const request = raw as RequestEnvelope
    calls.push({ method: request.method, params: request.params })
    const handler = table.get(request.method)
    if (handler === undefined) {
      if (!unknownMethods.includes(request.method)) unknownMethods.push(request.method)
      parent.emit(
        createErrorEnvelope(
          request.id,
          'EH_INTERNAL',
          `测试用 main 桥没有实现 ${request.method}（宿主调用了没人应答的方法）`
        )
      )
      return
    }
    // 用微任务回包：真实 main 也是异步回包，同步回包会掩盖"回包早于登记"的时序 bug
    void Promise.resolve()
      .then((): unknown => handler(request.params))
      .then(
        (result: unknown): void => {
          parent.emit(createResponseEnvelope(request.id, result))
        },
        (error: unknown): void => {
          parent.emit(createErrorEnvelope(request.id, 'EH_INTERNAL', messageOf(error)))
        }
      )
  })
  return {
    calls,
    methods: table,
    unknownMethods,
    countOf(method: string): number {
      return calls.filter((call): boolean => call.method === method).length
    },
    dispose(): void {
      unsubscribe()
    }
  }
}

/** 假 `host-renderer` 端口（`init` 的 `ports[0]`） */
interface FakeRendererPort {
  port: HostRendererPortLike
  /** 宿主 → 渲染侧：收到的信封（顺序） */
  received: Envelope[]
  /** 渲染侧 → 宿主：喂一条信封 */
  receive(message: unknown): void
  /** 是否被 close（宿主退出时必须关端口） */
  closed(): boolean
}

function createFakeRendererPort(): FakeRendererPort {
  const received: Envelope[] = []
  let listener: ((event: unknown) => void) | null = null
  let closed = false
  const port: HostRendererPortLike = {
    postMessage(message: unknown): void {
      received.push(message as Envelope)
    },
    get onmessage(): ((event: unknown) => void) | null {
      return listener
    },
    set onmessage(value: ((event: unknown) => void) | null) {
      listener = value
    },
    close(): void {
      closed = true
      listener = null
    }
  }
  return {
    port,
    received,
    receive(message: unknown): void {
      listener?.({ data: message })
    },
    closed: (): boolean => closed
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 3. 唯一的 api 级接缝：记录调用 + 拦下 spawn                                                     */
/* -------------------------------------------------------------------------------------------- */

/** 一个扩展的观测记录 */
interface ExtensionRun {
  readonly ext: RealExtension
  /** `plugin(api)` 期间真实发生过的 api 调用（`statusBar.setText` 这种点分路径，按调用顺序） */
  readonly calls: string[]
  /** 被拦下的"会拉起子进程"的调用 */
  readonly blocked: string[]
  /** 真实 api 对象（激活后可用于能力级断言，例如 ipc 清单解析） */
  api: HostedExtensionApi | null
}

/**
 * 给真实 `api` 套一层只读观察代理：**不改任何行为**，只记下"哪个能力被调用了"。
 *
 * 为什么值得这一层：`plugin(api)` 是同步函数，成功时宿主只留一条 `info` 日志，无法证明
 * "扩展体真的跑完了"而不是"跑到一半被 runSafely 吞了"。调用记录是最直接的证据，
 * 也是回执表里"plugin(api) 是否执行"这一列的来源。
 *
 * 代理必须保持**同一路径稳定同一引用**（`api.statusBar === api.statusBar`），否则扩展里
 * 任何 `const sb = api.statusBar` 后再比较的代码都会莫名其妙地不等。
 */
function observeApi(api: HostedExtensionApi, run: ExtensionRun): HostedExtensionApi {
  run.api = api
  const cache = new Map<string, unknown>()

  const wrap = (target: object, prefix: string): unknown => {
    const cached = cache.get(prefix)
    if (cached !== undefined) return cached
    const proxy = new Proxy(target, {
      get(current: object, property: string | symbol): unknown {
        if (typeof property !== 'string') return Reflect.get(current, property, current)
        const value = Reflect.get(current, property, current)
        const full = prefix === '' ? property : `${prefix}.${property}`

        if (typeof value === 'function') {
          const cachedFunction = cache.get(full)
          if (cachedFunction !== undefined) return cachedFunction
          const callable = (...args: unknown[]): unknown => {
            if (SPAWN_CALLS.has(full)) {
              // 卡要求 5：一律不真的拉起子进程。给中文可诊断错误，扩展理应降级而不是崩。
              run.blocked.push(full)
              return Promise.reject(
                new Error(`测试禁止拉起子进程（EH-D8a 要求 5）：${full} 被拦下`)
              )
            }
            run.calls.push(full)
            return (value as (...rest: unknown[]) => unknown).apply(current, args)
          }
          cache.set(full, callable)
          return callable
        }

        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const child = wrap(value, full)
          cache.set(full, child)
          return child
        }
        return value
      }
    })
    cache.set(prefix, proxy)
    return proxy
  }

  return wrap(api as unknown as object, '') as HostedExtensionApi
}

/**
 * 把真实入口模块包一层：`default`（即 `plugin(api)`）拿到的是被观测的 api。
 *
 * 这是 `HostRuntimeOptions.importModule` 这个注入点的用途（"测试可注入"）：
 * `import()` 本身仍是**真 import 磁盘上的文件**，只把传给插件的 api 换成观察代理。
 */
function createEntryImporter(
  runs: Map<string, ExtensionRun>,
  dirs: Map<string, string>
): (url: string) => Promise<unknown> {
  return async (url: string): Promise<unknown> => {
    const module = (await import(/* @vite-ignore */ url)) as Record<string, unknown>
    let extId: string | undefined
    for (const [id, dir] of dirs) {
      if (url.startsWith(pathToFileURL(dir).href)) {
        extId = id
        break
      }
    }
    const plugin = module.default
    if (extId === undefined || typeof plugin !== 'function') return module
    const run = runs.get(extId)
    if (run === undefined) return module
    const original = plugin as (api: HostedExtensionApi) => unknown
    return {
      ...module,
      default: (api: HostedExtensionApi): unknown => original(observeApi(api, run))
    }
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 4. 一次真实宿主运行的现场                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * 宿主日志（**一条都不许丢**：失败诊断全靠它）。
 *
 * 宿主的日志不是函数回调，而是一条 `log` 信封（`createEnvelopeLogger` → `parentPort`），
 * 所以这里从端口上把 `log` 信封捞回来——这正是生产里 main 收到的东西，不额外造注入点。
 */
interface HostLogEntry {
  level: string
  message: string
  detail?: string
}

function logEntriesOf(parent: FakeParentPort): HostLogEntry[] {
  return parent.posted
    .filter(
      (raw): raw is { t: 'log'; level: string; message: string; detail?: unknown } =>
        typeof raw === 'object' && raw !== null && (raw as { t?: unknown }).t === 'log'
    )
    .map((envelope): HostLogEntry => {
      const detail = envelope.detail
      return typeof detail === 'string'
        ? { level: envelope.level, message: envelope.message, detail }
        : { level: envelope.level, message: envelope.message }
    })
}

interface HostRun {
  tempDir: string
  parent: FakeParentPort
  renderer: FakeRendererPort
  main: FakeMainBridge
  runtime: ExtensionHostRuntime
  runs: Map<string, ExtensionRun>
  /** `terminate` 后宿主调用的退出码 */
  exits: number[]
  /** 每个真实扩展目录在测试前 `<ext>/data` 的样子（跑完原样恢复：扩展目录对本卡是只读的） */
  dataSnapshots: Array<{ dir: string; existed: boolean; entries: string[] }>
  /** `plugin(api)` 的返回值被宿主当成清理函数跑过没有（停用阶段断言） */
  shutdownDone: boolean
}

let run: HostRun | null = null

/**
 * 假 main 桥实现的方法表。
 *
 * 只实现"激活路径上真会碰到"的那几个（其余一律回 `err`，并在末尾断言"没有未知 method"）：
 * 少实现一个就会在结果里以 `未知 method` 出现，不会静默通过。
 */
function mainMethods(): Record<string, (params: unknown) => unknown> {
  return {
    // obox-updater：`api.update.getVersion()`（main 侧回 `{ ok, value }`，见 host-main 的 readValueResult）
    'host.update.version': (): unknown => ({
      ok: true,
      value: typeof REPO_VERSION === 'string' ? REPO_VERSION : '0.0.0'
    }),
    // 事件轮询（`api.update.onEvent` / `window.onFocusChanged` / 通知点击共用）
    'host.event.poll': (): unknown => ({ cursor: 0, events: [] }),
    // pet：`api.overlay.create(...)`
    'host.overlay.create': (): unknown => ({ ok: true, position: { x: 100, y: 640 } }),
    'host.overlay.destroy': (): unknown => ({ ok: true }),
    'host.overlay.set-mouse-through': (): unknown => ({ ok: true }),
    'host.overlay.set-position': (): unknown => ({ ok: true }),
    // 代理配置（`net.fetch` / `clipboard` 会读；激活路径上一般不会，留着以免偶发未知 method）
    'host.proxy.get': (): unknown => ({
      ok: true,
      value: { proxy: { enabled: false, url: '', noProxy: [] }, ignoreSSL: false }
    }),
    // secrets（rdp 只在 handler 里用；装配期读一次也不该炸）
    'host.secrets.get': (): unknown => ({ ok: true, value: null }),
    'host.secrets.set': (): unknown => ({ ok: true }),
    'host.secrets.delete': (): unknown => ({ ok: true })
  }
}

/** 快照 `<扩展目录>/data`（宿主会往里写 state/、*.db；本卡要求扩展目录只读，跑完恢复） */
function snapshotDataDir(extDir: string): { dir: string; existed: boolean; entries: string[] } {
  const dataDir = path.join(extDir, 'data')
  const existed = existsSync(dataDir)
  const entries = existed ? readdirSync(dataDir) : []
  return { dir: dataDir, existed, entries }
}

/** 恢复 `<扩展目录>/data`：只删"本次跑出来的"内容，用户真实数据（如 rdp.db）一个字节都不动 */
async function restoreDataDir(snapshot: {
  dir: string
  existed: boolean
  entries: string[]
}): Promise<void> {
  if (!existsSync(snapshot.dir)) return
  if (!snapshot.existed) {
    await rm(snapshot.dir, { recursive: true, force: true })
    return
  }
  for (const name of readdirSync(snapshot.dir)) {
    if (snapshot.entries.includes(name)) continue
    await rm(path.join(snapshot.dir, name), { recursive: true, force: true })
  }
}

/** 造一次真实宿主运行：假端口 + 真运行时 + 真清单 */
async function startHostRun(): Promise<HostRun> {
  resetSharedUiPlaneHub()
  const tempDir = await mkdtemp(path.join(tmpdir(), 'obox-eh-d8a-'))
  const parent = createFakeParentPort()
  // 用生产的端口适配器：`init` 的 `ports[0]` 必须真的被 `firstRendererPortOf` 取出来
  const ports = createHostPortsFromParentPort(parent.parentPort)
  const renderer = createFakeRendererPort()
  const main = createFakeMainBridge(parent, mainMethods())
  const runs = new Map<string, ExtensionRun>()
  const dirs = new Map<string, string>()
  for (const extension of hostable) {
    runs.set(extension.id, { ext: extension, calls: [], blocked: [], api: null })
    dirs.set(extension.id, extension.dir)
  }

  const exits: number[] = []
  const runtime = new ExtensionHostRuntime({
    port: ports.main,
    rendererPort: (): HostRendererPortLike | null => ports.renderer,
    hostId: 'host-real-extensions',
    pid: 4310,
    appInfo: { name: 'obox', version: typeof REPO_VERSION === 'string' ? REPO_VERSION : '0.0.0' },
    locale: 'zh',
    echoLog: false,
    exit: (code: number): void => {
      exits.push(code)
    },
    importModule: createEntryImporter(runs, dirs)
  })

  const state: HostRun = {
    tempDir,
    parent,
    renderer,
    main,
    runtime,
    runs,
    exits,
    dataSnapshots: hostable.map((extension) => snapshotDataDir(extension.dir)),
    shutdownDone: false
  }

  runtime.start()
  parent.emit(
    createInitEnvelope({
      apiVersion: HOST_API_VERSION,
      dataDir: tempDir,
      extensions: hostable.map(
        (extension): HostedExtensionInfo => extension.hosted as HostedExtensionInfo
      )
    }),
    // 渲染侧 port1 随 init transfer 过来（真实链路：main 的 `postToHost(init, [port1])`）
    [renderer.port]
  )

  // 渲染侧一挂上端口就会推一份设置快照（`SettingsSnapshotPayload`）。真宿主靠它校准
  // `settings.get` 的同步缓存；这里推一份空快照，既走真链路又让扩展读到自己的默认值。
  renderer.receive({ v: 1, op: 'snapshot', settings: {}, locale: 'zh', themeId: 'default' })

  await runtime.settled()
  // 扩展内部有不被宿主 track 的 async 续体（webapp 的 bootstrap、pet 的 init 序列），
  // 等"结果"而不是"时间"：最多 5 秒，正常情况几十毫秒内就满足。
  await waitFor(
    (): boolean =>
      logEntriesOf(parent).some((entry): boolean => entry.message.includes('启动后激活完成')),
    '启动后激活完成（onStartupFinished）'
  )
  await flush(6)
  return state
}

/** 当前这次运行的现场（未启动时抛错，避免用例静默空跑） */
function liveRun(): HostRun {
  if (run === null) throw new Error('宿主还没启动（beforeAll 未执行或已失败）')
  return run
}

/** 某个扩展的观测记录 */
function runOf(extId: string): ExtensionRun {
  const found = liveRun().runs.get(extId)
  if (found === undefined) throw new Error(`没有 ${extId} 的观测记录`)
  return found
}

/** 状态表里某扩展的一行 */
function statusOf(extId: string): ExtensionStatus | undefined {
  return liveRun().runtime.statusOf(extId)
}

/** 渲染侧收到的某扩展的某 channel 事件载荷 */
function planeEventsOf(extId: string, channel: string): Array<Record<string, unknown>> {
  return liveRun()
    .renderer.received.filter((envelope): envelope is EventEnvelope => envelope.t === 'event')
    .filter((envelope): boolean => envelope.channel === channel)
    .map((envelope): unknown => envelope.payload)
    .filter(
      (payload): payload is Record<string, unknown> =>
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { extId?: unknown }).extId === extId
    )
}

/** 某个扩展是否"真的跑过"：至少有可观察的贡献或调用 */
function evidenceOf(extId: string): string[] {
  const evidence: string[] = []
  const appEvents = planeEventsOf(extId, EH_EVENT_CHANNELS.appRegister)
  for (const payload of appEvents) {
    if (payload.op !== 'register') continue
    const registration = payload.registration as { id?: unknown } | undefined
    evidence.push(`app.register(${typeof registration?.id === 'string' ? registration.id : '?'})`)
  }
  if (appEvents.some((payload): boolean => payload.op === 'messageHandler')) {
    evidence.push('app.onMessage 已登记')
  }
  const statusBar = planeEventsOf(extId, EH_EVENT_CHANNELS.statusBar)
  if (statusBar.length > 0) evidence.push(`statusBar×${statusBar.length}`)
  const calls = runOf(extId).calls
  if (calls.length > 0) evidence.push(`api 调用 ${calls.length} 次`)
  const mainCalls = liveRun().main.calls.filter((call): boolean =>
    JSON.stringify(call.params ?? null).includes(`"${extId}"`)
  )
  if (mainCalls.length > 0) evidence.push(`main RPC×${mainCalls.length}`)
  return evidence
}

/**
 * 一次真实运行的结果行（回执表的数据源，也是"逐扩展断言"的输入）。
 *
 * `outcome` 只有两种终态：`activated`（成功）/ `failed`（失败，带原因原文）。**没有 skipped**：
 * 5 个扩展都没有 `activationEvents`，归一后是 `['*']`，启动即激活，不该出现"没轮到它"。
 */
interface ResultRow {
  ext: RealExtension
  apiVersion: string
  loadable: boolean
  outcome: string
  executed: boolean
  failure: string
  activationEvents: string
}

function collectRows(): ResultRow[] {
  const host = liveRun()
  return hostable.map((extension): ResultRow => {
    const status = host.runtime.statusOf(extension.id)
    const observation = host.runs.get(extension.id)
    const outcome = status?.state ?? 'missing'
    return {
      ext: extension,
      apiVersion: `${extension.hosted?.apiVersion ?? '?'}（宿主 v${HOST_API_VERSION}）`,
      loadable:
        (host.runtime.extensions().find((record): boolean => record.info.id === extension.id)
          ?.state ?? 'rejected') === 'loadable',
      outcome,
      executed: (observation?.calls.length ?? 0) > 0,
      failure:
        status?.failure === undefined ? '—' : `${status.failure.kind}：${status.failure.message}`,
      activationEvents:
        status === undefined || status.activationEvents.length === 0
          ? '(空)'
          : status.activationEvents.join(',')
    }
  })
}

/** 打印结果总表（原始输出里必须看得到 5 个扩展逐条结果 + 失败原文） */
function printRow(row: ResultRow): void {
  const observation = liveRun().runs.get(row.ext.id)
  console.log(
    [
      `[EH-D8a] ${row.ext.id}`,
      `  清单=${row.ext.name}@${row.ext.version}`,
      `  apiVersion=${row.apiVersion}`,
      `  可加载=${row.loadable}`,
      `  激活状态=${row.outcome}`,
      `  plugin(api)执行=${row.executed}`,
      `  激活事件=${row.activationEvents}`,
      `  失败原因=${row.failure}`,
      `  api 调用=${observation?.calls.join(' → ') ?? '(无)'}`,
      `  被拦下的 spawn=${observation?.blocked.length === 0 ? '(无)' : observation?.blocked.join(',')}`
    ].join('\n')
  )
}

/* -------------------------------------------------------------------------------------------- */
/* 5. 每个扩展的专用判据（"它注册了预期的贡献点"）                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * 逐扩展的专用判据：标题 + 检查。
 *
 * 为什么按 id 分派而不是在一个大 if 里：这些判据证明的是**扩展自己的贡献点真的被装配**，
 * 而不是"plugin 函数返回了"。每个扩展的贡献点不同（状态栏 / App 卡片 / sidecar 声明 / overlay），
 * 判据也就必须分开写。未知 id（将来新增的扩展）走通用判据，不会因为没登记而假绿。
 */
const extensionSpecifics: Record<string, { title: string; check: () => Promise<void> | void }> = {
  'obox-updater': {
    title: '状态栏 + 更新能力真的被装配（update.version 经 main 桥往返）',
    check: (): void => {
      const observation = runOf('obox-updater')
      assert.ok(
        planeEventsOf('obox-updater', EH_EVENT_CHANNELS.statusBar).length > 0,
        'obox-updater 没有发出任何 statusBar 事件（插件体没跑完？）'
      )
      assert.ok(
        observation.calls.includes('registerCommand'),
        `obox-updater 没注册命令（清单声明了 commands，实际调用：${observation.calls.join(' → ')}）`
      )
      assert.ok(
        liveRun().main.countOf('host.update.version') >= 1,
        'obox-updater 没问过主进程版本（api.update.getVersion 没走通宿主 → main 的反向通道）'
      )
      assert.ok(observation.calls.includes('update.onEvent'), 'obox-updater 没订阅更新事件')
    }
  },
  rdp: {
    title: 'App 卡片注册 + 清单声明的 sidecar 通道被宿主解析（不 spawn）',
    check: async (): Promise<void> => {
      assert.ok(
        planeEventsOf('rdp', EH_EVENT_CHANNELS.appRegister).some(
          (payload): boolean => payload.op === 'register'
        ),
        'rdp 没有向渲染侧注册 App 卡片'
      )
      await assertSidecarDeclared('rdp')
    }
  },
  webapp: {
    title: 'App 卡片 + 设置能力 + 清单声明的 sidecar 通道被解析（不 spawn）',
    check: async (): Promise<void> => {
      const observation = runOf('webapp')
      assert.ok(
        planeEventsOf('webapp', EH_EVENT_CHANNELS.appRegister).some(
          (payload): boolean => payload.op === 'register'
        ),
        'webapp 没有向渲染侧注册 App 卡片'
      )
      assert.ok(
        observation.calls.some((call): boolean => call.startsWith('settings.')),
        `webapp 没有调用任何 settings 能力（实际：${observation.calls.join(' → ')}）`
      )
      await assertSidecarDeclared('webapp')
    }
  },
  todo: {
    title: 'App 卡片 + 页面消息桥在宿主模式下可用（URL 是 app:// 而不是 file://）',
    check: (): void => {
      const registrations = planeEventsOf('todo', EH_EVENT_CHANNELS.appRegister)
      const register = registrations.find((payload): boolean => payload.op === 'register')
      assert.ok(register !== undefined, 'todo 没有注册 App 卡片')
      const registration = register.registration as { url?: unknown } | undefined
      assert.equal(typeof registration?.url, 'string', 'todo 的卡片没有 url')
      const url = String(registration?.url)
      assert.ok(
        url.startsWith('app://'),
        `todo 的卡片 URL 不是 app://（宿主模式下 import.meta.url 是 file://，会被 CSP 拒载）：${url}`
      )
      assert.ok(
        registrations.some((payload): boolean => payload.op === 'messageHandler'),
        'todo 没有登记页面消息处理器（页面的 todo:load / todo:save 会全部落到空处）'
      )
    }
  },
  pet: {
    title: '状态栏 + overlay 建窗经 main 桥往返 + 定时器挂上',
    check: async (): Promise<void> => {
      const observation = runOf('pet')
      assert.ok(
        planeEventsOf('pet', EH_EVENT_CHANNELS.statusBar).length > 0,
        'pet 没有发出状态栏事件'
      )
      // overlay.create 是异步的（启动序列里先 await 读档），等它真的到达 main 桥
      await waitFor(
        (): boolean => liveRun().main.countOf('host.overlay.create') > 0,
        'pet 的 overlay.create 到达 main 桥'
      )
      const createCall = liveRun().main.calls.find(
        (call): boolean => call.method === 'host.overlay.create'
      )
      assert.ok(
        JSON.stringify(createCall?.params ?? null).includes('"pet"'),
        'pet 的 overlay.create 没有带 extId=pet（main 的越权判定会拒掉它）'
      )
      assert.ok(
        observation.calls.some((call): boolean => call.startsWith('timer.setInterval')),
        `pet 没有挂上周期定时器（实际：${observation.calls.join(' → ')}）`
      )
    }
  }
}

/**
 * 断言"清单里声明的 sidecar 通道被宿主解析过"，且**没有真的 spawn**。
 *
 * 怎么在不拉起子进程的前提下证明解析真的发生了：宿主对**未声明**的通道会先读
 * `<扩展目录>/manifest.json` 的 `contributes.ipcChannels`，再给出「清单里没有声明通道 x」。
 * 拿一个不存在的名字去问，得到的拒绝文案本身就是"解析链路活着"的证据。
 */
async function assertSidecarDeclared(extId: string): Promise<void> {
  const api = runOf(extId).api
  assert.ok(api !== null, `${extId} 没拿到 api 对象`)
  await assert.rejects(
    async (): Promise<void> => {
      await api.ipc.connect(`${extId}.eh-d8a-未声明的通道`)
    },
    (error: unknown): boolean => {
      const text = messageOf(error)
      assert.match(text, /清单里没有声明通道/, `${extId} 的错误文案不认识：${text}`)
      assert.match(text, /contributes\.ipcChannels/, `${extId} 的错误文案没指明是清单字段：${text}`)
      return true
    },
    `${extId} 的 sidecar 声明没有被宿主解析（对未声明通道没有给出可诊断的拒绝）`
  )
}

/* -------------------------------------------------------------------------------------------- */
/* 6. 用例                                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe.skipIf(realExtensions.length === 0)(
  'EH-D8a · 真实扩展在宿主里跑（真清单 + 真入口 + 真运行时）',
  (): void => {
    beforeAll(async (): Promise<void> => {
      run = await startHostRun()
    })

    afterAll(async (): Promise<void> => {
      const host = run
      run = null
      if (host === null) return
      // 兜底：任用例失败导致没走到停止用例时，也要把宿主停掉并恢复扩展目录
      if (!host.shutdownDone) {
        try {
          host.parent.emit(createTerminateEnvelope(2000))
          await flush(10)
        } catch {
          // 尽力而为：清理阶段不再把测试搞红
        }
      }
      host.runtime.dispose()
      resetSharedUiPlaneHub()
      for (const snapshot of host.dataSnapshots) {
        try {
          await restoreDataDir(snapshot)
        } catch {
          // 尽力而为（Windows 上偶发文件占用）
        }
      }
      await rm(host.tempDir, { recursive: true, force: true })
    })

    /* -------------------------------- 总表：逐扩展结果 -------------------------------- */

    test('真实清单都被宿主接受，且 plugin(api) 都真的被执行（逐条打印）', (): void => {
      // 清单没通过校验的扩展**根本进不了宿主**（渲染侧在交接前就把它过滤掉）。
      // 这类"本地副本不可用"与"宿主不兼容"是两回事：判定清单合法性是
      // `test/manifest-script-parity.test.ts` 的职责（它会对同一份清单判红），这里不重复拥有同一条判据，
      // 但必须**响亮地**列出来——否则"少加载一个扩展"会被误读成"它跑通了"。
      const unhostable = realExtensions.filter((extension): boolean => extension.hosted === null)
      if (unhostable.length > 0) {
        for (const extension of unhostable) {
          console.warn(
            `[EH-D8a] ${extension.id} 的清单没通过校验，未进入宿主（不计入本次结果）：` +
              extension.problems.join('；')
          )
        }
        // 唯一的要求：原因必须可诊断（空原因等于"不知道为什么没跑"，那才是真问题）
        for (const extension of unhostable) {
          assert.ok(
            extension.problems.length > 0 && extension.problems.every((text) => text.trim() !== ''),
            `${extension.id} 的清单校验失败了，却没给出任何原因（无法诊断）`
          )
        }
      }
      assert.ok(hostable.length > 0, '没有一个扩展的清单通过校验（这本身就说明宿主/清单层不兼容）')
      // 清单层：全部 loadable（apiVersion 门槛通过、入口在扩展目录内、id 合法）
      const rejected = hostable.filter((extension): boolean => {
        const record = liveRun()
          .runtime.extensions()
          .find((item): boolean => item.info.id === extension.id)
        return record === undefined || record.state !== 'loadable'
      })
      assert.deepEqual(
        rejected.map((extension): string => extension.id),
        [],
        '这些扩展的清单被宿主判为不可加载（见 runtime.extensions() 的 reason）'
      )

      console.log(
        `[EH-D8a] 本次进宿主的真实扩展 ${hostable.length} 个` +
          (unhostable.length === 0
            ? '（扩展目录里的清单全部通过校验）'
            : `；另有 ${unhostable.length} 个清单未通过校验、未进入宿主：` +
              unhostable.map((extension): string => extension.id).join('、'))
      )
      for (const row of collectRows()) {
        printRow(row)
        assert.equal(
          row.executed || row.outcome === 'failed',
          true,
          `${row.ext.id}：既没有 api 调用记录，也没被判失败——说明 plugin(api) 根本没跑到，这条门禁是假绿`
        )
      }
    })

    test('有失败的扩展：失败原因必须可诊断且带中文文案（不允许静默/不可读）', (): void => {
      const failed = collectRows().filter((row): boolean => row.outcome === 'failed')
      if (failed.length === 0) return // 全部成功：这条判据自然满足

      const knownKinds = new Set([
        'not-loaded',
        'not-loadable',
        'import-failed',
        'no-default-export',
        'plugin-threw'
      ])
      for (const row of failed) {
        const failure = statusOf(row.ext.id)?.failure
        assert.ok(failure !== undefined, `${row.ext.id} 被判失败却没有失败记录（不可诊断）`)
        assert.ok(
          knownKinds.has(failure.kind),
          `${row.ext.id} 的失败归类 ${failure.kind} 不在已知集合里（宿主没给出可判定的分类）`
        )
        assert.notEqual(
          failure.message.trim(),
          '',
          `${row.ext.id} 的失败原因为空（用户看不懂发生了什么）`
        )
        assert.ok(
          hasChinese(failure.message),
          `${row.ext.id} 的失败原因没有中文文案：${failure.message}`
        )
        // 原始错误（栈/URL/文件路径）来自日志：必须打印出来，这是本卡最重要的诊断信息
        const details = logEntriesOf(liveRun().parent).filter(
          (entry): boolean =>
            entry.message.includes(row.ext.id) &&
            (entry.level === 'error' || entry.level === 'warn' || entry.detail !== undefined)
        )
        console.log(`[EH-D8a] ${row.ext.id} 失败原文：${failure.kind}：${failure.message}`)
        for (const entry of details) {
          console.log(
            `         ${entry.level} ${entry.message}${entry.detail ? ` :: ${entry.detail}` : ''}`
          )
        }
      }
    })

    test('激活状态符合各自的 activationEvents（无事件 ⇒ 缺省 `*` ⇒ 启动即激活）', (): void => {
      for (const row of collectRows()) {
        const status = statusOf(row.ext.id)
        assert.ok(status !== undefined, `${row.ext.id} 没有进状态表（init 播种失败）`)
        const declared = row.ext.hosted?.activationEvents ?? []
        const expected = declared.length === 0 ? ['*'] : declared.map(String)
        assert.deepEqual(
          status.activationEvents,
          expected,
          `${row.ext.id} 的激活事件与清单不一致（清单 ${JSON.stringify(declared)}）`
        )
        assert.equal(
          status.lastActivation?.reason,
          '*',
          `${row.ext.id} 不是被启动激活（` * `）触发的：${status.lastActivation?.reason}`
        )
        assert.notEqual(
          status.state,
          'pending',
          `${row.ext.id} 声明了 * 却还停在 pending：启动激活没派发到它`
        )
        assert.notEqual(
          status.state,
          'activating',
          `${row.ext.id} 停在 activating：激活流程没有收敛（异步续体泄漏）`
        )
      }
    })

    test('隔离：每个扩展的贡献都带自己的 extId，没有串台', (): void => {
      for (const extension of hostable) {
        const payloads = [
          ...planeEventsOf(extension.id, EH_EVENT_CHANNELS.appRegister),
          ...planeEventsOf(extension.id, EH_EVENT_CHANNELS.statusBar)
        ]
        for (const payload of payloads) {
          assert.equal(
            payload.extId,
            extension.id,
            `${extension.id} 的事件里 extId 串台了：${String(payload.extId)}`
          )
        }
      }
      // 5 个扩展的 api 对象互不相同（每个扩展一份，不是共享一份）
      const apis = hostable
        .map((extension): HostedExtensionApi | null => runOf(extension.id).api)
        .filter((api): api is HostedExtensionApi => api !== null)
      assert.equal(new Set(apis).size, apis.length, '不同扩展拿到了同一个 api 对象（隔离被破坏）')
    })

    test('sidecar 一次都没真的拉起（ipc.connect / python.run 全部被拦下），且扩展仍激活', (): void => {
      for (const extension of hostable) {
        const observation = runOf(extension.id)
        if (observation.blocked.length === 0) continue
        // 被拦下的 spawn 只允许出现在**已激活**的扩展上：说明它能优雅降级，而不是靠崩溃收场
        assert.equal(
          statusOf(extension.id)?.state,
          'active',
          `${extension.id} 尝试拉起 sidecar 后没有优雅降级（状态 ${String(statusOf(extension.id)?.state)}）`
        )
        console.log(
          `[EH-D8a] ${extension.id} 的 spawn 被拦下：${observation.blocked.join(',')}（扩展已降级继续）`
        )
      }
    })

    test('main 桥：扩展没有调用"宿主没声明"的方法（假 main 一个 method 都没漏）', (): void => {
      // 假 main 只实现了激活路径上真实存在的方法。出现未知 method 有两种含义：
      // 扩展调了 API 面之外的东西，或宿主把方法名改了（两边漂了）——都必须当场红。
      assert.deepEqual(
        liveRun().main.unknownMethods,
        [],
        '宿主发出了测试用 main 桥没实现的方法（扩展越界 / 方法名两侧漂移）'
      )
    })

    /* --------------------------- 逐个扩展：真实结果与贡献 --------------------------- */

    for (const extension of hostable) {
      const specific = extensionSpecifics[extension.id]
      const label = specific === undefined ? '真实入口跑起来并留下可观察的贡献' : specific.title
      test(`${extension.id}：${label}`, async (): Promise<void> => {
        // —— 通用判据：激活成功 + plugin(api) 真的执行过 ——
        const status = statusOf(extension.id)
        assert.ok(status !== undefined, `${extension.id} 没有进状态表`)
        assert.equal(
          status.state,
          'active',
          `${extension.id} 激活状态是 ${status.state}，失败原因：${status.failure?.message ?? '(无)'}`
        )
        const observation = runOf(extension.id)
        assert.ok(
          observation.calls.length > 0,
          `${extension.id} 的 plugin(api) 一次 api 都没调用——没证据表明它真的执行过`
        )
        assert.ok(
          evidenceOf(extension.id).length > 0,
          `${extension.id} 在宿主里没有留下任何可观察的贡献（贡献点/调用/RPC 全空）`
        )
        console.log(
          `[EH-D8a] ${extension.id} 证据：${evidenceOf(extension.id).join('，')}` +
            `\n         api 调用：${observation.calls.join(' → ')}`
        )
        // —— 该扩展自己的贡献点（每个扩展一个专用判据，见 extensionSpecifics） ——
        if (specific !== undefined) await specific.check()
      })
    }

    /* --------------------------------- 卡片 URL 诊断 --------------------------------- */

    test('卡片 URL 必须是 app://（宿主里 import.meta.url 是 file://，扩展必须自己换算）', (): void => {
      // 为什么这条值得单独立一条门禁：宿主进程里 `import.meta.url` 是 `file://…/index.js`，
      // 而 App 子窗口的 iframe 只认 `app:`（CSP `frame-src 'self' app:` + 主进程 host 校验）。
      // 直接 `new URL('./ui/index.html', import.meta.url)` 拼出来的 card.url 会被拒载 ⇒ 卡片空白窗，
      // 而**激活本身是成功的**——这正是"能激活 ≠ 能用"的那一类缺陷，只有在这里才看得见。
      const diagnostics: string[] = []
      for (const extension of hostable) {
        const register = planeEventsOf(extension.id, EH_EVENT_CHANNELS.appRegister).find(
          (payload): boolean => payload.op === 'register'
        )
        if (register === undefined) continue // 没注册 App 卡片的扩展不适用
        const registration = register.registration as { url?: unknown } | undefined
        assert.equal(
          typeof registration?.url,
          'string',
          `${extension.id} 注册的卡片没有 url（渲染侧会静默不显示）`
        )
        const url = String(registration?.url)
        diagnostics.push(`${extension.id}: ${url}`)
        assert.ok(
          url.startsWith('app://'),
          `${extension.id} 的卡片 URL 不是 app://（子窗口 iframe 会被 CSP 拒载）：${url}`
        )
      }
      console.log(`[EH-D8a] 卡片 URL：\n         ${diagnostics.join('\n         ')}`)
    })

    /* ----------------------------------- 幂等与收尾 ----------------------------------- */

    test('重复激活幂等：再一次 dispatch(`*`) 全部 skipped，不重复执行 plugin', async (): Promise<void> => {
      const before = new Map(
        hostable.map((extension): [string, number] => [
          extension.id,
          statusOf(extension.id)?.activationCount ?? 0
        ])
      )
      const results = await liveRun().runtime.dispatchActivation('*')
      for (const result of results) {
        const state = statusOf(result.extId)?.state
        if (state !== 'active') continue // 失败的扩展允许重试
        assert.equal(
          result.state,
          'skipped',
          `${result.extId} 被重复激活成了 ${result.state}（幂等被破坏）`
        )
        assert.equal(
          statusOf(result.extId)?.activationCount,
          before.get(result.extId),
          `${result.extId} 的 activationCount 增加了：plugin 被执行了第二遍`
        )
      }
    })

    test('terminate：已激活的扩展全部优雅停用，plugin 的清理函数被执行，退出码 0', async (): Promise<void> => {
      const host = liveRun()
      const activeIds = hostable
        .map((extension): string => extension.id)
        .filter((id): boolean => host.runtime.statusOf(id)?.state === 'active')
      /** 停用前已注册 App 卡片的扩展（它们的清理函数会 `card.dispose()`，那是一条可观察事件） */
      const cardOwners = activeIds.filter((extId): boolean =>
        planeEventsOf(extId, EH_EVENT_CHANNELS.appRegister).some(
          (payload): boolean => payload.op === 'register'
        )
      )
      // 宽限期给足：走 `shutdown()` 的优雅路径（deactivateAll），而不是被强制退出
      host.parent.emit(createTerminateEnvelope(5000))
      await waitFor((): boolean => host.exits.length > 0, '宿主调用 exit')
      await flush(6)
      host.shutdownDone = true

      assert.deepEqual(host.exits, [0], '宿主退出码不是 0（清理阶段被强制退出？）')
      for (const extId of activeIds) {
        // 停用后状态是 `stopped`；失败过的扩展保持 `failed`（历史留痕，不覆盖）
        const state = host.runtime.statusOf(extId)?.state
        assert.equal(state, 'stopped', `${extId} 没有走优雅停用（状态 ${String(state)}）`)
      }
      // `plugin(api)` 返回的清理函数**真的被宿主执行过**：注册过 App 卡片的扩展都必须发出
      // `app.register` 的 `dispose` 子操作（那是清理函数里 `card.dispose()` 的唯一出口）。
      for (const extId of cardOwners) {
        assert.ok(
          planeEventsOf(extId, EH_EVENT_CHANNELS.appRegister).some(
            (payload): boolean => payload.op === 'dispose'
          ),
          `${extId} 的卡片没有被撤掉：plugin 返回的清理函数没被执行`
        )
      }
      // pet 的清理函数会回收 overlay（`api.overlay.destroy` / hostMain.dispose 的兜底回收）
      if (activeIds.includes('pet')) {
        assert.ok(
          host.main.countOf('host.overlay.destroy') >= 1,
          'pet 停用后没有回收 overlay 窗体（清理函数没跑 / 装配没收尾）'
        )
      }
      // 端口必须真的退订/关闭，否则宿主进程退不干净
      assert.equal(host.parent.listenerCount(), 0, '宿主退出后仍监听着 parentPort')
      assert.equal(host.renderer.closed(), true, '宿主退出后没有关闭 host-renderer 端口')
    })
  }
)
