/**
 * **进程族（二）**：`api.python.run`（EH-B2）—— 宿主内拉起扩展自带的 Python sidecar，收流并返回。
 *
 * ## 分工（为什么不是一个 RPC 让 main 跑）
 *
 * Python 运行时是**扩展自带**的（`<扩展>/python/python.exe`，ADR-0018），但"运行时在哪、用哪份
 * 环境"由 main 的既有规则决定（`src/main/pythonCore.ts` 的 `pythonExecutablePath` /
 * `buildPythonEnv` / `pythonUserSiteDir`，其中 `PYTHONHOME` 指向扩展目录、`PYTHONPATH` 指向
 * `<data>/user-site`）。宿主进程拿不到 `app.getPath('userData')`，所以：
 *
 * - **运行时定位仍归 main**：宿主发一条**宿主内部 RPC** `host.pythonRuntime`
 *   （`{ extId, script } → { ok:true, exePath, scriptPath, env, cwd }`，失败时 `{ ok:false, code, error }`），
 *   main 侧在 `src/main/index.ts` 用**既有解析函数**算（不复制一份路径规则）；
 * - **进程与流归宿主**：spawn、stdout/stderr 收集、2 MiB 上限、进程树终止、`channel` 注册成
 *   `api.ipc` 通道——全是本文件，复用 main 的 `pythonRun.startPythonRun`（shell 调用 + cmd 转义 +
 *   `taskkill /T /F` 都已在 `pythonCore` 里测过）。
 *
 * 形状写进回执（R60）：这正是本卡唯一新增的宿主内部 RPC；它**不进扩展 API 面**，扩展看到的仍然只有
 * `api.python.run(...)`，所以 `docs/extension-api/**` 一个字都不用改。
 *
 * ## 语义（逐条照 `src/api/types.ts` 的 `python.run` 注释）
 *
 * - **默认不超时**：交互式脚本（`plt.show()`）会开窗等用户关窗，调用一直等到进程结束；
 * - **脚本自身失败不抛错**：返回非零 `code` + `stderr`（调用方自己判断 `code`）；
 * - **宿主侧失败才抛**，稳定错误码：`python-missing` / `arch-mismatch` / `launch-failed` /
 *   `invalid-declaration`（本文件抛出的 `Error.message` 以 `[码] ` 开头，与渲染进程时代一致）；
 * - `opts.channel`：该进程被注册成一条 **`api.ipc` 通道**（占用"每扩展 4 条通道"限额），随后用
 *   `api.ipc.request/onRequest/...` 交互；Python 侧要自行实现 JSON-RPC 与 `Content-Length` 分帧。
 */
import { mkdir } from 'node:fs/promises'
import type { ExtensionActivationApi } from '../../api/types'
import type { PythonErrorCode } from '../../main/pythonCore'
import { isPythonCoreError, normalizeChannelName, PythonCoreError } from '../../main/pythonCore'
import { startPythonRun, type PythonRunHandle } from '../../main/pythonRun'
import { toErrorMessage } from '../errors'
import type { HostLogger } from '../log'
import type { HostMainBridge } from './io'
import type { IpcCapabilities } from './ipc'

/* -------------------------------------------------------------------------------------------- */
/* 宿主内部 RPC（宿主 → main）                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** 宿主 → main：取该扩展的 Python 运行时（exe / 脚本绝对路径 / 环境 / cwd） */
export const PYTHON_RUNTIME_METHOD = 'host.pythonRuntime'

/** `host.pythonRuntime` 的参数（形状与 `src/main/index.ts` 的处理器一一对应） */
export interface PythonRuntimeRequest {
  extId: string
  script: string
}

/** `host.pythonRuntime` 成功时的载荷 */
export interface PythonRuntimeInfo {
  /** 解释器绝对路径（`<扩展>/python/python.exe`） */
  exePath: string
  /** 脚本绝对路径（已做"必须在扩展目录内"的包含校验） */
  scriptPath: string
  /** 子进程环境（白名单 + `PYTHONHOME` / `PYTHONPATH` / `PYTHONNOUSERSITE`） */
  env: Record<string, string>
  /** 工作目录（扩展 data 目录，与 main 的 `dataDirFor` 一致） */
  cwd: string
}

/** `host.pythonRuntime` 的失败载荷（`code` 只用 `pythonCore.PythonErrorCode` 的四个稳定码） */
export interface PythonRuntimeFailure {
  ok: false
  code: PythonErrorCode
  error: string
}

/** `host.pythonRuntime` 的返回：成功带全量信息，失败带稳定错误码 */
export type PythonRuntimeResponse = ({ ok: true } & PythonRuntimeInfo) | PythonRuntimeFailure

/* -------------------------------------------------------------------------------------------- */
/* 参数与返回值                                                                                  */
/* -------------------------------------------------------------------------------------------- */

export interface HostPythonCapabilitiesOptions {
  /** 扩展 id（请求 main 时带上；日志归属） */
  extId: string
  /** 宿主日志 */
  log: HostLogger
  /** 宿主 → main 通道（缺省 = 未接线：`run` 给可执行的中文错误，而不是装作能跑） */
  hostMain?: HostMainBridge
  /** IPC 能力族（`opts.channel` 时把进程注册成一条通道） */
  ipc: Pick<IpcCapabilities, 'registerStreamChannel' | 'closeChannel'>
  /** stdout/stderr 收集上限（字节，缺省 `pythonCore.DEFAULT_MAX_OUTPUT_BYTES` = 2 MiB） */
  maxOutputBytes?: number
}

/** 进程能力族（python 部分） */
export interface PythonCapabilities {
  /** `api.python`（声明里的 1 个成员） */
  readonly api: ExtensionActivationApi['python']
  /** 当前在跑的脚本进程数（诊断/测试；dispose 后必为 0） */
  runningCount(): number
  /** 杀掉该扩展全部在跑的脚本进程（扩展停用/宿主退出；幂等） */
  dispose(): void
}

/* -------------------------------------------------------------------------------------------- */
/* 工厂                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** 带稳定码的宿主侧失败（`message` 以 `[码] ` 开头，与渲染进程时代逐字一致） */
function pythonError(code: PythonErrorCode, message: string): Error {
  const error = new Error(`[${code}] ${message}`) as Error & { code?: PythonErrorCode }
  error.code = code
  return error
}

/** 任意失败 → 带稳定码的 `Error`（`PythonCoreError` 自带码；其余算 `launch-failed`） */
function normalizeFailure(error: unknown): Error {
  if (isPythonCoreError(error)) return pythonError(error.code, error.message)
  return pythonError('launch-failed', toErrorMessage(error))
}

/** `channel` 入参的解读：省略/`false` 不建通道；`true` 用缺省名；字符串用该名（与 main 同规则） */
function resolveChannelName(raw: string | boolean | undefined): string | undefined {
  if (raw === undefined || raw === false) return undefined
  try {
    if (raw === true) return normalizeChannelName(undefined)
    return normalizeChannelName(raw)
  } catch (error) {
    throw normalizeFailure(error)
  }
}

/** 校验 main 回的载荷；形状不对 → `launch-failed`（不猜、不静默降级） */
function parseRuntimeResponse(raw: unknown): PythonRuntimeInfo {
  if (typeof raw !== 'object' || raw === null) {
    throw pythonError('launch-failed', '主进程返回了无法识别的 Python 运行时信息')
  }
  const record = raw as {
    ok?: unknown
    code?: unknown
    error?: unknown
    exePath?: unknown
    scriptPath?: unknown
    env?: unknown
    cwd?: unknown
  }
  if (record.ok === false) {
    const code =
      typeof record.code === 'string' ? (record.code as PythonErrorCode) : 'launch-failed'
    throw pythonError(
      code,
      typeof record.error === 'string' ? record.error : '无法获取 Python 运行时'
    )
  }
  if (record.ok !== true) {
    throw pythonError('launch-failed', '主进程返回了无法识别的 Python 运行时信息')
  }
  if (typeof record.exePath !== 'string' || record.exePath.trim() === '') {
    throw pythonError('python-missing', '宿主拿到的 Python 解释器路径为空')
  }
  if (typeof record.scriptPath !== 'string' || record.scriptPath.trim() === '') {
    throw pythonError('invalid-declaration', '宿主拿到的脚本路径为空')
  }
  if (typeof record.cwd !== 'string' || record.cwd.trim() === '') {
    throw pythonError('launch-failed', '宿主拿到的工作目录为空')
  }
  const env: Record<string, string> = {}
  if (typeof record.env === 'object' && record.env !== null) {
    for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value
    }
  }
  return { exePath: record.exePath, scriptPath: record.scriptPath, env, cwd: record.cwd }
}

/**
 * 按扩展构造 python 能力。
 *
 * 降级（`hostMain` 未接线）：**明确失败**而不是"跑到一半才发现"——`run` 当场抛
 * `[launch-failed] 无法获取 Python 运行时：宿主未接入 host→main 通道（host.pythonRuntime）…`。
 * 这条文案与"能力尚未迁移"（`CAPABILITY_NOT_MIGRATED_HINT`）刻意不同：它不是"还没搬"，
 * 而是"桥没接上"，排查方向完全不同（同 EH-B1 的 clipboard 分支）。
 */
export function createPythonCapabilities(
  options: HostPythonCapabilitiesOptions
): PythonCapabilities {
  const extId = options.extId
  const running = new Set<PythonRunHandle>()
  let disposed = false

  /** 向 main 要运行时信息（唯一一座桥；失败一律变成带码的 `Error`） */
  const requestRuntime = async (script: string): Promise<PythonRuntimeInfo> => {
    const bridge = options.hostMain
    if (bridge === undefined) {
      throw pythonError(
        'launch-failed',
        '无法获取 Python 运行时：宿主未接入 host→main 通道（host.pythonRuntime）；' +
          '请在主进程注册该 RPC（见 src/main/index.ts），或改用非宿主模式运行扩展'
      )
    }
    let raw: unknown
    try {
      const request: PythonRuntimeRequest = { extId, script }
      raw = await bridge.request(PYTHON_RUNTIME_METHOD, request)
    } catch (error) {
      throw pythonError('launch-failed', `读取 Python 运行时失败：${toErrorMessage(error)}`)
    }
    return parseRuntimeResponse(raw)
  }

  const run = async (
    script: string,
    args?: string[],
    opts?: { channel?: string | boolean }
  ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    if (disposed) throw new Error('该扩展的 api 已释放（dispose 之后不能再 python.run）')
    if (typeof script !== 'string' || script.trim() === '') {
      throw pythonError('invalid-declaration', '脚本路径不能为空')
    }
    if (
      args !== undefined &&
      (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    ) {
      throw pythonError('invalid-declaration', 'python.run 的 args 必须是字符串数组')
    }
    const channelName = resolveChannelName(opts?.channel)
    const runtime = await requestRuntime(script)
    await mkdir(runtime.cwd, { recursive: true })

    let handle: PythonRunHandle
    try {
      handle = startPythonRun({
        pythonExe: runtime.exePath,
        script: runtime.scriptPath,
        args,
        cwd: runtime.cwd,
        env: runtime.env,
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes })
      })
    } catch (error) {
      throw normalizeFailure(error)
    }
    running.add(handle)

    let channelRegistered = false
    try {
      if (channelName !== undefined) {
        const streams = handle.streams()
        if (!streams.stdin || !streams.stdout) {
          throw new PythonCoreError('launch-failed', '子进程未提供可用的 stdin/stdout')
        }
        // 注册失败（如通道数超限）会抛错 → 走 catch，进程会被杀掉
        options.ipc.registerStreamChannel(channelName, {
          readable: streams.stdout,
          writable: streams.stdin,
          onDispose: (): void => {
            void handle.kill().catch(() => undefined)
          }
        })
        channelRegistered = true
      }
      const result = await handle.result
      if (channelRegistered && channelName !== undefined) options.ipc.closeChannel(channelName)
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      await handle.kill().catch(() => undefined)
      if (channelRegistered && channelName !== undefined) options.ipc.closeChannel(channelName)
      throw normalizeFailure(error)
    } finally {
      running.delete(handle)
    }
  }

  return {
    api: { run },
    runningCount: (): number => running.size,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const handle of [...running]) {
        // `kill()` 会杀进程树（Windows: taskkill /T /F）并等子进程真的结束；这里不 await
        // （`dispose()` 是同步契约），失败只记日志
        void handle.kill().catch((error: unknown) => {
          options.log('warn', `[${extId}] 终止 Python 子进程失败`, toErrorMessage(error))
        })
      }
      running.clear()
    }
  }
}
