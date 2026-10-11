/**
 * 开机自启的**纯逻辑**（ADR-0019 决策 12）：启动参数识别、登录项设置构造、"注册表真实状态"归并、失败文案。
 *
 * electron-free，便于确定性单测；Electron 调用在 `autoStart.ts`。
 *
 * 事实依据（Electron 44.6 d.ts 实测）：
 * - `openAtLogin` 全平台；`path`/`args`/`name`/`enabled` 是 **Windows only**；
 * - **`openAsHidden` 已在 Electron 44 移除**，Windows 也没有"本次是否由登录项启动"的 API
 *   （`wasOpenedAtLogin` 仅 macOS）→ 静默启动只能由应用自带参数实现；
 * - 读取时必须传入与写入**相同**的 `path`/`args`，否则 `openAtLogin` 不准；
 * - `launchItems[].enabled` 反映任务管理器"启动应用"的启用状态（可被用户关闭而 Run 值仍在）。
 */
import { pickLocale } from './windowBehaviorCore'

/** 开机自启时附加的参数（用于静默启动；Windows 无系统级"由登录项启动"标识） */
export const AUTOSTART_ARG = '--autostart'

/** 注册表值名：默认取 AppUserModelId，显式传避免依赖 toolkit 在 dev/打包下的差异 */
export const LOGIN_ITEM_NAME = 'com.obox.app'

/** 本次进程是否由开机自启拉起 */
export function isAutostartLaunch(argv: readonly string[]): boolean {
  return argv.includes(AUTOSTART_ARG)
}

export interface LoginItemSettingsShape {
  openAtLogin: boolean
  path: string
  args: string[]
  name: string
  enabled?: boolean
}

/** 构造 `app.setLoginItemSettings` 的入参（启用时顺带把任务管理器里的开关置为启用） */
export function buildLoginItemSettings(enabled: boolean, exePath: string): LoginItemSettingsShape {
  const base: LoginItemSettingsShape = {
    openAtLogin: enabled,
    path: exePath,
    args: [AUTOSTART_ARG],
    name: LOGIN_ITEM_NAME
  }
  return enabled ? { ...base, enabled: true } : base
}

/** 读取时使用的比对参数（必须与写入一致，否则 openAtLogin 不准） */
export function loginItemQuery(exePath: string): { path: string; args: string[] } {
  return { path: exePath, args: [AUTOSTART_ARG] }
}

/**
 * 归并"系统真实状态"：`openAtLogin` 表示存在启动项，`launchItemEnabled` 表示它在任务管理器里是否启用。
 * 任务管理器可以在保留 Run 值的情况下禁用（`StartupApproved\Run` 首字节 03），
 * 因此只有两者都为真才算"真会开机自启"（读不到 launchItems 时退回 openAtLogin）。
 */
export function resolveAutoStartEnabled(input: {
  openAtLogin: boolean
  launchItemEnabled?: boolean
}): boolean {
  if (!input.openAtLogin) return false
  return input.launchItemEnabled === undefined ? true : input.launchItemEnabled
}

/** 从 launchItems 里找本应用的条目（按值名匹配） */
export function findLoginItem<T extends { name: string; enabled?: boolean }>(
  items: readonly T[] | undefined
): T | undefined {
  return items?.find((item) => item.name === LOGIN_ITEM_NAME)
}

export interface AutoStartSupport {
  supported: boolean
  /** 不支持时的原因（设置页据此显示说明；`dev` 表示开发版） */
  reason?: 'platform' | 'dev'
}

/**
 * 是否支持开机自启：**仅 Windows 且非开发版**。
 * 开发版下 `process.execPath` 是 `node_modules/electron/dist/electron.exe`，注册进去只会留下无效启动项
 * （ADR-0019 决策 13）。
 */
export function resolveAutoStartSupport(input: {
  platform: string
  isPackaged: boolean
}): AutoStartSupport {
  if (input.platform !== 'win32') return { supported: false, reason: 'platform' }
  if (!input.isPackaged) return { supported: false, reason: 'dev' }
  return { supported: true }
}

/** 开关失败时的内联文案（ADR-0019 决策 14：回弹到真实状态 + 就地说明原因） */
export function autoStartFailureText(locale: string | undefined, detail?: string): string {
  const suffix = detail ? `（${detail}）` : ''
  return pickLocale(locale) === 'zh'
    ? `设置开机自启失败，已恢复为系统当前状态${suffix}`
    : `Failed to update launch-at-login; reverted to the current system state${detail ? ` (${detail})` : ''}`
}

/** 不支持时的说明文案（平台/开发版两种原因） */
export function autoStartUnsupportedText(
  locale: string | undefined,
  reason: 'platform' | 'dev' | undefined
): string {
  const zh = pickLocale(locale) === 'zh'
  if (reason === 'dev') {
    return zh
      ? '开发版不注册开机自启（注册项会指向开发目录里的 Electron，属于无效启动项）'
      : 'Launch at login is disabled in development builds (the entry would point at the dev Electron binary)'
  }
  return zh
    ? '当前平台不支持开机自启（与系统托盘一样仅 Windows）'
    : 'Launch at login is Windows-only (same scope as the system tray)'
}
