/**
 * IPC 通道声明与校验（**主进程与渲染进程共用**）。
 *
 * 为什么在 `shared/`：主进程用它校验运行时声明；渲染进程要在**清单校验阶段**校验
 * `contributes.ipcChannels`（issue #45），而渲染进程不能 import 主进程模块（会把 `node:path` 之类
 * 拖进 renderer 包）。规则只能放双方都能引用的地方，才能做到"只有一套校验"。
 *
 * 名字规则（`IPC_NAME_RE`）也在这里，由 `src/main/ipcCore.ts` 的 `sanitizeIpcName` 复用。
 */

/** 分帧方式：默认 content-length（`Content-Length: <n>\r\n\r\n`），可改 ndjson（每行一条） */
export type Framing = 'content-length' | 'ndjson'

/** 传输：stdio（宿主拉起子进程）/ pipe（连接已在运行的进程）。**不含 TCP/端口** */
export type IpcTransport = 'stdio' | 'pipe'

export interface IpcChannelDeclaration {
  /** 通道名（同一扩展内唯一） */
  id: string
  /** 传输：stdio（宿主拉起子进程）/ pipe（连接已在运行的进程） */
  transport: IpcTransport
  /** stdio 必填：相对扩展目录的可执行文件/脚本路径（禁止绝对路径与 ..） */
  program?: string
  /** stdio 可选：命令行参数 */
  args?: string[]
  /** 分帧（默认 content-length） */
  framing?: Framing
}

/** 声明非法（主进程会把它转成 `IpcCoreError('invalid-declaration')`，保持既有错误码契约） */
export class IpcDeclarationError extends Error {
  readonly code = 'invalid-declaration'
  constructor(message: string) {
    super(message)
    this.name = 'IpcDeclarationError'
  }
}

/** 通道/扩展 id 片段：只允许字母数字与 . _ -，禁止路径分隔符与 .. */
export const IPC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 名称是否合法（纯谓词：两个错误类型各自包装，规则只有这一份） */
export function isValidIpcName(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const value = raw.trim()
  return Boolean(value) && IPC_NAME_RE.test(value) && !value.includes('..')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 校验一个通道声明；非法即抛 `IpcDeclarationError` */
export function validateIpcDeclaration(raw: unknown): IpcChannelDeclaration {
  if (!isRecord(raw)) {
    throw new IpcDeclarationError('通道声明必须是对象')
  }
  if (!isValidIpcName(raw.id)) {
    throw new IpcDeclarationError(
      `通道 id 非法（只允许字母/数字/./_/-，且不能含 ..）: ${String(raw.id)}`
    )
  }
  const id = String(raw.id).trim()
  const transport = raw.transport
  if (transport !== 'stdio' && transport !== 'pipe') {
    throw new IpcDeclarationError(
      `通道 ${id} 的 transport 必须是 'stdio' 或 'pipe'（不支持 TCP/端口）`
    )
  }
  const framing = raw.framing
  if (framing !== undefined && framing !== 'content-length' && framing !== 'ndjson') {
    throw new IpcDeclarationError(`通道 ${id} 的 framing 非法: ${String(framing)}`)
  }
  const declaration: IpcChannelDeclaration = { id, transport }
  if (framing) declaration.framing = framing

  if (transport === 'stdio') {
    const program = raw.program
    if (typeof program !== 'string' || !program.trim()) {
      throw new IpcDeclarationError(`stdio 通道 ${id} 必须声明 program`)
    }
    const normalized = program.replace(/\\/g, '/').replace(/^\.\//, '')
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new IpcDeclarationError(
        `stdio 通道 ${id} 的 program 必须是扩展目录内的相对路径: ${program}`
      )
    }
    declaration.program = normalized
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
        throw new IpcDeclarationError(`stdio 通道 ${id} 的 args 必须是字符串数组`)
      }
      declaration.args = raw.args as string[]
    }
  } else if (raw.program !== undefined || raw.args !== undefined) {
    throw new IpcDeclarationError(`pipe 通道 ${id} 不应声明 program/args（它是连接已在运行的进程）`)
  }
  return declaration
}

/** 不抛错的声明校验（清单校验阶段用：要把错误信息汇总成"清单无效"） */
export function checkIpcDeclaration(
  raw: unknown
): { ok: true; declaration: IpcChannelDeclaration } | { ok: false; message: string } {
  try {
    return { ok: true, declaration: validateIpcDeclaration(raw) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 校验清单里的 `contributes.ipcChannels`（数组 + 逐项 + 同扩展内 id 唯一）。
 * 缺省/空数组视为"没有声明"（合法）。
 */
export function checkIpcChannelList(
  raw: unknown
): { ok: true; declarations: IpcChannelDeclaration[] } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, declarations: [] }
  if (!Array.isArray(raw)) return { ok: false, message: '必须是数组' }
  const declarations: IpcChannelDeclaration[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const checked = checkIpcDeclaration(raw[i])
    if (!checked.ok) return { ok: false, message: `第 ${i + 1} 项：${checked.message}` }
    if (seen.has(checked.declaration.id)) {
      return { ok: false, message: `通道 id 重复: ${checked.declaration.id}` }
    }
    seen.add(checked.declaration.id)
    declarations.push(checked.declaration)
  }
  return { ok: true, declarations }
}

/**
 * 按 id 取清单里声明的通道（issue #45：`api.ipc.connect('worker')` 的简写形式）。
 * 取不到返回 undefined —— 调用方给出"清单里没有声明该通道"的明确错误。
 * **运行时传对象优先**：调用方只在传字符串时才走这里，所以同名冲突天然以运行时声明为准。
 */
export function resolveIpcChannelDeclaration(
  declarations: readonly IpcChannelDeclaration[] | undefined,
  id: string
): IpcChannelDeclaration | undefined {
  if (!declarations || declarations.length === 0) return undefined
  const wanted = id.trim()
  return declarations.find((declaration) => declaration.id === wanted)
}
