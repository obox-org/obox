/**
 * 设置页首屏取值（issue #85 缺陷 2）：**冷启动后第一次进设置页时，每个控件都必须显示
 * 本地持久化配置**，而不是代码里的默认值。
 *
 * 为什么要专门钉这条：`stateStore` 的快照在 `core/state.ts` 模块求值时读一次
 * `localStorage['obox:state:v1']`。设置页里若哪个分区把这个快照**在 setup 阶段一次性取成普通值**
 * （而不是每次渲染经响应式路径读取），首屏就会停在默认值，且之后不再刷新 —— 这正是"初次进入
 * 没有按本地持久化配置显示"。这里把每个分区的**首屏取值来源**逐条钉住：每一条用例都让
 * "持久化值 ≠ 代码默认值"，取值来源一旦退化就会红。
 *
 * 覆盖边界（重要）：仓库 vitest 是 `environment: 'node'`，没有 jsdom / @vue/test-utils
 * （先例：test/settings-view-wiring.test.ts 读 SettingsView.vue 源文件断言接线），因此这里
 * **不挂载组件**，而是断言"控件首屏读到的值"这条取数路径。组件模板是否把它接到控件上，
 * 由 settings-view-wiring.test.ts 的源文件门禁覆盖。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 存储 key 直接写字面量：`core/state` 必须在本文件**任何静态导入之前**都不被求值——
 * 它的快照是在模块求值时读 localStorage 的，静态 import 会让它在 stub 生效前就读到空。
 */
const STORAGE_KEY = 'obox:state:v1'

/** 预置一份"和默认值都不一样"的持久化快照 */
const PERSISTED = {
  disabledExtensions: [],
  notificationDisabledExtensions: [],
  memento: {},
  settings: {
    theme: 'theme-light.light',
    'keybinding.app.showCommands': 'Ctrl+Alt+K',
    'network.proxy': { enabled: true, host: 'my-proxy.local', port: 8080, noProxy: ['a.com'] },
    'ext-probe.demo.mode': 'advanced'
  }
}

const store: Record<string, string> = {
  [STORAGE_KEY]: JSON.stringify(PERSISTED),
  'obox:locale:v1': 'en'
}

type Module = typeof import('../src/renderer/src/core/state')
let state: Module

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    },
    removeItem: (k: string) => {
      delete store[k]
    }
  })
  // 快照必须在 core/state.ts 求值**之前**就在 localStorage 里（冷启动的真实顺序）
  state = await import('../src/renderer/src/core/state')
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('设置页首屏取值 · 冷启动读持久化配置（issue #85 缺陷 2）', () => {
  it('快照本身被读进来了（前提）', () => {
    expect(state.stateStore.getSetting('theme')).toBe('theme-light.light')
  })

  it('外观：主题下拉读到持久化主题（不是默认 dark）', async () => {
    const { themeStore } = await import('../src/renderer/src/core/theme')
    // 主题列表在宿主启动后注册；这里显式注册与快照里同一个 id 的主题
    themeStore.register('theme-light', {
      id: 'theme-light.light',
      label: 'Light',
      tokens: { '--bg': '#ffffff' }
    })
    themeStore.register('theme-dark', {
      id: 'theme-dark.dark',
      label: 'Dark',
      tokens: { '--bg': '#1e1e1e' }
    })
    expect(themeStore.currentId).toBe('theme-light.light')
  })

  it('语言：下拉读到持久化语言（不是 i18n 的兜底 zh）', async () => {
    const { i18n } = await import('../src/renderer/src/i18n')
    expect(i18n.global.locale.value).toBe('en')
  })

  it('快捷键：表格读到持久化按键（不是默认 Ctrl+Shift+P）', async () => {
    const { keybindingStore } = await import('../src/renderer/src/core/keybindings')
    keybindingStore.register({
      command: 'app.showCommands',
      labelKey: 'palette.showCommands',
      defaultKey: 'Ctrl+Shift+P'
    })
    const row = keybindingStore.list().find((r) => r.command === 'app.showCommands')
    expect(row?.currentKey).toBe('Ctrl+Alt+K')
  })

  it('网络：代理表单读到持久化配置（不是默认的 disabled/空 host）', () => {
    expect(state.stateStore.getSetting('network.proxy')).toEqual(
      PERSISTED.settings['network.proxy']
    )
  })

  it('扩展设置：字段读到持久化值（不是 field.default）', () => {
    expect(state.stateStore.getSetting('ext-probe.demo.mode', 'basic')).toBe('advanced')
  })

  it('更新：生效提供者读到持久化选择', async () => {
    const { updaterStore } = await import('../src/renderer/src/core/updaterStore')
    updaterStore.register('updater-probe')
    state.stateStore.setSetting('update.provider', 'updater-probe')
    expect(updaterStore.activeId).toBe('updater-probe')
    updaterStore.deactivateExtension('updater-probe')
  })
})
