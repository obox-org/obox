/**
 * 扩展 API 类型（面向扩展作者）。
 * 扩展通过 manifest 声明贡献点，入口导出 Cordis 插件函数 + 具名导出视图组件。
 * 本文件由宿主导入，扩展经相对路径或别名引用类型。
 */
import type { Component } from 'vue'

/** 导航栏分组：top = 可排序业务导航；bottom = 固定全局区（不参与排序） */
export type NavGroup = 'top' | 'bottom'

/** 导航项贡献点（manifest 声明） */
export interface NavItemContribution {
  /** 唯一 id（建议含扩展名前缀，如 `ext-manager.home`） */
  id: string
  /** 显示名称（hover tooltip 显示） */
  title: string
  /** 图标：SVG 字符串（data: 或 path 均可），或组件 id（宿主内置图标名） */
  icon: string
  /** 分组：top（可排序）/ bottom（固定全局区） */
  group?: NavGroup
  /** 绑定的视图组件 id（扩展入口具名导出的组件名），点击导航项时渲染 */
  view?: string
  /** 数字徽标初始值（扩展运行时可用 ctx.navbar.setBadge 更新） */
  badge?: number
}

/** 状态栏对齐 */
export type StatusBarAlignment = 'left' | 'right'

/** 状态栏项贡献点（manifest 声明） */
export interface StatusBarItemContribution {
  /** 唯一 id（扩展内唯一） */
  id: string
  /** 显示名称（hover tooltip） */
  name: string
  /** 初始文本（支持 $(icon) 语法） */
  text?: string
  /** 对齐：left / right */
  alignment?: StatusBarAlignment
  /** 优先级：同侧数值大者靠左（左侧）/ 靠右（右侧）；同值时按扩展 id 决胜 */
  priority?: number
  /** 点击绑定的命令 id */
  command?: string
}

/** 命令贡献点（manifest 声明） */
export interface CommandContribution {
  /** 命令 id（全局唯一，建议 `<扩展名>.<动作>`） */
  command: string
  /** 显示标题 */
  title: string
  /** 分类（命令面板中分组显示，如 "扩展"） */
  category?: string
  /** 是否在命令面板显示（默认 true） */
  palette?: boolean
  /** when 表达式：控制命令面板中的显隐（首版支持 'false' 即隐藏，其余字符串恒真） */
  when?: string
}

/** 主题贡献点（manifest 声明）：主题扩展声明一组 CSS 变量 token */
export interface ThemeContribution {
  /** 主题 id（全局唯一，建议 `<扩展名>.<主题名>`，如 `theme-dark.dark`） */
  id: string
  /** 显示名（如 "深色"/"Dark"） */
  label: string
  /** CSS 变量 token 组：`--bg` → 值 */
  tokens: Record<string, string>
}

/** 设置字段类型（扩展设置页字段） */
export type SettingFieldType = 'text' | 'number' | 'boolean' | 'select'

/** 设置字段定义（api.settings.register 或 manifest 声明） */
export interface SettingField {
  /** 字段 key（设置存储中的键，建议含扩展前缀） */
  key: string
  /** 字段显示名 */
  label: string
  /** 字段类型 */
  type: SettingFieldType
  /** 默认值 */
  default?: unknown
  /** select 类型的选项 [{ value, label }] */
  options?: Array<{ value: string; label: string }>
  /** 字段描述（可选） */
  description?: string
}

/** 设置页贡献（api.settings.register） */
export interface SettingsPage {
  /** 设置页 id（建议含扩展前缀） */
  id: string
  /** 设置页标题（设置左侧树"扩展"节点下显示） */
  title: string
  /** 字段列表 */
  fields: SettingField[]
}

/** manifest 的贡献点声明 */
export interface ContributionManifest {
  navItems?: NavItemContribution[]
  statusBarItems?: StatusBarItemContribution[]
  commands?: CommandContribution[]
  themes?: ThemeContribution[]
  /** 扩展语言包：{ localeCode: { key: text } } */
  i18n?: Record<string, Record<string, string>>
  /** 扩展设置 schema（对齐 VS Code contributes.configuration 简化版） */
  settings?: SettingsPage
}

/** 扩展 manifest（package.json 的 obox 扩展声明） */
export interface ExtensionManifest {
  /** 扩展 id（必填，全局唯一） */
  name: string
  /** 版本号（必填，semver） */
  version: string
  /** 显示名（扩展管理器展示） */
  displayName?: string
  /** 作者 */
  author?: string
  /** 简介 */
  description?: string
  /** 扩展入口文件（相对扩展目录，如 ./index.ts），必填 */
  main: string
  /** 依赖的其他扩展 id 列表 */
  extensionDependencies?: string[]
  /** 卸载钩子脚本（相对扩展目录），卸载时先执行再删目录 */
  uninstall?: string
  /** 贡献点声明 */
  contributes?: ContributionManifest
}

/** 校验消息级别 */
export type ValidationSeverity = 'error' | 'warning' | 'info'

/** 校验消息 */
export interface ValidationMessage {
  severity: ValidationSeverity
  message: string
}

/** 扩展来源 */
export type ExtensionSource = 'builtin' | 'user'

/** 扩展运行时状态 */
export interface ExtensionInfo {
  /** 扩展 id */
  id: string
  /** manifest 原文 */
  manifest: ExtensionManifest
  /** 来源：内置（resources）/ 用户（userData） */
  source: ExtensionSource
  /** 是否通过校验（未通过则不加载，但出现在管理列表标红） */
  isValid: boolean
  /** 校验/错误消息 */
  validations: ValidationMessage[]
  /** 是否启用（不在禁用列表即启用，缺省即启用模型） */
  enabled: boolean
  /** 是否已激活 */
  isActive: boolean
  /** 激活失败的错误（若有） */
  activationError?: string
  /** 是否需重启生效（状态刚变更，尚未重启） */
  requiresRestart?: boolean
  /** 安装时间戳（用户扩展） */
  installedTimestamp?: number
}

/** 扩展上下文（扩展 apply(ctx) 中可用的宿主能力） */
export interface ExtensionContextLike {
  /** 扩展 id */
  extensionId: string
  /** 扩展目录的绝对路径（经 app:// 访问） */
  extensionUri: string
  /** 扩展 mode */
  extensionMode: 'production' | 'development'
  /** 统一清理：所有注册必须 push 进这里，停用时统一 dispose */
  subscriptions: Disposable[]
}

/** Disposable 统一清理形状 */
export interface Disposable {
  dispose(): void
}

/** 由扩展模块具名导出的视图组件表：view id → Vue 组件 */
export type ExtensionViews = Record<string, Component>

/** 扩展模块契约 */
export interface ExtensionModule {
  /** Cordis 插件函数（宿主以 apply(ctx) 调用） */
  default?: (ctx: unknown) => void | (() => void)
  /** 具名导出的视图组件（key = 导航项 contribution 的 view id） */
  [viewId: string]: unknown
}

/** 插件卡片注册项（扩展经 api.app.register 注册进 App） */
export interface AppRegistration {
  /** 唯一 id（建议含扩展名前缀，如 `my-ext.calculator`） */
  id: string
  /** 显示名称（卡片标题 + 子窗口标题） */
  name: string
  /** 版本号 */
  version: string
  /** 作者 */
  author?: string
  /** 简介 */
  description?: string
  /** 图标：SVG 字符串（data URI）或图片 URL */
  icon: string
  /** 子窗口内容 URL（优先）；与 html 二选一或都提供（url 优先） */
  url?: string
  /** 子窗口内容 HTML（url 缺失时用 srcdoc 渲染） */
  html?: string
  /** 是否允许多开：false 重复点击聚焦已有窗口；true 每次点击新建 */
  multiOpen?: boolean
  /** 子窗口宽度（默认 900） */
  width?: number
  /** 子窗口高度（默认 640） */
  height?: number
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
}

/** Memento：JSON 值键值存储 */
export interface Memento {
  keys(): string[]
  get<T = unknown>(key: string): T | undefined
  get<T = unknown>(key: string, defaultValue: T): T
  update(key: string, value: unknown): Promise<void>
}
