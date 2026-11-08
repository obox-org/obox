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
import { currentLocale, LOCALES, setLocale } from '../i18n'
import { readExtensionHostSwitch } from './extensionHostBridge'
import { extensionSettingsStore } from './extensionSettings'
import { stateStore } from './state'
import { updaterStore } from './updaterStore'
import { themeStore } from './theme'
import { resolveExtensionLabel, resolveFieldLabels, resolveManifestLabels } from './extensionLabels'

/**
 * 对外（扩展页面 / 宿主扩展）提供扩展条目时，先把 manifest 里的 `%key%` 标签解析成文本
 * （change `unified-page-context` 任务 4.3）。
 *
 * 为什么必须在这里解析：只有壳子手上有**所有扩展**的语言包；页面（扩展管理器、设置页）拿到的
 * 必须是成品文本，否则它要么显示 `%key%`、要么得自己去读别人的词条（跨扩展读数据）。
 */
function withResolvedLabels<T extends { id: string; manifest?: Record<string, unknown> }>(
  ext: T
): T {
  return resolveManifestLabels(ext)
}

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
    listExtensions: async () => {
      const list = (await lazyHost()).getExtensions() as Array<{
        id: string
        manifest?: Record<string, unknown>
      }>
      return list.map(withResolvedLabels)
    },
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
    // 设置页要的**一站式快照**：分区内容一次取全，避免页面为每个分区单独往返（也避免键名知识散落）
    settingsSnapshot: async () => {
      const appInfo = await window.api.getAppInfo()
      const closeBehavior = await window.api.getCloseBehavior()
      const hostSwitch = readExtensionHostSwitch()
      const extensions = (await (await lazyHost()).getExtensions()) as Array<{
        id: string
        source: string
        enabled: boolean
      }>
      return {
        app: { version: appInfo.version },
        theme: {
          list: themeStore.themes.map((t) => ({
            id: t.id,
            label: resolveExtensionLabel(t.label, t.extensionId)
          })),
          current: themeStore.currentId
        },
        locale: {
          list: LOCALES.map((l) => ({ code: l.code, label: l.displayName })),
          current: currentLocale()
        },
        closeBehavior,
        settings: stateStore.getSettingsSnapshot(),
        keybindings: keybindingStore.list().map((k) => ({
          command: k.command,
          labelKey: k.labelKey,
          defaultKey: k.defaultKey,
          currentKey: k.currentKey
        })),
        extensionHost: {
          enabled: hostSwitch.enabled,
          source: hostSwitch.source,
          sourceText: hostSwitch.source,
          // 显式设置值（undefined = 从未设过）；设置页用它渲染"跟随默认/强制开/强制关"
          setting: stateStore.getExtensionHostEnabled() ?? null
        },
        extensions: extensions.map((e) => ({
          id: e.id,
          source: e.source,
          enabled: e.enabled,
          notificationDisabled: stateStore.isNotificationDisabled(e.id)
        })),
        update: {
          providers: updaterStore.providers.map((p) => ({ extensionId: p.extensionId })),
          activeId: updaterStore.activeId ?? null
        },
        devRuntime: await window.api.devRuntimeScan(),
        extensionPages: extensionSettingsStore.pages.map((p) => ({
          id: p.id,
          title: resolveExtensionLabel(p.title, p.extensionId),
          extensionId: p.extensionId,
          fields: p.fields.map((field) => resolveFieldLabels(field, p.extensionId))
        }))
      }
    },
    // 设置页的写操作：关闭行为与语言（两者都不在 settings 里，各有专用通道）
    setCloseBehavior: async (behavior) => {
      await window.api.setCloseBehavior(behavior as 'ask' | 'hide' | 'quit')
    },
    setLocale: (code) => setLocale(code as 'zh' | 'en'),
    setNotificationDisabled: (id, disabled) => {
      stateStore.setNotificationDisabled(id, disabled)
    },
    // 更新区动作：与旧设置页同一组 IPC（feedUrl 由当前生效的更新提供者扩展给出）
    updateCheck: async () => {
      const active = updaterStore.active
      if (!active || !active.feedUrl) return { ok: false, error: '没有可用的更新提供者' }
      return await window.api.checkUpdate({ feedUrl: active.feedUrl })
    },
    updateDownload: () => window.api.downloadUpdate(),
    updateInstall: () => window.api.installUpdate(),
    // AI 测试连接：main 侧统一走 net.fetch（与扩展 api.net 同一套代理策略）
    aiTest: (baseUrl, apiKey) => window.api.aiTestConnection({ baseUrl, apiKey }),
    // 目录选择（扩展设置里的 directory 字段）
    pickDirectory: (title) => window.api.dialogOpen({ title, properties: ['openDirectory'] }),
    // 文件选择（开发运行时：手动选 .oix 运行时包）
    pickFile: (title) =>
      window.api.dialogOpen({
        title,
        properties: ['openFile'],
        filters: [{ name: 'Obox 运行时包', extensions: ['oix'] }]
      }),
    installFromPath: (path) => window.api.installUserExtensionFromPath(path),
    devRuntimeScan: () => window.api.devRuntimeScan(),
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
    commands: () =>
      registry.commands.map((c) => ({
        ...c,
        title: resolveExtensionLabel(c.title, c.extensionId)
      })),
    menus: () => [...registry.getMenusFor('')],
    themeList: () =>
      themeStore.themes.map((t) => ({
        ...t,
        label: resolveExtensionLabel(t.label, t.extensionId)
      })),
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
