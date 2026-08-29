/**
 * 树视图数据源注册表（渲染侧）：view id → TreeViewProvider。
 * 扩展经 api.views.registerTreeProvider(viewId, provider) 注册；
 * TreeView 组件按当前导航项（view id）取 provider 渲染。
 */
import type { TreeItem, TreeViewProvider } from '../../../api'

const providers = new Map<string, TreeViewProvider>()

export const treeStore = {
  registerTreeProvider(viewId: string, provider: TreeViewProvider): () => void {
    providers.set(viewId, provider)
    return () => {
      providers.delete(viewId)
    }
  },

  getProvider(viewId: string): TreeViewProvider | undefined {
    return providers.get(viewId)
  }
}

export type { TreeItem }
