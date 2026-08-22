<script setup lang="ts">
/**
 * 扩展管理器视图：Grid 网格展示扩展（名称/版本/作者/简介），
 * 点击查看详情（含 Installation 区块），支持禁用/卸载、搜索、排序、来源标注。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ExtensionInfo } from '../../core/types'
import { host } from '../../core/host'

type SortKey = 'name' | 'installed'

const query = ref('')
const sortKey = ref<SortKey>('name')
const selected = ref<ExtensionInfo | null>(null)
const confirmUninstall = ref<ExtensionInfo | null>(null)
const busyId = ref<string | null>(null)
const notice = ref('')
const refreshTick = ref(0)
const installBusy = ref(false)
const dragActive = ref(false)

const extensions = computed(() => host.listExtensions())

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  let list = extensions.value
  if (q) {
    list = list.filter(
      (e) =>
        e.manifest.displayName?.toLowerCase().includes(q) ||
        e.manifest.name.toLowerCase().includes(q) ||
        e.manifest.author?.toLowerCase().includes(q)
    )
  }
  const sorted = [...list]
  if (sortKey.value === 'name') {
    sorted.sort((a, b) =>
      (a.manifest.displayName ?? a.id).localeCompare(b.manifest.displayName ?? b.id)
    )
  } else {
    sorted.sort((a, b) => (b.installedTimestamp ?? 0) - (a.installedTimestamp ?? 0))
  }
  return sorted
})

function showNotice(msg: string): void {
  notice.value = msg
  setTimeout(() => (notice.value = ''), 3000)
}

async function toggleEnabled(ext: ExtensionInfo): Promise<void> {
  busyId.value = ext.id
  try {
    host.setEnabled(ext.id, !ext.enabled)
    // 触发列表刷新 + 事件通知（宿主视图不销毁，直接更新）
    refreshTick.value++
    showNotice(
      `「${ext.manifest.displayName ?? ext.id}」已${ext.enabled ? '启用' : '禁用'}，重启后生效`
    )
  } finally {
    busyId.value = null
  }
}

async function doUninstall(): Promise<void> {
  if (!confirmUninstall.value) return
  const ext = confirmUninstall.value
  busyId.value = ext.id
  try {
    await host.uninstall(ext.id)
    selected.value = null
    showNotice(`「${ext.manifest.displayName ?? ext.id}」已卸载，重启后生效`)
  } catch (err) {
    showNotice(`卸载失败: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    confirmUninstall.value = null
    busyId.value = null
  }
}

/** 安装 .oix 包：成功后提示重启生效 */
async function installFromPath(filePath: string): Promise<boolean> {
  installBusy.value = true
  try {
    const result = await window.api.installUserExtensionFromPath(filePath)
    if (result) {
      showNotice(
        `「${result.displayName ?? result.name}」v${result.version} 安装成功${result.replaced ? '（已覆盖旧版）' : ''}，重启后生效`
      )
      refreshTick.value++
      return true
    }
    return false
  } catch (err) {
    showNotice(`安装失败: ${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    installBusy.value = false
  }
}

/** 工具栏按钮：文件对话框选 .oix 安装 */
async function installViaDialog(): Promise<void> {
  installBusy.value = true
  try {
    const result = await window.api.installUserExtensionViaDialog()
    if (result) {
      showNotice(
        `「${result.displayName ?? result.name}」v${result.version} 安装成功${result.replaced ? '（已覆盖旧版）' : ''}，重启后生效`
      )
      refreshTick.value++
    }
  } catch (err) {
    showNotice(`安装失败: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    installBusy.value = false
  }
}

/** 拖拽安装：接受 .oix 文件，经 webUtils 取路径后走同一安装流程 */
function onDragOver(e: DragEvent): void {
  e.preventDefault()
  dragActive.value = true
}

function onDragLeave(e: DragEvent): void {
  // 离开子元素时不算离开容器
  if (!(e.currentTarget as HTMLElement | null)?.contains(e.relatedTarget as Node | null)) {
    dragActive.value = false
  }
}

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  dragActive.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  const oixFiles = files.filter((f) => f.name.toLowerCase().endsWith('.oix'))
  if (oixFiles.length === 0) {
    showNotice('请拖入 .oix 扩展包文件')
    return
  }
  for (const file of oixFiles) {
    const path = window.api.getPathForFile(file)
    if (path) await installFromPath(path)
  }
}

function onEvent(...args: unknown[]): void {
  const name = args[0] as string
  const payload = args[1]
  if (name === 'ext-manager:refresh') refreshTick.value++
  if (name === 'ext-manager:disable' || name === 'ext-manager:enable') {
    const id = payload as string
    const ext = extensions.value.find((e) => e.id === id)
    if (ext) void toggleEnabled(ext)
  }
}

let offEvents: (() => void) | undefined

onMounted(() => {
  offEvents = (
    host.rootContext as unknown as {
      on(e: string, l: (...args: unknown[]) => void): () => void
    }
  ).on('ext-manager', onEvent)
})

onUnmounted(() => offEvents?.())

const sourceLabel = (s: string): string => (s === 'builtin' ? '内置' : '用户')
</script>

<template>
  <div
    class="ext-manager"
    :class="{ 'drag-active': dragActive }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="toolbar">
      <button class="btn install" :disabled="installBusy" @click="installViaDialog">
        {{ installBusy ? '安装中…' : '安装扩展' }}
      </button>
      <input v-model="query" class="search" placeholder="搜索扩展（名称/作者）…" />
      <select v-model="sortKey" class="sort">
        <option value="name">按名称</option>
        <option value="installed">按安装时间</option>
      </select>
      <span class="count">{{ filtered.length }} 个扩展</span>
      <span v-if="notice" class="notice">{{ notice }}</span>
    </div>
    <div v-if="dragActive" class="drop-hint">松开以安装 .oix 扩展包</div>

    <!-- Grid 网格 -->
    <div v-if="!selected" class="grid">
      <div
        v-for="ext in filtered"
        :key="ext.id"
        class="card"
        :class="{ invalid: !ext.isValid, disabled: !ext.enabled }"
        @click="selected = ext"
      >
        <div class="card-header">
          <span class="card-name">{{ ext.manifest.displayName ?? ext.id }}</span>
          <span class="card-version">{{ ext.manifest.version }}</span>
          <span v-if="ext.source === 'builtin'" class="badge builtin">内置</span>
          <span v-if="!ext.enabled" class="badge disabled">已禁用</span>
        </div>
        <div class="card-author">{{ ext.manifest.author ?? '未知作者' }}</div>
        <div class="card-desc">{{ ext.manifest.description ?? '暂无简介' }}</div>
        <div v-if="!ext.isValid" class="card-error">
          清单无效（{{ ext.validations.length }} 条错误）
        </div>
      </div>
      <div v-if="filtered.length === 0" class="empty">没有匹配的扩展</div>
    </div>

    <!-- 详情 -->
    <div v-else class="detail">
      <button class="back" @click="selected = null">← 返回列表</button>
      <div class="detail-header">
        <h2>{{ selected.manifest.displayName ?? selected.id }}</h2>
        <span class="detail-version">{{ selected.manifest.version }}</span>
        <span v-if="selected.source === 'builtin'" class="badge builtin">Built-in</span>
      </div>
      <dl class="detail-fields">
        <dt>作者</dt>
        <dd>{{ selected.manifest.author ?? '未知' }}</dd>
        <dt>简介</dt>
        <dd>{{ selected.manifest.description ?? '暂无' }}</dd>
        <dt>Identifier</dt>
        <dd>{{ selected.id }}</dd>
        <dt>Source</dt>
        <dd>{{ sourceLabel(selected.source) }}</dd>
        <dt>Last Updated</dt>
        <dd>
          {{
            selected.installedTimestamp
              ? new Date(selected.installedTimestamp).toLocaleString()
              : '—'
          }}
        </dd>
        <dt>依赖</dt>
        <dd>{{ selected.manifest.extensionDependencies?.join(', ') ?? '无' }}</dd>
        <dt>状态</dt>
        <dd>
          <span v-if="selected.activationError" class="state-error"
            >激活失败: {{ selected.activationError }}</span
          >
          <span v-else-if="!selected.isValid" class="state-error">清单无效</span>
          <span v-else-if="selected.requiresRestart" class="state-warn">变更待重启生效</span>
          <span v-else-if="selected.isActive">运行中</span>
          <span v-else-if="!selected.enabled">已禁用</span>
          <span v-else>已启用</span>
        </dd>
      </dl>

      <div v-if="selected.validations.length" class="validations">
        <h3>校验信息</h3>
        <ul>
          <li v-for="(v, i) in selected.validations" :key="i" :class="v.severity">
            {{ v.message }}
          </li>
        </ul>
      </div>

      <div class="detail-actions">
        <button class="btn" :disabled="busyId === selected.id" @click="toggleEnabled(selected)">
          {{ selected.enabled ? '禁用' : '启用' }}
        </button>
        <button
          v-if="selected.source !== 'builtin'"
          class="btn danger"
          :disabled="busyId === selected.id"
          @click="confirmUninstall = selected"
        >
          卸载
        </button>
      </div>
    </div>

    <!-- 卸载确认 -->
    <Teleport to="body">
      <div v-if="confirmUninstall" class="confirm-overlay" @click.self="confirmUninstall = null">
        <div class="confirm-box">
          <h3>确认卸载</h3>
          <p>
            确定要卸载「{{ confirmUninstall.manifest.displayName ?? confirmUninstall.id }}」吗？
            将删除其目录，重启后生效，此操作不可恢复。
          </p>
          <div class="confirm-actions">
            <button class="btn" @click="confirmUninstall = null">取消</button>
            <button class="btn danger" :disabled="busyId !== null" @click="doUninstall">
              确认卸载
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ext-manager {
  position: relative;
  padding: 16px;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.search {
  flex: 1;
  max-width: 320px;
  background: #3c3c3c;
  border: 1px solid #454545;
  color: #cccccc;
  padding: 4px 8px;
  font-size: 13px;
  outline: none;
}
.sort {
  background: #3c3c3c;
  border: 1px solid #454545;
  color: #cccccc;
  font-size: 13px;
  padding: 4px;
}
.count {
  color: #6e6e6e;
  font-size: 12px;
}
.notice {
  color: #4ec9b0;
  font-size: 12px;
  margin-left: auto;
}
.ext-manager.drag-active {
  outline: 2px dashed #007acc;
  outline-offset: -6px;
}
.drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 90, 160, 0.25);
  color: #75beff;
  font-size: 15px;
  pointer-events: none;
  z-index: 10;
}
.btn.install {
  background: #0e639c;
  border-color: #1177bb;
  color: #ffffff;
}
.btn.install:hover {
  background: #1177bb;
}
.grid {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  overflow-y: auto;
  align-content: start;
}
.card {
  background: #252526;
  border: 1px solid #3c3c3c;
  border-radius: 4px;
  padding: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease-out;
}
.card:hover {
  border-color: #007acc;
}
.card.disabled {
  opacity: 0.5;
}
.card.invalid {
  border-color: #a1260d;
}
.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.card-name {
  font-size: 14px;
  font-weight: 600;
  color: #e8e8e8;
}
.card-version {
  font-size: 11px;
  color: #6e6e6e;
}
.card-author {
  font-size: 12px;
  color: #9d9d9d;
  margin-top: 4px;
}
.card-desc {
  font-size: 12px;
  color: #cccccc;
  margin-top: 6px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-error {
  color: #f48771;
  font-size: 11px;
  margin-top: 6px;
}
.empty {
  color: #6e6e6e;
  font-size: 13px;
  padding: 24px;
  text-align: center;
}
.badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  margin-left: 4px;
}
.badge.builtin {
  background: #2d5d8b;
  color: #ffffff;
}
.badge.disabled {
  background: #5a5a5a;
  color: #cccccc;
}
.detail {
  flex: 1;
  overflow-y: auto;
}
.back {
  background: transparent;
  border: none;
  color: #007acc;
  cursor: pointer;
  font-size: 13px;
  padding: 0 0 8px;
}
.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-header h2 {
  margin: 0;
  font-size: 20px;
  color: #e8e8e8;
}
.detail-version {
  color: #6e6e6e;
  font-size: 13px;
}
.detail-fields {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 8px;
  margin: 16px 0;
  font-size: 13px;
}
.detail-fields dt {
  color: #9d9d9d;
}
.detail-fields dd {
  margin: 0;
  color: #cccccc;
}
.state-error {
  color: #f48771;
}
.state-warn {
  color: #cca700;
}
.validations {
  margin: 16px 0;
}
.validations h3 {
  font-size: 13px;
  color: #9d9d9d;
  margin: 0 0 8px;
}
.validations ul {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
}
.validations .error {
  color: #f48771;
}
.validations .warning {
  color: #cca700;
}
.validations .info {
  color: #75beff;
}
.detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.btn {
  background: #3c3c3c;
  border: 1px solid #454545;
  color: #cccccc;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 2px;
}
.btn:hover {
  background: #454545;
}
.btn.danger {
  background: #5a1d1d;
  border-color: #7a2a2a;
  color: #f48771;
}
.btn.danger:hover {
  background: #6e2424;
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 6000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.confirm-box {
  background: #252526;
  border: 1px solid #454545;
  padding: 20px;
  width: 380px;
  border-radius: 4px;
}
.confirm-box h3 {
  margin: 0 0 12px;
  color: #e8e8e8;
  font-size: 15px;
}
.confirm-box p {
  color: #cccccc;
  font-size: 13px;
  line-height: 1.6;
  margin: 0 0 16px;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
