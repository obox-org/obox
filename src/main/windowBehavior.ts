/**
 * 关闭行为的 Electron 接线（ADR-0019）：偏好读写、关闭拦截、原生提示、关于对话框、IPC。
 *
 * 纯逻辑在 `windowBehaviorCore.ts`（有单测）；这里只做 IO 与 Electron 调用。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyClosePromptResult,
  buildAboutPrompt,
  buildClosePrompt,
  decideCloseAction,
  parseCloseBehavior,
  parseWindowBehavior,
  DEFAULT_CLOSE_BEHAVIOR,
  WINDOW_BEHAVIOR_FILE,
  type CloseBehavior,
  type WindowBehaviorState
} from './windowBehaviorCore'

let state: WindowBehaviorState = { closeBehavior: DEFAULT_CLOSE_BEHAVIOR }

/**
 * 退出流程标志：一旦为 true，关闭拦截必须放行。
 * 否则托盘"退出"/偏好=退出都会被自己的 `close` 拦截吞掉（ADR-0019 决策 6）。
 */
let quitting = false

function behaviorFile(): string {
  return join(app.getPath('userData'), WINDOW_BEHAVIOR_FILE)
}

/** 启动时读取偏好（文件缺失/损坏一律回落默认，不阻塞启动） */
export function loadWindowBehavior(): void {
  try {
    state = parseWindowBehavior(JSON.parse(readFileSync(behaviorFile(), 'utf8')))
  } catch {
    state = { closeBehavior: DEFAULT_CLOSE_BEHAVIOR }
  }
}

export function closeBehavior(): CloseBehavior {
  return state.closeBehavior
}

export function setCloseBehavior(value: unknown): void {
  state = { closeBehavior: parseCloseBehavior(value) }
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(behaviorFile(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.warn('[window-behavior] 写偏好失败:', err)
  }
}

export function isQuitting(): boolean {
  return quitting
}

export function markQuitting(): void {
  quitting = true
}

export interface WindowBehaviorOptions {
  /** 托盘当前是否可用（非 Windows / 创建失败 → false，关闭退回"关窗即退出"） */
  trayAvailable: () => boolean
}

/**
 * 安装关闭拦截：
 * - `quit`（已在退出流程 / 没有托盘 / 偏好=退出）→ 放行
 * - `hide` → 取消关闭并 `hide()`（窗口不销毁，状态保留）
 * - `ask` → 取消关闭并弹原生提示，按用户选择执行
 */
export function installWindowBehavior(win: BrowserWindow, opts: WindowBehaviorOptions): void {
  win.on('close', (event) => {
    const action = decideCloseAction(closeBehavior(), {
      trayAvailable: opts.trayAvailable(),
      quitting
    })
    if (action === 'quit') {
      markQuitting()
      return
    }
    event.preventDefault()
    if (action === 'hide') {
      win.hide()
      return
    }
    void promptClose(win)
  })
}

/** 弹原生提示：收进托盘 / 退出 / 取消（勾选"记住我的选择"则写偏好） */
async function promptClose(win: BrowserWindow): Promise<void> {
  const prompt = buildClosePrompt(app.getLocale(), app.getName())
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    message: prompt.message,
    detail: prompt.detail,
    buttons: prompt.buttons,
    defaultId: prompt.defaultId,
    cancelId: prompt.cancelId,
    checkboxLabel: prompt.checkboxLabel,
    checkboxChecked: false,
    noLink: true
  })
  const outcome = applyClosePromptResult(result, closeBehavior())
  if (outcome.persist) setCloseBehavior(outcome.behavior)
  if (outcome.next === 'hide') win.hide()
  else if (outcome.next === 'quit') {
    markQuitting()
    win.close()
  }
}

/** 托盘"关于"：原生对话框显示名称与版本（含 Electron/Chromium/Node） */
export function showAboutDialog(parent?: BrowserWindow): void {
  const info = buildAboutPrompt(app.getLocale(), {
    appName: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  })
  const options = {
    type: 'info' as const,
    message: info.message,
    detail: info.detail,
    buttons: info.buttons,
    noLink: true
  }
  const target = parent && !parent.isDestroyed() ? parent : undefined
  void (target ? dialog.showMessageBox(target, options) : dialog.showMessageBox(options))
}

/** 偏好 IPC（渲染进程设置页读写；主进程是唯一权威） */
export function registerWindowBehaviorIpc(): void {
  ipcMain.handle('window:get-close-behavior', (): CloseBehavior => closeBehavior())
  ipcMain.handle('window:set-close-behavior', (_e, value: unknown): void => setCloseBehavior(value))
}
