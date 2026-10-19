/**
 * 激活器：把「**为什么现在激活它**」（激活事件）与「**怎么激活**」（`import` + `plugin(api)`）接起来。
 *
 * EH-A3 只实现 4 类激活事件（ADR-0026 决策 6）：
 * - `*`：立即激活（**缺省值**，等价于今天的行为）
 * - `onStartupFinished`：首屏之后、空闲时激活
 * - `onCommand:<id>`：命令被调用时激活
 * - `onView:<id>`：视图首次打开时激活
 *
 * 两个关键行为：
 * 1. **懒 `import()`**：只有真的要激活某个扩展时才加载它的入口模块（`loader.loadEntry`），
 *    否则 `onCommand:` 只是省掉了 `plugin(api)`，模块顶层副作用仍会在启动时跑；
 * 2. **错误归类 + 隔离**：激活失败分四类（`import` 失败 / 没导出 default / `plugin` 抛错 /
 *    不可加载），全部经 `log` 信封 + 状态表上报，且**只影响该扩展**——一个扩展失败后
 *    `dispatch` 继续激活其它扩展。
 */
import type { Disposable } from '../api/runtime'
import type { ActivationReason } from '../shared/extensionHostProtocol'
import type { BuiltExtensionApi, HostedExtensionApi } from './apiFactory'
import { toErrorMessage } from './errors'
import type { ExtensionEntryModule, ExtensionLoader, LoadedExtension } from './loader'
import type { HostLogger } from './log'
import type { SafeRunner } from './safety'
import {
  describeActivationReason,
  type ActivationFailureKind,
  type ExtensionStatusTable
} from './status'

/** 一次激活尝试的结果 */
export interface ActivationResult {
  extId: string
  /** 触发原因（字符串形式，便于日志/测试比对） */
  reason: string
  /** `activated` 成功；`failed` 失败（看 `failure`）；`skipped` 已激活或不该激活 */
  state: 'activated' | 'failed' | 'skipped'
  /** 失败归类（`state === 'failed'` 时必有） */
  failure?: { kind: ActivationFailureKind; message: string }
}

/** `Activator` 的构造参数 */
export interface ActivatorOptions {
  loader: ExtensionLoader
  status: ExtensionStatusTable
  log: HostLogger
  /** 绑定了错误上报的隔离执行壳（`plugin(api)` 经它跑） */
  runSafely: SafeRunner
  /** 按扩展构造 api（宿主注入 `extensionDataDir` / `appInfo` / `locale` / `log`） */
  createApi: (extension: LoadedExtension) => BuiltExtensionApi
}

/** 已激活扩展的现场（停用时要还的账） */
interface ActiveExtension {
  readonly built: BuiltExtensionApi
  /** `plugin(api)` 的返回值（若它是 `{ dispose() }` 或函数，停用时调用） */
  readonly disposable?: Disposable
}

/**
 * 激活事件匹配：`events` 里是否有任一条能匹配 `trigger`。
 *
 * 规则：`*` 匹配**任何**触发（它本来就是「立即激活」，不该被后续触发排除）；
 * 字符串只与同名字符串匹配；对象按 `command` / `view` 的**同名键**比较值。
 * 空数组按清单层约定视为 `['*']`。
 */
export function matchesActivationEvent(
  events: readonly ActivationReason[],
  trigger: ActivationReason
): boolean {
  const normalized = events.length === 0 ? (['*'] as readonly ActivationReason[]) : events
  return normalized.some((event) => activationEventMatches(event, trigger))
}

/** 单条事件 vs 单次触发 */
function activationEventMatches(event: ActivationReason, trigger: ActivationReason): boolean {
  if (event === '*') return true
  if (typeof event === 'string' && typeof trigger === 'string') return event === trigger
  if (typeof event === 'object' && typeof trigger === 'object') {
    if ('command' in event && 'command' in trigger) return event.command === trigger.command
    if ('view' in event && 'view' in trigger) return event.view === trigger.view
  }
  return false
}

/** `plugin(api)` 的返回值 → `Disposable`：支持返回清理函数或 `{ dispose }` 对象 */
function toDisposable(value: unknown): Disposable | undefined {
  if (typeof value === 'function') {
    const callable = value as () => void
    return {
      dispose: (): void => {
        callable()
      }
    }
  }
  if (typeof value === 'object' && value !== null && 'dispose' in value) {
    const candidate = (value as { dispose?: unknown }).dispose
    if (typeof candidate === 'function') {
      const dispose = (candidate as () => void).bind(value)
      return {
        dispose: (): void => {
          dispose()
        }
      }
    }
  }
  return undefined
}

/**
 * 激活器。
 *
 * 并发约定：同一扩展的并发激活会**复用同一次**激活（`activating` 表），
 * 避免「命令与视图同时触发」导致 `plugin(api)` 跑两遍（用户代码通常不幂等）。
 */
export class Activator {
  private readonly loader: ExtensionLoader
  private readonly status: ExtensionStatusTable
  private readonly log: HostLogger
  private readonly runSafely: SafeRunner
  private readonly createApi: (extension: LoadedExtension) => BuiltExtensionApi
  private readonly active = new Map<string, ActiveExtension>()
  private readonly activating = new Map<string, Promise<ActivationResult>>()

  constructor(options: ActivatorOptions) {
    this.loader = options.loader
    this.status = options.status
    this.log = options.log
    this.runSafely = options.runSafely
    this.createApi = options.createApi
  }

  /** 该扩展当前是否已激活 */
  isActive(extId: string): boolean {
    return this.active.has(extId)
  }

  /** 已激活的扩展 id（排序） */
  activeIds(): string[] {
    return [...this.active.keys()].sort((left, right) => left.localeCompare(right))
  }

  /**
   * 按**事件**批量激活：把所有声明了匹配事件的扩展逐个激活。
   * 返回逐个结果（含 skipped），调用方（宿主）只用于日志/诊断，不需要处理失败——
   * 失败已经进状态表，且不会中断循环。
   */
  async dispatch(trigger: ActivationReason): Promise<ActivationResult[]> {
    const results: ActivationResult[] = []
    for (const extension of this.loader.all()) {
      if (extension.state !== 'loadable') continue
      if (!matchesActivationEvent(extension.info.activationEvents, trigger)) continue
      results.push(await this.activate(extension.info.id, trigger))
    }
    return results
  }

  /**
   * 激活**指定**扩展。
   *
   * 说明：显式激活（main 的 `activate` 信封 / `host.activate` RPC）**不**校验`reason` 是否在
   * `activationEvents` 里——那是调用方的判断（用户点了命令、打开了视图）；宿主只负责
   * 「按给定原因激活并留痕」。按事件批量激活请用 `dispatch()`。
   */
  async activate(extId: string, reason: ActivationReason): Promise<ActivationResult> {
    const reasonText = describeActivationReason(reason)

    const pending = this.activating.get(extId)
    if (pending) return pending
    if (this.active.has(extId)) {
      return { extId, reason: reasonText, state: 'skipped' }
    }

    const extension = this.loader.get(extId)
    if (!extension) {
      return this.fail(extId, reasonText, 'not-loaded', `扩展 ${extId} 不在 init 清单里`)
    }
    if (extension.state === 'rejected') {
      return this.fail(extId, reasonText, 'not-loadable', extension.reason ?? '扩展不可加载')
    }

    const task = this.activateOne(extension, reasonText)
    this.activating.set(extId, task)
    try {
      return await task
    } finally {
      this.activating.delete(extId)
    }
  }

  /**
   * 停用一个扩展：清定时器 + 跑 `plugin(api)` 返回的清理，然后标记 `stopped`。
   * 未激活的扩展返回 `false`（幂等：重复停用不是错误）。
   */
  async deactivate(extId: string): Promise<boolean> {
    const entry = this.active.get(extId)
    if (!entry) return false
    this.active.delete(extId)

    entry.built.dispose()
    if (entry.disposable) {
      const outcome = await this.runSafely(extId, () => entry.disposable?.dispose(), 'deactivate')
      if (!outcome.ok) {
        this.log('warn', `扩展 ${extId} 清理函数抛错（已忽略）`, toErrorMessage(outcome.error))
      }
    }
    this.status.stop(extId)
    this.log('info', `扩展 ${extId} 已停用`)
    return true
  }

  /** 停用全部（宿主 `terminate` 时）：逐个停用，单个失败不影响其它 */
  async deactivateAll(): Promise<void> {
    for (const extId of [...this.active.keys()]) {
      await this.deactivate(extId)
    }
  }

  /** 单个扩展的激活流程（`import` → 取 default → 造 api → `plugin(api)`） */
  private async activateOne(
    extension: LoadedExtension,
    reasonText: string
  ): Promise<ActivationResult> {
    const extId = extension.info.id
    this.status.activating(extId, reasonText)
    this.log('info', `激活扩展 ${extId}（${reasonText}）`)

    let entry: ExtensionEntryModule
    try {
      entry = await this.loader.loadEntry(extId)
    } catch (error) {
      return this.fail(extId, reasonText, 'import-failed', toErrorMessage(error))
    }

    const plugin = entry.default
    if (typeof plugin !== 'function') {
      return this.fail(
        extId,
        reasonText,
        'no-default-export',
        `扩展入口 ${extension.entryPath} 未导出 default 函数（应为 plugin(api)）`
      )
    }

    const built = this.createApi(extension)
    const invoke = plugin as (api: HostedExtensionApi) => unknown
    const outcome = await this.runSafely(extId, () => invoke(built.api), 'activate')
    if (!outcome.ok) {
      built.dispose()
      return this.fail(extId, reasonText, 'plugin-threw', toErrorMessage(outcome.error))
    }

    this.active.set(extId, { built, disposable: toDisposable(outcome.value) })
    this.status.active(extId)
    this.log('info', `扩展 ${extId} 激活完成（${reasonText}）`)
    return { extId, reason: reasonText, state: 'activated' }
  }

  /** 失败收尾：状态表 + `log` 信封；**不抛错**（隔离的关键） */
  private fail(
    extId: string,
    reasonText: string,
    kind: ActivationFailureKind,
    message: string
  ): ActivationResult {
    this.status.fail(extId, kind, message)
    this.log('error', `扩展 ${extId} 激活失败（${kind}）`, `${message}；触发原因 ${reasonText}`)
    return { extId, reason: reasonText, state: 'failed', failure: { kind, message } }
  }
}
