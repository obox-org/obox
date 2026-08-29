/**
 * 树节点（TreeView 的递归子组件）：展开/收起加载子节点，点击执行命令。
 * 用 h() 渲染（递归），样式类定义在 TreeView.vue 的全局 <style> 块。
 */
import { defineComponent, h, ref, watch } from 'vue'
import { treeStore } from '../core/treeStore'
import type { TreeItem } from '../../../api'

export const TreeNode = defineComponent({
  name: 'TreeNode',
  props: {
    node: { type: Object as () => TreeItem, required: true },
    providerViewId: { type: String, required: true }
  },
  emits: ['run'],
  setup(props, { emit }) {
    const expanded = ref(false)
    const children = ref<TreeItem[]>([])
    const loaded = ref(false)
    const loading = ref(false)

    async function toggle(): Promise<void> {
      if (!props.node.collapsible) return
      expanded.value = !expanded.value
      if (expanded.value && !loaded.value) {
        loading.value = true
        try {
          const provider = treeStore.getProvider(props.providerViewId)
          children.value = (await provider?.getChildren(props.node)) ?? []
          loaded.value = true
        } finally {
          loading.value = false
        }
      }
    }

    watch(
      () => props.providerViewId,
      () => {
        expanded.value = false
        loaded.value = false
        children.value = []
      }
    )

    return () =>
      h('li', { class: 'tree-node' }, [
        h(
          'div',
          {
            class: ['tree-row', { expandable: props.node.collapsible }],
            onClick: () => {
              if (props.node.collapsible) void toggle()
              else emit('run', props.node)
            }
          },
          [
            h('span', {
              class: ['tree-twisty', { open: expanded.value }],
              innerHTML: props.node.collapsible ? '▸' : ''
            }),
            props.node.icon
              ? h('span', {
                  class: 'tree-icon',
                  innerHTML: props.node.icon
                })
              : null,
            h('span', { class: 'tree-label' }, props.node.label)
          ]
        ),
        expanded.value && loading.value ? h('div', { class: 'tree-loading' }, '…') : null,
        expanded.value && children.value.length > 0
          ? h(
              'ul',
              { class: 'tree-children' },
              children.value.map((child) =>
                h(TreeNode, {
                  node: child,
                  providerViewId: props.providerViewId,
                  onRun: (n: TreeItem) => emit('run', n)
                })
              )
            )
          : null
      ])
  }
})

export default TreeNode
