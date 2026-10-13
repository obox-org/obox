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

// ---- 点击时序（单击弹菜单 / 双击打开主窗口，ADR-0019 决策 3） ----

/**
 * 单击与双击的区分窗口（毫秒）。Windows 的双击判定由系统完成（`WM_LBUTTONDBLCLK`），
 * 该间隔只是"单击后延迟多久弹菜单"的等待量：双击落在这个窗口内时，待弹菜单被取消。
 */
export const DOUBLE_CLICK_GAP_MS = 220

/** 点击时序状态：`idle` 无待办；`pending` 已排定一次延迟弹菜单；`menuOpen` 菜单已弹出 */
export type TrayClickPhase = 'idle' | 'pending' | 'menuOpen'

export interface TrayClickState {
  phase: TrayClickPhase
}

/** 一次点击事件应产生的动作（由 `tray.ts` 映射到 Electron 调用） */
export type TrayClickAction = 'schedule-menu' | 'cancel-menu' | 'show-menu' | 'open-window'

/** 新建时序状态 */
export function createTrayClickState(): TrayClickState {
  return { phase: 'idle' }
}

/**
 * 状态转移（**纯函数**，不碰计时器与 Electron）：
 *
 * | 当前 | 事件 | 下一状态 | 动作 |
 * | --- | --- | --- | --- |
 * | idle / menuOpen | click | pending | schedule-menu |
 * | pending | click | pending | cancel-menu + schedule-menu |
 * | pending | double-click | idle | cancel-menu + open-window |
 * | idle / menuOpen | double-click | idle | open-window（`menuOpen` 时菜单已弹出过，不再重复取消） |
 * | pending | watchdog-fire | menuOpen | show-menu |
 * | idle / menuOpen | watchdog-fire | 不变 | 无（迟到的定时器回调被忽略） |
 *
 * 返回的 `actions` 按顺序执行；空数组表示本次事件不该做任何事。
 * Windows 的双击必然带来一次 `click`（`WM_LBUTTONDOWN`）+ 一次 `double-click`
 * （`WM_LBUTTONDBLCLK`），因此"双击取消待弹菜单"落在 `pending` 分支上。
 */
export function trayClickTransition(
  state: TrayClickState,
  event: 'click' | 'double-click' | 'watchdog-fire'
): { state: TrayClickState; actions: TrayClickAction[] } {
  switch (event) {
    case 'click':
      if (state.phase === 'pending') {
        // 连续单击：取消上一次待弹菜单，重新排定一次（避免两次弹菜单）
        return {
          state: { phase: 'pending' },
          actions: ['cancel-menu', 'schedule-menu']
        }
      }
      return { state: { phase: 'pending' }, actions: ['schedule-menu'] }
    case 'double-click':
      if (state.phase === 'pending') {
        return {
          state: { phase: 'idle' },
          actions: ['cancel-menu', 'open-window']
        }
      }
      return { state: { phase: 'idle' }, actions: ['open-window'] }
    case 'watchdog-fire':
      if (state.phase === 'pending') {
        return { state: { phase: 'menuOpen' }, actions: ['show-menu'] }
      }
      return { state, actions: [] }
  }
}

/**
 * 销毁时的收尾：`pending` 需要清掉待弹菜单；已弹出的菜单由 Electron 随托盘销毁关闭。
 * 返回动作清单（`idle` / `menuOpen` 时为空）。
 */
export function trayClickTeardown(state: TrayClickState): TrayClickAction[] {
  return state.phase === 'pending' ? ['cancel-menu'] : []
}
