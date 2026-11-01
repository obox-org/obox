import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RPC_BUDGET_MS,
  hasExplicitBudget,
  rpcBudgetMs,
  rpcBudgetTable
} from '../src/shared/rpcBudget'

/**
 * 跨进程 RPC 预算表（2.0.3）。
 *
 * 背景：2.0.x 所有请求共用 3 秒默认预算，`ui.appMessage`（扩展 handler 会做 IO / 长轮询）
 * 必然超时——pet 面板永远"正在连接"、webapp 首次 `open()` 报"对端没有响应"。
 * 预算表把"方法族"作为唯一判定依据，渲染侧桥与宿主共用同一份。
 */
describe('rpcBudget · 表', () => {
  it('默认预算与 ACK_TIMEOUT_MS 一致（3 秒）', () => {
    expect(DEFAULT_RPC_BUDGET_MS).toBe(3000)
    expect(rpcBudgetMs('host.ping')).toBe(3000)
    expect(hasExplicitBudget('host.ping')).toBe(false)
  })

  it('消息类反向请求给足预算', () => {
    expect(rpcBudgetMs('ui.appMessage')).toBe(30_000)
    expect(rpcBudgetMs('ui.executeCommand')).toBe(30_000)
    expect(rpcBudgetMs('ui.treeChildren')).toBe(15_000)
    expect(hasExplicitBudget('ui.appMessage')).toBe(true)
  })

  it('update 家族的预算集中在这里（与 R72 一致，不再两处漂移）', () => {
    expect(rpcBudgetMs('host.update.check')).toBe(60_000)
    expect(rpcBudgetMs('host.update.download')).toBe(15 * 60_000)
    expect(rpcBudgetMs('host.update.install')).toBe(15 * 60_000)
  })

  it('未知方法回落默认值', () => {
    expect(rpcBudgetMs('host.not-a-method')).toBe(DEFAULT_RPC_BUDGET_MS)
    expect(rpcBudgetMs('')).toBe(DEFAULT_RPC_BUDGET_MS)
  })

  it('表是只读快照：改动返回值不影响内部表', () => {
    const table = rpcBudgetTable() as Record<string, number>
    table['ui.appMessage'] = 1
    expect(rpcBudgetMs('ui.appMessage')).toBe(30_000)
  })

  it('pet 的长轮询（25 秒）落在 appMessage 预算内', () => {
    // pet 的 SUBSCRIBE_HOLD_MS = 25_000，必须小于预算，否则宿主先超时
    const PET_SUBSCRIBE_HOLD_MS = 25_000
    expect(rpcBudgetMs('ui.appMessage')).toBeGreaterThan(PET_SUBSCRIBE_HOLD_MS)
  })
})
