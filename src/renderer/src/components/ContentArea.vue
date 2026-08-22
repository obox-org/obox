<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import type { Component } from 'vue'
import { registry } from '../core/registry'

const props = defineProps<{
  activeNavId: string | null
}>()

const activeView = computed<Component | null>(() => {
  if (!props.activeNavId) return null
  const item = registry.navItems.find((i) => i.id === props.activeNavId && i.active)
  if (!item?.view) return null
  const component = registry.viewComponents.get(item.view)
  if (!component) return null
  // 注册表组件已 markRaw；用 defineAsyncComponent 包装以支持异步挂载
  return defineAsyncComponent(() => Promise.resolve(component))
})
</script>

<template>
  <main class="content-area">
    <KeepAlive>
      <component :is="activeView" v-if="activeView" :key="activeNavId" />
    </KeepAlive>
    <div v-if="!activeView" class="content-empty">
      <p>选择一个导航项开始</p>
    </div>
  </main>
</template>

<style scoped>
.content-area {
  flex: 1;
  overflow: auto;
  background: #1e1e1e;
  color: #cccccc;
}
.content-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6e6e6e;
  font-size: 14px;
}
</style>
