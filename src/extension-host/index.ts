/**
 * **扩展宿主进程入口**（Electron `utilityProcess.fork()` 的 target，见 ADR-0026 决策 2）。
 *
 * 这个文件只做三件事，任何业务逻辑都不属于它：
 * 1. 取 `process.parentPort`（utilityProcess 的父端口）并适配成 `HostPort`；
 * 2. 组装 `ExtensionHostRuntime` 并 `start()`（发 `ready`，等 `init`）；
 * 3. 进程级兜底（`uncaughtException` / `unhandledRejection`）——注意**扩展错误不在这里**：
 *    它们已被 `runExtensionSafely` 隔离成 `log` + 状态表，能走到这里的是宿主自己的 bug。
 *
 * ## 硬约束
 * - **不得 import Electron 的 main-only API**（`app` / `BrowserWindow` / `dialog` / `i18n` …）：
 *   utilityProcess 里没有它们，import 即崩。本文件只 import 本目录模块与 Node 内建。
 * - **入口注册不在这里**：`electron.vite.config.ts` 的路由由 EH-A2 负责；本文件只要保证
 *   自己是一个「被 fork 起来就能跑」的合法入口。
 *
 * ## 环境变量（临时桥，EH-A2 若改为经 `init` 之外的渠道传 appInfo 可替换）
 * - `OBOX_APP_NAME` / `OBOX_APP_VERSION`：`api.appInfo` / `api.env.getOboxVersion` 的值
 *   （`init` 信封里没有应用版本字段，宿主只能从这里知道；缺省 `obox` / `0.0.0`）。
 * - `OBOX_LOCALE`：`api.env.language`（缺省 `zh`）。
 */
import { randomUUID } from 'node:crypto'
import { toErrorMessage } from './errors'
import {
  createHostPortsFromParentPort,
  type HostRendererPortLike,
  type ParentPortLike
} from './port'
import { ExtensionHostRuntime } from './runtime'

/**
 * 取 `process.parentPort`。
 *
 * 用结构化访问而不是 `import { parentPort } from 'electron'`：宿主进程不需要（也不该要）
 * Electron 的类型面，Electron 在 utilityProcess 里注入的 `process.parentPort` 形状即
 * `ParentPortLike`。
 */
function readParentPort(): ParentPortLike | null {
  const candidate = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  return candidate ?? null
}

/** 从环境变量读应用信息（`init` 信封不含应用版本，见文件头说明） */
function readAppInfo(): { name: string; version: string } {
  return {
    name: process.env.OBOX_APP_NAME ?? 'obox',
    version: process.env.OBOX_APP_VERSION ?? '0.0.0'
  }
}

/** 启动宿主；没有父端口说明被当成普通 Node 脚本执行了，直接报错退出（不要静默空转） */
function start(): void {
  const parentPort = readParentPort()
  if (!parentPort) {
    process.stderr.write(
      '[extension-host] 未检测到 process.parentPort：本文件只能作为 Electron utilityProcess 的入口运行\n'
    )
    process.exit(1)
    return
  }

  // 两条端口一次建好（EH-B3b-1）：`main` 收发信封，`renderer` 是随 `init` 的 transfer 到达的
  // `host-renderer` port1。`renderer` 用 getter 惰性读——构造这一刻它还没到。
  const ports = createHostPortsFromParentPort(parentPort)

  const runtime = new ExtensionHostRuntime({
    port: ports.main,
    rendererPort: (): HostRendererPortLike | null => ports.renderer,
    hostId: randomUUID(),
    pid: process.pid,
    appInfo: readAppInfo(),
    locale: process.env.OBOX_LOCALE ?? 'zh',
    // 开发时（`--inspect` + 终端）能看到日志；打包后 stdout 不可见，主出口仍是 `log` 信封
    echoLog: true
  })

  /**
   * 未捕获异常：宿主自身 bug，记一条日志后退出（让 A2 的崩溃计数接手重启）。
   * 用 `setImmediate` 让 `postMessage` 有机会把日志送出去，再退出。
   */
  process.on('uncaughtException', (error: Error): void => {
    runtime.log('error', '扩展宿主未捕获异常，即将退出', error.stack ?? error.message)
    setImmediate((): void => {
      process.exit(1)
    })
  })

  /**
   * 未处理的 Promise rejection：**不退出**。绝大多数来自扩展异步回调忘了 catch；
   * 杀掉宿主会让所有扩展一起挂（与「一个扩展失败不影响其它」相反）。记日志后继续服务。
   */
  process.on('unhandledRejection', (reason: unknown): void => {
    runtime.log(
      'error',
      '扩展宿主未处理的 Promise rejection（已忽略，进程继续）',
      toErrorMessage(reason)
    )
  })

  runtime.start()
}

start()
