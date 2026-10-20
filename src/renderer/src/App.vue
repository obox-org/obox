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
  // EH-C2：若该导航项的视图属于**宿主进程里的扩展**且尚未激活，先请求宿主激活
  // （fire-and-forget：切页本身不该等激活；失败由 core/host.ts 记 error，不打断 UI）。
  void host.ensureViewActivated(id)
}

function onGlobalKeydown(e: KeyboardEvent): void {
  // 捕获态守卫（issue #85）：设置页正在录按键时，全局快捷键一律不触发，
  // 否则 Ctrl+Shift+P 会被这里拦下并打开命令面板，捕获框永远拿不到该键。
  // `matchKeydown` 内部也有同样的早退（双保险，见 core/keybindings.ts）。
  if (keybindingStore.isCapturing) return
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

let offNavOpen: (() => void) | undefined

onMounted(() => {
  void host.ready.then(() => {
    // 启动视图固定为"应用"扩展（不恢复上次选择）——策略与回退链见 core/startupView.ts
    activeNavId.value = pickStartupNavId(registry.navItems)
  })
  window.addEventListener('keydown', onGlobalKeydown)
  // 托盘"设置"→ 主进程要求切页（切页状态在本组件，主进程无法直接改；ADR-0019 决策 8）
  offNavOpen = window.events.on('nav:open', (navId) => selectNav(navId))
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  offNavOpen?.()
})
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
