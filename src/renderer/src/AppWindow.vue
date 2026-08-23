<script setup lang="ts">
/**
 * App 子窗口：复用 TitleBar（标题=插件名）+ 内容栏 iframe。
 * 渲染插件注册的 url（优先）或 html（srcdoc）。
 * 监听 iframe 内 postMessage 的窗口控制消息（最小化/最大化/关闭本窗口）。
 * 主题：srcdoc 内容前注入当前主题的 CSS 变量（<style>），扩展页面用 var(--bg) 等即可跟随主题。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import TitleBar from './components/TitleBar.vue'
import { appStore } from './core/appStore'
import { themeStore } from './core/theme'
import { stateStore } from './core/state'

const { t } = useI18n()

const params = new URLSearchParams(window.location.search)
const appId = params.get('appId') ?? ''
const sequence = Number(params.get('sequence') ?? '1')

const registration = computed(() => appStore.findById(appId))

const title = computed(() => {
  const name = registration.value?.name ?? ''
  return sequence > 1 ? `${name} ${sequence}` : name
})

/** 主题相关：themeKey（驱动 iframe 重渲染的响应式 key）+ themeStyleHtml（注入的 CSS） */
const themeKey = computed(() => {
  void themeStore.themes
  return themeStore.current?.id ?? 'none'
})
const themeStyleHtml = computed(() => {
  const tokens = themeStore.current?.tokens ?? {}
  const rules = Object.entries(tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join('')
  return rules ? `<style>:root{${rules}}</style>` : ''
})

const iframeSrc = computed(() => registration.value?.url ?? undefined)
const iframeSrcdoc = computed(() => {
  if (registration.value?.url) return undefined
  const html =
    registration.value?.html ?? `<p style="color:#888;padding:16px">${t('appExt.emptyContent')}</p>`
  return themeStyleHtml.value + html
})

function onMessage(e: MessageEvent): void {
  const data = e.data
  if (!data || typeof data !== 'object' || data.source !== 'obox-app') return
  switch (data.action) {
    case 'minimize':
      void window.api.windowAction('minimize')
      break
    case 'maximize':
      void window.api.windowAction('toggle-maximize')
      break
    case 'close':
      void window.api.windowAction('close')
      break
  }
}

let offTheme: (() => void) | undefined

onMounted(() => {
  window.addEventListener('message', onMessage)
  // 主题切换时刷新 iframe（:key="themeStyle" 触发 srcdoc 重渲染，应用新主题变量）
  offTheme = stateStore.onSettingsChanged(() => {
    // 仅依赖 key 变化触发重渲染；无需额外逻辑
  })
})

onUnmounted(() => {
  window.removeEventListener('message', onMessage)
  offTheme?.()
})
</script>

<template>
  <div class="app-window">
    <TitleBar :title="title" />
    <div class="app-window-content">
      <iframe
        v-if="registration"
        :key="themeKey"
        class="app-frame"
        :src="iframeSrc"
        :srcdoc="iframeSrcdoc"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
      <div v-else class="app-window-empty">
        <p>{{ t('appExt.notFound', { appId }) }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-window {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg, #1e1e1e);
}
.app-window-content {
  flex: 1;
  min-height: 0;
  background: var(--bg, #1e1e1e);
}
.app-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #ffffff;
}
.app-window-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-dim, #6e6e6e);
  font-size: 13px;
}
</style>
