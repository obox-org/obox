/**
 * 关闭行为纯逻辑的测试（ADR-0019）：偏好容错、决策矩阵、提示文案/按钮、勾选"记住"的语义。
 * 这些都是主进程侧必须**同步**正确的东西（关闭拦截走它），所以用矩阵式断言而不是抽样。
 */
import { describe, expect, it } from 'vitest'
import {
  applyClosePromptResult,
  buildAboutPrompt,
  buildClosePrompt,
  decideCloseAction,
  DEFAULT_CLOSE_BEHAVIOR,
  parseCloseBehavior,
  parseWindowBehavior,
  pickLocale,
  type CloseBehavior
} from '../src/main/windowBehaviorCore'

describe('偏好解析（坏文件不该拦住启动）', () => {
  it('合法三态原样返回', () => {
    expect(parseCloseBehavior('ask')).toBe('ask')
    expect(parseCloseBehavior('hide')).toBe('hide')
    expect(parseCloseBehavior('quit')).toBe('quit')
  })

  it('非法/缺失一律回落默认（询问）', () => {
    for (const bad of [undefined, null, '', 'HIDE', 'minimize', 0, {}, []]) {
      expect(parseCloseBehavior(bad)).toBe(DEFAULT_CLOSE_BEHAVIOR)
    }
  })

  it('parseWindowBehavior 容错非对象与缺字段', () => {
    expect(parseWindowBehavior({ closeBehavior: 'hide' })).toEqual({ closeBehavior: 'hide' })
    expect(parseWindowBehavior({ closeBehavior: 'nope' })).toEqual({ closeBehavior: 'ask' })
    expect(parseWindowBehavior(null)).toEqual({ closeBehavior: 'ask' })
    expect(parseWindowBehavior('x')).toEqual({ closeBehavior: 'ask' })
  })
})

describe('decideCloseAction 决策矩阵', () => {
  const behaviors: CloseBehavior[] = ['ask', 'hide', 'quit']

  it('已在退出流程 → 一律放行 quit（否则退不掉）', () => {
    for (const behavior of behaviors) {
      expect(decideCloseAction(behavior, { trayAvailable: true, quitting: true })).toBe('quit')
    }
  })

  it('没有托盘 → 保持旧行为（关窗即退出）', () => {
    for (const behavior of behaviors) {
      expect(decideCloseAction(behavior, { trayAvailable: false, quitting: false })).toBe('quit')
    }
  })

  it('有托盘：hide/quit 照做，ask 弹提示', () => {
    expect(decideCloseAction('hide', { trayAvailable: true, quitting: false })).toBe('hide')
    expect(decideCloseAction('quit', { trayAvailable: true, quitting: false })).toBe('quit')
    expect(decideCloseAction('ask', { trayAvailable: true, quitting: false })).toBe('ask')
  })
})

describe('pickLocale', () => {
  it('zh 开头 → zh，其余 → en', () => {
    expect(pickLocale('zh-CN')).toBe('zh')
    expect(pickLocale('ZH')).toBe('zh')
    expect(pickLocale('en-US')).toBe('en')
    expect(pickLocale(undefined)).toBe('en')
    expect(pickLocale('')).toBe('en')
  })
})

describe('buildClosePrompt', () => {
  it('中文：三个按钮 + 勾选框 + 取消/默认索引', () => {
    const p = buildClosePrompt('zh-CN', 'obox')
    expect(p.buttons).toEqual(['收进托盘', '退出', '取消'])
    expect(p.defaultId).toBe(0)
    expect(p.cancelId).toBe(2)
    expect(p.checkboxLabel).toBe('记住我的选择')
    expect(p.message).toContain('obox')
    expect(p.detail).toContain('托盘')
  })

  it('英文：同样三个按钮', () => {
    const p = buildClosePrompt('en-US', 'obox')
    expect(p.buttons).toEqual(['Hide to tray', 'Quit', 'Cancel'])
    expect(p.checkboxLabel).toBe('Remember my choice')
    expect(p.detail.toLowerCase()).toContain('tray')
  })

  it('应用名兜底为 obox', () => {
    expect(buildClosePrompt('en-US').message).toContain('obox')
  })
})

describe('applyClosePromptResult（勾选语义）', () => {
  it('未勾选 → 只本次生效，偏好不变', () => {
    expect(applyClosePromptResult({ response: 0, checkboxChecked: false }, 'ask')).toEqual({
      behavior: 'ask',
      next: 'hide',
      persist: false
    })
    expect(applyClosePromptResult({ response: 1, checkboxChecked: false }, 'ask')).toEqual({
      behavior: 'ask',
      next: 'quit',
      persist: false
    })
  })

  it('勾选 → 写入偏好（收进托盘 / 退出）', () => {
    expect(applyClosePromptResult({ response: 0, checkboxChecked: true }, 'ask')).toEqual({
      behavior: 'hide',
      next: 'hide',
      persist: true
    })
    expect(applyClosePromptResult({ response: 1, checkboxChecked: true }, 'quit')).toEqual({
      behavior: 'quit',
      next: 'quit',
      persist: true
    })
  })

  it('取消（含勾选）→ 什么都不做、不写偏好', () => {
    expect(applyClosePromptResult({ response: 2, checkboxChecked: true }, 'ask')).toEqual({
      behavior: 'ask',
      next: 'none',
      persist: false
    })
    expect(applyClosePromptResult({ response: 99, checkboxChecked: true }, 'ask')).toMatchObject({
      next: 'none',
      persist: false
    })
  })
})

describe('buildAboutPrompt', () => {
  it('显示名称+版本，并带 Electron/Chromium/Node', () => {
    const p = buildAboutPrompt('zh-CN', {
      appName: 'obox',
      version: '1.0.4',
      electron: '44.6.0',
      chrome: '140.0.0',
      node: '22.20.0'
    })
    expect(p.message).toBe('obox 1.0.4')
    expect(p.detail).toContain('Electron 44.6.0')
    expect(p.detail).toContain('Chromium 140.0.0')
    expect(p.detail).toContain('Node 22.20.0')
    expect(p.buttons).toEqual(['确定'])
  })

  it('缺失版本信息不炸（用占位）', () => {
    const p = buildAboutPrompt('en-US', { appName: 'obox', version: '1.0.4' })
    expect(p.buttons).toEqual(['OK'])
    expect(p.detail).toContain('Electron -')
  })
})
