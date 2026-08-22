/** 待办领域类型（与宿主无关，纯子应用内部模型） */

export type Priority = 'high' | 'medium' | 'low'

export interface Todo {
  id: string
  title: string
  notes: string
  completed: boolean
  /** 截止日期，'YYYY-MM-DD'（仅日期粒度） */
  dueDate: string | null
  priority: Priority
  /** 标签 id 列表（多对多） */
  tags: string[]
  createdAt: number
  completedAt: number | null
}

export interface Tag {
  id: string
  name: string
  color: string
  createdAt: number
}

/** 内容栏视图：我的一天 / 全部待办 / 日历 / 标签筛选 / 某日 */
export type View =
  | { kind: 'my-day' }
  | { kind: 'all' }
  | { kind: 'calendar' }
  | { kind: 'tag'; tagId: string }
  | { kind: 'day'; date: string }

export const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 }
export const PRIORITY_LABEL: Record<Priority, string> = { high: '高', medium: '中', low: '低' }

export const TAG_COLORS = [
  '#4ec9b0',
  '#569cd6',
  '#c586c0',
  '#dcdcaa',
  '#ce9178',
  '#6a9955',
  '#9cdcfe',
  '#f48771'
] as const
