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

/**
 * 系统扩展的页面（`contributes.navItems[].page`）：磁盘扩展只能给 HTML，
 * 壳子用 iframe 加载它，地址走既有的 `app://extensions/<id>/<rest>`（系统根优先解析）。
 */
const activePage = computed<string | null>(() => {
  if (!props.activeNavId) return null
  const item = registry.navItems.find((i) => i.id === props.activeNavId && i.active)
  if (!item?.page || !item.extensionId) return null
  return `app://extensions/${encodeURIComponent(item.extensionId)}/${item.page}`
})

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
    <iframe
      v-if="activePage"
      :key="activePage"
      :src="activePage"
      class="content-page"
      title="extension page"
    />
    <KeepAlive>
      <component
        :is="activeView"
        v-if="activeView && !activePage"
        :key="activeNavId"
        :active-nav-id="activeNavId"
      />
    </KeepAlive>
    <div v-if="!activeView && !activePage" class="content-empty">
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
.content-page {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: var(--bg, #1e1e1e);
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
