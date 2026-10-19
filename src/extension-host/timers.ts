/**
 * 定时器小工具：**不让定时器拖住宿主退出**。
 *
 * Node 的 `setTimeout`/`setInterval` 会把事件循环按住（进程不退出）。宿主进程里有两类定时器：
 * - 业务定时器（扩展 `api.timer` 的秒级定时器、RPC 的 ack 超时）；
 * - 退出宽限定时器（收到 `terminate` 后 `graceMs` 强制退出）。
 *
 * 两类都**不应**成为「宿主已经清理完却还在等定时器」的原因：`terminate` 到达后宿主自己会
 * `process.exit()`，宽限定时器只是兜底。因此统一 `unref()`——有别的活（消息、IO）时它照常触发，
 * 没别的活时它不阻止进程退出。
 *
 * 单独成文件而不是各写一份：`unref` 在浏览器/测试环境里不存在（句柄是数字），
 * 必须用可选调用兜底，这种「环境差异」写一次就够。
 */

/** 对定时器句柄尝试 `unref`（环境不支持时静默跳过） */
export function unrefTimer(handle: unknown): void {
  const unrefable = handle as unknown as { unref?: () => void }
  unrefable.unref?.()
}
