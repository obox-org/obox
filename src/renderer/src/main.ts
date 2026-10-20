import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import AppWindow from './AppWindow.vue'
import { host } from './core/host'
import { startExtensionHostConsumer } from './core/extensionHostConsumer'
import { plainProxyConfig } from './core/plainProxy'
import { stateStore } from './core/state'
import type { ProxyConfig } from './core/types'
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

/**
 * 把「网络代理」设置推给主进程（宿主内部 IPC `proxy:apply`），由主进程的 `applyProxy()` 同时应用到
 * 扩展联网（`obox-net`）与更新下载（`electron-updater`）两个 session。
 *
 * 为什么要有这一步（卡 20）：主进程此前只有 `applyProxy()` 这个"把代理同时应用到两个 session"的
 * 入口却**没有任何调用方**，于是 session 只在"某次请求恰好带了 proxy 参数"时才被配置；下载/安装
 * （`update:download` / `update:install`）压根不带该参数 ⇒ 是否走代理取决于"上一次 check 是否恰好
 * 配置过这个 session"这种偶然状态，用户看到的就是"obox-updater 没有使用代理"。
 * 现在：**启动时**推一次（两个 session 一开始就处于已配置状态）+ **设置变化时**再推一次（改完即生效）。
 *
 * `plainProxyConfig` 不可省：`stateStore` 的 state 是 `reactive(...)`，Proxy 进 IPC 会被结构化克隆
 * 拒掉（`An object could not be cloned.`，见 core/plainProxy.ts 与设置页那条历史缺陷）。
 * 子窗口也走本文件，重复推送无副作用（主进程按配置指纹去重，见 `applyProxyToSession`）。
 */
function pushProxyToHost(): void {
  void window.api
    .applyProxy(plainProxyConfig(stateStore.getSetting<ProxyConfig>('network.proxy')))
    .catch((err) => console.warn('[proxy] 推送代理设置失败', err))
}
pushProxyToHost()
// 设置变化（含另一个窗口写入后同步过来的快照）→ 重新推。key 为 undefined（语言切换等无具体 key 的
// 通知）时也推一次：主进程按指纹去重，未变配置不会产生多余的 setProxy 往返
stateStore.onSettingsChanged((key) => {
  if (key === undefined || key === 'network.proxy') pushProxyToHost()
})

// 启动扩展宿主（两阶段），完成后由根组件消费注册表
void (async () => {
  // EH-B3b-1：宿主 → 渲染侧的数据面消费者（状态栏/命令/树/设置页/卡片/主图/事件）。
  // 必须在 `host.start()` **之前**启动：消费者要先订阅"端口到达"，才能保证宿主的第一次
  // `settings.get` 有缓存可读；开关 `OBOX_EXTENSION_HOST` 关闭时它什么都不做（默认零变化）。
  // 子窗口不接：宿主只服务主窗口，子窗口连端口都拿不到（且它的 localStorage 是共享的，
  // 推快照会把"子窗口以为的设置"覆盖成宿主的真相）。
  if (!isChildWindow) startExtensionHostConsumer({ host })

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
