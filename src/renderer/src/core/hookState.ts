/**
 * 兼容再导出：钩子状态判定的实现在 `src/shared/hookState.ts`（主进程与渲染进程共用同一套规则）。
 * 保留本文件是为了不动既有 import（核心/测试都从这里取）。
 */
export * from '../../../shared/hookState'
