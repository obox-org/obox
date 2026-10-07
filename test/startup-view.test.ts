/**
 * 启动视图选择单测（core/startupView.ts）。
 * 针对对外行为断言：给定导航项集合 → 启动时激活哪一个。
 * 先例：test/manifest.test.ts、test/keybindings.test.ts（渲染进程 core 纯逻辑）。
 */
import { describe, expect, it } from 'vitest'
import {
  STARTUP_NAV_ID,
  pickStartupNavId,
  type StartupNavCandidate
} from '../src/renderer/src/core/startupView'

const nav = (id: string, group?: string, active = true): StartupNavCandidate => ({
  id,
  active,
  group
})

describe('pickStartupNavId · 固定显示"应用"', () => {
  it('内置三项齐备时固定选 app.main（与注册顺序、组别无关）', () => {
    const items = [
      nav('settings.main', 'bottom'),
      nav('app.main', 'top'),
      nav('ext-manager.main', 'bottom')
    ]
    expect(pickStartupNavId(items)).toBe('app.main')
  })

  it('即使其它导航项排在 app.main 之前，仍选 app.main', () => {
    const items = [
      nav('settings.main', 'bottom'),
      nav('ext-manager.main', 'bottom'),
      nav('app.main', 'top')
    ]
    expect(pickStartupNavId(items)).toBe('app.main')
  })

  it('启动不继承任何"上次选择"——settings 与 app 同时可用时仍选 app', () => {
    const items = [nav('settings.main', 'top'), nav('app.main', 'top')]
    expect(pickStartupNavId(items)).toBe('app.main')
  })

  it('函数是纯函数：不修改传入数组', () => {
    const items = [nav('settings.main', 'bottom'), nav('app.main', 'top')]
    const snapshot = JSON.stringify(items)
    pickStartupNavId(items)
    expect(JSON.stringify(items)).toBe(snapshot)
  })
})

describe('pickStartupNavId · 回退链（目标不可用时避免白屏）', () => {
  it('app.main 不存在 → 回退到第一个激活的 top 组项', () => {
    const items = [
      nav('settings.main', 'bottom'),
      nav('other.main', 'top'),
      nav('another.main', 'bottom')
    ]
    expect(pickStartupNavId(items)).toBe('other.main')
  })

  it('app.main 存在但被禁用（active=false）→ 同样回退', () => {
    const items = [nav('app.main', 'top', false), nav('ext-manager.main', 'bottom')]
    expect(pickStartupNavId(items)).toBe('ext-manager.main')
  })

  it('没有任何 top 组项 → 回退到第一个激活项', () => {
    const items = [nav('settings.main', 'bottom'), nav('ext-manager.main', 'bottom')]
    expect(pickStartupNavId(items)).toBe('settings.main')
  })

  it('group 未声明时视为 top', () => {
    const items = [nav('no-group.main'), nav('bottom.main', 'bottom')]
    expect(pickStartupNavId(items)).toBe('no-group.main')
  })

  it('全部被禁用 → null（内容区显示空态）', () => {
    const items = [nav('app.main', 'top', false), nav('settings.main', 'bottom', false)]
    expect(pickStartupNavId(items)).toBeNull()
  })

  it('空列表 → null', () => {
    expect(pickStartupNavId([])).toBeNull()
  })

  it('可指定自定义目标项（供未来"固定显示其它视图"复用）', () => {
    const items = [nav('app.main', 'top'), nav('settings.main', 'bottom')]
    expect(pickStartupNavId(items, 'settings.main')).toBe('settings.main')
  })

  it('导出的常量就是"应用"扩展的导航项 id', () => {
    expect(STARTUP_NAV_ID).toBe('app.main')
  })
})
