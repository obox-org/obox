<script setup lang="ts">
/**
 * 内容栏待办列表：顶部快速添加 + 勾选完成 + 行内编辑（标题/备注/日期/优先级/标签）。
 * 全部待办视图带「显示已完成」开关（已完成置底灰显）。
 */
import { computed, ref } from 'vue'
import { todoStore } from '../store'
import { PRIORITY_LABEL, PRIORITY_ORDER } from '../types'
import { fmtDate, isOverdue, priorityClass, relDate, sortTodos } from '../utils'
import type { Priority, Todo } from '../types'

const props = defineProps<{
  title: string
  filter: (t: Todo) => boolean
  quickAddDueDate?: string | null
  quickAddTags?: string[]
  showCompletedToggle?: boolean
  emptyText?: string
}>()

const quickText = ref('')
const expandedId = ref<string | null>(null)
const showCompleted = ref(false)

const items = computed(() => sortTodos(todoStore.todos.filter(props.filter)))
const completedItems = computed(() =>
  sortTodos(todoStore.todos.filter((t) => t.completed && props.filter(t)))
)

function quickAdd(): void {
  const title = quickText.value.trim()
  if (!title) return
  todoStore.addTodo({
    title,
    dueDate: props.quickAddDueDate ?? null,
    tags: props.quickAddTags ?? []
  })
  quickText.value = ''
}

function toggleExpand(id: string): void {
  expandedId.value = expandedId.value === id ? null : id
}

function removeAndClose(id: string): void {
  todoStore.removeTodo(id)
  expandedId.value = null
}

// ---- 行内编辑（直接写入 store，实时保存） ----
function setTitle(id: string, e: Event): void {
  todoStore.updateTodo(id, { title: (e.target as HTMLInputElement).value })
}
function setNotes(id: string, e: Event): void {
  todoStore.updateTodo(id, { notes: (e.target as HTMLTextAreaElement).value })
}
function setDueDate(id: string, e: Event): void {
  const v = (e.target as HTMLInputElement).value
  todoStore.updateTodo(id, { dueDate: v || null })
}
function setPriority(id: string, e: Event): void {
  todoStore.updateTodo(id, { priority: (e.target as HTMLSelectElement).value as Priority })
}
function toggleTagOnTodo(id: string, tagId: string): void {
  const t = todoStore.todos.find((x) => x.id === id)
  if (!t) return
  const tags = t.tags.includes(tagId) ? t.tags.filter((x) => x !== tagId) : [...t.tags, tagId]
  todoStore.updateTodo(id, { tags })
}

const priorities = (Object.keys(PRIORITY_ORDER) as Priority[]).map((p) => ({
  value: p,
  label: PRIORITY_LABEL[p]
}))

const hint = computed(() => {
  const parts: string[] = []
  if (props.quickAddDueDate) parts.push(`日期：${fmtDate(props.quickAddDueDate)}`)
  if (props.quickAddTags?.length) {
    const names = props.quickAddTags.map((id) => todoStore.tagById(id)?.name).filter(Boolean)
    if (names.length) parts.push(`标签：${names.join('、')}`)
  }
  return parts.join('　')
})
</script>

<template>
  <div class="todo-list">
    <header class="list-header">
      <h2 class="list-title">{{ title }}</h2>
    </header>

    <!-- 快速添加 -->
    <div class="quick-add">
      <input
        v-model="quickText"
        class="quick-input"
        placeholder="添加待办，回车创建…"
        @keydown.enter="quickAdd"
      />
      <span v-if="hint" class="quick-hint">{{ hint }}</span>
    </div>

    <!-- 待办列表 -->
    <div class="items">
      <div v-for="t in items" :key="t.id" class="item" :class="{ expanded: expandedId === t.id }">
        <div class="item-row" @click="toggleExpand(t.id)">
          <button
            class="check"
            :class="{ done: t.completed }"
            title="完成"
            @click.stop="todoStore.toggleTodo(t.id)"
          >
            <svg
              v-if="t.completed"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            >
              <path d="m5 12 5 5 9-10" />
            </svg>
          </button>
          <span class="item-title" :class="{ done: t.completed }">{{ t.title }}</span>
          <span v-if="t.priority !== 'medium'" class="prio" :class="priorityClass(t.priority)">
            {{ PRIORITY_LABEL[t.priority] }}
          </span>
          <span v-if="t.dueDate" class="due" :class="{ overdue: isOverdue(t) }">{{
            relDate(t.dueDate)
          }}</span>
          <span
            v-for="tagId in t.tags"
            :key="tagId"
            class="tag-chip"
            :style="{ color: todoStore.tagById(tagId)?.color }"
          >
            {{ todoStore.tagById(tagId)?.name }}
          </span>
        </div>

        <!-- 行内编辑 -->
        <div v-if="expandedId === t.id" class="editor" @click.stop>
          <input
            :value="t.title"
            class="ed-title"
            placeholder="标题"
            @input="setTitle(t.id, $event)"
          />
          <textarea
            :value="t.notes"
            class="ed-notes"
            placeholder="备注（可选）"
            rows="2"
            @input="setNotes(t.id, $event)"
          />
          <div class="ed-row">
            <label
              >截止日期
              <input :value="t.dueDate ?? ''" type="date" @input="setDueDate(t.id, $event)" />
            </label>
            <label
              >优先级
              <select :value="t.priority" @change="setPriority(t.id, $event)">
                <option v-for="p in priorities" :key="p.value" :value="p.value">
                  {{ p.label }}
                </option>
              </select>
            </label>
          </div>
          <div class="ed-tags">
            <span class="ed-tags-label">标签</span>
            <label
              v-for="tag in todoStore.tags"
              :key="tag.id"
              class="ed-tag"
              :class="{ picked: t.tags.includes(tag.id) }"
            >
              <input
                type="checkbox"
                :checked="t.tags.includes(tag.id)"
                @change="toggleTagOnTodo(t.id, tag.id)"
              />
              <span class="dot" :style="{ background: tag.color }" />{{ tag.name }}
            </label>
            <span v-if="todoStore.tags.length === 0" class="ed-tags-empty"
              >暂无标签，可在左侧边栏新建</span
            >
          </div>
          <div class="ed-actions">
            <button class="mini danger" @click="removeAndClose(t.id)">删除</button>
            <button class="mini" @click="expandedId = null">完成</button>
          </div>
        </div>
      </div>

      <div v-if="items.length === 0" class="empty">{{ emptyText }}</div>
    </div>

    <!-- 已完成（全部待办视图） -->
    <div v-if="showCompletedToggle && completedItems.length" class="completed-section">
      <button class="completed-toggle" @click="showCompleted = !showCompleted">
        {{ showCompleted ? '▾' : '▸' }} 已完成（{{ completedItems.length }}）
      </button>
      <div v-if="showCompleted" class="items completed">
        <div v-for="t in completedItems" :key="t.id" class="item">
          <div class="item-row">
            <button class="check done" title="恢复" @click="todoStore.toggleTodo(t.id)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="m5 12 5 5 9-10" />
              </svg>
            </button>
            <span class="item-title done">{{ t.title }}</span>
            <span
              v-for="tagId in t.tags"
              :key="tagId"
              class="tag-chip"
              :style="{ color: todoStore.tagById(tagId)?.color }"
              >{{ todoStore.tagById(tagId)?.name }}</span
            >
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  gap: 12px;
  overflow: hidden;
}
.list-header {
  flex-shrink: 0;
}
.list-title {
  margin: 0;
  font-size: 18px;
  color: #e8e8e8;
  font-weight: 600;
}
.quick-add {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.quick-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 14px;
  background: #252526;
  border: 1px solid #454545;
  border-radius: 4px;
}
.quick-input:focus {
  border-color: #007acc;
}
.quick-hint {
  color: #6e6e6e;
  font-size: 11px;
  padding-left: 2px;
}
.items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.item {
  background: #252526;
  border: 1px solid transparent;
  border-radius: 4px;
}
.item:hover {
  border-color: #3c3c3c;
}
.item.expanded {
  border-color: #007acc;
}
.item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  min-height: 36px;
}
.check {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1.5px solid #6e6e6e;
  background: transparent;
  color: #1e1e1e;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.check:hover {
  border-color: #007acc;
}
.check.done {
  background: #0e639c;
  border-color: #0e639c;
  color: #ffffff;
}
.check svg {
  width: 12px;
  height: 12px;
}
.item-title {
  flex: 1;
  color: #e8e8e8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-title.done {
  color: #6e6e6e;
  text-decoration: line-through;
}
.prio {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.prio.prio-high {
  background: #5a1d1d;
  color: #f48771;
}
.prio.prio-low {
  background: #3c3c3c;
  color: #9d9d9d;
}
.due {
  font-size: 11px;
  color: #9d9d9d;
  flex-shrink: 0;
}
.due.overdue {
  color: #f48771;
}
.tag-chip {
  font-size: 11px;
  flex-shrink: 0;
}
.empty {
  color: #6e6e6e;
  padding: 24px;
  text-align: center;
}
.editor {
  border-top: 1px solid #333333;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ed-title {
  width: 100%;
}
.ed-notes {
  width: 100%;
  resize: vertical;
}
.ed-row {
  display: flex;
  gap: 16px;
  align-items: center;
}
.ed-row label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #9d9d9d;
  font-size: 12px;
}
.ed-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ed-tags-label {
  color: #9d9d9d;
  font-size: 12px;
}
.ed-tag {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #cccccc;
  cursor: pointer;
  padding: 2px 6px;
  border: 1px solid #3c3c3c;
  border-radius: 3px;
}
.ed-tag.picked {
  border-color: #007acc;
  background: #1f3a52;
}
.ed-tag input {
  display: none;
}
.ed-tag .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.ed-tags-empty {
  color: #6e6e6e;
  font-size: 11px;
}
.ed-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.mini {
  background: #3c3c3c;
  border: 1px solid #454545;
  color: #cccccc;
  font-size: 12px;
  padding: 4px 14px;
  cursor: pointer;
  border-radius: 2px;
}
.mini:hover {
  background: #454545;
}
.mini.danger {
  background: #5a1d1d;
  border-color: #7a2a2a;
  color: #f48771;
}
.completed-section {
  flex-shrink: 0;
  border-top: 1px solid #333333;
  padding-top: 8px;
}
.completed-toggle {
  background: transparent;
  border: none;
  color: #9d9d9d;
  font-size: 12px;
  cursor: pointer;
  padding: 4px 0;
}
.completed-toggle:hover {
  color: #cccccc;
}
.items.completed {
  flex: none;
  max-height: 40%;
  margin-top: 4px;
}
.items.completed .item-title {
  color: #6e6e6e;
}
</style>
