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

/**
 * 断线自动重连策略（issue #44）。**只在运行时声明对象里生效**：
 * `api.ipc.connect({ id, transport: 'pipe', autoReconnect: { retries: 5 } })`。
 * 写进 manifest 的 `contributes.ipcChannels` **既不报错也不生效**（R13/R18）。
 * 仅对 `transport: 'pipe'` 有效；`stdio` + `autoReconnect` → `invalid-declaration`。
 */
export interface IpcAutoReconnect {
  /** 重试次数上限（缺省 3；`0` 等价于关闭；必须是非负整数；**不额外封顶**） */
  retries?: number
  /** 首次退避毫秒（缺省 250；按 ×2 递增，单次封顶 `MAX_BACKOFF_MS`；`0` = 不等待；必须是非负有限数） */
  backoffMs?: number
}

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
  /**
   * 断线自动重连（issue #44；见 `IpcAutoReconnect`）。
   * **只有运行时声明对象（`connect({...})`）里的这一键会生效**；清单声明路径会把它剥掉（R18）。
   */
  autoReconnect?: IpcAutoReconnect
}

/** 重连缺省重试次数（R2） */
export const DEFAULT_RECONNECT_RETRIES = 3
/** 重连缺省首次退避（毫秒，R2） */
export const DEFAULT_RECONNECT_BACKOFF_MS = 250
/** 单次退避等待的上限（与"默认请求超时 30s"同量级，S1） */
export const MAX_BACKOFF_MS = 30_000

/** 归一化后的重连策略（缺省已填） */
export interface ResolvedAutoReconnect {
  retries: number
  backoffMs: number
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
 * 把 `autoReconnect` 原始值**校验并归一化**（缺省填充）；非法抛 `IpcDeclarationError`
 * （主进程会把它转成 `invalid-declaration`）。
 *
 * 接受面（issue #44 R2 + E3/E4）：非对象（含 `null` / 数组 / 标量）→ 抛错；
 * `retries` 必须是非负整数（`0` = 关闭，**不额外封顶**，E2）；`backoffMs` 必须是非负有限数
 * （`0` = 不等待，E4）；**未知键静默忽略**（与顶层逐键白名单读取同风格，E3）。
 */
export function normalizeAutoReconnect(raw: unknown): ResolvedAutoReconnect {
  if (!isRecord(raw) || Array.isArray(raw)) {
    throw new IpcDeclarationError('autoReconnect 必须是对象（如 { retries: 3, backoffMs: 250 }）')
  }
  const rawRetries = raw.retries
  const rawBackoff = raw.backoffMs
  let retries = DEFAULT_RECONNECT_RETRIES
  let backoffMs = DEFAULT_RECONNECT_BACKOFF_MS
  if (rawRetries !== undefined) {
    if (typeof rawRetries !== 'number' || !Number.isInteger(rawRetries) || rawRetries < 0) {
      throw new IpcDeclarationError(
        `autoReconnect.retries 必须是非负整数（0 表示关闭）: ${String(rawRetries)}`
      )
    }
    retries = rawRetries
  }
  if (rawBackoff !== undefined) {
    if (typeof rawBackoff !== 'number' || !Number.isFinite(rawBackoff) || rawBackoff < 0) {
      throw new IpcDeclarationError(
        `autoReconnect.backoffMs 必须是非负有限数（0 表示不等待）: ${String(rawBackoff)}`
      )
    }
    backoffMs = rawBackoff
  }
  return { retries, backoffMs }
}

/**
 * **只服务运行时声明**的通道声明：字段与 `IpcChannelDeclaration` 相同，但 `autoReconnect`
 * 已由 `normalizeAutoReconnect` 归一化（缺省已填，见 `ResolvedAutoReconnect`）。
 *
 * 为什么另立一个类型而不是给 `IpcChannelDeclaration` 换个字段类型：**清单路径**上
 * `autoReconnect` 的值形状是"用户随手写的、不校验的"（`IpcAutoReconnect`，全可选）；
 * 运行时路径上它一定是归一化结果（两个字段都齐），把两者混成一个类型会让调用方
 * 被迫写 `?? 缺省` 那种"第二份缺省值"，从而可能在两处漂移。
 */
export interface RuntimeIpcChannelDeclaration {
  id: string
  transport: IpcTransport
  program?: string
  args?: string[]
  framing?: Framing
  autoReconnect?: ResolvedAutoReconnect
}

/**
 * **只服务运行时声明**的校验入口（issue #44 R18 的落点）。
 *
 * 在 `validateIpcDeclaration` 的白名单归一化之上，**额外**校验并保留 `autoReconnect`
 * （→ `invalid-declaration`：非法策略，或 `transport !== 'pipe'`，R12）。
 * `retries: 0` 视为关闭，**不写回**该键（调用方据此不挂任何重连绑定）。
 *
 * **清单校验路径（`validateIpcDeclaration` / `checkIpcDeclaration` / `checkIpcChannelList`）
 * 绝不可调用本函数**：清单里写 `autoReconnect` 必须既不报错也不生效（Q2 = A / R13）。
 */
export function validateRuntimeIpcDeclaration(raw: unknown): RuntimeIpcChannelDeclaration {
  const base = validateIpcDeclaration(raw)
  const reconnectRaw = isRecord(raw) ? raw.autoReconnect : undefined
  if (reconnectRaw === undefined) return runtimeDeclarationOf(base)
  const policy = normalizeAutoReconnect(reconnectRaw)
  if (base.transport !== 'pipe') {
    throw new IpcDeclarationError(
      `通道 ${base.id} 的 autoReconnect 只支持 pipe（stdio 场景请自行 connect() 重连，或改用 pipe）`
    )
  }
  const declaration = runtimeDeclarationOf(base)
  // `retries: 0` = 关闭（R2）：不写回该键
  if (policy.retries > 0) declaration.autoReconnect = { ...policy }
  return declaration
}

/** 取 `validateIpcDeclaration` 之后的白名单字段（**不带** `autoReconnect`） */
function runtimeDeclarationOf(base: IpcChannelDeclaration): RuntimeIpcChannelDeclaration {
  const declaration: RuntimeIpcChannelDeclaration = { id: base.id, transport: base.transport }
  if (base.framing !== undefined) declaration.framing = base.framing
  if (base.program !== undefined) declaration.program = base.program
  if (base.args !== undefined) declaration.args = base.args
  return declaration
}

/**
 * 按 id 取清单里声明的通道（issue #45：`api.ipc.connect('worker')` 的简写形式）。
 * 取不到返回 undefined —— 调用方给出"清单里没有声明该通道"的明确错误。
 * **运行时传对象优先**：调用方只在传字符串时才走这里，所以同名冲突天然以运行时声明为准。
 *
 * **R18：返回值是白名单归一化后的声明**——只含 `id/transport/program/args/framing`，
 * 清单里写的 `autoReconnect` 与任何未知键在此被**剥掉**（复用同一个校验器），
 * 使"清单里写 autoReconnect 不生效"由**构造**保证，而不是靠"没人读它"。
 */
export function resolveIpcChannelDeclaration(
  declarations: readonly IpcChannelDeclaration[] | undefined,
  id: string
): IpcChannelDeclaration | undefined {
  if (!declarations || declarations.length === 0) return undefined
  const wanted = id.trim()
  const found = declarations.find((declaration) => declaration.id === wanted)
  if (!found) return undefined
  try {
    return validateIpcDeclaration(found)
  } catch (err) {
    // 清单在加载期已过 checkIpcChannelList，这里属"不可能路径"；仍显式抛出，以便一旦有人
    // 绕过清单校验能在日志里看见，而不是静默降级成一个半残的声明。
    throw new IpcDeclarationError(
      `清单里的通道 ${wanted} 非法: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
