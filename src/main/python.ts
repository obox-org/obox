/**
 * 扩展自带 Python 运行时的**主进程薄壳**（issue #51 / ADR-0018）。
 *
 * 纯逻辑都在可单测的模块里，这里只做接线：
 * - `pythonCore.ts`：路径约定、声明校验、环境白名单与注入、cmd 转义、通道名、进程树命令、输出上限
 * - `pythonRun.ts`：以 shell 方式启动脚本、收集输出、杀进程树（真实子进程测试）
 * - `ipc.ts`：把该进程注册成一条 `api.ipc` 通道（限额、关闭广播与注销共用同一套治理）
 *
 * 语义要点（与规格一致）：
 * - **默认不超时**：交互式脚本（`plt.show()`）会开窗等用户关窗；
 * - **脚本自身失败不抛错**：返回非零 `code` + `stderr`；只有宿主故障才以错误码失败
 *   （`python-missing` / `arch-mismatch` / `launch-failed` / `invalid-declaration`）；
 * - **不注入代理**：子进程只拿白名单 env（宿主的代理设置对 Python 无效，见决策 10）；
 * - 扩展停用/卸载/重载时**杀进程树**（并入既有 `extension:cleanup`）。
 */
import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PythonRunInput, PythonRunOutcome } from '../shared/types'
import { closeExtensionChannel, registerStreamChannel } from './ipc'
import { isIpcCoreError } from './ipcCore'
import { resolveProgramInExtension } from './ipcTransport'
import { getUserExtensionsDir } from './paths'
import {
  PythonCoreError,
  buildPythonEnv,
  isPythonCoreError,
  normalizeChannelName,
  pythonExecutablePath,
  pythonUserSiteDir
} from './pythonCore'
import { startPythonRun, type PythonRunHandle } from './pythonRun'

/** 扩展数据目录（与 fs/sqlite 同一约定：userData/extensions/<id>/data） */
function dataDirFor(extId: string): string {
  return join(app.getPath('userData'), 'extensions', extId, 'data')
}

/** 正在跑的脚本进程（停用/卸载时统一杀进程树） */
const running = new Map<string, Set<PythonRunHandle>>()

function track(extId: string, handle: PythonRunHandle): () => void {
  const set = running.get(extId) ?? new Set<PythonRunHandle>()
  set.add(handle)
  running.set(extId, set)
  return (): void => {
    set.delete(handle)
    if (set.size === 0) running.delete(extId)
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 宿主侧失败 → 带稳定错误码的返回值（渲染进程再还原成抛错） */
function fail(err: unknown): PythonRunOutcome {
  if (isPythonCoreError(err)) return { ok: false, code: err.code, error: err.message }
  if (isIpcCoreError(err)) return { ok: false, code: err.code, error: err.message }
  return {
    ok: false,
    code: 'launch-failed',
    error: err instanceof Error ? err.message : String(err)
  }
}

/**
 * `channel` 入参的解读：省略/`false` 不建通道；`true` 用缺省名；字符串用该名。
 * 默认**不建**通道是有意的：建了通道，进程的 stdout 就是协议流，普通脚本的一句 `print` 会破坏分帧。
 */
function resolveChannelName(raw: PythonRunInput['channel']): string | undefined {
  if (raw === undefined || raw === false) return undefined
  if (raw === true) return normalizeChannelName(undefined)
  return normalizeChannelName(raw)
}

/** 跑一个脚本（见文件头语义）；失败以返回值表达，不向 IPC 层抛错 */
export async function runPython(extId: string, input: PythonRunInput): Promise<PythonRunOutcome> {
  let handle: PythonRunHandle | undefined
  let channelName: string | undefined
  let untrack: (() => void) | undefined
  try {
    const extensionDir = join(getUserExtensionsDir(), extId)
    const pythonExe = pythonExecutablePath(extensionDir)
    if (!(await pathExists(pythonExe))) {
      throw new PythonCoreError('python-missing', `扩展未自带该架构的 Python 运行时：${pythonExe}`)
    }
    if (typeof input?.script !== 'string' || !input.script.trim()) {
      throw new PythonCoreError('invalid-declaration', '脚本路径不能为空')
    }
    // 越界一律拒绝（声明校验之外的第二道包含检查）
    const script = resolveProgramInExtension(extensionDir, input.script)
    if (!(await pathExists(script))) {
      throw new PythonCoreError('invalid-declaration', `脚本不存在：${input.script}`)
    }
    channelName = resolveChannelName(input.channel)

    const dataDir = dataDirFor(extId)
    // 用户库目录（随扩展升级保留；见 ADR-0018）：注入 PYTHONPATH 前确保存在
    await fs.mkdir(pythonUserSiteDir(dataDir), { recursive: true })

    handle = startPythonRun({
      pythonExe,
      script,
      args: input.args,
      cwd: dataDir,
      env: buildPythonEnv({ baseEnv: process.env, extensionDir, dataDir })
    })
    untrack = track(extId, handle)

    if (channelName !== undefined) {
      const streams = handle.streams()
      if (!streams.stdin || !streams.stdout) {
        throw new PythonCoreError('launch-failed', '子进程未提供可用的 stdin/stdout')
      }
      // 注册失败（如通道数超限）会抛错 → 走下面的 catch，进程会被杀掉
      registerStreamChannel(extId, channelName, {
        readable: streams.stdout,
        writable: streams.stdin,
        onDispose: (): void => {
          void handle?.kill().catch(() => undefined)
        }
      })
    }

    const result = await handle.result
    if (channelName !== undefined) {
      // 进程结束 → 注销通道（ipc.ts 的 onClose 会广播 close 事件）
      closeExtensionChannel(extId, channelName)
    }
    return {
      ok: true,
      result: { code: result.code, stdout: result.stdout, stderr: result.stderr }
    }
  } catch (err) {
    if (handle) await handle.kill().catch(() => undefined)
    if (channelName !== undefined) closeExtensionChannel(extId, channelName)
    return fail(err)
  } finally {
    untrack?.()
  }
}

/** 扩展停用/卸载/重载：杀掉它所有在跑的脚本（进程树） */
export function closeExtensionPython(extId: string): void {
  const set = running.get(extId)
  if (!set) return
  for (const handle of [...set]) void handle.kill().catch(() => undefined)
  running.delete(extId)
}

export function registerPythonIpc(): void {
  ipcMain.handle(
    'python:run',
    async (_e, extId: unknown, input: PythonRunInput): Promise<PythonRunOutcome> => {
      if (typeof extId !== 'string' || !extId) {
        return { ok: false, code: 'invalid-declaration', error: '无效的扩展 id' }
      }
      return runPython(extId, input ?? { script: '' })
    }
  )
}
