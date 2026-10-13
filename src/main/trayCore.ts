/**
 * 托盘菜单的**纯逻辑**（project: ADR-0019 决策 3/4/11/21）。
 *
 * 只产出"菜单项描述"（id + 文案 + 分隔符）与 tooltip 文案，Electron 的
 * `Menu.buildFromTemplate` 与 `click` 回调在 `tray.ts` 里接线——这样菜单结构能在 vitest 里
 * 确定性断言，不需要 electron。
 *
 * 点击行为（ADR-0019 决策 21）：**左键单击无任何行为**、双击打开主窗口、右键弹菜单。
 * 因此这里**没有**点击时序逻辑——不需要"延迟区分单击/双击"的状态机与定时器。
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

/**
 * 托盘 tooltip（悬停提示）：名称 + 版本 + **可发现性提示**。
 *
 * 为什么带提示：左键单击不再有任何行为（ADR-0019 决策 21），用户没有别的途径知道
 * "双击能打开窗口 / 右键能出菜单"，因此把操作方式写进悬停提示作为缓解措施。
 * 与 `trayMenuItems` 同样按 locale 出 zh/en 两份（主进程唯一语言来源是 `app.getLocale()`）。
 */
export function trayTooltip(appName: string, version: string, locale: string | undefined): string {
  const name = appName.trim() || 'obox'
  const head = version.trim() ? `${name} ${version.trim()}` : name
  const hint =
    pickLocale(locale) === 'zh'
      ? '双击打开 / 右键菜单'
      : 'Double-click to open / Right-click for menu'
  return `${head} — ${hint}`
}

/** 可点击项 id 清单（供壳层断言"菜单覆盖了全部动作"） */
export function trayActionIds(items: readonly TrayMenuItem[]): TrayMenuItemId[] {
  return items.flatMap((item) => (item.id ? [item.id] : []))
}
