/**
 * 扩展 manifest 类型（面向扩展作者；扩展经相对路径导入 src/api）。
 * 扩展 manifest 是 package.json / manifest.json 中的 obox 扩展声明。
 * 由 src/api/index.ts 聚合导出。
 */
import type { ContributionManifest } from './contributions'

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
