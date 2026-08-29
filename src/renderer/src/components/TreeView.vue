<script setup lang="ts">
/**
 * 树视图（内置组件，view id = 'obox.tree'）：渲染 contributes.views 声明、
 * api.views.registerTreeProvider 提供数据的树形视图。
 */
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { registry } from '../core/registry'
import { treeStore } from '../core/treeStore'
import { host } from '../core/host'
import TreeNode from './TreeNode'
import type { TreeItem } from '../../../api'

const { t } = useI18n()

const props = defineProps<{
  activeNavId: string | null
}>()

/** 当前导航项（= contributes.views 声明的视图） */
const view = ref(registry.navItems.find((i) => i.id === props.activeNavId && i.active))
watch(
  () => props.activeNavId,
  (id) => {
    view.value = registry.navItems.find((i) => i.id === id && i.active)
    roots.value = []
    void loadRoots()
  }
)

const roots = ref<TreeItem[]>([])
const loading = ref(false)

async function loadRoots(): Promise<void> {
  if (!props.activeNavId) return
  const provider = treeStore.getProvider(props.activeNavId)
  if (!provider) {
    roots.value = []
    return
  }
  loading.value = true
  try {
    roots.value = (await provider.getChildren()) ?? []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadRoots()
})

/** 点击节点：执行其命令 */
function runNode(item: TreeItem): void {
  if (!item.command) return
  void host.executeCommand(item.command, ...(item.args ?? [])).catch((err) =>
    console.error('[tree]', item.command, err)
  )
}
</script>

<template>
  <div class="tree-view">
    <h2 v-if="view" class="tree-title">
      {{ view.titleKey ? t(view.titleKey) : view.title }}
    </h2>
    <p v-if="loading" class="tree-hint">加载中…</p>
    <ul v-else class="tree-list">
      <TreeNode
        v-for="node in roots"
        :key="node.id"
        :node="node"
        :provider-view-id="props.activeNavId ?? ''"
        @run="runNode"
      />
      <li v-if="!loading && roots.length === 0" class="tree-empty">
        {{ t('content.empty') }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.tree-view {
  padding: 12px 16px;
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
}
.tree-title {
  font-size: 14px;
  margin: 0 0 10px;
  color: var(--fg-bright, #e8e8e8);
}
.tree-hint,
.tree-empty {
  color: var(--fg-dim, #6e6e6e);
  font-size: 13px;
}
.tree-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
</style>

<!-- TreeNode 用 h() 渲染，节点样式须为全局（非 scoped） -->
<style>
.tree-children {
  list-style: none;
  margin: 0;
  padding-left: 16px;
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border-radius: 3px;
  cursor: default;
  font-size: 13px;
  color: var(--fg, #cccccc);
}
.tree-row:hover {
  background: var(--hover-bg, #2a2d2e);
}
.tree-twisty {
  display: inline-block;
  width: 14px;
  text-align: center;
  font-size: 10px;
  color: var(--fg-dim, #9d9d9d);
  transition: transform 0.15s;
}
.tree-twisty.open {
  transform: rotate(90deg);
}
.tree-icon {
  display: inline-flex;
  width: 16px;
  height: 16px;
  color: var(--fg, #cccccc);
}
.tree-icon svg {
  width: 100%;
  height: 100%;
}
.tree-loading {
  padding: 2px 6px 2px 24px;
  color: var(--fg-dim, #6e6e6e);
  font-size: 12px;
}
</style>
