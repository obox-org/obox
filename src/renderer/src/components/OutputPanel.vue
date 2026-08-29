<script setup lang="ts">
/**
 * 输出面板（底部）：多输出通道 tab + 内容，api.output.createChannel 的数据宿主。
 */
import { computed } from 'vue'
import { outputState, outputStore } from '../core/outputStore'

const active = computed(() =>
  outputState.channels.find((c) => c.id === outputState.activeId)
)
const activeLines = computed(() => active.value?.lines ?? [])
</script>

<template>
  <div v-if="outputState.visible" class="output-panel">
    <div class="output-tabs">
      <div
        v-for="ch in outputState.channels"
        :key="ch.id"
        class="output-tab"
        :class="{ active: ch.id === outputState.activeId }"
        @click="outputStore.setActive(ch.id)"
      >
        {{ ch.name }}
      </div>
      <div class="output-close" title="关闭输出面板" @click="outputStore.close()">✕</div>
    </div>
    <div class="output-content">
      <pre v-if="activeLines.length > 0">{{ activeLines.join('') }}</pre>
      <p v-else class="output-empty">（空）</p>
    </div>
  </div>
</template>

<style scoped>
.output-panel {
  height: 160px;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border, #3c3c3c);
  background: var(--bg, #1e1e1e);
  flex-shrink: 0;
}
.output-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border, #3c3c3c);
  min-height: 30px;
}
.output-tab {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--fg-dim, #9d9d9d);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.output-tab.active {
  color: var(--fg, #cccccc);
  border-bottom-color: var(--accent, #007acc);
}
.output-tab:hover {
  color: var(--fg, #cccccc);
}
.output-close {
  margin-left: auto;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--fg-dim, #6e6e6e);
  cursor: pointer;
}
.output-close:hover {
  color: var(--fg, #cccccc);
}
.output-content {
  flex: 1;
  overflow: auto;
  padding: 8px 12px;
}
.output-content pre {
  margin: 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--fg, #cccccc);
  white-space: pre-wrap;
  word-break: break-all;
}
.output-empty {
  color: var(--fg-dim, #6e6e6e);
  font-size: 12px;
  margin: 0;
}
</style>
