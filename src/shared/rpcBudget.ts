/**
 * 跨进程 RPC 的时间预算表（单一来源）。
 *
 * ## 为什么需要它
 *
 * 渲染进程与扩展宿主之间只有一条 `MessagePort`，所有请求共用一个默认超时
 * （`ACK_TIMEOUT_MS = 3000`）。这个数对"纯内存往返"成立，但**对会做 IO 的 handler 不成立**：
 *
 * - `api.app.onMessage` 的契约允许扩展 await 任意工作（读写文件、spawn 子进程、等用户填表单）；
 *   pet 的 `pet.subscribe` 是**长轮询**（hold 到状态变化或 25 秒），webapp 的 `open()` 会
 *   `api.ipc.connect()` 拉起 sidecar（Windows 冷启动常 >3 秒）。
 * - 3 秒预算一到，渲染侧就放弃等待并报"对端在超时时间内没有响应"，而宿主侧其实**还在执行**。
 *   用户看到的是"扩展坏了"，实际只是预算给错了。
 *
 * 2.0.x 实测（CDP 在浮层页直接调用宿主）：
 * `{"ok":false,"error":"…（方法 ui.appMessage（id=29）在 3000ms 内没有响应…）"}`——
 * pet 的面板因此永远停在"正在连接宠物"，`pet.hit` 也超时 ⇒ 鼠标穿透永不关闭。
 *
 * ## 规则
 *
 * 按**方法族**给预算，而不是给每个调用点散写魔数（`update.*` 已经踩过一次：
 * 3 秒 vs 整段下载）。调用方仍可用 `options.timeoutMs` 按次覆盖。
 *
 * 纯模块：不 import electron / DOM，node 环境可直接单测。
 */

/** 默认预算：纯内存/短 IO 往返（与 `ACK_TIMEOUT_MS` 保持一致） */
export const DEFAULT_RPC_BUDGET_MS = 3000

/**
 * 方法 → 预算（毫秒）。键必须与方法名逐字一致（`ui.appMessage` 等）。
 *
 * 只收录**真的跨进程**的方法：宿主内部的 `api.ipc.connect`（sidecar 在宿主里 spawn）不在此列。
 */
const BUDGETS: Readonly<Record<string, number>> = {
  // 渲染 → 宿主：扩展 handler 可能做 IO / 长轮询 / 等用户
  'ui.appMessage': 30_000,
  'ui.executeCommand': 30_000,
  'ui.treeChildren': 15_000,

  // 宿主 → main：update 的既有预算（R72），集中在这里避免两处漂移
  'host.update.check': 60_000,
  'host.update.resolve-feed': 60_000,
  'host.update.download': 15 * 60_000,
  'host.update.install': 15 * 60_000
}

/** 取某方法的预算；未知方法回落默认值 */
export function rpcBudgetMs(method: string): number {
  const exact = BUDGETS[method]
  if (typeof exact === 'number' && Number.isFinite(exact) && exact > 0) return exact
  return DEFAULT_RPC_BUDGET_MS
}

/** 方法是否有显式预算（诊断/测试用；`false` 表示吃默认 3 秒） */
export function hasExplicitBudget(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUDGETS, method)
}

/** 全部显式预算（只读快照，测试与文档对拍用） */
export function rpcBudgetTable(): Readonly<Record<string, number>> {
  return { ...BUDGETS }
}
