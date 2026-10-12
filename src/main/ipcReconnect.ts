/**
 * 断线自动重连的**纯逻辑控制器**（**不依赖 electron**，可独立单测；issue #44）。
 *
 * 语义（与 `tmp/spec/extension-ipc-reconnect.md` 的 R1–R12 一致）：
 * - 只在"首次连接成功后发生**可重连**断因"时启动（首连失败由 `connect()` 抛错给扩展，R4）；
 * - 退避序列 `backoffMs × 2^(i-1)`，单次等待封顶 `maxBackoffMs`（默认 `MAX_BACKOFF_MS`，S1）；
 * - **不排队、不重放**任何请求（N1/N2）：控制器只负责"重建传输"，请求语义由 `ipc.ts` 负责；
 * - 定时器 `unref()`（R11），且 `cancel()` 会**清掉在途等待定时器**（K4），
 *   不拖住进程退出或测试（`vi.getTimerCount() === 0` 可测）；
 * - 风格先例：`hookBridge.ts`（工厂函数 + 可注入 `sleep` + 诊断出口）。
 *
 * **`src/main/ipcTransport.ts` 一行不改**（设计 §3.5）：断因到"是否可重连"的分类属重连策略，
 * 因此 `isReconnectableCloseReason` 落在本模块；传输层只需如实把断因交给 `channel.close(reason)`。
 */
import type { IpcCoreError } from './ipcCore'
import { MAX_BACKOFF_MS } from '../shared/ipcDeclaration'

/**
 * 可重连断因的**封闭清单**（R4/S2）——只有列在这里的断因才重连。
 *
 * 依据 `JsonRpcChannel.onClose` 的 `err` 语义（`ipcCore.ts` 的 `close()`）：
 * - `err === null` ⇒ 调用方主动 `close()`（含 `transport.dispose()`）→ **不可重连**；
 * - `peer-crashed` ⇒ 对端退出 / 套接字关闭 → **可重连**；
 * - `protocol-error` ⇒ 对端发非法帧 → **不可重连**（避免与坏对端无限拉锯）；
 * - 其余码 ⇒ 都不可能作为 close 原因出现，一律视为不可重连；
 * - **首连失败不在本清单的判定范围**：它由 `connect()` 抛错，控制器根本不启动。
 */
export function isReconnectableCloseReason(err: IpcCoreError | null): boolean {
  return err?.code === 'peer-crashed'
}

/**
 * 第 `attempt` 次尝试**之前**的等待时长（纯函数，便于单测；`attempt` 从 1 起）。
 *
 * `wait(i) = min(backoffMs × 2^(i−1), maxBackoffMs)`；累乘在触顶后停止，避免 `Infinity`。
 */
export function backoffDelayFor(input: {
  attempt: number
  backoffMs: number
  maxBackoffMs?: number
}): number {
  const max = Math.max(0, input.maxBackoffMs ?? MAX_BACKOFF_MS)
  const attempt = Number.isFinite(input.attempt) ? Math.max(1, Math.floor(input.attempt)) : 1
  let delay = Math.min(Math.max(0, input.backoffMs), max)
  for (let i = 1; i < attempt; i++) {
    if (delay >= max) return max
    delay = Math.min(delay * 2, max)
  }
  return delay
}

export interface ReconnectControllerOptions {
  /** 重试次数上限（> 0；`0` 由调用方在声明层判为"关闭"，不会走到这里） */
  retries: number
  /** 首次等待（毫秒，≥ 0） */
  backoffMs: number
  /** 单次等待封顶（默认 `MAX_BACKOFF_MS`） */
  maxBackoffMs?: number
  /**
   * 一次重连尝试：成功 resolve（此后控制器停止，不再有等待/尝试）；
   * 失败 reject（含 `connect-failed`）→ 按退避继续；**不区分错误码**
   * （R4：重连期的 `connect-failed` 只用于继续退避）。
   */
  attempt: () => Promise<void>
  /** 每次尝试**开始前**（等待结束后）回调，`attempt` 从 1 起 */
  onAttempt?: (attempt: number) => void
  /** 重连成功（`attempts` = 本次共尝试次数，含成功那次） */
  onSuccess?: (info: { attempts: number }) => void
  /** 用尽 `retries` 次仍失败（**不**触发 `onSuccess`） */
  onGiveUp?: (lastError: unknown) => void
  /** 注入 sleep（默认 `setTimeout` + `unref()`；测试注入假实现以获得确定性序列） */
  sleep?: (ms: number) => Promise<void>
}

export interface ReconnectController {
  /** 启动（幂等：已在跑则忽略）。**异步**：首次尝试在第一次退避等待之后（V5 的序列要求） */
  start(): void
  /** 取消剩余重试并清理在途等待定时器（幂等；已 resolve 的尝试不受影响，`onSuccess` 不再触发） */
  cancel(): void
  readonly running: boolean
  /** 已进行的尝试次数 */
  readonly attempts: number
}

export function createReconnectController(
  options: ReconnectControllerOptions
): ReconnectController {
  const maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS
  let running = false
  let cancelled = false
  let attempts = 0
  let lastError: unknown = null
  /** 取消在途等待（`cancel()` 用；注入 sleep 时为 null —— 那条路径由 `cancelled` 兜住） */
  let abortSleep: (() => void) | null = null

  /** 默认 sleep：唯一涉及定时器的实现（先例 `ipcCore.ts` 的 `unref?.()`） */
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abortSleep = null
        resolve()
      }, ms)
      timer.unref?.() // 不要因为一次退避拖住进程退出/测试（K4）
      abortSleep = (): void => {
        abortSleep = null
        clearTimeout(timer)
        resolve()
      }
    })

  const wait = options.sleep ?? sleep

  async function run(): Promise<void> {
    for (let i = 1; i <= options.retries; i++) {
      // cancel() 之后不得再新建任何定时器/尝试（V6/V8 的 `getTimerCount() === 0`）
      if (cancelled) return
      await wait(backoffDelayFor({ attempt: i, backoffMs: options.backoffMs, maxBackoffMs }))
      if (cancelled) return
      attempts = i
      options.onAttempt?.(i)
      try {
        await options.attempt()
      } catch (err) {
        // 失败一律继续退避（不区分错误码：重连期的 connect-failed 只用于继续退避，R4）
        lastError = err
        continue
      }
      if (cancelled) return
      running = false
      options.onSuccess?.({ attempts: i })
      return
    }
    running = false
    if (cancelled) return
    options.onGiveUp?.(lastError)
  }

  return {
    start(): void {
      if (running) return
      running = true
      cancelled = false
      attempts = 0
      void run()
    },
    cancel(): void {
      cancelled = true
      running = false
      abortSleep?.()
    },
    get running(): boolean {
      return running
    },
    get attempts(): number {
      return attempts
    }
  }
}
