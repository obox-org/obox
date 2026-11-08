/**
 * 主进程语言跟随设置（change `unified-page-context` 任务 5.3）。
 *
 * 覆盖判据：
 * - `getMainLocale()` 在渲染侧推送前回退系统语言（zh/en 归一）；
 * - `applyMainLocale()` 只在合法值上生效，并如实报告 changed（托盘据此决定是否重建）；
 * - 系统中文 + 设置英文 ⇒ 托盘菜单/关窗提示/关于对话框输出英文（纯函数侧）；
 * - 源码门禁：托盘与关窗/关于不再直接读 `app.getLocale()`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

vi.mock('electron', () => ({
  app: { getLocale: (): string => 'zh-CN' },
  ipcMain: { handle: (): void => undefined }
}))

import { applyMainLocale, getMainLocale, resetMainLocale } from '../src/main/locale'
import { trayMenuItems, trayTooltip } from '../src/main/trayCore'
import { buildAboutPrompt, buildClosePrompt } from '../src/main/windowBehaviorCore'

beforeEach(() => {
  resetMainLocale()
})
afterEach(() => {
  resetMainLocale()
})

function repoFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
}

describe('getMainLocale / applyMainLocale', () => {
  it('未推送时回退系统语言（zh-CN → zh）', () => {
    expect(getMainLocale()).toBe('zh')
  })

  it('推送 en：生效并报告 changed', () => {
    expect(applyMainLocale('en')).toEqual({ locale: 'en', changed: true })
    expect(getMainLocale()).toBe('en')
  })

  it('重复推送同一语言：不再报告 changed（避免无意义重建托盘）', () => {
    applyMainLocale('en')
    expect(applyMainLocale('en')).toEqual({ locale: 'en', changed: false })
  })

  it('非法值保持当前语言', () => {
    applyMainLocale('en')
    expect(applyMainLocale('fr')).toEqual({ locale: 'en', changed: false })
    expect(applyMainLocale(undefined)).toEqual({ locale: 'en', changed: false })
  })
})

describe('系统中文 + 应用英文 ⇒ 主进程文案为英文', () => {
  it('托盘菜单与 tooltip', () => {
    applyMainLocale('en')
    const labels = trayMenuItems(getMainLocale())
      .map((i) => i.label)
      .filter((label) => label !== undefined)
    expect(labels).toEqual(['Open', 'Settings', 'About', 'Quit'])
    expect(trayTooltip('obox', '2.3.0', getMainLocale())).toContain('Double-click to open')
  })

  it('关窗提示与关于对话框', () => {
    applyMainLocale('en')
    const prompt = buildClosePrompt(getMainLocale(), 'obox')
    expect(prompt.buttons.join(' ')).toMatch(/Quit|Hide|Cancel/i)
    expect(prompt.message).toMatch(/close|quit/i)
    const about = buildAboutPrompt(getMainLocale(), {
      appName: 'obox',
      version: '2.3.0',
      electron: '44.0.0',
      chrome: '140',
      node: '22'
    })
    expect(about.detail).toContain('Electron')
    expect(about.message).not.toContain('关于')
  })

  it('切回 zh：恢复中文文案', () => {
    applyMainLocale('en')
    applyMainLocale('zh')
    expect(
      trayMenuItems(getMainLocale())
        .map((i) => i.label)
        .filter((label) => label !== undefined)
    ).toEqual(['打开', '设置', '关于', '退出'])
    expect(buildClosePrompt(getMainLocale(), 'obox').message).toContain('退出')
  })
})

describe('源码门禁：主进程不再直接读 app.getLocale()', () => {
  it('tray.ts / windowBehavior.ts 走 getMainLocale()', () => {
    const tray = repoFile('src/main/tray.ts')
    expect(tray).toContain('getMainLocale')
    expect(tray).not.toContain('app.getLocale()')

    const behavior = repoFile('src/main/windowBehavior.ts')
    expect(behavior).toContain('getMainLocale')
    expect(behavior).not.toContain('app.getLocale()')
  })

  it('index.ts 注册 locale:apply 并接到托盘刷新', () => {
    const index = repoFile('src/main/index.ts')
    expect(index).toContain('registerLocaleIpc')
    expect(index).toContain('refreshTrayLocale')
  })
})
