/**
 * 待办数据存储：reactive 状态 + localStorage 持久化。
 * 运行于 App 子窗口 iframe（app://extensions/<id>/ 同源），
 * localStorage 按该源持久化；写入失败时降级为内存态（不阻塞使用）。
 */
import { reactive } from 'vue'
import type { Priority, Tag, Todo } from './types'
import { TAG_COLORS } from './types'
import { uid } from './utils'

const STORAGE_KEY = 'obox:todo:v1'

interface Persisted {
  todos: Todo[]
  tags: Tag[]
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>
      return {
        todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        tags: Array.isArray(parsed.tags) ? parsed.tags : []
      }
    }
  } catch (err) {
    console.error('[todo] 读取存储失败', err)
  }
  return { todos: [], tags: [] }
}

const state = reactive<Persisted>(load())

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ todos: state.todos, tags: state.tags }))
  } catch (err) {
    console.error('[todo] 写入存储失败', err)
  }
}

export interface NewTodoInput {
  title: string
  notes?: string
  dueDate?: string | null
  priority?: Priority
  tags?: string[]
}

export const todoStore = {
  todos: state.todos,
  tags: state.tags,

  // ---- 待办 ----

  addTodo(input: NewTodoInput): Todo {
    const todo: Todo = {
      id: uid(),
      title: input.title.trim(),
      notes: input.notes?.trim() ?? '',
      completed: false,
      dueDate: input.dueDate ?? null,
      priority: input.priority ?? 'medium',
      tags: input.tags ?? [],
      createdAt: Date.now(),
      completedAt: null
    }
    state.todos.unshift(todo)
    save()
    return todo
  },

  updateTodo(id: string, patch: Partial<Omit<Todo, 'id'>>): void {
    const t = state.todos.find((x) => x.id === id)
    if (!t) return
    Object.assign(t, patch)
    save()
  },

  toggleTodo(id: string): void {
    const t = state.todos.find((x) => x.id === id)
    if (!t) return
    t.completed = !t.completed
    t.completedAt = t.completed ? Date.now() : null
    save()
  },

  removeTodo(id: string): void {
    const i = state.todos.findIndex((x) => x.id === id)
    if (i >= 0) {
      state.todos.splice(i, 1)
      save()
    }
  },

  // ---- 标签 ----

  addTag(name: string, color?: string): Tag {
    const tag: Tag = {
      id: uid(),
      name: name.trim(),
      color: color ?? TAG_COLORS[state.tags.length % TAG_COLORS.length],
      createdAt: Date.now()
    }
    state.tags.push(tag)
    save()
    return tag
  },

  renameTag(id: string, name: string): void {
    const t = state.tags.find((x) => x.id === id)
    if (!t) return
    t.name = name.trim() || t.name
    save()
  },

  recolorTag(id: string, color: string): void {
    const t = state.tags.find((x) => x.id === id)
    if (!t) return
    t.color = color
    save()
  },

  /** 删除标签：待办保留，仅清除引用 */
  deleteTag(id: string): void {
    const i = state.tags.findIndex((x) => x.id === id)
    if (i < 0) return
    state.tags.splice(i, 1)
    for (const t of state.todos) {
      if (t.tags.includes(id)) t.tags = t.tags.filter((x) => x !== id)
    }
    save()
  },

  tagById(id: string): Tag | undefined {
    return state.tags.find((x) => x.id === id)
  }
}
