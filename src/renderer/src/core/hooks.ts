/**
 * 扩展生命周期钩子：入口具名导出 `install` / `uninstall`（见 issue #52）。
 *
 * 本模块**不依赖 electron**（可独立单测）：只负责"从入口导出里解析钩子"与"执行并归因失败"。
 * 时机编排（`.oix` 原子替换成功后、激活前调 install；删除目录前调 uninstall）与 UI 反馈由宿主负责。
 *
 * 设计约定（访谈已定）：两个钩子**都可选、可为空**——入口未导出即跳过，不报错；
 * 钩子失败不在此模块决定后果（install 失败归为激活失败，由宿主走既有 activationError 通道）。
 */

/** 钩子名称 */
export type HookName = 'install' | 'uninstall'

/** 钩子执行上下文 */
export interface HookContext {
  /** 扩展 id */
  extensionId: string
  /** 是否为覆盖安装（升级） */
  upgraded: boolean
  /** 升级前的版本（仅 upgraded 为 true 时提供） */
  previousVersion?: string
}

/** 钩子函数：可同步可异步；返回值不使用 */
export type HookFunction = (ctx: HookContext) => unknown

/** 解析结果 */
export interface ResolvedHooks {
  install?: HookFunction
  uninstall?: HookFunction
  /** 导出过同名值但不是函数（视为未提供，但记录下来便于排查） */
  ignored: HookName[]
}

/** 单个钩子的执行结果 */
export interface HookOutcome {
  name: HookName
  /** 入口未导出该钩子（可选、可为空，属正常情况） */
  skipped: boolean
  ok: boolean
  /** 失败原因（ok 为 false 时存在），已归一化为单行文本 */
  error?: string
  /** 执行耗时（毫秒） */
  durationMs: number
}

const HOOK_NAMES: readonly HookName[] = ['install', 'uninstall']

/** 从扩展入口的导出对象里解析钩子；非函数导出视为未提供并记入 ignored */
export function resolveHooks(namespace: unknown): ResolvedHooks {
  const resolved: ResolvedHooks = { ignored: [] }
  if (typeof namespace !== 'object' || namespace === null) return resolved
  const record = namespace as Record<string, unknown>
  for (const name of HOOK_NAMES) {
    const value = record[name]
    if (typeof value === 'function') resolved[name] = value as HookFunction
    else if (value !== undefined) resolved.ignored.push(name)
  }
  return resolved
}

/** 把任意抛出物归一化成单行可读文本 */
export function normalizeHookError(error: unknown): string {
  const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
  if (error instanceof Error) return collapse(error.message) || collapse(error.name) || '未知错误'
  if (typeof error === 'string') return collapse(error) || '未知错误'
  if (error === undefined || error === null) return '未知错误'
  try {
    const text = JSON.stringify(error)
    return collapse(text ?? String(error)) || '未知错误'
  } catch {
    return collapse(String(error)) || '未知错误'
  }
}

/**
 * 执行一个钩子。
 *
 * - 钩子未导出（undefined）→ `skipped: true, ok: true`（可选、可为空，不是错误）
 * - 抛错 → `ok: false`，原因经 {@link normalizeHookError} 归一化（不向外抛，调用方据 ok 决定后果）
 */
export async function runHook(
  name: HookName,
  hook: HookFunction | undefined,
  ctx: HookContext
): Promise<HookOutcome> {
  if (hook === undefined) return { name, skipped: true, ok: true, durationMs: 0 }
  const startedAt = Date.now()
  try {
    await hook(ctx)
    return { name, skipped: false, ok: true, durationMs: Date.now() - startedAt }
  } catch (error) {
    return {
      name,
      skipped: false,
      ok: false,
      error: normalizeHookError(error),
      durationMs: Date.now() - startedAt
    }
  }
}

/** 钩子失败文案（中文，可直接展示或并入 activationError） */
export function formatHookFailure(outcome: HookOutcome): string {
  const label = outcome.name === 'install' ? '安装钩子' : '卸载钩子'
  return `${label}执行失败：${outcome.error ?? '未知错误'}`
}
