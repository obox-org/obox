<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { registry } from '../core/registry'
import { resolveExtensionLabel } from '../core/extensionLabels'

const { t } = useI18n()

const props = defineProps<{
  activeNavId: string | null
}>()

const leftItems = computed(() => registry.getVisibleStatusBarItems('left'))
const rightItems = computed(() => registry.getVisibleStatusBarItems('right'))

/** 鐘舵€佹爮 tooltip锛歮anifest `name`锛堟敮鎸?`%key%`锛夋垨鎵╁睍杩愯鏃跺啓鍏ョ殑 tooltip */
function itemLabel(item: { name: string; tooltip?: string; extensionId: string }): string {
  const raw = item.tooltip ?? item.name
  return resolveExtensionLabel(raw, item.extensionId)
}

const activeTitle = computed(() => {
  const item = registry.navItems.find((i) => i.id === props.activeNavId)
  if (!item) return ''
  if (item.titleKey) return t(item.titleKey)
  return resolveExtensionLabel(item.title, item.extensionId)
})

async function onItemClick(command?: string): Promise<void> {
  if (!command) return
  const cmd = registry.commands.find((c) => c.command === command)
  if (cmd?.handler) await cmd.handler()
}
</script>

<template>
  <footer class="statusbar">
    <div class="statusbar-left">
      <span class="status-item">{{ activeTitle }}</span>
      <!-- 鏂囨湰鐢辨墿灞曟彁渚涳紙鍚岃繘绋嬪彈淇′唬鐮侊紝瑙?ADR-0015锛夛紝闇€瑕?v-html 娓叉煋鎵╁睍缁欏嚭鐨勫瘜鏂囨湰锛?           鍏冪礌璺ㄥ琛岋紝鏁呯敤鍧楃骇璞佸厤锛堜笅涓€琛屽紡璞佸厤鍙鐩?`<span` 閭ｄ竴琛岋級 -->
      <!-- eslint-disable vue/no-v-html -->
      <span
        v-for="item in leftItems"
        :key="item.id"
        class="status-item clickable"
        :title="itemLabel(item)"
        @click="onItemClick(item.command)"
        v-html="item.text"
      />
      <!-- eslint-enable vue/no-v-html -->
    </div>
    <div class="statusbar-right">
      <!-- eslint-disable vue/no-v-html -- 鍚屼笂锛堝彸渚х姸鎬侀」锛屽厓绱犺法澶氳锛?-->
      <span
        v-for="item in rightItems"
        :key="item.id"
        class="status-item clickable"
        :title="itemLabel(item)"
        @click="onItemClick(item.command)"
        v-html="item.text"
      />
      <!-- eslint-enable vue/no-v-html -->
      <span class="status-item version">Obox</span>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  height: 22px;
  display: flex;
  align-items: center;
  background: var(--statusbar-bg, #007acc);
  color: var(--statusbar-fg, #ffffff);
  font-size: 12px;
  user-select: none;
  flex-shrink: 0;
}
.statusbar-left {
  flex: 1;
  display: flex;
  align-items: center;
  overflow: hidden;
}
.statusbar-right {
  display: flex;
  flex-direction: row-reverse;
  align-items: center;
  flex-wrap: wrap;
  max-width: 50%;
}
.status-item {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  height: 22px;
  line-height: 22px;
  white-space: nowrap;
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status-item.clickable:hover {
  background: rgba(255, 255, 255, 0.12);
}
</style>
