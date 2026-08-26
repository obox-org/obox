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
