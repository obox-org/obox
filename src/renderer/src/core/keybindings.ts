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

/** 修饰键别名 → 规范名（与 `captureCombo` 产出的名字一致；`Cmd`/`Meta` 在事件侧也算 `Ctrl`） */
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  meta: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift'
}

/** 命名主键别名 → 规范名（与 `normalizeMainKey` 的表一致，另接受常见别名） */
const NAMED_KEY_ALIASES: Record<string, string> = {
  space: 'Space',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  esc: 'Esc',
  escape: 'Esc',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  delete: 'Delete',
  del: 'Delete',
  backspace: 'Backspace'
}

/**
 * 规范化组合键字符串：**空白 + 大小写 + 修饰键名**统一（issue #79）。
 *
 * 声明侧与事件侧都走这里，因此 `Ctrl+Shift+k`、`ctrl + shift + K`、`Ctrl+Shift+K` 视为同一绑定：
 * 匹配（`matchKeydown`）、改键冲突检测（`setKey`）与宿主注册期的重名告警（`host.ts`）都按归一结果比较。
 *
 * 边界（刻意如此，别顺手"再折一点"）：
 * - **单字符主键折成大写**（`k` → `K`）；这同时也让旧文档里"主键自动大写"的说法对声明侧成立。
 * - **只折叠上表列出的修饰键名与命名主键**。其余多字符 `e.key`（如 `F1`、`PageUp`、`Home`）由事件侧
 *   原样透传，这里不盲目 `toUpperCase()`——把 `PageUp` 折成 `PAGEUP` 反而会与事件侧失配。请按 `e.key`
 *   的规范写法声明（`F1`、`PageUp`）。
 * - **不重排修饰键顺序**：`Ctrl+Shift+P` 与 `Shift+Ctrl+P` 仍是两个不同绑定（沿用既有行为，事件侧固定
 *   产出 `Ctrl+Alt+Shift` 的顺序）。
 * - **不做 `Ctrl+k` 与 `Ctrl+Shift+K` 的等价折叠**：`Shift` 是组合里的独立一维，折叠大小写不等于忽略
 *   Shift（那会让"大小写敏感"的快捷键无法表达）；这里只折大小写，不折修饰键集合。
 */
export function normalizeKey(key: string): string {
  // 不按 `+` 过滤空段：`Ctrl++`（主键是 `+`）必须原样往返
  return key.split('+').map(normalizeKeyPart).join('+')
}

function normalizeKeyPart(raw: string): string {
  const part = raw.trim()
  if (!part) return ''
  const lower = part.toLowerCase()
  const modifier = MODIFIER_ALIASES[lower]
  if (modifier) return modifier
  if (part.length === 1) return part.toUpperCase()
  return NAMED_KEY_ALIASES[lower] ?? part
}

/** 主键规范化：'p' → 'P'（修饰键组合的主键统一大写） */
function normalizeMainKey(key: string): string {
  // 空格必须先判断：' ' 长度为 1，会被下面的单字符分支提前返回成 ' '，
  // 导致绑定 "Space" 的快捷键永远匹配不上（用户按空格得到的是 ' '）
  if (key === ' ') return 'Space'
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
