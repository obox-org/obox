<script setup lang="ts">
/**
 * App 子窗口：复用 TitleBar（标题=插件名）+ 内容栏 iframe。
 * 渲染插件注册的 url（优先）或 html（srcdoc）。
 * 监听 iframe 内 postMessage 的窗口控制消息（最小化/最大化/关闭本窗口）。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import TitleBar from './components/TitleBar.vue'
import { appStore } from './core/appStore'

const params = new URLSearchParams(window.location.search)
const appId = params.get('appId') ?? ''
const sequence = Number(params.get('sequence') ?? '1')

const registration = computed(() => appStore.findById(appId))

const title = computed(() => {
  const name = registration.value?.name ?? '应用'
  return sequence > 1 ? `${name} ${sequence}` : name
})

const iframeSrc = computed(() => registration.value?.url ?? undefined)
const iframeSrcdoc = computed(() =>
  registration.value?.url
    ? undefined
    : (registration.value?.html ?? '<p style="color:#888;padding:16px">空内容</p>')
)

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

onMounted(() => {
  window.addEventListener('message', onMessage)
})

onUnmounted(() => {
  window.removeEventListener('message', onMessage)
})
</script>

<template>
  <div class="app-window">
    <TitleBar :title="title" />
    <div class="app-window-content">
      <iframe
        v-if="registration"
        class="app-frame"
        :src="iframeSrc"
        :srcdoc="iframeSrcdoc"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
      <div v-else class="app-window-empty">
        <p>未找到应用「{{ appId }}」（可能已被移除或禁用）</p>
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
  background: #1e1e1e;
}
.app-window-content {
  flex: 1;
  min-height: 0;
  background: #1e1e1e;
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
  color: #6e6e6e;
  font-size: 13px;
}
</style>
