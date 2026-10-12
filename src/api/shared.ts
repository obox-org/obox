/**
 * 扩展 API 共享类型（面向扩展作者；扩展经相对路径导入 src/api）。
 * 由 src/api/index.ts 聚合导出。
 */

/** 更新事件形状 */
export type UpdateEvent =
  | { type: 'update-available'; version?: string }
  | { type: 'update-not-available' }
  | {
      type: 'download-progress'
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }
  | { type: 'update-downloaded'; version: string }
  | { type: 'error'; message: string }

/** 代理配置 */
export interface ProxyConfig {
  enabled: boolean
  host: string
  port?: number
  username?: string
  password?: string
  ignoreSSL?: boolean
  noProxy?: string[]
}

/** Memento：JSON 值键值存储 */
export interface Memento {
  keys(): string[]
  get<T = unknown>(key: string): T | undefined
  get<T = unknown>(key: string, defaultValue: T): T
  update(key: string, value: unknown): Promise<void>
}

/**
 * 断线自动重连策略（issue #44）。**只在运行时声明对象里生效**：
 * `api.ipc.connect({ id, transport: 'pipe', autoReconnect: { retries: 5 } })`。
 * 写进 manifest 的 `contributes.ipcChannels` **既不报错也不生效**（R13/R18）。
 * 仅对 `transport: 'pipe'` 有效；`stdio` + `autoReconnect` → `invalid-declaration`。
 */
export interface IpcAutoReconnect {
  /** 重试次数上限（缺省 3；`0` 等价于关闭；必须是非负整数；**不额外封顶**） */
  retries?: number
  /** 首次退避毫秒（缺省 250；按 ×2 递增，单次封顶 30000；`0` = 不等待；必须是非负有限数） */
  backoffMs?: number
}

/**
 * 外部进程通道声明（`api.ipc.connect`）。
 * 传输**只有两种，都不使用 TCP 端口**：
 * - `stdio`：宿主拉起子进程，用它的 stdin/stdout 双向通信（`program` 必须是扩展目录内的相对路径）
 * - `pipe`：连接**已在运行**的进程（Windows 命名管道 / POSIX Unix 域套接字，端点由宿主按扩展 id + 通道名推导）
 */
export interface IpcChannelDeclaration {
  /** 通道名（同一扩展内唯一；只允许字母/数字与 . _ -） */
  id: string
  transport: 'stdio' | 'pipe'
  /** `stdio` 必填：相对扩展根目录的可执行文件/脚本路径（禁止绝对路径与 `..`） */
  program?: string
  /** `stdio` 可选：命令行参数 */
  args?: string[]
  /** 分帧：`content-length`（默认，二进制安全）或 `ndjson`（换行分隔 JSON） */
  framing?: 'content-length' | 'ndjson'
  /** 断线自动重连（仅 `transport: 'pipe'` 的**运行时**声明；见 `IpcAutoReconnect`） */
  autoReconnect?: IpcAutoReconnect
}
