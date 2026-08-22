<script setup lang="ts">
/**
 * 待办子应用根组件：左侧边栏 + 内容栏。
 * 视图路由（简单状态机）：我的一天 / 全部待办 / 日历 / 标签筛选 / 某日待办。
 */
import { computed, ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import TodoList from './components/TodoList.vue'
import CalendarView from './components/CalendarView.vue'
import { todoStore } from './store'
import { fmtDateWeek, isOverdue, todayStr } from './utils'
import type { Todo, View } from './types'

const view = ref<View>({ kind: 'my-day' })

function selectView(v: View): void {
  view.value = v
}

/** 各视图的待办筛选（日历视图不在此列） */
const currentFilter = computed<((t: Todo) => boolean) | null>(() => {
  const v = view.value
  switch (v.kind) {
    case 'my-day': {
      const today = todayStr()
      return (t) => !t.completed && (t.dueDate === today || isOverdue(t))
    }
    case 'all':
      return (t) => !t.completed
    case 'tag':
      return (t) => !t.completed && t.tags.includes(v.tagId)
    case 'day':
      return (t) => t.dueDate === v.date
    default:
      return null
  }
})

const viewKey = computed(() => {
  const v = view.value
  if (v.kind === 'tag') return `tag-${v.tagId}`
  if (v.kind === 'day') return `day-${v.date}`
  return v.kind
})

const viewTitle = computed(() => {
  const v = view.value
  switch (v.kind) {
    case 'my-day':
      return '我的一天'
    case 'all':
      return '全部待办'
    case 'tag':
      return todoStore.tagById(v.tagId)?.name ?? '标签'
    case 'day':
      return fmtDateWeek(v.date)
    default:
      return ''
  }
})

const quickAdd = computed<{ dueDate: string | null; tags: string[] }>(() => {
  const v = view.value
  if (v.kind === 'my-day') return { dueDate: todayStr(), tags: [] }
  if (v.kind === 'tag') return { dueDate: null, tags: [v.tagId] }
  if (v.kind === 'day') return { dueDate: v.date, tags: [] }
  return { dueDate: null, tags: [] }
})

const emptyText = computed(() => {
  const v = view.value
  switch (v.kind) {
    case 'my-day':
      return '今天没有待办，享受一下 🎉'
    case 'all':
      return '没有待办，从上方输入框添加一条吧'
    case 'tag':
      return '这个标签下没有待办'
    case 'day':
      return '这一天没有待办'
    default:
      return ''
  }
})
</script>

<template>
  <div class="app">
    <Sidebar :view="view" @select="selectView" />
    <main class="content">
      <CalendarView
        v-if="view.kind === 'calendar'"
        @pick-day="(d: string) => selectView({ kind: 'day', date: d })"
      />
      <TodoList
        v-else-if="currentFilter"
        :key="viewKey"
        :title="viewTitle"
        :filter="currentFilter"
        :quick-add-due-date="quickAdd.dueDate"
        :quick-add-tags="quickAdd.tags"
        :show-completed-toggle="view.kind === 'all'"
        :empty-text="emptyText"
      />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100%;
  overflow: hidden;
}
.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #1e1e1e;
}
</style>
