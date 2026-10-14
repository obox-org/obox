/**
 * 代理配置的**形态归一化 + 旧值迁移**（纯函数，主进程 / 渲染进程 / 单测三处共享）。
 *
 * 为什么单独一个文件（而不是塞进 `src/main/proxy.ts`）：
 * - 代理 URL 的**解析**（`parseProxyUrl`）与 **Chromium 规则串派生**（`proxyRulesOf`）的唯一实现在
 *   `src/main/proxy.ts`——那里 `import 'electron'`，渲染层不能 import（Renderer 里没有 electron 模块）；
 * - 但「旧形态 → 单个 URL」的迁移两边都要用：主进程要容忍旧值从别处流入（`applyProxyToSession`），
 *   设置页首屏要把持久化里的旧值显示成 URL（`readProxyConfig()`）。
 *   于是迁移实现只放这里一份，**渲染层不许再抄一遍**。
 *
 * 旧形态（≤1.0.11，见 `LegacyProxyConfig`）：`{enabled,host,port?,username?,password?,...}`
 * 新形态（≥1.0.12，见 `ProxyConfig`）：`{enabled,url,ignoreSSL?,noProxy?}`
 */
import type { ProxyConfig, LegacyProxyConfig } from './types'

/** 归一化入参：新形态 / 旧形态 / 响应式 Proxy / 部分字段 / 类型垃圾（设置里可能被写进任何东西） */
export type ProxyConfigInput =
  Partial<ProxyConfig & LegacyProxyConfig> | LegacyProxyConfig | ProxyConfig | null | undefined

/** 取一个未知值为字符串（非字符串一律空串），并 trim */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * **旧形态 → 代理 URL**（唯一的迁移实现）。
 *
 * - `host` 为空 → 空串（无代理）
 * - 默认协议 `http`（旧形态没有协议概念，历史行为就是 `http://host:port`）
 * - `username` 非空时写入 userinfo，`password` 一并写入（各自百分号编码，
 *   避免密码里的 `@ : / %` 破坏 URL）；只有密码没有用户名 → 不迁移凭据
 *   （Chromium 的 login 事件必须有用户名，只有密码没有意义）
 * - `port` 为**有限正整数**时写入（容忍被写成数字字符串的脏值；越界/非数字则省略，
 *   由协议缺省端口决定）；IPv6 字面量自动加方括号
 * - `host` 里已经写了完整 URL（非预期，但可能被手工/扩展写入）→ 原样采用，不重复加协议前缀
 */
export function legacyProxyToUrl(value?: ProxyConfigInput): string {
  const src = (value ?? {}) as Record<string, unknown>
  const rawHost = str(src.host)
  if (!rawHost) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost)) return rawHost

  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost

  const portRaw = typeof src.port === 'number' ? src.port : Number(str(src.port))
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : undefined

  const username = str(src.username)
  const password = typeof src.password === 'string' ? src.password : ''
  const auth = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    : ''

  return `http://${auth}${host}${port ? `:${port}` : ''}`
}

/**
 * 归一化为**新形态**的纯对象（每次返回新对象 + 新 `noProxy` 数组 ⇒ 可安全结构化克隆）。
 *
 * - 已经是新形态（`url` 是非空字符串）→ 只收敛字段，不碰 URL
 * - 旧形态（有 `host`）→ 经 `legacyProxyToUrl()` 迁移成 URL，设置不丢
 * - `enabled` 非严格 `true` 一律 `false`；`ignoreSSL` 只在是布尔值时写入；
 *   `noProxy` 元素一律转字符串（挡掉扩展/界面写进设置的奇怪类型）
 */
export function normalizeProxyConfig(value?: ProxyConfigInput): ProxyConfig {
  const src = (value ?? {}) as Record<string, unknown>
  const url = str(src.url) || legacyProxyToUrl(src)
  const out: ProxyConfig = {
    enabled: src.enabled === true,
    url,
    noProxy: Array.isArray(src.noProxy) ? src.noProxy.map((x) => String(x)) : []
  }
  if (typeof src.ignoreSSL === 'boolean') out.ignoreSSL = src.ignoreSSL
  return out
}

/** 输入是否是**旧形态**（有 host 而没有 url）——迁移判据，仅供诊断/测试使用 */
export function isLegacyProxyInput(value?: ProxyConfigInput): boolean {
  const src = (value ?? {}) as Record<string, unknown>
  return !str(src.url) && !!str(src.host)
}
