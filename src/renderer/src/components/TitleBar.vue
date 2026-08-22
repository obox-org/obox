<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { WindowState } from '../../../shared/types'

const props = defineProps<{
  title?: string
}>()

const state = ref<WindowState>({ isMaximized: false, isFullScreen: false, isFocused: true })

async function refresh(): Promise<void> {
  const s = await window.api.getWindowState()
  if (s) state.value = s
}

function minimize(): void {
  void window.api.windowAction('minimize')
}

function toggleMaximize(): void {
  void window.api.windowAction('toggle-maximize')
}

function close(): void {
  void window.api.windowAction('close')
}

let offState: (() => void) | undefined

onMounted(() => {
  void refresh()
  offState = window.events.on('window:state-changed', (s) => {
    state.value = s
  })
})

onUnmounted(() => offState?.())
</script>

<template>
  <header class="titlebar" :class="{ inactive: !state.isFocused, fullscreen: state.isFullScreen }">
    <div class="titlebar-drag" />
    <div class="titlebar-title">{{ props.title ?? 'Obox' }}</div>
    <div class="titlebar-controls">
      <button class="window-icon" title="最小化" aria-label="最小化" @click="minimize">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
      <button
        class="window-icon"
        :title="state.isMaximized ? '还原' : '最大化'"
        :aria-label="state.isMaximized ? '还原' : '最大化'"
        @click="toggleMaximize"
      >
        <svg v-if="!state.isMaximized" width="10" height="10" viewBox="0 0 10 10">
          <rect
            x="0.5"
            y="0.5"
            width="9"
            height="9"
            fill="none"
            stroke="currentColor"
            stroke-width="1"
          />
        </svg>
        <svg v-else width="10" height="10" viewBox="0 0 10 10">
          <rect
            x="0.5"
            y="2.5"
            width="7"
            height="7"
            fill="none"
            stroke="currentColor"
            stroke-width="1"
          />
          <path
            d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1"
          />
        </svg>
      </button>
      <button class="window-icon close" title="关闭" aria-label="关闭" @click="close">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" stroke="currentColor" stroke-width="1.1" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  position: relative;
  height: 32px;
  display: flex;
  align-items: center;
  background: #323233;
  color: #cccccc;
  user-select: none;
  flex-shrink: 0;
  z-index: 100;
}
/* 拖拽区：铺满整个标题栏、垫底 */
.titlebar-drag {
  position: absolute;
  inset: 0;
  -webkit-app-region: drag;
}
.titlebar.inactive > *:not(.titlebar-drag) {
  opacity: 0.6;
}
.titlebar-title {
  position: relative;
  z-index: 1;
  padding-left: 12px;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
/* 窗口控制按钮区：显式 no-drag + 高 z-index，否则点不到 */
.titlebar-controls {
  position: relative;
  z-index: 3000;
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
}
.window-icon {
  width: 46px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: #cccccc;
  cursor: default;
  outline: none;
}
.window-icon:hover {
  background: rgba(255, 255, 255, 0.1);
}
.window-icon.close:hover {
  background: rgba(232, 17, 35, 0.9);
  color: #ffffff;
}
.fullscreen .titlebar-controls {
  display: none;
}
</style>
