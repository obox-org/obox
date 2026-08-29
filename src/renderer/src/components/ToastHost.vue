<script setup lang="ts">
/**
 * 扩展提示宿主：应用内 toast（非模态，自动消失）+ withProgress 进度条。
 */
import { uiState, uiStore } from '../core/uiStore'
</script>

<template>
  <Teleport to="body">
    <!-- withProgress 进度条 -->
    <div v-if="uiState.progress" class="progress-bar-row">
      <div class="progress-text">{{ uiState.progress.title }}</div>
      <div class="progress-track">
        <div
          class="progress-fill"
          :style="{ width: (uiState.progress.percent ?? 0) + '%' }"
        ></div>
      </div>
    </div>

    <!-- toasts -->
    <div class="toast-host">
      <div
        v-for="toast in uiState.toasts"
        :key="toast.id"
        class="toast"
        :class="`toast-${toast.type}`"
        @click="uiStore.dismissToast(toast.id)"
      >
        {{ toast.message }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: 16px;
  bottom: 40px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 5200;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  min-width: 200px;
  max-width: 360px;
  padding: 8px 14px;
  font-size: 13px;
  border-radius: 4px;
  border: 1px solid var(--border, #454545);
  background: var(--bg-panel, #252526);
  color: var(--fg, #cccccc);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  animation: toast-in 0.2s ease;
}
.toast-info {
  border-left: 3px solid var(--accent, #007acc);
}
.toast-success {
  border-left: 3px solid var(--fg-success, #4ec9b0);
}
.toast-warning {
  border-left: 3px solid #d7ba7d;
}
.toast-error {
  border-left: 3px solid var(--fg-error, #f48771);
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.progress-bar-row {
  position: fixed;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
  width: 320px;
  z-index: 5200;
  background: var(--bg-panel, #252526);
  border: 1px solid var(--border, #454545);
  border-radius: 4px;
  padding: 8px 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.progress-text {
  font-size: 12px;
  color: var(--fg, #cccccc);
  margin-bottom: 6px;
}
.progress-track {
  height: 4px;
  background: var(--bg-input, #3c3c3c);
  border-radius: 2px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent, #007acc);
  transition: width 0.2s ease;
}
</style>
