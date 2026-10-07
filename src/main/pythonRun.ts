/**
 * 解释器脚本的**启动与收尾**（不依赖 electron，用真实子进程单测；见 issue #51 / ADR-0018）。
 *
 * 对应 #51 的既定决策：
 * - **shell 调用**：命令行交给 `cmd.exe`（`spawn(cmdline, { shell: true })`）——因此参数必须按 cmd 规则转义，
 *   转义与命令行构造在 `pythonCore.ts`（已有单测覆盖空串/空白/元字符/内部引号/结尾反斜杠）；
 * - **进程树终止**：`shell: true` 之后直接子进程是 `cmd.exe`，只杀它会留下 `python.exe` 残影，
 *   所以 kill 走 `taskkill /PID <pid> /T /F`；
 * - **输出收集带上限**：默认 2 MiB，超出截断并置 `truncated`（避免长脚本吃光内存）；
 * - **默认不超时**：交互式脚本（`plt.show()`）会开窗等用户关窗，超时语义由调用方决定（见规格）。
 *
 * 协议通道**不在这里建立**：本模块只把子进程的 stdin/stdout 交出去，由宿主注册成一条
 * `api.ipc` 通道（通道名由扩展在 `run` 时指定）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import {
  appendWithCap,
  buildPythonCommandLine,
  DEFAULT_MAX_OUTPUT_BYTES,
  processTreeKillCommand
} from './pythonCore'

export interface PythonRunOptions {
  /** 解释器可执行文件（来自 `<扩展>/python/python.exe`） */
  pythonExe: string
  /** 脚本路径（绝对路径或相对 cwd） */
  script: string
  args?: string[]
  /** 工作目录（宿主用扩展 data 目录） */
  cwd: string
  /** 子进程环境（由 `pythonCore.buildPythonEnv` 构造：白名单 + PYTHONHOME/PYTHONPATH） */
  env: Record<string, string>
  /** 输出收集上限（默认 2 MiB） */
  maxOutputBytes?: number
}

export interface PythonRunResult {
  /** 退出码（null = 被信号终止或启动失败） */
  code: number | null
  stdout: string
  stderr: string
  /** 输出是否被截断（stdout/stderr 任一超限即 true） */
  truncated: boolean
}

export interface PythonRunHandle {
  /** 直接子进程 pid（`cmd.exe`；进程树终止用） */
  pid(): number | undefined
  /** 等脚本结束（默认不超时） */
  result: Promise<PythonRunResult>
  /** 杀进程树，并等到子进程确实结束 */
  kill(): Promise<void>
  /** 交给 API 层注册 IPC 通道用的流 */
  streams(): { stdin: Writable | null; stdout: Readable | null }
}

export function startPythonRun(options: PythonRunOptions): PythonRunHandle {
  const commandLine = buildPythonCommandLine({
    pythonExe: options.pythonExe,
    script: options.script,
    args: options.args
  })
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  const child: ChildProcessWithoutNullStreams = spawn(commandLine, {
    shell: true,
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  let truncated = false
  const collect = (chunk: Buffer, which: 'stdout' | 'stderr'): void => {
    const current = which === 'stdout' ? stdout : stderr
    const next = appendWithCap(current, chunk.toString('utf8'), maxBytes)
    if (which === 'stdout') stdout = next.text
    else stderr = next.text
    if (next.truncated) truncated = true
  }
  child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
  child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))

  const result = new Promise<PythonRunResult>((resolve) => {
    let settled = false
    const settle = (value: PythonRunResult): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.on('error', (err) => {
      stderr = `${stderr}\n[启动失败] ${err.message}`.trim()
      truncated = true
      settle({ code: null, stdout, stderr, truncated })
    })
    child.on('close', (code) => settle({ code, stdout, stderr, truncated }))
  })

  return {
    pid: (): number | undefined => child.pid,
    result,
    async kill(): Promise<void> {
      const pid = child.pid
      if (pid === undefined) {
        child.kill()
        return
      }
      const { program, args } = processTreeKillCommand(pid)
      await new Promise<void>((resolve) => {
        const killer = spawn(program, args, { windowsHide: true, stdio: 'ignore' })
        // taskkill 不可用时退回单进程 kill（尽力而为，绝不让调用方卡住）
        killer.on('error', () => {
          child.kill()
          resolve()
        })
        killer.on('close', () => resolve())
      })
      await result
    },
    streams: (): { stdin: Writable | null; stdout: Readable | null } => ({
      stdin: child.stdin,
      stdout: child.stdout
    })
  }
}
