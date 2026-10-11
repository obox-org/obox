/**
 * 开机自启的 Electron 接线（仅 Windows，ADR-0019 决策 12–14）：
 * 注册/注销登录项、读**系统真实状态**（含任务管理器的启用/禁用）、启动参数识别、IPC。
 *
 * 纯逻辑在 `autoStartCore.ts`（有单测）。
 */
import { app, ipcMain } from 'electron'
import {
  AUTOSTART_ARG,
  autoStartFailureText,
  autoStartUnsupportedText,
  buildLoginItemSettings,
  findLoginItem,
  isAutostartLaunch,
  loginItemQuery,
  resolveAutoStartEnabled,
  resolveAutoStartSupport
} from './autoStartCore'
import { launchAtLogin, setLaunchAtLogin } from './windowBehavior'

export interface AutoStartState {
  /** 是否支持（仅 Windows 且非开发版） */
  supported: boolean
  /** 系统真实状态：真会开机自启吗 */
  enabled: boolean
  /** 不支持时的原因与说明（设置页据此显示） */
  reason?: 'platform' | 'dev'
  message?: string
}

export function autoStartSupport(): { supported: boolean; reason?: 'platform' | 'dev' } {
  return resolveAutoStartSupport({ platform: process.platform, isPackaged: app.isPackaged })
}

/** 本次进程是否由开机自启拉起（Windows 无系统级标识，只能看自己的参数） */
export function startedByAutoStart(argv: readonly string[] = process.argv): boolean {
  return isAutostartLaunch(argv)
}

/**
 * 读**系统真实状态**：`openAtLogin` 说明存在启动项，`launchItems[].enabled` 说明它在
 * 任务管理器"启动应用"里是否启用（用户可以在保留 Run 值的情况下禁用它）。
 */
export function readAutoStartEnabled(): boolean {
  const settings = app.getLoginItemSettings(loginItemQuery(process.execPath))
  const item = findLoginItem(settings.launchItems)
  return resolveAutoStartEnabled({
    openAtLogin: settings.openAtLogin,
    launchItemEnabled: item?.enabled
  })
}

function currentState(): AutoStartState {
  const support = autoStartSupport()
  if (!support.supported) {
    return {
      supported: false,
      enabled: false,
      reason: support.reason,
      message: autoStartUnsupportedText(app.getLocale(), support.reason)
    }
  }
  return { supported: true, enabled: readAutoStartEnabled() }
}

/** 偏好 IPC：读（以系统为准并回写偏好）/ 写（失败回弹 + 原因） */
export function registerAutoStartIpc(): void {
  ipcMain.handle('app:get-auto-start', (): AutoStartState => {
    const state = currentState()
    // 以系统真实状态为准并回写偏好（ADR-0019 决策 12）
    if (state.supported && state.enabled !== launchAtLogin()) setLaunchAtLogin(state.enabled)
    return state
  })

  ipcMain.handle('app:set-auto-start', (_e, value: unknown): AutoStartState => {
    const support = autoStartSupport()
    if (!support.supported) return currentState()
    const wanted = value === true
    let error: string | undefined
    try {
      app.setLoginItemSettings(
        buildLoginItemSettings(wanted, process.execPath) as Electron.Settings
      )
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    // 复读校验：注册表写入失败/被策略拦截时，开关要回弹到真实状态（ADR-0019 决策 14）
    const actual = readAutoStartEnabled()
    setLaunchAtLogin(actual)
    if (actual !== wanted) {
      console.warn(`[auto-start] 设置开机自启失败（期望 ${wanted}，实际 ${actual}）`, error ?? '')
      return {
        supported: true,
        enabled: actual,
        message: autoStartFailureText(app.getLocale(), error)
      }
    }
    return { supported: true, enabled: actual }
  })
}

export { AUTOSTART_ARG }
