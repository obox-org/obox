/**
 * App 注册类型（面向扩展作者；扩展经相对路径导入 src/api）。
 * 扩展经 api.app.register 把插件卡片注册进 App（应用）扩展。
 * 由 src/api/index.ts 聚合导出。
 */

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
  /** 子窗口任务栏图标：app:// 图标 URL（如 app://extensions/<id>/icon.png），主进程转磁盘路径设置 */
  iconUrl?: string
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
