/**
 * 扩展 API 类型（历史兼容入口，类型已迁移至 src/api/）。
 * 本文件仅再导出 src/api，保持仓库内现有 import 零改动；
 * 新代码应直接 import src/api（如扩展入口
 * `import type { ExtensionActivationApi } from '../../../../api'`）。
 */
export * from '../../../api'
