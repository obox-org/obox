/**
 * 系统托盘（**仅 Windows**，ADR-0019 决策 1/3/4）：创建/销毁托盘、菜单接线、单击弹菜单/双击打开。
 *
 * 菜单结构与 tooltip 的纯逻辑在 `trayCore.ts`（有单测）；这里只做 Electron 调用与点击时序。
 */
import { app, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import {
  DOUBLE_CLICK_GAP_MS,
  createTrayClickState,
  trayClickTeardown,
  trayClickTransition,
  trayMenuItems,
  trayTooltip,
  type TrayClickAction,
  type TrayClickState,
  type TrayMenuItemId
} from './trayCore'

export interface TrayActions {
  /** 打开主窗口（不存在则重建） */
  open: () => void
  /** 打开主窗口并切到设置页 */
  settings: () => void
  /** 关于对话框 */
  about: () => void
  /** 真退出（调用方负责置退出标志） */
  quit: () => void
}

let tray: Tray | null = null
let menu: Menu | null = null
let clickTimer: NodeJS.Timeout | null = null
/** 点击时序状态（纯状态机在 trayCore.ts，有单测） */
let clickState: TrayClickState = createTrayClickState()

/** 托盘是否可用（关闭拦截据此决定是否"收进托盘"） */
export function isTrayActive(): boolean {
  return tray !== null
}

function trayIconPath(): string {
  // 与主窗口图标同一约定（window.ts）：out/main/../../resources → 打包后经 asarUnpack 仍可读
  return join(__dirname, '../../resources/tray.ico')
}

function clearClickTimer(): void {
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
  }
}

/**
 * 把状态机产出的动作映射到 Electron 调用。
 *
 * 单击弹菜单**必须**手动 `popUpContextMenu()`：Windows 上托盘只在**右键**时弹
 * `setContextMenu` 装的菜单；左键单击只发 `click` 事件，系统不会代弹（Electron
 * `shell/browser/ui/win/notify_icon.cc` 的 `HandleClickEvent`）。因此这里保留
 * `setContextMenu`（右键仍要菜单）＋ 单击显式弹出（见 troubleshooting「托盘」条）。
 */
function runClickActions(actions: readonly TrayClickAction[], trayActions: TrayActions): void {
  for (const action of actions) {
    switch (action) {
      case 'schedule-menu':
        clearClickTimer()
        clickTimer = setTimeout(() => {
          clickTimer = null
          applyClickEvent('watchdog-fire', trayActions)
        }, DOUBLE_CLICK_GAP_MS)
        break
      case 'cancel-menu':
        clearClickTimer()
        break
      case 'show-menu': {
        const current = tray
        if (!current || current.isDestroyed()) {
          console.warn('[tray] 单击弹菜单跳过：托盘已失效')
          break
        }
        // 显式传 menu（与 setContextMenu 装的是同一份），不依赖 Electron 内部保存的引用
        if (menu) current.popUpContextMenu(menu)
        else current.popUpContextMenu()
        break
      }
      case 'open-window':
        trayActions.open()
        break
    }
  }
}

function applyClickEvent(
  event: 'click' | 'double-click' | 'watchdog-fire',
  trayActions: TrayActions
): void {
  const next = trayClickTransition(clickState, event)
  clickState = next.state
  runClickActions(next.actions, trayActions)
}

/** 创建托盘；非 Windows 或图标缺失一律返回 null（保持旧行为，不拦住启动） */
export function createTray(actions: TrayActions): Tray | null {
  if (process.platform !== 'win32') return null
  if (tray) return tray

  const icon = nativeImage.createFromPath(trayIconPath())
  if (icon.isEmpty()) {
    console.warn(`[tray] 托盘图标读取失败，跳过托盘: ${trayIconPath()}`)
    return null
  }

  const locale = app.getLocale()
  const handlers: Record<TrayMenuItemId, () => void> = {
    open: actions.open,
    settings: actions.settings,
    about: actions.about,
    quit: actions.quit
  }
  const template = trayMenuItems(locale).map((item) =>
    item.type === 'separator'
      ? { type: 'separator' as const }
      : { label: item.label, click: (): void => handlers[item.id as TrayMenuItemId]() }
  )

  tray = new Tray(icon)
  tray.setToolTip(trayTooltip(app.getName(), app.getVersion()))
  menu = Menu.buildFromTemplate(template)
  tray.setContextMenu(menu)

  // 单击：等一个双击间隔再弹菜单；双击：取消待弹菜单并打开主窗口（时序见 trayCore）
  clickState = createTrayClickState()
  tray.on('click', () => applyClickEvent('click', actions))
  tray.on('double-click', () => applyClickEvent('double-click', actions))
  return tray
}

/** 销毁托盘（退出流程/单测环境） */
export function destroyTray(): void {
  for (const action of trayClickTeardown(clickState)) {
    if (action === 'cancel-menu') clearClickTimer()
  }
  clickState = createTrayClickState()
  tray?.destroy()
  tray = null
  menu = null
}
