<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { registry } from '../core/registry'

const { t } = useI18n()

const props = defineProps<{
  activeNavId: string | null
}>()

/** 组件定义缓存：view id → 异步组件包装（避免每次 computed 新建导致 KeepAlive 缓存失效） */
const asyncCache = new Map<string, Component>()

const activeView = computed<Component | null>(() => {
  if (!props.activeNavId) return null
  const item = registry.navItems.find((i) => i.id === props.activeNavId && i.active)
  if (!item?.view) return null
  const component = registry.viewComponents.get(item.view)
  if (!component) return null
  // 注册表组件已 markRaw；用 defineAsyncComponent 包装以支持异步挂载，并缓存包装结果
  let wrapped = asyncCache.get(item.view)
  if (!wrapped) {
    wrapped = defineAsyncComponent(() => Promise.resolve(component))
    asyncCache.set(item.view, wrapped)
  }
  return wrapped
})
</script>

<template>
  <main class="content-area">
    <KeepAlive>
      <component
        :is="activeView"
        v-if="activeView"
        :key="activeNavId"
        :active-nav-id="activeNavId"
      />
    </KeepAlive>
    <div v-if="!activeView" class="content-empty">
      <p>{{ t('content.empty') }}</p>
    </div>
  </main>
</template>

<style scoped>
.content-area {
  flex: 1;
  overflow: auto;
  background: var(--bg, #1e1e1e);
  color: var(--fg, #cccccc);
}
.content-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-dim, #6e6e6e);
  font-size: 14px;
}
</style>
