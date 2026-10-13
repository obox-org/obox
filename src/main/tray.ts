/**
 * 系统托盘（**仅 Windows**，ADR-0019 决策 1/3/4/21）：创建/销毁托盘、菜单接线。
 *
 * 点击行为（ADR-0019 决策 21）：**左键单击无任何行为**、**双击**打开主窗口、
 * **右键**弹菜单（由 `setContextMenu` 提供，Windows 上系统只在右键时弹）。
 * 菜单结构与 tooltip 的纯逻辑在 `trayCore.ts`（有单测）；这里只做 Electron 接线。
 */
import { app, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { trayMenuItems, trayTooltip, type TrayMenuItemId } from './trayCore'

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

/** 托盘是否可用（关闭拦截据此决定是否"收进托盘"） */
export function isTrayActive(): boolean {
  return tray !== null
}

function trayIconPath(): string {
  // 与主窗口图标同一约定（window.ts）：out/main/../../resources → 打包后经 asarUnpack 仍可读
  return join(__dirname, '../../resources/tray.ico')
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
  tray.setToolTip(trayTooltip(app.getName(), app.getVersion(), locale))
  menu = Menu.buildFromTemplate(template)
  // 右键菜单：Windows 上 `setContextMenu` 装的菜单只由**右键**弹出（Electron
  // `shell/browser/ui/win/notify_icon.cc` 的 `HandleClickEvent`）；不再注册 `click` 处理器，
  // 因此**左键单击无任何行为**（ADR-0019 决策 21）。
  tray.setContextMenu(menu)
  // 双击打开主窗口（左键单击不再有行为，无需再做"延迟区分单击/双击"）
  tray.on('double-click', () => actions.open())
  return tray
}

/** 销毁托盘（退出流程/单测环境） */
export function destroyTray(): void {
  tray?.destroy()
  tray = null
  menu = null
}
