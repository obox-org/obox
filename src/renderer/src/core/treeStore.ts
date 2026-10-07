/**
 * 树视图数据源注册表（渲染侧）：(扩展 id, view id) → TreeViewProvider。
 * 扩展经 api.views.registerTreeProvider(viewId, provider) 注册；
 * TreeView 组件按当前导航项（view id）取 provider 渲染。
 *
 * 键按扩展隔离：两个扩展注册同 viewId 时互不覆盖，且某个扩展热移除/覆盖安装时
 * 不会误删另一个扩展的 provider（旧实现用全局 viewId 键，后者注册会覆盖前者、
 * 先注册者的 dispose 又会删掉后注册者的 provider）。
 */
import type { TreeItem, TreeViewProvider } from '../../../api'

const providers = new Map<string, TreeViewProvider>()

function keyOf(extensionId: string, viewId: string): string {
  return `${extensionId}:${viewId}`
}

export const treeStore = {
  registerTreeProvider(
    viewId: string,
    provider: TreeViewProvider,
    extensionId: string
  ): () => void {
    const key = keyOf(extensionId, viewId)
    providers.set(key, provider)
    return () => {
      // 仅当仍指向自己时才删除：覆盖注册后旧的 dispose 不应误删新 provider
      if (providers.get(key) === provider) providers.delete(key)
    }
  },

  /**
   * 取 provider。视图组件只知道 viewId（不知道扩展 id），因此不传 extensionId 时
   * 按 viewId 后缀匹配，取**最后注册**的一个（与旧实现"后注册覆盖"语义一致）。
   */
  getProvider(viewId: string, extensionId?: string): TreeViewProvider | undefined {
    if (extensionId) return providers.get(keyOf(extensionId, viewId))
    let found: TreeViewProvider | undefined
    for (const [key, provider] of providers) {
      if (key.endsWith(`:${viewId}`)) found = provider
    }
    return found
  }
}

export type { TreeItem }
