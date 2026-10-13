/**
 * 托盘纯逻辑的测试（ADR-0019 决策 3/4/21）：菜单顺序、分隔符、中英文案、tooltip 文案，
 * 以及**契约门禁**——"左键单击弹菜单"已被用户决策移除，
 * 因此 `trayCore` 不得再导出点击时序状态机（`DOUBLE_CLICK_GAP_MS` /
 * `createTrayClickState` / `trayClickTransition` / `trayClickTeardown`），
 * `tray.ts` 也不得再注册 `click` 处理器。这些用例防的就是"悄悄改回单击弹菜单"。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  TRAY_MENU_ORDER,
  trayActionIds,
  trayMenuItems,
  trayTooltip,
  type TrayMenuItem
} from '../src/main/trayCore'
import * as trayCoreModule from '../src/main/trayCore'

/** 去掉块注释与行注释，避免文档/注释里的字符串把断言喂成假绿 */
function traySource(): string {
  const path = fileURLToPath(new URL('../src/main/tray.ts', import.meta.url))
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
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

describe('trayTooltip（含"双击打开 / 右键菜单"可发现性提示）', () => {
  it('中文：名称 + 版本 + 双击/右键提示', () => {
    expect(trayTooltip('obox', '1.0.4', 'zh-CN')).toBe('obox 1.0.4 — 双击打开 / 右键菜单')
  })

  it('英文：名称 + 版本 + 双击/右键提示', () => {
    expect(trayTooltip('obox', '1.0.4', 'en-US')).toBe(
      'obox 1.0.4 — Double-click to open / Right-click for menu'
    )
  })

  it('locale 缺失按英文（与 pickLocale / trayMenuItems 同一规则）', () => {
    expect(trayTooltip('obox', '1.0.4', undefined)).toContain('Double-click to open')
  })

  it('提示只讲"双击打开 / 右键菜单"，不暗示左键单击（也不出现"单击"字样）', () => {
    for (const locale of ['zh-CN', 'en-US', undefined]) {
      const tip = trayTooltip('obox', '1.0.4', locale)
      expect(tip).toMatch(/双击打开 \/ 右键菜单|Double-click to open \/ Right-click for menu/)
      expect(tip).not.toContain('单击')
      expect(tip.toLowerCase()).not.toContain('single-click')
      expect(tip.toLowerCase()).not.toContain('left-click')
    }
    // 中英各自一套，且**只**提双击这一种打开方式
    expect(trayTooltip('obox', '1.0.4', 'zh-CN')).toContain('双击打开')
    expect(trayTooltip('obox', '1.0.4', 'en-US')).toContain('Double-click to open')
  })
  it('缺名称/版本时的兜底（提示仍在）', () => {
    expect(trayTooltip('', '1.0.4', 'zh-CN')).toBe('obox 1.0.4 — 双击打开 / 右键菜单')
    expect(trayTooltip('obox', '   ', 'zh-CN')).toBe('obox — 双击打开 / 右键菜单')
    expect(trayTooltip('  ', '', 'en-US')).toBe(
      'obox — Double-click to open / Right-click for menu'
    )
  })
})

describe('托盘契约门禁：左键单击不再有任何行为（ADR-0019 决策 21）', () => {
  it('trayCore 不再导出点击时序状态机（防"悄悄改回单击弹菜单"）', () => {
    for (const name of [
      'DOUBLE_CLICK_GAP_MS',
      'createTrayClickState',
      'trayClickTransition',
      'trayClickTeardown'
    ]) {
      expect(name in trayCoreModule).toBe(false)
    }
    // 点击相位/动作类型同样不该再存在
    expect('TrayClickPhase' in trayCoreModule).toBe(false)
    expect('TrayClickAction' in trayCoreModule).toBe(false)
  })

  it("tray.ts 不再注册 click 处理器（源码里没有 tray.on('click')）", () => {
    const src = traySource()
    expect(src).not.toContain("on('click'")
    expect(src).not.toContain('"click"')
    expect(src).not.toContain('clickTimer')
    expect(src).not.toContain('popUpContextMenu')
    expect(src).not.toContain('DOUBLE_CLICK_GAP_MS')
  })

  it('tray.ts 仍接双击打开与右键菜单', () => {
    const src = traySource()
    expect(src).toContain("tray.on('double-click'")
    expect(src).toContain('actions.open()')
    expect(src).toContain('tray.setContextMenu(menu)')
  })
})
