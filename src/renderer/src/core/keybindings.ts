/**
 * 快捷键系统：内置快捷键注册表 + 修改 + 冲突检测 + 持久化。
 * 快捷键表示：组合键字符串（如 "Ctrl+Shift+P"），用 + 连接修饰键与主键。
 */
import { reactive } from 'vue'
import { stateStore } from './state'

export interface KeybindingEntry {
  /** 命令 id（如 app.showCommands） */
  command: string
  /** 命令显示名（设置页展示；用语言包 key 或直接字符串） */
  labelKey: string
  /** 默认快捷键（组合键字符串） */
  defaultKey: string
}

const KEYBINDING_SETTING_PREFIX = 'keybinding.'

class KeybindingStore {
  readonly entries = reactive<KeybindingEntry[]>([])

  register(entry: KeybindingEntry): void {
    this.entries.push(entry)
  }

  /** 当前生效的快捷键（用户修改优先，否则默认） */
  currentKey(command: string): string {
    const saved = stateStore.getSetting<string>(KEYBINDING_SETTING_PREFIX + command)
    const entry = this.entries.find((e) => e.command === command)
    if (saved) return saved
    return entry?.defaultKey ?? ''
  }

  /** 修改快捷键并持久化；返回冲突的命令（若有），null 表示无冲突 */
  setKey(
    command: string,
    key: string
  ): { conflict: string | null; conflictCommand: string | null } {
    // 冲突检测：同一按键被其他命令占用
    const normalized = normalizeKey(key)
    for (const entry of this.entries) {
      if (entry.command === command) continue
      if (normalizeKey(this.currentKey(entry.command)) === normalized) {
        return { conflict: key, conflictCommand: entry.command }
      }
    }
    stateStore.setSetting(KEYBINDING_SETTING_PREFIX + command, key)
    return { conflict: null, conflictCommand: null }
  }

  /** 重置某命令快捷键为默认 */
  reset(command: string): void {
    stateStore.setSetting(KEYBINDING_SETTING_PREFIX + command, undefined)
  }

  /** 按键事件 → 组合键字符串；匹配注册的快捷键并返回命令（若无匹配返回 null） */
  matchKeydown(e: KeyboardEvent): string | null {
    const combo = this.captureCombo(e)
    if (!combo) return null
    for (const entry of this.entries) {
      if (normalizeKey(this.currentKey(entry.command)) === combo) return entry.command
    }
    return null
  }

  /** 从按键事件提取组合键字符串（无修饰键且为修饰键本身时返回 null） */
  captureCombo(e: KeyboardEvent): string | null {
    const parts: string[] = []
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    const key = normalizeMainKey(e.key)
    // 只按了修饰键（Ctrl/Alt/Shift 本身）→ 无效组合
    if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return null
    if (!key) return null
    parts.push(key)
    return parts.join('+')
  }

  /** 供设置页展示：所有快捷键（命令 + 当前按键） */
  list(): Array<KeybindingEntry & { currentKey: string }> {
    return this.entries.map((e) => ({ ...e, currentKey: this.currentKey(e.command) }))
  }
}

/** 规范化按键字符串（大小写/空格统一） */
function normalizeKey(key: string): string {
  return key
    .trim()
    .replace(/\s*\+\s*/g, '+')
    .replace(/Ctrl\+/g, 'Ctrl+')
}

/** 主键规范化：'p' → 'P'（修饰键组合的主键统一大写） */
function normalizeMainKey(key: string): string {
  if (key.length === 1) return key.toUpperCase()
  const map: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
    Delete: 'Delete',
    Backspace: 'Backspace'
  }
  return map[key] ?? key
}

export const keybindingStore = new KeybindingStore()
