/**
 * 主进程 / preload / 渲染进程 共享的 IPC 契约类型。
 * 扩展 API 类型见 src/api/（面向扩展作者；src/renderer/src/core/types.ts 再导出兼容）。
 */

/** 窗口控制动作 */
export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'

/** 窗口状态快照（渲染进程自绘标题栏需要） */
export interface WindowState {
  isMaximized: boolean
  isFullScreen: boolean
  isFocused: boolean
}

/** 应用信息 */
export interface AppInfo {
  name: string
  version: string
}

/** 用户扩展目录下的一个扩展（由主进程扫描，供渲染进程加载/管理） */
export interface UserExtensionEntry {
  /** 目录名（= 扩展 id） */
  id: string
  /** 绝对路径（渲染进程经 app:// 协议访问，不可直接读盘） */
  path: string
}

/** 调试扩展（--debug-extension 声明）：本地目录直接加载，不经过 .oix 安装 */
export interface DebugExtensionEntry {
  /** 扩展 id（CLI 参数显式指定） */
  id: string
  /** 本地目录绝对路径（经 app://debug/<id>/ 访问） */
  path: string
}

/** .oix 扩展包安装结果 */
export interface InstallOixResult {
  /** 安装目录名（= <name>_<清洗后 author>，即扩展 id） */
  id: string
  /** manifest.name */
  name: string
  /** manifest.displayName */
  displayName?: string
  /** manifest.version */
  version: string
  /** manifest.author */
  author?: string
  /** 是否覆盖了已存在的同名扩展 */
  replaced: boolean
}

/** 代理配置（设置-网络页，VS Code 风格） */
export interface ProxyConfig {
  /** 是否启用代理 */
  enabled: boolean
  /** 代理 host（如 127.0.0.1） */
  host: string
  /** 代理端口 */
  port?: number
  /** 用户名（可选） */
  username?: string
  /** 密码（可选） */
  password?: string
  /** 是否忽略 SSL 证书校验 */
  ignoreSSL?: boolean
  /** noProxy 排除列表（host 或域名，逗号分隔的数组） */
  noProxy?: string[]
}

/** 渲染进程 → 主进程 的调用（invoke） */
export interface MainApi {
  /** 窗口控制 */
  windowAction(action: WindowAction): Promise<void>
  getWindowState(): Promise<WindowState>
  /** 应用信息 */
  getAppInfo(): Promise<AppInfo>
  /** 用户扩展目录扫描（返回 userData/extensions 下的扩展目录清单） */
  listUserExtensions(): Promise<UserExtensionEntry[]>
  /** 调试扩展清单（--debug-extension 声明；不安装，重启消失） */
  listDebugExtensions(): Promise<DebugExtensionEntry[]>
  /** 卸载用户扩展（删除 userData/extensions/<id> 目录） */
  uninstallUserExtension(id: string): Promise<void>
  /** 运行用户扩展的卸载钩子（若有），返回是否成功 */
  runUninstallHook(id: string): Promise<boolean>
  /** 文件对话框选择 .oix 并安装；取消返回 null */
  installUserExtensionViaDialog(): Promise<InstallOixResult | null>
  /** 按路径安装 .oix（拖拽场景，路径来自 getPathForFile） */
  installUserExtensionFromPath(filePath: string): Promise<InstallOixResult>
  /** 拖拽文件取真实磁盘路径（Electron webUtils；渲染进程传入 File） */
  getPathForFile(file: unknown): string
  /** 开发辅助：截图窗口内容到磁盘，返回保存路径 */
  capture(outPath: string): Promise<string>
  /** 开发辅助：在渲染进程执行 JS 并返回结果 */
  eval(script: string): Promise<unknown>
  /** 打开 App 子窗口（返回打开结果；单开时聚焦已有窗口） */
  openAppWindow(req: {
    appId: string
    title: string
    multiOpen?: boolean
    width?: number
    height?: number
    iconUrl?: string
  }): Promise<{ appId: string; sequence: number }>
  /** 获取 obox 当前版本号 */
  getOboxVersion(): Promise<string>
  /** 解析 GitHub 仓库"最后一次编译"的 release 更新源（按创建时间最新，不依赖 latest 标记） */
  resolveUpdateFeed(repo: string): Promise<{
    ok: boolean
    tag?: string
    feedUrl?: string
    publishedAt?: string
    error?: string
  }>
  /** 检查更新（feedUrl 由更新提供者扩展提供；无默认源） */
  checkUpdate(opts: {
    feedUrl?: string
    proxy?: ProxyConfig
  }): Promise<{ ok: boolean; available?: string; error?: string }>
  /** 下载更新（不自动安装） */
  downloadUpdate(): Promise<{ ok: boolean; error?: string }>
  /** 安装并重启（下载完成后） */
  installUpdate(): Promise<void>
  // ---- 扩展能力：定时器（主进程精确计时，秒粒度） ----
  setTimerTimeout(extId: string, id: string, seconds: number): Promise<{ ok: boolean; error?: string }>
  setTimerInterval(extId: string, id: string, seconds: number): Promise<{ ok: boolean; error?: string }>
  clearTimer(extId: string, id: string): Promise<void>
  // ---- 扩展能力：sqlite（node:sqlite，相对路径 → 扩展 data 目录） ----
  sqliteOpen(extId: string, name: string): Promise<{ ok: boolean; error?: string }>
  sqliteClose(extId: string, name: string): Promise<void>
  sqliteExec(extId: string, name: string, sql: string): Promise<{ ok: boolean; error?: string }>
  sqliteQuery(
    extId: string,
    name: string,
    sql: string,
    params: unknown[]
  ): Promise<{ ok: boolean; rows?: unknown[]; error?: string }>
  sqliteInsert(
    extId: string,
    name: string,
    row: Record<string, unknown>
  ): Promise<{ ok: boolean; row?: unknown; error?: string }>
  sqliteUpdate(
    extId: string,
    name: string,
    where: Record<string, unknown>,
    patch: Record<string, unknown>
  ): Promise<{ ok: boolean; changes?: number; error?: string }>
  sqliteGet(extId: string, name: string, id: unknown): Promise<{ ok: boolean; row?: unknown; error?: string }>
  sqliteGetAll(extId: string, name: string): Promise<{ ok: boolean; rows?: unknown[]; error?: string }>
  sqliteGetBy(
    extId: string,
    name: string,
    where: Record<string, unknown>
  ): Promise<{ ok: boolean; rows?: unknown[]; error?: string }>
  sqliteDel(extId: string, name: string, id: unknown): Promise<{ ok: boolean; changes?: number; error?: string }>
  sqliteDelBy(
    extId: string,
    name: string,
    where: Record<string, unknown>
  ): Promise<{ ok: boolean; changes?: number; error?: string }>
  sqliteClear(extId: string, name: string): Promise<{ ok: boolean; changes?: number; error?: string }>
  // ---- 扩展能力：系统提醒 ----
  showNotification(
    extId: string,
    opts: { title?: string; body?: string; icon?: string }
  ): Promise<{ ok: boolean; id?: number; error?: string }>
  /** 扩展停用/卸载/重载时清理主进程资源（定时器 + 数据库连接） */
  cleanupExtension(extId: string): Promise<void>
  // ---- 扩展能力：网络（渲染 CSP 禁外网，走主进程 + 代理） ----
  netFetch(
    req: { url?: string; method?: string; headers?: Record<string, string>; body?: unknown; json?: boolean },
    proxy?: ProxyConfig
  ): Promise<{ ok: boolean; status?: number; statusText?: string; data?: unknown; error?: string }>
  // ---- 扩展能力：文件系统（限定扩展 data 目录，相对路径） ----
  fsReadFile(extId: string, rel: string): Promise<{ ok: boolean; content?: string; error?: string }>
  fsWriteFile(extId: string, rel: string, content: string): Promise<{ ok: boolean; error?: string }>
  fsReadDir(
    extId: string,
    rel: string
  ): Promise<{ ok: boolean; entries?: Array<{ name: string; isDir: boolean }>; error?: string }>
  fsExists(extId: string, rel: string): Promise<{ ok: boolean; exists?: boolean; error?: string }>
  fsRemove(extId: string, rel: string): Promise<{ ok: boolean; error?: string }>
  // ---- 扩展能力：对话框 / 外链 / 剪贴板 / 任务栏进度 ----
  dialogOpen(opts: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    multiSelect?: boolean
  }): Promise<{ ok: boolean; filePaths?: string[]; canceled?: boolean; error?: string }>
  dialogSave(opts: {
    title?: string
    defaultName?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>
  dialogMessage(opts: {
    type?: 'info' | 'warning' | 'error' | 'question'
    title?: string
    message?: string
    detail?: string
    buttons?: string[]
  }): Promise<{ ok: boolean; response?: number; error?: string }>
  shellOpenExternal(url: string): Promise<{ ok: boolean; error?: string }>
  shellOpenPath(p: string): Promise<{ ok: boolean; error?: string }>
  clipboardReadText(): Promise<string>
  clipboardWriteText(text: string): Promise<void>
  setProgressBar(progress: number | null): Promise<void>
  /** 运行环境静态信息（preload 直接提供，非 IPC） */
  env: { platform: string; arch: string; nodeVersion: string }
  // ---- 扩展能力：密钥存储（safeStorage 加密） ----
  secretsGet(extId: string, key: string): Promise<{ ok: boolean; value?: string; error?: string }>
  secretsSet(extId: string, key: string, value: string): Promise<{ ok: boolean; error?: string }>
  secretsDelete(extId: string, key: string): Promise<{ ok: boolean; error?: string }>
  // ---- 扩展能力：文件监听（扩展 data 目录） ----
  fsWatch(extId: string, watchId: string, rel: string): Promise<{ ok: boolean; error?: string }>
  fsUnwatch(extId: string, watchId: string): Promise<void>
  // ---- App 子窗口 ↔ 扩展消息桥 ----
  /** 子窗口（AppWindow）向扩展入口发消息并等待响应（经主进程 → 主窗口宿主 → 扩展 handler） */
  extensionMessage(appId: string, channel: string, payload: unknown): Promise<{
    ok: boolean
    data?: unknown
    error?: string
  }>
  /** 主窗口宿主把扩展 handler 的结果回传主进程（请求-响应桥的回复侧） */
  extensionReply(requestId: number, result: { ok: boolean; data?: unknown; error?: string }): void
  // ---- 窗口化 ui 模态框（按焦点窗口显示） ----
  /** 扩展 ui 模态框：焦点在 App 子窗口时转发到该窗口渲染；否则 local（主窗口自己渲染） */
  uiShow(kind: string, payload: unknown): Promise<{ local: boolean; canceled?: boolean; value?: unknown }>
  /** 子窗口把模态框结果回传主进程（ui:show 的回复侧） */
  uiResult(requestId: number, r: { canceled: boolean; value?: unknown }): void
}

/** 主进程 → 渲染进程 的事件（on） */
export interface MainEvents {
  /** 窗口状态变化（最大化/还原/全屏/聚焦） */
  'window:state-changed': (state: WindowState) => void
  /** 更新事件（检查结果/下载进度/下载完成/错误） */
  'update:event': (e: {
    type: string
    info?: { version?: string; files?: unknown[]; releaseDate?: string }
    percent?: number
    bytesPerSecond?: number
    transferred?: number
    total?: number
    message?: string
  }) => void
  /** 定时器到点（key = <扩展id>:<id>；kind = timeout|interval） */
  'timer:fire': (e: { key: string; kind: 'timeout' | 'interval' }) => void
  /** 通知被点击（扩展分发 onClick 回调） */
  'notification:click': (e: { notifId: number; extId: string; title: string }) => void
  /** 文件监听事件（key = <扩展id>:<watchId>；relPath 相对监听目录） */
  'fs:watch-event': (e: { key: string; relPath: string }) => void
  /** App 子窗口向扩展发消息（主窗口宿主按 appId 分发到扩展 handler） */
  'extension:message': (e: {
    requestId: number
    appId: string
    channel: string
    payload: unknown
  }) => void
  /** 主进程把扩展 ui 模态框显示指令发给目标窗口（App 子窗口渲染，结果经 uiResult 回传） */
  'ui:show': (e: { requestId: number; kind: string; payload: unknown }) => void
}
