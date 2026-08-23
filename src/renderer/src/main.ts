import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import AppWindow from './AppWindow.vue'
import { host } from './core/host'
import { collectBuiltinExtensions, collectUserExtensions } from './core/loader'
import { i18n } from './i18n'

// 启动扩展宿主（两阶段），完成后由根组件消费注册表
void (async () => {
  const [builtins, userExtensions] = await Promise.all([
    collectBuiltinExtensions(),
    collectUserExtensions()
  ])
  await host.start({ builtins, userExtensions })

  // 子窗口模式：?obox-window=app&appId=xxx → 渲染 AppWindow（标题栏 + 内容 iframe）
  const params = new URLSearchParams(window.location.search)
  const isAppWindow = params.get('obox-window') === 'app'

  if (isAppWindow) {
    createApp(AppWindow).use(i18n).mount('#app')
  } else {
    createApp(App).use(i18n).mount('#app')
  }
})()
