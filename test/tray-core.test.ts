/**
 * 托盘菜单纯逻辑的测试（ADR-0019 决策 3/4）：顺序、分隔符、中英文案、tooltip。
 * 断言"菜单覆盖了全部动作"，避免以后加动作却漏加菜单项（或反过来）。
 */
import { describe, expect, it } from 'vitest'
import {
  TRAY_MENU_ORDER,
  trayActionIds,
  trayMenuItems,
  trayTooltip,
  type TrayMenuItem
} from '../src/main/trayCore'

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
