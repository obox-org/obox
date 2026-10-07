/**
 * 主进程 → 渲染进程的"跑生命周期钩子"请求/应答桥（**不依赖 electron**，可独立单测）。
 *
 * 为什么要桥：`.oix` 安装/卸载发生在**主进程**，而扩展入口只在**渲染进程**被 import
 * （`app://extensions/<id>/` + Cordis 服务），所以钩子必须请渲染进程执行（issue #52）。
 *
 * 语义（与 #52 规格一致）：
 * - 请求带 `requestId`；渲染进程跑完用同一个 id 回传结果；
 * - **超时**：钩子是进程内调用、没有天然超时（旧 `.uninstall.cjs` 是子进程 5 秒），这里默认 10 秒；
 * - **渲染进程不可用**（`send` 抛错）**不等于钩子失败**：返回 `delivered:false`，由调用方决定——
 *   安装场景据此保留 `pendingInstall` 待下次启动补跑，而不是把扩展标成激活失败。
 */
import type { HookPhase } from '../renderer/src/core/hookState'

/** 默认钩子超时（毫秒） */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000

/** 发给渲染进程的请求 */
export interface HookRunRequest {
  requestId: string
  /** 扩展 id（= 安装目录名） */
  extId: string
  phase: HookPhase
  /** 当前声明的版本（manifest.version） */
  version: string
  /** 是否覆盖安装（升级） */
  upgraded: boolean
  /** 升级前版本（仅 upgraded 为 true 时提供） */
  previousVersion?: string
}

/** 渲染进程回传的结果 */
export interface HookRunResult {
  requestId: string
  ok: boolean
  /** 入口未导出该钩子（可选、可为空，属正常） */
  skipped?: boolean
  error?: string
}

/**
 * 桥的返回值：`delivered` 区分"没送到"与"送到了但钩子失败"——
 * 这两者在调用方是完全不同的处置（保留 pending 补跑 vs 归为激活失败）。
 */
export type HookRunOutcome =
  | { delivered: false; reason: 'renderer-unavailable'; error?: string }
  | { delivered: true; ok: boolean; skipped?: boolean; error?: string }

export interface HookBridgeOptions {
  /** 把请求送出去；抛错即视为渲染进程不可用 */
  send: (request: HookRunRequest) => void
  timeoutMs?: number
  /** 便于测试注入 */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  newRequestId?: () => string
}

export interface HookBridge {
  /** 发起一次钩子执行并等待结果（超时/不可用都以求值结果表达，不抛错） */
  run(input: Omit<HookRunRequest, 'requestId'>): Promise<HookRunOutcome>
  /** 渲染进程回传结果；未知或重复的 requestId 返回 false（不抛） */
  settle(result: HookRunResult): boolean
  /** 在途请求数（诊断与测试用） */
  pendingCount(): number
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

let requestCounter = 0

export function createHookBridge(options: HookBridgeOptions): HookBridge {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout))
  const newRequestId = options.newRequestId ?? ((): string => `hook-${++requestCounter}`)

  const pending = new Map<string, { resolve: (outcome: HookRunOutcome) => void; timer: unknown }>()

  const finish = (requestId: string, outcome: HookRunOutcome): boolean => {
    const entry = pending.get(requestId)
    if (!entry) return false
    pending.delete(requestId)
    clearTimer(entry.timer)
    entry.resolve(outcome)
    return true
  }

  return {
    run(input: Omit<HookRunRequest, 'requestId'>): Promise<HookRunOutcome> {
      const requestId = newRequestId()
      return new Promise<HookRunOutcome>((resolve) => {
        const timer = setTimer(() => {
          finish(requestId, {
            delivered: true,
            ok: false,
            error: `钩子执行超时（${timeoutMs}ms）`
          })
        }, timeoutMs)
        pending.set(requestId, { resolve, timer })
        try {
          options.send({ ...input, requestId })
        } catch (error) {
          // 没送到 ≠ 钩子失败：安装场景据此保留 pendingInstall 待下次启动补跑
          finish(requestId, {
            delivered: false,
            reason: 'renderer-unavailable',
            error: describeError(error)
          })
        }
      })
    },

    settle(result: HookRunResult): boolean {
      const { requestId, ok, skipped, error } = result
      return finish(requestId, { delivered: true, ok, skipped, error })
    },

    pendingCount(): number {
      return pending.size
    }
  }
}
