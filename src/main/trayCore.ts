/**
 * 托盘菜单的**纯逻辑**（project: ADR-0019 决策 3/4/11）。
 *
 * 只产出"菜单项描述"（id + 文案 + 分隔符），Electron 的 `Menu.buildFromTemplate` 与
 * `click` 回调在 `tray.ts` 里接线——这样菜单结构能在 vitest 里确定性断言，不需要 electron。
 */
import { pickLocale } from './windowBehaviorCore'

/** 可点击项 id（托盘菜单顺序：打开 / 设置 / 关于 / —— / 退出） */
export type TrayMenuItemId = 'open' | 'settings' | 'about' | 'quit'

export interface TrayMenuItem {
  /** 分隔符没有 id/label */
  type?: 'separator'
  id?: TrayMenuItemId
  label?: string
}

/** 菜单项顺序（打开恒为"打开"，不随窗口可见性变文案） */
export const TRAY_MENU_ORDER: readonly TrayMenuItemId[] = ['open', 'settings', 'about', 'quit']

/** 按语言产出菜单项（退出前插一条分隔符，避免误点） */
export function trayMenuItems(locale: string | undefined): TrayMenuItem[] {
  const zh = pickLocale(locale) === 'zh'
  const labels: Record<TrayMenuItemId, string> = zh
    ? { open: '打开', settings: '设置', about: '关于', quit: '退出' }
    : { open: 'Open', settings: 'Settings', about: 'About', quit: 'Quit' }
  const items: TrayMenuItem[] = []
  for (const id of TRAY_MENU_ORDER) {
    if (id === 'quit') items.push({ type: 'separator' })
    items.push({ id, label: labels[id] })
  }
  return items
}

/** 托盘 tooltip（悬停提示） */
export function trayTooltip(appName: string, version: string): string {
  const name = appName.trim() || 'obox'
  return version.trim() ? `${name} ${version.trim()}` : name
}

/** 可点击项 id 清单（供壳层断言"菜单覆盖了全部动作"） */
export function trayActionIds(items: readonly TrayMenuItem[]): TrayMenuItemId[] {
  return items.flatMap((item) => (item.id ? [item.id] : []))
}
