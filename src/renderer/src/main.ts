import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import AppWindow from './AppWindow.vue'
import { host } from './core/host'
import {
  collectBuiltinExtensions,
  collectDebugExtensions,
  collectUserExtensions
} from './core/loader'
import { i18n } from './i18n'

// 子窗口模式：?obox-window=app（App 卡片子窗口）或 ?obox-window=overlay（overlay 窗体）
// → 渲染 AppWindow 外壳（卡片：标题栏 + 内容 iframe；overlay：纯透明外壳 + 扩展页 iframe）。
// overlay 为什么也算子窗口（R11 裁定，design pet-desktop-companion D-11）：它加载同一份
// index.html、复用同一个外壳与 preload（消息桥原样可用）；不认 overlay 的话这个窗口会挂载
// 整个主窗口 App 并激活全部扩展。注意 overlay **不**参与 ui 模态框转发（main/ui.ts 的 isChild
// 按 'obox-window=app' 判定）——这是预期取舍，理由见 AppWindow.vue 的 PromptHost 注释。
// 注意要在启动宿主**之前**判断：子窗口只注册贡献点、不激活扩展（避免副作用在每个子窗口重复注册）
const params = new URLSearchParams(window.location.search)
const windowKind = params.get('obox-window')
const isChildWindow = windowKind === 'app' || windowKind === 'overlay'

// 启动扩展宿主（两阶段），完成后由根组件消费注册表
void (async () => {
  const [builtins, userExtensions, debugEntries] = await Promise.all([
    collectBuiltinExtensions(),
    collectUserExtensions(),
    window.api.listDebugExtensions()
  ])
  const debugExtensions = await collectDebugExtensions(debugEntries)
  await host.start({
    builtins,
    userExtensions,
    debugExtensions,
    activateExtensions: !isChildWindow
  })

  if (isChildWindow) {
    createApp(AppWindow).use(i18n).mount('#app')
  } else {
    createApp(App).use(i18n).mount('#app')
  }
})()
