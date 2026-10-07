/**
 * 扩展激活 API 类型（面向扩展作者；扩展经相对路径导入 src/api）。
 * 宿主在激活扩展时构造并注入 ExtensionActivationApi，作为插件函数的唯一参数（api）。
 * 由 src/api/index.ts 聚合导出。
 */
import type { SettingsPage } from './contributions'
import type { AppRegistration } from './registration'
import type { Disposable } from './runtime'
import type { IpcChannelDeclaration, Memento, ProxyConfig, UpdateEvent } from './shared'

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
    /** 文件选择对话框 → 选中路径数组 */
    showOpenDialog(opts?: {
      title?: string
      filters?: DialogFilter[]
      multiSelect?: boolean
    }): Promise<{ ok: boolean; filePaths?: string[]; canceled?: boolean; error?: string }>
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
   * 规格见 issue #40；协议为 JSON-RPC 2.0，两种分帧（content-length 默认 / ndjson）。
   *
   * ```ts
   * await api.ipc.connect({ id: 'worker', transport: 'stdio', program: 'bin/worker.exe' })
   * api.ipc.onRequest('worker', (method, params) => ({ echo: params })) // 对端也可调用宿主
   * const sum = await api.ipc.request('worker', 'sum', { a: 1, b: 2 })
   * api.ipc.onNotification('worker', (method, params) => {})
   * api.ipc.onStderr('worker', (text) => api.output.append('worker', text))
   * api.ipc.onClose('worker', (err) => {})
   * await api.ipc.close('worker')
   * ```
   *
   * 稳定错误码：`invalid-declaration` / `connect-failed` / `not-connected` / `protocol-error` /
   * `timeout` / `cancelled` / `message-too-large` / `too-many-requests` / `too-many-channels` /
   * `peer-crashed` / `channel-closed`。
   * 注意：本能力是**能力封装而非安全边界**（扩展与宿主同上下文，见 ADR-0015）。
   */
  ipc: {
    /** 打开通道：`stdio` 由宿主拉起子进程（program 必须是扩展目录内相对路径）；`pipe` 连接已在运行的进程 */
    connect(declaration: IpcChannelDeclaration | string): Promise<void>
    /** 关闭通道（幂等） */
    close(name: string): Promise<void>
    /** 当前已打开的通道名 */
    channels(): Promise<string[]>
    /** 发请求并等响应；超时默认 30s，可逐请求覆盖 */
    request(
      name: string,
      method: string,
      params?: unknown,
      opts?: { timeoutMs?: number }
    ): Promise<unknown>
    /** 发通知（无应答） */
    notify(name: string, method: string, params?: unknown): Promise<void>
    /** 处理**对端发来的请求**（双向）：返回值作为 JSON-RPC result 回给对端 */
    onRequest(name: string, handler: (method: string, params: unknown) => unknown): Disposable
    /** 订阅对端通知 */
    onNotification(name: string, cb: (method: string, params: unknown) => void): Disposable
    /** 订阅通道关闭（含对端崩溃） */
    onClose(name: string, cb: (err: { code: string; message: string }) => void): Disposable
    /** 订阅对端日志（stdio 的 stderr；pipe 传输没有独立日志流） */
    onStderr(name: string, cb: (text: string) => void): Disposable
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

/** 文件对话框过滤器 */
export interface DialogFilter {
  name: string
  extensions: string[]
}
