<script setup lang="ts">
import { computed } from 'vue'
import { registry } from '../core/registry'

const props = defineProps<{
  activeNavId: string | null
}>()

const leftItems = computed(() => registry.getVisibleStatusBarItems('left'))
const rightItems = computed(() => registry.getVisibleStatusBarItems('right'))

const activeTitle = computed(() => {
  const item = registry.navItems.find((i) => i.id === props.activeNavId)
  return item?.title ?? ''
})

async function onItemClick(command?: string): Promise<void> {
  if (!command) return
  const cmd = registry.commands.find((c) => c.command === command)
  if (cmd?.handler) await cmd.handler()
}
</script>

<template>
  <footer class="statusbar">
    <div class="statusbar-left">
      <span class="status-item">{{ activeTitle }}</span>
      <span
        v-for="item in leftItems"
        :key="item.id"
        class="status-item clickable"
        :title="item.tooltip ?? item.name"
        @click="onItemClick(item.command)"
        v-html="item.text"
      />
    </div>
    <div class="statusbar-right">
      <span
        v-for="item in rightItems"
        :key="item.id"
        class="status-item clickable"
        :title="item.tooltip ?? item.name"
        @click="onItemClick(item.command)"
        v-html="item.text"
      />
      <span class="status-item version">Obox</span>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  height: 22px;
  display: flex;
  align-items: center;
  background: #007acc;
  color: #ffffff;
  font-size: 12px;
  user-select: none;
  flex-shrink: 0;
}
.statusbar-left {
  flex: 1;
  display: flex;
  align-items: center;
  overflow: hidden;
}
.statusbar-right {
  display: flex;
  flex-direction: row-reverse;
  align-items: center;
  flex-wrap: wrap;
  max-width: 50%;
}
.status-item {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  height: 22px;
  line-height: 22px;
  white-space: nowrap;
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status-item.clickable:hover {
  background: rgba(255, 255, 255, 0.12);
}
</style>
