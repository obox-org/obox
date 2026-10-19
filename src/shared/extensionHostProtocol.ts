/**
 * 扩展宿主进程（Extension Host Process）的**线路协议**：信封、错误码、序列化守卫、帧上限。
 *
 * 决策见 `docs/adr/0026-extension-host-process.md`，任务卡见 `docs/extension-host-migration.md`
 * 的 EH-A1。本文件是**纯模块**（不 import electron / node / vue），主进程、宿主进程、渲染进程与
 * 单测共用同一份定义，避免三处各写一份守卫而慢慢漂移。
 *
 * ## 通道拓扑（谁跟谁说话）
 *
 * main 用 `utilityProcess.fork()` 拉起宿主，并把一条 `MessagePort` 转交给渲染进程，于是有**两条
 * 逻辑通道**（见 `EH_LINK_CHANNELS`）：
 * - `host-main`：宿主 ↔ main，只承载「必须回 main 的能力」——`safeStorage` 密钥、系统对话框、
 *   通知、窗口/托盘/菜单、`app://` 协议、自动更新、单实例、关闭行为。
 * - `host-renderer`：宿主 ↔ 渲染进程，承载 UI 数据——`statusBar` / `commands` / `views` /
 *   `app.register` / `settings` / `theme` / 气泡 / 卡片图标字符串。
 *
 * ## 帧与信封
 *
 * 传输是 Electron `MessagePort`（structured clone），**不自己分帧**：一条 message 就是一个信封。
 * 但每个信封仍然自描述（`v` + `t` + 该类型自己的字段），原因有三：
 * 1. 两条通道共用一套信封，接收方必须能凭 `t` 分派（通道本身只区分「谁来处理」）；
 * 2. `v` 让版本不匹配立刻可见，而不是解出半个对象再在业务层炸掉；
 * 3. 信封结构固定后，日志与抓包可以直接读，不需要用协议代码反解。
 *
 * 本模块**不做**状态机（谁先发 `ready`、`init` 之后才能 `req` 之类的时序属于 A2/A3）；这里只回答
 * 「这个值是不是形状正确的信封」「这个值能不能过 MessagePort」「这一帧有多大」。
 */

/* -------------------------------------------------------------------------------------------- */
/* 版本与常量                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * 协议版本。**任何信封字段的增删改都要 +1**（本模块对信封字段严格，多一个字段也算畸形）：
 * 两个进程会被一起打包发布，升级无灰度期，版本号只需承担「新旧宿主/渲染侧短暂错配」的判定，
 * 因此选择严格而不是宽容——错配早报错，好过半个字段静默丢失。
 */
export const PROTOCOL_VERSION = 1 as const

/** 协议版本类型（字面量 `1`，让构造器的 `v` 不需要断言） */
export type ProtocolVersion = typeof PROTOCOL_VERSION

/**
 * 单帧上限 **8 MB**。与 `api.net.fetch` 的响应上限取同一个数：扩展在宿主里已经能直接读写文件，
 * 真的有大块数据应该走 `fs` 路径；把上限压到与既有 net 限制一致，避免出现「net 能过、桥不能过」
 * 的第二种失败模式。二进制（`Uint8Array` / `ArrayBuffer`）**按字节精确计数**，不按 base64 膨胀。
 */
export const FRAME_LIMIT_BYTES = 8 * 1024 * 1024

/**
 * 判活阈值：发出请求后 **3 秒**内没收到任何响应（`res` / `err`）即判「对端卡住」。
 *
 * 注意语义（ADR-0026 决策 7）：**只观测，不杀**。超时只记日志 / 打点，不自动重启宿主，
 * 因为宿主里跑的是用户的完整 Node 代码，一次同步 IO 就可能接近这个数；杀进程的代价远大于
 * 一次慢请求。
 */
export const ACK_TIMEOUT_MS = 3000

/** `terminate` 的默认宽限期：宿主收到后最多再活 **5 秒**，必须自行清理并退出 */
export const TERMINATE_GRACE_MS = 5000

/** 请求 id 从 1 开始自增（每个发送方各自维护，两条通道互不相干） */
export const FIRST_REQUEST_ID = 1

/* -------------------------------------------------------------------------------------------- */
/* 通道与事件 channel 命名                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** 两条逻辑通道的固定名字（拓扑见文件头） */
export const EH_LINK_CHANNELS = {
  /** 宿主 ↔ main：只能是「必须回 main 的能力」 */
  main: 'host-main',
  /** 宿主 ↔ 渲染进程：UI 数据（状态栏/命令/视图/设置/主题/气泡/图标字符串） */
  renderer: 'host-renderer'
} as const

/** 逻辑通道名 */
export type EhLinkChannel = (typeof EH_LINK_CHANNELS)[keyof typeof EH_LINK_CHANNELS]

/** 两条逻辑通道名（便于遍历 / 日志校验） */
export const EH_LINK_CHANNEL_NAMES = [EH_LINK_CHANNELS.main, EH_LINK_CHANNELS.renderer] as const

/**
 * `event` 信封的**已知** channel（UI 数据面）。`event.channel` 本身不限定在这张表里
 * （能力/扩展可能新增自定义事件，提前枚举会把协议焊死），这里只是给 A3/A4 提供常量，
 * 避免字符串手写出错；新增已知 channel 时同步补到这里与文档。
 */
export const EH_EVENT_CHANNELS = {
  statusBar: 'statusBar',
  commands: 'commands',
  views: 'views',
  appRegister: 'app.register',
  settings: 'settings',
  theme: 'theme',
  bubble: 'bubble',
  cardIcon: 'cardIcon'
} as const

/** 已知事件 channel 名 */
export type EhEventChannel = (typeof EH_EVENT_CHANNELS)[keyof typeof EH_EVENT_CHANNELS]

/* -------------------------------------------------------------------------------------------- */
/* 错误码                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * 协议级错误码（`err` 信封的 `code`，也用于本地守卫的返回值）。
 *
 * 刻意做成**封闭枚举**而不是字符串自由发挥：渲染侧/宿主侧都要把它映射成用户能看懂的中文
 * 文案（见 `EH_ERROR_TEXT`）并决定是否重试，自由字符串会让「该重试还是该报 bug」的判断散落各处。
 * 新增错误码需要同时补 `EH_ERROR_CODES` 与 `EH_ERROR_TEXT`（`Record` 的穷举由类型保证）。
 */
export type EhErrorCode =
  | 'EH_NOT_READY'
  | 'EH_UNKNOWN_EXT'
  | 'EH_ACTIVATION_FAILED'
  | 'EH_TIMEOUT'
  | 'EH_UNSERIALIZABLE'
  | 'EH_CANCELLED'
  | 'EH_FRAME_TOO_LARGE'
  | 'EH_INTERNAL'

/** 全部错误码（顺序 = 文档/日志里的展示顺序） */
export const EH_ERROR_CODES = [
  'EH_NOT_READY',
  'EH_UNKNOWN_EXT',
  'EH_ACTIVATION_FAILED',
  'EH_TIMEOUT',
  'EH_UNSERIALIZABLE',
  'EH_CANCELLED',
  'EH_FRAME_TOO_LARGE',
  'EH_INTERNAL'
] as const satisfies readonly EhErrorCode[]

/**
 * 错误码 → **中文可执行文案**：告诉用户「现在能做什么」，而不是复述错误名。
 * 宿主与渲染侧都直接展示这一句，因此这里不允许出现内部路径/堆栈（那些进日志或 `detail`）。
 */
export const EH_ERROR_TEXT: Record<EhErrorCode, string> = {
  EH_NOT_READY:
    '扩展宿主还没就绪（未收到 initialized）。请等待宿主启动完成；若反复出现，检查宿主进程是否已崩溃。',
  EH_UNKNOWN_EXT:
    '目标扩展未在宿主中加载。请确认扩展已安装并出现在扩展列表中；刚安装的扩展需要重启扩展宿主。',
  EH_ACTIVATION_FAILED:
    '扩展激活失败。请在扩展管理器里打开该扩展的日志，修好 activate() 抛出的错误后重新激活。',
  EH_TIMEOUT:
    '对端在超时时间内没有响应。请检查该扩展是否阻塞了事件循环；必要时在扩展管理器里重启扩展宿主。',
  EH_UNSERIALIZABLE:
    '数据无法跨进程传输（函数 / Symbol / 类实例 / 循环引用 / Map / Set 都不允许）。请改成纯数据；二进制请用 Uint8Array 或 ArrayBuffer。',
  EH_CANCELLED: '请求已被取消（对端取消或链路已断开）。通常不是错误，可按需重试。',
  EH_FRAME_TOO_LARGE:
    '单帧超过 8 MB 上限。请分片传输，或把大块数据落到磁盘后用路径/流传递；二进制请用 Uint8Array 并显式 transfer。',
  EH_INTERNAL: '宿主内部错误或协议不匹配。请保留日志并向 obox 反馈（附宿主日志与版本号）。'
}

/** 未知值是否是已知错误码 */
export function isEhErrorCode(value: unknown): value is EhErrorCode {
  return typeof value === 'string' && (EH_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * 协议错误：本地守卫抛错时用（例如 `assertFrameSize`）。
 * `code` 与 `err` 信封同源，调用方不必为「本地抛」和「远端回」写两套分支。
 */
export class EhProtocolError extends Error {
  /** 同 `err.code` */
  readonly code: EhErrorCode

  /** 可选的诊断细节（路径、字节数等） */
  readonly detail?: string

  constructor(code: EhErrorCode, message: string, detail?: string) {
    super(detail === undefined ? message : `${message}（${detail}）`)
    this.name = 'EhProtocolError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 激活事件与宿主侧扩展信息                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * 激活原因（ADR-0026 决策 6，只实现 4 类）：
 * - `*`：立即激活（缺省值，等价于今天的行为）
 * - `onStartupFinished`：首屏之后、空闲时激活
 * - `{ command }`：命令被调用时激活
 * - `{ view }`：视图首次被打开时激活
 *
 * 内部用**结构化**表示而不是清单里的 `onCommand:<id>` 字符串：宿主分派激活时只比较字段，
 * 不需要每次 `startsWith` + `slice`。清单字符串 → 结构的转换在 `parseActivationEvent()`。
 */
export type ActivationReason = '*' | 'onStartupFinished' | { command: string } | { view: string }

/** 清单里 4 类激活事件的前缀（`*` 与 `onStartupFinished` 无前缀） */
export const ACTIVATION_EVENT_PREFIXES = {
  command: 'onCommand:',
  view: 'onView:'
} as const

/** 清单里的激活事件字符串 → 结构化 `ActivationReason`；不认识返回 `null`（由清单层报错） */
export function parseActivationEvent(event: string): ActivationReason | null {
  if (event === '*') return '*'
  if (event === 'onStartupFinished') return 'onStartupFinished'
  if (event.startsWith(ACTIVATION_EVENT_PREFIXES.command)) {
    const command = event.slice(ACTIVATION_EVENT_PREFIXES.command.length)
    return command ? { command } : null
  }
  if (event.startsWith(ACTIVATION_EVENT_PREFIXES.view)) {
    const view = event.slice(ACTIVATION_EVENT_PREFIXES.view.length)
    return view ? { view } : null
  }
  return null
}

/**
 * 宿主需要知道的扩展清单摘要（`init` 信封携带）。宿主不自己扫目录，渲染侧/主进程扫完把这份
 * 结构交给它，保证「用户装了哪些扩展」只有一处真相。
 *
 * `apiVersion` 带上（而不只靠 `path` 让宿主再读一次清单）：宿主启动时要先按 `apiVersion` 决定
 * 是否加载（ADR-0026 决策 8 升到 3），多一次磁盘读没必要，且清单可能已被改动而这份摘要是权威。
 */
export interface HostedExtensionInfo {
  /** 扩展 id（= 目录名 / `.oix` id） */
  id: string
  /** 扩展版本（语义化字符串，协议层不校验格式） */
  version: string
  /** 扩展根目录绝对路径（宿主据此 `require`/`import` 入口） */
  path: string
  /** 已解析的激活事件；空数组视为 `['*']`（清单层归一） */
  activationEvents: ActivationReason[]
  /** 扩展声明的 obox apiVersion（ADR-0026 起为 3） */
  apiVersion: number
}

/* -------------------------------------------------------------------------------------------- */
/* 信封                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** 宿主进程起来后发的第一封信；`hostId` 用于日志与崩溃归因，`pid` 用于主进程判活/强制退出 */
export interface ReadyEnvelope {
  v: ProtocolVersion
  t: 'ready'
  hostId: string
  pid: number
}

/**
 * main → 宿主的初始化指令：`apiVersion` 是宿主可用的能力面版本，`dataDir` 是宿主可写的
 * 用户数据目录（与 main 的 `userData` 同源，方便扩展沿用旧路径），`extensions` 是要加载的清单摘要。
 */
export interface InitEnvelope {
  v: ProtocolVersion
  t: 'init'
  apiVersion: number
  dataDir: string
  extensions: HostedExtensionInfo[]
}

/** 宿主完成加载后的回执；在这之前发送任何 `req` 都应被回 `EH_NOT_READY` */
export interface InitializedEnvelope {
  v: ProtocolVersion
  t: 'initialized'
}

/** 激活某个扩展（`reason` 决定为什么现在激活它） */
export interface ActivateEnvelope {
  v: ProtocolVersion
  t: 'activate'
  extId: string
  reason: ActivationReason
}

/** 停用某个扩展（热装卸/宿主关闭前） */
export interface DeactivateEnvelope {
  v: ProtocolVersion
  t: 'deactivate'
  extId: string
}

/**
 * RPC 请求。`id` 由**发送方**自增，只在「该发送方 → 该接收方」方向内唯一；
 * 同一 `id` 的响应/取消与它配对，跨方向复用 id 不会冲突。
 */
export interface RequestEnvelope {
  v: ProtocolVersion
  t: 'req'
  id: number
  method: string
  params: unknown
}

/** RPC 成功响应 */
export interface ResponseEnvelope {
  v: ProtocolVersion
  t: 'res'
  id: number
  result: unknown
}

/** RPC 失败响应；`detail` 放诊断细节（路径、字节数、堆栈摘要），`message` 给用户看 */
export interface ErrorEnvelope {
  v: ProtocolVersion
  t: 'err'
  id: number
  code: EhErrorCode
  message: string
  detail?: string
}

/**
 * 取消某个在途请求。接收方收到后**必须能放弃**（ADR-0026 & EH-A1 的语义约定）：
 * 已经做完的请求回正常响应，放弃掉的请求回 `EH_CANCELLED`；具体实现留给 EH-A3。
 */
export interface CancelEnvelope {
  v: ProtocolVersion
  t: 'cancel'
  id: number
}

/**
 * 单向事件（占位语义：不需要响应）。UI 数据（状态栏/命令/视图/设置/主题/气泡/图标字符串）
 * 走 `host-renderer` 通道的 `event`；`channel` 的已知取值见 `EH_EVENT_CHANNELS`。
 */
export interface EventEnvelope {
  v: ProtocolVersion
  t: 'event'
  channel: string
  payload: unknown
}

/** 日志：宿主进程的 stdout/stderr 在打包后不可见，结构化日志信封是唯一稳定出口 */
export interface LogEnvelope {
  v: ProtocolVersion
  t: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

/** 主进程要求宿主退出；宿主最多再活 `graceMs`（默认 `TERMINATE_GRACE_MS`） */
export interface TerminateEnvelope {
  v: ProtocolVersion
  t: 'terminate'
  graceMs: number
}

/** 所有信封的联合类型（收发两侧共用） */
export type Envelope =
  | ReadyEnvelope
  | InitEnvelope
  | InitializedEnvelope
  | ActivateEnvelope
  | DeactivateEnvelope
  | RequestEnvelope
  | ResponseEnvelope
  | ErrorEnvelope
  | CancelEnvelope
  | EventEnvelope
  | LogEnvelope
  | TerminateEnvelope

/** 信封类型标签（`t` 的取值集合） */
export type EnvelopeType = Envelope['t']

/** 按标签取具体信封类型：`EnvelopeOf<'req'>` → `RequestEnvelope` */
export type EnvelopeOf<T extends EnvelopeType> = Extract<Envelope, { t: T }>

/** 日志级别 */
export type LogLevel = LogEnvelope['level']

/* -------------------------------------------------------------------------------------------- */
/* 构造器（只负责拼形状，不校验；发送前请自行过 validateEnvelope / checkSerializable）             */
/* -------------------------------------------------------------------------------------------- */

/** `ready`：宿主起来后的第一封信 */
export function createReadyEnvelope(hostId: string, pid: number): ReadyEnvelope {
  return { v: PROTOCOL_VERSION, t: 'ready', hostId, pid }
}

/** `init`：main → 宿主，交付能力面版本、数据目录与扩展清单摘要 */
export function createInitEnvelope(init: {
  apiVersion: number
  dataDir: string
  extensions: HostedExtensionInfo[]
}): InitEnvelope {
  return {
    v: PROTOCOL_VERSION,
    t: 'init',
    apiVersion: init.apiVersion,
    dataDir: init.dataDir,
    extensions: init.extensions
  }
}

/** `initialized`：宿主加载完成 */
export function createInitializedEnvelope(): InitializedEnvelope {
  return { v: PROTOCOL_VERSION, t: 'initialized' }
}

/** `activate`：激活某个扩展 */
export function createActivateEnvelope(extId: string, reason: ActivationReason): ActivateEnvelope {
  return { v: PROTOCOL_VERSION, t: 'activate', extId, reason }
}

/** `deactivate`：停用某个扩展 */
export function createDeactivateEnvelope(extId: string): DeactivateEnvelope {
  return { v: PROTOCOL_VERSION, t: 'deactivate', extId }
}

/** `req`：RPC 请求（`params` 缺省 `null`，保持信封纯数据） */
export function createRequestEnvelope(
  id: number,
  method: string,
  params: unknown = null
): RequestEnvelope {
  return { v: PROTOCOL_VERSION, t: 'req', id, method, params }
}

/** `res`：RPC 成功响应（`result` 缺省 `null`） */
export function createResponseEnvelope(id: number, result: unknown = null): ResponseEnvelope {
  return { v: PROTOCOL_VERSION, t: 'res', id, result }
}

/** `err`：RPC 失败响应（`detail` 不传就不写字段，避免出现 `detail: undefined`） */
export function createErrorEnvelope(
  id: number,
  code: EhErrorCode,
  message: string,
  detail?: string
): ErrorEnvelope {
  const env: ErrorEnvelope = { v: PROTOCOL_VERSION, t: 'err', id, code, message }
  if (detail !== undefined) env.detail = detail
  return env
}

/** `cancel`：取消在途请求 */
export function createCancelEnvelope(id: number): CancelEnvelope {
  return { v: PROTOCOL_VERSION, t: 'cancel', id }
}

/** `event`：单向事件（UI 数据面） */
export function createEventEnvelope(channel: string, payload: unknown = null): EventEnvelope {
  return { v: PROTOCOL_VERSION, t: 'event', channel, payload }
}

/** `log`：结构化日志 */
export function createLogEnvelope(level: LogLevel, message: string): LogEnvelope {
  return { v: PROTOCOL_VERSION, t: 'log', level, message }
}

/** `terminate`：要求宿主退出，宽限期默认 `TERMINATE_GRACE_MS` */
export function createTerminateEnvelope(graceMs: number = TERMINATE_GRACE_MS): TerminateEnvelope {
  return { v: PROTOCOL_VERSION, t: 'terminate', graceMs }
}

/* -------------------------------------------------------------------------------------------- */
/* 信封校验                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** `validateEnvelope` 的结果：成功带具体信封，失败带错误码与中文原因（含出错字段路径） */
export type ValidateEnvelopeResult =
  { ok: true; env: Envelope } | { ok: false; code: EhErrorCode; why: string }

/**
 * 各类型**允许**的字段。多余字段一律拒绝：
 * 新增字段 = 协议变更 = 升 `PROTOCOL_VERSION`。这样做的好处是拼错字段名（`extld` vs `extId`）
 * 会当场报错，而不是收出一个字段永远为 `undefined` 的信封；代价是两端必须同版本，而这两个进程
 * 本来就随同一个 obox 一起发布。
 */
const ENVELOPE_FIELDS: Record<EnvelopeType, readonly string[]> = {
  ready: ['v', 't', 'hostId', 'pid'],
  init: ['v', 't', 'apiVersion', 'dataDir', 'extensions'],
  initialized: ['v', 't'],
  activate: ['v', 't', 'extId', 'reason'],
  deactivate: ['v', 't', 'extId'],
  req: ['v', 't', 'id', 'method', 'params'],
  res: ['v', 't', 'id', 'result'],
  err: ['v', 't', 'id', 'code', 'message', 'detail'],
  cancel: ['v', 't', 'id'],
  event: ['v', 't', 'channel', 'payload'],
  log: ['v', 't', 'level', 'message'],
  terminate: ['v', 't', 'graceMs']
}

/** 各类型里**可选**的字段（其余允许字段都是必填） */
const OPTIONAL_ENVELOPE_FIELDS: Record<EnvelopeType, readonly string[]> = {
  ready: [],
  init: [],
  initialized: [],
  activate: [],
  deactivate: [],
  req: [],
  res: [],
  err: ['detail'],
  cancel: [],
  event: [],
  log: [],
  terminate: []
}

/** 信封标签全集（顺序 = 文档顺序） */
export const ENVELOPE_TYPES = [
  'ready',
  'init',
  'initialized',
  'activate',
  'deactivate',
  'req',
  'res',
  'err',
  'cancel',
  'event',
  'log',
  'terminate'
] as const satisfies readonly EnvelopeType[]

/** 宿主侧扩展信息允许的字段（同样严格） */
const HOSTED_EXTENSION_FIELDS = ['id', 'version', 'path', 'activationEvents', 'apiVersion'] as const

/** 日志级别全集 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[]

/** 未知值是否是普通对象（非 null、非数组）；信封**必须**是普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 自身可枚举字符串键里是否有 `key` */
function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** 诊断信息里描述一个值（截断长字符串，避免日志被参数撑爆） */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `数组（长度 ${value.length}）`
  if (typeof value === 'string') {
    const text = value.length > 40 ? `${value.slice(0, 40)}…` : value
    return `字符串 ${JSON.stringify(text)}`
  }
  if (typeof value === 'number' || typeof value === 'boolean')
    return `${typeof value} ${String(value)}`
  if (typeof value === 'bigint') return `bigint ${value.toString()}`
  if (typeof value === 'object') return '对象'
  return typeof value
}

/** 构造一条「畸形信封」失败结果：结构问题统一归 `EH_INTERNAL`（协议不匹配/实现对不上） */
function malformed(why: string): ValidateEnvelopeResult {
  return { ok: false, code: 'EH_INTERNAL', why }
}

/** 非空字符串字段校验：返回中文原因或 `null` */
function badText(
  record: Record<string, unknown>,
  key: string,
  where: string,
  allowEmpty = false
): string | null {
  const value = record[key]
  if (typeof value !== 'string') {
    return `${where}.${key} 必须是字符串，收到 ${describeValue(value)}`
  }
  if (!allowEmpty && value.trim() === '') {
    return `${where}.${key} 不能为空字符串`
  }
  return null
}

/** 正整数 id 校验：返回中文原因或 `null` */
function badId(record: Record<string, unknown>, where: string): string | null {
  const value = record.id
  if (typeof value !== 'number' || !Number.isInteger(value) || value < FIRST_REQUEST_ID) {
    return `${where}.id 必须是 ≥${FIRST_REQUEST_ID} 的整数（由发送方自增），收到 ${describeValue(value)}`
  }
  return null
}

/** 校验激活原因（字符串两种 / 对象恰好一个 `command` 或 `view`） */
export function validateActivationReason(
  value: unknown
): { ok: true; reason: ActivationReason } | { ok: false; why: string } {
  if (value === '*') return { ok: true, reason: '*' }
  if (value === 'onStartupFinished') return { ok: true, reason: 'onStartupFinished' }
  if (typeof value === 'string') {
    return {
      ok: false,
      why: `激活事件 ${JSON.stringify(value)} 不受支持（只允许 * / onStartupFinished / onCommand:<id> / onView:<id>）`
    }
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      why: `激活原因必须是 * / onStartupFinished / { command } / { view }，收到 ${describeValue(value)}`
    }
  }
  const keys = Object.keys(value)
  if (keys.length !== 1) {
    return {
      ok: false,
      why: `激活原因对象必须恰好有一个键（command 或 view），收到 ${keys.length} 个：${keys.join(', ') || '（无）'}`
    }
  }
  const key = keys[0]
  if (key !== 'command' && key !== 'view') {
    return { ok: false, why: `激活原因对象只允许键 command / view，收到 ${JSON.stringify(key)}` }
  }
  const target = value[key]
  if (typeof target !== 'string' || target.trim() === '') {
    return { ok: false, why: `激活原因 ${key} 必须是非空字符串，收到 ${describeValue(target)}` }
  }
  return { ok: true, reason: key === 'command' ? { command: target } : { view: target } }
}

/** 未知值是否是合法 `ActivationReason` */
export function isActivationReason(value: unknown): value is ActivationReason {
  return validateActivationReason(value).ok
}

/** 未知值是否是合法 `LogLevel` */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/** 校验一条 `HostedExtensionInfo`；返回中文原因或 `null`。`at` 是路径前缀（如 `init.extensions[0]`） */
function badHostedExtensionInfo(value: unknown, at: string): string | null {
  if (!isRecord(value)) return `${at} 必须是普通对象，收到 ${describeValue(value)}`
  for (const key of Object.keys(value)) {
    if (!(HOSTED_EXTENSION_FIELDS as readonly string[]).includes(key)) {
      return `${at} 不接受字段 "${key}"（允许：${HOSTED_EXTENSION_FIELDS.join(', ')}；新增字段需升 PROTOCOL_VERSION）`
    }
  }
  for (const key of HOSTED_EXTENSION_FIELDS) {
    if (!hasOwn(value, key)) return `${at} 缺少必需字段 "${key}"`
  }
  const textProblem =
    badText(value, 'id', at) ?? badText(value, 'version', at) ?? badText(value, 'path', at)
  if (textProblem) return textProblem

  const apiVersion = value.apiVersion
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 1) {
    return `${at}.apiVersion 必须是 ≥1 的整数，收到 ${describeValue(apiVersion)}`
  }

  const events = value.activationEvents
  if (!Array.isArray(events)) {
    return `${at}.activationEvents 必须是数组，收到 ${describeValue(events)}`
  }
  for (let i = 0; i < events.length; i++) {
    const checked = validateActivationReason(events[i])
    if (!checked.ok) return `${at}.activationEvents[${i}]：${checked.why}`
  }
  return null
}

/** 校验 `init.extensions` 数组 */
function badHostedExtensions(value: unknown): string | null {
  if (!Array.isArray(value)) return `init.extensions 必须是数组，收到 ${describeValue(value)}`
  for (let i = 0; i < value.length; i++) {
    const problem = badHostedExtensionInfo(value[i], `init.extensions[${i}]`)
    if (problem) return problem
  }
  return null
}

/**
 * **信封形状校验**（纯函数，收发两侧都该先过一遍）。
 *
 * 只回答结构问题，不回答时序问题（例如「`initialized` 之前来 `req`」由 A2/A3 判 `EH_NOT_READY`），
 * 也不回答可传输性（那是 `checkSerializable` 的事）：一个形状对的信封里仍可能塞了函数。
 *
 * 失败一律 `EH_INTERNAL`：错误码表里没有「协议畸形」这一条，而畸形信封确实是两端实现/版本
 * 对不上的 bug，不是用户可以处理的情况；`why` 里写清路径，直接进日志。
 */
export function validateEnvelope(raw: unknown): ValidateEnvelopeResult {
  if (!isRecord(raw)) {
    return malformed(`信封必须是普通对象，收到 ${describeValue(raw)}`)
  }
  if (raw.v !== PROTOCOL_VERSION) {
    return malformed(
      `协议版本不匹配：收到 v=${describeValue(raw.v)}，期望 ${PROTOCOL_VERSION}（宿主与渲染侧版本不一致，需整包升级）`
    )
  }
  const type = raw.t
  if (typeof type !== 'string' || !(ENVELOPE_TYPES as readonly string[]).includes(type)) {
    return malformed(`未知信封类型 t=${describeValue(type)}（允许：${ENVELOPE_TYPES.join(' / ')}）`)
  }
  const t = type as EnvelopeType

  const allowed = ENVELOPE_FIELDS[t]
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      return malformed(
        `信封 t="${t}" 不接受字段 "${key}"（允许：${allowed.join(', ')}；新增字段需升 PROTOCOL_VERSION）`
      )
    }
  }
  const optional = OPTIONAL_ENVELOPE_FIELDS[t]
  for (const key of allowed) {
    if (!optional.includes(key) && !hasOwn(raw, key)) {
      return malformed(`信封 t="${t}" 缺少必需字段 "${key}"`)
    }
  }

  switch (t) {
    case 'ready': {
      const problem = badText(raw, 'hostId', 'ready')
      if (problem) return malformed(problem)
      const pid = raw.pid
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return malformed(`ready.pid 必须是 >0 的整数，收到 ${describeValue(pid)}`)
      }
      return { ok: true, env: raw as unknown as ReadyEnvelope }
    }
    case 'init': {
      const apiVersion = raw.apiVersion
      if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 1) {
        return malformed(`init.apiVersion 必须是 ≥1 的整数，收到 ${describeValue(apiVersion)}`)
      }
      const dataDirProblem = badText(raw, 'dataDir', 'init')
      if (dataDirProblem) return malformed(dataDirProblem)
      const extensionsProblem = badHostedExtensions(raw.extensions)
      if (extensionsProblem) return malformed(extensionsProblem)
      return { ok: true, env: raw as unknown as InitEnvelope }
    }
    case 'initialized':
      return { ok: true, env: raw as unknown as InitializedEnvelope }
    case 'activate': {
      const extIdProblem = badText(raw, 'extId', 'activate')
      if (extIdProblem) return malformed(extIdProblem)
      const reason = validateActivationReason(raw.reason)
      if (!reason.ok) return malformed(`activate.reason：${reason.why}`)
      return { ok: true, env: raw as unknown as ActivateEnvelope }
    }
    case 'deactivate': {
      const extIdProblem = badText(raw, 'extId', 'deactivate')
      if (extIdProblem) return malformed(extIdProblem)
      return { ok: true, env: raw as unknown as DeactivateEnvelope }
    }
    case 'req': {
      const idProblem = badId(raw, 'req')
      if (idProblem) return malformed(idProblem)
      const methodProblem = badText(raw, 'method', 'req')
      if (methodProblem) return malformed(methodProblem)
      // params 允许任意形状（含 null）：可传输性由 checkSerializable 负责
      return { ok: true, env: raw as unknown as RequestEnvelope }
    }
    case 'res': {
      const idProblem = badId(raw, 'res')
      if (idProblem) return malformed(idProblem)
      return { ok: true, env: raw as unknown as ResponseEnvelope }
    }
    case 'err': {
      const idProblem = badId(raw, 'err')
      if (idProblem) return malformed(idProblem)
      if (!isEhErrorCode(raw.code)) {
        return malformed(
          `err.code 必须是已知错误码，收到 ${describeValue(raw.code)}（允许：${EH_ERROR_CODES.join(' / ')}）`
        )
      }
      const messageProblem = badText(raw, 'message', 'err')
      if (messageProblem) return malformed(messageProblem)
      if (hasOwn(raw, 'detail') && typeof raw.detail !== 'string') {
        return malformed(`err.detail 必须是字符串，收到 ${describeValue(raw.detail)}`)
      }
      return { ok: true, env: raw as unknown as ErrorEnvelope }
    }
    case 'cancel': {
      const idProblem = badId(raw, 'cancel')
      if (idProblem) return malformed(idProblem)
      return { ok: true, env: raw as unknown as CancelEnvelope }
    }
    case 'event': {
      const channelProblem = badText(raw, 'channel', 'event')
      if (channelProblem) return malformed(channelProblem)
      return { ok: true, env: raw as unknown as EventEnvelope }
    }
    case 'log': {
      if (!isLogLevel(raw.level)) {
        return malformed(
          `log.level 必须是 ${LOG_LEVELS.join(' / ')}，收到 ${describeValue(raw.level)}`
        )
      }
      const textProblem = badText(raw, 'message', 'log', true)
      if (textProblem) return malformed(textProblem)
      return { ok: true, env: raw as unknown as LogEnvelope }
    }
    case 'terminate': {
      const graceMs = raw.graceMs
      if (typeof graceMs !== 'number' || !Number.isInteger(graceMs) || graceMs < 0) {
        return malformed(
          `terminate.graceMs 必须是 ≥0 的整数（毫秒），收到 ${describeValue(graceMs)}`
        )
      }
      return { ok: true, env: raw as unknown as TerminateEnvelope }
    }
  }
}

/**
 * 类型守卫：`isEnvelope(x)` ⟺ `validateEnvelope(x).ok`。
 * 刻意不做「更宽松的快速判断」——两套判定标准迟早会分叉，而信封很小，校验开销可以忽略。
 */
export function isEnvelope(value: unknown): value is Envelope {
  return validateEnvelope(value).ok
}

/* -------------------------------------------------------------------------------------------- */
/* 序列化守卫                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * 不可传输值的种类（`checkSerializable` 失败时给出，UI/日志可直接翻译）。
 * 全部为「JSON 纯数据 + Uint8Array/ArrayBuffer」之外的类型。
 */
export type UnserializableKind =
  | 'undefined'
  | 'bigint'
  | 'function'
  | 'symbol'
  | 'symbol-key'
  | 'non-finite-number'
  | 'circular'
  | 'sparse-array'
  | 'map'
  | 'set'
  | 'weakmap'
  | 'weakset'
  | 'date'
  | 'regexp'
  | 'error'
  | 'promise'
  | 'typed-array'
  | 'class-instance'
  | 'unreadable'

/** `checkSerializable` 的结果：失败时带**出错路径**（如 `params.items[2].onClick`）与种类 */
export type SerializableCheck = { ok: true } | { ok: false; path: string; kind: UnserializableKind }

/** 可作为对象键安全写成 `.key` 的标识符 */
const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 子路径：普通键用 `.key`，怪键用 `["key"]` */
function childPath(parent: string, key: string): string {
  return IDENTIFIER_KEY.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

/** 内置类实例的具体种类；普通对象与数组返回 `null`（交给调用方继续遍历） */
function builtinKindOf(value: object): UnserializableKind | null {
  if (value instanceof Map) return 'map'
  if (value instanceof Set) return 'set'
  if (value instanceof WeakMap) return 'weakmap'
  if (value instanceof WeakSet) return 'weakset'
  if (value instanceof Date) return 'date'
  if (value instanceof RegExp) return 'regexp'
  if (value instanceof Error) return 'error'
  if (value instanceof Promise) return 'promise'
  return null
}

/** 递归检查；`ancestors` 只放**当前路径上的祖先**，因此重复引用（DAG）不算循环 */
function checkSerializableNode(
  node: unknown,
  path: string,
  ancestors: Set<object>
): SerializableCheck {
  switch (typeof node) {
    case 'string':
    case 'boolean':
      return { ok: true }
    case 'number':
      return Number.isFinite(node) ? { ok: true } : { ok: false, path, kind: 'non-finite-number' }
    case 'undefined':
      return { ok: false, path, kind: 'undefined' }
    case 'bigint':
      return { ok: false, path, kind: 'bigint' }
    case 'symbol':
      return { ok: false, path, kind: 'symbol' }
    case 'function':
      return { ok: false, path, kind: 'function' }
    default:
      break
  }
  if (node === null) return { ok: true }

  const object = node as object
  if (ancestors.has(object)) return { ok: false, path, kind: 'circular' }

  // 二进制旁路：Uint8Array（含 Node Buffer）与 ArrayBuffer 允许；其他视图请先转成 Uint8Array
  if (ArrayBuffer.isView(object)) {
    return object instanceof Uint8Array ? { ok: true } : { ok: false, path, kind: 'typed-array' }
  }
  if (object instanceof ArrayBuffer) return { ok: true }

  if (Array.isArray(object)) {
    ancestors.add(object)
    for (let i = 0; i < object.length; i++) {
      if (!hasOwn(object as unknown as Record<string, unknown>, String(i))) {
        ancestors.delete(object)
        return { ok: false, path: `${path}[${i}]`, kind: 'sparse-array' }
      }
      const check = checkSerializableNode(object[i], `${path}[${i}]`, ancestors)
      if (!check.ok) {
        ancestors.delete(object)
        return check
      }
    }
    ancestors.delete(object)
    return { ok: true }
  }

  const builtin = builtinKindOf(object)
  if (builtin) return { ok: false, path, kind: builtin }

  const prototype = Object.getPrototypeOf(object) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, path, kind: 'class-instance' }
  }
  if (Object.getOwnPropertySymbols(object).length > 0) {
    return { ok: false, path, kind: 'symbol-key' }
  }

  ancestors.add(object)
  for (const key of Object.keys(object)) {
    let child: unknown
    try {
      child = (object as Record<string, unknown>)[key]
    } catch {
      ancestors.delete(object)
      return { ok: false, path: childPath(path, key), kind: 'unreadable' }
    }
    const check = checkSerializableNode(child, childPath(path, key), ancestors)
    if (!check.ok) {
      ancestors.delete(object)
      return check
    }
  }
  ancestors.delete(object)
  return { ok: true }
}

/**
 * **可传输性守卫**：只放行 JSON 纯数据 + `Uint8Array`/`ArrayBuffer`。
 *
 * 与 VS Code 的做法相反：那边遇到函数就丢、循环引用变 `null`、类实例按字段降级；obox 选择
 * **当场报错**（`EH_UNSERIALIZABLE` + 路径 + 种类）。原因是这类"降级"在扩展场景里极难排查——
 * 扩展看见 `api.foo(cb)` 正常返回，实际回调从没被调用过；不如在第一次跨进程时就把路径打出来。
 *
 * 允许：`string` / 有限 `number` / `boolean` / `null` / 纯对象 / 数组（无洞）/ `Uint8Array`
 * （含 Node `Buffer`）/ `ArrayBuffer`。
 *
 * 拒绝：函数、Symbol（值与键）、`bigint`、`undefined`、`NaN`/`±Infinity`、类实例（`Date` /
 * `RegExp` / `Error` / `Promise` / 扩展自定义类等）、`Map` / `Set` / `WeakMap` / `WeakSet`、
 * 非 `Uint8Array` 的 TypedArray/`DataView`、稀疏数组、循环引用、抛错的 getter。
 *
 * 关于 `undefined` 与 `NaN`：结构化克隆其实能忠实传它们，但本协议把"能过桥"定义为
 * "能被 JSON 表达"——否则同一个值经日志/持久化/JSON 转发时会悄悄变成别的样子（`undefined`
 * 键消失、`NaN` 变 `null`），这正是 obox 要避免的静默降级。
 *
 * @param value 待检查值
 * @param rootPath 根路径名（默认 `value`），用于拼出错路径，如 `params.items[2].onClick`
 */
export function checkSerializable(value: unknown, rootPath = 'value'): SerializableCheck {
  return checkSerializableNode(value, rootPath, new Set<object>())
}

/* -------------------------------------------------------------------------------------------- */
/* 帧大小                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** 结构估算的字节权重（刻意取保守值，宁可早一点判超限） */
const NUMBER_BYTES = 8
const BOOLEAN_BYTES = 5
const NULL_BYTES = 4
const CONTAINER_OVERHEAD = 2
const KEY_OVERHEAD = 4
const COMMA_BYTES = 1

/** UTF-8 字节数（自己算，避免依赖 `TextEncoder`/`Buffer` 让本模块在两端环境行为不同） */
function utf8Length(text: string): number {
  let bytes = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
  }
  return bytes
}

function sizeOfNode(node: unknown, ancestors: Set<object>): number {
  switch (typeof node) {
    case 'string':
      return utf8Length(node) + 2
    case 'number':
      return NUMBER_BYTES
    case 'boolean':
      return BOOLEAN_BYTES
    case 'bigint':
      return utf8Length(node.toString()) + 2
    case 'undefined':
    case 'symbol':
    case 'function':
      return 0
    default:
      break
  }
  if (node === null) return NULL_BYTES

  const object = node as object
  if (ancestors.has(object)) return 0
  // 二进制按字节精确计数（不按 base64 膨胀），否则 8 MB 上限对二进制会失真 33%
  if (ArrayBuffer.isView(object)) return object.byteLength
  if (object instanceof ArrayBuffer) return object.byteLength

  ancestors.add(object)
  let size = CONTAINER_OVERHEAD
  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      size += sizeOfNode(object[i], ancestors)
      if (i > 0) size += COMMA_BYTES
    }
  } else {
    let first = true
    for (const key of Object.keys(object)) {
      let child: unknown = undefined
      try {
        child = (object as Record<string, unknown>)[key]
      } catch {
        child = undefined
      }
      size += utf8Length(key) + KEY_OVERHEAD
      if (!first) size += COMMA_BYTES
      first = false
      size += sizeOfNode(child, ancestors)
    }
  }
  ancestors.delete(object)
  return size
}

/**
 * **帧大小估算**（字节，上界估计，不是精确 JSON 长度）。
 *
 * - 字符串按 UTF-8 字节数 + 引号，数字 8、布尔 5、`null` 4、容器与键各留少量开销；
 * - `Uint8Array`/`ArrayBuffer` 按 `byteLength` **精确**计（二进制是旁路，不该被 base64 放大）；
 * - 非数据值（函数/Symbol）按 0 计——它们本来就该先被 `checkSerializable` 拒掉；
 * - 重复引用/环按 0 计，避免死循环（形状合法性同样交给 `checkSerializable`）。
 */
export function estimateSize(value: unknown): number {
  return sizeOfNode(value, new Set<object>())
}

/** `checkFrameSize` 的结果 */
export type FrameSizeCheck =
  { ok: true; size: number } | { ok: false; size: number; code: 'EH_FRAME_TOO_LARGE'; why: string }

/**
 * 检查一帧是否超过上限（默认 `FRAME_LIMIT_BYTES`）；不抛错，便于调用方先记日志再决定。
 */
export function checkFrameSize(value: unknown, limit: number = FRAME_LIMIT_BYTES): FrameSizeCheck {
  const size = estimateSize(value)
  if (size > limit) {
    return {
      ok: false,
      size,
      code: 'EH_FRAME_TOO_LARGE',
      why: `单帧约 ${size} 字节，超过上限 ${limit} 字节（${Math.round(limit / 1024 / 1024)} MB）；请分片传输或改走文件/流`
    }
  }
  return { ok: true, size }
}

/**
 * 同 `checkFrameSize`，但超限时抛 `EhProtocolError`（`code = EH_FRAME_TOO_LARGE`）。
 * 返回估算字节数，便于日志。
 */
export function assertFrameSize(value: unknown, limit: number = FRAME_LIMIT_BYTES): number {
  const check = checkFrameSize(value, limit)
  if (!check.ok) {
    throw new EhProtocolError('EH_FRAME_TOO_LARGE', EH_ERROR_TEXT.EH_FRAME_TOO_LARGE, check.why)
  }
  return check.size
}

/**
 * 收集可 transfer 的底层缓冲（`postMessage` 的第二参数），避免大块二进制被整份复制。
 *
 * 返回**去重后**的 `ArrayBuffer`；`Uint8Array` 视图（含 `Buffer`、subarray）给出其 `buffer`
 * （transfer 会搬整个底层缓冲，接收侧的 offset/length 仍然正确）。数组本身也受 8 MB 帧上限
 * 约束，transfer 只是省掉一次拷贝。
 */
export function collectTransferables(value: unknown): ArrayBuffer[] {
  const collected: ArrayBuffer[] = []
  const seenValues = new Set<object>()
  const seenBuffers = new Set<ArrayBuffer>()

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const object = node as object
    if (seenValues.has(object)) return
    if (ArrayBuffer.isView(object)) {
      const buffer: unknown = object.buffer
      if (buffer instanceof ArrayBuffer && !seenBuffers.has(buffer)) {
        seenBuffers.add(buffer)
        collected.push(buffer)
      }
      return
    }
    if (object instanceof ArrayBuffer) {
      if (!seenBuffers.has(object)) {
        seenBuffers.add(object)
        collected.push(object)
      }
      return
    }
    seenValues.add(object)
    if (Array.isArray(object)) {
      for (const item of object) walk(item)
      return
    }
    for (const key of Object.keys(object)) {
      try {
        walk((object as Record<string, unknown>)[key])
      } catch {
        // getter 抛错：可传输性由 checkSerializable 报，这里只是收集，跳过即可
      }
    }
  }

  walk(value)
  return collected
}
