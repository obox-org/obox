/**
 * 扩展运行时**状态表**：一个扩展一行，是「宿主现在怎么看待这个扩展」的唯一真相。
 *
 * 为什么需要一张显式的表，而不是只靠 `Map<extId, plugin>`：
 * 1. 激活是**异步、可失败、可懒触发**的。用户问「我的扩展为什么没生效」时，答案有五种可能
 *    （apiVersion 超限被拒 / 入口 import 失败 / 没导出 default / `plugin(api)` 抛错 / 还没到激活事件），
 *    只记录「active 集合」的话，其余四种状态全都会显示成「没加载」，无法归因；
 * 2. 状态表要能经 `host.status` RPC 一次性吐给 main/渲染侧（扩展管理器展示），因此必须是纯数据；
 * 3. 错误隔离要求「一个扩展失败不影响其它」，而失败**必须留痕**——不留痕的隔离等于静默失败。
 */
import type { ActivationReason, HostedExtensionInfo } from '../shared/extensionHostProtocol'

/**
 * 扩展在宿主里的生命周期状态：
 * - `pending`：已进清单，尚未激活（等激活事件）
 * - `activating`：正在 `import()` + `plugin(api)`
 * - `active`：激活成功且未停用
 * - `failed`：激活失败（已归类，见 `ActivationFailureKind`）
 * - `rejected`：**不可加载**（apiVersion 超限 / id 非法 / 入口越界），连 `import()` 都不做
 * - `stopped`：曾激活成功，已停用（宿主关闭或热停用）
 */
export type ExtensionState = 'pending' | 'activating' | 'active' | 'failed' | 'rejected' | 'stopped'

/**
 * 激活失败的归类。EH-A3 只要求区分「未导出 default」与「抛错」，这里额外留了入口加载失败
 * 与「不在清单里」两类：它们对用户是不同的话（装错包 vs 扩展代码 bug vs 没装）。
 */
export type ActivationFailureKind =
  'not-loaded' | 'not-loadable' | 'import-failed' | 'no-default-export' | 'plugin-threw'

/** 一次失败记录（`kind` 用于程序判断，`message` 给用户看） */
export interface ExtensionFailure {
  kind: ActivationFailureKind
  message: string
  at: number
}

/** 一个扩展的运行时状态（纯数据，可直接进 RPC 结果） */
export interface ExtensionStatus {
  /** 扩展 id */
  readonly extId: string
  /** 扩展版本（来自清单摘要） */
  readonly version: string
  /** 扩展声明的 apiVersion */
  readonly apiVersion: number
  /** 归一后的激活事件（字符串形式，便于展示与日志） */
  readonly activationEvents: string[]
  /** 当前状态 */
  state: ExtensionState
  /** 激活成功次数（懒激活 + 停用后再激活会累加） */
  activationCount: number
  /** 最近一次激活尝试（原因 + 时间） */
  lastActivation?: { reason: string; at: number }
  /** 最近一次失败（成功后清除） */
  failure?: ExtensionFailure
  /** 最近一次**运行期**错误（激活之后回调/定时器里抛的错；不改变 `state`） */
  runtimeError?: { phase: string; message: string; at: number }
}

/**
 * 激活原因 → 清单里的字符串形式（`onCommand:xxx` / `onView:xxx`）。
 *
 * 只用于**展示与日志**：内部判定一律用结构化对象（`parseActivationEvent` 的另一半），
 * 免得每次比较都 `startsWith` + `slice`。
 */
export function describeActivationReason(reason: ActivationReason): string {
  if (typeof reason === 'string') return reason
  if ('command' in reason) return `onCommand:${reason.command}`
  return `onView:${reason.view}`
}

/**
 * 状态表。所有写操作都要求该扩展已 `seed()`（`init` 时一次性播种），未知 id 静默忽略——
 * 理由：状态表是**观测**设施，不该因为一条迟到的激活结果把宿主搞崩。
 */
export class ExtensionStatusTable {
  private readonly rows = new Map<string, ExtensionStatus>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** 播种一行（`init` 时按清单摘要建立） */
  seed(info: HostedExtensionInfo): ExtensionStatus {
    const row: ExtensionStatus = {
      extId: info.id,
      version: info.version,
      apiVersion: info.apiVersion,
      activationEvents: info.activationEvents.map(describeActivationReason),
      state: 'pending',
      activationCount: 0
    }
    this.rows.set(info.id, row)
    return row
  }

  /** 标记不可加载（apiVersion 超限、id 非法等），并把原因写进 `failure` */
  reject(extId: string, reason: string): void {
    const row = this.rows.get(extId)
    if (!row) return
    row.state = 'rejected'
    row.failure = { kind: 'not-loadable', message: reason, at: this.now() }
  }

  /** 开始激活（幂等：重复进入只更新最近原因） */
  activating(extId: string, reason: string): void {
    const row = this.rows.get(extId)
    if (!row) return
    row.state = 'activating'
    row.lastActivation = { reason, at: this.now() }
  }

  /** 激活成功：清掉历史失败，`activationCount` 累加 */
  active(extId: string): void {
    const row = this.rows.get(extId)
    if (!row) return
    row.state = 'active'
    row.activationCount += 1
    delete row.failure
  }

  /** 激活失败：归类留痕 */
  fail(extId: string, kind: ActivationFailureKind, message: string): void {
    const row = this.rows.get(extId)
    if (!row) return
    row.state = 'failed'
    row.failure = { kind, message, at: this.now() }
  }

  /** 已停用（宿主关闭 / 热停用）；保留失败历史，便于事后看「停用前是不是出过错」 */
  stop(extId: string): void {
    const row = this.rows.get(extId)
    if (!row) return
    row.state = 'stopped'
  }

  /**
   * 记录**运行期**错误（激活成功后的定时器/回调抛错）。
   * 刻意不改 `state`：扩展仍然活着，只是某次回调失败；改状态会让「一个回调出错 = 扩展挂掉」，
   * 与「一个扩展失败不影响其它」的隔离目标相反。
   */
  recordRuntimeError(extId: string, phase: string, message: string): void {
    const row = this.rows.get(extId)
    if (!row) return
    row.runtimeError = { phase, message, at: this.now() }
  }

  get(extId: string): ExtensionStatus | undefined {
    return this.rows.get(extId)
  }

  /** 全部行（按 id 排序，保证 RPC 结果稳定可比对） */
  all(): ExtensionStatus[] {
    return [...this.rows.values()].sort((left, right) => left.extId.localeCompare(right.extId))
  }

  /** 某状态的扩展数（测试与宿主自检用） */
  count(state: ExtensionState): number {
    let total = 0
    for (const row of this.rows.values()) {
      if (row.state === state) total += 1
    }
    return total
  }

  /** 清空（宿主重建时用；当前 EH-A3 只在 `dispose` 里用不到，但保留对称入口） */
  clear(): void {
    this.rows.clear()
  }
}
