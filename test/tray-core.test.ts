/**
 * 托盘菜单纯逻辑的测试（ADR-0019 决策 3/4）：顺序、分隔符、中英文案、tooltip，
 * 以及**点击时序状态机**（单击延迟弹菜单 / 双击取消并开窗 / 连续单击 / 销毁清理）。
 * 断言"菜单覆盖了全部动作"，避免以后加动作却漏加菜单项（或反过来）。
 */
import { describe, expect, it } from 'vitest'
import {
  DOUBLE_CLICK_GAP_MS,
  TRAY_MENU_ORDER,
  createTrayClickState,
  trayActionIds,
  trayClickTeardown,
  trayClickTransition,
  trayMenuItems,
  trayTooltip,
  type TrayClickAction,
  type TrayClickState,
  type TrayMenuItem
} from '../src/main/trayCore'

/** 按序喂事件，返回逐次动作与最终状态（模拟 tray.ts 的接线） */
function drive(events: Array<'click' | 'double-click' | 'watchdog-fire'>): {
  actions: TrayClickAction[][]
  state: TrayClickState
} {
  let state = createTrayClickState()
  const actions: TrayClickAction[][] = []
  for (const event of events) {
    const next = trayClickTransition(state, event)
    state = next.state
    actions.push(next.actions)
  }
  return { actions, state }
}

describe('trayMenuItems', () => {
  it('中文：打开/设置/关于/——/退出', () => {
    expect(trayMenuItems('zh-CN')).toEqual([
      { id: 'open', label: '打开' },
      { id: 'settings', label: '设置' },
      { id: 'about', label: '关于' },
      { type: 'separator' },
      { id: 'quit', label: '退出' }
    ] satisfies TrayMenuItem[])
  })

  it('英文（含 locale 缺失）', () => {
    for (const locale of ['en-US', undefined]) {
      expect(trayActionIds(trayMenuItems(locale))).toEqual([...TRAY_MENU_ORDER])
      expect(trayMenuItems(locale).map((item) => item.label)).toEqual([
        'Open',
        'Settings',
        'About',
        undefined,
        'Quit'
      ])
    }
  })

  it('退出前恰有一条分隔符（避免误点退出）', () => {
    const items = trayMenuItems('zh-CN')
    expect(items.filter((item) => item.type === 'separator')).toHaveLength(1)
    expect(items.at(-2)?.type).toBe('separator')
    expect(items.at(-1)?.id).toBe('quit')
  })

  it('菜单覆盖全部动作，顺序与 TRAY_MENU_ORDER 一致', () => {
    expect(trayActionIds(trayMenuItems('zh-CN'))).toEqual([...TRAY_MENU_ORDER])
  })
})

describe('trayTooltip', () => {
  it('名称 + 版本', () => {
    expect(trayTooltip('obox', '1.0.4')).toBe('obox 1.0.4')
  })

  it('缺名称/版本时的兜底', () => {
    expect(trayTooltip('', '1.0.4')).toBe('obox 1.0.4')
    expect(trayTooltip('obox', '   ')).toBe('obox')
    expect(trayTooltip('  ', '')).toBe('obox')
  })
})

describe('托盘点击时序（trayCore，ADR-0019 决策 3）', () => {
  it('初始状态 idle、无待办', () => {
    expect(createTrayClickState()).toEqual({ phase: 'idle' })
  })

  it('单击：排定一次延迟弹菜单；定时器到点才弹菜单', () => {
    const { actions, state } = drive(['click', 'watchdog-fire'])
    expect(actions).toEqual([['schedule-menu'], ['show-menu']])
    expect(state).toEqual({ phase: 'menuOpen' })
  })

  it('双击：取消待弹菜单并打开主窗口（不弹菜单）', () => {
    const { actions, state } = drive(['click', 'double-click'])
    expect(actions).toEqual([['schedule-menu'], ['cancel-menu', 'open-window']])
    expect(state).toEqual({ phase: 'idle' })
    // 取消后**不再**有 watchdog-fire（定时器已被清掉）；即便迟到也不弹
    const late = trayClickTransition(state, 'watchdog-fire')
    expect(late.actions).toEqual([])
    expect(late.state).toEqual({ phase: 'idle' })
  })

  it('连续单击：取消上一次待弹菜单再重排（同一时刻最多一次待弹菜单）', () => {
    const { actions, state } = drive(['click', 'click'])
    expect(actions).toEqual([['schedule-menu'], ['cancel-menu', 'schedule-menu']])
    expect(state).toEqual({ phase: 'pending' })
  })

  it('菜单已弹出后再单击：重新排定（不会出现"两次弹菜单"叠加）', () => {
    const { actions } = drive(['click', 'watchdog-fire', 'click'])
    expect(actions).toEqual([['schedule-menu'], ['show-menu'], ['schedule-menu']])
  })

  it('菜单已弹出时双击：不再重复取消，直接开窗', () => {
    const { actions } = drive(['click', 'watchdog-fire', 'double-click'])
    expect(actions).toEqual([['schedule-menu'], ['show-menu'], ['open-window']])
  })

  it('未单击时收到 watchdog-fire（迟到回调）→ 什么都不做', () => {
    const { actions, state } = drive(['watchdog-fire'])
    expect(actions).toEqual([[]])
    expect(state).toEqual({ phase: 'idle' })
  })

  it('双击间隔常量仍是用于区分单击的等待量（正数）', () => {
    expect(DOUBLE_CLICK_GAP_MS).toBeGreaterThan(0)
  })

  describe('销毁清理（destroy）', () => {
    it('pending：需要清掉待弹定时器', () => {
      const { state } = drive(['click'])
      expect(trayClickTeardown(state)).toEqual(['cancel-menu'])
    })

    it('idle / menuOpen：没有待弹定时器可清', () => {
      expect(trayClickTeardown(createTrayClickState())).toEqual([])
      const open = drive(['click', 'watchdog-fire']).state
      expect(trayClickTeardown(open)).toEqual([])
    })
  })
})
