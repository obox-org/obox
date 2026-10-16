/**
 * overlay 窗体门禁（卡 03 · host-overlay-window；pet-desktop-companion design D-1/D-2/D-3/D-11）。
 *
 * 测试策略三层（`test/**` 不在 typecheck 范围，沿用仓库既有惯例）：
 * 1. **主进程功能测试**：`vi.mock('electron')` 后跑**真实的** `src/main/appWindow.ts`
 *    （先例：test/ipc-server.test.ts、test/ipc-reconnect.test.ts）——创建参数映射（11 个窗体
 *    选项逐个断言）、四个 anchor 的定位公式、destroy 真销毁 + pending 清理 + 幂等、
 *    setMouseThrough 穿透切换、作用域安全（越权拒绝）、参数校验负向矩阵、生命周期联动；
 * 2. **宿主功能测试**：真实的 `src/renderer/src/core/host.ts`（先例：test/ipc-renderer-close.test.ts
 *    的 electron + TreeView.vue mock + window 仿真）——api.overlay 接线、消息路由三分支
 *    （卡片命中 / overlayId 兜底 / 都未命中回既有错误）、停用与热移除回收 overlay、不进 appStore；
 * 3. **源码文本断言**：AppWindow.vue / main.css / main.ts 的五处透明改动与回归面
 *    （先例：test/app-window-wiring.test.ts）、preload 桥接、MainApi 签名、api/types.ts 必填翻转、
 *    main/index.ts 注册、60s 超时不缩短。
 *
 * 验收映射（任务卡 4-①…⑧）：① 创建参数映射 → describe「create 参数映射」；② anchor 公式 →
 * 「四个 anchor 的定位公式」；③ destroy 清理与幂等 → 「destroy」；④ 穿透 → 「setMouseThrough」；
 * ⑤ 作用域 → 「作用域安全」；⑥ 外壳透明与回归 → 「五处透明改动」；⑦ 消息路由 → 「消息路由」；
 * ⑧ 停用回收 + 主窗关闭 → 「api.overlay 接线与回收」「生命周期联动」。
 *
 * 卡 14（host-overlay-setposition）增补：第四方法 `setPosition(id, x, y)` —— 宿主兜底钳位
 * （扩展主钳，design D-13）、非法坐标不钳不猜、作用域与「不存在」口径与 setMouseThrough 同构、
 * 移动不改变其它窗体属性、`OverlayResult.position` 回传钳后坐标 → describe「主进程 · setPosition」；
 * 宿主接线（extId 闭包绑定逐字转发）→「宿主 · api.overlay 接线与回收」；preload 第四条桥接与
 * MainApi 第四签名 → 「桥接面」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ExtensionActivationApi, ExtensionInfo } from '../src/api'

// ---- 共享 mock 状态（vi.hoisted：vi.mock 工厂被提升，只能引用 hoisted 值） ----
const mock = vi.hoisted(() => ({
  /** screen.getPrimaryDisplay().workArea 的假数据（每个测试可改写） */
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  /** ipcMain.handle 注册表 */
  handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
  /** ipcMain.on 注册表（'extension:reply'） */
  ipcOn: new Map<string, (e: unknown, ...args: unknown[]) => void>(),
  /** 已创建且未销毁的窗口（= BrowserWindow.getAllWindows 的返回） */
  windows: [] as unknown[],
  /** webContents.id 发号器 */
  nextId: 1
}))

/** mock 窗体的测试侧视图（字段与 electron mock 工厂里的 MockBrowserWindow 一一对应） */
interface MockWin {
  opts: Record<string, unknown>
  url: string
  shown: boolean
  destroyed: boolean
  destroyCalls: number
  closeCalls: number
  ignoreCalls: Array<[boolean, { forward?: boolean }?]>
  /** win.setPosition 的调用记录（卡 14：setPosition 只应触碰位置，不动其它窗体方法） */
  positionCalls: Array<[number, number]>
  webContents: { id: number; sent: Array<[string, unknown]> }
  getBounds(): { x: number; y: number; width: number; height: number }
  fire(ev: string, ...args: unknown[]): void
  wcFire(ev: string, ...args: unknown[]): void
}

vi.mock('electron', () => {
  class MockBrowserWindow {
    opts: Record<string, unknown>
    url = ''
    shown = false
    destroyed = false
    destroyCalls = 0
    closeCalls = 0
    ignoreCalls: Array<[boolean, { forward?: boolean }?]> = []
    positionCalls: Array<[number, number]> = []
    private listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    webContents = {
      id: mock.nextId++,
      sent: [] as Array<[string, unknown]>,
      listeners: new Map<string, Array<(...a: unknown[]) => void>>(),
      on: (ev: string, cb: (...a: unknown[]) => void): void => {
        const list = this.webContents.listeners.get(ev) ?? []
        list.push(cb)
        this.webContents.listeners.set(ev, list)
      },
      send: (channel: string, payload: unknown): void => {
        this.webContents.sent.push([channel, payload])
      },
      getURL: (): string => this.url
    }

    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      mock.windows.push(this)
    }
    loadURL(u: string): Promise<void> {
      this.url = u
      return Promise.resolve()
    }
    on(ev: string, cb: (...a: unknown[]) => void): void {
      const list = this.listeners.get(ev) ?? []
      list.push(cb)
      this.listeners.set(ev, list)
    }
    /** 测试侧触发窗体事件（ready-to-show / closed） */
    fire(ev: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(ev) ?? []) cb(...args)
    }
    /** 测试侧触发 webContents 事件（console-message / render-process-gone） */
    wcFire(ev: string, ...args: unknown[]): void {
      for (const cb of this.webContents.listeners.get(ev) ?? []) cb(...args)
    }
    show(): void {
      this.shown = true
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyCalls += 1
      if (!this.destroyed) {
        this.destroyed = true
        this.fire('closed')
      }
    }
    close(): void {
      this.closeCalls += 1
      if (!this.destroyed) {
        this.destroyed = true
        this.fire('closed')
      }
    }
    setIgnoreMouseEvents(ignore: boolean, opts?: { forward?: boolean }): void {
      this.ignoreCalls.push([ignore, opts])
    }
    /** 当前 bounds = 创建参数 (x,y,width,height) 叠加 setPosition 的累计移动（卡 14） */
    getBounds(): { x: number; y: number; width: number; height: number } {
      return {
        x: (this.opts.x as number) ?? 0,
        y: (this.opts.y as number) ?? 0,
        width: (this.opts.width as number) ?? 0,
        height: (this.opts.height as number) ?? 0
      }
    }
    setPosition(x: number, y: number): void {
      this.positionCalls.push([x, y])
      this.opts.x = x
      this.opts.y = y
    }
    static getAllWindows(): MockBrowserWindow[] {
      return mock.windows.filter((w) => !(w as MockBrowserWindow).destroyed)
    }
    static getFocusedWindow(): undefined {
      return undefined
    }
  }
  return {
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void => {
        mock.handlers.set(channel, fn)
      },
      on: (channel: string, fn: (e: unknown, ...args: unknown[]) => void): void => {
        mock.ipcOn.set(channel, fn)
      }
    },
    screen: {
      getPrimaryDisplay: (): { workArea: typeof mock.workArea } => ({ workArea: mock.workArea })
    }
  }
})

// appWindow.ts 用到 is.dev（urlForChild 分支）；固定 false ⇒ 走 file:// 路径（查询串断言不受 dev server 影响）
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
// appWindow.ts 只用到 getUserExtensionsDir（App 卡片图标路径）；mock 掉避免拖入 capabilities 的重依赖
vi.mock('../src/main/capabilities', () => ({
  getUserExtensionsDir: (): string => 'X:\\fake\\userData\\extensions'
}))
// host.ts 顶层 import 了 TreeView.vue（SFC，node 环境跑不了）——先例：test/ipc-renderer-close.test.ts
vi.mock('../src/renderer/src/components/TreeView.vue', () => ({ default: {} }))

// appWindow.ts 用 __dirname 拼 preload / renderer 路径；vitest 按 ESM 跑模块没有该绑定，补一个全局假值
;(globalThis as Record<string, unknown>).__dirname = 'X:\\fake\\out\\main'

// 真实的宿主与清单工具（静态导入：host 是单例，跨测试共享；私有成员经窄化 cast 触达，先例同上）
import { host, resolveMessageExtId } from '../src/renderer/src/core/host'
import { makeExtensionInfo } from '../src/renderer/src/core/manifest'
import { appStore } from '../src/renderer/src/core/appStore'

type AppWindowModule = typeof import('../src/main/appWindow')
let mod: AppWindowModule

// console 三件套的统一 spy（全局 beforeEach 装、afterEach restoreAllMocks 收）：
// 既给日志断言用，也静音 [overlay]/[host]/[app] persist 噪音，保持门槛输出干净
let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

/** 设计 D-1 的真实参数集（pet 右下角 220×460 透明置顶窗体） */
const PET_REQ = {
  id: 'pet.overlay',
  url: 'app://extensions/pet/overlay.html',
  width: 220,
  height: 460,
  anchor: 'bottom-right',
  margin: 24,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true
}

/** 每个测试拿全新的 appWindow 模块实例（overlays / pendingReplies / reqSeq 都是模块级状态） */
beforeEach(async () => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.resetModules()
  mock.handlers.clear()
  mock.ipcOn.clear()
  mock.windows.length = 0
  mock.nextId = 1
  mock.workArea = { x: 0, y: 0, width: 1920, height: 1040 }
  mod = await import('../src/main/appWindow')
  mod.registerOverlayIpc()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).window
})

/** 扮演 preload 的 ipcRenderer.invoke（overlay 通道不需要事件对象） */
function ipc(channel: string, ...args: unknown[]): unknown {
  const fn = mock.handlers.get(channel)
  if (!fn) throw new Error(`未注册的 handler: ${channel}`)
  return fn({}, ...args)
}

/** 同上，但带上 sender（'app:extension-message' 用 sender.id 追踪 pending 归属） */
function ipcFrom(channel: string, senderId: number, ...args: unknown[]): unknown {
  const fn = mock.handlers.get(channel)
  if (!fn) throw new Error(`未注册的 handler: ${channel}`)
  return fn({ sender: { id: senderId } }, ...args)
}

function createOverlay(
  extId: string,
  req: Record<string, unknown>
): { ok: boolean; error?: string; position?: { x: number; y: number } } {
  return ipc('overlay:create', extId, req) as {
    ok: boolean
    error?: string
    position?: { x: number; y: number }
  }
}

function lastWin(): MockWin {
  return mock.windows[mock.windows.length - 1] as MockWin
}

/** 造一个"主窗口"（URL 不含 obox-window 标记 ⇒ 被 mainWindow() 认出来） */
async function fakeMainWindow(): Promise<MockWin> {
  const { BrowserWindow } = await import('electron')
  return new BrowserWindow({}) as unknown as MockWin
}

/** 下一个宏任务（让 Promise.then 链跑完） */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ============================ 主进程 · appWindow.ts ============================

describe('主进程 · create 参数映射（验收①；design D-1 / D-11 改动 1/5）', () => {
  it('pet 设计值：11 个 BrowserWindow 选项逐个断言 + 背景色 + 尺寸 + 右下角坐标', () => {
    const r = createOverlay('pet', { ...PET_REQ })
    // R31：create 成功即回传 position = anchor/margin 解析后的实际坐标（右下角 (1676,556)）
    expect(r).toEqual({ ok: true, position: { x: 1676, y: 556 } })
    expect(mock.windows).toHaveLength(1)
    const win = lastWin()
    // —— 11 个窗体选项逐个断言（任务卡 D-11 改动 1 的清单）——
    expect(win.opts.transparent).toBe(true)
    expect(win.opts.hasShadow).toBe(false)
    expect(win.opts.thickFrame).toBe(false)
    expect(win.opts.roundedCorners).toBe(false)
    expect(win.opts.acceptFirstMouse).toBe(true)
    expect(win.opts.alwaysOnTop).toBe(true)
    expect(win.opts.skipTaskbar).toBe(true)
    expect(win.opts.resizable).toBe(false)
    expect(win.opts.maximizable).toBe(false)
    expect(win.opts.frame).toBe(false)
    expect(win.opts.show).toBe(false)
    // —— 背景与尺寸/坐标 ——
    expect(win.opts.backgroundColor).toBe('#00000000')
    expect(win.opts.width).toBe(220)
    expect(win.opts.height).toBe(460)
    // workArea {0,0,1920,1040} + margin 24：x=1920-220-24=1676，y=1040-460-24=556
    expect(win.opts.x).toBe(1676)
    expect(win.opts.y).toBe(556)
  })

  it('show:false + ready-to-show 后才显示（避免创建瞬间闪底色）', () => {
    createOverlay('pet', { ...PET_REQ })
    const win = lastWin()
    expect(win.shown).toBe(false)
    win.fire('ready-to-show')
    expect(win.shown).toBe(true)
  })

  it('创建后默认鼠标穿透 true + forward:true（design D-2）', () => {
    createOverlay('pet', { ...PET_REQ })
    expect(lastWin().ignoreCalls).toEqual([[true, { forward: true }]])
  })

  it('查询串契约（R13）：五个参数名字与顺序固定，appId=overlayId，url 百分号编码', () => {
    createOverlay('pet', { ...PET_REQ })
    const url = lastWin().url
    expect(url.startsWith('file://')).toBe(true)
    expect(url).toContain(
      '?obox-window=overlay&extId=pet&overlayId=pet.overlay&appId=pet.overlay' +
        '&url=app%3A%2F%2Fextensions%2Fpet%2Foverlay.html'
    )
    // 纯函数同口径（外壳与文档引用的是同一份契约）
    expect(mod.overlayQuery('pet', 'pet.overlay', 'app://extensions/pet/overlay.html')).toBe(
      'obox-window=overlay&extId=pet&overlayId=pet.overlay&appId=pet.overlay' +
        '&url=app%3A%2F%2Fextensions%2Fpet%2Foverlay.html'
    )
  })

  it('非透明 overlay：backgroundColor 回落 #1e1e1e（#00000000 必须与 transparent:true 同用），三开关缺省 false，仍默认穿透', () => {
    const r = createOverlay('wid', {
      id: 'wid.min',
      url: 'app://extensions/wid/page.html',
      width: 100,
      height: 100,
      anchor: 'top-left'
    })
    // margin 缺省 24：top-left ⇒ 实际坐标 (24, 24)，position 原样回传
    expect(r).toEqual({ ok: true, position: { x: 24, y: 24 } })
    const win = lastWin()
    expect(win.opts.transparent).toBe(false)
    expect(win.opts.backgroundColor).toBe('#1e1e1e')
    expect(win.opts.alwaysOnTop).toBe(false)
    expect(win.opts.skipTaskbar).toBe(false)
    // 无边框四件套与穿透默认值不随 transparent 变化
    expect(win.opts.hasShadow).toBe(false)
    expect(win.opts.resizable).toBe(false)
    expect(win.ignoreCalls).toEqual([[true, { forward: true }]])
    // margin 缺省 24：top-left ⇒ (24, 24)
    expect(win.opts.x).toBe(24)
    expect(win.opts.y).toBe(24)
  })

  it('日志：[overlay] 前缀覆盖创建/销毁/穿透切换/越权拒绝；子窗口日志沿用 [child-renderer:<level>]', () => {
    createOverlay('pet', { ...PET_REQ })
    expect(
      logSpy.mock.calls.some((c) => String(c[0]).includes('[overlay] 已创建: pet/pet.overlay'))
    ).toBe(true)
    // 子窗口 console-message 转发（与 App 卡片子窗口同一条路径、同一前缀；error/warning 走 console.error）
    lastWin().wcFire('console-message', {
      level: 'info',
      message: 'hello',
      lineNumber: 3,
      sourceId: 'app://extensions/pet/overlay.html'
    })
    expect(
      logSpy.mock.calls.some((c) =>
        String(c[0]).includes('[child-renderer:info] app://extensions/pet/overlay.html:3')
      )
    ).toBe(true)
    lastWin().wcFire('console-message', {
      level: 'error',
      message: 'boom',
      lineNumber: 9,
      sourceId: 'app://extensions/pet/overlay.html'
    })
    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes('[child-renderer:error] app://extensions/pet/overlay.html:9')
      )
    ).toBe(true)
    ipc('overlay:set-mouse-through', 'pet', 'pet.overlay', false)
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('[overlay] 鼠标穿透=false'))).toBe(
      true
    )
    ipc('overlay:destroy', 'other', 'pet.overlay') // 越权
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[overlay] 越权被拒'))).toBe(true)
    ipc('overlay:destroy', 'pet', 'pet.overlay')
    expect(
      logSpy.mock.calls.some((c) => String(c[0]).includes('[overlay] 已销毁: pet/pet.overlay'))
    ).toBe(true)
  })
})

describe('主进程 · 四个 anchor 的定位公式（验收②；design D-1）', () => {
  it('overlayPosition 纯函数：假 workArea 下四角对称公式全部成立', () => {
    const wa = { x: 100, y: 50, width: 1920, height: 1040 }
    // 右下：x = wa.x + wa.width - w - margin；y = wa.y + wa.height - h - margin
    expect(mod.overlayPosition(wa, 220, 460, 'bottom-right', 24)).toEqual({ x: 1776, y: 606 })
    // 左下：x = wa.x + margin；y 同右下
    expect(mod.overlayPosition(wa, 220, 460, 'bottom-left', 24)).toEqual({ x: 124, y: 606 })
    // 右上：x 同右下；y = wa.y + margin
    expect(mod.overlayPosition(wa, 220, 460, 'top-right', 24)).toEqual({ x: 1776, y: 74 })
    // 左上：两轴都取原点 + margin
    expect(mod.overlayPosition(wa, 220, 460, 'top-left', 24)).toEqual({ x: 124, y: 74 })
  })

  it('margin 可为 0（贴角）；公式对负 workArea 原点（多显示器副屏坐标）同样成立', () => {
    expect(
      mod.overlayPosition({ x: 0, y: 0, width: 800, height: 600 }, 100, 100, 'bottom-right', 0)
    ).toEqual({
      x: 700,
      y: 500
    })
    expect(
      mod.overlayPosition(
        { x: -1920, y: 0, width: 1920, height: 1080 },
        100,
        100,
        'bottom-left',
        10
      )
    ).toEqual({ x: -1910, y: 970 })
  })

  it('create 走同一公式：top-right + margin 0 落在工作区右上角（screen.getPrimaryDisplay().workArea）', () => {
    mock.workArea = { x: 0, y: 0, width: 1920, height: 1040 }
    const r = createOverlay('pet', {
      id: 'pet.tr',
      url: 'app://extensions/pet/o.html',
      width: 220,
      height: 460,
      anchor: 'top-right',
      margin: 0
    })
    expect(r).toEqual({ ok: true, position: { x: 1700, y: 0 } })
    expect(lastWin().opts.x).toBe(1700)
    expect(lastWin().opts.y).toBe(0)
  })

  it('R31：create 成功回传 position = anchor/margin 解析后的实际坐标（与 overlayPosition 公式一致；四个 anchor 各断一次）', () => {
    // 期望值不硬编码，直接用既有 anchor 公式算（220×460、margin 24、workArea {0,0,1920,1040}）
    const anchors = [
      ['bottom-right', { x: 1676, y: 556 }],
      ['bottom-left', { x: 24, y: 556 }],
      ['top-right', { x: 1676, y: 24 }],
      ['top-left', { x: 24, y: 24 }]
    ] as const
    for (const [anchor, expected] of anchors) {
      const r = createOverlay('pet', { ...PET_REQ, id: `pet.${anchor}`, anchor })
      expect(r, `anchor=${anchor}`).toEqual({
        ok: true,
        position: mod.overlayPosition(mock.workArea, 220, 460, anchor, 24)
      })
      expect(r.position, `anchor=${anchor}`).toEqual(expected)
      // 回传坐标与窗体实际创建坐标是同一份（不重算、不漂移）
      expect(r.position).toEqual({ x: lastWin().opts.x, y: lastWin().opts.y })
    }
  })

  it('R31：create 失败路径不带 position（非法参数 / 重复 id 都只回 ok:false + error）', () => {
    const bad = createOverlay('pet', { ...PET_REQ, width: 0 })
    expect(bad.ok).toBe(false)
    expect(bad.position).toBeUndefined()
    // 成功一次后重复创建：失败且不带 position
    expect(createOverlay('pet', { ...PET_REQ })).toEqual({
      ok: true,
      position: { x: 1676, y: 556 }
    })
    const dup = createOverlay('pet', { ...PET_REQ })
    expect(dup.ok).toBe(false)
    expect(dup.position).toBeUndefined()
    // destroy/setMouseThrough 的成功回包也不带 position（R31 只扩了 create 与 setPosition）
    expect(ipc('overlay:set-mouse-through', 'pet', 'pet.overlay', false)).toEqual({ ok: true })
    expect(ipc('overlay:destroy', 'pet', 'pet.overlay')).toEqual({ ok: true })
  })
})

describe('主进程 · destroy：真销毁 + pending 清理 + 幂等（验收③）', () => {
  it('destroy 真销毁窗体（destroy 而非 hide），并把该窗口的 pending 桥请求立即以错误结算', async () => {
    const main = await fakeMainWindow()
    createOverlay('pet', { ...PET_REQ })
    const win = lastWin()

    // overlay 页面发一条长轮询（pet.subscribe 类）：此时应挂起等扩展回复
    const pending = ipcFrom('app:extension-message', win.webContents.id, {
      appId: 'pet.overlay',
      channel: 'pet.subscribe',
      payload: { rev: 0 }
    }) as Promise<{ ok: boolean; error?: string }>
    let settled: unknown = null
    void pending.then((r) => {
      settled = r
    })
    await tick()
    expect(settled).toBe(null) // 还没回复：pending 挂着（60s 超时前）
    // 消息确实转发到了主窗口宿主（overlay 路径复用同一桥）
    expect(main.webContents.sent[0]?.[0]).toBe('extension:message')
    const forwarded = main.webContents.sent[0]?.[1] as { requestId: number; appId: string }
    expect(forwarded.appId).toBe('pet.overlay')

    const r = ipc('overlay:destroy', 'pet', 'pet.overlay') as { ok: boolean }
    expect(r).toEqual({ ok: true })
    expect(win.destroyed).toBe(true)
    expect(win.destroyCalls).toBe(1)
    // 'closed' 清理：pending 立即结算，不再空等 60s
    expect(await pending).toEqual({ ok: false, error: 'overlay 窗体已销毁' })
    expect(settled).not.toBe(null)
    void forwarded.requestId
  })

  it('幂等：已销毁 / 不存在的 id 重复 destroy 静默成功（ok:true），且不再触碰窗体', () => {
    createOverlay('pet', { ...PET_REQ })
    const win = lastWin()
    expect(ipc('overlay:destroy', 'pet', 'pet.overlay')).toEqual({ ok: true })
    expect(ipc('overlay:destroy', 'pet', 'pet.overlay')).toEqual({ ok: true })
    expect(ipc('overlay:destroy', 'pet', 'pet.overlay')).toEqual({ ok: true })
    expect(win.destroyCalls).toBe(1)
    // 从未存在过的 id：同样静默成功（api/types.ts destroy 的 JSDoc 契约）
    expect(ipc('overlay:destroy', 'pet', 'ghost.overlay')).toEqual({ ok: true })
    expect(mock.windows).toHaveLength(1)
  })

  it('destroy 后同 id 可重建（登记表已被 closed 清理）', () => {
    createOverlay('pet', { ...PET_REQ })
    ipc('overlay:destroy', 'pet', 'pet.overlay')
    const again = createOverlay('pet', { ...PET_REQ })
    expect(again).toEqual({ ok: true, position: { x: 1676, y: 556 } })
    expect(mock.windows).toHaveLength(2)
  })

  it('id 参数非法（空串/非字符串）→ ok:false，不动任何窗体', () => {
    createOverlay('pet', { ...PET_REQ })
    expect((ipc('overlay:destroy', 'pet', '') as { ok: boolean }).ok).toBe(false)
    expect((ipc('overlay:destroy', 'pet', 42) as { ok: boolean }).ok).toBe(false)
    expect(lastWin().destroyed).toBe(false)
  })
})

describe('主进程 · setMouseThrough（验收④；design D-2）', () => {
  it('false → setIgnoreMouseEvents(false)；true → setIgnoreMouseEvents(true,{forward:true})', () => {
    createOverlay('pet', { ...PET_REQ })
    const win = lastWin()
    expect(win.ignoreCalls).toEqual([[true, { forward: true }]]) // 创建默认穿透

    expect(ipc('overlay:set-mouse-through', 'pet', 'pet.overlay', false)).toEqual({ ok: true })
    expect(win.ignoreCalls.at(-1)).toEqual([false, undefined])

    expect(ipc('overlay:set-mouse-through', 'pet', 'pet.overlay', true)).toEqual({ ok: true })
    expect(win.ignoreCalls.at(-1)).toEqual([true, { forward: true }])
  })

  it('不存在的 id → ok:false（错误含「不存在」），不产生任何窗体调用', () => {
    const r = ipc('overlay:set-mouse-through', 'pet', 'ghost.overlay', true) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不存在')
    expect(mock.windows).toHaveLength(0)
  })

  it('through 非布尔 → ok:false（错误含「布尔」），窗体穿透态不被触碰', () => {
    createOverlay('pet', { ...PET_REQ })
    const win = lastWin()
    for (const bad of ['true', 1, 0, null, undefined, {}]) {
      const r = ipc('overlay:set-mouse-through', 'pet', 'pet.overlay', bad) as {
        ok: boolean
        error?: string
      }
      expect(r.ok).toBe(false)
      expect(r.error).toContain('布尔')
    }
    expect(win.ignoreCalls).toEqual([[true, { forward: true }]]) // 只剩创建时的默认穿透
  })
})

describe('主进程 · setPosition（卡 14；宿主兜底钳位、扩展主钳，design D-13）', () => {
  /** 建 pet 窗体（220×460，workArea {0,0,1920,1040} 下右下角 (1676,556)）并返回 mock 视图 */
  function createPet(): MockWin {
    expect(createOverlay('pet', { ...PET_REQ })).toEqual({
      ok: true,
      position: { x: 1676, y: 556 }
    })
    return lastWin()
  }

  function setPosition(
    extId: unknown,
    id: unknown,
    x?: unknown,
    y?: unknown
  ): { ok: boolean; error?: string; position?: { x: number; y: number } } {
    return ipc('overlay:set-position', extId, id, x, y) as {
      ok: boolean
      error?: string
      position?: { x: number; y: number }
    }
  }

  it('合法坐标在工作区内：直接生效，position 回传实际坐标，win.setPosition 恰好一次', () => {
    const win = createPet()
    const r = setPosition('pet', 'pet.overlay', 100, 200)
    expect(r).toEqual({ ok: true, position: { x: 100, y: 200 } })
    expect(win.positionCalls).toEqual([[100, 200]])
    expect(win.getBounds()).toEqual({ x: 100, y: 200, width: 220, height: 460 })
    // 日志一条：[overlay] setPosition 前缀
    expect(
      logSpy.mock.calls.some((c) => String(c[0]).includes('[overlay] setPosition: pet/pet.overlay'))
    ).toBe(true)
  })

  it('超工作区坐标（验收③）：钳到 workArea 边界且回传 position = 钳后值；日志含钳前钳后坐标', () => {
    const win = createPet()
    // workArea {0,0,1920,1040}、窗体 220×460 ⇒ x 上限 1920-220=1700；y 下限 0
    const r = setPosition('pet', 'pet.overlay', 5000, -100)
    expect(r).toEqual({ ok: true, position: { x: 1700, y: 0 } })
    expect(win.positionCalls).toEqual([[1700, 0]])
    expect(
      logSpy.mock.calls.some(
        (c) =>
          String(c[0]).includes('[overlay] setPosition') &&
          String(c[0]).includes('(5000,-100)') &&
          String(c[0]).includes('钳制后(1700,0)')
      )
    ).toBe(true)
  })

  it('非零工作区原点（多显示器副屏坐标系）：下限钳到 wa.x/wa.y 而不是 0', () => {
    mock.workArea = { x: 100, y: 50, width: 1920, height: 1040 }
    // createPet 的期望坐标按缺省 workArea {0,0,…} 写死，这里 workArea 变了 ⇒ 直接建窗体，
    // create 回传坐标用既有 anchor 公式算（bottom-right：(1776, 606)）
    expect(createOverlay('pet', { ...PET_REQ })).toEqual({
      ok: true,
      position: mod.overlayPosition(mock.workArea, 220, 460, 'bottom-right', 24)
    })
    const win = lastWin()
    const r = setPosition('pet', 'pet.overlay', -9999, 0)
    expect(r).toEqual({ ok: true, position: { x: 100, y: 50 } })
    expect(win.positionCalls).toEqual([[100, 50]])
  })

  it('clampOverlayPosition 纯函数：与 D-13 扩展侧同公式；退化情形（窗体比工作区宽）以 min 为准', () => {
    expect(
      mod.clampOverlayPosition({ x: 0, y: 0, width: 1920, height: 1040 }, 220, 460, 5000, -100)
    ).toEqual({ x: 1700, y: 0 })
    expect(
      mod.clampOverlayPosition({ x: 100, y: 50, width: 800, height: 600 }, 100, 100, 99999, 99999)
    ).toEqual({ x: 800, y: 550 })
    // width > 工作区宽 ⇒ 上限塌缩到下限（保证左上角仍在工作区内，允许右侧溢出）
    expect(
      mod.clampOverlayPosition({ x: 0, y: 0, width: 800, height: 600 }, 1000, 100, 5000, 10)
    ).toEqual({ x: 0, y: 10 })
  })

  it('NaN / Infinity / 字符串 / 缺参坐标（验收② + 负向自检）：ok:false 不钳不猜，窗体不动', () => {
    const win = createPet()
    const before = win.getBounds()
    const bad: Array<[unknown, unknown]> = [
      [NaN, 100],
      [Infinity, -Infinity],
      [100, NaN],
      ['10', '20'],
      [10, '20'],
      [100, undefined], // 缺参
      [undefined, 50],
      [null, 50],
      [{}, 50]
    ]
    for (const [x, y] of bad) {
      const r = setPosition('pet', 'pet.overlay', x, y)
      expect(r.ok, `应拒绝：x=${String(x)} y=${String(y)}`).toBe(false)
      expect(typeof r.error).toBe('string')
      expect(r.error).toContain('setPosition')
      // 不钳不猜：拒绝时不回传任何"猜测/钳制"出来的坐标
      expect(r.position).toBeUndefined()
    }
    expect(win.positionCalls).toEqual([]) // 一次都没移动
    expect(win.getBounds()).toEqual(before)
  })

  it('id / extId 非法（负向自检）：空串 / 非字符串 / 缺失 ⇒ ok:false，不触碰窗体', () => {
    const win = createPet()
    expect(setPosition('pet', '', 10, 10).ok).toBe(false)
    expect(setPosition('pet', 42, 10, 10).ok).toBe(false)
    expect(setPosition('pet', undefined, 10, 10).ok).toBe(false)
    expect(setPosition('', 'pet.overlay', 10, 10).ok).toBe(false)
    expect(setPosition(undefined, 'pet.overlay', 10, 10).ok).toBe(false)
    expect(setPosition(42, 'pet.overlay', 10, 10).ok).toBe(false)
    expect(win.positionCalls).toEqual([])
  })

  it('不存在的 id（验收④）：ok:false（错误含「不存在」），与 setMouseThrough 同口径，不建窗体', () => {
    const r = setPosition('pet', 'ghost.overlay', 10, 10)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不存在')
    expect(r.position).toBeUndefined()
    expect(mock.windows).toHaveLength(0)
  })

  it('已销毁的 overlay 调 setPosition：ok:false（不抛错），错误含「不存在」', () => {
    createPet()
    expect(ipc('overlay:destroy', 'pet', 'pet.overlay')).toEqual({ ok: true })
    const r = setPosition('pet', 'pet.overlay', 10, 10)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不存在')
  })

  it('越权（验收① + 负向自检）：A 扩展 setPosition B 扩展的 overlay ⇒ ok:false + error 指认真实属主 + [overlay] warn + 窗体未移动', () => {
    // 100×100 bottom-right margin 24 ⇒ 实际坐标 (1796, 916)
    expect(
      createOverlay('ext-a', {
        id: 'a.win',
        url: 'app://extensions/ext-a/page.html',
        width: 100,
        height: 100,
        anchor: 'bottom-right'
      })
    ).toEqual({ ok: true, position: { x: 1796, y: 916 } })
    const win = lastWin()
    const before = win.getBounds()
    const r = setPosition('ext-b', 'a.win', 10, 10)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('越权')
    expect(r.error).toContain('ext-a') // 错误文案指认真实属主，可执行
    expect(r.error).toContain('ext-b')
    expect(r.position).toBeUndefined()
    expect(win.positionCalls).toEqual([])
    expect(win.getBounds()).toEqual(before)
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[overlay] 越权被拒'))).toBe(true)
    // 属主自己移动仍然可行
    expect(setPosition('ext-a', 'a.win', 300, 200)).toEqual({
      ok: true,
      position: { x: 300, y: 200 }
    })
  })

  it('移动不改变其它属性（验收⑤）：窗体选项与穿透态全部未被触碰', () => {
    const win = createPet()
    const snapshot = { ...win.opts }
    const r = setPosition('pet', 'pet.overlay', 300, 200)
    expect(r.ok).toBe(true)
    // 位置以外的窗体选项逐项不变（transparent/alwaysOnTop 等运行期属性一个都不动）
    for (const key of Object.keys(snapshot)) {
      if (key === 'x' || key === 'y') continue
      expect(win.opts[key], `opts.${key} 不应被 setPosition 触碰`).toBe(snapshot[key])
    }
    expect(win.opts.x).toBe(300)
    expect(win.opts.y).toBe(200)
    // 穿透态未被触碰：setIgnoreMouseEvents 仍只有创建时的默认穿透一次调用
    expect(win.ignoreCalls).toEqual([[true, { forward: true }]])
    // 移动后穿透切换照常可用（穿透态与位置互不影响）
    expect(ipc('overlay:set-mouse-through', 'pet', 'pet.overlay', false)).toEqual({ ok: true })
    expect(win.ignoreCalls.at(-1)).toEqual([false, undefined])
  })

  it('连续两次 setPosition（同 id）：最后一次生效、不崩溃（负向自检）', () => {
    const win = createPet()
    const r1 = setPosition('pet', 'pet.overlay', 100, 100)
    const r2 = setPosition('pet', 'pet.overlay', 300, 300)
    expect(r1).toEqual({ ok: true, position: { x: 100, y: 100 } })
    expect(r2).toEqual({ ok: true, position: { x: 300, y: 300 } })
    expect(win.positionCalls).toEqual([
      [100, 100],
      [300, 300]
    ])
    expect(win.getBounds()).toEqual({ x: 300, y: 300, width: 220, height: 460 })
  })
})

describe('主进程 · 作用域安全（验收⑤；design D-2/N4：只能操作自己创建的 overlay）', () => {
  it('A 扩展不能 destroy B 扩展的 overlay：ok:false + 窗体未被销毁 + console.warn 记 [overlay]', () => {
    createOverlay('ext-a', {
      id: 'shared.id',
      url: 'app://extensions/ext-a/page.html',
      width: 100,
      height: 100,
      anchor: 'bottom-right'
    })
    const win = lastWin()
    const r = ipc('overlay:destroy', 'ext-b', 'shared.id') as { ok: boolean; error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ext-a') // 错误文案指认真实属主，可执行
    expect(r.error).toContain('越权')
    expect(win.destroyed).toBe(false)
    expect(win.destroyCalls).toBe(0)
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[overlay]'))).toBe(true)
    // 属主自己销毁仍然可行
    expect(ipc('overlay:destroy', 'ext-a', 'shared.id')).toEqual({ ok: true })
    expect(win.destroyed).toBe(true)
  })

  it('A 扩展不能 setMouseThrough B 扩展的 overlay：ok:false + setIgnoreMouseEvents 未被追加调用', () => {
    createOverlay('ext-a', {
      id: 'a.win',
      url: 'app://extensions/ext-a/page.html',
      width: 100,
      height: 100,
      anchor: 'bottom-right'
    })
    const win = lastWin()
    const r = ipc('overlay:set-mouse-through', 'ext-b', 'a.win', false) as {
      ok: boolean
      error?: string
    }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('越权')
    expect(win.ignoreCalls).toEqual([[true, { forward: true }]]) // 仍只有创建时的默认穿透
  })

  it('同扩展同 id 重复 create 被拒（提示先 destroy）；跨扩展同 id 也被拒（消息路由按 overlayId 全局寻址）', () => {
    createOverlay('ext-a', {
      id: 'dup.id',
      url: 'app://extensions/ext-a/page.html',
      width: 100,
      height: 100,
      anchor: 'bottom-right'
    })
    const dup = createOverlay('ext-a', {
      id: 'dup.id',
      url: 'app://extensions/ext-a/other.html',
      width: 100,
      height: 100,
      anchor: 'bottom-right'
    })
    expect(dup.ok).toBe(false)
    expect(dup.error).toContain('重复创建')
    expect(dup.error).toContain("destroy('dup.id')")
    const cross = createOverlay('ext-b', {
      id: 'dup.id',
      url: 'app://extensions/ext-b/page.html',
      width: 100,
      height: 100,
      anchor: 'bottom-right'
    })
    expect(cross.ok).toBe(false)
    expect(cross.error).toContain('已被扩展 ext-a 占用')
    expect(mock.windows).toHaveLength(1) // 两次拒绝都没建窗体
  })

  it('url 越出扩展目录被拒：别人的扩展目录 / 非 app 协议 / .. 穿越 / 目录本身 / 未知 host', () => {
    const base = {
      width: 100,
      height: 100,
      anchor: 'bottom-right'
    }
    const bad = [
      ['app://extensions/other-ext/page.html', '别人的扩展目录'],
      ['https://evil.example/page.html', '非 app 协议'],
      ['http://extensions/pet/page.html', '协议冒充'],
      ['file:///C:/Windows/system32/x.html', 'file 协议'],
      ['app://extensions/pet/../other-ext/page.html', '.. 穿越'],
      ['app://extensions/pet', '目录本身（无子路径）'],
      ['app://extensions/pet/', '目录本身（斜杠结尾）'],
      ['app://unknown-host/pet/page.html', '未知 host'],
      ['overlay.html', '相对路径'],
      ['', '空串']
    ] as const
    for (const [url, label] of bad) {
      const r = createOverlay('pet', { ...base, id: `t.${Math.random()}`, url })
      expect(r.ok, `应拒绝：${label}（${url}）`).toBe(false)
    }
    expect(mock.windows).toHaveLength(0)
  })

  it('三个合法 host 都放行：extensions / builtin / debug（路径首段 = 调用方扩展 id；protocol.ts 的映射）', () => {
    expect(mod.isOverlayUrlInsideExtension('app://extensions/pet/overlay.html', 'pet')).toBe(true)
    expect(mod.isOverlayUrlInsideExtension('app://builtin/pet/overlay.html', 'pet')).toBe(true)
    expect(mod.isOverlayUrlInsideExtension('app://debug/pet/overlay.html', 'pet')).toBe(true)
    expect(mod.isOverlayUrlInsideExtension('app://debug/pet/o.html', 'other')).toBe(false)
    const r1 = createOverlay('pet', {
      id: 'p.builtin',
      url: 'app://builtin/pet/o.html',
      width: 10,
      height: 10,
      anchor: 'top-left'
    })
    const r2 = createOverlay('pet', {
      id: 'p.debug',
      url: 'app://debug/pet/o.html',
      width: 10,
      height: 10,
      anchor: 'top-left'
    })
    expect(r1).toEqual({ ok: true, position: { x: 24, y: 24 } })
    expect(r2).toEqual({ ok: true, position: { x: 24, y: 24 } })
  })

  it('create 非法参数矩阵：全部 ok:false 且一个窗体都不建（负向自检）', () => {
    const good = { ...PET_REQ }
    const cases: Array<[string, Record<string, unknown> | unknown]> = [
      ['缺 id', { ...good, id: undefined }],
      ['id 空串', { ...good, id: '  ' }],
      ['id 非字符串', { ...good, id: 7 }],
      ['缺 url', { ...good, url: undefined }],
      ['width=0', { ...good, width: 0 }],
      ['width<0', { ...good, width: -220 }],
      ['width 非数字', { ...good, width: '220' }],
      ['width=Infinity', { ...good, width: Infinity }],
      ['height=0', { ...good, height: 0 }],
      ['height<0', { ...good, height: -1 }],
      ['margin<0', { ...good, margin: -24 }],
      ['margin 非数字', { ...good, margin: '24' }],
      ['anchor 非枚举', { ...good, anchor: 'bottom-center' }],
      ['anchor 缺失', { ...good, anchor: undefined }],
      ['transparent 非布尔', { ...good, transparent: 'yes' }],
      ['alwaysOnTop 非布尔', { ...good, alwaysOnTop: 1 }],
      ['skipTaskbar 非布尔', { ...good, skipTaskbar: null }],
      ['req=null', null],
      ['req=字符串', 'x'],
      ['req=数字', 42]
    ]
    for (const [label, req] of cases) {
      // undefined 值的键删掉，模拟"缺失"（JSON 语义下 undefined 键等于不存在）
      if (req && typeof req === 'object') {
        for (const [k, v] of Object.entries(req))
          if (v === undefined) delete (req as Record<string, unknown>)[k]
      }
      const r = createOverlay('pet', req as Record<string, unknown>)
      expect(r.ok, `应拒绝：${label}`).toBe(false)
      expect(typeof r.error).toBe('string')
      expect((r.error ?? '').length).toBeGreaterThan(0)
    }
    expect(mock.windows).toHaveLength(0)
  })

  it('extId 非法（宿主接线错误）→ 四方法都 ok:false', () => {
    expect((ipc('overlay:create', '', { ...PET_REQ }) as { ok: boolean }).ok).toBe(false)
    expect((ipc('overlay:create', undefined, { ...PET_REQ }) as { ok: boolean }).ok).toBe(false)
    expect((ipc('overlay:destroy', 42, 'x') as { ok: boolean }).ok).toBe(false)
    expect((ipc('overlay:set-mouse-through', null, 'x', true) as { ok: boolean }).ok).toBe(false)
    expect((ipc('overlay:set-position', '', 'x', 1, 2) as { ok: boolean }).ok).toBe(false)
    expect((ipc('overlay:set-position', 42, 'x', 1, 2) as { ok: boolean }).ok).toBe(false)
  })
})

describe('主进程 · 生命周期联动（验收⑧后半；对齐 App 子窗口既有行为）', () => {
  it('mainWindow() 不把 overlay 当主窗口：只有 overlay 时桥立即回「主窗口不可用」', async () => {
    createOverlay('pet', { ...PET_REQ })
    const win = lastWin()
    const r = (await ipcFrom('app:extension-message', win.webContents.id, {
      appId: 'pet.overlay',
      channel: 'pet.state',
      payload: null
    })) as { ok: boolean; error?: string }
    // 旧判据只排除 'obox-window=app'——overlay 的 URL 不含它，会被误认成主窗口并永久挂起；
    // 现在立即以「主窗口不可用」失败，证明 overlay 被排除
    expect(r).toEqual({ ok: false, error: '主窗口不可用' })
    expect(win.webContents.sent).toHaveLength(0)
  })

  it('主窗口存在：overlay 的桥消息投给主窗口，extension:reply 结算（overlay 路径复用同一超时/回复逻辑）', async () => {
    const main = await fakeMainWindow()
    createOverlay('pet', { ...PET_REQ })
    const win = lastWin()
    const pending = ipcFrom('app:extension-message', win.webContents.id, {
      appId: 'pet.overlay',
      channel: 'pet.state',
      payload: null
    }) as Promise<{ ok: boolean; data?: unknown }>
    await tick()
    expect(main.webContents.sent).toHaveLength(1)
    const [channel, payload] = main.webContents.sent[0]
    expect(channel).toBe('extension:message')
    const requestId = (payload as { requestId: number }).requestId
    // 宿主回包（extension:reply 是 ipcMain.on 注册的回复侧）
    const reply = mock.ipcOn.get('extension:reply')
    expect(reply).toBeDefined()
    reply!(null, { requestId, ok: true, data: { vitals: { hunger: 90 } } })
    expect(await pending).toEqual({ ok: true, data: { vitals: { hunger: 90 } } })
  })

  it('主窗口关闭 ⇒ overlay 一并关闭（closeAllAppWindowsOnMainClose 的既有约定扩展到 overlay）', () => {
    return (async () => {
      const main = await fakeMainWindow()
      createOverlay('pet', { ...PET_REQ })
      const win = lastWin()
      mod.closeAllAppWindowsOnMainClose(main as unknown as import('electron').BrowserWindow)
      main.fire('closed')
      expect(win.destroyed).toBe(true)
      expect(win.closeCalls).toBe(1)
      // 登记表已清：再 destroy 走幂等分支（ok:true）而不是找到旧窗体
      expect(ipc('overlay:destroy', 'pet', 'pet.overlay')).toEqual({ ok: true })
    })()
  })
})

// ============================ 宿主 · core/host.ts ============================

/** host 私有成员的窄化视图（先例：test/ipc-renderer-close.test.ts 对 buildIpcApi 的 cast） */
const hostPriv = host as unknown as {
  buildApi(ext: ExtensionInfo, disposables: Array<() => void>): ExtensionActivationApi
  handleExtensionMessage(e: {
    requestId: number
    appId: string
    channel: string
    payload: unknown
  }): void
  overlayOwners: Map<string, string>
  appMessageHandlers: Map<string, (channel: string, payload: unknown) => unknown>
  extensions: Map<string, ExtensionInfo>
  cleanups: Map<string, () => void>
}

interface HostRecorder {
  replies: Array<[number, { ok: boolean; data?: unknown; error?: string }]>
  calls: unknown[][]
}

let rec: HostRecorder

/** 仿真 preload 暴露的 window（host.ts 只读 window.events / window.api 的这几个成员） */
function installHostWindow(
  overlayCreateResult: { ok: boolean; error?: string } = { ok: true }
): void {
  rec = { replies: [], calls: [] }
  ;(globalThis as unknown as { window: unknown }).window = {
    events: {
      on: (): (() => void) => () => {}
    },
    api: {
      env: { platform: 'win32', arch: 'x64', nodeVersion: 'v22.0.0' },
      extensionReply: (requestId: number, result: unknown): void => {
        rec.replies.push([requestId, result as never])
      },
      overlayCreate: (extId: string, options: unknown): Promise<unknown> => {
        rec.calls.push(['overlayCreate', extId, options])
        return Promise.resolve(overlayCreateResult)
      },
      overlayDestroy: (extId: string, id: string): Promise<unknown> => {
        rec.calls.push(['overlayDestroy', extId, id])
        return Promise.resolve({ ok: true })
      },
      overlaySetMouseThrough: (extId: string, id: string, through: boolean): Promise<unknown> => {
        rec.calls.push(['overlaySetMouseThrough', extId, id, through])
        return Promise.resolve({ ok: true })
      },
      overlaySetPosition: (extId: string, id: string, x: number, y: number): Promise<unknown> => {
        rec.calls.push(['overlaySetPosition', extId, id, x, y])
        // 主进程真实返回带钳制后坐标；mock 原样回显（钳位逻辑在主进程测试里单独钉住）
        return Promise.resolve({ ok: true, position: { x, y } })
      },
      cleanupExtension: (extId: string): Promise<void> => {
        rec.calls.push(['cleanupExtension', extId])
        return Promise.resolve()
      }
    }
  }
}

function petExt(id = 'pet'): ExtensionInfo {
  return makeExtensionInfo(id, { name: id, version: '1.0.0', main: 'index.js' }, 'user', true)
}

afterEach(() => {
  hostPriv.appMessageHandlers.clear()
  hostPriv.overlayOwners.clear()
  appStore.deactivateExtension('card-ext')
})

describe('宿主 · 消息路由（验收⑦；先查卡片、查不到按 overlayId、都未命中回既有错误）', () => {
  it('resolveMessageExtId 纯函数：卡片优先、overlay 兜底、都未命中 undefined', () => {
    const owners = new Map([
      ['pet.overlay', 'pet'],
      ['my.card', 'overlay-side-ext'] // 故意与卡片 id 撞名：验证卡片优先
    ])
    const findCard = (id: string): string | undefined => (id === 'my.card' ? 'card-ext' : undefined)
    expect(resolveMessageExtId('my.card', findCard, owners)).toBe('card-ext')
    expect(resolveMessageExtId('pet.overlay', findCard, owners)).toBe('pet')
    expect(resolveMessageExtId('nope', findCard, owners)).toBeUndefined()
  })

  it('appId 命中卡片 → 所属扩展 handler，结果 ok:true 回传（App 卡片既有路径逐字不变）', async () => {
    installHostWindow()
    const card = appStore.register('card-ext', {
      id: 'my.card',
      name: '卡片',
      version: '1.0.0',
      icon: '<svg/>'
    })
    hostPriv.appMessageHandlers.set('card-ext', (ch, p) => ({ echo: [ch, p] }))
    hostPriv.handleExtensionMessage({
      requestId: 11,
      appId: 'my.card',
      channel: 'ping',
      payload: 7
    })
    await tick()
    expect(rec.replies).toEqual([[11, { ok: true, data: { echo: ['ping', 7] } }]])
    card.dispose()
  })

  it('appId 命中 overlayId → 按所属扩展派发（后台扩展没有卡片，页面用 overlayId 当 appId）', async () => {
    installHostWindow()
    expect(appStore.findById('pet.overlay')).toBeUndefined() // 前提：确实没有卡片
    hostPriv.overlayOwners.set('pet.overlay', 'pet')
    hostPriv.appMessageHandlers.set('pet', (ch, p) => ({ state: `${ch}:${JSON.stringify(p)}` }))
    hostPriv.handleExtensionMessage({
      requestId: 12,
      appId: 'pet.overlay',
      channel: 'pet.subscribe',
      payload: { rev: 3 }
    })
    await tick()
    expect(rec.replies).toEqual([[12, { ok: true, data: { state: 'pet.subscribe:{"rev":3}' } }]])
  })

  it('两者都不命中 → 回既有错误「扩展未注册消息处理器」（文案逐字不变）', async () => {
    installHostWindow()
    hostPriv.handleExtensionMessage({ requestId: 13, appId: 'ghost', channel: 'x', payload: null })
    await tick()
    expect(rec.replies).toEqual([[13, { ok: false, error: '扩展未注册消息处理器' }]])
  })

  it('命中扩展但 handler 拒绝（async 抛错）→ ok:false + 错误消息（既有行为）', async () => {
    installHostWindow()
    hostPriv.overlayOwners.set('t.overlay', 't-ext')
    // 文档契约是"handler 可返回 Promise"（api-reference.md）：异步拒绝走 .catch 回传错误。
    // （同步 throw 会逃出监听器、请求走 60s 超时——这是 App 卡片窗口的既有特性，overlay 路径
    // 原样复用不改动，故这里只测文档化的异步路径。）
    hostPriv.appMessageHandlers.set('t-ext', async () => {
      throw new Error('boom')
    })
    hostPriv.handleExtensionMessage({
      requestId: 14,
      appId: 't.overlay',
      channel: 'x',
      payload: null
    })
    await tick()
    expect(rec.replies).toEqual([[14, { ok: false, error: 'boom' }]])
  })
})

describe('宿主 · api.overlay 接线与回收（验收⑧前半 + 不进启动器）', () => {
  it('create：以（自己的扩展 id，原参数）调 IPC；成功后登记 overlayId→extId 路由；**不写 appStore**', async () => {
    installHostWindow()
    const disposables: Array<() => void> = []
    const api = hostPriv.buildApi(petExt(), disposables)
    const r = await api.overlay.create({ ...PET_REQ } as never)
    expect(r).toEqual({ ok: true })
    expect(rec.calls).toEqual([['overlayCreate', 'pet', PET_REQ]])
    expect(hostPriv.overlayOwners.get('pet.overlay')).toBe('pet')
    // overlay 不是卡片：不进启动器/应用列表（appStore 里没有它）
    expect(appStore.findById('pet.overlay')).toBeUndefined()
    expect(appStore.items.some((i) => i.id === 'pet.overlay')).toBe(false)
    expect(appStore.items.some((i) => i.extensionId === 'pet')).toBe(false)
    // create 时就把销毁钩子挂进了 disposables（停用即回收的实现载体）
    expect(disposables.length).toBeGreaterThan(0)
  })

  it('create 失败（ok:false）不登记路由表', async () => {
    installHostWindow({ ok: false, error: 'width 必须是 > 0 的数字' })
    const api = hostPriv.buildApi(petExt(), [])
    const r = await api.overlay.create({ ...PET_REQ, width: 0 } as never)
    expect(r.ok).toBe(false)
    expect(hostPriv.overlayOwners.size).toBe(0)
  })

  it('destroy / setMouseThrough：extId 绑定在闭包里逐字转发（扩展无法伪造成别人）', async () => {
    installHostWindow()
    const api = hostPriv.buildApi(petExt(), [])
    await api.overlay.create({ ...PET_REQ } as never)
    await api.overlay.setMouseThrough('pet.overlay', false)
    await api.overlay.destroy('pet.overlay')
    expect(rec.calls).toEqual([
      ['overlayCreate', 'pet', PET_REQ],
      ['overlaySetMouseThrough', 'pet', 'pet.overlay', false],
      ['overlayDestroy', 'pet', 'pet.overlay']
    ])
    // destroy 成功后路由项被收掉（消息不再按旧 overlayId 投递）
    expect(hostPriv.overlayOwners.has('pet.overlay')).toBe(false)
  })

  it('setPosition（卡 14）：extId 绑定在闭包里逐字转发；主进程回传的 position 原样交给扩展', async () => {
    installHostWindow()
    const api = hostPriv.buildApi(petExt(), [])
    await api.overlay.create({ ...PET_REQ } as never)
    const r = await api.overlay.setPosition('pet.overlay', 120, 340)
    expect(r).toEqual({ ok: true, position: { x: 120, y: 340 } })
    expect(rec.calls).toEqual([
      ['overlayCreate', 'pet', PET_REQ],
      ['overlaySetPosition', 'pet', 'pet.overlay', 120, 340]
    ])
    // setPosition 不影响消息路由表（移动不改变 overlay 的归属与生命周期）
    expect(hostPriv.overlayOwners.get('pet.overlay')).toBe('pet')
  })

  it('停用 cleanup：跑 disposables（= disposeAll）⇒ overlayDestroy 被调 + 路由表清空（「停用或卸载即回收窗体」）', async () => {
    installHostWindow()
    const disposables: Array<() => void> = []
    const api = hostPriv.buildApi(petExt(), disposables)
    await api.overlay.create({ ...PET_REQ } as never)
    expect(hostPriv.overlayOwners.size).toBe(1)
    // disposeAll 的等价物（activateExtension 保存的 cleanups 就是它）
    for (const d of disposables.splice(0)) d()
    await tick()
    expect(rec.calls.at(-1)).toEqual(['overlayDestroy', 'pet', 'pet.overlay'])
    expect(hostPriv.overlayOwners.size).toBe(0)
  })

  it('removeExtension（卸载/热移除路径）：窗体回收 + 路由清扫 + 主进程 cleanupExtension 被调', async () => {
    installHostWindow()
    const ext = petExt('pet2')
    hostPriv.extensions.set('pet2', ext)
    const disposables: Array<() => void> = []
    const api = hostPriv.buildApi(ext, disposables)
    await api.overlay.create({
      id: 'pet2.main',
      url: 'app://extensions/pet2/o.html',
      width: 100,
      height: 100,
      anchor: 'bottom-right'
    } as never)
    hostPriv.cleanups.set('pet2', () => {
      for (const d of disposables) d()
    })

    expect(host.removeExtension('pet2')).toBe(true)
    await tick()
    expect(rec.calls).toContainEqual(['overlayDestroy', 'pet2', 'pet2.main'])
    expect(rec.calls).toContainEqual(['cleanupExtension', 'pet2'])
    expect(hostPriv.overlayOwners.has('pet2.main')).toBe(false)
    expect(hostPriv.extensions.has('pet2')).toBe(false)
  })
})

// ============================ 源码门禁（五处透明改动 + 接线面 + 回归） ============================

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

/** 去掉块注释 / HTML 注释 / 行注释（先例：test/app-window-wiring.test.ts——注释里的示例不得喂污断言） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 折叠空白：prettier 换行不该让"语句存在"断言假红 */
function flatten(src: string): string {
  return stripComments(src).replace(/\s+/g, ' ')
}

const vueSrc = read('../src/renderer/src/AppWindow.vue')
const vueFlat = flatten(vueSrc)
const cssSrc = read('../src/renderer/src/assets/main.css')
const mainTsSrc = read('../src/renderer/src/main.ts')
const preloadSrc = read('../src/preload/index.ts')
const sharedSrc = read('../src/shared/types.ts')
const apiTypesSrc = read('../src/api/types.ts')
const mainIndexSrc = read('../src/main/index.ts')
const hostSrc = read('../src/renderer/src/core/host.ts')
const appWindowSrc = read('../src/main/appWindow.ts')

describe('外壳 · 五处透明改动（验收⑥；design D-11，缺一处就不是透明窗体）', () => {
  it('改动 1/5（主进程侧）：transparent 时 backgroundColor=#00000000，且窗体参数齐备', () => {
    // 功能面已由「create 参数映射」覆盖；这里钉住源码里的关键常量与开关注释
    expect(appWindowSrc).toContain("backgroundColor: transparent ? '#00000000' : '#1e1e1e'")
    expect(appWindowSrc).toContain('transparent,')
    expect(appWindowSrc).toContain('hasShadow: false')
    expect(appWindowSrc).toContain('thickFrame: false')
    expect(appWindowSrc).toContain('roundedCorners: false')
    expect(appWindowSrc).toContain('acceptFirstMouse: true')
  })

  it('改动 2/5：overlay 不渲染 TitleBar 与 PromptHost；卡片模式照常渲染（v-if 开关隔离）', () => {
    expect(vueFlat).toMatch(/<TitleBar v-if="!isOverlay" :title="title" :icon="windowIcon" \/>/)
    expect(vueFlat).toMatch(/<PromptHost v-if="!isOverlay" \/>/)
    // 回归：卡片模式（isOverlay=false）时 v-if 为真 ⇒ 两个组件仍在模板里、未被删除
    expect(vueFlat).toContain('<TitleBar')
    expect(vueFlat).toContain('<PromptHost')
  })

  it('改动 3/5 + 4/5：overlay 根 class 下 .app-window / .app-window-content / .app-frame 三层背景全透明', () => {
    // 根 class 由 isOverlay 单一开关绑定（R9：所有新逻辑都从这个开关走）
    expect(vueFlat).toContain(`:class="{ 'app-window--overlay': isOverlay }"`)
    expect(vueFlat).toMatch(
      /\.app-window--overlay, \.app-window--overlay \.app-window-content, \.app-window--overlay \.app-frame \{ background: transparent; \}/
    )
  })

  it('回归（R9）：卡片模式的基础样式逐字保留——var(--bg,#1e1e1e) 两处 + .app-frame 白底 + sandbox 属性', () => {
    const styleBlock = vueSrc.slice(vueSrc.indexOf('<style scoped>'))
    // 基础规则仍在（overlay 规则是**追加**的覆盖，不是替换）
    expect(styleBlock).toContain('background: var(--bg, #1e1e1e);')
    expect(styleBlock.match(/background: var\(--bg, #1e1e1e\);/g)).toHaveLength(2)
    expect(styleBlock).toContain('background: #ffffff;')
    // overlay 覆盖规则位于基础规则之后（层叠顺序保证覆盖生效）
    expect(styleBlock.indexOf('.app-window--overlay')).toBeGreaterThan(
      styleBlock.indexOf('background: #ffffff;')
    )
    // iframe sandbox 与 srcdoc/url 双路径未被 overlay 改动破坏
    expect(vueFlat).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-popups"')
    expect(vueFlat).toContain(':srcdoc="iframeSrcdoc"')
    expect(vueFlat).toContain('themeStyleHtml.value + html')
  })

  it('改动 5/5：挂载前给 <html> 挂 obox-overlay class（模块级副作用）+ main.css 全局规则；body 默认背景保留', () => {
    // AppWindow.vue：模块级（plain <script>，先于 <script setup>）在首帧前挂 class
    expect(vueSrc.indexOf('<script lang="ts">')).toBeLessThan(
      vueSrc.indexOf('<script setup lang="ts">')
    )
    expect(vueFlat).toContain(
      `if (new URLSearchParams(window.location.search).get('obox-window') === 'overlay') { document.documentElement.classList.add('obox-overlay') }`
    )
    // main.css：html/body 背景透明规则存在，且只作用于带 class 的 overlay 窗口
    expect(cssSrc).toMatch(
      /html\.obox-overlay,\s*html\.obox-overlay body\s*{\s*background: transparent;\s*}/
    )
    // 回归：全局 body 默认背景（主窗口与卡片子窗口）逐字保留
    expect(cssSrc).toMatch(/body\s*{[^}]*background: var\(--bg\);/)
  })

  it('外壳 url 二次校验（R13）：与主进程同判据；非法 url 不加载 iframe、渲染空白并记 [overlay] 日志', () => {
    // 判据一致：两处都是 app:// 协议 + 三 host 白名单 + 首段=extId + 须有子路径 + 拒绝 ..
    expect(vueFlat).toContain('function isOverlayUrlAllowed(')
    expect(vueFlat).toContain(`parsed.protocol !== 'app:'`)
    expect(vueFlat).toContain(`['extensions', 'builtin', 'debug']`)
    expect(vueFlat).toContain(
      'slash > 0 && slash < rest.length - 1 && rest.slice(0, slash) === ownerExtId'
    )
    expect(vueFlat).toContain(`rest.includes('..')`)
    expect(appWindowSrc).toContain(`['extensions', 'builtin', 'debug'].includes(parsed.hostname)`)
    expect(appWindowSrc).toContain(
      'slash > 0 && slash < rest.length - 1 && rest.slice(0, slash) === extId'
    )
    // 校验失败 ⇒ overlayUrl 为空 ⇒ iframe v-if 不成立 ⇒ 空白；且 warn 一条可转发的日志
    expect(vueFlat).toContain('[overlay] 拒绝非法 url:')
    expect(vueFlat).toContain(`v-if="isOverlay ? overlayUrl : registration"`)
    // overlay 的空态**不渲染提示文字**（文字也是像素）；卡片空态保留
    expect(vueFlat).toContain('v-else-if="!isOverlay"')
    expect(vueFlat).toContain(`t('appExt.notFound', { appId })`)
  })

  it('overlay 的消息转发强制用自己的 appId（=overlayId）；卡片路径仍用页面发来的 data.appId', () => {
    expect(vueFlat).toContain(
      'extensionMessage(isOverlay ? appId : data.appId, data.channel, data.payload)'
    )
  })

  it('overlay iframe 不走 srcdoc、key 恒定（overlayUrl 常量 ⇒ 主题/重渲染不打断页面动画）', () => {
    expect(vueFlat).toContain('if (isOverlay) return undefined')
    expect(vueFlat).toContain(
      'isOverlay ? overlayUrl : appFrameKey(registration.value, themeId.value)'
    )
    // 主题推送不新增分支：pushThemeTokens 保持 registration.url 早退（overlay 自然不推送，design D-6）
    expect(vueFlat).toContain('if (!registration.value?.url) return')
  })
})

describe('main.ts · 窗口类型判定（R11 扩权；源码门禁）', () => {
  it('app 与 overlay 都挂 AppWindow 外壳且不激活扩展；主窗口仍挂 App 且激活', () => {
    const flat = flatten(mainTsSrc)
    expect(flat).toContain(`const windowKind = params.get('obox-window')`)
    expect(flat).toContain(`const isChildWindow = windowKind === 'app' || windowKind === 'overlay'`)
    expect(flat).toContain('activateExtensions: !isChildWindow')
    // 主窗口（无 obox-window 参数）：isChildWindow=false ⇒ 挂 App、activateExtensions=true
    expect(flat).toMatch(
      /if \(isChildWindow\) \{ createApp\(AppWindow\)\.use\(i18n\)\.mount\('#app'\) \} else \{ createApp\(App\)\.use\(i18n\)\.mount\('#app'\) \}/
    )
  })

  it('obox-window=app 行为逐字不变：app 仍命中 isChildWindow；旧变量名 isAppWindow 已不存在', () => {
    expect(mainTsSrc).toContain(`windowKind === 'app'`)
    expect(mainTsSrc).not.toContain('isAppWindow')
  })

  it('注释写明「overlay 为什么也算子窗口」（D-11 + R11）与 ui.ts 模态框转发取舍', () => {
    expect(mainTsSrc).toContain('R11')
    expect(mainTsSrc).toContain('D-11')
    expect(mainTsSrc).toContain('ui.ts')
  })
})

describe('桥接面 · preload / MainApi / api 类型 / 主进程注册（源码门禁）', () => {
  it('preload 四条桥接：通道名与参数顺序', () => {
    const flat = flatten(preloadSrc)
    expect(flat).toContain(
      `overlayCreate: (extId, options) => ipcRenderer.invoke('overlay:create', extId, options)`
    )
    expect(flat).toContain(
      `overlayDestroy: (extId, id) => ipcRenderer.invoke('overlay:destroy', extId, id)`
    )
    expect(flat).toContain(
      `overlaySetMouseThrough: (extId, id, through) => ipcRenderer.invoke('overlay:set-mouse-through', extId, id, through)`
    )
    // 卡 14：第四条桥接（移动窗体；坐标校验与钳位都在主进程）
    expect(flat).toContain(
      `overlaySetPosition: (extId, id, x, y) => ipcRenderer.invoke('overlay:set-position', extId, id, x, y)`
    )
  })

  it('shared/types.ts：MainApi 四个 overlay 方法签名（与 preload/主进程同契约）', () => {
    const flat = flatten(sharedSrc)
    expect(flat).toContain(
      'overlayCreate(extId: string, options: CreateOverlayRequest): Promise<OverlayResult>'
    )
    expect(flat).toContain('overlayDestroy(extId: string, id: string): Promise<OverlayResult>')
    expect(flat).toContain(
      'overlaySetMouseThrough(extId: string, id: string, through: boolean): Promise<OverlayResult>'
    )
    expect(flat).toContain(
      'overlaySetPosition(extId: string, id: string, x: number, y: number): Promise<OverlayResult>'
    )
  })

  it('api/types.ts：overlay 已翻必填（R2/R12）——`overlay: {` 存在、`overlay?:` 不存在', () => {
    expect(apiTypesSrc).toMatch(/^ {2}overlay: \{$/m)
    expect(apiTypesSrc).not.toMatch(/overlay\?: \{/)
  })

  it('main/index.ts：registerOverlayIpc 已注册（与 registerAppWindowIpc 并列）', () => {
    const flat = flatten(mainIndexSrc)
    expect(flat).toContain('registerOverlayIpc')
    expect(flat).toMatch(/registerAppWindowIpc\(\) .*registerOverlayIpc\(\)/)
  })

  it('host.ts：监听走 handleExtensionMessage；既有错误文案逐字保留；removeExtension 清扫路由表', () => {
    const flat = flatten(hostSrc)
    expect(flat).toContain(
      `window.events.on('extension:message', (e) => this.handleExtensionMessage(e))`
    )
    expect(hostSrc).toContain("error: '扩展未注册消息处理器'")
    expect(flat).toContain('if (owner === id) this.overlayOwners.delete(overlayId)')
  })

  it('60s 桥超时未被缩短，overlay 复用同一逻辑；「长轮询必须小于该超时」写进注释', () => {
    expect(appWindowSrc).toContain('}, 60_000)')
    expect(appWindowSrc.match(/60_000/g)).toHaveLength(1) // 只有这一处超时值，没有被改小/另设
    expect(appWindowSrc).toContain('长轮询')
    expect(appWindowSrc).toContain('必须**小于**该超时')
    // 超时错误文案不变（guides-user.md 的既有契约）
    expect(appWindowSrc).toContain("error: '扩展未响应（超时）'")
  })
})
