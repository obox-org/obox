/**
 * 生命周期钩子的**状态判定与互斥**（不依赖 electron，可独立单测）：见 issue #52。
 *
 * 已定语义（#52 规格）：
 * - `install` 钩子"**每次安装只跑一次**"：同一版本已跑过就不再跑；**升级（版本变化）要重跑**；
 * - 安装完成后**立刻执行**；若此刻渲染进程不可用 → 记 `pendingInstall`，**下次启动扫描期补跑**（不无限重试）；
 * - `uninstall` 钩子总在删除前执行一次，不需要持久化标记；
 * - 同一扩展的同一阶段**不并发执行**（进程内互斥锁）；文档仍要求钩子幂等。
 *
 * 本模块只做判定：**不读盘、不写盘**（持久化由宿主写入 `.obox-meta.json`），因此可用纯函数测试。
 *
 * 放在 `src/shared/` 的理由：**主进程也要用同一个判定**（oix.ts 判断"该版本是否已跑过"），
 * 而渲染进程侧只在钩子执行时用；放共享处才能保证只有一套规则（此前 renderer/core 里那份因为主进程
 * 没引用，实际上成了死代码——同版本重装会重复执行，E2E 才发现）。
 */

/** 钩子阶段 */
export type HookPhase = 'install' | 'uninstall'

/** install 钩子的执行记录（持久化在扩展元数据里） */
export interface InstallHookRecord {
  /** 本次安装声明的版本（manifest.version） */
  version: string
  /** 执行时间（毫秒时间戳） */
  at: number
  /** 是否成功；失败也记录，避免"只跑一次"被破坏后无限重跑 */
  ok: boolean
}

/** 待补跑的 install 钩子（安装时渲染进程不可用） */
export interface PendingInstallRecord {
  version: string
  at: number
}

/** 持久化的钩子状态 */
export interface HookState {
  install?: InstallHookRecord
  pendingInstall?: PendingInstallRecord
}

/** 判定结果：是否需要现在执行 */
export type HookDecision =
  | { run: false; reason: 'already-done' | 'nothing-to-do' }
  | { run: true; reason: 'install' | 'upgrade' | 'pending' }

export interface InstallHookInput {
  state: HookState
  /** 本次安装声明的版本 */
  version: string
  /** 是否为覆盖安装（升级） */
  upgraded: boolean
  /** true = 安装完成后立刻这个时机；false = 启动扫描期（只能补跑 pending） */
  atInstallTime: boolean
}

/**
 * 判定 install 钩子此刻该不该跑。
 *
 * - 安装时机：该版本已记录 → `already-done`；否则要跑（升级则 reason 为 `upgrade`）
 * - 启动扫描期：仅当存在**同版本**的 `pendingInstall` 才补跑（reason `pending`），否则 `nothing-to-do`
 */
export function decideInstallHook(input: InstallHookInput): HookDecision {
  const { state, version, upgraded, atInstallTime } = input
  if (atInstallTime) {
    if (state.install !== undefined && state.install.version === version) {
      return { run: false, reason: 'already-done' }
    }
    return { run: true, reason: upgraded ? 'upgrade' : 'install' }
  }
  if (state.pendingInstall !== undefined && state.pendingInstall.version === version) {
    return { run: true, reason: 'pending' }
  }
  return { run: false, reason: 'nothing-to-do' }
}

/** 记录一次 install 钩子执行结果（返回新对象，不改原状态）；跑过即清除待补跑标记 */
export function recordInstallHook(
  state: HookState,
  version: string,
  at: number,
  ok: boolean
): HookState {
  const cleared = clearPendingInstall(state)
  return { ...cleared, install: { version, at, ok } }
}

/** 标记"安装时未能执行，待下次启动补跑" */
export function markPendingInstall(state: HookState, version: string, at: number): HookState {
  return { ...state, pendingInstall: { version, at } }
}

/** 清除待补跑标记（补跑成功、失败、或版本已变都该清） */
export function clearPendingInstall(state: HookState): HookState {
  if (state.pendingInstall === undefined) return state
  const next: HookState = { ...state }
  delete next.pendingInstall
  return next
}

/** 互斥键：同一扩展的同一阶段互斥（不同阶段可并行） */
export function hookLockKey(extensionId: string, phase: HookPhase): string {
  if (!extensionId) throw new Error('扩展 id 不能为空')
  return `${extensionId}:${phase}`
}

/** 进程内互斥锁：只保证"同扩展同阶段不并发"，不承担跨进程/持久化职责 */
export interface HookGate {
  /** 尝试占用；已被占用返回 false */
  tryAcquire(key: string): boolean
  /** 释放（未占用时为无害空操作） */
  release(key: string): void
  isRunning(key: string): boolean
}

export function createHookGate(): HookGate {
  const running = new Set<string>()
  return {
    tryAcquire(key: string): boolean {
      if (running.has(key)) return false
      running.add(key)
      return true
    },
    release(key: string): void {
      running.delete(key)
    },
    isRunning(key: string): boolean {
      return running.has(key)
    }
  }
}

/**
 * 在互斥保护下执行：已被占用时**不等待**，返回 `started: false`
 * （调用方据此决定是"跳过"还是"稍后再试"，避免钩子排队堆积）。
 */
export async function runExclusive<T>(
  gate: HookGate,
  key: string,
  task: () => Promise<T>
): Promise<{ started: true; result: T } | { started: false }> {
  if (!gate.tryAcquire(key)) return { started: false }
  try {
    return { started: true, result: await task() }
  } finally {
    gate.release(key)
  }
}
