/**
 * 把「网络代理」设置转成**结构化克隆安全**的纯对象。
 *
 * 为什么必须有它：`stateStore` 的 state 是 `reactive(...)`，于是
 * `stateStore.getSetting('network.proxy')` 返回的是 **Proxy**，且其嵌套的 `noProxy` 数组**也是**
 * Proxy。而 `ipcRenderer.invoke` 的参数走**结构化克隆**，Proxy 会被直接拒掉：
 *
 * ```
 * Uncaught (in promise) Error: An object could not be cloned.
 * ```
 *
 * 实测症状（1.0.10 复核更新功能时发现）：设置 → 更新 → 点「检查更新」后按钮永久停在「检查中…」，
 * 主进程日志只有上面那行；而把同一个 IPC 用**字面量纯对象**调用则正常返回 `{ok:true}`。
 * 同类路径一并受影响：`api.net.fetch`（把该设置直接当第二个参数传给 IPC）与
 * `api.update.check/download/install`（`buildUpdateApi` 的 `proxy()`）。
 *
 * 因此这里**显式构造**新对象：只取已知字段、`noProxy` 复制成新数组、其余字段各自收敛为原始类型
 * （同时挡掉扩展/界面把奇怪类型写进设置的情况）。任何「把代理设置送进 IPC 或跨扩展边界」的地方
 * 都必须先过这个函数。
 */
import type { ProxyConfig } from '../../../shared/types'

/** 空的默认代理配置（每次返回新对象，避免调用方共享同一份可变引用） */
export function emptyProxyConfig(): ProxyConfig {
  return { enabled: false, host: '', noProxy: [] }
}

/**
 * 归一化为纯对象。接受 `undefined` / `null` / 响应式 Proxy / 部分字段的对象。
 * 返回对象的**所有字段值都是原始类型或新数组**，可安全结构化克隆。
 */
export function plainProxyConfig(value?: Partial<ProxyConfig> | null): ProxyConfig {
  const p: Partial<ProxyConfig> = value ?? {}
  const out: ProxyConfig = {
    enabled: p.enabled === true,
    host: typeof p.host === 'string' ? p.host : '',
    noProxy: Array.isArray(p.noProxy) ? p.noProxy.map((x) => String(x)) : []
  }
  if (typeof p.port === 'number' && Number.isFinite(p.port)) out.port = p.port
  if (typeof p.username === 'string' && p.username) out.username = p.username
  if (typeof p.password === 'string' && p.password) out.password = p.password
  if (typeof p.ignoreSSL === 'boolean') out.ignoreSSL = p.ignoreSSL
  return out
}
