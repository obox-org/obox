/**
 * EH-A4 · 渲染侧扩展宿主桥 + 清单交接 + 回退开关 的单测。
 *
 * 判据来自 `docs/adr/0026-extension-host-process.md` 与 `docs/extension-host-migration.md` 的
 * EH-A4 行，以及本卡的第一原则「**默认行为零变化**」：
 *
 * - 开关关闭（默认）⇒ `ehStart` 一次都不发、宿主不 start、用户扩展照旧在渲染进程激活；
 * - 开关打开 ⇒ 清单形状正确（过协议守卫）、渲染侧只注册贡献点不做用户扩展激活、端口到达后桥可用；
 * - 桥本身：`checkSerializable` 失败带**字段路径**、req/res 按 id 配对（乱序也要对）、超时、
 *   `event` / `log` 分发、状态订阅收到 phase 变化与崩溃原因、端口未到给中文可执行错误（不 panic）。
 *
 * 三条装配线各自取"最小可测"的驱动方式，都不起真进程、不开窗口：
 * 1. **桥**：注入假 `ExtensionHostChannel`（含"端口到没到"开关与手动投递）；
 * 2. **渲染侧交接 / 激活**：用 `vi.mock` 替掉 `TreeView.vue`，装一个假的 `window`
 *    （`api.ehStart` 是 spy），直接跑真实的 `core/host.ts` + `core/loader.ts`；
 * 3. **main 侧不 start**：注入假 `fork` / 假端口，断言"构造不 fork、只有 `start(清单)` 才 fork，
 *    且 `init.extensions` 就是传进来的清单"；再对 `src/main/index.ts` 做结构门禁
 *    （`starter.start(` 只在 `eh:start` 处理器里出现一次）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EH_ERROR_TEXT,
  EhProtocolError,
  PROTOCOL_VERSION,
  createInitializedEnvelope,
  createReadyEnvelope,
  validateEnvelope,
  type Envelope,
  type HostedExtensionInfo
} from '../src/shared/extensionHostProtocol'
import {
  ANY_EVENT_CHANNEL,
  EXTENSION_HOST_ENV,
  createExtensionHostBridge,
  handOverToExtensionHost,
  isExtensionHostEnabled,
  notReadyMessage,
  type ExtensionHostBridgeLogger,
  type ExtensionHostChannel
} from '../src/renderer/src/core/extensionHostBridge'
import { collectHostedExtensions } from '../src/renderer/src/core/loader'
import type { ExtensionHostPhase, ExtensionHostStatusSnapshot } from '../src/shared/types'

/* -------------------------------------------------------------------------------------------- */
/* Electron 假实现（只为让 main 侧模块的顶层 import 不炸；本文件不起进程、不开窗口）              */
/* -------------------------------------------------------------------------------------------- */

const electronMock = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    ipcHandlers,
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown): void => {
        ipcHandlers.set(channel, handler)
      },
      removeHandler: (channel: string): void => {
        ipcHandlers.delete(channel)
      }
    },
    app: { getName: (): string => 'obox', getPath: (): string => 'C:\\userData' },
    BrowserWindow: class {},
    Tray: class {},
    Menu: {},
    nativeImage: {},
    dialog: {},
    shell: {},
    clipboard: {},
    utilityProcess: {
      fork: (): never => {
        throw new Error('单测必须注入假 utilityProcess：不允许真的 fork 宿主')
      }
    },
    MessageChannelMain: class {}
  }
})

vi.mock('electron', () => electronMock)
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
// host.ts 顶层 import 了那个 SFC，node 环境里必须替掉才能 import 宿主
vi.mock('../src/renderer/src/components/TreeView.vue', () => ({ default: {} }))

import { host } from '../src/renderer/src/core/host'
import {
  createExtensionHostStarter,
  type ExtensionHostForkOptions,
  type ExtensionHostPortLike,
  type ExtensionHostProcessLike,
  type ExtensionHostTimers
} from '../src/main/extensionHostStarter'

/* -------------------------------------------------------------------------------------------- */
/* 小工具                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** 读仓库文件（相对本测试文件；UTF-8） */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

/** 静默日志器（默认 console 会把测试输出刷满；需要断言时读 `lines`） */
function createLogger(): ExtensionHostBridgeLogger & { lines: string[] } {
  const lines: string[] = []
  const push =
    (level: string) =>
    (message: string): void => {
      lines.push(`${level}: ${message}`)
    }
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error')
  }
}

/** 状态快照夹具（`phase` 之外一律给"从未发生"的中性值） */
function status(
  phase: ExtensionHostPhase,
  extra: Partial<ExtensionHostStatusSnapshot> = {}
): ExtensionHostStatusSnapshot {
  return {
    phase,
    hostId: null,
    pid: null,
    crashCount: 0,
    lastCrash: null,
    lastAckAt: null,
    ...extra
  }
}

/** `HostedExtensionInfo` 夹具 */
function hosted(id: string, extra: Partial<HostedExtensionInfo> = {}): HostedExtensionInfo {
  return {
    id,
    version: '1.0.0',
    path: `/extensions/${id}`,
    activationEvents: ['*'],
    apiVersion: 1,
    ...extra
  }
}

/* -------------------------------------------------------------------------------------------- */
/* 假通道：模拟"端口到没到" + 手动投递宿主消息                                                    */
/* -------------------------------------------------------------------------------------------- */

interface FakeChannel extends ExtensionHostChannel {
  /** 已发出的信封（按发送顺序） */
  sent: Envelope[]
  /** 端口是否可用 */
  ready: boolean
  /** readStatus 的返回值 */
  snapshot: ExtensionHostStatusSnapshot
  /** 投递一条"宿主 → 渲染侧"的原始消息 */
  deliver(raw: unknown): void
  /** 推一次状态变化（等价于主进程的 eh:status） */
  emitStatus(next: ExtensionHostStatusSnapshot): void
}

function createFakeChannel(): FakeChannel {
  const envelopeListeners = new Set<(raw: unknown) => void>()
  const statusListeners = new Set<(next: ExtensionHostStatusSnapshot) => void>()
  const channel: FakeChannel = {
    sent: [],
    ready: true,
    snapshot: status('starting'),
    deliver: (raw): void => {
      for (const listener of [...envelopeListeners]) listener(raw)
    },
    emitStatus: (next): void => {
      channel.snapshot = next
      for (const listener of [...statusListeners]) listener(next)
    },
    isReady: (): boolean => channel.ready,
    send: (envelope): boolean => {
      if (!channel.ready) return false
      channel.sent.push(envelope)
      return true
    },
    onEnvelope: (listener): (() => void) => {
      envelopeListeners.add(listener)
      return (): void => {
        envelopeListeners.delete(listener)
      }
    },
    onStatus: (listener): (() => void) => {
      statusListeners.add(listener)
      return (): void => {
        statusListeners.delete(listener)
      }
    },
    readStatus: async (): Promise<ExtensionHostStatusSnapshot | null> => channel.snapshot,
    readPortStatus: async () => ({
      phase: channel.snapshot.phase,
      portDelivered: channel.ready,
      portPending: !channel.ready,
      hostId: channel.snapshot.hostId,
      pid: channel.snapshot.pid,
      channel: 'eh:port',
      protocolVersion: PROTOCOL_VERSION
    })
  }
  return channel
}

/* ============================================================================================ */
/* 1. 回退开关判定                                                                               */
/* ============================================================================================ */

describe('回退开关 OBOX_EXTENSION_HOST：只有 1 / true 才启用', () => {
  it('启用值：1 / true（大小写与空白不敏感）', () => {
    for (const flag of ['1', 'true', 'TRUE', 'True', ' 1 ', ' true ']) {
      expect(isExtensionHostEnabled(flag), `flag=${JSON.stringify(flag)}`).toBe(true)
    }
  })

  it('关闭值：未设置 / null / 空串 / 0 / false / 其它任何值（含拼写错误）', () => {
    for (const flag of [undefined, null, '', '  ', '0', 'false', 'FALSE', 'no', 'on', '2', 'yes']) {
      expect(isExtensionHostEnabled(flag), `flag=${JSON.stringify(flag)}`).toBe(false)
    }
  })

  it('环境变量名固定为 OBOX_EXTENSION_HOST（改名等于改契约）', () => {
    expect(EXTENSION_HOST_ENV).toBe('OBOX_EXTENSION_HOST')
  })
})

/* ============================================================================================ */
/* 2. 桥：发送前校验                                                                             */
/* ============================================================================================ */

describe('桥 · 发送前校验（validateEnvelope + checkSerializable）', () => {
  it('checkSerializable 失败：抛 EH_UNSERIALIZABLE，文案含**字段路径**，且一个信封都不发', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })

    const error: unknown = await bridge
      .request('demo.save', { items: [{ title: 'a', onClick: (): void => undefined }] })
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(EhProtocolError)
    expect((error as EhProtocolError).code).toBe('EH_UNSERIALIZABLE')
    const message = (error as Error).message
    // 关键：路径要精确到出错的属性，而不是"某个值不行"
    expect(message).toContain('params.items[0].onClick')
    expect(message).toContain('函数')
    expect(message).toContain(EH_ERROR_TEXT.EH_UNSERIALIZABLE)
    expect(channel.sent).toHaveLength(0)
  })

  it('多种不可传输值都给中文种类（Map / 循环引用 / NaN / 类实例）', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    class Custom {
      value = 1
    }
    const cases: Array<{ params: unknown; expect: string }> = [
      { params: { m: new Map([['a', 1]]) }, expect: 'Map' },
      { params: { loop: circular }, expect: '循环引用' },
      { params: { n: Number.NaN }, expect: 'NaN' },
      { params: { c: new Custom() }, expect: '类实例' },
      { params: { u: undefined }, expect: 'undefined' }
    ]
    for (const item of cases) {
      const error: unknown = await bridge.request('demo.x', item.params).catch((e: unknown) => e)
      expect((error as EhProtocolError).code, item.expect).toBe('EH_UNSERIALIZABLE')
      expect((error as Error).message, item.expect).toContain(item.expect)
    }
    expect(channel.sent).toHaveLength(0)
  })

  it('方法名非法 ⇒ EH_INTERNAL（本地就拒，不发出去）', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    for (const method of ['', '   ']) {
      const error: unknown = await bridge.request(method).catch((e: unknown) => e)
      expect((error as EhProtocolError).code).toBe('EH_INTERNAL')
    }
    expect(channel.sent).toHaveLength(0)
  })

  it('帧超过 8 MB ⇒ EH_FRAME_TOO_LARGE（本地拒，提示分片/落盘）', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    const error: unknown = await bridge
      .request('demo.big', { blob: 'x'.repeat(9 * 1024 * 1024) })
      .catch((e: unknown) => e)
    expect((error as EhProtocolError).code).toBe('EH_FRAME_TOO_LARGE')
    expect((error as Error).message).toContain('8 MB')
    expect(channel.sent).toHaveLength(0)
  })
})

/* ============================================================================================ */
/* 3. 桥：req/res 配对、超时、错误、取消                                                          */
/* ============================================================================================ */

describe('桥 · req/res 配对与超时', () => {
  it('乱序响应按 id 配对（先发后回不影响）', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })

    const first = bridge.request<string>('a.one', { x: 1 })
    const second = bridge.request<string>('a.two')
    expect(channel.sent.map((env) => (env.t === 'req' ? env.id : -1))).toEqual([1, 2])
    expect(channel.sent[0]).toMatchObject({ t: 'req', method: 'a.one', params: { x: 1 } })

    // 故意先回第二个
    channel.deliver({ v: PROTOCOL_VERSION, t: 'res', id: 2, result: 'two' })
    channel.deliver({ v: PROTOCOL_VERSION, t: 'res', id: 1, result: 'one' })

    await expect(first).resolves.toBe('one')
    await expect(second).resolves.toBe('two')
    expect(bridge.pendingRequestCount()).toBe(0)
  })

  it('宿主 err 信封 ⇒ 原样带出 code / message / detail', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    const pending = bridge.request('demo.x')
    channel.deliver({
      v: PROTOCOL_VERSION,
      t: 'err',
      id: 1,
      code: 'EH_UNKNOWN_EXT',
      message: EH_ERROR_TEXT.EH_UNKNOWN_EXT,
      detail: 'ext=demo'
    })
    const error: unknown = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EhProtocolError)
    expect((error as EhProtocolError).code).toBe('EH_UNKNOWN_EXT')
    expect((error as Error).message).toContain(EH_ERROR_TEXT.EH_UNKNOWN_EXT)
    expect((error as Error).message).toContain('ext=demo')
  })

  it('超时 ⇒ EH_TIMEOUT，之后迟到的 res 不会炸、也不会再改结果', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, timeoutMs: 20, logger: createLogger() })
    const error: unknown = await bridge.request('slow.call').catch((e: unknown) => e)
    expect((error as EhProtocolError).code).toBe('EH_TIMEOUT')
    expect((error as Error).message).toContain('slow.call')
    expect(bridge.pendingRequestCount()).toBe(0)

    // 迟到的响应只记日志：不能抛、不能二次 settle
    expect(() =>
      channel.deliver({ v: PROTOCOL_VERSION, t: 'res', id: 1, result: 'late' })
    ).not.toThrow()
  })

  it('宿主 cancel ⇒ EH_CANCELLED（在途请求被结掉）', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    const pending = bridge.request('slow.call')
    channel.deliver({ v: PROTOCOL_VERSION, t: 'cancel', id: 1 })
    await expect(pending).rejects.toMatchObject({ code: 'EH_CANCELLED' })
    expect(bridge.pendingRequestCount()).toBe(0)
  })

  it('畸形信封只记日志，不 panic；宿主发起的 req 会被回 err（否则宿主永远等）', () => {
    const channel = createFakeChannel()
    const logger = createLogger()
    // 桥挂上订阅才收得到消息（本用例只断言"畸形/反向 req"的处理，不用桥的其它接口）
    createExtensionHostBridge({ channel, logger })

    expect(() => channel.deliver({ t: 'res', id: 1 })).not.toThrow()
    expect(logger.lines.join('\n')).toContain('畸形')

    channel.deliver({ v: PROTOCOL_VERSION, t: 'req', id: 77, method: 'ui.toast', params: null })
    expect(channel.sent.at(-1)).toMatchObject({ t: 'err', id: 77, code: 'EH_INTERNAL' })
  })

  it('dispose ⇒ 在途请求以 EH_CANCELLED 结束（页面卸载不留悬挂 promise）', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    const pending = bridge.request('x.y')
    bridge.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'EH_CANCELLED' })
    expect(bridge.pendingRequestCount()).toBe(0)
  })
})

/* ============================================================================================ */
/* 4. 桥：event / log 分发                                                                        */
/* ============================================================================================ */

describe('桥 · event 与 log 分发', () => {
  it('event 按 channel 精确分发，通配订阅收全部；未订阅只记 debug', () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    const byChannel: Array<[string, unknown]> = []
    const anyChannel: unknown[] = []
    bridge.onEvent('statusBar', (payload) => byChannel.push(['statusBar', payload]))
    bridge.onEvent(ANY_EVENT_CHANNEL, (payload) => anyChannel.push(payload))

    channel.deliver({
      v: PROTOCOL_VERSION,
      t: 'event',
      channel: 'statusBar',
      payload: { id: 'sb.one', text: 'hi' }
    })
    channel.deliver({
      v: PROTOCOL_VERSION,
      t: 'event',
      channel: 'theme',
      payload: { id: 'dark' }
    })

    expect(byChannel).toEqual([['statusBar', { id: 'sb.one', text: 'hi' }]])
    expect(anyChannel).toHaveLength(2)
  })

  it('log 转发到渲染侧 console（level 原样映射），并通知订阅者', () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    const seen: Array<[string, string]> = []
    bridge.onLog((level, message) => seen.push([level, message]))
    const spies = {
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    }
    try {
      channel.deliver({
        v: PROTOCOL_VERSION,
        t: 'log',
        level: 'info',
        message: '宿主开始加载扩展'
      })
      channel.deliver({ v: PROTOCOL_VERSION, t: 'log', level: 'warn', message: '慢请求' })

      // 断言必须在 mockRestore 之前：mockRestore 会清掉调用记录
      expect(spies.info).toHaveBeenCalledWith('[host] 宿主开始加载扩展')
      expect(spies.warn).toHaveBeenCalledWith('[host] 慢请求')
      expect(seen).toEqual([
        ['info', '宿主开始加载扩展'],
        ['warn', '慢请求']
      ])
    } finally {
      spies.info.mockRestore()
      spies.warn.mockRestore()
    }
  })
})

/* ============================================================================================ */
/* 5. 桥：状态可观测                                                                             */
/* ============================================================================================ */

describe('桥 · 状态订阅（phase 与最近崩溃原因）', () => {
  it('订阅者收到每次 phase 变化；getStatus 与 refreshStatus 都是最新快照', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    const phases: ExtensionHostPhase[] = []
    bridge.onStatus((next) => phases.push(next.phase))

    channel.emitStatus(status('starting'))
    channel.emitStatus(status('ready', { hostId: 'host-1', pid: 4321 }))
    expect(phases).toEqual(['starting', 'ready'])
    expect(bridge.getStatus()).toMatchObject({ phase: 'ready', hostId: 'host-1', pid: 4321 })

    // 崩溃：最近原因必须原样暴露给 A5 / 扩展管理器
    channel.snapshot = status('crashed', {
      crashCount: 3,
      lastCrash: { code: 1, at: 1700000000000 }
    })
    const refreshed = await bridge.refreshStatus()
    expect(refreshed.phase).toBe('crashed')
    expect(refreshed.crashCount).toBe(3)
    expect(refreshed.lastCrash).toEqual({ code: 1, at: 1700000000000 })
    expect(phases.at(-1)).toBe('crashed')
  })

  it('端口状态照 A2 的 eh:get-port 定义读（只有状态，没有端口）', async () => {
    const channel = createFakeChannel()
    channel.ready = false
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    const port = await bridge.getPortStatus()
    expect(port).not.toBeNull()
    expect(port).toMatchObject({
      channel: 'eh:port',
      protocolVersion: PROTOCOL_VERSION,
      portDelivered: false,
      portPending: true
    })
    // 端口对象不在返回值里（端口只能经 eh:port transfer）
    expect(port && 'port' in port).toBe(false)
  })

  it('notReadyMessage：每个 phase 都给"下一步动作"，不是复述错误名', () => {
    for (const phase of [
      'idle',
      'starting',
      'ready',
      'unresponsive',
      'crashed',
      'stopped'
    ] as const) {
      const text = notReadyMessage(status(phase))
      expect(text, phase).toContain('端口还没到')
      expect(text.length, phase).toBeGreaterThan(30)
    }
    expect(notReadyMessage(status('crashed', { lastCrash: { code: 9, at: 1 } }))).toContain(
      '退出码 9'
    )
  })
})

/* ============================================================================================ */
/* 6. 桥：端口未到时发送 ⇒ 中文可执行错误（不 panic）                                             */
/* ============================================================================================ */

describe('桥 · 端口未到时发送（不 panic）', () => {
  it('端口未到：抛 EH_NOT_READY + 中文可执行文案，不发出任何信封、不排队', async () => {
    const channel = createFakeChannel()
    channel.ready = false
    channel.snapshot = status('idle')
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })

    expect(bridge.isReady()).toBe(false)
    const error: unknown = await bridge.request('fs.readFile', { rel: 'a.txt' }).catch((e) => e)

    expect(error).toBeInstanceOf(EhProtocolError)
    expect((error as EhProtocolError).code).toBe('EH_NOT_READY')
    const message = (error as Error).message
    expect(message).toContain('端口还没到')
    // idle 分支必须指向开关（默认路径就是"不启用宿主"）
    expect(message).toContain(EXTENSION_HOST_ENV)
    expect(channel.sent).toHaveLength(0)
    expect(bridge.pendingRequestCount()).toBe(0)
  })

  it('端口到达后同一个桥立刻可用（订阅在"通道"上，不依赖端口先到）', async () => {
    const channel = createFakeChannel()
    channel.ready = false
    channel.snapshot = status('starting')
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    await expect(bridge.request('x.y')).rejects.toMatchObject({ code: 'EH_NOT_READY' })

    // main 交付端口 + 宿主 initialized
    channel.ready = true
    channel.emitStatus(status('ready', { hostId: 'host-1', pid: 7 }))
    expect(bridge.isReady()).toBe(true)

    const pending = bridge.request('fs.readFile', { rel: 'a.txt' })
    expect(channel.sent).toHaveLength(1)
    channel.deliver({
      v: PROTOCOL_VERSION,
      t: 'res',
      id: channel.sent[0].t === 'req' ? channel.sent[0].id : -1,
      result: { content: 'ok' }
    })
    await expect(pending).resolves.toEqual({ content: 'ok' })
  })

  it('发送瞬间端口断开（send 返回 false）⇒ 仍是 EH_NOT_READY，不悬挂', async () => {
    const channel = createFakeChannel()
    const bridge = createExtensionHostBridge({ channel, logger: createLogger() })
    // isReady 报 true，但 send 时链路已断（页面重建的竞态）
    const originalSend = channel.send
    channel.send = (): boolean => false
    try {
      await expect(bridge.request('x.y')).rejects.toMatchObject({ code: 'EH_NOT_READY' })
    } finally {
      channel.send = originalSend
    }
    expect(bridge.pendingRequestCount()).toBe(0)
  })
})

/* ============================================================================================ */
/* 7. 清单交接（开关关 / 开）                                                                     */
/* ============================================================================================ */

describe('清单交接 handOverToExtensionHost', () => {
  it('开关关闭 ⇒ 不 start、不发 IPC、清单为空、started 为 null', () => {
    const started: Array<HostedExtensionInfo[]> = []
    for (const flag of [undefined, null, '', '0', 'false', 'no']) {
      const result = handOverToExtensionHost({
        flag,
        extensions: [hosted('demo')],
        start: async (list) => {
          started.push(list)
          return { ok: true, hostId: 'h', pid: 1 }
        },
        logger: createLogger()
      })
      expect(result).toEqual({ enabled: false, extensions: [], started: null })
    }
    expect(started).toHaveLength(0)
  })

  it('开关打开 ⇒ 清单副本交给 start，结果透传', async () => {
    const received: Array<HostedExtensionInfo[]> = []
    const list = [hosted('a', { activationEvents: [{ command: 'demo.hello' }] }), hosted('b')]
    const result = handOverToExtensionHost({
      flag: 'TRUE',
      extensions: list,
      start: async (sent) => {
        received.push(sent)
        return { ok: true, hostId: 'host-1', pid: 42 }
      },
      logger: createLogger()
    })

    expect(result.enabled).toBe(true)
    expect(result.extensions).toEqual(list)
    await expect(result.started).resolves.toEqual({ ok: true, hostId: 'host-1', pid: 42 })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(list)
    // 副本：调用方之后再改数组，不会影响已经发出的请求
    expect(received[0]).not.toBe(list)
  })

  it('ehStart 抛错 ⇒ 永不 reject（降级成 ok:false + 日志），否则会打断 host.start', async () => {
    const logger = createLogger()
    const result = handOverToExtensionHost({
      flag: '1',
      extensions: [hosted('a')],
      start: async () => {
        throw new Error("No handler registered for 'eh:start'")
      },
      logger
    })
    await expect(result.started).resolves.toMatchObject({ ok: false, code: 'EH_INTERNAL' })
    expect(logger.lines.join('\n')).toContain('No handler registered')
  })
})

/* ============================================================================================ */
/* 8. 清单形状：loader.collectHostedExtensions                                                    */
/* ============================================================================================ */

/** 造一个 `ExtensionEntry` 形状的夹具（loader 的纯映射只读这些字段） */
function entry(
  id: string,
  source: 'builtin' | 'user' | 'debug',
  manifest: Record<string, unknown>,
  path?: string
): Parameters<typeof collectHostedExtensions>[0][number] {
  return {
    id,
    source,
    path,
    manifest: { name: id, version: '1.0.0', main: 'index.js', ...manifest },
    load: async () => ({})
  } as unknown as Parameters<typeof collectHostedExtensions>[0][number]
}

describe('清单形状 collectHostedExtensions（只收用户扩展）', () => {
  it('内置 / 调试扩展不进清单；用户扩展给 id/version/path/activationEvents/apiVersion', () => {
    const list = collectHostedExtensions([
      entry('builtin.one', 'builtin', {}),
      entry('user.one', 'user', { version: '2.3.4' }, '/extensions/user.one'),
      entry('debug.one', 'debug', {}, '/tmp/debug.one')
    ])
    expect(list).toEqual([
      {
        id: 'user.one',
        version: '2.3.4',
        path: '/extensions/user.one',
        activationEvents: ['*'],
        apiVersion: 1
      }
    ])
  })

  it('缺失 path 的用户扩展跳过（宿主没法加载它）', () => {
    const list = collectHostedExtensions([entry('user.nopath', 'user', {})])
    expect(list).toEqual([])
  })

  it('version 缺失/空白 ⇒ 0.0.0（空字符串会被信封校验拒掉）', () => {
    const list = collectHostedExtensions([
      entry('user.a', 'user', { version: '' }, '/e/a'),
      entry('user.b', 'user', { version: 42 }, '/e/b')
    ])
    expect(list.map((item) => item.version)).toEqual(['0.0.0', '0.0.0'])
  })

  it('activationEvents：缺省/空 ⇒ ["*"]；4 类事件都能解析；认不出的丢弃；全认不出回退 ["*"]', () => {
    const parsed = collectHostedExtensions([
      entry(
        'user.multi',
        'user',
        {
          activationEvents: ['onStartupFinished', 'onCommand:demo.hello', 'onView:demo.view']
        },
        '/e/multi'
      ),
      entry('user.none', 'user', { activationEvents: [] }, '/e/none'),
      entry(
        'user.unknown',
        'user',
        { activationEvents: ['onDebug:foo', 'onCommand:'] },
        '/e/unknown'
      ),
      entry(
        'user.mixed',
        'user',
        {
          activationEvents: ['onDebug:x', '*']
        },
        '/e/mixed'
      )
    ])
    expect(parsed[0].activationEvents).toEqual([
      'onStartupFinished',
      { command: 'demo.hello' },
      { view: 'demo.view' }
    ])
    expect(parsed[1].activationEvents).toEqual(['*'])
    // 全是认不出的 ⇒ 退回"立即激活"（宁可照旧，也不要永不激活）
    expect(parsed[2].activationEvents).toEqual(['*'])
    // 混着来 ⇒ 保留认得出的那个
    expect(parsed[3].activationEvents).toEqual(['*'])
  })

  it('apiVersion：声明 ≥1 的整数原样上报；缺失/0/非整数/字符串 ⇒ 1', () => {
    const list = collectHostedExtensions([
      entry('user.v2', 'user', { apiVersion: 2 }, '/e/v2'),
      entry('user.missing', 'user', {}, '/e/missing'),
      entry('user.zero', 'user', { apiVersion: 0 }, '/e/zero'),
      entry('user.float', 'user', { apiVersion: 1.5 }, '/e/float'),
      entry('user.string', 'user', { apiVersion: '3' }, '/e/string')
    ])
    expect(list.map((item) => item.apiVersion)).toEqual([2, 1, 1, 1, 1])
  })

  it('产出的每一项都能过协议的 init 信封守卫（宿主侧同一套校验）', () => {
    const list = collectHostedExtensions([
      entry(
        'user.ok',
        'user',
        {
          version: '1.0.0',
          apiVersion: 2,
          activationEvents: ['onCommand:demo.hello']
        },
        '/extensions/user.ok'
      )
    ])
    const checked = validateEnvelope({
      v: PROTOCOL_VERSION,
      t: 'init',
      apiVersion: 3,
      dataDir: '/userData',
      extensions: list
    })
    expect(checked.ok).toBe(true)
  })
})

/* ============================================================================================ */
/* 9. 渲染侧 host.start()：开关关闭 vs 打开（默认行为零变化）                                     */
/* ============================================================================================ */

/** 宿主启动用的 window 假面（`host.ts` 只读 window.api / window.events / window.eh） */
interface WindowStub {
  /** `api.ehStart` 收到的每一次清单 */
  ehStartCalls: Array<HostedExtensionInfo[]>
  /** `api.ehGetStatus` 被调用次数（桥的状态校准） */
  ehGetStatusCalls: number
  /** `eh.onStatus` 的订阅者数量（桥是否接上） */
  statusSubscribers: number
  window: Record<string, unknown>
}

function installWindow(options: { flag?: string | null } = {}): WindowStub {
  const calls: WindowStub = {
    ehStartCalls: [],
    ehGetStatusCalls: 0,
    statusSubscribers: 0,
    window: {}
  }
  const eh = {
    extensionHostFlag: options.flag ?? null,
    hasPort: (): boolean => false,
    onPort: (): (() => void) => (): void => undefined,
    onMessage: (): (() => void) => (): void => undefined,
    post: (): boolean => false,
    onStatus: (): (() => void) => {
      calls.statusSubscribers += 1
      return (): void => undefined
    }
  }
  calls.window = {
    eh,
    events: {
      on: (): (() => void) => (): void => undefined
    },
    api: {
      env: { platform: 'win32', arch: 'x64', nodeVersion: '20.0.0' },
      ehStart: async (list: HostedExtensionInfo[]): Promise<unknown> => {
        calls.ehStartCalls.push(list)
        return { ok: true, hostId: 'host-1', pid: 4321 }
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
      ehGetStatus: async (): Promise<unknown> => {
        calls.ehGetStatusCalls += 1
        return status('idle')
      },
      ehStop: async (): Promise<void> => undefined
    }
  }
  ;(globalThis as unknown as { window?: unknown }).window = calls.window
  return calls
}

/** 造一个会被 host.start 载入的扩展条目（`activated` 记录谁真的被激活了） */
function hostEntry(
  id: string,
  source: 'builtin' | 'user',
  activated: string[],
  path?: string
): Parameters<typeof host.start>[0]['builtins'][number] {
  return {
    id,
    source,
    path,
    manifest: { name: id, version: '1.0.0', main: 'index.js' },
    load: async () => ({
      default: (): void => {
        activated.push(id)
      }
    })
  }
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('渲染侧 host.start()：开关关闭 ⇒ 默认行为零变化', () => {
  it('显式关闭（OBOX_EXTENSION_HOST=0）⇒ 不 start 宿主、不交清单，用户扩展照旧在渲染进程激活', async () => {
    // 2.0.0 起「未设置」= **默认开**（EH-D2a，见 test/extension-host-flag.test.ts 的优先级表），
    // 所以"零变化"这条路径要用**显式关闭**来驱动。
    const stub = installWindow({ flag: '0' })
    const activated: string[] = []
    const builtin = hostEntry('off.builtin', 'builtin', activated)
    const user = hostEntry('off.user', 'user', activated, '/extensions/off.user')

    const infos = await host.start({ builtins: [builtin], userExtensions: [user] })

    // ① 一个 ehStart 都不发（= main 侧 start 不会被触发）
    expect(stub.ehStartCalls).toHaveLength(0)
    // ② 用户扩展仍在本进程被激活（既有路径）
    expect(activated).toEqual(['off.builtin', 'off.user'])
    // ③ 扩展列表照旧
    expect(infos.map((info) => info.id).sort()).toEqual(['off.builtin', 'off.user'])
    // ④ 桥没有接上（开关关闭时连状态订阅都不该发生）
    expect(stub.statusSubscribers).toBe(0)
    expect(stub.ehGetStatusCalls).toBe(0)
  })

  it('显式关闭值（0 / false）同样零变化', async () => {
    const activated: string[] = []
    for (const flag of ['0', 'false']) {
      const stub = installWindow({ flag })
      await host.start({
        builtins: [hostEntry(`off2.builtin.${flag}`, 'builtin', activated)],
        userExtensions: [hostEntry(`off2.user.${flag}`, 'user', activated, `/e/${flag}`)]
      })
      expect(stub.ehStartCalls, flag).toHaveLength(0)
    }
    expect(activated.filter((id) => id.includes('user'))).toHaveLength(2)
  })
})

describe('渲染侧 host.start()：开关打开 ⇒ 交接 + 跳过用户扩展激活', () => {
  it('清单形状正确、渲染侧只激活内置、宿主收到 start、桥已接上', async () => {
    const stub = installWindow({ flag: '1' })
    const activated: string[] = []
    const builtin = hostEntry('on.builtin', 'builtin', activated)
    const userA = hostEntry('on.usera', 'user', activated, '/extensions/on.usera')
    const userB = hostEntry('on.userb', 'user', activated, '/extensions/on.userb')

    const infos = await host.start({
      builtins: [builtin],
      userExtensions: [userA, userB]
    })

    // ① 只有内置扩展在本进程被激活；两个用户扩展都没在这里跑
    expect(activated).toEqual(['on.builtin'])
    // ② 扩展列表仍然完整（UI 的导航/状态栏/命令来自阶段一的贡献点注册）
    expect(infos.map((info) => info.id).sort()).toEqual(['on.builtin', 'on.usera', 'on.userb'])
    expect(infos.filter((info) => info.source === 'user').map((info) => info.isActive)).toEqual([
      false,
      false
    ])

    // ③ 清单交接了一次，形状逐字正确
    expect(stub.ehStartCalls).toHaveLength(1)
    expect(stub.ehStartCalls[0]).toEqual([
      {
        id: 'on.usera',
        version: '1.0.0',
        path: '/extensions/on.usera',
        activationEvents: ['*'],
        apiVersion: 1
      },
      {
        id: 'on.userb',
        version: '1.0.0',
        path: '/extensions/on.userb',
        activationEvents: ['*'],
        apiVersion: 1
      }
    ])
    // ④ 这份清单能过协议的 init 守卫（宿主会收到同一形状）
    const checked = validateEnvelope({
      v: PROTOCOL_VERSION,
      t: 'init',
      apiVersion: 3,
      dataDir: '/userData',
      extensions: stub.ehStartCalls[0]
    })
    expect(checked.ok).toBe(true)

    // ⑤ 桥接上了（状态订阅 + 一次状态校准）：A5 从这里拿 phase / 崩溃原因
    expect(stub.statusSubscribers).toBeGreaterThan(0)
    expect(stub.ehGetStatusCalls).toBeGreaterThan(0)
  })
})

/* ============================================================================================ */
/* 10. main 侧：构造不 fork、start(清单) 才 fork，且 init 带的就是这份清单                        */
/* ============================================================================================ */

interface FakeProcess extends ExtensionHostProcessLike {
  readonly posted: Array<{ message: unknown; transfer: unknown[] }>
  emitMessage(message: unknown): void
}

function createFakeProcess(): FakeProcess {
  const messageListeners: Array<(message: unknown) => void> = []
  const exitListeners: Array<(code: number) => void> = []
  const posted: Array<{ message: unknown; transfer: unknown[] }> = []
  return {
    pid: 4321,
    stdout: null,
    stderr: null,
    posted,
    on: (event: 'message' | 'exit', listener: (...args: never[]) => void): unknown => {
      if (event === 'message') messageListeners.push(listener as (message: unknown) => void)
      else exitListeners.push(listener as (code: number) => void)
      return undefined
    },
    postMessage: (message: unknown, transfer?: unknown[]): void => {
      posted.push({ message, transfer: transfer ?? [] })
    },
    kill: (): boolean => true,
    emitMessage: (message): void => {
      for (const listener of [...messageListeners]) listener(message)
    }
  }
}

const fakePort = (): ExtensionHostPortLike => ({
  postMessage: (): void => undefined,
  close: (): void => undefined
})

// 假定时器：永不触发（握手/判活的长定时器在单测里不需要跑）
const neverTimers: ExtensionHostTimers = {
  setTimeout: (): unknown => 0,
  clearTimeout: (): void => undefined,
  now: (): number => 1_700_000_000_000
}

describe('main 侧启动器：默认不 start，清单只在 start(extensions) 时进 init', () => {
  it('构造不 fork；start(清单) 才 fork，init.extensions 就是传入的清单', async () => {
    const forked: Array<{ entry: string; options: ExtensionHostForkOptions }> = []
    const processes: FakeProcess[] = []
    const starter = createExtensionHostStarter({
      entryPoint: 'C:\\app\\out\\main\\extension-host.js',
      dataDir: 'C:\\userData',
      deps: {
        fork: (entryPoint, _args, options): ExtensionHostProcessLike => {
          forked.push({ entry: entryPoint, options })
          const child = createFakeProcess()
          processes.push(child)
          return child
        },
        createMessageChannel: () => ({ port1: fakePort(), port2: fakePort() }),
        getRendererTarget: (): null => null,
        forceKill: (): void => undefined,
        timers: neverTimers,
        logger: {
          debug: (): void => undefined,
          info: (): void => undefined,
          warn: (): void => undefined,
          error: (): void => undefined
        }
      }
    })

    // ① 只构造：一个进程都不该起来（"启动由渲染侧请求触发"）
    expect(forked).toHaveLength(0)
    expect(starter.getStatus().phase).toBe('idle')

    // ② 交接带来清单后才 fork
    const list = [hosted('user.one', { apiVersion: 2 })]
    const startPromise = starter.start(list)
    expect(forked).toHaveLength(1)
    expect(forked[0].options.serviceName).toBe('extension-host')

    // ③ ready → init（port1 走 transfer，清单在信封里）
    processes[0].emitMessage(createReadyEnvelope('host-1', 4321))
    const init = processes[0].posted.find((item) => (item.message as Envelope).t === 'init')
    expect(init).toBeDefined()
    expect((init?.message as { extensions: HostedExtensionInfo[] }).extensions).toEqual(list)
    expect(init?.transfer).toHaveLength(1)

    // ④ initialized → ready，start() 回结构化成功
    processes[0].emitMessage(createInitializedEnvelope())
    await expect(startPromise).resolves.toEqual({ ok: true, hostId: 'host-1', pid: 4321 })
    expect(starter.getStatus()).toMatchObject({ phase: 'ready', hostId: 'host-1', pid: 4321 })
  })
})

/* ============================================================================================ */
/* 11. 结构门禁：接线不能悄悄改动（start 只能来自 eh:start；端口必须 start()）                     */
/* ============================================================================================ */

describe('结构门禁（读源码断言接线，防止默认路径被悄悄改回"启动即 start"）', () => {
  it('src/main/index.ts：starter.start( 只出现一次，且就在 EH_START_IPC 的处理器里', () => {
    const src = read('../src/main/index.ts')
    const positions = [...src.matchAll(/starter\.start\(/g)].map((match) => match.index ?? -1)
    expect(positions).toHaveLength(1)
    const before = src.slice(Math.max(0, positions[0] - 3000), positions[0])
    expect(before).toContain('EH_START_IPC')
    // 处理器里必须先校验清单形状再 start（main 不信单侧）
    expect(before).toContain('validateEnvelope')
    // 状态迁移必须广播给窗口（A5 的展示依赖它）
    expect(src).toContain('starter.onStatus(broadcastExtensionHostStatus)')
    expect(src).toContain("EH_STATUS_IPC = 'eh:get-status'")
  })

  it('src/preload/index.ts：监听 eh:port 并 port.start()，把端口代理暴露为 window.eh', () => {
    const src = read('../src/preload/index.ts')
    expect(src).toContain("ipcRenderer.on('eh:port'")
    expect(src).toContain('port.start()')
    expect(src).toContain("contextBridge.exposeInMainWorld('eh', eh)")
    expect(src).toContain("ipcRenderer.invoke('eh:start'")
    expect(src).toContain("ipcRenderer.invoke('eh:get-port'")
    expect(src).toContain("ipcRenderer.invoke('eh:get-status'")
    expect(src).toContain("ipcRenderer.invoke('eh:stop'")
  })

  it('MainApi / MainEvents 的契约与 preload 的 channel 名一致', () => {
    const types = read('../src/shared/types.ts')
    for (const method of ['ehStart', 'ehGetPort', 'ehGetStatus', 'ehStop']) {
      expect(types, method).toContain(`  ${method}(`)
    }
    expect(types).toContain("'eh:status': (status: ExtensionHostStatusSnapshot) => void")
    // 通道名与 preload 对得上（拼错就是"永远收不到"，编译期看不出来）
    const preload = read('../src/preload/index.ts')
    const main = read('../src/main/index.ts')
    for (const channel of ['eh:start', 'eh:stop', 'eh:get-status', 'eh:status']) {
      expect(preload, channel).toContain(`'${channel}'`)
      expect(main, channel).toContain(`'${channel}'`)
    }
  })
})

/* ============================================================================================ */
/* 12. 泛型小测试：任何 phase 都不能把 host.start 的既有路径带歪（守住"零变化"的默认值）           */
/* ============================================================================================ */

describe('零变化兜底', () => {
  it('子窗口模式（activateExtensions:false）即便开关打开也不交接、不启动宿主', async () => {
    const stub = installWindow({ flag: '1' })
    const activated: string[] = []
    await host.start({
      builtins: [hostEntry('child.builtin', 'builtin', activated)],
      userExtensions: [hostEntry('child.user', 'user', activated, '/extensions/child.user')],
      activateExtensions: false
    })
    // 子窗口只注册贡献点：既不激活扩展，也不启动宿主
    expect(activated).toEqual([])
    expect(stub.ehStartCalls).toHaveLength(0)
    expect(stub.statusSubscribers).toBe(0)
  })
})
