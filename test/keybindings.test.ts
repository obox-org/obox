/**
 * 快捷键系统单测（keybindingStore + normalizeKey）。
 * 覆盖：默认值/用户修改优先级、冲突检测（不落盘；含 issue #79 的大小写/修饰键名归一）、重置、
 * 按键事件 → 组合键字符串与命令匹配。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { keybindingStore, normalizeKey } from '../src/renderer/src/core/keybindings'

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

  // issue #79：以前 normalizeKey 只规范空白，`ctrl+shift+g` 与 `Ctrl+Shift+G` 不算冲突、
  // 也永远匹配不上——静默失效。现在两侧都按归一后的组合键比较。
  it('大小写差异视为冲突：declaration 侧归一后与事件侧同一绑定', () => {
    keybindingStore.register({
      command: 'kb-test.gamma',
      labelKey: 'g',
      defaultKey: 'Ctrl+Shift+G'
    })
    keybindingStore.register({
      command: 'kb-test.delta',
      labelKey: 'd',
      defaultKey: 'Ctrl+Shift+D'
    })
    // 换个命令写小写 k：归一后与 gamma 相同 → 冲突且**不修改**
    const conflict = keybindingStore.setKey('kb-test.delta', 'ctrl+shift+g')
    expect(conflict.conflictCommand).toBe('kb-test.gamma')
    expect(keybindingStore.currentKey('kb-test.delta')).toBe('Ctrl+Shift+D')
    // 写自己当前的键（仅大小写不同）不算自冲突 → 落盘，且 keydown 能命中
    const self = keybindingStore.setKey('kb-test.delta', 'ctRl + shIft + d')
    expect(self.conflictCommand).toBeNull()
    expect(keybindingStore.currentKey('kb-test.delta')).toBe('ctRl + shIft + d')
    expect(keybindingStore.matchKeydown(keydown({ key: 'd', ctrlKey: true, shiftKey: true }))).toBe(
      'kb-test.delta'
    )
    keybindingStore.reset('kb-test.delta')
  })

  it('归一后确实能命中：小写声明 / 别名主键 / 别名修饰键都能匹配 keydown', () => {
    keybindingStore.register({ command: 'kb-fold.k', labelKey: 'k', defaultKey: 'ctrl+shift+k' })
    keybindingStore.register({
      command: 'kb-fold.esc',
      labelKey: 'e',
      defaultKey: 'Control+escape'
    })
    keybindingStore.register({
      command: 'kb-fold.subject',
      labelKey: 's',
      defaultKey: 'CMD+arrowup'
    })
    expect(keybindingStore.matchKeydown(keydown({ key: 'K', ctrlKey: true, shiftKey: true }))).toBe(
      'kb-fold.k'
    )
    expect(keybindingStore.matchKeydown(keydown({ key: 'Escape', ctrlKey: true }))).toBe(
      'kb-fold.esc'
    )
    expect(keybindingStore.matchKeydown(keydown({ key: 'ArrowUp', metaKey: true }))).toBe(
      'kb-fold.subject'
    )
  })
})

describe('normalizeKey（issue #79）', () => {
  it('大小写折叠 + 修饰键名归一 + 空白规范', () => {
    expect(normalizeKey('ctrl+shift+k')).toBe('Ctrl+Shift+K')
    expect(normalizeKey('Ctrl + Shift + K')).toBe('Ctrl+Shift+K')
    expect(normalizeKey('CTRL+ALT+K')).toBe('Ctrl+Alt+K')
    expect(normalizeKey('Control+Option+Escape')).toBe('Ctrl+Alt+Esc')
    expect(normalizeKey('CMD+arrowup')).toBe('Ctrl+Up')
    expect(normalizeKey('')).toBe('')
  })

  it('不重排修饰键顺序、不折 Shift 语义：只折大小写', () => {
    expect(normalizeKey('Shift+Ctrl+P')).toBe('Shift+Ctrl+P')
    expect(normalizeKey('Shift+Ctrl+P')).not.toBe(normalizeKey('Ctrl+Shift+P'))
    // `Ctrl+k` 与 `Ctrl+Shift+K` 仍是两个绑定（Shift 是组合里的独立一维）
    expect(normalizeKey('Ctrl+k')).not.toBe(normalizeKey('Ctrl+Shift+K'))
  })

  it('表外的多字符主键原样保留（不盲目大写，避免 PageUp/PAGEUP 失配）', () => {
    expect(normalizeKey('Ctrl+PageUp')).toBe('Ctrl+PageUp')
    expect(normalizeKey('Ctrl+pageup')).toBe('Ctrl+pageup')
    expect(normalizeKey('Ctrl+F1')).toBe('Ctrl+F1')
  })

  it('主键是 `+` 时原样往返（不因空段被吃掉）', () => {
    expect(normalizeKey('Ctrl++')).toBe('Ctrl++')
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

/**
 * 捕获态（issue #85）：设置页"编辑"改键期间，全局快捷键一律不得触发。
 * 这是"快捷键不支持配置"的第二个叠加原因——捕获框没焦点，即使有焦点也会先被
 * 全局 keydown 处理器抢走按键。
 */
describe('keybindingStore · 捕获态守卫（issue #85）', () => {
  it('默认不在捕获态', () => {
    keybindingStore.setCapturing(false)
    expect(keybindingStore.isCapturing).toBe(false)
  })

  it('捕获态下 matchKeydown 不返回任何命令（已注册的命中键也不返回）', () => {
    keybindingStore.register({
      command: 'kb-cap.palette',
      labelKey: 'p',
      defaultKey: 'Ctrl+Shift+P'
    })
    keybindingStore.setCapturing(false)
    expect(keybindingStore.matchKeydown(keydown({ key: 'P', ctrlKey: true, shiftKey: true }))).toBe(
      'kb-cap.palette'
    )
    keybindingStore.setCapturing(true)
    expect(keybindingStore.matchKeydown(keydown({ key: 'P', ctrlKey: true, shiftKey: true }))).toBe(
      null
    )
    keybindingStore.setCapturing(false)
    expect(keybindingStore.matchKeydown(keydown({ key: 'P', ctrlKey: true, shiftKey: true }))).toBe(
      'kb-cap.palette'
    )
  })

  it('捕获态不影响 captureCombo（捕获框仍要能把按键转成组合键）与 setKey', () => {
    keybindingStore.register({ command: 'kb-cap.combo', labelKey: 'c', defaultKey: 'Ctrl+Alt+C' })
    keybindingStore.setCapturing(true)
    const combo = keybindingStore.captureCombo(keydown({ key: 'j', ctrlKey: true, altKey: true }))
    expect(combo).toBe('Ctrl+Alt+J')
    expect(keybindingStore.setKey('kb-cap.combo', combo as string).conflict).toBeNull()
    expect(keybindingStore.currentKey('kb-cap.combo')).toBe('Ctrl+Alt+J')
    keybindingStore.reset('kb-cap.combo')
    keybindingStore.setCapturing(false)
  })
})
