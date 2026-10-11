/**
 * 系统托盘（**仅 Windows**，ADR-0019 决策 1/3/4）：创建/销毁托盘、菜单接线、单击弹菜单/双击打开。
 *
 * 菜单结构与 tooltip 的纯逻辑在 `trayCore.ts`（有单测）；这里只做 Electron 调用与点击时序。
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

/** 单击与双击的区分窗口：Windows 上双击前必然先来一次 click（ADR-0019 决策 3） */
const DOUBLE_CLICK_GAP_MS = 220

let tray: Tray | null = null
let clickTimer: NodeJS.Timeout | null = null

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
  tray.setToolTip(trayTooltip(app.getName(), app.getVersion()))
  tray.setContextMenu(Menu.buildFromTemplate(template))

  const showMenu = (): void => {
    tray?.popUpContextMenu()
  }
  // 单击：等一个双击间隔再弹菜单；双击：取消待弹菜单并打开主窗口
  tray.on('click', () => {
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = setTimeout(() => {
      clickTimer = null
      showMenu()
    }, DOUBLE_CLICK_GAP_MS)
  })
  tray.on('double-click', () => {
    if (clickTimer) {
      clearTimeout(clickTimer)
      clickTimer = null
    }
    actions.open()
  })
  return tray
}

/** 销毁托盘（退出流程/单测环境） */
export function destroyTray(): void {
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
  }
  tray?.destroy()
  tray = null
}
