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

// 子窗口模式：?obox-window=app&appId=xxx → 渲染 AppWindow（标题栏 + 内容 iframe）
// 注意要在启动宿主**之前**判断：子窗口只注册贡献点、不激活扩展（避免副作用在每个子窗口重复注册）
const params = new URLSearchParams(window.location.search)
const isAppWindow = params.get('obox-window') === 'app'

// 启动扩展宿主（两阶段），完成后由根组件消费注册表
void (async () => {
  const [builtins, userExtensions, debugEntries] = await Promise.all([
    collectBuiltinExtensions(),
    collectUserExtensions(),
    window.api.listDebugExtensions()
  ])
  const debugExtensions = await collectDebugExtensions(debugEntries)
  await host.start({ builtins, userExtensions, debugExtensions, activateExtensions: !isAppWindow })

  if (isAppWindow) {
    createApp(AppWindow).use(i18n).mount('#app')
  } else {
    createApp(App).use(i18n).mount('#app')
  }
})()
