/**
 * 渲染进程侧的钩子执行入口（**不依赖 electron**，可独立单测；见 issue #52）。
 *
 * 把"主进程的请求"翻译成"跑入口导出的钩子并回一个结果"：
 * - 扩展尚未加载到宿主 → `deferred`（主进程据此**保留 pendingInstall**，下次启动补跑）
 * - 同扩展同阶段不并发 → `runExclusive`（已在执行则记为 deferred，不排队堆积）
 * - 入口未导出钩子 → `skipped`（可选、可为空，属正常）
 * - 钩子抛错 → `ok:false` + 归一化原因（install 场景由宿主记入 `activationError`）
 */
import type { ExtensionActivationApi } from '../../../api'
import type { ExtensionHookRunRequest, ExtensionHookRunResult } from '../../../shared/types'
import { formatHookFailure, resolveHooks, runHook } from './hooks'
import { createHookGate, hookLockKey, runExclusive } from './hookState'

/** 进程内互斥：同一扩展的同一阶段不并发执行钩子 */
const gate = createHookGate()

export interface ExecuteHookOptions {
  /** 加载扩展入口（宿主提供；缺失即 deferred） */
  load: () => Promise<unknown>
  /** 钩子上下文里的能力面（宿主用 buildApi 构造；与激活时同一套） */
  api: ExtensionActivationApi
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error)
}

/** 执行一次钩子请求并返回可直接回传主进程的结果（不抛错） */
export async function executeExtensionHook(
  request: ExtensionHookRunRequest,
  options: ExecuteHookOptions
): Promise<ExtensionHookRunResult> {
  const head = { requestId: request.requestId }
  try {
    const outcome = await runExclusive(
      gate,
      hookLockKey(request.extId, request.phase),
      async () => {
        const module = await options.load()
        const hook = resolveHooks(module)[request.phase]
        return runHook(request.phase, hook, {
          extensionId: request.extId,
          upgraded: request.upgraded,
          previousVersion: request.previousVersion,
          api: options.api
        })
      }
    )
    if (!outcome.started) {
      return { ...head, ok: false, deferred: true, error: '同阶段的钩子正在执行，留待下次补跑' }
    }
    const result = outcome.result
    if (!result.ok) {
      return { ...head, ok: false, skipped: result.skipped, error: formatHookFailure(result) }
    }
    return { ...head, ok: true, skipped: result.skipped }
  } catch (error) {
    // 入口加载失败等：钩子跑不了，但**不能**记成"已跑过"
    return { ...head, ok: false, deferred: true, error: describe(error) }
  }
}

/** 扩展未加载到宿主时的返回（主进程保留 pendingInstall 待下次启动补跑） */
export function deferredHookResult(
  requestId: string,
  reason = '扩展尚未加载到宿主，留待下次启动补跑'
): ExtensionHookRunResult {
  return { requestId, ok: false, deferred: true, error: reason }
}

/**
 * 由钩子结果得出"要不要记激活失败"。
 * 只有**真的执行过且失败**才算；`deferred` 与成功都不算。
 */
export function hookFailureForActivation(result: ExtensionHookRunResult): string | undefined {
  if (result.ok || result.deferred) return undefined
  return result.error ?? '生命周期钩子执行失败'
}
