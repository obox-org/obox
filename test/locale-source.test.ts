/**
 * 语言唯一来源（change `unified-page-context` 任务 5.1）。
 *
 * 覆盖判据：
 * - 设置里的 `locale` 是唯一真相；
 * - 旧 localStorage 键（`obox:locale:v1`）只在升级时读一次并迁移，迁移后删除；
 * - 设置值非法 → 回退 zh；旧键非法同样忽略；
 * - `setLocale` 写设置、切 vue-i18n、并删除旧键。
 *
 * 说明：`core/state.ts` 在模块求值时读一次 localStorage，因此每个用例都要先装好假存储、
 * 再 `vi.resetModules()` + 动态 import（与 `test/theme-apply.test.ts` 同一手法）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const STORAGE_KEY = 'obox:state:v1'
const LEGACY_KEY = 'obox:locale:v1'

interface Seeded {
  store: Map<string, string>
  localeSetting?: string
  legacy?: string
}

function seededState(localeSetting?: string, legacy?: string): { store: Map<string, string> } {
  const settings = localeSetting === undefined ? {} : { locale: localeSetting }
  const store = new Map<string, string>([
    [
      STORAGE_KEY,
      JSON.stringify({
        disabledExtensions: [],
        notificationDisabledExtensions: [],
        memento: {},
        settings
      })
    ]
  ])
  if (legacy !== undefined) store.set(LEGACY_KEY, legacy)
  return { store }
}

function installStorage(store: Map<string, string>): void {
  vi.stubGlobal('localStorage', {
    getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string): void => void store.set(k, String(v)),
    removeItem: (k: string): void => void store.delete(k)
  })
}

async function boot(seed: Seeded): Promise<{
  i18nMod: typeof import('../src/renderer/src/i18n')
  stateMod: typeof import('../src/renderer/src/core/state')
  store: Map<string, string>
}> {
  vi.resetModules()
  const { store } = seededState(seed.localeSetting, seed.legacy)
  installStorage(store)
  const i18nMod = await import('../src/renderer/src/i18n')
  const stateMod = await import('../src/renderer/src/core/state')
  return { i18nMod, stateMod, store }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveInitialLocale（纯函数）', () => {
  it('设置值优先，其次是旧键，最后 zh', async () => {
    const { resolveInitialLocale } = await import('../src/renderer/src/i18n')
    expect(resolveInitialLocale('en', 'zh')).toEqual({ code: 'en', migratedFromLegacy: false })
    expect(resolveInitialLocale(undefined, 'en')).toEqual({ code: 'en', migratedFromLegacy: true })
    expect(resolveInitialLocale(undefined, undefined)).toEqual({
      code: 'zh',
      migratedFromLegacy: false
    })
    expect(resolveInitialLocale('fr', 'en')).toEqual({ code: 'en', migratedFromLegacy: true })
    expect(resolveInitialLocale('fr', 'ja')).toEqual({ code: 'zh', migratedFromLegacy: false })
  })
})

describe('启动时的语言来源', () => {
  it('全新安装：默认 zh，且不写设置（保持"从未设过"）', async () => {
    const { i18nMod, stateMod } = await boot({})
    expect(i18nMod.currentLocale()).toBe('zh')
    expect(stateMod.stateStore.getSetting('locale')).toBeUndefined()
  })

  it('旧键存在：迁移为设置项、切到该语言、删除旧键', async () => {
    const { i18nMod, stateMod, store } = await boot({ legacy: 'en' })
    expect(i18nMod.currentLocale()).toBe('en')
    expect(stateMod.stateStore.getSetting('locale')).toBe('en')
    expect(store.has(LEGACY_KEY)).toBe(false)
    // 迁移写入的是同一份持久化快照
    expect(JSON.parse(store.get(STORAGE_KEY) as string).settings.locale).toBe('en')
  })

  it('设置值优先于旧键（迁移期两者并存时不回退）', async () => {
    const { i18nMod, store } = await boot({ localeSetting: 'en', legacy: 'zh' })
    expect(i18nMod.currentLocale()).toBe('en')
    expect(store.has(LEGACY_KEY)).toBe(false)
  })

  it('设置值非法：回退 zh，不把非法值写回去', async () => {
    const { i18nMod, stateMod } = await boot({ localeSetting: 'fr' })
    expect(i18nMod.currentLocale()).toBe('zh')
    expect(stateMod.stateStore.getSetting('locale')).toBe('fr')
  })
})

describe('setLocale', () => {
  it('写设置 + 切 vue-i18n + 删旧键', async () => {
    const { i18nMod, stateMod, store } = await boot({ legacy: 'zh' })
    i18nMod.setLocale('en')
    expect(i18nMod.currentLocale()).toBe('en')
    expect(stateMod.stateStore.getSetting('locale')).toBe('en')
    expect(store.has(LEGACY_KEY)).toBe(false)
  })

  it('不支持的语言被忽略（运行时防御）', async () => {
    const { i18nMod } = await boot({})
    ;(i18nMod.setLocale as (code: string) => void)('fr')
    expect(i18nMod.currentLocale()).toBe('zh')
  })

  it('切换会通知订阅者，且 key = locale（壳子/宿主/页面据此重推）', async () => {
    const { i18nMod, stateMod } = await boot({})
    const keys: Array<string | undefined> = []
    const off = stateMod.stateStore.onSettingsChanged((key) => void keys.push(key))
    i18nMod.setLocale('en')
    off()
    expect(keys).toEqual(['locale'])
  })

  it('页面上下文立刻带新语言（任务 5.2：页面与壳子同一份真相）', async () => {
    const { i18nMod } = await boot({})
    const { buildPageContextFor } = await import('../src/renderer/src/core/pageContext')
    expect(buildPageContextFor('ext-x').locale).toBe('zh')
    i18nMod.setLocale('en')
    expect(buildPageContextFor('ext-x').locale).toBe('en')
  })

  /**
   * 回归（真机缺陷，与主题同型）：`setLocale` 曾经**先写设置、后切 vue-i18n**，而 `setSetting`
   * 同步通知订阅者——`ContentArea` 在回调里读 `currentLocale()` 组 `obox:context` 推给页面，
   * 于是页面收到的永远是**上一个**语言（切英文后仍中文，切回中文才变英文）。这里钉住
   * "通知发生时 `currentLocale()` 已是新值"。
   */
  it('setLocale：先切 vue-i18n 再通知（页面推送读到的是新语言）', async () => {
    const { i18nMod, stateMod } = await boot({})
    const seen: string[] = []
    const off = stateMod.stateStore.onSettingsChanged((key) => {
      if (key === 'locale') seen.push(i18nMod.currentLocale())
    })
    i18nMod.setLocale('en')
    off()
    expect(seen).toEqual(['en'])
    expect(i18nMod.currentLocale()).toBe('en')
  })

  /**
   * 子窗口视角（真机缺陷）：主窗口切语言 → 子窗口只经 `storage` 事件合并到设置（`applyExternal`），
   * 它自己的 vue-i18n 实例不会自动切。这里模拟"只写设置"这条路径，要求 `currentLocale()` 与
   * 本窗口 vue-i18n 都跟随（否则 App 卡片窗口的 `obox:context` 仍带旧 locale）。
   */
  it('只写设置（模拟跨窗口合并）时 currentLocale 与本窗口 vue-i18n 都跟随', async () => {
    const { i18nMod, stateMod } = await boot({})
    expect(i18nMod.currentLocale()).toBe('zh')
    stateMod.stateStore.setSetting('locale', 'en')
    expect(i18nMod.currentLocale()).toBe('en')
    expect(i18nMod.i18n.global.locale.value).toBe('en')
  })

  it('扩展宿主的 snapshot 推送依赖同一个设置变更通知（源码门禁）', () => {
    const consumer = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/core/extensionHostConsumer.ts', import.meta.url)),
      'utf8'
    )
    expect(consumer).toContain('stateStore.onSettingsChanged')
    expect(consumer).toContain('pushSnapshot')
  })
})
