/** 日期/排序工具（纯函数） */
import type { Priority, Todo } from './types'
import { PRIORITY_ORDER } from './types'

/** 本地日期 → 'YYYY-MM-DD' */
export function toDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayStr(): string {
  return toDateStr(new Date())
}

/** 'YYYY-MM-DD' → 可读 'M月D日'（跨年带年份） */
export function fmtDate(s: string): string {
  const [y, m, d] = s.split('-')
  const now = new Date()
  const prefix = Number(y) === now.getFullYear() ? '' : `${y}年`
  return `${prefix}${Number(m)}月${Number(d)}日`
}

/** 'YYYY-MM-DD' → 'M月D日 周X' */
export function fmtDateWeek(s: string): string {
  const [y, m, d] = s.split('-').map(Number)
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()]
  return `${fmtDate(s)} 周${week}`
}

/** 相对今天：'今天' / '明天' / '昨天' / 其他回退 fmtDate */
export function relDate(s: string): string {
  const today = todayStr()
  const toNum = (x: string): number => new Date(x + 'T00:00:00').getTime()
  const diff = Math.round((toNum(s) - toNum(today)) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  return fmtDate(s)
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 未完成且已逾期（截止日期早于今天） */
export function isOverdue(t: Todo): boolean {
  return !t.completed && t.dueDate !== null && t.dueDate < todayStr()
}

/** 排序：优先级高→低，其次截止日期近→远（无日期靠后），再按创建时间 */
export function sortTodos(list: Todo[]): Todo[] {
  return [...list].sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    if (p !== 0) return p
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
    if (a.dueDate && !b.dueDate) return -1
    if (!a.dueDate && b.dueDate) return 1
    return a.createdAt - b.createdAt
  })
}

export function priorityClass(p: Priority): string {
  return `prio-${p}`
}
