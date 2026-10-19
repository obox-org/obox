/**
 * **按扩展隔离错误**的执行壳：`runExtensionSafely(extId, fn)`。
 *
 * 为什么必须有它（ADR-0026 决策 6/7 + 本卡要求 6）：宿主里跑的是用户代码，用户代码会抛错，
 * 而且**到处**会抛——`plugin(api)` 同步抛、返回的 Promise reject、`api.timer` 的回调抛、
 * 事件监听器抛。任何一处漏接都会变成 `uncaughtException` → 整个宿主进程死 → 全部扩展一起挂，
 * 这正是「一个扩展失败不影响其它」要避免的。
 *
 * 设计取舍：
 * - 返回**结果对象**而不是 `undefined`/`null`：调用方需要区分「成功但返回 undefined」与
 *   「失败」，也用不上 try/catch 的缩进噪声；
 * - `report` 由调用方注入：状态表 + `log` 信封的落点是宿主的职责，这个文件只负责「兜住」；
 * - **同步与异步一视同仁**：`fn` 的返回值先 `await`，因此同步抛与 reject 走同一条路径。
 */
import { toErrorMessage } from './errors'

/** 出错阶段（进状态表与日志，用于区分「激活就挂了」和「跑起来之后某次回调挂了」） */
export type ExtensionRunPhase =
  'activate' | 'deactivate' | 'callback' | 'timer' | 'event' | 'unknown'

/** 错误上报器：宿主注入（写 `log` 信封 + 状态表） */
export type ExtensionErrorReporter = (
  extId: string,
  error: unknown,
  phase: ExtensionRunPhase
) => void

/** `runExtensionSafely` 的结果 */
export type SafeRunResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * 绑定上报器的执行壳类型：**两个参数**（`extId` + `fn`），断言/回调场景用起来最短。
 * 实现即 `createRunExtensionSafely()` 的返回值。
 */
export type SafeRunner = <T>(
  extId: string,
  fn: () => T | Promise<T>,
  phase?: ExtensionRunPhase
) => Promise<SafeRunResult<T>>

/**
 * 核心实现：跑 `fn`，抛错/拒绝时上报并返回 `{ ok: false }`。
 *
 * @param extId 出错时归属的扩展（日志/状态表按它归档）
 * @param fn 被隔离执行的函数（同步或异步）
 * @param report 上报器（宿主注入）
 * @param phase 出错阶段（缺省 `unknown`）
 */
export async function runExtensionSafely<T>(
  extId: string,
  fn: () => T | Promise<T>,
  report: ExtensionErrorReporter,
  phase: ExtensionRunPhase = 'unknown'
): Promise<SafeRunResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    try {
      report(extId, error, phase)
    } catch (reportError) {
      // 上报器自己炸了也不能把宿主带下去：退到 console（打包后不可见，但至少不连锁失败）
      console.error(
        `[extension-host] 上报扩展错误时再次出错：${toErrorMessage(reportError)}（原始错误：${toErrorMessage(error)}）`
      )
    }
    return { ok: false, error }
  }
}

/**
 * 造一个**绑定了上报器**的 `runExtensionSafely(extId, fn)`。
 * 宿主（`runtime.ts`）在 `init` 时创建一次，供激活器与 API 工厂共用：
 * 同一份上报口径，不会出现「激活失败进状态表、定时器失败只进 console」的分叉。
 */
export function createRunExtensionSafely(report: ExtensionErrorReporter): SafeRunner {
  return <T>(
    extId: string,
    fn: () => T | Promise<T>,
    phase: ExtensionRunPhase = 'unknown'
  ): Promise<SafeRunResult<T>> => runExtensionSafely(extId, fn, report, phase)
}
