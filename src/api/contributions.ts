/**
 * 扩展贡献点类型（面向扩展作者；扩展经相对路径导入 src/api）。
 * 贡献点由扩展在 manifest 的 contributes 中声明，宿主解析注册。
 * 由 src/api/index.ts 聚合导出。
 */

/** 导航栏分组：top = 可排序业务导航；bottom = 固定全局区（不参与排序） */
export type NavGroup = 'top' | 'bottom'

/** 导航项贡献点（manifest 声明） */
export interface NavItemContribution {
  /** 唯一 id（建议含扩展名前缀，如 `ext-manager.home`） */
  id: string
  /** 显示名称（hover tooltip 显示） */
  title: string
  /** 语言包 key（可选）：存在时 tooltip/状态栏用 t(titleKey) 本地化，否则用 title 原文 */
  titleKey?: string
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
  /** 声明为"更新提供者扩展"：提供 obox 更新能力（设置-更新选择，只能一个生效） */
  updater?: {
    /** 更新源 URL 模板（可含 {version} 占位）；扩展激活时也可用 api.update 覆盖 */
    feedUrl?: string
  }
}
