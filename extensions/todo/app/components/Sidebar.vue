<script setup lang="ts">
/**
 * 左侧边栏：我的一天 / 全部待办 / 日历 + 标签区（增/改名/改色/删）。
 * 注意：iframe 无 allow-modals，禁用 alert/confirm/prompt，全部用行内 UI。
 */
import { computed, ref } from 'vue'
import { todoStore } from '../store'
import { TAG_COLORS } from '../types'
import { isOverdue, todayStr } from '../utils'
import type { View } from '../types'

const props = defineProps<{ view: View }>()
const emit = defineEmits<{ select: [view: View] }>()

// ---- 导航 ----
const navItems = [
  { key: 'my-day', label: '我的一天' },
  { key: 'all', label: '全部待办' },
  { key: 'calendar', label: '日历' }
] as const

function isNavActive(key: string): boolean {
  const v = props.view
  if (key === 'calendar') return v.kind === 'calendar' || v.kind === 'day'
  return v.kind === key
}

const myDayCount = computed(() => {
  const today = todayStr()
  return todoStore.todos.filter((t) => !t.completed && (t.dueDate === today || isOverdue(t))).length
})

function go(key: string): void {
  if (key === 'my-day') emit('select', { kind: 'my-day' })
  else if (key === 'all') emit('select', { kind: 'all' })
  else emit('select', { kind: 'calendar' })
}

// ---- 标签 ----
const adding = ref(false)
const newTagName = ref('')
const newTagColor = ref<string>(TAG_COLORS[0])
const renamingId = ref<string | null>(null)
const renameText = ref('')
const confirmDeleteId = ref<string | null>(null)

function startAdd(): void {
  adding.value = true
  newTagName.value = ''
  newTagColor.value = TAG_COLORS[todoStore.tags.length % TAG_COLORS.length]
}

function submitAdd(): void {
  if (newTagName.value.trim()) todoStore.addTag(newTagName.value, newTagColor.value)
  adding.value = false
}

function startRename(id: string): void {
  renamingId.value = id
  renameText.value = todoStore.tagById(id)?.name ?? ''
}

function submitRename(id: string): void {
  todoStore.renameTag(id, renameText.value)
  renamingId.value = null
}

function startDelete(id: string): void {
  confirmDeleteId.value = id
}

function confirmDelete(id: string): void {
  todoStore.deleteTag(id)
  confirmDeleteId.value = null
}

function selectTag(id: string): void {
  emit('select', { kind: 'tag', tagId: id })
}
</script>

<template>
  <aside class="sidebar">
    <nav class="nav">
      <button
        v-for="item in navItems"
        :key="item.key"
        class="nav-item"
        :class="{ active: isNavActive(item.key) }"
        @click="go(item.key)"
      >
        <svg
          v-if="item.key === 'my-day'"
          class="ico"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"
          />
        </svg>
        <svg
          v-else-if="item.key === 'all'"
          class="ico"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path d="M8 6h13M8 12h13M8 18h13" />
          <circle cx="3.5" cy="6" r="1" />
          <circle cx="3.5" cy="12" r="1" />
          <circle cx="3.5" cy="18" r="1" />
        </svg>
        <svg
          v-else
          class="ico"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M3 9h18M8 2v4M16 2v4" />
          <circle cx="9" cy="14" r="1" />
          <circle cx="15" cy="14" r="1" />
        </svg>
        <span class="label">{{ item.label }}</span>
        <span v-if="item.key === 'my-day'" class="count">{{ myDayCount }}</span>
      </button>
    </nav>

    <section class="tags-section">
      <div class="tags-header">
        <span class="tags-title">标签</span>
        <button class="icon-btn" title="新建标签" @click="startAdd">＋</button>
      </div>

      <!-- 新增标签行 -->
      <div v-if="adding" class="tag-row add-row">
        <span class="dot" :style="{ background: newTagColor }" />
        <input
          v-model="newTagName"
          class="tag-input"
          placeholder="标签名"
          @keydown.enter="submitAdd"
          @keydown.esc="adding = false"
        />
        <div class="swatches">
          <button
            v-for="c in TAG_COLORS"
            :key="c"
            class="swatch"
            :class="{ picked: newTagColor === c }"
            :style="{ background: c }"
            @click="newTagColor = c"
          />
        </div>
        <button class="mini-btn primary" @click="submitAdd">添加</button>
      </div>

      <!-- 标签列表 -->
      <div
        v-for="tag in todoStore.tags"
        :key="tag.id"
        class="tag-row"
        :class="{ active: view.kind === 'tag' && view.tagId === tag.id }"
      >
        <template v-if="renamingId === tag.id">
          <span class="dot" :style="{ background: tag.color }" />
          <input
            v-model="renameText"
            class="tag-input"
            @keydown.enter="submitRename(tag.id)"
            @keydown.esc="renamingId = null"
            @blur="submitRename(tag.id)"
          />
          <div class="swatches">
            <button
              v-for="c in TAG_COLORS"
              :key="c"
              class="swatch"
              :class="{ picked: tag.color === c }"
              :style="{ background: c }"
              @click="todoStore.recolorTag(tag.id, c)"
            />
          </div>
        </template>

        <template v-else-if="confirmDeleteId === tag.id">
          <span class="dot" :style="{ background: tag.color }" />
          <span class="tag-name">删除「{{ tag.name }}」？</span>
          <button class="mini-btn danger" @click="confirmDelete(tag.id)">删除</button>
          <button class="mini-btn" @click="confirmDeleteId = null">取消</button>
        </template>

        <template v-else>
          <span class="dot" :style="{ background: tag.color }" />
          <button class="tag-name" @click="selectTag(tag.id)">{{ tag.name }}</button>
          <span class="tag-count">{{
            todoStore.todos.filter((t) => t.tags.includes(tag.id) && !t.completed).length
          }}</span>
          <span class="row-actions">
            <button class="icon-btn sm" title="重命名" @click="startRename(tag.id)">✎</button>
            <button class="icon-btn sm danger" title="删除标签" @click="startDelete(tag.id)">
              ✕
            </button>
          </span>
        </template>
      </div>

      <div v-if="todoStore.tags.length === 0 && !adding" class="tags-empty">
        暂无标签，点 ＋ 新建
      </div>
    </section>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: #252526;
  border-right: 1px solid #333333;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 8px;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  color: #cccccc;
  padding: 7px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 3px;
  text-align: left;
}
.nav-item:hover {
  background: #2f2f2f;
}
.nav-item.active {
  background: #37373d;
  color: #ffffff;
}
.ico {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.label {
  flex: 1;
}
.count {
  font-size: 11px;
  color: #9d9d9d;
  background: #3c3c3c;
  border-radius: 8px;
  padding: 0 6px;
}
.tags-section {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tags-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
}
.tags-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #9d9d9d;
}
.icon-btn {
  background: transparent;
  border: none;
  color: #9d9d9d;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 3px;
  line-height: 1;
}
.icon-btn:hover {
  background: #3c3c3c;
  color: #ffffff;
}
.icon-btn.sm {
  font-size: 11px;
}
.icon-btn.danger:hover {
  color: #f48771;
}
.tag-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 3px;
  min-height: 26px;
}
.tag-row:hover {
  background: #2f2f2f;
}
.tag-row.active {
  background: #37373d;
}
.tag-row .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.tag-name {
  flex: 1;
  background: transparent;
  border: none;
  color: #cccccc;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  padding: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-name:hover {
  color: #ffffff;
}
.tag-count {
  font-size: 11px;
  color: #6e6e6e;
}
.row-actions {
  display: none;
  gap: 2px;
}
.tag-row:hover .row-actions {
  display: flex;
}
.tag-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  font-size: 12px;
}
.add-row {
  flex-wrap: wrap;
  background: #2f2f2f;
}
.swatches {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
}
.swatch {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid transparent;
  cursor: pointer;
  padding: 0;
}
.swatch.picked {
  border-color: #ffffff;
  box-shadow: 0 0 0 1px #007acc;
}
.mini-btn {
  background: #3c3c3c;
  border: 1px solid #454545;
  color: #cccccc;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  border-radius: 2px;
}
.mini-btn.primary {
  background: #0e639c;
  border-color: #1177bb;
  color: #ffffff;
}
.mini-btn.danger {
  background: #5a1d1d;
  border-color: #7a2a2a;
  color: #f48771;
}
.tags-empty {
  color: #6e6e6e;
  font-size: 12px;
  padding: 4px 8px;
}
</style>
