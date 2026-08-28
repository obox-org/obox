/**
 * 扩展激活 API 类型（面向扩展作者；扩展经相对路径导入 src/api）。
 * 宿主在激活扩展时构造并注入 ExtensionActivationApi，作为插件函数的唯一参数（api）。
 * 由 src/api/index.ts 聚合导出。
 */
import type { SettingsPage } from './contributions'
import type { AppRegistration } from './registration'
import type { Disposable } from './runtime'
import type { Memento, ProxyConfig, UpdateEvent } from './shared'

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
  }
  /** 应用信息 */
  appInfo: {
    get(): Promise<{ name: string; version: string }>
  }
  /** App（应用）扩展：向 App 注册插件卡片 */
  app: {
    /** 注册一张插件卡片，返回注销函数；扩展停用时宿主自动清理 */
    register(registration: AppRegistration): Disposable
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
    /** 安装并重启（下载完成后） */
    install(): Promise<void>
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
}
