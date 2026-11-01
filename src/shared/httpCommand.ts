/**
 * 宿主 HTTP 指令面的共享契约（主进程 ↔ 渲染进程 / 扩展宿主）。
 *
 * ## 为什么需要它
 *
 * 外部程序（脚本、手机快捷指令、其它桌面工具）需要能驱动 obox 里的扩展做事，而不是只能靠点界面。
 * 设计取舍：
 *
 * - **端口随机**：监听 `127.0.0.1:0`，由系统分配空闲端口，避免和用户已占用的端口打架；
 *   实际端口与访问令牌写进 `<userData>/http-endpoint.json`，外部程序读该文件即可发现。
 * - **只绑回环地址**：不暴露到局域网；`0.0.0.0` 会把整台机器变成控制面，风险不可接受。
 * - **令牌鉴权**：除 `GET /health` 外都要 `x-obox-token` 头。仅靠"只监听本机"挡不住同机其它进程，
 *   更挡不住浏览器页面（任何网页都能 fetch 127.0.0.1）；默认不返回 CORS 头 ⇒ 浏览器读不到响应。
 * - **指令名带扩展前缀**：`<extId>:<name>`，外部调用一眼能看出归属，也天然避免两个扩展重名。
 *
 * 纯类型 + 常量模块：不 import electron / DOM，node 单测可直接用。
 */

/** 主进程 → 渲染进程：一条来自 HTTP 的指令 */
export const HTTP_COMMAND_EVENT_CHANNEL = 'http:command'

/** 渲染进程 → 主进程：指令处理结果（与 requestId 配对） */
export const HTTP_COMMAND_REPLY_CHANNEL = 'http:reply'

/** 端点发现文件（放在 userData 根目录） */
export const HTTP_ENDPOINT_FILE = 'http-endpoint.json'

/** 指令名的分隔符：`pet_chenzhi:feed` */
export const HTTP_COMMAND_SEPARATOR = ':'

/** 单条指令的默认超时（扩展 handler 可能做 IO；外部客户端应先收到 202 语义的等待） */
export const HTTP_COMMAND_TIMEOUT_MS = 30_000

/** 请求体上限（1MB）：避免外部客户端把宿主内存打满 */
export const HTTP_MAX_BODY_BYTES = 1024 * 1024

/** 端点发现文件的形状（外部程序读它即可知道端口与令牌） */
export interface HttpEndpointInfo {
  /** 实际监听端口（系统分配） */
  port: number
  /** 访问令牌：除 `/health` 外的所有请求都要放进 `x-obox-token` */
  token: string
  /** 基址，形如 `http://127.0.0.1:52341` */
  url: string
  /** 应用版本（便于外部脚本判断协议差异） */
  version: string
  /** 写入时间（ISO 字符串；排查"文件是不是旧的"用） */
  updatedAt: string
}

/** 主进程发给渲染进程的指令信封 */
export interface HttpCommandRequest {
  requestId: number
  /** `<extId>:<name>` */
  command: string
  /** 任意 JSON（已由服务端限制为 JSON） */
  payload: unknown
}

/** 渲染进程回给主进程的结果（与既有 `extension:reply` 同一形状） */
export interface HttpCommandResult {
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * 校验并拆分指令名：`<extId>:<name>`。
 *
 * 规则与扩展 id / 指令名保持一致（`[a-z0-9._-]`，扩展 id 允许 `_`），
 * 目的是**从入口就挡住**奇怪的字符串进到扩展 handler 里。
 */
export function parseHttpCommandName(
  raw: string
): { extId: string; name: string } | { error: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { error: '指令名不能为空' }
  const at = text.indexOf(HTTP_COMMAND_SEPARATOR)
  if (at <= 0 || at === text.length - 1) {
    return {
      error: `指令名必须是 <扩展id>${HTTP_COMMAND_SEPARATOR}<指令名>，例如 pet_chenzhi:feed`
    }
  }
  const extId = text.slice(0, at)
  const name = text.slice(at + 1)
  const pattern = /^[a-z0-9][a-z0-9._-]*$/
  if (!pattern.test(extId)) return { error: `扩展 id 非法：${extId}` }
  if (!pattern.test(name)) return { error: `指令名非法：${name}` }
  return { extId, name }
}

/** 拼一个规范的指令名（注册与文档共用，避免两处手写拼接） */
export function httpCommandName(extId: string, name: string): string {
  return `${extId}${HTTP_COMMAND_SEPARATOR}${name}`
}
/**
 * HTTP 指令在**既有消息桥**里的通道前缀。
 *
 * 为什么不新造一套 RPC：扩展处理一条指令本质是"拿到 channel + payload、回一个值"，与
 * `api.app.onMessage` 完全同构。复用 `ui.appMessage` 意味着宿主模式与渲染模式**共用同一条**
 * 派发路径（超时、错误归一、host-renderer 端口全都在里面），不必再造第三套代理。
 */
export const HTTP_CHANNEL_PREFIX = 'http:'

/** 指令名 → 桥通道：`feed` ⇒ `http:feed` */
export function httpChannelOf(name: string): string {
  return `${HTTP_CHANNEL_PREFIX}${name}`
}

/** 桥通道 → 指令名（不是 HTTP 通道时回 `null`） */
export function httpCommandOfChannel(channel: string): string | null {
  if (!channel.startsWith(HTTP_CHANNEL_PREFIX)) return null
  const name = channel.slice(HTTP_CHANNEL_PREFIX.length)
  return name === '' ? null : name
}
