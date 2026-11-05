<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { registry } from '../core/registry'
import { runHostQuery, toSerializable } from '../core/hostQuery'
import { hostQueryDeps } from '../core/hostQueryDeps'
import { themeStore } from '../core/theme'

const { t } = useI18n()

const props = defineProps<{
  activeNavId: string | null
}>()

const pageRef = ref<HTMLIFrameElement | null>(null)

/**
 * 系统扩展页面的桥：页面 `postMessage({type:'obox:page-call', id, op, args})` →
 * 这里用**渲染侧真实状态**执行 `runHostQuery(op, args)` → 回 `{type:'obox:page-reply', id, ok, ...}`。
 *
 * 为什么由壳子回答而不是走宿主：扩展表/卡片表/主题等真相都在渲染进程；页面与壳子同进程，
 * 直接复用宿主扩展也在用的同一批 op（`hostQueryDeps`），语义不会分叉。
 */
async function onPageMessage(event: MessageEvent): Promise<void> {
  const frame = pageRef.value
  if (!frame || event.source !== frame.contentWindow) return
  const data = event.data as { type?: string; id?: number; op?: string; args?: unknown } | null
  if (!data || data.type !== 'obox:page-call' || typeof data.op !== 'string') return
  const reply = (payload: Record<string, unknown>): void => {
    frame.contentWindow?.postMessage(payload, '*')
  }
  try {
    const result = await runHostQuery(data.op, data.args, hostQueryDeps())
    reply({ type: 'obox:page-reply', id: data.id, ok: true, result: toSerializable(result) })
  } catch (error) {
    reply({
      type: 'obox:page-reply',
      id: data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** iframe 加载完成后下发主题 token（CSS 变量不跨文档，必须显式推） */
function onPageLoad(): void {
  pageRef.value?.contentWindow?.postMessage(
    { type: 'obox-theme', tokens: themeStore.currentTokens },
    '*'
  )
}

/**
 * 更新事件转发（`update:event`）：下载进度只存在于渲染进程的 main 事件里，
 * 系统扩展的更新分区要显示百分比，就必须把事件推给它的 iframe。
 */
let offUpdateEvent: (() => void) | undefined

onMounted(() => {
  window.addEventListener('message', onPageMessage)
  offUpdateEvent = window.events.on('update:event', (event) => {
    pageRef.value?.contentWindow?.postMessage({ type: 'obox-update-event', event }, '*')
  })
})
onUnmounted(() => {
  window.removeEventListener('message', onPageMessage)
  offUpdateEvent?.()
})

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
      ref="pageRef"
      :key="activePage"
      :src="activePage"
      class="content-page"
      title="extension page"
      @load="onPageLoad"
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
