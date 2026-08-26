/**
 * 扩展 API 类型（面向扩展作者）。
 * 扩展通过 manifest 声明贡献点，入口导出 Cordis 插件函数 + 具名导出视图组件。
 * 本目录类型由宿主导入（经 src/renderer/src/core/types.ts 再导出兼容），
 * 扩展经相对路径直接导入（如内置扩展入口 `import type { ... } from '../../../../api'`）。
 */
export * from './contributions'
export * from './manifest'
export * from './registration'
export * from './runtime'
export * from './shared'
export * from './types'
