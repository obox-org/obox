/**
 * 把「网络代理」设置转成**结构化克隆安全**的纯对象（并顺带完成旧值 → URL 的迁移）。
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
 * 归一化与旧形态迁移的**唯一实现**在 `src/shared/proxyConfig.ts`（这里不复制一份解析/迁移逻辑）：
 * `normalizeProxyConfig()` 每次返回新对象 + 新数组、字段各自收敛为原始类型，并把旧形态
 * （`{enabled,host,port,username,password,...}`，≤1.0.11 的持久化值）拼成 `http://[user:pass@]host[:port]`。
 * 任何「把代理设置送进 IPC 或跨扩展边界」的地方都必须先过这个函数。
 */
import type { ProxyConfig } from '../../../shared/types'
import { normalizeProxyConfig, type ProxyConfigInput } from '../../../shared/proxyConfig'

/** 空的默认代理配置（每次返回新对象，避免调用方共享同一份可变引用） */
export function emptyProxyConfig(): ProxyConfig {
  return { enabled: false, url: '', noProxy: [] }
}

/**
 * 归一化为纯对象。接受 `undefined` / `null` / 响应式 Proxy / 部分字段 / **旧形态**的对象
 * （旧形态会被迁移成 URL，见 `src/shared/proxyConfig.ts`）。
 * 返回对象的**所有字段值都是原始类型或新数组**，可安全结构化克隆。
 */
export function plainProxyConfig(value?: ProxyConfigInput): ProxyConfig {
  return normalizeProxyConfig(value)
}
