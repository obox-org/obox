/**
 * 主进程 / preload / 渲染进程 共享的 IPC 契约类型。
 * 扩展 API 类型见 src/api/（面向扩展作者；src/renderer/src/core/types.ts 再导出兼容）。
 */
import type { EhErrorCode, HostedExtensionInfo } from './extensionHostProtocol'

/** 窗口控制动作 */
export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'

/**
 * 关闭行为偏好（ADR-0019）：`ask` 关闭时弹原生提示让用户选 / `hide` 收进托盘 / `quit` 退出。
 * 由**主进程**持有（`userData/window-behavior.json`），设置页经 IPC 读写——关闭拦截发生在主进程，
 * 而主进程读不到渲染进程的 localStorage 设置。
 */
export type CloseBehavior = 'ask' | 'hide' | 'quit'

/**
 * 开机自启状态（ADR-0019 决策 12–14）。
 * `supported`：当前是否可配置（仅 Windows 且非开发版）；`enabled`：**系统真实状态**
 * （含 Windows 任务管理器"启动应用"里的启用/禁用，它可以在保留启动项的情况下禁用它）。
 */
export interface AutoStartState {
  supported: boolean
  enabled: boolean
  reason?: 'platform' | 'dev'
  /** 不支持或设置失败时的说明（设置页内联显示） */
  message?: string
}

/** 窗口状态快照（渲染进程自绘标题栏需要） */
export interface WindowState {
  isMaximized: boolean
  isFullScreen: boolean
  isFocused: boolean
}

/** 文件对话框过滤器（Electron `FileFilter` 的最小子集） */
export interface DialogFilter {
  name: string
  extensions: string[]
}

/**
 * 打开对话框的 `properties`（Electron `OpenDialogOptions['properties']` 的最小子集）。
 * `openDirectory` 与 `openFile` **互斥**（同时传按目录模式归一，见 `src/main/ext.ts` 的
 * `normalizeDialogProperties`）；目录模式下 `filters` 不生效（Electron 不对目录应用过滤器）。
 */
export type DialogProperty = 'openFile' | 'openDirectory' | 'multiSelections'

/** `dialogOpen` 入参（主进程 / preload 类型 / 扩展 API **三处共用同一份**，避免签名漂移） */
export interface DialogOpenOptions {
  title?: string
  filters?: DialogFilter[]
  multiSelect?: boolean
  /** 不传 ⇒ `['openFile']`（既有默认行为不变）；未知值被忽略，不抛错 */
  properties?: DialogProperty[]
}

/** 打开对话框的返回形状（目录选择与文件选择**共用 `filePaths`**，不新增字段） */
export interface DialogOpenResult {
  ok: boolean
  filePaths?: string[]
  canceled?: boolean
  error?: string
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
  | 'forbidden-entry'
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

/**
 * 代理配置（设置-网络页）。
 *
 * **形态（1.0.12 起，用户裁定 A 方案）**：主输入是**一个代理 URL**
 * —— `http://127.0.0.1:7890`、`https://proxy:8443`、`socks5://127.0.0.1:1080`、
 * `http://user:pass@host:1080`；空串 = 直连。两个附加项保留：`noProxy`（排除列表）与
 * `ignoreSSL`（忽略证书校验）。解析与 Chromium 规则串派生的**唯一实现**在 `src/main/proxy.ts`。
 */
export interface ProxyConfig {
  /** 是否启用代理 */
  enabled: boolean
  /** 代理 URL（含协议，可含 `user:pass@`；空串 = 直连） */
  url: string
  /** 是否忽略 SSL 证书校验 */
  ignoreSSL?: boolean
  /** noProxy 排除列表（host 或域名，逗号分隔的数组） */
  noProxy?: string[]
}

/**
 * **旧形态**代理配置（1.0.11 及更早的持久化值），**只用于迁移读取**。
 *
 * 迁移语义：`{enabled,host,port?,username?,password?,ignoreSSL?,noProxy?}`
 * → `http://[user:pass@]host[:port]`（协议默认 `http`；用户名/密码做百分号编码；
 * 只有密码没有用户名时不迁移凭据——Chromium 的 login 事件必须有用户名）。
 * 唯一的迁移实现是 `legacyProxyToUrl()`（`src/shared/proxyConfig.ts`）：设置页首屏读值时调用，
 * 主进程 `applyProxyToSession()` 也用它容忍旧值从别处流入。**新代码不要构造、也不要持久化它。**
 */
export interface LegacyProxyConfig {
  /** 是否启用代理 */
  enabled: boolean
  /** 代理 host（旧值没有协议前缀，如 127.0.0.1） */
  host: string
  /** 代理端口（缺省时不写进 URL，由协议缺省端口决定） */
  port?: number
  /** 用户名（旧值，迁移进 URL 的 userinfo） */
  username?: string
  /** 密码（旧值，迁移进 URL 的 userinfo） */
  password?: string
  /** 是否忽略 SSL 证书校验（迁移后语义不变） */
  ignoreSSL?: boolean
  /** noProxy 排除列表（迁移后语义不变） */
  noProxy?: string[]
}

/**
 * 「设置 → AI」的**测试连接**请求（宿主内部，见 `MainApi.aiTestConnection`）。
 *
 * 参数就是设置页里那五个键中的两个：`baseUrl`（OpenAI 兼容端点根地址，如
 * `https://api.openai.com/v1`，带不带尾斜杠都可）与 `apiKey`（可为空——不少本地端点不要密钥）。
 * 两者都由渲染进程从统一设置存储（localStorage）读出后经 IPC 传入；**密钥不过网络**，
 * 只在主进程被拼进 `Authorization` 头。
 */
export interface AiConnectionRequest {
  baseUrl?: string
  apiKey?: string
}

/** 测试连接的失败原因（稳定码；中文文案见 `message`，UI 直接展示 message） */
export type AiConnectionReason =
  | 'missing-base-url'
  | 'invalid-base-url'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'http-error'
  | 'bad-response'
  | 'network'
  | 'timeout'

/**
 * 「测试连接」的结果（**失败不抛错**：与 notification/shell/dialog 的 `{ok, error}` 风格同构）。
 *
 * - `message`：中文、可执行的原因或结论（成功形如「连接成功（N 个模型可用）」）——
 *   由主进程生成，因为"请求失败"的一手信息（状态码 / Chromium 错误名）只在主进程拿得到；
 * - `reason`：稳定码，供 UI/测试做分支判断（不锁文案）；
 * - `modelCount` / `models`：成功且端点返回 OpenAI 风格 `{data:[{id}]}` 时给出（模型名至多 3 个）；
 * - `status`：拿到 HTTP 响应时的状态码（网络错误/超时为 undefined）；
 * - **绝不回传 `apiKey`**（结果里只有端点的公开信息，避免密钥随 UI 文案/日志扩散）。
 */
export interface AiConnectionResult {
  ok: boolean
  message: string
  reason?: AiConnectionReason
  modelCount?: number
  models?: string[]
  status?: number
}

/** 渲染进程 → 主进程 的调用（invoke） */
export interface MainApi {
  /** 窗口控制 */
  windowAction(action: WindowAction): Promise<void>
  getWindowState(): Promise<WindowState>
  /** 读取关闭行为偏好（主进程是唯一权威，见 ADR-0019） */
  getCloseBehavior(): Promise<CloseBehavior>
  /** 写入关闭行为偏好（非 Windows 无托盘，写入后关闭仍直接退出） */
  setCloseBehavior(behavior: CloseBehavior): Promise<void>
  /** 读开机自启状态（以系统真实状态为准，并回写偏好） */
  getAutoStart(): Promise<AutoStartState>
  /** 设置开机自启（失败时返回真实状态 + message，设置页据此回弹） */
  setAutoStart(enabled: boolean): Promise<AutoStartState>
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
  // ---- 扩展能力：overlay 窗体（无边框/可透明/可置顶/不占任务栏的固定小窗；桌面宠物类，卡 03） ----
  /**
   * 创建 overlay 窗体（主进程实现：`src/main/appWindow.ts` 的 createOverlayWindow）。
   * 参数校验（id/url 非空、width/height > 0、margin ≥ 0 缺省 24、anchor 枚举、url 必须指向
   * 本扩展目录内页面、overlayId 全局唯一）与窗体创建都在主进程；失败**不抛错**，返回
   * `ok:false` + 中文可执行原因。创建成功后窗体**默认鼠标穿透**
   * （`setIgnoreMouseEvents(true,{forward:true})`，design D-2）。
   * 成功回传 `position` = anchor/margin 解析后的实际窗体坐标（R31：扩展拿不到 workArea，
   * 拖动换算需要这个绝对基准）。
   */
  overlayCreate(extId: string, options: CreateOverlayRequest): Promise<OverlayResult>
  /**
   * 销毁 overlay 窗体（**真销毁**不是隐藏：页面与其 rAF/定时器动画循环随之终止）。
   * 幂等：不存在/已销毁的 id 静默成功（ok:true）；越权（id 属于别的扩展）拒绝并记 `[overlay]` 日志。
   */
  overlayDestroy(extId: string, id: string): Promise<OverlayResult>
  /**
   * 切换鼠标穿透：true ⇒ `setIgnoreMouseEvents(true,{forward:true})`（悬停移动仍转发给页面，
   * 供页面做命中测试）；false ⇒ `setIgnoreMouseEvents(false)` 恢复接收。
   * 不存在的 id 返回 ok:false（与 destroy 的幂等语义不同）；越权拒绝。
   */
  overlaySetMouseThrough(extId: string, id: string, through: boolean): Promise<OverlayResult>
  /**
   * 移动 overlay 窗体到屏幕坐标 (x, y)（窗体左上角；扩展拖宠物换位用，卡 14/design D-13）。
   * 钳位双保险：扩展侧主钳，宿主侧兜底把 x/y 钳进主显示器工作区；成功回传 `position` =
   * **钳制后的实际坐标**（扩展拿不到 workArea，靠它校正自己记录的位置）。
   * 非法坐标（NaN/Infinity/非数字）直接拒绝（不钳不猜）；不存在的 id 返回 ok:false
   * （与 setMouseThrough 同口径）；越权拒绝。移动不改变 transparent/alwaysOnTop/穿透态。
   */
  overlaySetPosition(extId: string, id: string, x: number, y: number): Promise<OverlayResult>
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
  /**
   * 宿主内部（**不属扩展 API 面**，扩展读代理请用 `api.proxy.get()`）：把「网络代理」设置推给主进程。
   *
   * 渲染进程在**启动时**与**代理设置变化时**调用；主进程据此在扩展联网（`obox-net`）与更新
   * （`electron-updater`）两个 session 上应用代理，使更新链路的检查/下载/安装**不依赖调用顺序**
   * （此前 `applyProxy()` 无调用方，下载/安装是否走代理纯靠"上一次 check 恰好带过 proxy"）。
   * 传 `undefined` = 直连（用户关掉代理）；非法值由主进程归一化后按直连处理。
   * 参数**必须**经 `core/plainProxy.ts` 的 `plainProxyConfig()` 归一化（reactive Proxy 进 IPC 会抛
   * `An object could not be cloned.`）。
   */
  applyProxy(proxy?: ProxyConfig): Promise<void>
  /**
   * 宿主内部（**不属扩展 API 面**，「设置 → AI」的「测试连接」按钮专用）：
   * 用当前 AI 配置发一次最小请求 `GET {baseUrl}/models`（带 `Authorization: Bearer <apiKey>`，
   * `apiKey` 为空则不带该头）验证配置可用。
   *
   * - **必须在主进程用 `netSession()` 发起**（`src/main/ai.ts`）：只有这条 session 上应用了
   *   用户配置的代理与忽略 SSL 设置（卡 20），与 `api.net.fetch` 同一条路；渲染进程的 `fetch`
   *   走默认 session、**不**经宿主代理，因此不能在这里用；
   * - 带 10 秒超时（`AbortController`），失败**不抛错**，返回 `{ok:false, message, reason}`；
   * - `baseUrl` 为空/非 http(s) 时主进程侧直接拒绝（渲染进程也会先行早退，见设置页）；
   * - 返回结果**不回传 apiKey**（见 `AiConnectionResult`）。
   */
  aiTestConnection(req: AiConnectionRequest): Promise<AiConnectionResult>
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
  dialogOpen(opts: DialogOpenOptions): Promise<DialogOpenResult>
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
  // ---- 扩展能力：与外部进程的端口无关 IPC（stdio / 命名管道；见 issue #40 / #43） ----
  /** 打开一条通道（stdio：宿主拉起子进程；pipe：连接已在运行的进程） */
  ipcConnect(
    extId: string,
    declaration: IpcChannelDeclaration
  ): Promise<{ ok: boolean; code?: string; error?: string }>
  /** listen 一个 pipe 端点（**服务端**，接受多条连接；见 issue #43） */
  ipcListen(
    extId: string,
    declaration: IpcChannelDeclaration
  ): Promise<{ ok: boolean; code?: string; error?: string }>
  /** 关闭该名字下的**一切**（client 通道或 server）；不存在时静默成功、幂等 */
  ipcClose(extId: string, name: string): Promise<void>
  /** 列出已打开的通道名（**含** server 名） */
  ipcList(extId: string): Promise<string[]>
  /** 发请求并等响应（超时/取消/断开以稳定错误码返回）；`connectionId` 仅对 server 名字有意义 */
  ipcRequest(
    extId: string,
    name: string,
    method: string,
    params?: unknown,
    timeoutMs?: number,
    connectionId?: number
  ): Promise<{ ok: boolean; result?: unknown; code?: string; error?: string }>
  /** 发通知（无应答）；`connectionId` 规则同上 */
  ipcNotify(
    extId: string,
    name: string,
    method: string,
    params?: unknown,
    connectionId?: number
  ): Promise<{ ok: boolean; code?: string; error?: string }>
  /** 向 server 的全部连接各发一条**通知**（不收集回包） */
  ipcBroadcast(
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
  // ---- 扩展宿主进程（ADR-0026 / EH-A4）：开关打开时渲染侧请求 main 启动宿主 ----
  /**
   * 请求 main 启动扩展宿主，并把用户扩展清单交给它（`init.extensions`）。
   *
   * **只有渲染侧主动调用才会 fork**（A2 的启动器本身不自动启动）：回退开关关闭时本方法
   * 永远不该被调用，用户扩展继续在渲染进程里执行（默认行为零变化）。
   * 结果永远 resolve，失败走 `ok:false`（`code` 为协议错误码）。
   */
  ehStart(extensions: HostedExtensionInfo[]): Promise<ExtensionHostStartOutcome>
  /**
   * 端口状态（**只有状态，没有端口**；端口只能经 `eh:port` 转移，A2 已确认）。
   * 字段定义照 A2 的 `RendererPortDescription`，渲染侧桥据此判断"端口是否已到"。
   */
  ehGetPort(): Promise<ExtensionHostPortStatus>
  /**
   * 宿主状态快照（含最近一次崩溃原因，供 A5 / 扩展管理器展示）。
   * 比 `ehGetPort` 多 `crashCount` 与 `lastCrash`：端口状态只用来说明"链路到没到"。
   */
  ehGetStatus(): Promise<ExtensionHostStatusSnapshot>
  /** 主动停止宿主（幂等；页面重新加载后端口已随旧页面销毁时，这是重建链路的第一步） */
  ehStop(): Promise<void>
  /**
   * 把当前生效的主题 token 上报给主进程（**overlay 浮层窗口的主题下发**，2.0.1）。
   *
   * 为什么需要：浮层是主进程 new BrowserWindow 加载的独立文档，CSS 自定义属性不跨文档继承，
   * App 子窗口那条 `obox-theme` postMessage 也送不到它 ⇒ 浮层页里的 `var(--bg-panel)` 全部
   * 解析为空、面板透明。链路：渲染侧主题生效后调用本方法 → 主进程缓存并向所有 overlay
   * `webContents.send('theme:tokens')` → preload 写到 documentElement。
   *
   * 载荷只接受 `--x` 形状的 token 名与字符串值（`shared/themeTokens.ts` 校验）。
   */
  themePushTokens(payload: { themeId: string; tokens: Record<string, string> }): void
}

/* -------------------------------------------------------------------------------------------- */
/* 扩展宿主进程（ADR-0026 / EH-A4）：渲染侧看到的契约                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * 宿主生命周期阶段。与 `src/main/extensionHostStarter.ts` 的 `ExtensionHostPhase` **同值**：
 * 主进程是唯一权威（它 fork/判活/重启），渲染侧只读。
 */
export type ExtensionHostPhase =
  'idle' | 'starting' | 'ready' | 'unresponsive' | 'crashed' | 'stopped'

/** 最近一次崩溃/启动失败的原因（`code` 是退出码，或启动器合成的负数码） */
export interface ExtensionHostCrashInfo {
  code: number
  /** 发生时间（ms epoch） */
  at: number
}

/**
 * 宿主状态快照（`eh:status` 事件载荷 / `eh:get-status` 返回值）。
 * 与启动器的 `ExtensionHostStatus` 结构一致——渲染侧不能 import 主进程模块（会拖进 electron），
 * 所以在共享层再声明一次；字段增删要两边一起改。
 */
export interface ExtensionHostStatusSnapshot {
  phase: ExtensionHostPhase
  /** 宿主自报的 id（握手成功后才有） */
  hostId: string | null
  /** 宿主进程 pid（握手成功后才有） */
  pid: number | null
  /** 5 分钟窗口内的崩溃次数（= 已用掉的自动重启预算） */
  crashCount: number
  /** 最近一次崩溃原因；从未失败为 `null` */
  lastCrash: ExtensionHostCrashInfo | null
  /** 最近一次收到宿主合法信封的时间（判活信号） */
  lastAckAt: number | null
}

/** `eh:get-port` 的返回（A2 定义：**只有状态，没有端口**） */
export interface ExtensionHostPortStatus {
  phase: ExtensionHostPhase
  /** 端口是否已交给某个渲染进程（true 而页面没有端口 = 页面在交付之后重新加载过） */
  portDelivered: boolean
  /** 端口是否还挂在启动器手里等窗口就绪 */
  portPending: boolean
  hostId: string | null
  pid: number | null
  /** 端口实际投递用的 channel（渲染侧 preload 照它监听） */
  channel: string
  /** 协议版本（错配时渲染侧桥可直接给出"需整包升级"） */
  protocolVersion: number
}

/** `eh:start` 的结果：永远 resolve，失败走 `ok:false`（`code` 为协议错误码） */
export type ExtensionHostStartOutcome =
  | { ok: true; hostId: string; pid: number }
  | { ok: false; code: EhErrorCode; message: string; detail?: string }

/**
 * `eh:port` 转移时随端口一起带来的描述（**不是信封**：端口靠 transfer 列表走，不塞字段）。
 * 字段与 A2 的 `RendererPortPayload` 一致。
 */
export interface ExtensionHostPortArrival {
  /** 协议版本（A2 目前是 1） */
  v?: number
  hostId: string | null
  pid: number | null
}

/**
 * 端口代理（preload 交付给渲染侧的**窄接口**）。
 *
 * ⚠️ 为什么不是真的 `MessagePort`：`contextBridge` 不支持传 `MessagePort`（transferable 不能跨
 * 隔离世界），而端口又不能经 `ipcMain.handle` 返回（A2 已确认）。因此 preload 在隔离世界里持有
 * 真端口，只把"发/停"两件事代理出来；渲染侧桥只依赖这个接口，单测可注入假端口。
 */
export interface ExtensionHostPortBridge {
  /** 发送一个纯数据信封（不合形状/不可传输请在**渲染侧**先拦，别指望这里抛错可读） */
  postMessage(envelope: unknown): void
  /** 关闭端口（链路断开；之后的 send 会立刻失败而不是排队） */
  close(): void
}

/**
 * preload 暴露为 `window.eh` 的扩展宿主桥接口（EH-A4）。
 *
 * 分工：**preload 只做搬运**（端口生命周期 + `ipcRenderer` 事件 → 回调），判定逻辑
 * （开关、校验、配对、超时、状态解释）全在 `renderer/src/core/extensionHostBridge.ts`，
 * 这样桥能在 node 环境里被单测直接驱动。
 */
export interface ExtensionHostBridgeSurface {
  /**
   * 回退开关的**原文**（`process.env.OBOX_EXTENSION_HOST`，未设置时 `null`）。
   * 由渲染侧解析（`isExtensionHostEnabled`）：开关判定只有一处，preload 不参与解释。
   */
  extensionHostFlag: string | null
  /** 端口是否已到达（页面重新加载后为 false，此时端口已随旧页面销毁） */
  hasPort(): boolean
  /**
   * 订阅端口到达；端口**已经先到**时用微任务补发一次（页面加载晚于投递的竞态）。
   * 返回退订函数。
   */
  onPort(
    listener: (info: ExtensionHostPortArrival, port: ExtensionHostPortBridge) => void
  ): () => void
  /** 订阅宿主 → 渲染侧的消息（原始值，由渲染侧桥校验后再分发） */
  onMessage(listener: (raw: unknown) => void): () => void
  /** 发送一个纯数据信封；端口未到时返回 `false`（不抛错，由调用方给中文错误） */
  post(envelope: unknown): boolean
  /** 订阅宿主状态变化（主进程 `eh:status`） */
  onStatus(listener: (status: ExtensionHostStatusSnapshot) => void): () => void
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

/**
 * overlay 窗体的锚点方位：贴主显示器**工作区**（`workArea`，不含任务栏）的哪个角。
 * 桌面宠物这类常驻 UI 常用 `bottom-right`；其余三角为其它 overlay 场景预留。
 */
export type OverlayAnchor = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

/**
 * overlay 窗体的创建请求（`api.overlay.create` 入参）。
 *
 * 扩展 API 与主进程窗体实现**共用同一份**，避免签名漂移——与 `openAppWindow` 的请求形状
 * （`OpenAppWindowRequest`，`src/main/appWindow.ts`）同先例。这里只定类型面：运行时的参数
 * 校验与窗体创建由主进程实现负责，违反下方 JSDoc 契约（`width`/`height` 必须 > 0、
 * `margin` ≥ 0、`url` 不得越出扩展目录等）时以 `OverlayResult.ok: false` 拒绝，不抛错。
 * 四方法的作用域约束（只能操作**自己创建的** overlay，宿主按扩展 id 校验）见
 * `src/api/types.ts` 的 `ExtensionActivationApi.overlay` JSDoc。
 */
export interface CreateOverlayRequest {
  /** overlay id（扩展内唯一，建议含扩展名前缀，如 `pet.overlay`）；`destroy` / `setMouseThrough` 以它寻址 */
  id: string
  /** 页面 URL：**该扩展内**的页面（如 `app://extensions/<id>/overlay.html`）；越出扩展目录一律拒绝 */
  url: string
  /**
   * 窗体宽（像素，必须 > 0）。overlay 尺寸固定：不可调整大小、不可最大化
   * （透明窗体被拉伸后在部分平台会失去透明，Electron 官方限制，故宿主强制固定尺寸）。
   */
  width: number
  /** 窗体高（像素，必须 > 0） */
  height: number
  /** 贴主显示器工作区的哪个角 */
  anchor: OverlayAnchor
  /** 距锚定角的边距（像素，缺省 24；必须 ≥ 0，负值拒绝） */
  margin?: number
  /**
   * 是否透明窗体（缺省 false）。**只在创建时决定，创建后不可运行时切换**（Electron 限制）；
   * 透明时宿主不绘制任何窗体背景，并关闭阴影/系统边框/圆角。Windows 上依赖 DWM 合成
   * （被组策略关闭时退化为不透明）。
   */
  transparent?: boolean
  /** 是否置顶（缺省 false；全屏独占应用下仍可能被遮挡——平台行为，非宿主缺陷） */
  alwaysOnTop?: boolean
  /** 是否不占任务栏（缺省 false） */
  skipTaskbar?: boolean
}

/**
 * `api.overlay` 四方法的统一返回：失败**不抛错**，调用方检查 `ok`
 * （与 `notification.show` / `shell.openExternal` 等扩展能力同风格；`error` 为人类可读原因）。
 */
export interface OverlayResult {
  ok: boolean
  /** 失败原因（参数校验不通过 / 越权被拒 / 窗体创建失败等） */
  error?: string
  /**
   * 窗体的**实际屏幕坐标**（左上角）：`create` 与 `setPosition` 成功时回传
   * （destroy/setMouseThrough 不带该字段）——create 回传 anchor/margin 解析后的真实位置，
   * setPosition 回传钳制后的真实位置。为什么必须回传：扩展拿不到 workArea，既算不出 anchor
   * 的绝对落点、也不知道宿主兜底钳位钳到了哪——入口要靠它建立/校正自己的位置基准（R31）。
   */
  position?: { x: number; y: number }
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

/** 断线自动重连策略（issue #44；与 `src/shared/ipcDeclaration.ts` 的同名接口形状一致） */
export interface IpcAutoReconnect {
  /** 重试次数上限（缺省 3；`0` 等价于关闭） */
  retries?: number
  /** 首次退避毫秒（缺省 250；按 ×2 递增，单次封顶 30000） */
  backoffMs?: number
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
  /**
   * 断线自动重连（issue #44）：**只有运行时声明对象（`api.ipc.connect({...})`）里的这一键生效**；
   * 清单 `contributes.ipcChannels` 里写它不报错也不生效（宿主在归一化时剥掉）。
   */
  autoReconnect?: IpcAutoReconnect
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
      /**
       * 仅 **server 通道**上的对端请求出现（issue #43）：发出该请求的连接。
       * client 通道 / stdio 路径**不出现该字段**（与 #43 之前逐字段一致）。
       */
      connectionId?: number
    }
  | { extId: string; name: string; type: 'stderr'; text: string }
  | { extId: string; name: string; type: 'close'; code: string; message: string }
  /** server 通道接受了一条新连接（`connectionId` 单调递增、**永不复用**；超限被拒的连接不触发） */
  | { extId: string; name: string; type: 'connection'; connectionId: number }
  /** server 通道上一条**已被接受**的连接断开（每条连接**恰好触发一次**） */
  | {
      extId: string
      name: string
      type: 'disconnect'
      connectionId: number
      code: string
      message: string
    }
  /**
   * client 通道**自动重连成功**（issue #44）：每次重连成功后触发一次。
   * `attempts` = 本次重连共尝试了几次（含成功那次）。
   * 达到重试上限而**放弃**时**不**再触发任何事件（通道从 `channels()` 消失即为判据）。
   */
  | { extId: string; name: string; type: 'reconnect'; attempts: number }

/** 主进程 → 渲染进程 的事件（on） */
export interface MainEvents {
  /** 窗口状态变化（最大化/还原/全屏/聚焦） */
  'window:state-changed': (state: WindowState) => void
  /** 主进程要求渲染进程打开某个导航项（托盘"设置"→ 切到设置页；ADR-0019 决策 8） */
  'nav:open': (navId: string) => void
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
  /**
   * 扩展宿主状态变化（ADR-0026 / EH-A4）：`idle → starting → ready → …` 的每次迁移各发一次，
   * 载荷含最近崩溃原因。A5 / 扩展管理器订阅它做展示；渲染侧桥另经 `window.eh.onStatus` 收一份。
   */
  'eh:status': (status: ExtensionHostStatusSnapshot) => void
}
