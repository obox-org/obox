/**
 * 快捷键系统单测（keybindingStore）。
 * 覆盖：默认值/用户修改优先级、冲突检测（不落盘）、重置、按键事件 → 组合键字符串与命令匹配。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { keybindingStore } from '../src/renderer/src/core/keybindings'

/** 构造最小 KeyboardEvent（只用到几个字段） */
function keydown(init: {
  key: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: !!init.ctrlKey,
    altKey: !!init.altKey,
    shiftKey: !!init.shiftKey,
    metaKey: !!init.metaKey
  } as KeyboardEvent
}

describe('keybindingStore · 取值与修改', () => {
  beforeEach(() => {
    keybindingStore.register({ command: 'kb-test.alpha', labelKey: 'a', defaultKey: 'Ctrl+Alt+A' })
  })

  it('未修改时返回默认键；修改后返回用户键；重置后回到默认', () => {
    expect(keybindingStore.currentKey('kb-test.alpha')).toBe('Ctrl+Alt+A')
    const r = keybindingStore.setKey('kb-test.alpha', 'Ctrl+Alt+K')
    expect(r.conflict).toBeNull()
    expect(keybindingStore.currentKey('kb-test.alpha')).toBe('Ctrl+Alt+K')
    keybindingStore.reset('kb-test.alpha')
    expect(keybindingStore.currentKey('kb-test.alpha')).toBe('Ctrl+Alt+A')
  })

  it('未注册命令 → 空字符串', () => {
    expect(keybindingStore.currentKey('kb-test.unknown')).toBe('')
  })

  it('冲突：与其他命令占用的按键相同（空白差异会规范化）→ 返回冲突命令且**不修改**', () => {
    keybindingStore.register({ command: 'kb-test.beta', labelKey: 'b', defaultKey: 'Ctrl+Alt+B' })
    const r = keybindingStore.setKey('kb-test.alpha', 'Ctrl + Alt + B')
    expect(r.conflictCommand).toBe('kb-test.beta')
    expect(keybindingStore.currentKey('kb-test.alpha')).toBe('Ctrl+Alt+A')
  })

  it('大小写差异当前**不**视为冲突（normalizeKey 只规范空白）——记录现状', () => {
    keybindingStore.register({
      command: 'kb-test.gamma',
      labelKey: 'g',
      defaultKey: 'Ctrl+Shift+G'
    })
    const r = keybindingStore.setKey('kb-test.gamma', 'ctrl+shift+g')
    expect(r.conflict).toBeNull()
    expect(keybindingStore.currentKey('kb-test.gamma')).toBe('ctrl+shift+g')
    keybindingStore.reset('kb-test.gamma')
  })
})

describe('keybindingStore · 按键事件', () => {
  it('captureCombo：修饰键 + 主键大写化；只按修饰键返回 null', () => {
    expect(keybindingStore.captureCombo(keydown({ key: 'p', ctrlKey: true, shiftKey: true }))).toBe(
      'Ctrl+Shift+P'
    )
    expect(keybindingStore.captureCombo(keydown({ key: 'Control', ctrlKey: true }))).toBeNull()
    expect(keybindingStore.captureCombo(keydown({ key: 'ArrowUp' }))).toBe('Up')
    expect(keybindingStore.captureCombo(keydown({ key: ' ' }))).toBe('Space')
  })

  it('matchKeydown 命中注册命令', () => {
    keybindingStore.register({ command: 'kb-match.do', labelKey: 'm', defaultKey: 'Ctrl+F1' })
    expect(keybindingStore.matchKeydown(keydown({ key: 'F1', ctrlKey: true }))).toBe('kb-match.do')
    expect(keybindingStore.matchKeydown(keydown({ key: 'F2', ctrlKey: true }))).not.toBe(
      'kb-match.do'
    )
  })

  it('list 返回命令 + 当前生效按键', () => {
    const rows = keybindingStore.list()
    expect(rows.some((r) => r.command === 'kb-test.alpha' && r.currentKey === 'Ctrl+Alt+A')).toBe(
      true
    )
  })
})
