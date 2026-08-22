/**
 * 扩展管理器内置扩展。
 * 入口：default 导出插件函数（宿主 apply），具名导出视图组件 ExtensionManagerView。
 */
import type { ExtensionActivationApi } from '../../core/types'
import ExtensionManagerView from './ExtensionManagerView.vue'

export { ExtensionManagerView }

export default function extManager(api: ExtensionActivationApi): () => void {
  // 注册命令实现（manifest 已声明）
  const refresh = api.registerCommand('ext-manager.refresh', () => {
    api.emit('ext-manager:refresh')
  })
  const disable = api.registerCommand('ext-manager.disable', (id: unknown) => {
    if (typeof id === 'string') api.emit('ext-manager:disable', id)
  })
  const enable = api.registerCommand('ext-manager.enable', (id: unknown) => {
    if (typeof id === 'string') api.emit('ext-manager:enable', id)
  })

  // 状态栏：显示已安装扩展数量（点击触发刷新命令）
  api.statusBar.setText('ext-manager.count', '扩展已就绪')
  api.statusBar.setTooltip('ext-manager.count', '点击刷新扩展列表')
  api.emit('ext-manager:refresh')

  return () => {
    refresh.dispose()
    disable.dispose()
    enable.dispose()
  }
}
