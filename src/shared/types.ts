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
  /** 被替换掉的旧版本（仅覆盖安装且能读到旧清单时提供；install 钩子的 ctx.previousVersion） */
  previousVersion?: string
}

/**
 * `.obox-meta.json` 里与**生命周期钩子**相关的字段（issue #52）。
 *
 * 安装时由主进程写入 `pendingInstall`（表示"待执行 install 钩子"）；渲染进程执行后回写
 * `install` 并清除 `pendingInstall`。形状要与 `src/renderer/src/core/hookState.ts` 的
 * `HookState` 保持一致（该文件直接引用本类型，且测试里有双向可赋值校验防漂移）。
 */
export interface ExtensionHookState {
  /** install 钩子的执行记录（该版本跑过即记；失败也记，避免"只跑一次"被破坏后无限重跑） */
  install?: { version: string; at: number; ok: boolean }
  /** 待补跑：安装完成时渲染进程不可用，下次启动扫描期补跑一次 */
  pendingInstall?: { version: string; at: number; previousVersion?: string }
}

/** `.obox-meta.json` 的内容（缺失字段一律视为未设置，兼容旧文件） */
export interface ExtensionMeta extends ExtensionHookState {
  /** 安装时间戳（Last Updated 展示用） */
  installedTimestamp?: number
}

/**
 * .oix 安装失败的错误码（渲染进程据此区分引导文案；不要依赖 message 文本做判断）。
 * - invalid-package：不是有效 zip / 无法读取
 * - invalid-manifest：缺根 manifest.json，或 name/version/main 非法
 * - entry-missing：manifest.main 指向的入口不在包内
 * - entry-invalid：含非法条目路径（zip-slip / 反斜杠 / 绝对路径 / 空段）
 * - too-large：条目数或解压总量超限
 * - path-invalid：传入的安装路径非法或不存在
 * - write-failed：暂存/替换/写盘失败（旧版本已回滚）
 * - arch-mismatch：扩展自带的是另一架构的 Python 运行时（如 arm64 包在 x64 设备上安装，见 ADR-0018）
 */
export type InstallOixErrorCode =
  | 'invalid-package'
  | 'invalid-manifest'
  | 'entry-missing'
  | 'entry-invalid'
  | 'too-large'
  | 'path-invalid'
  | 'write-failed'
  | 'arch-mismatch'

/**
 * .oix 安装结果：成功或失败都以**返回值**表达（不再靠 IPC 抛错传消息），
 * 这样错误码能稳定跨进程传递，渲染进程可做区分处理。
 */
export type InstallOixOutcome =
  { ok: true; result: InstallOixResult } | { ok: false; code: InstallOixErrorCode; error: string }

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
  installUserExtensionViaDialog(): Promise<InstallOixOutcome | null>
  /** 按路径安装 .oix（拖拽场景，路径来自 getPathForFile） */
  installUserExtensionFromPath(filePath: string): Promise<InstallOixOutcome>
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
  /** 解析 GitHub 仓库的更新源（取最近若干 release 中第一个含 latest.yml 的正式版，排除预发布/draft） */
  resolveUpdateFeed(
    repo: string,
    proxy?: ProxyConfig
  ): Promise<{
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
  /** 强制重装/降级：从更新源直接下载并启动安装向导（绕开 electron-updater 的版本门控） */
  forceInstallUpdate(opts: {
    feedUrl: string
    proxy?: ProxyConfig
    reason?: 'user' | 'auto'
  }): Promise<{ ok: boolean; version?: string; filePath?: string; error?: string }>
  // ---- 扩展能力：定时器（主进程精确计时，秒粒度） ----
  setTimerTimeout(
    extId: string,
    id: string,
    seconds: number
  ): Promise<{ ok: boolean; error?: string }>
  setTimerInterval(
    extId: string,
    id: string,
    seconds: number
  ): Promise<{ ok: boolean; error?: string }>
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
  sqliteGet(
    extId: string,
    name: string,
    id: unknown
  ): Promise<{ ok: boolean; row?: unknown; error?: string }>
  sqliteGetAll(
    extId: string,
    name: string
  ): Promise<{ ok: boolean; rows?: unknown[]; error?: string }>
  sqliteGetBy(
    extId: string,
    name: string,
    where: Record<string, unknown>
  ): Promise<{ ok: boolean; rows?: unknown[]; error?: string }>
  sqliteDel(
    extId: string,
    name: string,
    id: unknown
  ): Promise<{ ok: boolean; changes?: number; error?: string }>
  sqliteDelBy(
    extId: string,
    name: string,
    where: Record<string, unknown>
  ): Promise<{ ok: boolean; changes?: number; error?: string }>
  sqliteClear(
    extId: string,
    name: string
  ): Promise<{ ok: boolean; changes?: number; error?: string }>
  // ---- 扩展能力：系统提醒 ----
  showNotification(
    extId: string,
    opts: { title?: string; body?: string; icon?: string }
  ): Promise<{ ok: boolean; id?: number; error?: string }>
  /** 扩展停用/卸载/重载时清理主进程资源（定时器 + 数据库连接） */
  cleanupExtension(extId: string): Promise<void>
  // ---- 扩展能力：网络（渲染 CSP 禁外网，走主进程 + 代理） ----
  netFetch(
    req: {
      url?: string
      method?: string
      headers?: Record<string, string>
      body?: unknown
      json?: boolean
    },
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
  extensionMessage(
    appId: string,
    channel: string,
    payload: unknown
  ): Promise<{
    ok: boolean
    data?: unknown
    error?: string
  }>
  /** 主窗口宿主把扩展 handler 的结果回传主进程（请求-响应桥的回复侧） */
  extensionReply(requestId: number, result: { ok: boolean; data?: unknown; error?: string }): void
  // ---- 窗口化 ui 模态框（按焦点窗口显示） ----
  /** 扩展 ui 模态框：焦点在 App 子窗口时转发到该窗口渲染；否则 local（主窗口自己渲染） */
  uiShow(
    kind: string,
    payload: unknown
  ): Promise<{ local: boolean; canceled?: boolean; value?: unknown }>
  /** 子窗口把模态框结果回传主进程（ui:show 的回复侧） */
  uiResult(requestId: number, r: { canceled: boolean; value?: unknown }): void
  // ---- 扩展能力：与外部进程的端口无关 IPC（stdio / 命名管道；见 issue #40） ----
  /** 打开一条通道（stdio：宿主拉起子进程；pipe：连接已在运行的进程） */
  ipcConnect(
    extId: string,
    declaration: IpcChannelDeclaration
  ): Promise<{ ok: boolean; code?: string; error?: string }>
  /** 关闭一条通道（幂等） */
  ipcClose(extId: string, name: string): Promise<void>
  /** 列出已打开的通道名 */
  ipcList(extId: string): Promise<string[]>
  /** 发请求并等响应（超时/取消/断开以稳定错误码返回） */
  ipcRequest(
    extId: string,
    name: string,
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<{ ok: boolean; result?: unknown; code?: string; error?: string }>
  /** 发通知（无应答） */
  ipcNotify(
    extId: string,
    name: string,
    method: string,
    params?: unknown
  ): Promise<{ ok: boolean; code?: string; error?: string }>
  /** 渲染进程里扩展处理器对"对端请求"的回包 */
  ipcReply(requestId: string, outcome: IpcReplyOutcome): Promise<void>
  // ---- 生命周期钩子（issue #52）：主进程请渲染进程执行入口导出的 install / uninstall ----
  /**
   * 渲染进程把钩子执行结果回传主进程（`extension:hook-request` 的回复侧）。
   * `deferred: true` 表示"这次跑不了，请留待下次启动补跑"（如扩展尚未加载到宿主）。
   */
  hookResult(result: ExtensionHookRunResult): void
  /**
   * 宿主**补跑** install 钩子后回写元数据（启动扫描期补跑 pending 时用；发起方向与 hookResult 相反）。
   * 主进程会先校验 extId 是否为已知扩展，再落账。
   */
  recordInstallHook(extId: string, version: string, ok: boolean): Promise<void>
  // ---- 扩展自带的 Python 运行时（issue #51 / ADR-0018）----
  /** 跑一个随扩展分发的脚本；**默认不超时**（交互式脚本会等用户关窗）。宿主故障才 ok:false */
  pythonRun(extId: string, input: PythonRunInput): Promise<PythonRunOutcome>
}

/** 生命周期钩子阶段（与 renderer/core/hookState.ts 的 HookPhase 一致） */
export type ExtensionHookPhase = 'install' | 'uninstall'

/** `api.python.run` 的入参（issue #51 / ADR-0018） */
export interface PythonRunInput {
  /** 脚本路径：**扩展目录内相对路径**（如 `scripts/run.py`），越界一律拒绝 */
  script: string
  args?: string[]
  /**
   * 是否把该进程注册成一条 `api.ipc` 通道（可选）：
   * - 省略 / `false`：**不建通道**（脚本可自由 print，输出走返回值）；
   * - `true`：建通道并用缺省名 `python`；
   * - 字符串：建通道并用该名字（计入"每扩展 4 条通道"限额）。
   * Python 侧需自行实现 JSON-RPC 与 `Content-Length` 分帧。
   */
  channel?: string | boolean
}

/** `api.python.run` 的结果：跑完后的退出码与输出（脚本失败也走这里，宿主故障才抛错） */
export interface PythonRunOutcome {
  ok: boolean
  /** 仅宿主侧失败时出现：`python-missing` / `arch-mismatch` / `launch-failed` / `invalid-declaration` */
  code?: string
  error?: string
  result?: { code: number | null; stdout: string; stderr: string }
}

/** 主进程 → 渲染进程：请执行某扩展的钩子（钩子在渲染进程执行，因为扩展入口只在这里被 import） */
export interface ExtensionHookRunRequest {
  /** 主进程生成，回包时原样带回 */
  requestId: string
  /** 扩展 id（= 安装目录名） */
  extId: string
  phase: ExtensionHookPhase
  /** 当前 manifest.version */
  version: string
  /** 是否覆盖安装（升级） */
  upgraded: boolean
  /** 升级前版本（仅 upgraded 为 true 时提供） */
  previousVersion?: string
}

/**
 * 渲染进程回传的钩子执行结果。
 * - `ok: true` + `skipped: true`：入口未导出该钩子（可选、可为空，属正常）
 * - `ok: false`：钩子跑过但失败（安装场景据此归为激活失败）
 * - `deferred: true`：**这次没执行**（如扩展尚未加载），主进程必须保留 `pendingInstall` 待下次启动补跑
 */
export interface ExtensionHookRunResult {
  requestId: string
  ok: boolean
  skipped?: boolean
  deferred?: boolean
  error?: string
}

/** 通道声明（与主进程 ipcCore 的契约形状一致；传输**不含 TCP/端口**） */
export interface IpcChannelDeclaration {
  /** 通道名（同一扩展内唯一，只允许字母数字与 . _ -） */
  id: string
  transport: 'stdio' | 'pipe'
  /** stdio 必填：扩展目录内的相对路径 */
  program?: string
  args?: string[]
  framing?: 'content-length' | 'ndjson'
}

/** 渲染进程回包（对端请求的响应） */
export interface IpcReplyOutcome {
  ok: boolean
  result?: unknown
  error?: string
}

/** 主进程 → 渲染进程的 IPC 通道事件 */
export type IpcEvent =
  | { extId: string; name: string; type: 'notification'; method: string; params?: unknown }
  | {
      extId: string
      name: string
      type: 'request'
      requestId: string
      method: string
      params?: unknown
    }
  | { extId: string; name: string; type: 'stderr'; text: string }
  | { extId: string; name: string; type: 'close'; code: string; message: string }

/** 主进程 → 渲染进程 的事件（on） */
export interface MainEvents {
  /** 窗口状态变化（最大化/还原/全屏/聚焦） */
  'window:state-changed': (state: WindowState) => void
  /** 生命周期钩子执行请求（宿主执行后经 api.hookResult 回传，见 issue #52） */
  'extension:hook-request': (e: ExtensionHookRunRequest) => void
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
  /** 扩展 IPC 通道事件（通知 / 对端请求 / 对端日志 / 通道关闭） */
  'ipc:event': (e: IpcEvent) => void
}
