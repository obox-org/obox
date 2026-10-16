import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { getUserExtensionsDir } from './capabilities'
import type { CreateOverlayRequest, OverlayAnchor, OverlayResult } from '../shared/types'

/** 打开子窗口的请求（渲染进程 App 视图发起） */
export interface OpenAppWindowRequest {
  /** 插件卡片 id */
  appId: string
  /** 窗口标题（插件名） */
  title: string
  /** 是否允许多开 */
  multiOpen?: boolean
  /** 子窗口宽（默认 900） */
  width?: number
  /** 子窗口高（默认 640） */
  height?: number
  /** 子窗口图标：app:// URL（如 app://extensions/<id>/icon.png），主进程转磁盘路径设任务栏图标 */
  iconUrl?: string
}

/** 已打开的子窗口跟踪：appId → [BrowserWindow] */
const appWindows = new Map<string, BrowserWindow[]>()

function urlForChild(query: string): string {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}?${query}`
  }
  return `file://${join(__dirname, '../renderer/index.html').replace(/\\/g, '/')}?${query}`
}

/** 把 app://extensions/<id>/<rest> 解析为磁盘路径（userData/extensions/<id>/<rest>） */
function appUrlToPath(appUrl: string): string | null {
  try {
    const url = new URL(appUrl)
    if (url.protocol !== 'app:' || url.hostname !== 'extensions') return null
    const rest = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!rest || rest.includes('..')) return null
    return join(getUserExtensionsDir(), rest)
  } catch {
    return null
  }
}

function openChildWindow(req: OpenAppWindowRequest): BrowserWindow {
  const width = req.width ?? 900
  const height = req.height ?? 640
  const multiOpen = req.multiOpen ?? false
  const list = appWindows.get(req.appId) ?? []

  // 单开且已有窗口：聚焦并返回
  if (!multiOpen && list.length > 0) {
    const existing = list[list.length - 1]
    if (!existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return existing
    }
  }

  // 多开序号：当前数量 + 1
  const sequence = list.filter((w) => !w.isDestroyed()).length + 1

  const winOptions: Electron.BrowserWindowConstructorOptions = {
    width,
    height,
    minWidth: 400,
    minHeight: 300,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    title: multiOpen && sequence > 1 ? `${req.title} ${sequence}` : req.title,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  }
  // 任务栏图标：若卡片提供 app:// 图标 URL，转磁盘路径设置；否则用应用默认图标
  if (req.iconUrl) {
    const iconPath = appUrlToPath(req.iconUrl)
    if (iconPath) winOptions.icon = iconPath
  }
  const win = new BrowserWindow(winOptions)

  // 子窗口参数：obox-window=app + appId + sequence
  const query = new URLSearchParams({
    'obox-window': 'app',
    appId: req.appId,
    sequence: String(sequence)
  })
  void win.loadURL(urlForChild(query.toString()))

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    const remaining = (appWindows.get(req.appId) ?? []).filter((w) => w !== win && !w.isDestroyed())
    if (remaining.length) appWindows.set(req.appId, remaining)
    else appWindows.delete(req.appId)
  })

  list.push(win)
  appWindows.set(req.appId, list)

  // 复用主窗口的渲染日志转发
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event
    const tag = `[child-renderer:${level}] ${sourceId}:${lineNumber}`
    if (level === 'error' || level === 'warning') console.error(tag, message)
    else console.log(tag, message)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[child-renderer-gone]', details.reason, details.exitCode)
  })

  return win
}

export function registerAppWindowIpc(): void {
  ipcMain.handle(
    'app:open-window',
    (_e, req: OpenAppWindowRequest): { appId: string; sequence: number } => {
      const win = openChildWindow(req)
      const list = appWindows.get(req.appId) ?? []
      return { appId: req.appId, sequence: list.indexOf(win) + 1 }
    }
  )
}

// ---- App 子窗口 ↔ 扩展消息桥 ----
// 链路：子窗口 iframe → AppWindow(vue) → IPC 'app:extension-message' → 主进程 → 主窗口
//   → 宿主分发扩展 handler → 'extension:reply' → 主进程 pending 匹配 → AppWindow → iframe postMessage。
// 请求-响应经 requestId 关联（主进程生成），60s 超时（handler 内可能弹模态框等用户填写）。

interface PendingReply {
  resolve: (r: { ok: boolean; data?: unknown; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
  /**
   * 发起方窗口的 webContents.id（卡 03 追加）：overlay 窗体销毁时按 sender 立即结算它的
   * pending 请求（见 flushPendingReplies）——页面已随窗体销毁，回复永远送不到，
   * 不清理就只能空等 60s 超时。App 卡片子窗口路径不消费该字段（既有行为不变）。
   */
  senderId?: number
}

const pendingReplies = new Map<number, PendingReply>()
let reqSeq = 0

/** 主窗口 = 既不是 App 卡片子窗口、也不是 overlay 窗体的那个窗口 */
function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => {
    if (w.isDestroyed()) return false
    const url = w.webContents.getURL()
    // overlay 窗体（obox-window=overlay，卡 03 新增）的 URL **不含** 'obox-window=app'，
    // 只按旧判据排除的话它会冒充主窗口、把宿主消息投进 overlay——必须两种子窗口都排除
    return !url.includes('obox-window=app') && !url.includes('obox-window=overlay')
  })
}

/** 把某发起窗口（webContents.id）的全部 pending 桥请求立即以错误结算（overlay 'closed' 时调用） */
function flushPendingReplies(senderId: number, error: string): void {
  for (const [requestId, pending] of pendingReplies) {
    if (pending.senderId !== senderId) continue
    clearTimeout(pending.timer)
    pendingReplies.delete(requestId)
    pending.resolve({ ok: false, error })
  }
}

ipcMain.handle(
  'app:extension-message',
  (
    e,
    msg: { appId: string; channel: string; payload: unknown }
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    return new Promise((resolve) => {
      const main = mainWindow()
      if (!main) {
        resolve({ ok: false, error: '主窗口不可用' })
        return
      }
      const requestId = ++reqSeq
      // 超时放宽到 60s：handler 内可能弹模态框（api.ui.showForm 等）等待用户填写。
      // overlay 路径**复用同一超时逻辑**（卡 03）：扩展用"入口 → 页面"的**长轮询**做状态同步
      // （pet.subscribe 一类：hold 到状态变化或 25s 超时，见 pet design D-3），其 hold 时长
      // 必须**小于**该超时，否则宿主先超时、页面收到的是"扩展未响应（超时）"而不是订阅结果。
      // 因此不要缩短这个值；要支持更长的 hold，先改扩展侧协议再评估这里。
      const timer = setTimeout(() => {
        pendingReplies.delete(requestId)
        resolve({ ok: false, error: '扩展未响应（超时）' })
      }, 60_000)
      pendingReplies.set(requestId, { resolve, timer, senderId: e.sender.id })
      main.webContents.send('extension:message', {
        requestId,
        appId: msg.appId,
        channel: msg.channel,
        payload: msg.payload
      })
    })
  }
)

ipcMain.on(
  'extension:reply',
  (_e, result: { requestId: number; ok: boolean; data?: unknown; error?: string }): void => {
    const pending = pendingReplies.get(result.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingReplies.delete(result.requestId)
    pending.resolve({ ok: result.ok, data: result.data, error: result.error })
  }
)

/** 主窗口关闭时关闭所有子窗口（在 createWindow 之后调用） */
export function closeAllAppWindowsOnMainClose(main: BrowserWindow): void {
  main.on('closed', () => {
    for (const list of appWindows.values()) {
      for (const win of list) {
        if (!win.isDestroyed()) win.close()
      }
    }
    appWindows.clear()
    // overlay 窗体随主窗口一并关闭（卡 03，对齐 App 子窗口的既有行为）：overlay 是扩展的
    // 附属桌面 UI，宿主主窗口没了它就没有存在意义（消息桥的对端宿主也没了）
    for (const entry of overlays.values()) {
      if (!entry.win.isDestroyed()) entry.win.close()
    }
    overlays.clear()
  })
}

// ---- overlay 窗体（卡 03；pet-desktop-companion design D-1/D-2/D-11） ----
// 与 App 子窗口的区别：overlay **不注册卡片、不进启动器/appStore**，由扩展经 api.overlay.*
// 自行创建/销毁（宿主接线在 core/host.ts buildOverlayApi），适合后台扩展的常驻桌面 UI。
// 外壳复用 AppWindow.vue（查询串 obox-window=overlay 进入 overlay 模式），透明的五处绘制点
// 改动见 design D-11（本文件的窗体参数是其中第 1 处；其余 4 处在渲染侧）。

/** overlay 跟踪表：key = `<extId>:<overlayId>`（扩展 id 字符集不含 ':'，见 core/manifest.ts，首冒号即分界） */
interface OverlayEntry {
  extId: string
  overlayId: string
  win: BrowserWindow
  /** 发起方 webContents.id：窗体销毁时清掉它的 pending 桥请求（防 60s 空等） */
  senderId: number
  /** 当前鼠标穿透态（日志/诊断用；窗体自身的 setIgnoreMouseEvents 才是权威） */
  mouseThrough: boolean
}
const overlays = new Map<string, OverlayEntry>()

const overlayKey = (extId: string, overlayId: string): string => `${extId}:${overlayId}`

/** anchor 合法值白名单（与 shared/types.ts 的 OverlayAnchor 联合一致；越界值直接拒绝） */
const OVERLAY_ANCHORS: readonly string[] = ['bottom-right', 'bottom-left', 'top-right', 'top-left']

/** margin 缺省值（design D-1：距锚定角 24px） */
const DEFAULT_OVERLAY_MARGIN = 24

/**
 * overlay 页面 URL 是否指向**调用方扩展目录内**的页面。
 *
 * 判据与外壳（AppWindow.vue 的 isOverlayUrlAllowed）的二次校验**完全一致**（R13 裁定：
 * 防御纵深，两处互相引用、不得单边放宽）：
 * - 协议必须是 `app:`（http/file/相对路径一律拒绝）；
 * - hostname 必须是 app:// 协议的三个合法 host（main/protocol.ts 的映射）之一：
 *   `extensions`（用户扩展）/ `builtin`（内置扩展）/ `debug`（--debug-extension 调试扩展）——
 *   只认 extensions 会让后两种加载形态的 overlay 没法开发/没法用；
 * - 路径首段必须等于调用方扩展 id，且必须有子路径（不允许只给目录）；
 * - 含 `..` 一律拒绝（与本文件 appUrlToPath 及 protocol.ts 的既有防护同口径）。
 */
export function isOverlayUrlInsideExtension(url: string, extId: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'app:') return false
    if (!['extensions', 'builtin', 'debug'].includes(parsed.hostname)) return false
    const rest = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    if (!rest || rest.includes('..')) return false
    const slash = rest.indexOf('/')
    // slash > 0：首段（扩展 id）非空；slash < rest.length - 1：首段后必须还有子路径
    //（`app://extensions/<id>/` 是目录本身，不是页面，拒绝）
    return slash > 0 && slash < rest.length - 1 && rest.slice(0, slash) === extId
  } catch {
    return false
  }
}

/**
 * create 参数校验（纯函数，test/overlay-window.test.ts 直接喂非法值断言被拒）。
 * 返回中文可执行错误消息；null = 通过。契约即 shared/types.ts `CreateOverlayRequest` 的
 * JSDoc（扩展 API 与主进程窗体实现共用同一份类型，防签名漂移）。
 */
export function validateOverlayRequest(req: unknown, extId: unknown): string | null {
  if (typeof extId !== 'string' || !extId) {
    return '缺少扩展 id（宿主接线错误：overlay 四方法必须由宿主绑定扩展 id 调用）'
  }
  if (!req || typeof req !== 'object') return 'create 参数必须是对象（CreateOverlayRequest）'
  const r = req as Partial<CreateOverlayRequest>
  if (typeof r.id !== 'string' || !r.id.trim()) {
    return '缺少 id：overlay id 必须是非空字符串（建议含扩展名前缀，如 pet.overlay）'
  }
  if (typeof r.url !== 'string' || !r.url.trim()) {
    return '缺少 url：overlay 页面地址必须是非空字符串（如 app://extensions/<扩展id>/overlay.html）'
  }
  if (!isOverlayUrlInsideExtension(r.url, extId)) {
    return `url 必须指向本扩展目录内的页面（app://extensions|builtin|debug/${extId}/…，不得越出扩展目录）：${r.url}`
  }
  if (typeof r.width !== 'number' || !Number.isFinite(r.width) || r.width <= 0) {
    return `width 必须是 > 0 的数字（像素；overlay 尺寸固定、不可调整大小）：${String(r.width)}`
  }
  if (typeof r.height !== 'number' || !Number.isFinite(r.height) || r.height <= 0) {
    return `height 必须是 > 0 的数字（像素；overlay 尺寸固定、不可调整大小）：${String(r.height)}`
  }
  if (typeof r.anchor !== 'string' || !OVERLAY_ANCHORS.includes(r.anchor)) {
    return `anchor 必须是 ${OVERLAY_ANCHORS.join(' / ')} 之一：${String(r.anchor)}`
  }
  if (
    r.margin !== undefined &&
    (typeof r.margin !== 'number' || !Number.isFinite(r.margin) || r.margin < 0)
  ) {
    return `margin 必须是 ≥ 0 的数字（缺省 ${DEFAULT_OVERLAY_MARGIN}）：${String(r.margin)}`
  }
  for (const flag of ['transparent', 'alwaysOnTop', 'skipTaskbar'] as const) {
    if (r[flag] !== undefined && typeof r[flag] !== 'boolean') {
      return `${flag} 必须是布尔（可缺省，缺省 false）：${String(r[flag])}`
    }
  }
  return null
}

/** workArea 的最小形状（Electron `screen.getPrimaryDisplay().workArea` 的返回值满足它；测试可注入假数据） */
export interface OverlayWorkArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * anchor → 窗体左上角坐标（纯函数；design D-1 的公式，右下角例：
 * `x = workArea.x + workArea.width - width - margin`、`y = workArea.y + workArea.height - height - margin`；
 * 其余三角对称：靠左/靠上就是工作区原点加 margin）。
 * 定位基准是**主显示器工作区**（workArea，不含任务栏）——满足 pet-window spec
 * 「多显示器环境定位在主显示器」的 scenario（不用 cursor 所在屏、不用坐标原点屏）。
 */
export function overlayPosition(
  workArea: OverlayWorkArea,
  width: number,
  height: number,
  anchor: OverlayAnchor,
  margin: number
): { x: number; y: number } {
  const x =
    anchor === 'bottom-right' || anchor === 'top-right'
      ? workArea.x + workArea.width - width - margin
      : workArea.x + margin
  const y =
    anchor === 'bottom-right' || anchor === 'bottom-left'
      ? workArea.y + workArea.height - height - margin
      : workArea.y + margin
  return { x, y }
}

/**
 * overlay 窗体的查询串契约（**五个参数**，名字与顺序固定；R13 裁定，文档同步在后续卡）：
 * `obox-window=overlay&extId=<扩展id>&overlayId=<overlay id>&appId=<overlay id>&url=<encodeURIComponent(扩展页URL)>`
 * - `appId` 为什么带：消息桥按 appId 路由（core/host.ts resolveMessageExtId 先查卡片、查不到
 *   再按 overlayId 查所属扩展），页面把自己的 overlayId 当 appId 原样发即可，外壳转发代码几乎不用改；
 * - `url` 为什么带：preload 只桥接 overlay 四方法（没有一个 IPC 面可查页面地址），overlay 又
 *   不进 appStore（拿不到卡片注册的 url），只能随查询串下发。url 已在本文件
 *   isOverlayUrlInsideExtension 校验过，外壳（AppWindow.vue）消费前还会做**同判据**的二次校验。
 */
export function overlayQuery(extId: string, overlayId: string, url: string): string {
  return new URLSearchParams({
    'obox-window': 'overlay',
    extId,
    overlayId,
    appId: overlayId,
    url
  }).toString()
}

/** 找 overlayId 的所属扩展（越权判定用：id 存在但不属于调用方 ⇒ 拒绝并记日志） */
function findOverlayOwner(overlayId: string): string | undefined {
  for (const entry of overlays.values()) {
    if (entry.overlayId === overlayId) return entry.extId
  }
  return undefined
}

function createOverlayWindow(extIdRaw: unknown, reqRaw: unknown): OverlayResult {
  const problem = validateOverlayRequest(reqRaw, extIdRaw)
  if (problem) {
    console.warn(`[overlay] 创建被拒（${String(extIdRaw)}）：${problem}`)
    return { ok: false, error: problem }
  }
  // 校验通过后收窄类型（validateOverlayRequest 已保证形状）
  const extId = extIdRaw as string
  const req = reqRaw as CreateOverlayRequest

  // overlayId 全局唯一：消息桥按 overlayId 路由（core/host.ts 的 overlayOwners 是 overlayId → extId，
  // 没有扩展维度），允许不同扩展同 id 会把"页面 → 入口"的消息投错扩展
  for (const entry of overlays.values()) {
    if (entry.overlayId !== req.id) continue
    const reason =
      entry.extId === extId
        ? `overlay id 已存在（重复创建）：${req.id}；要重建请先 destroy('${req.id}')`
        : `overlay id 已被扩展 ${entry.extId} 占用：${req.id}；请加扩展名前缀（如 ${extId}.${req.id}）`
    console.warn(`[overlay] 创建被拒（${extId}）：${reason}`)
    return { ok: false, error: reason }
  }

  const margin = req.margin ?? DEFAULT_OVERLAY_MARGIN
  const transparent = req.transparent ?? false
  // 定位基准：主显示器工作区（不含任务栏；electron.d.ts screen.getPrimaryDisplay → Display.workArea）
  const { x, y } = overlayPosition(
    screen.getPrimaryDisplay().workArea,
    req.width,
    req.height,
    req.anchor,
    margin
  )

  const win = new BrowserWindow({
    width: req.width,
    height: req.height,
    x,
    y,
    // 透明改动 1/5（design D-11）：overlay 不绘制任何窗体背景。
    // '#00000000' 必须与 transparent:true 同用（transparent:false 时带 alpha 的背景会渲染成黑窗），
    // 所以非透明 overlay 沿用 App 子窗口的深色底
    backgroundColor: transparent ? '#00000000' : '#1e1e1e',
    transparent,
    // 透明窗体的官方硬性要求（D-11 复核第 2/5/6 条）：透明窗不可 resize、Windows 下不可最大化；
    // hasShadow/thickFrame/roundedCorners 全关 = 完全无边框（Wayland/GTK 下 hasShadow 不关会留阴影边框）
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    frame: false,
    // macOS：未聚焦时第一次点击也直接生效（点宠物不用先点一下激活窗体）
    acceptFirstMouse: true,
    alwaysOnTop: req.alwaysOnTop ?? false,
    skipTaskbar: req.skipTaskbar ?? false,
    autoHideMenuBar: true,
    // 先隐藏，ready-to-show（首帧绘制完成）后再显示：避免创建瞬间闪一块底色
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  void win.loadURL(urlForChild(overlayQuery(extId, req.id, req.url)))

  // 创建后**默认鼠标穿透**（design D-2）：透明 overlay 不应一出现就吞掉其覆盖区域的桌面点击；
  // forward:true 让悬停移动仍转发给页面——页面据此做命中测试，命中精灵/面板时再调
  // setMouseThrough(id,false) 临时接收点击（electron.d.ts IgnoreMouseEventsOptions.forward，平台 darwin,win32）
  win.setIgnoreMouseEvents(true, { forward: true })

  const key = overlayKey(extId, req.id)
  const entry: OverlayEntry = {
    extId,
    overlayId: req.id,
    win,
    senderId: win.webContents.id,
    mouseThrough: true
  }
  overlays.set(key, entry)

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    overlays.delete(key)
    // 该窗口发出、还在等扩展回复的桥请求永远等不到页面了：立即以错误结算，别空挂 60s
    flushPendingReplies(entry.senderId, 'overlay 窗体已销毁')
    console.log(`[overlay] 已销毁: ${extId}/${req.id}`)
  })

  // 复用 App 子窗口的渲染日志转发（[child-renderer:<level>]，guides-user.md 的既有约定）
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event
    const tag = `[child-renderer:${level}] ${sourceId}:${lineNumber}`
    if (level === 'error' || level === 'warning') console.error(tag, message)
    else console.log(tag, message)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[child-renderer-gone]', details.reason, details.exitCode)
  })

  console.log(
    `[overlay] 已创建: ${extId}/${req.id} ${req.width}x${req.height} anchor=${req.anchor} margin=${margin} ` +
      `transparent=${transparent} alwaysOnTop=${req.alwaysOnTop ?? false} ` +
      `skipTaskbar=${req.skipTaskbar ?? false} @(${x},${y}) 默认鼠标穿透=true`
  )
  // 回传 anchor/margin 解析后的**实际窗体坐标**（与日志里的 @(x,y) 同一份，不重算）：
  // 扩展拿不到 workArea，首次拖动（存档里还没有位置）时入口需要这个绝对基准
  // 才能把 dx/dy 增量换算成 setPosition 的绝对坐标（R31，design D-13 的缺口补齐）
  return { ok: true, position: { x, y } }
}

function destroyOverlay(extIdRaw: unknown, idRaw: unknown): OverlayResult {
  if (typeof extIdRaw !== 'string' || !extIdRaw) {
    return {
      ok: false,
      error: '缺少扩展 id（宿主接线错误：overlay 四方法必须由宿主绑定扩展 id 调用）'
    }
  }
  if (typeof idRaw !== 'string' || !idRaw.trim()) {
    return { ok: false, error: 'destroy 参数错误：overlay id 必须是非空字符串' }
  }
  const key = overlayKey(extIdRaw, idRaw)
  const entry = overlays.get(key)
  if (!entry) {
    // 区分"别人的"与"不存在"：前者越权拒绝 + 日志（作用域安全，design D-2/N4），
    // 后者**静默成功**（幂等契约，见 src/api/types.ts destroy 的 JSDoc：不存在/已销毁重复销毁 ok）
    const owner = findOverlayOwner(idRaw)
    if (owner) {
      const error = `越权被拒：overlay ${idRaw} 由扩展 ${owner} 创建，${extIdRaw} 只能销毁自己创建的 overlay`
      console.warn(`[overlay] ${error}`)
      return { ok: false, error }
    }
    return { ok: true }
  }
  // **真销毁**（不是隐藏）：页面与驱动它的 rAF/定时器动画循环随之终止，CPU 占用回落
  // （pet-window spec「关窗即停动画循环」的宿主侧保证）。destroy() 触发 'closed' →
  // 登记表清除 + 该窗口 pending 桥请求结算
  if (!entry.win.isDestroyed()) entry.win.destroy()
  else overlays.delete(key)
  return { ok: true }
}

function setOverlayMouseThrough(
  extIdRaw: unknown,
  idRaw: unknown,
  throughRaw: unknown
): OverlayResult {
  if (typeof extIdRaw !== 'string' || !extIdRaw) {
    return {
      ok: false,
      error: '缺少扩展 id（宿主接线错误：overlay 四方法必须由宿主绑定扩展 id 调用）'
    }
  }
  if (typeof idRaw !== 'string' || !idRaw.trim()) {
    return { ok: false, error: 'setMouseThrough 参数错误：overlay id 必须是非空字符串' }
  }
  if (typeof throughRaw !== 'boolean') {
    return {
      ok: false,
      error: `setMouseThrough 参数错误：through 必须是布尔（true=整窗穿透，false=接收鼠标事件），收到 ${typeof throughRaw}`
    }
  }
  const entry = overlays.get(overlayKey(extIdRaw, idRaw))
  if (!entry || entry.win.isDestroyed()) {
    const owner = findOverlayOwner(idRaw)
    if (owner) {
      const error = `越权被拒：overlay ${idRaw} 由扩展 ${owner} 创建，${extIdRaw} 只能操作自己创建的 overlay`
      console.warn(`[overlay] ${error}`)
      return { ok: false, error }
    }
    // 与 destroy 的幂等不同：切换穿透对不存在的窗体没有"默认成功"语义，明确报错让扩展能自查
    return { ok: false, error: `overlay 不存在（或已销毁）：${idRaw}` }
  }
  // through=true 保持 forward:true：悬停移动仍转发给页面（pet.hit 一类命中测试依赖它）
  if (throughRaw) entry.win.setIgnoreMouseEvents(true, { forward: true })
  else entry.win.setIgnoreMouseEvents(false)
  entry.mouseThrough = throughRaw
  console.log(`[overlay] 鼠标穿透=${throughRaw}: ${extIdRaw}/${idRaw}`)
  return { ok: true }
}

/**
 * setPosition 的工作区钳位（纯函数，test/overlay-window.test.ts 直接喂边界值断言钳制结果）。
 * 公式与 design D-13 的扩展侧主钳**完全一致**：`x ∈ [wa.x, wa.x+wa.width-w]`、
 * `y ∈ [wa.y, wa.y+wa.height-h]`（w/h 取该 overlay 当前尺寸）——钳位保证窗体**左上角**
 * 不出主显示器工作区（不越界、不盖任务栏）。
 * 退化情形（窗体比工作区还宽/高，max < min）：以 min 为准——优先保证左上角在工作区内，
 * 允许右/下侧溢出（overlay 尺寸固定且远小于工作区，实际到不了这个分支）。
 */
export function clampOverlayPosition(
  workArea: OverlayWorkArea,
  width: number,
  height: number,
  x: number,
  y: number
): { x: number; y: number } {
  const minX = workArea.x
  const maxX = Math.max(workArea.x + workArea.width - width, minX)
  const minY = workArea.y
  const maxY = Math.max(workArea.y + workArea.height - height, minY)
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY)
  }
}

function setOverlayPosition(
  extIdRaw: unknown,
  idRaw: unknown,
  xRaw: unknown,
  yRaw: unknown
): OverlayResult {
  if (typeof extIdRaw !== 'string' || !extIdRaw) {
    return {
      ok: false,
      error: '缺少扩展 id（宿主接线错误：overlay 四方法必须由宿主绑定扩展 id 调用）'
    }
  }
  if (typeof idRaw !== 'string' || !idRaw.trim()) {
    return { ok: false, error: 'setPosition 参数错误：overlay id 必须是非空字符串' }
  }
  // 非法坐标 ⇒ 直接拒绝（**不钳不猜**）：NaN/Infinity/字符串坐标是调用方 bug，静默"修好"
  // 会掩盖扩展侧问题；钳位语义只针对**合法数字**超出工作区的情形（宿主兜底、扩展主钳）
  for (const [name, value] of [
    ['x', xRaw],
    ['y', yRaw]
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        ok: false,
        error: `setPosition 参数错误：${name} 必须是有限数字（NaN/Infinity/非数字一律拒绝，不钳不猜），收到 ${String(value)}`
      }
    }
  }
  const entry = overlays.get(overlayKey(extIdRaw, idRaw))
  if (!entry || entry.win.isDestroyed()) {
    const owner = findOverlayOwner(idRaw)
    if (owner) {
      const error = `越权被拒：overlay ${idRaw} 由扩展 ${owner} 创建，${extIdRaw} 只能操作自己创建的 overlay`
      console.warn(`[overlay] ${error}`)
      return { ok: false, error }
    }
    // 与 setMouseThrough 同口径：移动不存在的窗体没有"默认成功"语义，明确报错让扩展能自查
    return { ok: false, error: `overlay 不存在（或已销毁）：${idRaw}` }
  }
  // 钳位双保险：**扩展侧主钳**（design D-13：入口累加拖动增量后先钳再调本方法），
  // **宿主侧兜底**——扩展拿不到 workArea，换显示器/改分辨率时仍可能算出越界值，
  // 这里按窗体当前尺寸把左上角钳回主显示器工作区
  const bounds = entry.win.getBounds()
  const clamped = clampOverlayPosition(
    screen.getPrimaryDisplay().workArea,
    bounds.width,
    bounds.height,
    xRaw as number,
    yRaw as number
  )
  // 只改位置：不触碰 transparent/alwaysOnTop/穿透态（穿透态由 setMouseThrough 专管；
  // 拖动期间指针在窗体内，穿透本就是关的，无需联动）
  entry.win.setPosition(clamped.x, clamped.y)
  const wasClamped = clamped.x !== (xRaw as number) || clamped.y !== (yRaw as number)
  console.log(
    wasClamped
      ? `[overlay] setPosition: ${extIdRaw}/${idRaw} 请求(${String(xRaw)},${String(yRaw)}) 钳制后(${clamped.x},${clamped.y})`
      : `[overlay] setPosition: ${extIdRaw}/${idRaw} → (${clamped.x},${clamped.y})`
  )
  // 回传钳制后的实际坐标：扩展入口用它校正自己记录的位置（OverlayResult.position 由 create 与本方法回传）
  return { ok: true, position: { x: clamped.x, y: clamped.y } }
}

/**
 * 注册 overlay 四条 IPC（main/index.ts 调用，与 registerAppWindowIpc 并列）。
 *
 * extId 由宿主（core/host.ts buildOverlayApi）在构造 api 时绑定为**调用方扩展 id**——
 * 作用域校验防的是误用/串号，不是沙箱边界（扩展与宿主同进程同上下文，ADR-0015：
 * 能力封装而非安全边界）。越权一律 `{ ok:false, error }` + `[overlay]` 前缀 console.warn。
 */
export function registerOverlayIpc(): void {
  ipcMain.handle('overlay:create', (_e, extId: unknown, req: unknown): OverlayResult =>
    createOverlayWindow(extId, req)
  )
  ipcMain.handle('overlay:destroy', (_e, extId: unknown, id: unknown): OverlayResult =>
    destroyOverlay(extId, id)
  )
  ipcMain.handle(
    'overlay:set-mouse-through',
    (_e, extId: unknown, id: unknown, through: unknown): OverlayResult =>
      setOverlayMouseThrough(extId, id, through)
  )
  ipcMain.handle(
    'overlay:set-position',
    (_e, extId: unknown, id: unknown, x: unknown, y: unknown): OverlayResult =>
      setOverlayPosition(extId, id, x, y)
  )
}
