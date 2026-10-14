import type { IpcChannelDeclaration } from './shared'
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

/**
 * 设置字段类型（扩展设置页字段）。
 *
 * - `text` / `number` / `boolean` / `select`：基础控件（`select` 需要 `options`）。
 * - `directory`：目录选择控件 = **只读文本框（`readonly`）+ 「浏览…」按钮**（**点输入框或按钮都弹**系统目录选择器，按钮保留作键盘可达）；路径不支持手工输入/粘贴，选目录是主要输入方式。
 *   值的语义是**绝对路径字符串**；空串 `/ undefined` = 未选择，**由扩展自行决定默认目录**。
 *   宿主只负责"弹出选择器 + 把选中的绝对路径写回设置"，**不校验**该目录是否存在、是否可写、
 *   是否受扩展管理——这些约束由扩展侧在读取值时自行校验（老宿主见下）。
 * - `status`：**只读**状态展示——宿主**不提供任何编辑控件**（无输入框、无按钮）。
 *   展示的值就是该字段 `key` 在当前设置里的值（统一设置存储 `stateStore.settings`，
 *   非字符串值按 `String(value)` 展示），**由扩展用 `api.settings.set(key, value)` 写入**，
 *   宿主只负责渲染。值里含 `\n` 时按行渲染为列表（多行进度/明细）；空值渲染占位文案。
 *   `default` 仅在设置里没有该键时作为回退展示值。
 *   `status` 字段再带上 `modal: true`（见 `SettingField.modal`）时，值非空即在设置页渲染成
 *   一个**不可关闭的等待模态框**（迁移进度这类"没完之前不许操作"的场景），值被清空即消失。
 * - **未知类型**：宿主按 `text` 兜底渲染（可编辑、可保存）并 `console.warn`，
 *   避免宿主类型演进时设置项"凭空消失"。
 *
 * 兼容性：`directory` / `status` 是本仓库**新增**类型；不认识它们的老宿主（≤ v1.0.8）在字段渲染链
 * 末尾**没有兜底分支**（`v-if / v-else-if` 到 `select` 即止），因此该字段**不渲染任何控件**
 * （label 仍在，控件为空）。扩展若要在老宿主上也有可用输入，需自行降级为 `text`；
 * 对 `status`，认识它但未实现该分支的**前一版新版宿主**会走兜底 `text`（可编辑框，
 * 值仍取自同一设置存储，用户误编辑会覆盖扩展写的状态）——见 `docs/extension-api/themes-settings.md`。
 */
export type SettingFieldType = 'text' | 'number' | 'boolean' | 'select' | 'directory' | 'status'

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
  /**
   * 「等待模态框」开关（**可选**，只对 `type: 'status'` 有意义；值仍是字符串）。
   *
   * - `true` ⇒ 值**非空**时在设置页渲染一个**全屏遮罩 + 对话框**，把值按行显示（如迁移进度文本）；
   *   值**空**（未设置 / 空串 / 全空白）⇒ **不渲染任何东西**（模态框消失）。
   * - **不可关闭**：没有关闭按钮、`Esc` 无效、点击遮罩不关闭；遮罩同时挡住背景的滚动与交互
   *   （`role="dialog"` + `aria-modal="true"` + 初始聚焦对话框）。扩展**必须**在任务结束时用
   *   `api.settings.set(key, '')` 清空该值，模态框才会消失。
   * - 显示判据只取**设置存储里的值**，**不**回退 `default`：`default` 非空会让模态框在扩展
   *   还没开始任务时就常驻且无法关闭。该字段建议写 `default: ''`。
   * - **老宿主忽略它**：`modal` 是新增的**可选**属性，老宿主的字段链不认识、也不会读它——
   *   老宿主只按 `type: 'status'` 渲染（≤ v1.0.8 连 `status` 都不认识 ⇒ 该字段不渲染任何控件），
   *   因此**不会崩溃、不会报错**，只是**不弹模态框**（降级 = 只读状态文本 / 空内容）。
   */
  modal?: boolean
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

/** 快捷键贡献（manifest 声明）：把已声明命令绑定默认组合键 */
export interface KeybindingContribution {
  /** 命令 id（必须在 contributes.commands 声明） */
  command: string
  /** 组合键字符串（如 Ctrl+Shift+K） */
  key: string
}

/** 上下文菜单贡献（manifest 声明）：命令挂到该扩展 App 卡片的右键菜单 */
export interface MenuContribution {
  /** 命令 id（必须在 contributes.commands 声明） */
  command: string
  /** 显隐条件（首版仅 'false' 即隐藏，其余恒真） */
  when?: string
}

/** 树视图贡献（manifest 声明）：在导航区贡献树形视图（数据源由 api.views.registerTreeProvider 提供） */
export interface ViewContribution {
  /** 视图 id（全局唯一，建议含扩展前缀；数据源注册用同一 id） */
  id: string
  /** 显示名（导航图标 tooltip / 内容区标题） */
  title: string
  /** 图标（SVG 字符串） */
  icon: string
  /** 导航分组：top（可排序业务导航，默认）/ bottom（固定全局区） */
  group?: 'top' | 'bottom'
}

/** manifest 的贡献点声明 */
export interface ContributionManifest {
  /**
   * 静态声明的 IPC 通道（issue #45）：声明一次，代码里只写 `api.ipc.connect('<通道id>')`。
   * 与运行时声明**同一套校验**（src/shared/ipcDeclaration.ts）：非法声明会让**清单无效**
   * （扩展标红 + 明确错误），而不是等到 connect() 才炸。声明本身**不自动连接**。
   */

  ipcChannels?: IpcChannelDeclaration[]
  navItems?: NavItemContribution[]
  statusBarItems?: StatusBarItemContribution[]
  commands?: CommandContribution[]
  themes?: ThemeContribution[]
  /** 扩展语言包：{ localeCode: { key: text } } */
  i18n?: Record<string, Record<string, string>>
  /** 扩展设置 schema（对齐 VS Code contributes.configuration 简化版） */
  settings?: SettingsPage
  /** 快捷键（复用宿主 keybindingStore：冲突检测/用户可改/设置页展示/持久化） */
  keybindings?: KeybindingContribution[]
  /** 上下文菜单（首版：该扩展 App 卡片的右键菜单） */
  menus?: MenuContribution[]
  /** 树视图（导航区树形视图；数据源经 api.views.registerTreeProvider 提供） */
  views?: ViewContribution[]
  /** 声明为"更新提供者扩展"：提供 obox 更新能力（设置-更新选择，只能一个生效） */
  updater?: {
    /** 更新源 URL 模板（可含 {version} 占位）；扩展激活时也可用 api.update 覆盖 */
    feedUrl?: string
  }
}
