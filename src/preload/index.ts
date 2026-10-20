import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ExtensionHostBridgeSurface,
  ExtensionHostPortArrival,
  ExtensionHostPortBridge,
  ExtensionHostPortStatus,
  ExtensionHostStartOutcome,
  ExtensionHostStatusSnapshot,
  MainApi,
  MainEvents,
  WindowAction
} from '../shared/types'
import type { HostedExtensionInfo } from '../shared/extensionHostProtocol'

// 渲染进程可调用的能力桥（经 contextBridge 暴露为 window.api）
const api: MainApi = {
  windowAction: (action: WindowAction) => ipcRenderer.invoke('window:action', action),
  getWindowState: () => ipcRenderer.invoke('window:get-state'),
  getCloseBehavior: () => ipcRenderer.invoke('window:get-close-behavior'),
  setCloseBehavior: (behavior) => ipcRenderer.invoke('window:set-close-behavior', behavior),
  getAutoStart: () => ipcRenderer.invoke('app:get-auto-start'),
  setAutoStart: (enabled) => ipcRenderer.invoke('app:set-auto-start', enabled),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  listUserExtensions: () => ipcRenderer.invoke('extensions:list-user'),
  listDebugExtensions: () => ipcRenderer.invoke('extensions:list-debug'),
  uninstallUserExtension: (id) => ipcRenderer.invoke('extensions:uninstall', id),
  runUninstallHook: (id) => ipcRenderer.invoke('extensions:run-uninstall-hook', id),
  installUserExtensionViaDialog: () => ipcRenderer.invoke('extensions:install-oix-dialog'),
  installUserExtensionFromPath: (filePath) =>
    ipcRenderer.invoke('extensions:install-oix-path', filePath),
  // 拖拽 .oix 安装：取 File 的真实磁盘路径（Electron 官方拖拽模式）
  getPathForFile: (file) => webUtils.getPathForFile(file as File),
  capture: (outPath) => ipcRenderer.invoke('window:capture', outPath),
  eval: (script) => ipcRenderer.invoke('window:eval', script),
  openAppWindow: (req) => ipcRenderer.invoke('app:open-window', req),
  getOboxVersion: () => ipcRenderer.invoke('update:get-version'),
  resolveUpdateFeed: (repo, proxy) => ipcRenderer.invoke('update:resolve-feed', repo, proxy),
  checkUpdate: (opts) => ipcRenderer.invoke('update:check', opts),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  forceInstallUpdate: (opts) => ipcRenderer.invoke('update:force-install', opts),
  // 扩展能力：与外部进程的端口无关 IPC（stdio / 命名管道；客户端连接 · 服务端 listen）
  ipcConnect: (extId, declaration) => ipcRenderer.invoke('ipc:connect', extId, declaration),
  ipcListen: (extId, declaration) => ipcRenderer.invoke('ipc:listen', extId, declaration),
  ipcClose: (extId, name) => ipcRenderer.invoke('ipc:close', extId, name),
  ipcList: (extId) => ipcRenderer.invoke('ipc:list', extId),
  ipcRequest: (extId, name, method, params, timeoutMs, connectionId) =>
    ipcRenderer.invoke('ipc:request', extId, name, method, params, timeoutMs, connectionId),
  ipcNotify: (extId, name, method, params, connectionId) =>
    ipcRenderer.invoke('ipc:notify', extId, name, method, params, connectionId),
  ipcBroadcast: (extId, name, method, params) =>
    ipcRenderer.invoke('ipc:broadcast', extId, name, method, params),
  ipcReply: (requestId, outcome) => ipcRenderer.invoke('ipc:reply', requestId, outcome),
  // 扩展能力：定时器
  setTimerTimeout: (extId, id, seconds) =>
    ipcRenderer.invoke('timer:set-timeout', extId, id, seconds),
  setTimerInterval: (extId, id, seconds) =>
    ipcRenderer.invoke('timer:set-interval', extId, id, seconds),
  clearTimer: (extId, id) => ipcRenderer.invoke('timer:clear', extId, id),
  // 扩展能力：sqlite
  sqliteOpen: (extId, name) => ipcRenderer.invoke('sqlite:open', extId, name),
  sqliteClose: (extId, name) => ipcRenderer.invoke('sqlite:close', extId, name),
  sqliteExec: (extId, name, sql) => ipcRenderer.invoke('sqlite:exec', extId, name, sql),
  sqliteQuery: (extId, name, sql, params) =>
    ipcRenderer.invoke('sqlite:query', extId, name, sql, params),
  sqliteInsert: (extId, name, row) => ipcRenderer.invoke('sqlite:insert', extId, name, row),
  sqliteUpdate: (extId, name, where, patch) =>
    ipcRenderer.invoke('sqlite:update', extId, name, where, patch),
  sqliteGet: (extId, name, id) => ipcRenderer.invoke('sqlite:get', extId, name, id),
  sqliteGetAll: (extId, name) => ipcRenderer.invoke('sqlite:get-all', extId, name),
  sqliteGetBy: (extId, name, where) => ipcRenderer.invoke('sqlite:get-by', extId, name, where),
  sqliteDel: (extId, name, id) => ipcRenderer.invoke('sqlite:del', extId, name, id),
  sqliteDelBy: (extId, name, where) => ipcRenderer.invoke('sqlite:del-by', extId, name, where),
  sqliteClear: (extId, name) => ipcRenderer.invoke('sqlite:clear', extId, name),
  // 扩展能力：系统提醒
  showNotification: (extId, opts) => ipcRenderer.invoke('notification:show', extId, opts),
  // 扩展停用/卸载/重载时清理主进程资源
  cleanupExtension: (extId) => ipcRenderer.invoke('extension:cleanup', extId),
  // 扩展能力：overlay 窗体（桌面宠物类；作用域由主进程按 extId 校验，越权返回 ok:false，卡 03/R13）
  overlayCreate: (extId, options) => ipcRenderer.invoke('overlay:create', extId, options),
  overlayDestroy: (extId, id) => ipcRenderer.invoke('overlay:destroy', extId, id),
  overlaySetMouseThrough: (extId, id, through) =>
    ipcRenderer.invoke('overlay:set-mouse-through', extId, id, through),
  // 移动窗体（卡 14）：坐标钳位与合法性校验都在主进程（宿主兜底、扩展主钳，design D-13）
  overlaySetPosition: (extId, id, x, y) =>
    ipcRenderer.invoke('overlay:set-position', extId, id, x, y),
  // 扩展能力：网络（主进程 fetch + 代理）
  netFetch: (req, proxy) => ipcRenderer.invoke('net:fetch', req, proxy),
  // 宿主内部：渲染进程启动 / 代理设置变化时把代理推给主进程，由其同时应用到
  // 扩展联网（obox-net）与更新（electron-updater）两个 session（卡 20；主进程侧 registerProxyIpc）
  applyProxy: (proxy) => ipcRenderer.invoke('proxy:apply', proxy),
  // 宿主内部：「设置 → AI」的测试连接（主进程用 netSession() 发请求 ⇒ 继承宿主代理与忽略 SSL）
  aiTestConnection: (req) => ipcRenderer.invoke('ai:test-connection', req),
  // 扩展能力：文件系统（限定扩展 data 目录）
  fsReadFile: (extId, rel) => ipcRenderer.invoke('fs:read-file', extId, rel),
  fsWriteFile: (extId, rel, content) => ipcRenderer.invoke('fs:write-file', extId, rel, content),
  fsReadDir: (extId, rel) => ipcRenderer.invoke('fs:read-dir', extId, rel),
  fsExists: (extId, rel) => ipcRenderer.invoke('fs:exists', extId, rel),
  fsRemove: (extId, rel) => ipcRenderer.invoke('fs:remove', extId, rel),
  // 扩展能力：对话框 / 外链 / 剪贴板 / 任务栏进度
  dialogOpen: (opts) => ipcRenderer.invoke('dialog:open', opts),
  dialogSave: (opts) => ipcRenderer.invoke('dialog:save', opts),
  dialogMessage: (opts) => ipcRenderer.invoke('dialog:message', opts),
  shellOpenExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  shellOpenPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  setProgressBar: (progress) => ipcRenderer.invoke('window:set-progress-bar', progress),
  env: {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node
  },
  // 扩展能力：密钥存储（safeStorage 加密）
  secretsGet: (extId, key) => ipcRenderer.invoke('secrets:get', extId, key),
  secretsSet: (extId, key, value) => ipcRenderer.invoke('secrets:set', extId, key, value),
  secretsDelete: (extId, key) => ipcRenderer.invoke('secrets:delete', extId, key),
  // 扩展能力：文件监听（扩展 data 目录）
  fsWatch: (extId, watchId, rel) => ipcRenderer.invoke('fs:watch', extId, watchId, rel),
  fsUnwatch: (extId, watchId) => ipcRenderer.invoke('fs:unwatch', extId, watchId),
  // App 子窗口 ↔ 扩展消息桥
  extensionMessage: (appId, channel, payload) =>
    ipcRenderer.invoke('app:extension-message', { appId, channel, payload }),
  extensionReply: (requestId, result) =>
    ipcRenderer.send('extension:reply', { requestId, ...result }),
  // 窗口化 ui 模态框（按焦点窗口显示）
  uiShow: (kind, payload) => ipcRenderer.invoke('ui:show', { kind, payload }),
  uiResult: (requestId, r) => ipcRenderer.send('ui:result', { requestId, ...r }),
  // 生命周期钩子（issue #52）：宿主把入口导出的 install/uninstall 执行结果回传主进程
  hookResult: (result) => ipcRenderer.send('extension:hook-result', result),
  // 宿主补跑 install 钩子后回写元数据（发起方向与 hookResult 相反）
  recordInstallHook: (extId, version, ok) =>
    ipcRenderer.invoke('extension:record-install-hook', extId, version, ok),
  // 扩展自带的 Python 运行时（issue #51）：跑脚本（可选注册成 api.ipc 通道）
  pythonRun: (extId, input) => ipcRenderer.invoke('python:run', extId, input),
  // ---- 扩展宿主进程（ADR-0026 / EH-A4）：开关打开时由渲染侧请求 main 启动宿主 ----
  // 默认（开关关闭）这些方法一次都不会被调用：用户扩展继续在渲染进程执行。
  ehStart: (extensions: HostedExtensionInfo[]): Promise<ExtensionHostStartOutcome> =>
    ipcRenderer.invoke('eh:start', extensions),
  ehGetPort: (): Promise<ExtensionHostPortStatus> => ipcRenderer.invoke('eh:get-port'),
  ehGetStatus: (): Promise<ExtensionHostStatusSnapshot> => ipcRenderer.invoke('eh:get-status'),
  ehStop: (): Promise<void> => ipcRenderer.invoke('eh:stop')
}

// 主进程 → 渲染进程事件订阅
const events: { on<K extends keyof MainEvents>(channel: K, listener: MainEvents[K]): () => void } =
  {
    on: (channel, listener) => {
      const wrapped = (_e: unknown, ...args: unknown[]): void =>
        (listener as (...a: unknown[]) => void)(...args)
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    }
  }

/* -------------------------------------------------------------------------------------------- */
/* 扩展宿主渲染侧桥的暴露面（ADR-0026 / EH-A4）                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * 端口接收（A2 交付端的对侧）：main 在 fork 之后用
 * `webContents.postMessage('eh:port', payload, [port2])` 把 MessagePort 交给本窗口。
 *
 * 时机链（写在这里，方便排查"端口到底到没到"）：
 * 1. 渲染侧请求 `ehStart(清单)` → main `starter.start(清单)`；
 * 2. main `launch()`：`MessageChannelMain` 建一对端口 → fork 宿主 → **立刻**尝试投递 port2；
 * 3. 宿主回 `ready` → main 把 port1 随 `init` 一并 transfer 给宿主（信封字段里放不下端口）；
 * 4. 宿主回 `initialized` → `phase = 'ready'`，链路正式可用。
 *
 * `port.start()` 必须在 `onmessage` 之前/同时调用：`MessagePort` 在 `start()` 之前不派发消息
 * （宿主可能在 `ready` 之后就往端口里写过东西，那段是排队的，`start()` 后补发）。
 *
 * 为什么渲染世界拿到的是**端口代理**而不是 `MessagePort` 本身：`contextBridge` 不支持传
 * transferable（`MessagePort` 过不了隔离世界），而端口又不能经 `ipcMain.handle` 返回（A2 已确认：
 * `ipcMain.handle` 的返回值走结构化克隆，端口只认 `postMessage(channel, payload, [port])`）。
 * 因此真端口留在 preload，渲染世界只拿到 `post` / `onMessage` / 窄端口对象（`postMessage` / `close`）。
 */
const ehPortState: { port: MessagePort | null; arrival: ExtensionHostPortArrival | null } = {
  port: null,
  arrival: null
}

const ehPortListeners = new Set<
  (arrival: ExtensionHostPortArrival, port: ExtensionHostPortBridge) => void
>()
const ehMessageListeners = new Set<(raw: unknown) => void>()
const ehStatusListeners = new Set<(status: ExtensionHostStatusSnapshot) => void>()

/** `eh:port` 的载荷是 A2 的 `RendererPortPayload`；这里只挑需要的字段，坏形状兜成 null */
function readPortArrival(raw: unknown): ExtensionHostPortArrival {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    v?: unknown
    hostId?: unknown
    pid?: unknown
  }
  const arrival: ExtensionHostPortArrival = {
    hostId: typeof record.hostId === 'string' ? record.hostId : null,
    pid: typeof record.pid === 'number' ? record.pid : null
  }
  if (typeof record.v === 'number') arrival.v = record.v
  return arrival
}

/** 端口代理：跨 contextBridge 传的是这两个函数，不是 MessagePort */
function ehPortProxy(port: MessagePort): ExtensionHostPortBridge {
  return {
    postMessage: (envelope: unknown): void => {
      port.postMessage(envelope)
    },
    close: (): void => {
      try {
        port.close()
      } catch {
        // 端口已经关闭：close 是尽力而为
      }
      if (ehPortState.port === port) {
        ehPortState.port = null
        ehPortState.arrival = null
      }
    }
  }
}

/** 把到达事件派给订阅者（单个订阅者抛错不得打断其它订阅者） */
function notifyPortArrival(arrival: ExtensionHostPortArrival, port: MessagePort): void {
  for (const listener of [...ehPortListeners]) {
    try {
      listener(arrival, ehPortProxy(port))
    } catch (error) {
      console.error('[eh] 端口订阅者抛错', error)
    }
  }
}

ipcRenderer.on('eh:port', (event, payload: unknown) => {
  const port = event.ports?.[0]
  if (!port) {
    console.warn('[eh] eh:port 没有携带端口，已忽略（端口只能经 transfer 列表交付）')
    return
  }
  // ★ 端口开始派发消息（之前宿主写进来的消息在这之后补发）
  port.start()
  ehPortState.port = port
  ehPortState.arrival = readPortArrival(payload)
  port.onmessage = (message: MessageEvent): void => {
    for (const listener of [...ehMessageListeners]) {
      try {
        listener(message.data)
      } catch (error) {
        console.error('[eh] 消息订阅者抛错', error)
      }
    }
  }
  notifyPortArrival(ehPortState.arrival, port)
})

// 宿主状态（phase / 崩溃原因）：主进程每次迁移推一次；渲染侧桥再分发给订阅者
ipcRenderer.on('eh:status', (_event, status: unknown) => {
  if (typeof status !== 'object' || status === null) return
  const snapshot = status as ExtensionHostStatusSnapshot
  for (const listener of [...ehStatusListeners]) {
    try {
      listener(snapshot)
    } catch (error) {
      console.error('[eh] 状态订阅者抛错', error)
    }
  }
})

/**
 * `window.eh`：扩展宿主桥的暴露面。**只做搬运**——开关判定、信封校验、请求配对、超时、
 * 状态解释都在 `renderer/src/core/extensionHostBridge.ts`（那边能在单测里被假端口直接驱动）。
 */
const eh: ExtensionHostBridgeSurface = {
  extensionHostFlag: process.env.OBOX_EXTENSION_HOST ?? null,
  hasPort: (): boolean => ehPortState.port !== null,
  onPort: (listener) => {
    ehPortListeners.add(listener)
    const port = ehPortState.port
    const arrival = ehPortState.arrival
    if (port && arrival) {
      // 页面加载晚于端口投递（窗口创建即投递、渲染进程脚本后跑）：补发一次，别让订阅者永远等
      queueMicrotask(() => {
        if (!ehPortListeners.has(listener)) return
        try {
          listener(arrival, ehPortProxy(port))
        } catch (error) {
          console.error('[eh] 端口订阅者抛错', error)
        }
      })
    }
    return (): void => {
      ehPortListeners.delete(listener)
    }
  },
  onMessage: (listener) => {
    ehMessageListeners.add(listener)
    return (): void => {
      ehMessageListeners.delete(listener)
    }
  },
  post: (envelope: unknown): boolean => {
    const port = ehPortState.port
    // 端口未到就返回 false（不抛错）：中文可执行错误由渲染侧桥给，preload 不做文案
    if (!port) return false
    try {
      port.postMessage(envelope)
      return true
    } catch (error) {
      console.warn('[eh] 向扩展宿主发送失败', error)
      return false
    }
  },
  onStatus: (listener) => {
    ehStatusListeners.add(listener)
    return (): void => {
      ehStatusListeners.delete(listener)
    }
  }
}

// Custom APIs for renderer
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('events', events)
    contextBridge.exposeInMainWorld('eh', eh)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.events = events
  // @ts-ignore (define in dts)
  window.eh = eh
}
