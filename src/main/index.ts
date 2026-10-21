import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  safeStorage,
  shell
} from 'electron'
import { access, mkdir } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createWindow, getMainWindow, registerWindowIpc } from './window'
import { createTray, destroyTray, isTrayActive } from './tray'
import { registerAutoStartIpc, startedByAutoStart } from './autoStart'
import {
  installWindowBehavior,
  isQuitting,
  loadWindowBehavior,
  markQuitting,
  migrateLegacyPreferences,
  registerWindowBehaviorIpc,
  showAboutDialog
} from './windowBehavior'
import { cleanupAllExtensionResources, cleanupExtensionResources } from './extensionCleanup'
import { secondaryInstanceNotice } from './singleInstanceCore'
import { registerCapabilityIpc } from './capabilities'
import { registerExtensionProtocol } from './protocol'
import {
  registerAppWindowIpc,
  closeAllAppWindowsOnMainClose,
  registerOverlayIpc,
  // EH-B3a：overlay 四方法的**真实实现**（含越权判定与 workArea 钳位）。本卡只给它们加了
  // `export`（裁定 R66），函数体一行未动——宿主 RPC 因此复用同一份安全校验，不抄第二份。
  createOverlayWindow,
  destroyOverlay,
  setOverlayMouseThrough,
  setOverlayPosition,
  setOverlayTheme
} from './appWindow'
import { THEME_TOKENS_PUSH_CHANNEL } from '../shared/themeTokens'
// EH-B3a：dialog 的两个**纯函数**（属性归一 / 目录模式判定）是既有的，复用而不是重写规则
import { isDirectoryProperties, normalizeDialogProperties } from './ext'
import { registerOixIpc } from './oix'
import {
  checkUpdateForHost,
  downloadUpdateForHost,
  forceInstallForHost,
  installUpdateForHost,
  registerUpdateIpc,
  resolveFeedForHost,
  onUpdateEvent
} from './updater'
import { parseDebugExtensions, registerDebugIpc } from './debug'
import { registerDebugExtensionDirs } from './extensionDirs'
import { registerSqliteIpc } from './sqlite'
import { registerTimerIpc } from './timer'
import { registerNotificationIpc } from './notification'
import { registerNetIpc } from './net'
import { currentProxy } from './proxy'
import { registerAiIpc } from './ai'
import { registerFsIpc } from './fs'
import { registerExtIpc } from './ext'
import { registerSecretsIpc } from './secrets'
import { registerUiIpc } from './ui'
import { registerIpcBridge } from './ipc'
import { registerPythonIpc } from './python'
import {
  DEFAULT_HOST_API_VERSION,
  createExtensionHostStarter,
  type ExtensionHostStarter
} from './extensionHostStarter'
import {
  createInitEnvelope,
  validateEnvelope,
  type HostedExtensionInfo
} from '../shared/extensionHostProtocol'
// EH-B1：这两条是**宿主内部 RPC**（宿主进程 → main），不进扩展 API 面——扩展看到的是
// `api.net.fetch` / `api.clipboard`，这里只是宿主实现它们时向 main 借的两样东西。
import { CLIPBOARD_METHOD, PROXY_CONFIG_METHOD } from '../extension-host/capabilities/io'
// EH-B2：`host.pythonRuntime` —— 宿主拿不到 Python 运行时（exe/env/cwd 由 main 解析），
// 形状与类型定义都在宿主能力文件里（单一口径，防两边漂移）。
import {
  PYTHON_RUNTIME_METHOD,
  type PythonRuntimeResponse
} from '../extension-host/capabilities/python'
// EH-B3a：主进程类能力族（window / overlay / dialog / shell / notification / secrets /
// update.getVersion / proxy.get）的宿主内部 RPC。方法名与事件 channel 都从宿主能力文件
// import——两边同一个常量对象，名字不可能漂；`test/extension-host-host-main.test.ts` 还有
// 一条源码门禁逐个 key 断言这里确实注册了它。
import {
  HOST_MAIN_EVENT_CHANNELS,
  HOST_MAIN_METHODS
} from '../extension-host/capabilities/host-main'
import { extensionSourceDir } from './paths'
import { pickLocale } from './windowBehaviorCore'
import { buildPythonEnv, pythonExecutablePath, pythonUserSiteDir } from './pythonCore'
import { resolveProgramInExtension } from './ipcTransport'
import type {
  DialogOpenOptions,
  ExtensionHostStartOutcome,
  ExtensionHostStatusSnapshot,
  ProxyConfig
} from '../shared/types'

/**
 * 扩展宿主进程启动器（ADR-0026 / EH-A2）。**只注册、不启动**：`start()` 必须由渲染侧经
 * `eh:start` 主动请求（EH-A4 的交接），默认配置下永远不触发。
 * 放在模块级是因为退出清理（`before-quit`）在 `whenReady` 之外。
 */
let extensionHost: ExtensionHostStarter | null = null

/* -------------------------------------------------------------------------------------------- */
/* 扩展宿主 IPC（EH-A4）：名字与 preload 的 invoke 一一对应                                       */
/* -------------------------------------------------------------------------------------------- */

/** 渲染侧请求启动宿主（载荷 = `HostedExtensionInfo[]`） */
export const EH_START_IPC = 'eh:start'

/** 渲染侧主动停止宿主（幂等） */
export const EH_STOP_IPC = 'eh:stop'

/** 读状态快照（含崩溃原因）；端口状态另有 A2 的 `eh:get-port` */
export const EH_STATUS_IPC = 'eh:get-status'

/** 状态迁移的广播 channel（渲染侧 `window.eh.onStatus` 与 `window.events` 都听它） */
export const EH_STATUS_CHANNEL = 'eh:status'

/* -------------------------------------------------------------------------------------------- */
/* EH-B3a：main → 宿主的**事件队列**（推送的降级实现，见 capabilities/host-main.ts 文件头）            */
/* -------------------------------------------------------------------------------------------- */

/** 一条待宿主拉取的事件 */
interface HostEventEntry {
  /** 单调递增序号（宿主的游标；0 保留给"还没取过"） */
  seq: number
  channel: string
  payload: unknown
  /** 定向扩展 id；`undefined` = 广播类事件（窗口聚焦 / 更新事件） */
  extId?: string
}

/**
 * 队列容量。宿主按 250ms 轮询，正常只会有 1~2 条在队列里；这个上限只是"没人轮询时不许无限涨"
 * 的兜底（宿主没启动 / 扩展已停用期间的事件会被丢弃——那些事件本来也没人接）。
 */
const HOST_EVENT_QUEUE_LIMIT = 512

let hostEventSeq = 0
const hostEventQueue: HostEventEntry[] = []

/**
 * 记一条 main 侧事件，等宿主经 `host.event.poll` 取走。
 *
 * 为什么是队列 + 游标而不是直接推送：main → 宿主需要一个协议信封，本卡不动协议
 * （`runtime.ts` 明确丢弃 `event` 信封），所以按裁定 R65 用**游标轮询**降级——
 * 宿主侧被隔离在 `HostEventSource` 窄接口后面，将来换推送只改那一层。
 */
function enqueueHostEvent(channel: string, payload: unknown, extId?: string): void {
  hostEventSeq += 1
  const entry: HostEventEntry = { seq: hostEventSeq, channel, payload }
  if (extId !== undefined) entry.extId = extId
  hostEventQueue.push(entry)
  while (hostEventQueue.length > HOST_EVENT_QUEUE_LIMIT) hostEventQueue.shift()
}

/** 取一个参数对象（宿主 RPC 的 `params` 允许任意形状；坏形状当空对象处理，由各 handler 自己报错） */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 错误 → 一行文本（与 `skills`/既有 IPC handler 的 `err instanceof Error ? err.message : String(err)` 同口径） */
function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 从宿主 RPC 参数里取代理配置（EH-B3b-2 的 `host.update.*`）。
 *
 * 为什么不当成"必需"：缺失时的语义与 v1 一致——`applyUpdaterProxy(undefined)` 会**回落到当前配置**
 * （渲染侧经 `proxy:apply` 推入 main 的那个），而不是把 session 重置为直连（见 `updater.ts` 注释）。
 * 因此这里只做形状兜底：不是普通对象就当"没传"。
 */
function readProxyParam(record: Record<string, unknown>): ProxyConfig | undefined {
  const proxy = record.proxy
  return typeof proxy === 'object' && proxy !== null && !Array.isArray(proxy)
    ? (proxy as ProxyConfig)
    : undefined
}

/**
 * 注入给宿主进程的界面语言（R69 / 技术债 #12）。
 *
 * 主进程没有渲染进程的 i18n（`app.getLocale()` 是唯一来源，见 `windowBehaviorCore.ts` 的说明），
 * 所以按同一个 `pickLocale()` 归一成 `zh` / `en`；读不到（极少数平台/测试环境）就回 `zh`
 * ——与宿主入口 `process.env.OBOX_LOCALE ?? 'zh'` 的缺省一致。
 */
function hostLocaleEnv(): string {
  try {
    return pickLocale(app.getLocale())
  } catch {
    return 'zh'
  }
}

/** 宿主窗口能力的**目标窗口**：与 v1 的 `window:action` 同口径（焦点窗口优先，否则主窗口） */
function hostTargetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  const main = getMainWindow()
  return main && !main.isDestroyed() ? main : null
}

/** 主窗口（任务栏进度、通知点击聚焦、事件源都只认它） */
function hostMainWindow(): BrowserWindow | null {
  const main = getMainWindow()
  return main && !main.isDestroyed() ? main : null
}

/* -------------------------------------------------------------------------------------------- */
/* EH-B3a：宿主通知与密钥的私有实现                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * 宿主发起的系统通知（`api.notification.show` 走宿主 → main）。
 *
 * 与 `registerNotificationIpc()` 的区别只有"点击事件的去处"：那边的点击 `broadcast` 给渲染进程
 * （渲染侧宿主分发 `onClick`），这边进 {@link enqueueHostEvent} 的队列等宿主的轮询取走
 * ——回调函数过不了 RPC，只能用 `notifId` 关联。
 *
 * 存活引用表必须持有强引用（同 `src/main/notification.ts` 的两条理由）：对象被 GC 会让点击
 * 回调丢失；扩展停用时也要能关掉它的通知。{@link closeHostNotifications} 由既有的
 * `extension:cleanup` 一起调用。
 */
const hostNotifications = new Map<number, { notification: Notification; extId: string }>()
let hostNotificationSeq = 0

/** 关闭并清理某扩展经宿主发出的全部通知（扩展停用/卸载时调用） */
function closeHostNotifications(extId: string): void {
  for (const [id, entry] of [...hostNotifications]) {
    if (entry.extId !== extId) continue
    entry.notification.close()
    hostNotifications.delete(id)
  }
}

/**
 * 通知图标解析（与 `src/main/notification.ts` 的 `resolveIcon` 同源）。
 *
 * ⚠️ 本卡的**文件所有权**只允许改 `index.ts`，因此这里逐字保留同一套解析规则
 * （`data:` / `app://` / `http(s)` / 本地路径 + 解析失败则忽略图标）；改一处必须改两处。
 */
async function resolveHostNotificationIcon(
  icon?: string
): Promise<Electron.NativeImage | undefined> {
  if (!icon) return undefined
  try {
    if (icon.startsWith('data:')) {
      const image = nativeImage.createFromDataURL(icon)
      return image.isEmpty() ? undefined : image
    }
    if (icon.startsWith('app://') || icon.startsWith('http:') || icon.startsWith('https:')) {
      const response = await fetch(icon)
      const buffer = Buffer.from(await response.arrayBuffer())
      const image = nativeImage.createFromBuffer(buffer)
      return image.isEmpty() ? undefined : image
    }
    const image = nativeImage.createFromPath(icon)
    return image.isEmpty() ? undefined : image
  } catch {
    return undefined
  }
}

/**
 * 密钥文件（`<userData>/secrets.json`，key = `<扩展id>:<键>`，值是 safeStorage 加密后的 base64）。
 *
 * ⚠️ 与 `src/main/secrets.ts` **同一份文件格式**：宿主与渲染侧扩展共用同一个密钥库是**有意**的
 * （迁移期同一扩展可能在两边跑，切换宿主后不能"密钥全丢"）。同样受文件所有权限制只能在本文件
 * 里重写，规则保持逐字一致；`test/extension-host-host-main.test.ts` 有一条源码门禁断言
 * 两处都走 `safeStorage`（防止有人日后把它换成明文实现）。
 */
function hostSecretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

function loadHostSecrets(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(hostSecretsPath(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function saveHostSecrets(data: Record<string, string>): void {
  writeFileSync(hostSecretsPath(), JSON.stringify(data, null, 2), 'utf8')
}

function hostSecretsKeyOf(extId: string, key: string): string {
  return `${extId}:${key}`
}

/**
 * 系统加密是否**真**可用（同 `src/main/secrets.ts` 的 fail-closed 判定）：
 * Linux 上 `isEncryptionAvailable()` 可能为 true 而后端回落 `basic_text`（明文存储），
 * 因此额外看 `getSelectedStorageBackend()`；查到 `basic_text` 视为不可用。
 */
function hostEncryptionUsable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string })
    .getSelectedStorageBackend
  if (typeof backend === 'function') {
    try {
      if (backend.call(safeStorage) === 'basic_text') return false
    } catch {
      // 非 Linux 平台无此 API 或调用失败：按 isEncryptionAvailable 的结果处理
    }
  }
  return true
}

/**
 * 文件是否存在（EH-B2 的 `host.pythonRuntime` 用：解释器与脚本都要先自证存在，
 * 好让宿主拿到稳定错误码 `python-missing` / `invalid-declaration` 而不是一个 spawn 失败）。
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/** 把宿主状态迁移广播给所有窗口（单个窗口抛错不得打断其它窗口） */
function broadcastExtensionHostStatus(status: ExtensionHostStatusSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(EH_STATUS_CHANNEL, status)
    } catch {
      // 窗口正在销毁：这次状态没人收，等下一次迁移
    }
  }
}

/**
 * 确保主窗口存在并可见（启动、托盘"打开/设置"、第二实例唤前台与 macOS activate 共用）。
 * 窗口被销毁时重建——托盘常驻模式下"窗口没了"不该等于"应用没了"（ADR-0019 决策 6）。
 */
function ensureMainWindow(options: { hidden?: boolean } = {}): BrowserWindow {
  const existing = getMainWindow()
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }
  const created = createWindow({ startHidden: options.hidden })
  // 关闭拦截（收进托盘/弹提示）与"主窗口关闭时关闭所有 App 子窗口"
  installWindowBehavior(created, { trayAvailable: isTrayActive })
  closeAllAppWindowsOnMainClose(created)
  return created
}

// 单实例（ADR-0019 决策 9）：第二个进程不转发参数，只把已有主窗口唤到前台，并把"参数被忽略"写进日志
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  console.warn('[single-instance] ' + secondaryInstanceNotice(process.argv.slice(1), app.getName()))
}
if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    // 开机自启拉起的第二实例：静默退出，不把窗口抢到前台（ADR-0019 决策 13）
    if (startedByAutoStart(argv)) {
      console.log('[auto-start] 已有实例在运行：本次开机自启静默退出（不唤前台）')
      return
    }
    console.warn('[single-instance] ' + secondaryInstanceNotice(argv, app.getName()))
    ensureMainWindow()
  })
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) {
    app.exit(0)
    return
  }
  electronApp.setAppUserModelId('com.obox.app')

  // 关闭行为偏好（ADR-0019）：在主窗口创建前读入，坏文件回落默认
  loadWindowBehavior()
  // 更名迁移：新偏好文件不存在时读一次旧 window-behavior.json
  migrateLegacyPreferences()

  // 调试扩展（--debug-extension <id>@<path>，可重复）：不做 .oix 安装，经 app://debug/<id>/ 加载
  const debugExtensions = parseDebugExtensions(process.argv)
  // 供 api.python / api.ipc 解析“扩展自己的文件在哪”（调试扩展优先于 userData）
  registerDebugExtensionDirs(debugExtensions)

  // 注册 app:// 自定义协议：供渲染进程加载用户扩展入口（app://extensions/<id>/...）
  registerExtensionProtocol(debugExtensions)

  // 窗口控制 + 能力服务 + App 子窗口 IPC + .oix 安装 + 更新服务 + 调试扩展 + 扩展能力（sqlite/定时器/通知）
  registerWindowIpc()
  registerWindowBehaviorIpc()
  registerAutoStartIpc()
  registerCapabilityIpc()
  registerAppWindowIpc()
  // overlay 窗体四条 IPC（create/destroy/set-mouse-through/set-position，卡 03/14）：桌面宠物类
  // 后台扩展的常驻桌面小窗；作用域（只能操作自己创建的 overlay）由主进程按扩展 id 校验
  registerOverlayIpc()
  registerOixIpc()
  registerUpdateIpc()
  registerDebugIpc(debugExtensions)
  registerSqliteIpc()
  registerTimerIpc()
  registerNotificationIpc()
  registerNetIpc()
  // 「设置 → AI」的测试连接（宿主内部；在 netSession 上发 ⇒ 与 api.net.fetch 同一条代理链路）
  registerAiIpc()
  registerFsIpc()
  registerExtIpc()
  registerSecretsIpc()
  registerUiIpc()
  registerIpcBridge()
  registerPythonIpc()

  // 扩展停用/卸载/重载时清理其主进程资源（定时器 + 数据库连接 + 文件监听 + 系统通知 + IPC 通道 + Python 进程）
  ipcMain.handle('extension:cleanup', (_e, extId: string): void => {
    cleanupExtensionResources(String(extId))
    // EH-B3a：宿主经 RPC 发出的通知不在 `notification.ts` 的引用表里，得单独关
    // （否则扩展停用后旧通知被点击仍会往已停用的扩展投事件）
    closeHostNotifications(String(extId))
  })

  // 更新事件广播到所有窗口（渲染进程扩展订阅）
  onUpdateEvent((e) => {
    const payload = {
      type: e.type,
      info: e.type === 'update-available' ? e.info : undefined,
      percent: e.type === 'download-progress' ? (e as { percent: number }).percent : undefined,
      bytesPerSecond:
        e.type === 'download-progress'
          ? (e as { bytesPerSecond: number }).bytesPerSecond
          : undefined,
      transferred:
        e.type === 'download-progress' ? (e as { transferred: number }).transferred : undefined,
      total: e.type === 'download-progress' ? (e as { total: number }).total : undefined,
      message: e.type === 'error' ? (e as { message: string }).message : undefined,
      version: e.type === 'update-downloaded' ? (e as { version: string }).version : undefined
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('update:event', payload)
    }
    // EH-B3a：同一份载荷也进宿主事件队列（`api.update.onEvent` 的订阅者经轮询取走）。
    // 更新事件是**进程级**的，不带 extId（广播给所有订阅了 onEvent 的扩展）——与 v1 的
    // `window.events.on('update:event')` 语义一致。
    enqueueHostEvent(HOST_MAIN_EVENT_CHANNELS.updateEvent, payload)
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 开机自启（注册项带 --autostart）：静默启动，不显示主窗口（ADR-0019 决策 13）
  const hiddenAtStartup = startedByAutoStart(process.argv)
  if (hiddenAtStartup) console.log('[auto-start] 由开机自启拉起：静默启动，只创建托盘')
  const mainWindow = ensureMainWindow({ hidden: hiddenAtStartup })

  // 扩展宿主进程（ADR-0026 / EH-A2）的**注册接线**：通道 IPC（eh:get-port）+ 与主窗口同生共死
  // （closed ⇒ terminate/kill，宽限后强杀）。本卡不启动宿主，现有行为不变。
  const starter = createExtensionHostStarter({
    entryPoint: join(__dirname, 'extension-host.js'),
    dataDir: app.getPath('userData'),
    // ---- R69：修技术债 #12（宿主 fork 时补齐 OBOX_* 环境变量） ----
    // 宿主入口（`src/extension-host/index.ts`）的 `readAppInfo()` / `locale` 只读这三个 env，缺它们
    // 时 `api.appInfo` 恒为 `obox 0.0.0`、`api.env.language` 恒为 `zh`（B3b-1 只能靠渲染侧 settings
    // 快照事后校准 i18n 语言，appInfo 无法校准——它不在快照里）。`init` 信封没有版本字段，而加字段
    // 要升 `PROTOCOL_VERSION`，所以 env 是成本最低且与现有入口约定一致的做法。
    env: {
      OBOX_APP_NAME: app.getName(),
      OBOX_APP_VERSION: app.getVersion(),
      // 主进程唯一的语言来源是 `app.getLocale()`（见 `windowBehaviorCore` 的 `pickLocale`）；
      // 渲染侧随后会用 settings 快照覆盖成用户实际选择的语言。
      OBOX_LOCALE: hostLocaleEnv()
    }
  })
  starter.registerIpc()
  starter.bindWindow(mainWindow)
  extensionHost = starter

  // ---- EH-A4：渲染侧请求式启动（回退开关的"开"这一半；"关"这一半在渲染侧，这里一次都不触发） ----
  // 为什么不在 whenReady 里无条件 start()：宿主能力目前多数是桩（会抛 EH_INTERNAL），默认必须让
  // 用户扩展继续在渲染进程执行。于是 main 只提供入口，**触发权在渲染侧的 `ehStart`**。
  ipcMain.handle(
    EH_START_IPC,
    async (_event, rawExtensions: unknown): Promise<ExtensionHostStartOutcome> => {
      if (!Array.isArray(rawExtensions)) {
        return {
          ok: false,
          code: 'EH_INTERNAL',
          message: 'eh:start 的载荷必须是用户扩展清单数组（HostedExtensionInfo[]）'
        }
      }
      const extensions = rawExtensions as HostedExtensionInfo[]
      // 形状兜底：借用协议自己的 init 信封校验（渲染侧已经校验过一遍，main 不信单侧）
      const probe = validateEnvelope(
        createInitEnvelope({
          apiVersion: DEFAULT_HOST_API_VERSION,
          dataDir: app.getPath('userData'),
          extensions
        })
      )
      if (!probe.ok) {
        return {
          ok: false,
          code: probe.code,
          message: '扩展清单形状不合法，已拒绝启动扩展宿主',
          detail: probe.why
        }
      }
      if (probe.env.t !== 'init') {
        // 不可能发生（上面构造的就是 init），写出来只是为了让类型收窄成 InitEnvelope
        return {
          ok: false,
          code: 'EH_INTERNAL',
          message: '扩展清单校验没有产出 init 信封（内部实现错误）'
        }
      }
      return await starter.start(probe.env.extensions)
    }
  )
  ipcMain.handle(EH_STOP_IPC, async (): Promise<void> => {
    await starter.stop()
  })
  ipcMain.handle(EH_STATUS_IPC, (): ExtensionHostStatusSnapshot => starter.getStatus())
  // 状态迁移（idle → starting → ready → …）推给窗口：A5 / 扩展管理器据此展示 phase 与崩溃原因
  starter.onStatus(broadcastExtensionHostStatus)

  // ---- 主题 token 下发（overlay 浮层，2.0.1）----
  // 渲染侧主题生效后上报一份"当前生效 token"快照；这里缓存并广播给所有浮层窗口。
  // 浮层是主进程建的独立文档，拿不到主窗口 documentElement 上的 CSS 变量（这就是
  // "宠物面板透明"的根因）；载荷形状与 token 名校验在 shared/themeTokens.ts。
  ipcMain.on(THEME_TOKENS_PUSH_CHANNEL, (_event, payload: unknown): void => {
    setOverlayTheme(payload)
  })

  // ---- EH-B1：宿主 → main 的两条内部 RPC（宿主能力实现用，不进扩展 API 面） ----
  // 1) 代理配置：宿主进程没有 Chromium session，`net.fetch` 只能自己应用代理/忽略 SSL，
  //    而唯一真相是 main 的 `currentProxy()`（渲染侧启动与改设置时经 `proxy:apply` 推入）。
  starter.registerMethod(PROXY_CONFIG_METHOD, (): { proxy?: ProxyConfig; ignoreSSL: boolean } => {
    const proxy = currentProxy()
    // `ignoreSSL` 是**独立开关**（与 main 的 `applyProxyToSession` 一致）：只看 `ignoreSSL === true`、
    // 不看 `enabled`，所以"关掉代理但仍忽略证书"这种组合也照原样继承过来。
    return { proxy: proxy ?? undefined, ignoreSSL: proxy?.ignoreSSL === true }
  })
  // 2) 剪贴板：Electron `clipboard` 只在 main/renderer 可用，宿主进程（utilityProcess）没有该模块
  starter.registerMethod(CLIPBOARD_METHOD, (params: unknown) => {
    const record: { action?: unknown; text?: unknown } =
      typeof params === 'object' && params !== null
        ? (params as { action?: unknown; text?: unknown })
        : {}
    try {
      if (record.action === 'read') return { ok: true, text: clipboard.readText() }
      if (record.action === 'write') {
        if (typeof record.text !== 'string') {
          return { ok: false, error: '写入剪贴板需要字符串 text' }
        }
        clipboard.writeText(record.text)
        return { ok: true }
      }
      return {
        ok: false,
        error: `未知的剪贴板操作（${String(record.action)}）：只支持 read / write`
      }
    } catch (error) {
      return {
        ok: false,
        error: `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  })

  // ---- EH-B2：宿主内部的第三条 RPC —— Python 运行时（形状见 src/extension-host/capabilities/python.ts） ----
  // 为什么必需：`api.python.run` 的执行方是宿主进程（进程与流都归宿主），但**运行时在哪、用哪份环境**
  // 只有 main 知道（`app.getPath('userData')` + 扩展目录解析 + 用户库目录）。宿主拿不到这些，所以
  // 由这条 RPC 把 exePath / scriptPath / env / cwd 交出去，宿主自己 spawn 与收流。
  // 这里**复用既有解析函数**（pythonCore 的 pythonExecutablePath / buildPythonEnv / pythonUserSiteDir、
  // ipcTransport 的 resolveProgramInExtension），不复制任何路径规则。
  starter.registerMethod(
    PYTHON_RUNTIME_METHOD,
    async (params: unknown): Promise<PythonRuntimeResponse> => {
      const record: { extId?: unknown; script?: unknown } =
        typeof params === 'object' && params !== null
          ? (params as { extId?: unknown; script?: unknown })
          : {}
      if (typeof record.extId !== 'string' || record.extId.trim() === '') {
        return { ok: false, code: 'invalid-declaration', error: '无效的扩展 id' }
      }
      const extId = record.extId
      const script = typeof record.script === 'string' ? record.script : ''
      const extensionDir = extensionSourceDir(extId)
      const exePath = pythonExecutablePath(extensionDir)
      if (!(await pathExists(exePath))) {
        return {
          ok: false,
          code: 'python-missing',
          error: `扩展未自带该架构的 Python 运行时：${exePath}`
        }
      }
      if (script.trim() === '') {
        return { ok: false, code: 'invalid-declaration', error: '脚本路径不能为空' }
      }
      let scriptPath: string
      try {
        // 越界（绝对路径 / `..`）一律拒绝（声明校验之外的第二道包含检查）
        scriptPath = resolveProgramInExtension(extensionDir, script)
      } catch (error) {
        return {
          ok: false,
          code: 'invalid-declaration',
          error: error instanceof Error ? error.message : String(error)
        }
      }
      if (!(await pathExists(scriptPath))) {
        return {
          ok: false,
          code: 'invalid-declaration',
          error: `脚本不存在：${script}`
        }
      }
      // data 目录：与 `src/main/python.ts` 的 `dataDirFor` 同一约定
      // （userData/extensions/<id>/data）——宿主侧的 `<扩展目录>/data` 指向同一处（R62）
      const dataDir = join(app.getPath('userData'), 'extensions', extId, 'data')
      // 用户库目录（随扩展升级保留；见 ADR-0018）：注入 PYTHONPATH 前确保存在
      await mkdir(pythonUserSiteDir(dataDir), { recursive: true })
      return {
        ok: true,
        exePath,
        scriptPath,
        cwd: dataDir,
        env: buildPythonEnv({ baseEnv: process.env, extensionDir, dataDir })
      }
    }
  )

  /* ------------------------------------------------------------------------------------------ */
  /* EH-B3a：主进程类能力族（宿主 → main）。每条能力一个 handler，实现复用既有 main 模块。          */
  /*                                                                                            */
  /* 约定（与主机能力文件一致）：`res.result` 就是扩展 API 的返回形状——`{ok:false}` 型能力保持         */
  /* `{ok, error?}`，`window`/`secrets` 这类按值/按抛错的能力用 `{ok, value?}`。宿主负责翻译成         */
  /* v1 的语义（见 `src/renderer/src/core/host.ts` 的既有分类），main 不做二次判断。                  */
  /* ------------------------------------------------------------------------------------------ */

  // ---- window(7)：窗口动作 / 状态 / 任务栏进度。目标窗口口径与 `window:action` 一致 ----
  starter.registerMethod(HOST_MAIN_METHODS.windowMinimize, () => {
    const win = hostTargetWindow()
    if (!win)
      return { ok: false, error: 'window.minimize 未执行：没有可用窗口（主窗口可能正在关闭）' }
    // 与 `window:action` 同规则：主窗口不在任务栏显示，有托盘就静默收进托盘（ADR-0019 决策 5）
    if (isTrayActive()) win.hide()
    else win.minimize()
    return { ok: true }
  })
  starter.registerMethod(HOST_MAIN_METHODS.windowToggleMaximize, () => {
    const win = hostTargetWindow()
    if (!win) {
      return {
        ok: false,
        error: 'window.toggleMaximize 未执行：没有可用窗口（主窗口可能正在关闭）'
      }
    }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { ok: true }
  })
  starter.registerMethod(HOST_MAIN_METHODS.windowClose, () => {
    const win = hostTargetWindow()
    if (!win) return { ok: false, error: 'window.close 未执行：没有可用窗口（主窗口可能正在关闭）' }
    win.close()
    return { ok: true }
  })
  starter.registerMethod(HOST_MAIN_METHODS.windowIsMaximized, () => {
    const win = hostTargetWindow()
    if (!win)
      return { ok: false, error: 'window.isMaximized 失败：没有可用窗口（主窗口可能正在关闭）' }
    return { ok: true, value: win.isMaximized() }
  })
  starter.registerMethod(HOST_MAIN_METHODS.windowIsFocused, () => {
    const win = hostTargetWindow()
    if (!win)
      return { ok: false, error: 'window.isFocused 失败：没有可用窗口（主窗口可能正在关闭）' }
    return { ok: true, value: win.isFocused() }
  })
  starter.registerMethod(HOST_MAIN_METHODS.windowSetProgressBar, (params: unknown) => {
    const progress = asRecord(params).progress
    // 合法数字越界按 v1 钳到 0~1；`NaN`/`Infinity`/非数字直接拒绝（v1 会把 NaN 交给 Electron，
    // 行为随平台不同——那属于静默的未定义行为，明确报错更好排查）
    if (progress !== null && (typeof progress !== 'number' || !Number.isFinite(progress))) {
      return {
        ok: false,
        error: 'window.setProgressBar 的 progress 必须是 0~1 的有限数字或 null'
      }
    }
    const win = hostMainWindow()
    if (!win) {
      return { ok: false, error: 'window.setProgressBar 未执行：主窗口不存在（可能正在关闭）' }
    }
    if (progress === null) win.setProgressBar(-1)
    else win.setProgressBar(Math.min(1, Math.max(0, progress)))
    return { ok: true }
  })

  // ---- overlay(4)：**复用** appWindow.ts 的真实实现（越权判定 / app:// 校验 / 钳位都在里面）----
  starter.registerMethod(HOST_MAIN_METHODS.overlayCreate, (params: unknown) => {
    const record = asRecord(params)
    return createOverlayWindow(record.extId, record.request)
  })
  starter.registerMethod(HOST_MAIN_METHODS.overlayDestroy, (params: unknown) => {
    const record = asRecord(params)
    return destroyOverlay(record.extId, record.id)
  })
  starter.registerMethod(HOST_MAIN_METHODS.overlaySetMouseThrough, (params: unknown) => {
    const record = asRecord(params)
    return setOverlayMouseThrough(record.extId, record.id, record.through)
  })
  starter.registerMethod(HOST_MAIN_METHODS.overlaySetPosition, (params: unknown) => {
    const record = asRecord(params)
    return setOverlayPosition(record.extId, record.id, record.x, record.y)
  })

  // ---- dialog(3)：与 `registerExtIpc()` 的 dialog:* 同源（属性归一/目录模式复用同一对纯函数）----
  starter.registerMethod(HOST_MAIN_METHODS.dialogOpen, async (params: unknown) => {
    const opts = asRecord(params).opts as DialogOpenOptions | undefined
    try {
      const properties = normalizeDialogProperties(opts)
      // 目录模式下丢弃 filters：Electron 不对目录应用过滤器
      const filters = isDirectoryProperties(properties) ? undefined : opts?.filters
      const win = BrowserWindow.getFocusedWindow()
      const result = win
        ? await dialog.showOpenDialog(win, { title: opts?.title, filters, properties })
        : await dialog.showOpenDialog({ title: opts?.title, filters, properties })
      return { ok: true, filePaths: result.filePaths, canceled: result.canceled }
    } catch (error) {
      return { ok: false, error: describeThrown(error) }
    }
  })
  starter.registerMethod(HOST_MAIN_METHODS.dialogSave, async (params: unknown) => {
    const opts = asRecord(params).opts as
      | {
          title?: string
          defaultName?: string
          filters?: Array<{ name: string; extensions: string[] }>
        }
      | undefined
    try {
      const win = BrowserWindow.getFocusedWindow()
      const result = win
        ? await dialog.showSaveDialog(win, {
            title: opts?.title,
            defaultPath: opts?.defaultName,
            filters: opts?.filters
          })
        : await dialog.showSaveDialog({
            title: opts?.title,
            defaultPath: opts?.defaultName,
            filters: opts?.filters
          })
      return { ok: true, filePath: result.filePath ?? undefined, canceled: result.canceled }
    } catch (error) {
      return { ok: false, error: describeThrown(error) }
    }
  })
  starter.registerMethod(HOST_MAIN_METHODS.dialogMessage, async (params: unknown) => {
    const opts = asRecord(params).opts as
      | {
          type?: 'info' | 'warning' | 'error' | 'question'
          title?: string
          message?: string
          detail?: string
          buttons?: string[]
        }
      | undefined
    try {
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        type: opts?.type ?? 'info',
        title: opts?.title,
        message: opts?.message ?? '',
        detail: opts?.detail,
        buttons: opts?.buttons && opts.buttons.length > 0 ? opts.buttons : undefined
      }
      const result = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      return { ok: true, response: result.response }
    } catch (error) {
      return { ok: false, error: describeThrown(error) }
    }
  })

  // ---- shell(2)：与 `registerExtIpc()` 的 shell:* 同源（http/https 白名单在 main 里）----
  starter.registerMethod(HOST_MAIN_METHODS.shellOpenExternal, async (params: unknown) => {
    const url = asRecord(params).url
    try {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return { ok: false, error: 'openExternal 仅支持 http/https 链接' }
      }
      await shell.openExternal(url)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: describeThrown(error) }
    }
  })
  starter.registerMethod(HOST_MAIN_METHODS.shellOpenPath, async (params: unknown) => {
    const target = asRecord(params).path
    try {
      if (typeof target !== 'string' || !target) return { ok: false, error: 'path 必填' }
      const errorMessage = await shell.openPath(target)
      return errorMessage ? { ok: false, error: errorMessage } : { ok: true }
    } catch (error) {
      return { ok: false, error: describeThrown(error) }
    }
  })

  // ---- notification(1)：`onClick` 留在宿主，main 只把 notifId 发进事件队列 ----
  starter.registerMethod(HOST_MAIN_METHODS.notificationShow, async (params: unknown) => {
    const record = asRecord(params)
    const extId = typeof record.extId === 'string' ? record.extId : ''
    const opts = asRecord(record.opts)
    try {
      if (extId === '') {
        return { ok: false, error: '缺少扩展 id（宿主接线错误：通知必须由宿主绑定扩展 id 调用）' }
      }
      if (typeof opts.title !== 'string' || opts.title.trim() === '') {
        return { ok: false, error: '通知 title 必填' }
      }
      const icon = await resolveHostNotificationIcon(
        typeof opts.icon === 'string' ? opts.icon : undefined
      )
      const notification = new Notification({
        title: opts.title,
        body: typeof opts.body === 'string' ? opts.body : '',
        icon
      })
      const notifId = ++hostNotificationSeq
      notification.on('click', () => {
        // 已被清理（扩展停用/卸载）→ 忽略点击，不再往已停用的扩展投事件
        if (!hostNotifications.has(notifId)) return
        // 与 `registerNotificationIpc()` 一致：点击先聚焦主窗口，再把事件交给扩展
        const main = hostMainWindow()
        if (main) {
          if (main.isMinimized()) main.restore()
          main.focus()
        }
        enqueueHostEvent(
          HOST_MAIN_EVENT_CHANNELS.notificationClick,
          { notifId, title: opts.title },
          extId
        )
      })
      notification.on('close', () => {
        hostNotifications.delete(notifId)
      })
      notification.show()
      hostNotifications.set(notifId, { notification, extId })
      return { ok: true, id: notifId }
    } catch (error) {
      return { ok: false, error: describeThrown(error) }
    }
  })

  // ---- secrets(3)：仍然**只经 safeStorage**（fail-closed：加密不可用就报错，绝不落明文）----
  starter.registerMethod(HOST_MAIN_METHODS.secretsGet, (params: unknown) => {
    const record = asRecord(params)
    const extId = typeof record.extId === 'string' ? record.extId : ''
    const key = typeof record.key === 'string' ? record.key : ''
    try {
      if (extId === '' || key === '') return { ok: false, error: 'secrets.get 需要 extId 与 key' }
      if (!hostEncryptionUsable()) return { ok: false, error: '系统加密不可用（safeStorage）' }
      const encrypted = loadHostSecrets()[hostSecretsKeyOf(extId, key)]
      if (encrypted === undefined) return { ok: true, value: undefined }
      return {
        ok: true,
        value: safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      }
    } catch (error) {
      return { ok: false, error: describeThrown(error) }
    }
  })
  starter.registerMethod(HOST_MAIN_METHODS.secretsSet, (params: unknown) => {
    const record = asRecord(params)
    const extId = typeof record.extId === 'string' ? record.extId : ''
    const key = typeof record.key === 'string' ? record.key : ''
    const value = record.value
    try {
      if (extId === '' || key === '') return { ok: false, error: 'secrets.set 需要 extId 与 key' }
      if (typeof value !== 'string')
        return { ok: false, error: 'secrets.set 的 value 必须是字符串' }
      if (!hostEncryptionUsable()) return { ok: false, error: '系统加密不可用（safeStorage）' }
      const data = loadHostSecrets()
      data[hostSecretsKeyOf(extId, key)] = safeStorage.encryptString(value).toString('base64')
      saveHostSecrets(data)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: describeThrown(error) }
    }
  })
  starter.registerMethod(HOST_MAIN_METHODS.secretsDelete, (params: unknown) => {
    const record = asRecord(params)
    const extId = typeof record.extId === 'string' ? record.extId : ''
    const key = typeof record.key === 'string' ? record.key : ''
    try {
      if (extId === '' || key === '')
        return { ok: false, error: 'secrets.delete 需要 extId 与 key' }
      const data = loadHostSecrets()
      delete data[hostSecretsKeyOf(extId, key)]
      saveHostSecrets(data)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: describeThrown(error) }
    }
  })

  // ---- update：`getVersion` / 事件（v1 里没有门控的两项）+ EH-B3b-2 的 4 条门控方法 ----
  // 门控本身**不在 main**：真相是渲染侧的 `updaterStore.isActive`，宿主先问 `ui.updateGate`，
  // 只有放行后才会发这四条过来（R70）。实现全部复用 `./updater` 的具名导出（既有 IPC handler
  // 也调用同一批函数），因此宿主路径与渲染路径是同一份逻辑，不存在第二套。
  starter.registerMethod(HOST_MAIN_METHODS.updateVersion, () => ({
    ok: true,
    value: app.getVersion()
  }))
  starter.registerMethod(
    HOST_MAIN_METHODS.updateResolveFeed,
    async (params: unknown): Promise<unknown> => {
      const record = asRecord(params)
      return await resolveFeedForHost(
        typeof record.repo === 'string' ? record.repo : '',
        readProxyParam(record)
      )
    }
  )
  starter.registerMethod(
    HOST_MAIN_METHODS.updateCheck,
    async (params: unknown): Promise<unknown> => {
      const record = asRecord(params)
      return await checkUpdateForHost({
        feedUrl: typeof record.feedUrl === 'string' ? record.feedUrl : undefined,
        proxy: readProxyParam(record)
      })
    }
  )
  starter.registerMethod(HOST_MAIN_METHODS.updateDownload, async (): Promise<unknown> => {
    return await downloadUpdateForHost()
  })
  starter.registerMethod(
    HOST_MAIN_METHODS.updateInstall,
    async (params: unknown): Promise<unknown> => {
      const record = asRecord(params)
      if (record.force === true) {
        return await forceInstallForHost({
          feedUrl: typeof record.feedUrl === 'string' ? record.feedUrl : undefined,
          proxy: readProxyParam(record),
          reason: 'user'
        })
      }
      // 非 force：v1 的 `install()` 只等 `installUpdate()`，回值固定 `{ok:true}`（`quitAndInstall` 不再回头）
      installUpdateForHost()
      return { ok: true }
    }
  )

  // ---- proxy.get：与 v1 同源（渲染侧 `network.proxy` 经 `proxy:apply` 推入 main 的镜像）----
  starter.registerMethod(HOST_MAIN_METHODS.proxyGet, () => ({
    ok: true,
    value: currentProxy() ?? null
  }))

  // ---- 事件轮询（R65 的降级通道）：cursor=null 只回当前游标，不回放历史 ----
  starter.registerMethod(HOST_MAIN_METHODS.eventsPoll, (params: unknown) => {
    const record = asRecord(params)
    const extId = typeof record.extId === 'string' ? record.extId : ''
    const rawCursor = record.cursor
    const cursor =
      typeof rawCursor === 'number' && Number.isInteger(rawCursor) && rawCursor >= 0
        ? rawCursor
        : null
    if (cursor === null) return { cursor: hostEventSeq, events: [] }
    // 广播事件（extId 缺省）所有订阅者都收；定向事件只给对应扩展（通知点击）
    const events = hostEventQueue
      .filter((entry) => entry.seq > cursor && (entry.extId === undefined || entry.extId === extId))
      .map((entry) => ({ channel: entry.channel, payload: entry.payload }))
    return { cursor: hostEventSeq, events }
  })

  // ---- 聚焦事件源：主窗口的聚焦/失焦（子窗口、overlay 的聚焦不算 `api.window` 的语义）----
  app.on('browser-window-focus', (_event, win) => {
    if (win !== getMainWindow()) return
    enqueueHostEvent(HOST_MAIN_EVENT_CHANNELS.windowFocus, { focused: true })
  })
  app.on('browser-window-blur', (_event, win) => {
    if (win !== getMainWindow()) return
    enqueueHostEvent(HOST_MAIN_EVENT_CHANNELS.windowFocus, { focused: false })
  })

  // 系统托盘（仅 Windows）：右键 打开/设置/关于/退出，双击打开（ADR-0019 决策 3/4）
  const SETTINGS_NAV_ID = 'settings.main' // 内置 settings 扩展声明的导航项 id
  createTray({
    open: () => void ensureMainWindow(),
    settings: () => {
      const win = ensureMainWindow()
      win.webContents.send('nav:open', SETTINGS_NAV_ID)
    },
    about: () => showAboutDialog(getMainWindow() ?? undefined),
    quit: () => {
      markQuitting()
      app.quit()
    }
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) ensureMainWindow()
  })
})

// 退出前统一清理（ADR-0019 决策 10）：遍历"已知扩展"跑与热移除同一组清理。
// 动机有实测证据：宿主被强杀时 Python 对端会成为孤儿进程并占住 IPC 端点，下次启动报 not-connected。
app.on('before-quit', () => {
  markQuitting()
  destroyTray()
  // 扩展宿主随应用退出一起清理（幂等：窗口 closed 时可能已经清过；不 await 以免拖住退出）
  void extensionHost?.dispose()
  void cleanupAllExtensionResources().then((result) => {
    const tail =
      (result.failed ? '，失败 ' + result.failed : '') + (result.timedOut ? '（超时兜底）' : '')
    console.log('[quit] 主进程资源清理完成：' + result.cleaned + ' 个扩展' + tail)
  })
})

app.on('window-all-closed', () => {
  // 托盘常驻 + 未在退出流程时，窗口被销毁不等于退出（ADR-0019 决策 6）；
  // 真正退出走托盘"退出"或偏好=退出（那时 quitting 已置位）
  if (isTrayActive() && !isQuitting()) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
