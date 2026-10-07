/**
 * Python 运行时接入的**核心**（不依赖 electron，可独立单测）：见 issue #51 / ADR-0018。
 *
 * 这里只做纯计算与校验：运行时定位、清单声明校验、环境预处理、命令行构造、进程树终止命令、输出上限。
 * 真正的 spawn / kill / mkdir 由主进程薄壳执行，因此本模块用纯函数与真实临时目录即可测。
 *
 * 几个刻意的取舍（都写进注释，避免后人误改）：
 * - **shell 调用**：命令行要交给 `cmd.exe`（`spawn(cmdline, { shell: true })`），因此参数必须按 cmd 规则引号转义；
 * - **进程树**：`shell: true` 后直接子进程是 `cmd.exe`，终止必须连树（否则 `python.exe` 残留）；
 * - **代理不注入**：环境只放行白名单键 + 我们显式设置的三项；宿主代理对 Python 无效（见 #51 决策 10）。
 */
import { join } from 'node:path'

/** 目标架构（与 .oix 的每架构一个包对应） */
export type PythonArch = 'x64' | 'arm64'

/**
 * 错误码：`python-missing` / `arch-mismatch` / `launch-failed` 为 #51 定下的宿主侧三码；
 * `invalid-declaration` 复刻 `api.ipc` 的既有命名，用于清单声明本身不合法（与运行期失败区分开）。
 */
export type PythonErrorCode =
  'python-missing' | 'arch-mismatch' | 'launch-failed' | 'invalid-declaration'

/** 运行时在扩展目录下的固定子目录 */
export const PYTHON_DIR = 'python'
/** Windows 解释器可执行文件名 */
export const PYTHON_EXECUTABLE = 'python.exe'
/** `api.ipc` 通道名的缺省值（扩展可在 run 时指定） */
export const DEFAULT_PYTHON_CHANNEL = 'python'
/** stdout/stderr 收集上限（超出即截断并标记，避免长脚本吃光内存） */
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
/** 用户库（data 目录下）子目录名：随扩展升级保留 */
export const USER_SITE_DIR = 'user-site'

const SUPPORTED_ARCHES: readonly PythonArch[] = ['x64', 'arm64']
const PYTHON_VERSION_RE = /^\d+\.\d+$/
const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'SystemRoot',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LANG'
]

/** 核心错误：带稳定错误码，便于宿主映射成扩展可见的失败 */
export class PythonCoreError extends Error {
  readonly code: PythonErrorCode

  constructor(code: PythonErrorCode, message: string) {
    super(message)
    this.name = 'PythonCoreError'
    this.code = code
  }
}

export function isPythonCoreError(value: unknown): value is PythonCoreError {
  return value instanceof PythonCoreError
}

/** 清单里的 python 声明（校验后的形状） */
export interface PythonDeclaration {
  arch: PythonArch
  python: string
  requirements?: string[]
}

/**
 * 把 Node 的 `process.arch` 映射成运行时架构声明；不支持的架构返回 null
 * （调用方据此"无法比较时跳过校验"，而不是误判为不匹配）。
 */
export function toPythonArch(arch: string): PythonArch | null {
  if (arch === 'x64' || arch === 'arm64') return arch
  return null
}

/**
 * 校验 manifest 的 python 声明。
 *
 * - 架构不在支持列表 → `invalid-declaration`；架构与当前设备不符 → `arch-mismatch`（安装期即拦下）
 * - 版本号必须是形如 `3.13` 的主次版本；`requirements` 若出现必须是非空字符串数组
 */
export function validatePythonDeclaration(raw: unknown, hostArch: PythonArch): PythonDeclaration {
  if (typeof raw !== 'object' || raw === null) {
    throw new PythonCoreError('invalid-declaration', '清单里的 python 声明必须是对象')
  }
  const record = raw as Record<string, unknown>
  const arch = record.arch
  if (typeof arch !== 'string' || !SUPPORTED_ARCHES.includes(arch as PythonArch)) {
    throw new PythonCoreError(
      'invalid-declaration',
      `python.arch 必须是 ${SUPPORTED_ARCHES.join(' 或 ')}`
    )
  }
  if (arch !== hostArch) {
    throw new PythonCoreError(
      'arch-mismatch',
      `扩展自带的是 ${arch} 运行时，当前设备为 ${hostArch}，请安装对应架构的包`
    )
  }
  const python = record.python
  if (typeof python !== 'string' || !PYTHON_VERSION_RE.test(python)) {
    throw new PythonCoreError('invalid-declaration', 'python.python 必须是形如 "3.13" 的主次版本号')
  }
  const declaration: PythonDeclaration = { arch: arch as PythonArch, python }
  const requirements = record.requirements
  if (requirements !== undefined) {
    if (
      !Array.isArray(requirements) ||
      requirements.some((item) => typeof item !== 'string' || item.trim() === '')
    ) {
      throw new PythonCoreError('invalid-declaration', 'python.requirements 必须是非空字符串数组')
    }
    declaration.requirements = requirements.map((item) => (item as string).trim())
  }
  return declaration
}

/** 解释器路径：`<扩展>/python/python.exe` */
export function pythonExecutablePath(extensionDir: string): string {
  if (!extensionDir) throw new PythonCoreError('invalid-declaration', '扩展目录不能为空')
  return join(extensionDir, PYTHON_DIR, PYTHON_EXECUTABLE)
}

/** 用户库目录：`<扩展 data>/user-site`（随扩展升级保留，由薄壳负责创建） */
export function pythonUserSiteDir(dataDir: string): string {
  if (!dataDir) throw new PythonCoreError('invalid-declaration', '扩展数据目录不能为空')
  return join(dataDir, USER_SITE_DIR)
}

export interface PythonEnvInput {
  /** 宿主环境（只取白名单键；其余一律不传，含代理与密钥） */
  baseEnv: Record<string, string | undefined>
  extensionDir: string
  dataDir: string
}

/**
 * 构造 Python 子进程环境：白名单键 + `PYTHONHOME`（运行时）+ `PYTHONPATH`（用户库）+ 禁用平台用户目录。
 *
 * 注意：**不注入代理**（#51 决策 10），因此宿主的代理设置对 pip 无效——这是有意的，记录在文档里。
 */
export function buildPythonEnv(input: PythonEnvInput): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = input.baseEnv[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  env.PYTHONHOME = join(input.extensionDir, PYTHON_DIR)
  env.PYTHONPATH = pythonUserSiteDir(input.dataDir)
  env.PYTHONNOUSERSITE = '1'
  return env
}

/**
 * 按 `cmd.exe` 规则给单个参数加引号（命令行交给 `cmd.exe` 执行，见文件头取舍）。
 *
 * 覆盖：空串、含空白/`&|<>^()`/引号的参数、结尾反斜杠（C 运行时会吞掉引号前的反斜杠，故加倍）。
 * 已知边界：cmd 的转义规则本身很微妙，极端参数请改用 argv 形式（若将来放开该路径）。
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"&|<>^()]/.test(arg)) return arg
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"')
  escaped = escaped.replace(/(\\+)$/, '$1$1')
  return `"${escaped}"`
}

export interface PythonCommandInput {
  pythonExe: string
  script: string
  args?: string[]
}

/** 构造交给 `cmd.exe` 的完整命令行：解释器 + 脚本 + 参数，逐个按 cmd 规则转义 */
export function buildPythonCommandLine(input: PythonCommandInput): string {
  if (!input.pythonExe) throw new PythonCoreError('invalid-declaration', 'pythonExe 不能为空')
  if (!input.script) throw new PythonCoreError('invalid-declaration', '脚本路径不能为空')
  const parts = [quoteWindowsArg(input.pythonExe), quoteWindowsArg(input.script)]
  for (const arg of input.args ?? []) parts.push(quoteWindowsArg(arg))
  return parts.join(' ')
}

/** 规范化 `api.ipc` 通道名：缺省 `python`；非法则报错（与 `api.ipc` 的通道名规则一致） */
export function normalizeChannelName(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PYTHON_CHANNEL
  if (typeof raw !== 'string' || !CHANNEL_RE.test(raw)) {
    throw new PythonCoreError(
      'invalid-declaration',
      'python 通道名只能含字母数字与 . _ -，且以字母数字开头'
    )
  }
  return raw
}

/** 进程树终止命令（Windows：连子孙一起结束，避免 `cmd.exe` 退出后 `python.exe` 残留） */
export function processTreeKillCommand(pid: number): { program: string; args: string[] } {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new PythonCoreError('launch-failed', `无效的进程号：${String(pid)}`)
  }
  return { program: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
}

/**
 * 带上限地累积输出：超过上限按剩余字节尽量截断，并置 `truncated`（调用方据此提示用户）。
 * 已是上限时不再追加任何内容。
 */
export function appendWithCap(
  current: string,
  chunk: string,
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES
): { text: string; truncated: boolean } {
  if (chunk === '') return { text: current, truncated: false }
  const currentBytes = Buffer.byteLength(current)
  if (currentBytes >= maxBytes) return { text: current, truncated: true }
  const room = maxBytes - currentBytes
  if (Buffer.byteLength(chunk) <= room) return { text: current + chunk, truncated: false }
  let slice = chunk
  while (slice.length > 0 && Buffer.byteLength(slice) > room) slice = slice.slice(0, -1)
  return { text: current + slice, truncated: true }
}
