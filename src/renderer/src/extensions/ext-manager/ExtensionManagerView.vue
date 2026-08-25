<script setup lang="ts">
/**
 * 扩展管理器视图：Grid 网格展示扩展（名称/版本/作者/简介），
 * 点击查看详情（含 Installation 区块），支持禁用/卸载、搜索、排序、来源标注。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExtensionInfo } from '../../core/types'
import { host } from '../../core/host'

const { t } = useI18n()

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
/** 需要重启才能生效的操作提示（禁用/卸载已激活扩展时出现） */
const restartPrompt = ref('')

const extensions = computed(() => host.listExtensions())

/** 是否显示内置扩展（默认隐藏，对齐 VS Code：扩展列表默认排除 built-in） */
const showBuiltin = ref(false)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  let list = extensions.value
  // 默认只显示用户扩展；开启"显示内置"后包含内置扩展
  if (!showBuiltin.value) {
    list = list.filter((e) => e.source !== 'builtin')
  }
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
  setTimeout(() => (notice.value = ''), 5000)
}

/** 立即重启渲染进程（VS Code Reload Window 语义） */
function reloadWindow(): void {
  window.location.reload()
}

async function toggleEnabled(ext: ExtensionInfo): Promise<void> {
  busyId.value = ext.id
  try {
    const { hot, needsRestart } = host.setEnabled(ext.id, !ext.enabled)
    refreshTick.value++
    const action = ext.enabled ? t('extManager.actions.disable') : t('extManager.actions.enable')
    if (hot) {
      showNotice(t('extManager.notices.toggledHot', { action }))
    } else if (needsRestart) {
      showNotice(t('extManager.notices.toggledRestart', { action }))
      restartPrompt.value = t('extManager.notices.toggledRestart', { action })
    }
  } finally {
    busyId.value = null
  }
}

async function doUninstall(): Promise<void> {
  if (!confirmUninstall.value) return
  const ext = confirmUninstall.value
  busyId.value = ext.id
  try {
    const { hot, needsRestart } = await host.uninstall(ext.id)
    selected.value = null
    refreshTick.value++
    if (hot) {
      showNotice(t('extManager.notices.uninstalledHot'))
    } else if (needsRestart) {
      showNotice(t('extManager.notices.uninstalledRestart'))
      restartPrompt.value = t('extManager.notices.uninstalledRestart')
    }
  } catch (err) {
    showNotice(
      t('extManager.notices.installFailed', {
        msg: err instanceof Error ? err.message : String(err)
      })
    )
  } finally {
    confirmUninstall.value = null
    busyId.value = null
  }
}

/** 安装 .oix 包：成功后热加载（立即显示 + 立即激活，无需重启） */
async function installFromPath(filePath: string): Promise<boolean> {
  installBusy.value = true
  try {
    const result = await window.api.installUserExtensionFromPath(filePath)
    if (result) {
      await hotInstall(result)
      return true
    }
    return false
  } catch (err) {
    showNotice(
      t('extManager.notices.installFailed', {
        msg: err instanceof Error ? err.message : String(err)
      })
    )
    return false
  } finally {
    installBusy.value = false
  }
}

/** 安装成功后的热加载：构造条目 → 宿主增量加载 → 即时显示 */
async function hotInstall(result: {
  id: string
  name: string
  displayName?: string
  version: string
}): Promise<void> {
  const { buildUserExtensionEntry } = await import('../../core/loader')
  const entry = await buildUserExtensionEntry(result.id)
  if (!entry) {
    showNotice(
      `「${result.displayName ?? result.name}」v${result.version} ${t('extManager.invalidManifest')}`
    )
    refreshTick.value++
    return
  }
  const info = await host.loadUserExtension(entry)
  refreshTick.value++
  const name = info.manifest.displayName ?? info.id
  if (info.isActive) {
    showNotice(t('extManager.notices.installed', { name, version: info.manifest.version }))
  } else {
    showNotice(
      `「${name}」${info.activationError ? t('extManager.states.activationFailed') + ': ' + info.activationError : t('extManager.invalidManifest')}`
    )
  }
}

/** 工具栏按钮：文件对话框选 .oix 安装 */
async function installViaDialog(): Promise<void> {
  installBusy.value = true
  try {
    const result = await window.api.installUserExtensionViaDialog()
    if (result) {
      await hotInstall(result)
    }
  } catch (err) {
    showNotice(
      t('extManager.notices.installFailed', {
        msg: err instanceof Error ? err.message : String(err)
      })
    )
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
    showNotice(t('extManager.notices.dragOnlyOix'))
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

const sourceLabel = (s: string): string =>
  s === 'builtin' ? t('common.builtin') : s === 'debug' ? t('common.debug') : t('common.user')
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
        {{ installBusy ? t('extManager.installing') : t('extManager.installBtn') }}
      </button>
      <button v-if="restartPrompt" class="btn restart" @click="reloadWindow">
        {{ t('common.restart') }}
      </button>
      <label class="toggle-builtin">
        <input v-model="showBuiltin" type="checkbox" />
        {{ t('extManager.showBuiltin') }}
      </label>
      <input v-model="query" class="search" :placeholder="t('extManager.searchPlaceholder')" />
      <select v-model="sortKey" class="sort">
        <option value="name">{{ t('extManager.sortName') }}</option>
        <option value="installed">{{ t('extManager.sortInstalled') }}</option>
      </select>
      <span class="count">{{ filtered.length }} {{ t('extManager.count') }}</span>
      <span v-if="notice" class="notice">{{ notice }}</span>
    </div>
    <div v-if="dragActive" class="drop-hint">{{ t('extManager.dropHint') }}</div>

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
          <span v-if="ext.source === 'builtin'" class="badge builtin">
            {{ t('common.builtin') }}
          </span>
          <span v-else-if="ext.source === 'debug'" class="badge debug">
            {{ t('common.debug') }}
          </span>
          <span v-if="!ext.enabled" class="badge disabled">{{ t('common.disabled') }}</span>
        </div>
        <div class="card-author">{{ ext.manifest.author ?? t('extManager.unknownAuthor') }}</div>
        <div class="card-desc">{{ ext.manifest.description ?? t('extManager.noDescription') }}</div>
        <div v-if="!ext.isValid" class="card-error">
          {{ t('extManager.invalidManifest') }}（{{ ext.validations.length }}）
        </div>
      </div>
      <div v-if="filtered.length === 0" class="empty">{{ t('common.empty') }}</div>
    </div>

    <!-- 详情 -->
    <div v-else class="detail">
      <button class="back" @click="selected = null">{{ t('extManager.back') }}</button>
      <div class="detail-header">
        <h2>{{ selected.manifest.displayName ?? selected.id }}</h2>
        <span class="detail-version">{{ selected.manifest.version }}</span>
        <span v-if="selected.source === 'builtin'" class="badge builtin">
          {{ t('common.builtin') }}
        </span>
      </div>
      <dl class="detail-fields">
        <dt>{{ t('extManager.fields.author') }}</dt>
        <dd>{{ selected.manifest.author ?? t('extManager.unknownAuthor') }}</dd>
        <dt>{{ t('extManager.fields.description') }}</dt>
        <dd>{{ selected.manifest.description ?? t('extManager.noDescription') }}</dd>
        <dt>{{ t('extManager.fields.identifier') }}</dt>
        <dd>{{ selected.id }}</dd>
        <dt>{{ t('extManager.fields.source') }}</dt>
        <dd>{{ sourceLabel(selected.source) }}</dd>
        <dt>{{ t('extManager.fields.lastUpdated') }}</dt>
        <dd>
          {{
            selected.installedTimestamp
              ? new Date(selected.installedTimestamp).toLocaleString()
              : '—'
          }}
        </dd>
        <dt>{{ t('extManager.fields.dependencies') }}</dt>
        <dd>{{ selected.manifest.extensionDependencies?.join(', ') ?? '—' }}</dd>
        <dt>{{ t('extManager.fields.status') }}</dt>
        <dd>
          <span v-if="selected.activationError" class="state-error"
            >{{ t('extManager.states.activationFailed') }}: {{ selected.activationError }}</span
          >
          <span v-else-if="!selected.isValid" class="state-error">{{
            t('extManager.states.invalidManifest')
          }}</span>
          <span v-else-if="selected.requiresRestart" class="state-warn">{{
            t('extManager.states.pendingRestart')
          }}</span>
          <span v-else-if="selected.isActive">{{ t('extManager.states.running') }}</span>
          <span v-else-if="!selected.enabled">{{ t('extManager.states.disabled') }}</span>
          <span v-else>{{ t('extManager.states.enabled') }}</span>
        </dd>
      </dl>

      <div v-if="selected.validations.length" class="validations">
        <h3>{{ t('extManager.validations') }}</h3>
        <ul>
          <li v-for="(v, i) in selected.validations" :key="i" :class="v.severity">
            {{ v.message }}
          </li>
        </ul>
      </div>

      <div class="detail-actions">
        <button
          v-if="selected.source !== 'debug'"
          class="btn"
          :disabled="busyId === selected.id"
          @click="toggleEnabled(selected)"
        >
          {{ selected.enabled ? t('extManager.actions.disable') : t('extManager.actions.enable') }}
        </button>
        <button
          v-if="selected.source !== 'builtin' && selected.source !== 'debug'"
          class="btn danger"
          :disabled="busyId === selected.id"
          @click="confirmUninstall = selected"
        >
          {{ t('extManager.actions.uninstall') }}
        </button>
      </div>
    </div>

    <!-- 卸载确认 -->
    <Teleport to="body">
      <div v-if="confirmUninstall" class="confirm-overlay" @click.self="confirmUninstall = null">
        <div class="confirm-box">
          <h3>{{ t('extManager.uninstallConfirm.title') }}</h3>
          <p>
            {{
              t('extManager.uninstallConfirm.body', {
                name: confirmUninstall.manifest.displayName ?? confirmUninstall.id
              })
            }}
          </p>
          <div class="confirm-actions">
            <button class="btn" @click="confirmUninstall = null">{{ t('common.cancel') }}</button>
            <button class="btn danger" :disabled="busyId !== null" @click="doUninstall">
              {{ t('extManager.uninstallConfirm.uninstall') }}
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
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  color: var(--fg, #cccccc);
  padding: 4px 8px;
  font-size: 13px;
  outline: none;
}
.sort {
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  color: var(--fg, #cccccc);
  font-size: 13px;
  padding: 4px;
}
.count {
  color: var(--fg-dim, #6e6e6e);
  font-size: 12px;
}
.notice {
  color: var(--fg-success, #4ec9b0);
  font-size: 12px;
  margin-left: auto;
}
.ext-manager.drag-active {
  outline: 2px dashed var(--accent, #007acc);
  outline-offset: -6px;
}
.drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 90, 160, 0.25);
  color: var(--fg-link, #75beff);
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
.btn.restart {
  background: #613d00;
  border-color: #8a5400;
  color: #ffcc66;
}
.btn.restart:hover {
  background: #7a4d00;
}
.toggle-builtin {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--fg-dim, #9d9d9d);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.toggle-builtin input {
  accent-color: var(--accent, #007acc);
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
  background: var(--bg-panel, #252526);
  border: 1px solid var(--border, #3c3c3c);
  border-radius: 4px;
  padding: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease-out;
}
.card:hover {
  border-color: var(--accent, #007acc);
}
.card.disabled {
  opacity: 0.5;
}
.card.invalid {
  border-color: var(--fg-error, #a1260d);
}
.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.card-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg-bright, #e8e8e8);
}
.card-version {
  font-size: 11px;
  color: var(--fg-dim, #6e6e6e);
}
.card-author {
  font-size: 12px;
  color: var(--fg-dim, #9d9d9d);
  margin-top: 4px;
}
.card-desc {
  font-size: 12px;
  color: var(--fg, #cccccc);
  margin-top: 6px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-error {
  color: var(--fg-error, #f48771);
  font-size: 11px;
  margin-top: 6px;
}
.empty {
  color: var(--fg-dim, #6e6e6e);
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
.badge.debug {
  background: #8a5d2d;
  color: #ffffff;
}
.badge.disabled {
  background: #5a5a5a;
  color: var(--fg, #cccccc);
}
.detail {
  flex: 1;
  overflow-y: auto;
}
.back {
  background: transparent;
  border: none;
  color: var(--accent, #007acc);
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
  color: var(--fg-bright, #e8e8e8);
}
.detail-version {
  color: var(--fg-dim, #6e6e6e);
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
  color: var(--fg-dim, #9d9d9d);
}
.detail-fields dd {
  margin: 0;
  color: var(--fg, #cccccc);
}
.state-error {
  color: var(--fg-error, #f48771);
}
.state-warn {
  color: var(--fg-warning, #cca700);
}
.validations {
  margin: 16px 0;
}
.validations h3 {
  font-size: 13px;
  color: var(--fg-dim, #9d9d9d);
  margin: 0 0 8px;
}
.validations ul {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
}
.validations .error {
  color: var(--fg-error, #f48771);
}
.validations .warning {
  color: var(--fg-warning, #cca700);
}
.validations .info {
  color: var(--fg-link, #75beff);
}
.detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.btn {
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  color: var(--fg, #cccccc);
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 2px;
}
.btn:hover {
  background: var(--hover-bg, #454545);
}
.btn.danger {
  background: #5a1d1d;
  border-color: #7a2a2a;
  color: var(--fg-error, #f48771);
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
  background: var(--bg-panel, #252526);
  border: 1px solid var(--border, #454545);
  padding: 20px;
  width: 380px;
  border-radius: 4px;
}
.confirm-box h3 {
  margin: 0 0 12px;
  color: var(--fg-bright, #e8e8e8);
  font-size: 15px;
}
.confirm-box p {
  color: var(--fg, #cccccc);
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
