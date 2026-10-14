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
    // 代理是新形态（单一 URL）；旧形态（host/port/username/password）的迁移矩阵见 test/proxy-url.test.ts
    'network.proxy': { enabled: true, url: 'http://my-proxy.local:8080', noProxy: ['a.com'] },
    'ext-probe.demo.mode': 'advanced',
    'ext-probe.demo.dir': 'D:\\obox-data',
    'ext-probe.demo.progress': '步骤 1\n步骤 2',
    // modal 字段（等待模态框）的进度值：值非空 ⇒ 弹模态框，扩展写空串 ⇒ 模态框消失
    'ext-probe.demo.migration': '迁移 42%\n已完成 3/8'
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

  it('网络：代理表单读到持久化配置（不是默认的 disabled/空 URL）', () => {
    expect(state.stateStore.getSetting('network.proxy')).toEqual(
      PERSISTED.settings['network.proxy']
    )
  })

  it('扩展设置：字段读到持久化值（不是 field.default）', () => {
    expect(state.stateStore.getSetting('ext-probe.demo.mode', 'basic')).toBe('advanced')
  })

  it('扩展设置：directory 字段同样存统一设置存储（绝对路径，首屏读到持久化值）', () => {
    // directory 的"值"就是一条绝对路径字符串，与 text 共用同一个设置存储 →
    // 首屏取值、持久化、api.settings.get/set 全部与 text 同语义（不另造存储）
    expect(state.stateStore.getSetting('ext-probe.demo.dir', 'C:\\obox-data')).toBe('D:\\obox-data')
  })

  it('扩展设置：status 字段的值同样存统一设置存储（含 \\n 的多行状态原样保留）', () => {
    // status 的"值"就是扩展经 api.settings.set 写进统一设置存储的一条状态字符串；
    // 宿主只渲染、不提供编辑控件，因此首屏取值与 text/directory 完全同语义（不另造状态存储）
    expect(state.stateStore.getSetting('ext-probe.demo.progress')).toBe('步骤 1\n步骤 2')
  })

  it('status 的响应式来源：api.settings.set 与设置页读值落在同一个 stateStore（写后同步通知）', () => {
    const seen: Array<string | undefined> = []
    const off = state.stateStore.onSettingsChanged((key) => seen.push(key))
    try {
      // 扩展侧：api.settings.set = stateStore.setSetting（core/host.ts:440）
      state.stateStore.setSetting('ext-probe.demo.progress', '迁移 42%\n已完成 3/8')
    } finally {
      off()
    }
    // 设置页侧：fieldValue / statusLines 读 getSetting，onMounted 订阅 onSettingsChanged 后
    // 把 settingsRevision++ 触发重渲染（SettingsView.vue:298-301、:397-402）⇒
    // 扩展写键的那一刻订阅者就被同步通知，即"设置页无需重进即刷新"
    expect(seen).toEqual(['ext-probe.demo.progress'])
    expect(state.stateStore.getSetting('ext-probe.demo.progress')).toBe('迁移 42%\n已完成 3/8')
    // 落盘也在同一份持久层（渲染进程 localStorage 的 obox:state:v1），不是另一处主进程存储
    expect(store[STORAGE_KEY]).toContain('迁移 42%\\n已完成 3/8')
  })

  it('扩展设置：modal 字段的进度值同样存统一设置存储（宿主只显示，值由扩展写入）', () => {
    // modal 只是 status 的展示方式（等待模态框），值的存储与取值语义完全不变
    expect(state.stateStore.getSetting('ext-probe.demo.migration')).toBe('迁移 42%\n已完成 3/8')
  })

  it('modal 值清空 ⇒ 模态框消失：set("") 与设置页读值同源且同步通知（无需重进设置页）', () => {
    // 界面侧的门（SettingsView.statusHasValue）：只取设置值（不回退 default）+ 去空白后非空
    const hasValue = (v: unknown): boolean =>
      v !== undefined && v !== null && String(v).trim() !== ''
    expect(hasValue(state.stateStore.getSetting('ext-probe.demo.migration'))).toBe(true)
    expect(hasValue('')).toBe(false)
    expect(hasValue('   \n')).toBe(false)

    const seen: Array<string | undefined> = []
    const off = state.stateStore.onSettingsChanged((key) => seen.push(key))
    try {
      // 迁移结束：扩展用 api.settings.set(key, '') 清空（host.ts:440 = stateStore.setSetting）
      state.stateStore.setSetting('ext-probe.demo.migration', '')
    } finally {
      off()
    }
    // 同步通知 ⇒ SettingsView 的 settingsRevision++ ⇒ activeModal 重算为 null ⇒ v-if 立即卸载模态
    expect(seen).toEqual(['ext-probe.demo.migration'])
    expect(hasValue(state.stateStore.getSetting('ext-probe.demo.migration'))).toBe(false)
    // 键仍在（写空串 ≠ 删除），只是值为空：空值 = "没有进度" = 不渲染模态
    expect(state.stateStore.getSetting('ext-probe.demo.migration')).toBe('')
    // 复位，避免影响同文件后续用例
    state.stateStore.setSetting('ext-probe.demo.migration', '迁移 42%\n已完成 3/8')
  })

  it('更新：生效提供者读到持久化选择', async () => {
    const { updaterStore } = await import('../src/renderer/src/core/updaterStore')
    updaterStore.register('updater-probe')
    state.stateStore.setSetting('update.provider', 'updater-probe')
    expect(updaterStore.activeId).toBe('updater-probe')
    updaterStore.deactivateExtension('updater-probe')
  })
})
