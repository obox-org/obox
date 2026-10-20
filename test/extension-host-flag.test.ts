/**
 * EH-D2a · 「扩展宿主默认开」的开关解析 + 设置项 + 启动失败自动回退。
 *
 * 产品决策（2.0.0 起）：用户扩展**默认在 Extension Host 进程里执行**；用户能在设置项里关掉
 * （回到渲染进程执行，需重启生效）；环境变量 `OBOX_EXTENSION_HOST` 降级为**开发者/兜底**手段。
 *
 * 本文件钉四件事：
 * 1. **优先级表**：设置项（显式设过）> 环境变量（`1`/`true` 显式开、`0`/`false` 显式关）> 默认 `true`；
 *    解析是纯函数，穷举组合；
 * 2. **与 preload 解耦**：拿不到 env（无 `window` / 老 preload 没这个字段）= 未设 ⇒ 落到默认；
 * 3. **设置值持久化**：写入 localStorage 快照后重新读取仍然生效（冷启动的真实顺序）；
 * 4. **回退路径**：`ehStart` 失败 / 宿主运行中崩溃 ⇒ 自动回退到渲染进程——用户扩展照旧**被激活**、
 *    且留下**一条**明确日志 + 一条可见提示（不能让用户看到"所有扩展消失"）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXTENSION_HOST_ENV,
  EXTENSION_HOST_FALLBACK_KEY,
  EXTENSION_HOST_SOURCE_TEXT,
  activateRendererFallback,
  clearRendererFallback,
  extensionHostFallbackNotice,
  handOverToExtensionHost,
  handleExtensionHostCrash,
  isExtensionHostEnabled,
  isRendererFallbackActive,
  parseExtensionHostEnv,
  readExtensionHostFlag,
  readExtensionHostSwitch,
  rendererFallbackNoticeText,
  resolveExtensionHostSwitch,
  type ExtensionHostBridgeLogger
} from '../src/renderer/src/core/extensionHostBridge'
import { EXTENSION_HOST_SETTING_KEY, stateStore } from '../src/renderer/src/core/state'
import { host } from '../src/renderer/src/core/host'
import { PROTOCOL_VERSION, type HostedExtensionInfo } from '../src/shared/extensionHostProtocol'
import type { ExtensionHostPhase, ExtensionHostStatusSnapshot } from '../src/shared/types'

/* -------------------------------------------------------------------------------------------- */
/* 夹具                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** `host.ts` 里会直接被 `vi.mock` 掉的 Vue 组件（node 环境解析不了 .vue） */
vi.mock('../src/renderer/src/components/TreeView.vue', () => ({ default: {} }))

/** 收集日志行的假 logger（A4 的桥测试同一做法） */
function createLogger(): ExtensionHostBridgeLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    debug: (message: string): void => lines.push(`debug ${message}`),
    info: (message: string): void => lines.push(`info ${message}`),
    warn: (message: string): void => lines.push(`warn ${message}`),
    error: (message: string): void => lines.push(`error ${message}`)
  }
}

/** 造一条被交接给宿主的清单项 */
function hosted(id: string): HostedExtensionInfo {
  return {
    id,
    version: '1.0.0',
    path: `/extensions/${id}`,
    activationEvents: ['*'],
    apiVersion: 1
  }
}

/** 宿主状态快照（只填本文件关心的字段） */
function statusOf(
  phase: ExtensionHostPhase,
  lastCrash: { code: number; at: number } | null = null
): ExtensionHostStatusSnapshot {
  return {
    phase,
    hostId: null,
    pid: null,
    crashCount: lastCrash ? 1 : 0,
    lastCrash,
    lastAckAt: null
  }
}

/** `host.start()` 需要的条目（`load` 的 default 被调用 = 该扩展在**渲染进程**被激活） */
type HostEntry = Parameters<typeof host.start>[0]['builtins'][number]

function userEntry(id: string, activated: string[]): HostEntry {
  return {
    id,
    source: 'user',
    path: `/extensions/${id}`,
    manifest: { name: id, version: '1.0.0', main: 'index.js' },
    load: async () => ({
      default: (): void => {
        activated.push(id)
      }
    })
  }
}

/** 装一个 Electron 假窗口（只覆盖 `host.start()` 走过的面；不起进程、不开窗口） */
function installWindow(options: { env?: string | null } = {}): {
  ehStartCalls: HostedExtensionInfo[][]
} {
  const calls = { ehStartCalls: [] as HostedExtensionInfo[][] }
  const unwatch = (): void => undefined
  const fakeWindow = {
    eh: {
      extensionHostFlag: options.env ?? null,
      hasPort: (): boolean => false,
      onPort: unwatch,
      onMessage: unwatch,
      post: (): boolean => false,
      onStatus: unwatch
    },
    events: { on: unwatch },
    api: {
      env: { platform: 'win32', arch: 'x64', nodeVersion: '20.0.0' },
      ehStart: async (list: HostedExtensionInfo[]): Promise<unknown> => {
        calls.ehStartCalls.push(list)
        return { ok: true, hostId: 'test-host', pid: 1 }
      },
      ehGetPort: async (): Promise<unknown> => ({
        phase: 'idle',
        portDelivered: false,
        portPending: false,
        hostId: null,
        pid: null,
        channel: 'eh:port',
        protocolVersion: PROTOCOL_VERSION
      }),
      ehGetStatus: async (): Promise<unknown> => statusOf('idle'),
      ehStop: async (): Promise<void> => undefined
    }
  }
  ;(globalThis as unknown as { window?: unknown }).window = fakeWindow
  return calls
}

/**
 * 设置页源码（去掉 HTML 注释，并**折叠空白**：prettier 会在模板文本里换行，
 * "这句文案是否存在"的断言不该被换行喂成假红）。
 */
function settingsViewSource(): string {
  const path = fileURLToPath(
    new URL('../src/renderer/src/extensions/settings/SettingsView.vue', import.meta.url)
  )
  return readFileSync(path, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
}

/** state 源码（断言设置键只有一处定义） */
function stateSource(): string {
  const path = fileURLToPath(new URL('../src/renderer/src/core/state.ts', import.meta.url))
  return readFileSync(path, 'utf8')
}

/* -------------------------------------------------------------------------------------------- */
/* 全局夹具：localStorage 假面（state.ts 的 save() 不该在测试里刷错误日志）                        */
/* -------------------------------------------------------------------------------------------- */

/** 装一个内存版 localStorage（可用 `store` 观察写入的快照） */
function installLocalStorage(store: Record<string, string> = {}): Record<string, string> {
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value
    },
    removeItem: (key: string): void => {
      delete store[key]
    }
  })
  return store
}

/**
 * 装一个内存版 sessionStorage。
 *
 * 回退标记的唯一事实来源就是它（Electron 渲染进程一定有），因为回退要靠"自动重载"生效、
 * 而重载后只有 sessionStorage 还记得"本窗口已经回退过"。
 */
function installSessionStorage(store: Record<string, string> = {}): Record<string, string> {
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value
    },
    removeItem: (key: string): void => {
      delete store[key]
    }
  })
  return store
}

beforeAll(() => {
  installLocalStorage()
  installSessionStorage()
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  // 回退标记是**本窗口**的事，测试之间必须清干净（否则后一个用例会看到"已回退"）
  clearRendererFallback()
  // 设置项复位成"从未设过"
  stateStore.setSetting(EXTENSION_HOST_SETTING_KEY, undefined)
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  clearRendererFallback()
})

/* ============================================================================================ */
/* 1. 优先级表（纯函数穷举）                                                                      */
/* ============================================================================================ */

describe('开关解析优先级：设置项 > 环境变量 > 默认 true', () => {
  it('设置项未设 + 没有 env ⇒ **默认 true**（2.0.0 首次启动走宿主路径）', () => {
    for (const env of [undefined, null, '', '   ']) {
      expect(
        resolveExtensionHostSwitch({ setting: undefined, env }),
        `env=${JSON.stringify(env)}`
      ).toEqual({ enabled: true, source: 'default' })
    }
    // 连 setting 都不传（老调用方）同样是默认开
    expect(resolveExtensionHostSwitch({})).toEqual({ enabled: true, source: 'default' })
  })

  it('设置项未设 + env `0` / `false` ⇒ **false**（显式关也认，旧实现就有的能力）', () => {
    for (const env of ['0', 'false', 'FALSE', ' 0 ', 'False']) {
      expect(resolveExtensionHostSwitch({ env }), `env=${JSON.stringify(env)}`).toEqual({
        enabled: false,
        source: 'env'
      })
    }
  })

  it('设置项未设 + env `1` / `true` ⇒ true（来源 = 环境变量）', () => {
    for (const env of ['1', 'true', 'TRUE', ' true ']) {
      expect(resolveExtensionHostSwitch({ env }), `env=${JSON.stringify(env)}`).toEqual({
        enabled: true,
        source: 'env'
      })
    }
  })

  it('**显式设关 + env `1` ⇒ false**（设置项优先，env 不再能强行打开）', () => {
    expect(resolveExtensionHostSwitch({ setting: false, env: '1' })).toEqual({
      enabled: false,
      source: 'setting'
    })
    expect(resolveExtensionHostSwitch({ setting: false, env: 'true' })).toEqual({
      enabled: false,
      source: 'setting'
    })
    expect(resolveExtensionHostSwitch({ setting: false, env: null })).toEqual({
      enabled: false,
      source: 'setting'
    })
  })

  it('**显式设开 + env `0` ⇒ true**（设置项优先，env 显式关也压不过它）', () => {
    expect(resolveExtensionHostSwitch({ setting: true, env: '0' })).toEqual({
      enabled: true,
      source: 'setting'
    })
    expect(resolveExtensionHostSwitch({ setting: true, env: 'false' })).toEqual({
      enabled: true,
      source: 'setting'
    })
  })

  it('穷举表：setting × env 的每一种组合都落在表里（含拼错的环境变量）', () => {
    const table: Array<[boolean | undefined, string | null | undefined, boolean, string]> = [
      // setting, env, 期望 enabled, 期望 source
      [undefined, undefined, true, 'default'],
      [undefined, null, true, 'default'],
      [undefined, '', true, 'default'],
      [undefined, 'garbage', true, 'default'],
      [undefined, 'no', true, 'default'],
      [undefined, '1', true, 'env'],
      [undefined, '0', false, 'env'],
      [true, undefined, true, 'setting'],
      [true, '0', true, 'setting'],
      [true, '1', true, 'setting'],
      [false, undefined, false, 'setting'],
      [false, '0', false, 'setting'],
      [false, '1', false, 'setting']
    ]
    for (const [setting, env, enabled, source] of table) {
      expect(
        resolveExtensionHostSwitch({ setting, env }),
        `setting=${String(setting)} env=${JSON.stringify(env)}`
      ).toEqual({ enabled, source })
    }
  })

  it('env 三态解析：显式开 / 显式关 / **未设**（拼错与空串都算未设）', () => {
    expect(parseExtensionHostEnv('1')).toBe(true)
    expect(parseExtensionHostEnv('TRUE')).toBe(true)
    expect(parseExtensionHostEnv('0')).toBe(false)
    expect(parseExtensionHostEnv('false')).toBe(false)
    expect(parseExtensionHostEnv(undefined)).toBeUndefined()
    expect(parseExtensionHostEnv(null)).toBeUndefined()
    expect(parseExtensionHostEnv('')).toBeUndefined()
    expect(parseExtensionHostEnv('  ')).toBeUndefined()
    expect(parseExtensionHostEnv('yes')).toBeUndefined()
    expect(parseExtensionHostEnv('2')).toBeUndefined()
  })

  it('老契约 `isExtensionHostEnabled` 语义不变：只认 1/true（它是"已判定编码"的解析器）', () => {
    for (const flag of ['1', 'true', 'TRUE', ' 1 '])
      expect(isExtensionHostEnabled(flag), flag).toBe(true)
    for (const flag of [undefined, null, '', '  ', '0', 'false', 'no', 'yes', '2']) {
      expect(isExtensionHostEnabled(flag), String(flag)).toBe(false)
    }
  })

  it('来源文案都在（日志与设置页共用同一份中文说明，不会出现空 key）', () => {
    for (const source of ['setting', 'env', 'default', 'fallback'] as const) {
      expect(EXTENSION_HOST_SOURCE_TEXT[source].length).toBeGreaterThan(0)
    }
    expect(EXTENSION_HOST_SOURCE_TEXT.env).toContain(EXTENSION_HOST_ENV)
  })
})

/* ============================================================================================ */
/* 2. 与 preload 解耦：拿不到 env 就当未设                                                         */
/* ============================================================================================ */

describe('开关判定与 preload 解耦（拿不到 env ⇒ 当未设）', () => {
  it('没有 window（node / 单测）⇒ 默认开，且 `readExtensionHostFlag()` 编码成 `1`', () => {
    expect(readExtensionHostSwitch()).toEqual({ enabled: true, source: 'default' })
    expect(readExtensionHostFlag()).toBe('1')
  })

  it('preload 没暴露 extensionHostFlag 字段（老 preload）⇒ 当未设 ⇒ 默认开', () => {
    ;(globalThis as unknown as { window?: unknown }).window = { eh: {} }
    expect(readExtensionHostSwitch()).toEqual({ enabled: true, source: 'default' })
    expect(readExtensionHostFlag()).toBe('1')
  })

  it('preload 暴露 env `0` ⇒ 关；暴露 `1` ⇒ 开（env 兜底仍可用）', () => {
    installWindow({ env: '0' })
    expect(readExtensionHostSwitch()).toEqual({ enabled: false, source: 'env' })
    expect(readExtensionHostFlag()).toBe('0')
    delete (globalThis as unknown as { window?: unknown }).window

    installWindow({ env: '1' })
    expect(readExtensionHostSwitch()).toEqual({ enabled: true, source: 'env' })
    expect(readExtensionHostFlag()).toBe('1')
  })

  it('设置项压过 preload 的 env：设开 + env `0` ⇒ 开（`readExtensionHostFlag()` 回 `1`）', () => {
    installWindow({ env: '0' })
    stateStore.setExtensionHostEnabled(true)
    expect(readExtensionHostSwitch()).toEqual({ enabled: true, source: 'setting' })
    expect(readExtensionHostFlag()).toBe('1')
  })
})

/* ============================================================================================ */
/* 3. 设置项：getter/setter + 持久化                                                              */
/* ============================================================================================ */

describe('设置项 getter/setter 与持久化', () => {
  it('未设过 ⇒ `undefined`（不是 false：两者在优先级表里含义不同）', () => {
    expect(stateStore.getExtensionHostEnabled()).toBeUndefined()
  })

  it('写入后能读回；脏值（非布尔）一律按"未设过"处理', () => {
    stateStore.setExtensionHostEnabled(true)
    expect(stateStore.getExtensionHostEnabled()).toBe(true)
    stateStore.setExtensionHostEnabled(false)
    expect(stateStore.getExtensionHostEnabled()).toBe(false)

    for (const dirty of ['false', 0, 1, null, {}, []]) {
      stateStore.setSetting(EXTENSION_HOST_SETTING_KEY, dirty)
      expect(stateStore.getExtensionHostEnabled(), JSON.stringify(dirty)).toBeUndefined()
    }
  })

  it('设置键是带命名空间的稳定字符串（改名等于改契约）', () => {
    expect(EXTENSION_HOST_SETTING_KEY).toBe('extensionHost.enabled')
    expect(stateSource()).toContain(
      `export const EXTENSION_HOST_SETTING_KEY = '${EXTENSION_HOST_SETTING_KEY}'`
    )
  })

  it('持久化后**重新读取**仍生效（冷启动顺序：先写 localStorage，再重新加载模块）', async () => {
    const store = installLocalStorage()
    try {
      vi.resetModules()
      const first = await import('../src/renderer/src/core/state')
      const firstBridge = await import('../src/renderer/src/core/extensionHostBridge')
      // 没设过 ⇒ 默认开
      expect(firstBridge.readExtensionHostSwitch()).toEqual({ enabled: true, source: 'default' })

      first.stateStore.setExtensionHostEnabled(false)
      const snapshot = JSON.parse(store[first.STORAGE_KEY]) as {
        settings: Record<string, unknown>
      }
      expect(snapshot.settings[first.EXTENSION_HOST_SETTING_KEY]).toBe(false)

      // "重启"：清模块缓存后重新加载，设置值从 localStorage 快照里读回来
      vi.resetModules()
      const second = await import('../src/renderer/src/core/state')
      expect(second.stateStore.getExtensionHostEnabled()).toBe(false)
      const secondBridge = await import('../src/renderer/src/core/extensionHostBridge')
      // 即使 env 显式开，用户设的"关"依然优先
      expect(
        secondBridge.resolveExtensionHostSwitch({
          setting: second.stateStore.getExtensionHostEnabled(),
          env: '1'
        })
      ).toEqual({ enabled: false, source: 'setting' })
    } finally {
      vi.resetModules()
      // 恢复本文件的存储假面（`vi.unstubAllGlobals()` 只在 afterAll 里做）
      installLocalStorage()
      installSessionStorage()
    }
  })
})

/* ============================================================================================ */
/* 4. 回退路径（启动失败 / 崩溃 ⇒ 渲染进程）                                                       */
/* ============================================================================================ */

describe('回退：扩展宿主启动失败 ⇒ 自动回退到渲染进程', () => {
  it('ehStart 抛错 ⇒ 不 reject、留一条明确日志、置回退标记、只重载一次', async () => {
    const logger = createLogger()
    const reload = vi.fn()
    const result = handOverToExtensionHost({
      flag: '1',
      extensions: [hosted('a'), hosted('b')],
      start: async () => {
        throw new Error("No handler registered for 'eh:start'")
      },
      logger,
      reload
    })

    await expect(result.started).resolves.toMatchObject({ ok: false, code: 'EH_INTERNAL' })

    // ① 一次、且只有一次的明确日志：用户/支持同学只看这一行就知道发生了什么
    const fallbackLines = logger.lines.filter((line) => line.includes('自动回退'))
    expect(fallbackLines).toHaveLength(1)
    expect(fallbackLines[0]).toContain('No handler registered')
    expect(fallbackLines[0]).toContain('主界面进程')

    // ② 可见提示（设置页据此渲染红字）+ 回退标记生效
    const notice = extensionHostFallbackNotice()
    expect(notice).not.toBeNull()
    expect(notice).toContain('已自动回退')
    expect(isRendererFallbackActive()).toBe(true)

    // ③ 回退标记压过设置项/环境变量：开关判定变成"关" ⇒ 重新加载后走渲染进程
    expect(readExtensionHostSwitch()).toEqual({ enabled: false, source: 'fallback' })
    expect(readExtensionHostFlag()).toBe('0')

    // ④ 只重载一次（扩展不是空的 ⇒ 需要重载才能把激活拉回渲染进程）
    expect(reload).toHaveBeenCalledTimes(1)

    // ⑤ 幂等：再失败一次不会重复重载/重复刷日志（避免重载循环）
    const second = handOverToExtensionHost({
      flag: '1',
      extensions: [hosted('a')],
      start: async () => ({ ok: false, code: 'EH_TIMEOUT', message: '握手超时' }),
      logger,
      reload
    })
    await expect(second.started).resolves.toMatchObject({ ok: false, code: 'EH_TIMEOUT' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(logger.lines.filter((line) => line.includes('自动回退'))).toHaveLength(1)
  })

  it('ehStart 返回 ok:false ⇒ 同样回退（错误码/细节进日志）', async () => {
    const logger = createLogger()
    const reload = vi.fn()
    const result = handOverToExtensionHost({
      flag: '1',
      extensions: [hosted('a')],
      start: async () => ({ ok: false, code: 'EH_TIMEOUT', message: '握手超时', detail: '1200ms' }),
      logger,
      reload
    })
    await expect(result.started).resolves.toMatchObject({ ok: false, code: 'EH_TIMEOUT' })
    const line = logger.lines.find((text) => text.includes('自动回退')) ?? ''
    expect(line).toContain('EH_TIMEOUT')
    expect(line).toContain('1200ms')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('清单为空时不重载（没有需要救回来的扩展），但仍留提示', async () => {
    const logger = createLogger()
    const reload = vi.fn()
    const result = handOverToExtensionHost({
      flag: '1',
      extensions: [],
      start: async () => ({ ok: false, code: 'EH_INTERNAL', message: 'boom' }),
      logger,
      reload
    })
    await expect(result.started).resolves.toMatchObject({ ok: false })
    expect(reload).not.toHaveBeenCalled()
    expect(isRendererFallbackActive()).toBe(true)
  })

  it('**回退后用户扩展仍然被激活（渲染侧）**：host.start() 第二次走渲染进程路径', async () => {
    const logger = createLogger()
    // ① 第一次启动：宿主路径，ehStart 失败 ⇒ 回退
    const failed = handOverToExtensionHost({
      flag: '1',
      extensions: [hosted('user.fallback')],
      start: async () => {
        throw new Error('宿主进程起不来')
      },
      logger,
      reload: vi.fn()
    })
    await expect(failed.started).resolves.toMatchObject({ ok: false })
    expect(isRendererFallbackActive()).toBe(true)

    // ② 重载后（这里直接再跑一次 host.start）用户扩展在渲染进程被真的激活
    const stub = installWindow({ env: undefined })
    const activated: string[] = []
    await host.start({
      builtins: [],
      userExtensions: [userEntry('user.fallback', activated)]
    })

    expect(activated).toEqual(['user.fallback'])
    // 没有再请求 main 启动宿主（回退之后本窗口不再尝试）
    expect(stub.ehStartCalls).toHaveLength(0)
  })

  it('宿主**运行中崩溃** ⇒ 同样回退（一条日志 + 重载）；非 crashed 阶段一律不动', () => {
    const logger = createLogger()
    const reload = vi.fn()

    expect(handleExtensionHostCrash(statusOf('ready'), { logger, reload })).toBeNull()
    expect(handleExtensionHostCrash(statusOf('starting'), { logger, reload })).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    expect(isRendererFallbackActive()).toBe(false)

    const notice = handleExtensionHostCrash(
      statusOf('crashed', { code: 134, at: 1_700_000_000_000 }),
      { logger, reload }
    )
    expect(notice).toContain('已自动回退')
    expect(logger.lines.filter((line) => line.includes('自动回退'))).toHaveLength(1)
    expect(logger.lines.join('\n')).toContain('134')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(isRendererFallbackActive()).toBe(true)
  })

  it('用户改开关（clearRendererFallback）后回退标记消失，设置项重新生效', () => {
    activateRendererFallback('测试用')
    expect(readExtensionHostSwitch()).toEqual({ enabled: false, source: 'fallback' })

    clearRendererFallback()
    expect(isRendererFallbackActive()).toBe(false)
    expect(readExtensionHostSwitch()).toEqual({ enabled: true, source: 'default' })

    stateStore.setExtensionHostEnabled(false)
    expect(readExtensionHostSwitch()).toEqual({ enabled: false, source: 'setting' })
  })

  it('提示文案说明"为什么回退 / 扩展现在在哪跑 / 怎么恢复"', () => {
    const text = rendererFallbackNoticeText('EH_TIMEOUT')
    expect(text).toContain('EH_TIMEOUT')
    expect(text).toContain('主界面进程')
    expect(text).toContain('重启 Obox')
    expect(EXTENSION_HOST_FALLBACK_KEY).toBe('obox:extension-host:renderer-fallback')
  })
})

/* ============================================================================================ */
/* 5. 设置页那一项：位置、文案、读写接线                                                           */
/* ============================================================================================ */

describe('设置页「在独立进程中运行扩展」', () => {
  it('开关在「通用」分组里，且文案写清"需重启生效 / 关闭回到主界面进程 / 兼容旧行为"', () => {
    const src = settingsViewSource()
    // 右栏「通用」配置块的**模板**区间（左树节点里也有 `active === 'general'`，不能拿它当锚点）
    const generalStart = src.indexOf(`v-if="active === 'general'" class="config-block"`)
    const nextStart = src.indexOf(`v-else-if="active === 'language'"`)
    expect(generalStart).toBeGreaterThan(-1)
    expect(nextStart).toBeGreaterThan(generalStart)
    const block = src.slice(generalStart, nextStart)

    expect(block).toContain('在独立进程中运行扩展')
    expect(block).toContain('Extension Host')
    expect(block).toContain('需重启 Obox 后生效')
    expect(block).toContain('关闭后扩展回到主界面进程执行')
    expect(block).toContain('兼容旧行为')
    // 是 checkbox（开关），并接了唯一的写值入口
    expect(block).toContain('type="checkbox"')
    expect(block).toContain('onExtensionHostToggle')
    expect(block).toContain('extensionHostOn()')
  })

  it('读写接线：读 `readExtensionHostSwitch`（当前生效值），写 `stateStore.setExtensionHostEnabled`', () => {
    const src = settingsViewSource()
    expect(src).toContain('readExtensionHostSwitch(')
    expect(src).toContain('stateStore.setExtensionHostEnabled(')
    // 写之前先清回退标记（否则开关看起来没反应）
    expect(src).toContain('clearRendererFallback()')
    // 显示"当前生效"的来源，避免"勾着却没生效"的困惑
    expect(src).toContain('EXTENSION_HOST_SOURCE_TEXT')
    expect(src).toContain('当前生效：')
  })

  it('变更**不热切换**：有明确的重启提示，且不出现任何"立即重启宿主/重载宿主"的接线', () => {
    const src = settingsViewSource()
    expect(src).toContain('已保存，重启 Obox 后生效')
    // 不在设置页做热切换（EH-D2a 需求 3）：没有 ehStop/ehStart 调用
    expect(src).not.toContain('ehStop')
    expect(src).not.toContain('ehStart(')
    expect(src).not.toContain('location.reload')
  })

  it('回退提示在设置页可见（红字一行，来自 sessionStorage 里的回退标记）', () => {
    const src = settingsViewSource()
    expect(src).toContain('extensionHostFallbackNotice()')
    expect(src).toContain('extensionHostFallbackText()')
    expect(src).toContain('class="config-error"')
  })
})
