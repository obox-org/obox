<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import TitleBar from './components/TitleBar.vue'
import NavBar from './components/NavBar.vue'
import ContentArea from './components/ContentArea.vue'
import StatusBar from './components/StatusBar.vue'
import CommandPalette from './components/CommandPalette.vue'
import { registry } from './core/registry'
import { stateStore } from './core/state'
import { host } from './core/host'
import { keybindingStore } from './core/keybindings'
import oboxIcon from './assets/icons/obox.svg?raw'

const activeNavId = ref<string | null>(null)
const paletteOpen = ref(false)

// 默认导航项：扩展管理器（其贡献的导航项 id 约定为 ext-manager.main），
// 否则回退到第一个已注册导航项；再回退 null
const defaultNavId = computed(() => {
  const items = registry.getNavItems('bottom')
  const extManager = items.find((i) => i.id === 'ext-manager.main')
  if (extManager) return extManager.id
  const all = [...registry.getNavItems('top'), ...items]
  return all[0]?.id ?? null
})

const initialNavId = computed(() => {
  const saved = stateStore.lastActiveNavId
  if (saved && registry.navItems.some((i) => i.id === saved && i.active)) return saved
  return defaultNavId.value
})

function selectNav(id: string): void {
  activeNavId.value = id
  stateStore.setLastActiveNavId(id)
}

function onGlobalKeydown(e: KeyboardEvent): void {
  // 快捷键系统：匹配内置/自定义快捷键（如 Ctrl+Shift+P 命令面板）
  const command = keybindingStore.matchKeydown(e)
  if (!command) return
  if (command === 'app.showCommands') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
  }
}

onMounted(() => {
  void host.ready.then(() => {
    activeNavId.value = initialNavId.value
  })
  window.addEventListener('keydown', onGlobalKeydown)
})

onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <div class="app-shell">
    <TitleBar :icon="oboxIcon" />
    <div class="app-body">
      <NavBar :active-nav-id="activeNavId" @select="selectNav" />
      <ContentArea :active-nav-id="activeNavId" />
    </div>
    <StatusBar :active-nav-id="activeNavId" />
    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg, #1e1e1e);
}
.app-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
</style>
