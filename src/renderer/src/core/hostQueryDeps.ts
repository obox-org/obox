/**
 * `runHostQuery` 的**渲染侧真实依赖**（change `system-extensions-from-install-dir`）。
 *
 * 两处消费者共用这一份：
 * 1. `extensionHostConsumer` 的 `ui.hostQuery`（宿主里的扩展调用公共 API）；
 * 2. `ContentArea` 的页面 iframe 桥（系统扩展的 HTML 页面直接调同一批 op）。
 *
 * 为什么集中：扩展表/卡片表/命令表/主题/快捷键/设置的"真相"都在渲染进程，
 * 分散实现两遍必然漂移（一处忘了 `await`、一处忘了排序都会让页面与宿主看到不同结果）。
 */
import { appStore } from './appStore'
import type { HostQueryDeps } from './hostQuery'
import { keybindingStore } from './keybindings'
import { registry } from './registry'
import { stateStore } from './state'
import { themeStore } from './theme'

/** 懒取渲染侧 host：避免把 App.vue 静态拉进只跑 node 的测试模块图 */
async function lazyHost(): Promise<{
  getExtensions(): unknown[]
  setEnabled(id: string, enabled: boolean): unknown
  uninstall(id: string): Promise<unknown>
}> {
  const mod = await import('./host')
  return mod.host as unknown as {
    getExtensions(): unknown[]
    setEnabled(id: string, enabled: boolean): unknown
    uninstall(id: string): Promise<unknown>
  }
}

export function hostQueryDeps(): HostQueryDeps {
  return {
    listExtensions: async () => (await lazyHost()).getExtensions(),
    setEnabled: async (id, enabled) => {
      ;(await lazyHost()).setEnabled(id, enabled)
    },
    uninstall: async (id) => {
      await (await lazyHost()).uninstall(id)
    },
    // 重启走 main 的 app:relaunch（与扩展管理器的"立即重启"同一条路）
    restartHost: () => {
      void window.api.relaunchApp()
    },
    // 安装：走系统文件选择器（与旧管理器同一个 IPC），返回安装结果
    installExtension: () => window.api.installUserExtensionViaDialog(),
    apps: () => [...appStore.items],
    // 打开卡片：与 AppView 的 openApp 同一条路（缺字段给安全默认值，避免主进程校验失败）
    openApp: async (id) => {
      const item = appStore.findById(id)
      if (!item) throw new Error(`卡片不存在：${id}`)
      await window.api.openAppWindow({
        appId: item.id,
        title: item.name,
        multiOpen: item.multiOpen,
        width: item.width,
        height: item.height,
        iconUrl: item.iconUrl
      })
    },
    commands: () => [...registry.commands],
    menus: () => [...registry.getMenusFor('')],
    themeList: () => [...themeStore.themes],
    themeCurrent: () => themeStore.currentId,
    setTheme: (themeId) => themeStore.setTheme(themeId),
    keybindingsList: () => keybindingStore.list(),
    setKeybinding: (command, combo) => {
      keybindingStore.setKey(command, combo)
    },
    resetKeybinding: (command) => keybindingStore.reset(command),
    hostSettingGet: (key) => stateStore.getSetting(key),
    hostSettingSet: (key, value) => stateStore.setSetting(key, value),
    openPage: (pageId) => {
      window.dispatchEvent(
        new CustomEvent('obox:host-request', { detail: { action: 'open-page', pageId } })
      )
    }
  }
}
