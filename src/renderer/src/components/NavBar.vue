<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { registry } from '../core/registry'
import { stateStore } from '../core/state'

const { t } = useI18n()

defineProps<{
  activeNavId: string | null
}>()

/** 导航项显示名：titleKey 存在时本地化，否则用 manifest title 原文 */
function navTitle(item: { title: string; titleKey?: string }): string {
  return item.titleKey ? t(item.titleKey) : item.title
}

const emit = defineEmits<{
  (e: 'select', id: string): void
}>()

/** 应用级持久化顺序（memento 命名空间 __app__） */
const persistedOrder = ref<string[] | null>(null)

const topItems = computed(() => {
  const items = registry.getNavItems('top')
  const order = persistedOrder.value
  if (!order) return items
  return [...items].sort((a, b) => {
    const ia = order.indexOf(a.id)
    const ib = order.indexOf(b.id)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })
})
const bottomItems = computed(() => registry.getNavItems('bottom'))

const dragId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)

function onDragStart(id: string, e: DragEvent): void {
  dragId.value = id
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(id: string, e: DragEvent): void {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  if (dragOverId.value !== id) dragOverId.value = id
}

function onDrop(targetId: string): void {
  const from = dragId.value
  const to = targetId
  dragId.value = null
  dragOverId.value = null
  if (!from || from === to) return
  const items = topItems.value
  const fromIdx = items.findIndex((i) => i.id === from)
  const toIdx = items.findIndex((i) => i.id === to)
  if (fromIdx < 0 || toIdx < 0) return
  // 持久化顺序到 memento（应用级命名空间）
  const ns = stateStore.memento('__app__')
  const current = persistedOrder.value ?? items.map((i) => i.id)
  const newOrder = [...current]
  newOrder.splice(fromIdx, 1)
  newOrder.splice(toIdx, 0, from)
  persistedOrder.value = newOrder
  void ns.update('navOrder', newOrder)
  // 重建注册表顺序：Vue reactive 数组直接重排
  const moved = registry.navItems.splice(fromIdx, 1)[0]
  registry.navItems.splice(toIdx, 0, moved)
}

// 初始加载持久化顺序
{
  const saved = stateStore.memento('__app__').get<string[]>('navOrder')
  if (saved?.length) persistedOrder.value = saved
}

function onDragEnd(): void {
  dragId.value = null
  dragOverId.value = null
}

function onClick(id: string): void {
  // toggle 语义：点击已激活项回到默认视图（扩展管理器）？此处简单选中
  emit('select', id)
}
</script>

<template>
  <nav class="navbar">
    <div class="navbar-group top" @dragover.prevent @drop.prevent>
      <div
        v-for="item in topItems"
        :key="item.id"
        class="nav-item"
        :class="{
          active: activeNavId === item.id,
          dragging: dragId === item.id,
          over: dragOverId === item.id
        }"
        draggable="true"
        :title="navTitle(item)"
        @dragstart="onDragStart(item.id, $event)"
        @dragover="onDragOver(item.id, $event)"
        @drop="onDrop(item.id)"
        @dragend="onDragEnd"
        @click="onClick(item.id)"
      >
        <span class="nav-icon" v-html="item.icon" />
        <span v-if="item.badgeCount" class="nav-badge">{{
          item.badgeCount > 999 ? '1K+' : item.badgeCount
        }}</span>
      </div>
    </div>
    <div class="navbar-group bottom">
      <div
        v-for="item in bottomItems"
        :key="item.id"
        class="nav-item"
        :class="{ active: activeNavId === item.id }"
        :title="navTitle(item)"
        @click="onClick(item.id)"
      >
        <span class="nav-icon" v-html="item.icon" />
        <span v-if="item.badgeCount" class="nav-badge">{{
          item.badgeCount > 999 ? '1K+' : item.badgeCount
        }}</span>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.navbar {
  width: 48px;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: var(--bg-sidebar, #333333);
  border-right: 1px solid var(--border, #252526);
  user-select: none;
}
.navbar-group {
  display: flex;
  flex-direction: column;
  padding-top: 4px;
}
.navbar-group.bottom {
  padding-top: 0;
  padding-bottom: 4px;
}
.nav-item {
  position: relative;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--nav-icon, #858585);
  outline: none;
}
.nav-item:hover {
  color: var(--fg, #cccccc);
  background: var(--hover-bg, rgba(255, 255, 255, 0.04));
}
.nav-item.active {
  color: var(--fg-bright, #ffffff);
}
.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent, #ffffff);
}
.nav-icon {
  display: flex;
  width: var(--nav-icon-size, 24px);
  height: var(--nav-icon-size, 24px);
}
.nav-icon :deep(svg) {
  width: var(--nav-icon-size, 24px);
  height: var(--nav-icon-size, 24px);
}
.nav-badge {
  position: absolute;
  top: 5px;
  right: 4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 20px;
  background: var(--accent, #007acc);
  color: var(--fg-bright, #ffffff);
  font-size: 9px;
  line-height: 16px;
  text-align: center;
  box-sizing: border-box;
}
.nav-item.dragging {
  opacity: 0.4;
}
.nav-item.over::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent, #007acc);
  top: 0;
}
</style>
