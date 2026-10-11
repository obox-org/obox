/**
 * 开机自启纯逻辑的测试（ADR-0019 决策 12–14）：启动参数识别、登录项设置构造、真实状态归并、支持判定、文案。
 * 这些是主进程必须同步正确的东西（注册表读写 + 开关回弹的判定都基于它们）。
 */
import { describe, expect, it } from 'vitest'
import {
  AUTOSTART_ARG,
  autoStartFailureText,
  autoStartUnsupportedText,
  buildLoginItemSettings,
  findLoginItem,
  isAutostartLaunch,
  LOGIN_ITEM_NAME,
  loginItemQuery,
  resolveAutoStartEnabled,
  resolveAutoStartSupport
} from '../src/main/autoStartCore'

describe('isAutostartLaunch', () => {
  it('识别 --autostart（Electron 44 无 Windows 侧"由登录项启动"API，只能靠自己的参数）', () => {
    expect(isAutostartLaunch(['.', AUTOSTART_ARG])).toBe(true)
    expect(isAutostartLaunch(['.', '--debug-extension', 'x@y'])).toBe(false)
    expect(isAutostartLaunch([])).toBe(false)
  })

  it('不把包含该串的值当作命中（精确匹配）', () => {
    expect(isAutostartLaunch(['.', '--autostart=1'])).toBe(false)
  })
})

describe('buildLoginItemSettings', () => {
  it('启用：写 Run 项 + 带上静默参数 + 名称固定 + 顺带启用任务管理器里的开关', () => {
    expect(buildLoginItemSettings(true, 'C:\\app\\obox.exe')).toEqual({
      openAtLogin: true,
      path: 'C:\\app\\obox.exe',
      args: [AUTOSTART_ARG],
      name: LOGIN_ITEM_NAME,
      enabled: true
    })
  })

  it('停用：openAtLogin=false（删除 Run 项），不带 enabled', () => {
    const settings = buildLoginItemSettings(false, 'C:\\app\\obox.exe')
    expect(settings.openAtLogin).toBe(false)
    expect('enabled' in settings).toBe(false)
    expect(settings.args).toEqual([AUTOSTART_ARG])
  })

  it('读取用的比对参数与写入一致（否则 getLoginItemSettings 的 openAtLogin 不准）', () => {
    const write = buildLoginItemSettings(true, 'C:\\app\\obox.exe')
    const query = loginItemQuery('C:\\app\\obox.exe')
    expect(query.path).toBe(write.path)
    expect(query.args).toEqual(write.args)
  })
})

describe('resolveAutoStartEnabled（系统真实状态归并）', () => {
  it('没有启动项 → false', () => {
    expect(resolveAutoStartEnabled({ openAtLogin: false, launchItemEnabled: true })).toBe(false)
  })

  it('有启动项且任务管理器启用 → true', () => {
    expect(resolveAutoStartEnabled({ openAtLogin: true, launchItemEnabled: true })).toBe(true)
  })

  it('有启动项但被任务管理器禁用 → false（Run 值仍在，这就是"开关显示不准"的来源）', () => {
    expect(resolveAutoStartEnabled({ openAtLogin: true, launchItemEnabled: false })).toBe(false)
  })

  it('读不到 launchItems（平台差异）→ 退回 openAtLogin', () => {
    expect(resolveAutoStartEnabled({ openAtLogin: true })).toBe(true)
  })
})

describe('findLoginItem', () => {
  it('按值名匹配（默认值名 = AppUserModelId）', () => {
    const items = [
      { name: 'OneDrive', enabled: true },
      { name: LOGIN_ITEM_NAME, enabled: false }
    ]
    expect(findLoginItem(items)?.enabled).toBe(false)
    expect(findLoginItem([{ name: 'other', enabled: true }])).toBeUndefined()
    expect(findLoginItem(undefined)).toBeUndefined()
  })
})

describe('resolveAutoStartSupport', () => {
  it('仅 Windows 且非开发版可配置', () => {
    expect(resolveAutoStartSupport({ platform: 'win32', isPackaged: true })).toEqual({
      supported: true
    })
    expect(resolveAutoStartSupport({ platform: 'win32', isPackaged: false })).toEqual({
      supported: false,
      reason: 'dev'
    })
    expect(resolveAutoStartSupport({ platform: 'darwin', isPackaged: true })).toEqual({
      supported: false,
      reason: 'platform'
    })
    expect(resolveAutoStartSupport({ platform: 'linux', isPackaged: true })).toEqual({
      supported: false,
      reason: 'platform'
    })
  })
})

describe('文案', () => {
  it('失败文案含原因，中英各一份', () => {
    expect(autoStartFailureText('zh-CN', '拒绝访问')).toContain('设置开机自启失败')
    expect(autoStartFailureText('zh-CN', '拒绝访问')).toContain('拒绝访问')
    expect(autoStartFailureText('en-US')).toContain('Failed to update launch-at-login')
  })

  it('不支持文案区分开发版与平台', () => {
    expect(autoStartUnsupportedText('zh-CN', 'dev')).toContain('开发版')
    expect(autoStartUnsupportedText('zh-CN', 'platform')).toContain('仅 Windows')
    expect(autoStartUnsupportedText('en-US', 'dev')).toContain('development')
  })
})
