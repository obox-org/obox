<script setup lang="ts">
/**
 * App（应用）视图：Grid 网格展示扩展注册的插件卡片，
 * 点击卡片经 IPC 打开独立子窗口。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { appStore } from '../../core/appStore'

const { t } = useI18n()

const query = ref('')

const items = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = appStore.items.filter((i) => i.active)
  if (!q) return list
  return list.filter(
    (i) =>
      i.name.toLowerCase().includes(q) ||
      (i.author ?? '').toLowerCase().includes(q) ||
      i.description?.toLowerCase().includes(q)
  )
})

async function openApp(id: string): Promise<void> {
  const item = appStore.findById(id)
  if (!item) return
  await window.api.openAppWindow({
    appId: item.id,
    title: item.name,
    multiOpen: item.multiOpen,
    width: item.width,
    height: item.height
  })
}

function isSvgIcon(icon: string): boolean {
  return icon.trimStart().startsWith('<svg')
}
</script>

<template>
  <div class="app-view">
    <div class="toolbar">
      <input v-model="query" class="search" :placeholder="t('appExt.searchPlaceholder')" />
      <span class="count">{{ items.length }} {{ t('appExt.count') }}</span>
    </div>

    <div class="grid">
      <div v-for="item in items" :key="item.id" class="card" @click="openApp(item.id)">
        <div class="card-icon">
          <img v-if="!isSvgIcon(item.icon)" :src="item.icon" alt="" />
          <span v-else class="card-icon-svg" v-html="item.icon" />
        </div>
        <div class="card-header">
          <span class="card-name">{{ item.name }}</span>
          <span class="card-version">{{ item.version }}</span>
        </div>
        <div class="card-author">{{ item.author ?? t('extManager.unknownAuthor') }}</div>
        <div class="card-desc">{{ item.description ?? t('extManager.noDescription') }}</div>
        <div class="card-hint">{{ t('appExt.openHint') }}</div>
      </div>
      <div v-if="items.length === 0" class="empty">
        <p>{{ t('appExt.empty') }}</p>
        <p class="empty-hint">{{ t('appExt.emptyHint') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-view {
  padding: 16px;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.search {
  flex: 1;
  max-width: 320px;
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  color: var(--fg, #cccccc);
  padding: 4px 8px;
  font-size: 13px;
  outline: none;
}
.count {
  color: var(--fg-dim, #6e6e6e);
  font-size: 12px;
}
.grid {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  overflow-y: auto;
  align-content: start;
}
.card {
  background: var(--bg-panel, #252526);
  border: 1px solid var(--border, #3c3c3c);
  border-radius: 4px;
  padding: 14px;
  cursor: pointer;
  transition: border-color 0.15s ease-out;
}
.card:hover {
  border-color: var(--accent, #007acc);
}
.card-icon {
  width: 40px;
  height: 40px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg, #cccccc);
}
.card-icon img {
  max-width: 40px;
  max-height: 40px;
}
.card-icon-svg {
  display: flex;
}
.card-icon-svg :deep(svg) {
  width: 40px;
  height: 40px;
}
.card-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.card-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-bright, #e8e8e8);
}
.card-version {
  font-size: 11px;
  color: var(--fg-dim, #6e6e6e);
}
.card-author {
  font-size: 12px;
  color: var(--fg-dim, #9d9d9d);
  margin-top: 4px;
}
.card-desc {
  font-size: 12px;
  color: var(--fg, #cccccc);
  margin-top: 6px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-hint {
  font-size: var(--font-size-sm, 11px);
  color: var(--fg-link, #4a6b8a);
  margin-top: 8px;
}
.empty {
  grid-column: 1 / -1;
  color: var(--fg-dim, #6e6e6e);
  font-size: 13px;
  padding: 48px 24px;
  text-align: center;
}
.empty-hint {
  margin-top: 8px;
  font-size: 12px;
  color: #4a4a4a;
}
</style>
