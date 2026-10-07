<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import TitleBar from './components/TitleBar.vue'
import NavBar from './components/NavBar.vue'
import ContentArea from './components/ContentArea.vue'
import StatusBar from './components/StatusBar.vue'
import CommandPalette from './components/CommandPalette.vue'
import PromptHost from './components/PromptHost.vue'
import ToastHost from './components/ToastHost.vue'
import OutputPanel from './components/OutputPanel.vue'
import { registry } from './core/registry'
import { host } from './core/host'
import { keybindingStore } from './core/keybindings'
import { pickStartupNavId } from './core/startupView'
import oboxIcon from './assets/icons/obox.svg?raw'

const activeNavId = ref<string | null>(null)
const paletteOpen = ref(false)

function selectNav(id: string): void {
  activeNavId.value = id
}

function onGlobalKeydown(e: KeyboardEvent): void {
  // 快捷键系统：匹配内置/扩展快捷键（内置命令面板 + 扩展命令通用执行）
  const command = keybindingStore.matchKeydown(e)
  if (!command) return
  if (command === 'app.showCommands') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
  } else {
    e.preventDefault()
    void host.executeCommand(command).catch((err) => console.error('[keybinding]', command, err))
  }
}

onMounted(() => {
  void host.ready.then(() => {
    // 启动视图固定为"应用"扩展（不恢复上次选择）——策略与回退链见 core/startupView.ts
    activeNavId.value = pickStartupNavId(registry.navItems)
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
    <OutputPanel />
    <StatusBar :active-nav-id="activeNavId" />
    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
    <PromptHost />
    <ToastHost />
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
