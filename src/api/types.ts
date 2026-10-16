/**
 * 扩展激活 API 类型（面向扩展作者；扩展经相对路径导入 src/api）。
 * 宿主在激活扩展时构造并注入 ExtensionActivationApi，作为插件函数的唯一参数（api）。
 * 由 src/api/index.ts 聚合导出。
 */
import type { SettingsPage } from './contributions'
import type { AppRegistration } from './registration'
import type { Disposable } from './runtime'
import type { IpcChannelDeclaration, Memento, ProxyConfig, UpdateEvent } from './shared'
// 对话框类型是**主进程/preload/扩展 API 三处共用**的同一份定义（spec §9.11 H-2/H-3），
// 落在 src/shared/types.ts，这里只再导出给扩展作者（`import type { DialogOpenOptions } from '<ext>/api'`）。
// overlay 的请求/响应类型沿用同一先例（扩展 API 与主进程窗体实现共用一份契约，防签名漂移），
// 同样落在 shared、在这里再导出。
import type {
  CreateOverlayRequest,
  DialogFilter,
  DialogOpenOptions,
  DialogOpenResult,
  DialogProperty,
  OverlayAnchor,
  OverlayResult
} from '../shared/types'

export type {
  CreateOverlayRequest,
  DialogFilter,
  DialogOpenOptions,
  DialogOpenResult,
  DialogProperty,
  OverlayAnchor,
  OverlayResult
}

/** 数据库行（对象，键=列名） */
export type SqliteRow = Record<string, unknown>

/** 结构体匹配条件：{ 字段: 值 }，多键 AND 等值匹配 */
export type SqliteWhere = Record<string, unknown>

/** 扩展数据库句柄（api.sqlite.open 返回；行操作作用于默认表 = 文件名去扩展名） */
export interface SqliteDb {
  /** 执行 SQL 脚本（建表/初始化，可多语句；不返回结果集） */
  exec(sql: string): Promise<{ ok: boolean; error?: string }>
  /** 复杂查询（SELECT/JOIN/聚合），返回对象数组 */
  query(sql: string, params?: unknown[]): Promise<SqliteRow[]>
  /** 插入一行（首次写入自动建表，id 主键自增；含 id 则 upsert），返回新行 */
  insert(row: Record<string, unknown>): Promise<SqliteRow | null>
  /** 按等值条件更新部分字段，返回受影响行数 */
  update(where: SqliteWhere, patch: Record<string, unknown>): Promise<number>
  /** 按 id 取单行 */
  get(id: unknown): Promise<SqliteRow | null>
  /** 取全部行 */
  get_all(): Promise<SqliteRow[]>
  /** 按等值条件匹配，返回数组 */
  get_by(where: SqliteWhere): Promise<SqliteRow[]>
  /** 按 id 删除，返回受影响行数 */
  del(id: unknown): Promise<number>
  /** 按等值条件删除，返回受影响行数 */
  del_by(where: SqliteWhere): Promise<number>
  /** 清空表，返回受影响行数 */
  clear(): Promise<number>
  /** 关闭连接（扩展停用宿主自动关闭，也可手动调用） */
  close(): Promise<void>
}

/** 快速选择项（api.ui.showQuickPick） */
export interface QuickPickItem {
  label: string
  description?: string
}

/** 表单字段（api.ui.showForm） */
export interface FormField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'date' | 'time' | 'select' | 'checkbox'
  /** 必填（提交时校验；checkbox 数组为空视为未填） */
  required?: boolean
  placeholder?: string
  default?: unknown
  /** select / checkbox 的选项 */
  options?: Array<{ value: string; label: string }>
}

/** 输出通道（api.output.createChannel 返回，底部输出面板） */
export interface OutputChannel {
  append(text: string): void
  appendLine(text: string): void
  /** 显示输出面板并切到该通道 */
  show(): void
  clear(): void
  dispose(): void
}

/** 运行时状态栏项句柄（api.statusBar.createItem 返回） */
export interface StatusBarItem {
  /** 显示文本（支持 $(icon) 语法） */
  text: string
  /** 悬停提示 */
  tooltip?: string
  show(): void
  hide(): void
  dispose(): void
}

/** 树视图节点（contributes.views 树视图数据源） */
export interface TreeItem {
  /** 节点 id（同层唯一） */
  id: string
  /** 显示文本 */
  label: string
  /** 图标（SVG 字符串） */
  icon?: string
  /** 是否有子节点（true 时展开才加载） */
  collapsible?: boolean
  /** 点击节点执行的命令（须已声明） */
  command?: string
  /** 命令参数 */
  args?: unknown[]
}

/** 树视图数据源（api.views.registerTreeProvider 注册） */
export interface TreeViewProvider {
  /** 返回子节点（element 为空 = 根节点） */
  getChildren(element?: TreeItem): TreeItem[] | Promise<TreeItem[]>
}

/** 激活扩展时的宿主能力注入（传给扩展插件函数） */
export interface ExtensionActivationApi {
  /** 命令注册：把 manifest 声明的命令 id 绑定实现 */
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable
  /** 执行命令（跨扩展，经命令 id） */
  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>
  /** 状态栏项（manifest 声明的静态项在启动时已注册；运行时可用此更新文本/显示） */
  statusBar: {
    setText(id: string, text: string): void
    setTooltip(id: string, tooltip: string): void
    show(id: string): void
    hide(id: string): void
    /** 运行时创建状态栏项（动态项，可 show/hide/dispose） */
    createItem(init?: {
      text?: string
      tooltip?: string
      alignment?: 'left' | 'right'
      priority?: number
    }): StatusBarItem
  }
  /** 导航栏徽标 */
  navbar: {
    setBadge(id: string, count: number | undefined): void
  }
  /** Memento 状态存储 */
  workspaceState: Memento
  globalState: Memento
  /** 事件总线（Cordis ctx.on / ctx.emit） */
  on(event: string, listener: (...args: unknown[]) => void): Disposable
  emit(event: string, ...args: unknown[]): void
  /** 窗口能力（经 preload IPC） */
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    /** 主窗口任务栏进度（0~1；null 清除） */
    setProgressBar(progress: number | null): Promise<void>
    /** 主窗口是否聚焦 */
    isFocused(): Promise<boolean>
    /** 聚焦状态变化监听（返回注销函数） */
    onFocusChanged(callback: (focused: boolean) => void): Disposable
  }
  /** 应用信息 */
  appInfo: {
    get(): Promise<{ name: string; version: string }>
  }
  /** App（应用）扩展：向 App 注册插件卡片 */
  app: {
    /** 注册一张插件卡片，返回注销函数；扩展停用时宿主自动清理 */
    register(registration: AppRegistration): Disposable
    /**
     * 注册 App 子窗口消息处理器（子窗口 iframe 经 postMessage 发来的消息）。
     * handler(channel, payload) 返回值/结果回传给 iframe（可返回 Promise）；返回注销函数。
     */
    onMessage(
      handler: (channel: string, payload: unknown) => unknown | Promise<unknown>
    ): Disposable
  }
  /**
   * Overlay 窗体：无边框、可透明、可置顶、可不占任务栏的**固定小窗**（桌面宠物/悬浮小部件类场景）。
   *
   * 与 App 子窗口（`api.app`）的区别：overlay 不注册卡片、不进启动器/导航区，由**扩展自行
   * 创建与销毁**——适合"后台扩展"（不注册 App 卡片）的常驻桌面 UI。窗体尺寸固定（不可调整
   * 大小、不可最大化），定位在**主显示器**的工作区（`workArea`，不含任务栏）内按 `anchor` 贴角。
   *
   * **作用域（安全约束）**：四个方法都只能操作**调用方扩展自己创建的** overlay——宿主按扩展 id
   * 校验，越权操作别人的 overlay 一律拒绝（返回 `ok: false` + 原因）。为什么必须严格：扩展与
   * 宿主同上下文、无沙箱（ADR-0015），不限定作用域等于任一扩展都能销毁或穿透别人的窗体。
   *
   * 宿主停用/卸载扩展时会**自动回收**该扩展的全部 overlay（与入口 cleanup 一同生效），
   * 扩展无需手动销毁兜底。
   *
   * 本命名空间为**必填**（卡 03 运行时接线落地后由 `overlay?` 翻成 `overlay`，裁定 R2/R12）：
   * 宿主 buildApi（core/host.ts 的 buildOverlayApi）构造 api 时必定注入。老宿主没有本命名空间
   * 的问题由 manifest `apiVersion` 门槛兜底——声明 `apiVersion: 2` 的扩展在老宿主上直接被
   * 拒绝加载（见 `core/manifest.ts`），因此过门槛成功激活的扩展可直接 `api.overlay.create(...)`，
   * 不需要可选链。
   */
  overlay: {
    /**
     * 创建 overlay 窗体。失败**不抛错**，返回 `ok: false` + `error`
     * （与 `notification.show` / `shell.openExternal` 的返回风格一致）。
     *
     * 宿主校验的契约（违反一律拒绝）：`id`/`url` 非空、`width`/`height` 必须 > 0、
     * `margin` ≥ 0、`anchor` 必须是合法枚举值、`url` 必须指向本扩展内的页面（不得越出
     * 扩展目录）；同一扩展下同一 `id` 重复创建会被拒绝。创建成功后窗体**默认鼠标穿透**
     * （等效已调用 `setMouseThrough(id, true)`）——透明 overlay 不应一出现就"吞掉"其
     * 覆盖区域的桌面点击。
     *
     * 成功时返回的 `position` 是窗体在屏幕上的**绝对坐标**（左上角；anchor/margin 解析后的
     * 真实值，R31）——扩展拿不到 workArea，拖动换位时以它为基准把增量换算成 `setPosition`
     * 的绝对坐标。失败路径不带 `position`。
     */
    create(options: CreateOverlayRequest): Promise<OverlayResult>
    /**
     * 销毁指定 overlay：**真正销毁**窗体（不是隐藏）——页面与驱动它的 rAF/定时器动画循环
     * 随之终止，CPU 占用回落；权威状态应由扩展入口持有，不随窗体销毁丢失。
     * 幂等：不存在（或已销毁）的 `id` 重复销毁静默成功；越权（`id` 属于别的扩展）会被拒绝。
     */
    destroy(id: string): Promise<OverlayResult>
    /**
     * 切换鼠标穿透：`through: true` ⇒ 整窗不接收鼠标事件，宿主实现为
     * `setIgnoreMouseEvents(true, { forward: true })`——悬停移动**仍会转发**给页面，
     * 页面据此做命中测试（未命中精灵/面板 ⇒ 保持穿透；命中 ⇒ 临时关闭穿透以接收点击）；
     * `false` ⇒ `setIgnoreMouseEvents(false)` 恢复正常接收。
     * 注意这是**整窗**切换：Electron 没有逐像素 alpha 穿透（关闭穿透时透明窗体的空白区
     * 也会一并捕获点击）。越权会被拒绝。
     */
    setMouseThrough(id: string, through: boolean): Promise<OverlayResult>
    /**
     * 移动 overlay 窗体到屏幕坐标 `(x, y)`（**窗体左上角**，像素；拖宠物换位一类的运行期移动）。
     * 失败**不抛错**，返回 `ok: false` + `error`；成功时返回的 `position` 是**钳制后的实际坐标**
     * （与 `create` 回传初始绝对位置同口径），扩展入口应用它校正自己记录的位置。
     *
     * **钳位双保险**：扩展侧**主钳**（拖动入口累加增量后先钳到工作区再调本方法，见宠物扩展
     * design D-13）；宿主侧**兜底**——把 x/y 钳进主显示器工作区（`x ∈ [wa.x, wa.x+wa.width-w]`、
     * `y ∈ [wa.y, wa.y+wa.height-h]`，w/h 为该 overlay 当前尺寸）。为什么要回传 `position`：
     * 扩展拿不到 workArea，被宿主钳过之后只有自己算的值是错的。
     * 非法坐标（NaN/Infinity/非数字）**直接拒绝，不钳不猜**。
     * 移动只改位置：不触碰 transparent/alwaysOnTop/鼠标穿透态；不存在的 `id` 返回 `ok: false`
     * （与 `setMouseThrough` 同口径，无幂等语义）；越权（`id` 属于别的扩展）会被拒绝。
     */
    setPosition(id: string, x: number, y: number): Promise<OverlayResult>
  }
  /** 扩展多语言能力（扩展语言包与宿主语言包独立命名空间） */
  i18n: {
    /** 按当前语言查扩展自己的语言包（key 缺省返回 key 本身） */
    t(key: string, params?: Record<string, unknown>): string
    /** 当前语言代码（'zh' | 'en'） */
    readonly locale: string
    /** 语言切换监听（返回注销函数） */
    onLocaleChanged(callback: (locale: string) => void): Disposable
    /** 运行时注册扩展语言包（或 manifest contributes.i18n 声明） */
    registerMessages(messages: Record<string, Record<string, string>>): void
  }
  /** 扩展设置页注册（非内置扩展的设置项，显示在设置"扩展"节点） */
  settings: {
    /** 注册一个设置页（返回注销函数）；或 manifest contributes.settings 声明 */
    register(page: SettingsPage): Disposable
    /** 读取扩展设置值（与宿主统一设置存储，key 建议含扩展前缀） */
    get<T = unknown>(key: string, defaultValue?: T): T | undefined
    /** 写入扩展设置值（立即持久化并通知） */
    set(key: string, value: unknown): void
    /** 设置变更监听（≈VS Code onDidChangeConfiguration；返回注销函数） */
    onChanged(callback: (key: string) => void): Disposable
  }
  /** 更新能力（仅"更新提供者扩展"可用；设置-更新选择生效的提供者） */
  update: {
    /** 当前 obox 版本号 */
    getVersion(): Promise<string>
    /**
     * 解析 GitHub 仓库"最后一次编译"的 release 更新源（按创建时间最新，不依赖 latest 标记）。
     * 返回的 feedUrl 可直接传给 check()。
     */
    resolveFeed(repo: string): Promise<{
      ok: boolean
      tag?: string
      feedUrl?: string
      publishedAt?: string
      error?: string
    }>
    /** 检查更新（feedUrl 为更新源；无默认源） */
    check(feedUrl: string): Promise<{ ok: boolean; available?: string; error?: string }>
    /** 下载更新（不自动安装） */
    download(): Promise<{ ok: boolean; error?: string }>
    /**
     * 安装更新。
     * - 缺省：`quitAndInstall()` —— 重启并安装 electron-updater 已下载的版本
     * - `{ force: true }`：**强制重装 / 降级** —— 直接从更新源下载本机架构的安装包、校验 sha512 后
     *   启动安装向导（应用不退出）。它绕开 electron-updater 的版本门控（`allowDowngrade=false` +
     *   同版本按 semver 判"无更新"），因此**同版本重装与降级都能做**。
     *   `feedUrl` 缺省时使用提供者 manifest 里的 `contributes.updater.feedUrl`
     */
    install(opts?: {
      force?: boolean
      feedUrl?: string
    }): Promise<{ ok: boolean; version?: string; error?: string }>
    /** 订阅更新事件（发现新版本/下载进度/下载完成/错误），返回注销函数 */
    onEvent(callback: (e: UpdateEvent) => void): Disposable
  }
  /** 代理配置（obox 与内置扩展自动使用；非内置扩展可选） */
  proxy: {
    /** 读取当前代理配置（设置-网络页） */
    get(): ProxyConfig
  }
  /** 全局定时器（主进程精确计时，**秒粒度**整数 ≥1s，不受渲染进程后台节流影响；扩展停用自动清理） */
  timer: {
    /** 一次性定时器：seconds 秒后执行一次 callback（同 id 重复设置会重置） */
    setTimeout(id: string, seconds: number, callback: () => void): void
    /** 重复定时器：每 seconds 秒执行一次 callback（同 id 重复设置会重置） */
    setInterval(id: string, seconds: number, callback: () => void): void
    /** 取消一次性定时器（无此 id 则无操作） */
    clearTimeout(id: string): void
    /** 取消重复定时器（无此 id 则无操作） */
    clearInterval(id: string): void
  }
  /** sqlite 数据库（node:sqlite 内置驱动；**相对路径** → 扩展 data 目录，拒绝绝对路径；首次写入自动建表） */
  sqlite: {
    /** 打开数据库（相对路径如 'todo.db' 或 'sub/a.db'；自动建目录），返回表集合句柄 */
    open(name: string): Promise<SqliteDb>
  }
  /** 系统提醒（操作系统通知；设置-通知可逐扩展关闭，关闭后 show 无操作） */
  notification: {
    /** 显示一条系统通知；点击通知自动聚焦主窗口并执行 onClick（若有） */
    show(opts: {
      title: string
      body?: string
      icon?: string
      onClick?: () => void
    }): Promise<{ ok: boolean; error?: string }>
  }
  /** 网络请求（渲染进程 CSP 禁外网，走主进程 + 自动应用设置-网络代理；默认 30s 超时） */
  net: {
    /** 发起请求；data 按响应 Content-Type 自动解析 JSON/文本；opts.json=true 强制解析 JSON */
    fetch(
      url: string,
      opts?: {
        method?: string
        headers?: Record<string, string>
        body?: unknown
        json?: boolean
      }
    ): Promise<{
      ok: boolean
      status?: number
      statusText?: string
      data?: unknown
      error?: string
    }>
  }
  /** 文件对话框（主进程 dialog） */
  dialog: {
    /**
     * 打开对话框 → 选中路径数组（**目录选择与文件选择共用 `filePaths`**）。
     * `opts.properties`: 不传 ⇒ `['openFile']`（默认行为不变）；传 `['openDirectory']` ⇒ 弹**目录**框
     * （与 `openFile` 互斥，目录模式下 `filters` 不生效）。**老宿主会忽略 `properties`** ⇒ 拿到路径后
     * 请自证它是不是目录（见 `docs/extension-api/troubleshooting.md` 第 32 节）。
     */
    showOpenDialog(opts?: DialogOpenOptions): Promise<DialogOpenResult>
    /** 保存对话框 → 保存路径 */
    showSaveDialog(opts?: {
      title?: string
      defaultName?: string
      filters?: DialogFilter[]
    }): Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>
    /** 消息框（info/warning/error/question）→ 点击的按钮下标 */
    showMessageBox(opts?: {
      type?: 'info' | 'warning' | 'error' | 'question'
      title?: string
      message?: string
      detail?: string
      buttons?: string[]
    }): Promise<{ ok: boolean; response?: number; error?: string }>
  }
  /** 打开外部链接/路径（系统默认程序） */
  shell: {
    /** 用系统浏览器打开链接（仅 http/https） */
    openExternal(url: string): Promise<{ ok: boolean; error?: string }>
    /** 用系统默认程序打开文件/目录 */
    openPath(p: string): Promise<{ ok: boolean; error?: string }>
  }
  /** 剪贴板 */
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
  }
  /** 运行环境信息 */
  env: {
    /** 操作系统平台（win32/darwin/linux） */
    readonly platform: string
    /** CPU 架构（x64/arm64） */
    readonly arch: string
    /** Node 版本（宿主内置） */
    readonly nodeVersion: string
    /** 当前 UI 语言（'zh' | 'en'） */
    readonly language: string
    /** obox 版本号 */
    getOboxVersion(): Promise<string>
  }
  /** 主题（读当前主题/监听切换） */
  theme: {
    /** 当前主题 id（如 theme-dark） */
    getCurrent(): string
    /** 主题切换监听（返回注销函数） */
    onChanged(callback: (themeId: string) => void): Disposable
  }
  /** 文件系统（限定扩展自己的数据目录，相对路径；自动建目录） */
  fs: {
    /** 读取文本文件 */
    readFile(rel: string): Promise<string>
    /** 写入文本文件（自动建目录） */
    writeFile(rel: string, content: string): Promise<void>
    /** 列出目录内容 */
    readDir(rel: string): Promise<Array<{ name: string; isDir: boolean }>>
    /** 路径是否存在 */
    exists(rel: string): Promise<boolean>
    /** 删除文件/目录（递归） */
    remove(rel: string): Promise<void>
    /** 监听扩展 data 目录内变化（相对路径事件；扩展停用自动清理） */
    watch(watchId: string, dir: string, callback: (e: { relPath: string }) => void): Promise<void>
    /** 停止监听 */
    unwatch(watchId: string): Promise<void>
  }
  /** 交互 UI（应用内，非模态） */
  ui: {
    /** 选项选择面板，返回选中项 label（取消 → undefined） */
    showQuickPick(
      items: QuickPickItem[],
      opts?: { title?: string; placeHolder?: string; closeOnClickOutside?: boolean }
    ): Promise<string | undefined>
    /** 单行输入框，返回输入值（取消 → undefined） */
    showInputBox(opts?: {
      title?: string
      value?: string
      placeHolder?: string
      password?: boolean
      closeOnClickOutside?: boolean
    }): Promise<string | undefined>
    /** 应用内 toast（非模态，自动消失；区别于 dialog 阻塞消息框和系统 notification） */
    showMessage(message: string, type?: 'info' | 'warning' | 'error' | 'success'): void
    /**
     * 多字段表单模态框（返回 {field: value}；取消/校验不通过 → undefined）。
     * closeOnClickOutside: 点击遮罩是否关闭（默认 true；false 只能经取消/确定关闭，避免误触丢失输入）
     */
    showForm(opts: {
      title?: string
      fields: FormField[]
      closeOnClickOutside?: boolean
    }): Promise<Record<string, unknown> | undefined>
    /** 任务进度（title + 进度条，task 完成自动关闭；report(percent) 更新进度） */
    withProgress<T>(
      title: string,
      task: (report: (percent: number) => void) => Promise<T>
    ): Promise<T>
  }

  /**
   * 与外部进程的**端口无关**双向 IPC（stdio / 命名管道 / Unix 域套接字，不使用 TCP 端口）。
   * 规格见 issue #40；pipe 服务端（多连接，`listen`）见 issue #43。
   *
   * 通道分两类，**共用同一命名空间**（同一扩展内名字唯一）：
   * - **client 通道**（`connect`）：宿主作为拨号方，一对一；没有连接 ID；
   * - **server 通道**（`listen`）：宿主作为服务端接受**多条**连接；每条连接有一个
   *   进程内单调递增、**永不复用**的 `connectionId`。
   *
   * ```ts
   * await api.ipc.connect({ id: 'worker', transport: 'stdio', program: 'bin/worker.exe' })
   * api.ipc.onRequest('worker', (method, params) => ({ echo: params })) // 对端也可调用宿主
   * const sum = await api.ipc.request('worker', 'sum', { a: 1, b: 2 })
   * api.ipc.onNotification('worker', (method, params) => {})
   * api.ipc.onStderr('worker', (text) => api.output.append('worker', text))
   * api.ipc.onClose('worker', (err) => {})
   * await api.ipc.close('worker')
   *
   * // 服务端：接受多条连接（issue #43）
   * await api.ipc.listen({ id: 'svc', transport: 'pipe' })
   * api.ipc.onConnection('svc', (connectionId) => {})
   * const pong = await api.ipc.request('svc', 'ping', {}, { connectionId: 1 })
   * await api.ipc.broadcast('svc', 'tick', { n: 1 }) // 通知语义：不收集回包
   * api.ipc.onDisconnect('svc', (connectionId, err) => {})
   *
   * // 断线自动重连：只对 pipe 的**运行时**声明生效（issue #44）
   * await api.ipc.connect({ id: 'bus', transport: 'pipe', autoReconnect: { retries: 5 } })
   * api.ipc.onReconnect('bus', ({ attempts }) => api.ipc.request('bus', 'hello')) // 自行握手
   * ```
   *
   * **三条重连语义**（issue #44，逐条测过）：
   * 1. **在途请求绝不重放**：断线瞬间该通道所有挂起请求立即以断因码（`peer-crashed`）失败，
   *    不会在重连后补发；重连后请自行重发（这正是 `onReconnect` 的用途）；
   * 2. **重连期的新请求立即失败**：窗口期内 `request`/`notify` 立即以 `not-connected` 返回
   *    （不排队、不延迟），但 `channels()` **仍含**该通道名（不含 = 已放弃重连）；
   * 3. **协议层状态不保留**：重连成功是一条**新通道**（请求 id 从 1 重新开始、挂起表为空），
   *    需要握手的扩展必须在 `onReconnect` 里自己做；`autoReconnect` **只能写在运行时声明对象里**
   *    （写进 manifest 的 `contributes.ipcChannels` 既不报错也不生效），且**只对 `pipe` 有效**
   *    （`stdio` + `autoReconnect` → `invalid-declaration`，stdio 请自行在 `onClose` 里退避重连）。
   *
   * 稳定错误码：`invalid-declaration` / `connect-failed` / `not-connected` / `protocol-error` /
   * `timeout` / `cancelled` / `message-too-large` / `too-many-requests` / `too-many-channels` /
   * `too-many-connections` / `peer-crashed` / `channel-closed`。
   * 注意：本能力是**能力封装而非安全边界**（扩展与宿主同上下文，见 ADR-0015）。
   */
  ipc: {
    /**
     * 打开通道：`stdio` 由宿主拉起子进程（program 必须是扩展目录内相对路径）；`pipe` 连接已在运行的进程。
     * `declaration.autoReconnect`（issue #44）**只在此处（运行时声明对象）生效**，且只对 `pipe` 有效；
     * 清单里写它不报错也不生效。
     */
    connect(declaration: IpcChannelDeclaration | string): Promise<void>

    /**
     * 以**服务端**身份 listen 一个 pipe 端点（issue #43）：
     * - `declaration.transport` 必须是 `'pipe'`（传 `'stdio'` → `invalid-declaration`）；
     * - `declaration.id` 与既有 client 通道**共用命名空间**（重名 → `invalid-declaration`）；
     * - 端点**不带 suffix**：Windows `\\.\pipe\obox-<扩展id>-<通道名>`；
     *   POSIX `<userData>/ipc/obox-<扩展id>-<通道名>.sock`（服务端会自行清理陈旧 `.sock` 并 `chmod 0600`）；
     * - 该 server 的**所有连接共用** `declaration.framing`；
     * - 最多接受 16 条连接，第 17 条由宿主回一条 JSON-RPC 错误帧后关闭（不触发任何事件）。
     */
    listen(declaration: IpcChannelDeclaration): Promise<void>

    /**
     * 关闭该名字下的**一切**（issue #43）：
     * - 该名字是 client 通道 → 断开该通道；
     * - 该名字是 server → 停止监听并断开它**全部**连接；
     * - 两类都不存在 → **静默成功**；
     * - **幂等**（重复调用无副作用、不抛错）。
     */
    close(name: string): Promise<void>

    /** 当前通道名集合（**含** server 名；server 与 client 都在其中） */
    channels(): Promise<string[]>

    /**
     * 发请求并等响应；超时默认 30s，可逐请求覆盖。
     * - `name` 是 **server**：必须给 `opts.connectionId`，否则 `invalid-declaration`；
     *   指向已断开/不存在的连接 → `not-connected`；
     * - `name` 是 **client 通道**：不得给 `connectionId`（客户端通道没有连接 ID 命名空间）→ `invalid-declaration`。
     */
    request(
      name: string,
      method: string,
      params?: unknown,
      opts?: {
        /** 逐请求超时（毫秒；缺省 30s） */
        timeoutMs?: number
        /** 定向到 server 通道的某条连接（server 名字下必填） */
        connectionId?: number
      }
    ): Promise<unknown>

    /** 发通知（无应答）；`opts.connectionId` 的规则与 `request` 完全一致 */
    notify(
      name: string,
      method: string,
      params?: unknown,
      opts?: { connectionId?: number }
    ): Promise<void>

    /**
     * 向该 **server** 当前**全部已连接**对端各发**一条通知**（JSON-RPC notification，
     * **不收集回包**，因此返回 `Promise<void>`）：
     * - 要"定向请求"请用 `request(name, method, params, { connectionId })`；
     * - 已断开的连接**跳过**（不报错）；**无连接时静默成功**（不报 `not-connected`）；
     * - 单条连接写失败按**该连接断开**处理（触发 `onDisconnect`），`broadcast` 本身不抛错；
     * - `name` 存在但是 **client 通道** → `invalid-declaration`；`name` **不存在** → `not-connected`。
     */
    broadcast(name: string, method: string, params?: unknown): Promise<void>

    /**
     * 处理**对端发来的请求**（双向）：返回值作为 JSON-RPC result 回给对端（client / server 通道都可用）。
     *
     * **按通道名寻址的两条已知限制**（本期不改签名，见 issue #43 设计 D2 与
     * `docs/extension-api/api-reference.md` 的「每连接独立会话」）：
     * - 回调**不携带 `connectionId`**：server 通道上无法从 handler 得知请求来自哪条连接，
     *   要按连接分派只能在 `onConnection` / `onDisconnect` 里自行维护映射（回包由宿主按内部
     *   requestId 路由，不需要 ID）；
     * - 同一通道名**只生效最先注册**的那个 handler（宿主取插入序第一个），后注册的既不生效也
     *   不覆盖前一个；`dispose()` 掉前一个之后，后一个才顶上。
     */
    onRequest(name: string, handler: (method: string, params: unknown) => unknown): Disposable
    /** 订阅对端通知 */
    onNotification(name: string, cb: (method: string, params: unknown) => void): Disposable
    /** 订阅通道关闭（含对端崩溃）；每扩展主动 `close()` 与每次断连各触发一次 */
    onClose(name: string, cb: (err: { code: string; message: string }) => void): Disposable
    /** 订阅对端日志（stdio 的 stderr；pipe 传输没有独立日志流） */
    onStderr(name: string, cb: (text: string) => void): Disposable

    /**
     * 订阅 server 通道**接受了一条新连接**（issue #43）：
     * `connectionId` = 进程内单调递增、**永不复用**的正整数；被超限拒绝的连接**不触发**。
     * 宿主**不自动重连**服务端连接：对端回来就是一次新连入、拿一个新 ID。
     */
    onConnection(name: string, cb: (connectionId: number) => void): Disposable

    /**
     * 订阅 server 通道上一条**已被接受的连接断开**（issue #43）：
     * - 每条连接**恰好触发一次**；`err.code` 为断因（`peer-crashed` / `protocol-error` /
     *   宿主关闭 server 或 `close()` 时为 `channel-closed`）；
     * - 断开瞬间该连接上的**双向**挂起请求立即以断因码失败，**绝不重放**；
     * - 同一 server 的其它连接不受影响。
     */
    onDisconnect(
      name: string,
      cb: (connectionId: number, err: { code: string; message: string }) => void
    ): Disposable

    /**
     * 订阅 client 通道的**重连成功**（issue #44；只在声明了 `autoReconnect` 的 `pipe` 通道上会触发）：
     * - 每次重连成功后触发一次；`info.attempts` = 本次重连共尝试几次（含成功那次，首次即成功为 1）；
     * - **不自动握手**：重连后是一条**新通道**（协议层状态全部丢弃、请求 id 从 1 重新开始、
     *   挂起表为空），需要握手的扩展必须在这里自己做（例如重新 `request('hello')`）；
     * - **达到 `retries` 上限仍失败时不会触发本事件**：通道会从 `channels()` 消失
     *   （`channels()` 仍含该通道名 = 正在重连；不含 = 已放弃），此后请求报 `not-connected`；
     * - 断线瞬间的 `onClose` 每个断连周期**恰好一次**（在第一次重试尝试之前）。
     */
    onReconnect(name: string, cb: (info: { attempts: number }) => void): Disposable
  }
  /** 输出通道（底部输出面板，多通道 tab） */
  output: {
    createChannel(name: string): OutputChannel
  }
  /**
   * 扩展自带的 **Python 运行时**（ADR-0018）：只提供 `run`，用来跑随扩展分发的脚本。
   *
   * - **默认不超时**：交互式脚本（`plt.show()`）会开窗等用户关窗，调用会一直等到进程结束；
   * - **脚本自身失败不抛错**：返回非零 `code` + `stderr`（调用方需自行判断 `code`）；
   * - 需要与宿主双向通信时传 `opts.channel`：该进程会被注册成一条 **`api.ipc` 通道**
   *   （占用"每扩展 4 条通道"限额），随后用 `api.ipc.request/onRequest/...` 与它交互；
   *   Python 侧需自行实现 JSON-RPC 与 `Content-Length` 分帧，且**不要**再往 stdout 打印；
   * - 依赖随扩展包预置在 `<扩展>/python/`（含 pip，但不注入代理：宿主的代理设置对 Python 无效）。
   *
   * 稳定错误码（宿主侧失败才抛）：`python-missing`（包里没有该架构的运行时）/
   * `arch-mismatch`（架构不符）/ `launch-failed`（启动失败）/ `invalid-declaration`（声明非法，如脚本越出扩展目录）。
   */
  python: {
    run(
      script: string,
      args?: string[],
      opts?: { channel?: string | boolean }
    ): Promise<{ code: number | null; stdout: string; stderr: string }>
  }
  /** 密钥存储（主进程 safeStorage 加密存 userData；token/凭据用） */
  secrets: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  /** 树视图数据源（contributes.views 声明视图后注册数据源；返回注销函数） */
  views: {
    registerTreeProvider(viewId: string, provider: TreeViewProvider): Disposable
  }
}
