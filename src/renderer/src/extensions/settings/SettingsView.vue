<script setup lang="ts">
/**
 * 设置视图：左侧树（外观/语言/快捷键/扩展）+ 右侧配置表单。
 * - 外观：主题下拉（主题扩展贡献）
 * - 语言：语言下拉（本地化名称：中文/English）
 * - 快捷键：内置快捷键列表 + 修改 + 冲突检测
 * - 扩展：非内置扩展设置项（api.settings.register / manifest 声明）
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { themeStore } from '../../core/theme'
import { keybindingStore } from '../../core/keybindings'
import { stateStore } from '../../core/state'
import { extensionSettingsStore } from '../../core/extensionSettings'
import { host } from '../../core/host'
import { LOCALES, setLocale, type LocaleCode } from '../../i18n'
import type { RegisteredSettingsPage } from '../../core/extensionSettings'

const { t } = useI18n()

type TreeKey = 'appearance' | 'language' | 'keyboard' | 'update' | 'network' | 'notification' | 'extension'

const active = ref<TreeKey>('appearance')
const activeExt = ref<string | null>(null)

// ---- 主题 ----
const themes = computed(() => themeStore.themes)
const currentTheme = computed(() => themeStore.currentId)

function onThemeChange(e: Event): void {
  const id = (e.target as HTMLSelectElement).value
  themeStore.setTheme(id)
}

// ---- 语言 ----
// 直接读 i18n 实例的 locale（响应式），避免在 computed 中调 useI18n
import { i18n } from '../../i18n'
const currentLocale = computed<LocaleCode>(() => i18n.global.locale.value as LocaleCode)

function onLocaleChange(e: Event): void {
  const code = (e.target as HTMLSelectElement).value as LocaleCode
  setLocale(code)
}

// ---- 快捷键 ----
const keybindings = computed(() => keybindingStore.list())
const capturing = ref<string | null>(null)
const conflictMsg = ref('')

function startCapture(command: string): void {
  capturing.value = command
  conflictMsg.value = ''
}

function onCaptureKeydown(e: KeyboardEvent): void {
  if (!capturing.value) return
  e.preventDefault()
  if (e.key === 'Escape') {
    capturing.value = null
    return
  }
  const combo = keybindingStore.captureCombo(e)
  if (!combo) return
  const { conflict, conflictCommand } = keybindingStore.setKey(capturing.value, combo)
  if (conflict) {
    conflictMsg.value = t('settings.keyboard.conflict', {
      key: conflict,
      command: conflictCommand ?? ''
    })
    return
  }
  capturing.value = null
}

// ---- 更新 ----
import { updaterStore } from '../../core/updaterStore'
const updaterProviders = computed(() => updaterStore.providers)
const activeUpdater = computed(() => updaterStore.activeId)
const oboxVersion = ref('')
const updateStatus = ref<string>('') // 'checking' | 'available' | 'uptodate' | 'downloading' | 'downloaded' | 'error'
const isStatus = (s: string): boolean => updateStatus.value === s
const updateMsg = ref('')
const downloadPercent = ref(0)

void window.api.getOboxVersion().then((v) => (oboxVersion.value = v))

function selectUpdater(id: string): void {
  updaterStore.setActive(id === '' ? null : id)
}

/** 检查更新（用当前生效更新提供者的 feedUrl；无 feed 报错） */
async function checkUpdate(): Promise<void> {
  const active = updaterStore.active
  if (!active) return
  if (!active.feedUrl) {
    updateStatus.value = 'error'
    updateMsg.value = t('settings.update.noFeed')
    return
  }
  updateStatus.value = 'checking'
  const result = await window.api.checkUpdate({ feedUrl: active.feedUrl, proxy: proxyConfig.value })
  if (result.ok) {
    if (result.available && result.available !== oboxVersion.value) {
      updateStatus.value = 'available'
      updateMsg.value = t('settings.update.updateAvailable', { version: result.available })
    } else {
      updateStatus.value = 'uptodate'
      updateMsg.value = ''
    }
  } else {
    updateStatus.value = 'error'
    updateMsg.value = result.error ?? ''
  }
}

async function downloadUpdate(): Promise<void> {
  updateStatus.value = 'downloading'
  const result = await window.api.downloadUpdate()
  if (!result.ok) {
    updateStatus.value = 'error'
    updateMsg.value = result.error ?? ''
  }
}

async function installUpdate(): Promise<void> {
  await window.api.installUpdate()
}

// 订阅更新事件（下载进度/完成）
import { onMounted, onUnmounted } from 'vue'
let offUpdate: (() => void) | undefined
onMounted(() => {
  offUpdate = window.events.on('update:event', (e) => {
    if (e.type === 'download-progress') {
      updateStatus.value = 'downloading'
      downloadPercent.value = e.percent ?? 0
    } else if (e.type === 'update-downloaded') {
      updateStatus.value = 'downloaded'
      downloadPercent.value = 100
    } else if (e.type === 'error' && e.message) {
      updateStatus.value = 'error'
      updateMsg.value = e.message
    }
  })
})
onUnmounted(() => offUpdate?.())

// ---- 网络（代理） ----
import type { ProxyConfig } from '../../core/types'
const proxyConfig = ref<ProxyConfig>(
  stateStore.getSetting<ProxyConfig>('network.proxy') ?? { enabled: false, host: '', noProxy: [] }
)
const noProxyText = ref((proxyConfig.value.noProxy ?? []).join('\n'))

function saveProxy(): void {
  proxyConfig.value.noProxy = noProxyText.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  stateStore.setSetting('network.proxy', { ...proxyConfig.value })
}

// ---- 通知（逐扩展开关） ----
const notificationExts = computed(() => host.getExtensions())

function isNotifDisabled(id: string): boolean {
  return stateStore.isNotificationDisabled(id)
}

function toggleNotif(id: string, disabled: boolean): void {
  stateStore.setNotificationDisabled(id, disabled)
}

// ---- 扩展设置 ----
const extensionPages = computed<RegisteredSettingsPage[]>(() => extensionSettingsStore.pages)
const extIds = computed(() => extensionSettingsStore.extensionIds)

function extDisplayName(id: string): string {
  const info = host.getExtension(id)
  return info?.manifest.displayName ?? info?.manifest.name ?? id
}

function fieldValue(_page: RegisteredSettingsPage, key: string): unknown {
  return stateStore.getSetting(key)
}

function onFieldChange(_page: RegisteredSettingsPage, key: string, value: unknown): void {
  stateStore.setSetting(key, value)
}
</script>

<template>
  <div class="settings">
    <!-- 左侧树 -->
    <aside class="settings-tree">
      <div
        class="tree-node"
        :class="{ active: active === 'appearance' }"
        @click="active = 'appearance'"
      >
        <span class="tree-label">{{ t('settings.tree.appearance') }}</span>
      </div>
      <div
        class="tree-node"
        :class="{ active: active === 'language' }"
        @click="active = 'language'"
      >
        <span class="tree-label">{{ t('settings.tree.language') }}</span>
      </div>
      <div
        class="tree-node"
        :class="{ active: active === 'keyboard' }"
        @click="active = 'keyboard'"
      >
        <span class="tree-label">{{ t('settings.tree.keyboard') }}</span>
      </div>
      <div class="tree-node" :class="{ active: active === 'update' }" @click="active = 'update'">
        <span class="tree-label">{{ t('settings.tree.update') }}</span>
      </div>
      <div class="tree-node" :class="{ active: active === 'network' }" @click="active = 'network'">
        <span class="tree-label">{{ t('settings.tree.network') }}</span>
      </div>
      <div
        class="tree-node"
        :class="{ active: active === 'notification' }"
        @click="active = 'notification'"
      >
        <span class="tree-label">{{ t('settings.tree.notification') }}</span>
      </div>
      <div class="tree-node" :class="{ active: active === 'extension' && !activeExt }">
        <span class="tree-label">{{ t('settings.tree.extensions') }}</span>
      </div>
      <!-- 扩展节点下的扩展列表 -->
      <div v-if="active === 'extension'" class="tree-children">
        <div
          v-for="id in extIds"
          :key="id"
          class="tree-node child"
          :class="{ active: activeExt === id }"
          @click="activeExt = id"
        >
          <span class="tree-label">{{ extDisplayName(id) }}</span>
        </div>
      </div>
    </aside>

    <!-- 右侧配置 -->
    <section class="settings-content">
      <!-- 外观：主题 -->
      <div v-if="active === 'appearance'" class="config-block">
        <h2>{{ t('settings.appearance.title') }}</h2>
        <div class="config-row">
          <label>{{ t('settings.appearance.theme') }}</label>
          <select :value="currentTheme" @change="onThemeChange">
            <option v-for="th in themes" :key="th.id" :value="th.id">
              {{ th.label }}
            </option>
          </select>
          <p class="config-desc">{{ t('settings.appearance.themeDesc') }}</p>
        </div>
      </div>

      <!-- 语言 -->
      <div v-else-if="active === 'language'" class="config-block">
        <h2>{{ t('settings.language.title') }}</h2>
        <div class="config-row">
          <label>{{ t('settings.language.locale') }}</label>
          <select :value="currentLocale" @change="onLocaleChange">
            <option v-for="l in LOCALES" :key="l.code" :value="l.code">
              {{ l.displayName }}
            </option>
          </select>
          <p class="config-desc">{{ t('settings.language.localeDesc') }}</p>
        </div>
      </div>

      <!-- 快捷键 -->
      <div v-else-if="active === 'keyboard'" class="config-block">
        <h2>{{ t('settings.keyboard.title') }}</h2>
        <p class="config-desc">{{ t('settings.keyboard.desc') }}</p>
        <table class="keybindings-table">
          <thead>
            <tr>
              <th>{{ t('settings.keyboard.command') }}</th>
              <th>{{ t('settings.keyboard.keybinding') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="kb in keybindings" :key="kb.command">
              <td>{{ t(kb.labelKey) }}</td>
              <td>
                <kbd v-if="capturing !== kb.command">{{ kb.currentKey }}</kbd>
                <kbd v-else class="capturing">{{ t('settings.keyboard.captureHint') }}</kbd>
              </td>
              <td>
                <button
                  v-if="capturing !== kb.command"
                  class="btn"
                  @click="startCapture(kb.command)"
                >
                  {{ t('settings.keyboard.edit') }}
                </button>
                <button v-else class="btn" @click="capturing = null">
                  {{ t('common.cancel') }}
                </button>
                <button class="btn ghost" @click="keybindingStore.reset(kb.command)">
                  {{ t('settings.keyboard.reset') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="conflictMsg" class="config-error">{{ conflictMsg }}</p>
        <!-- 捕获按键的全局监听 -->
        <div v-if="capturing" class="capture-overlay" @click="capturing = null">
          <div class="capture-box" tabindex="0" @keydown="onCaptureKeydown" @click.stop>
            <p>{{ t('settings.keyboard.captureHint') }}</p>
          </div>
        </div>
      </div>

      <!-- 更新 -->
      <div v-else-if="active === 'update'" class="config-block">
        <h2>{{ t('settings.update.title') }}</h2>
        <p class="config-desc">{{ t('settings.update.providerDesc') }}</p>
        <div class="config-row">
          <label>{{ t('settings.update.currentVersion') }}</label>
          <span class="config-value">{{ oboxVersion }}</span>
        </div>
        <div class="config-row">
          <label>{{ t('settings.update.provider') }}</label>
          <select
            :value="activeUpdater ?? ''"
            @change="selectUpdater(($event.target as HTMLSelectElement).value)"
          >
            <option value="">—</option>
            <option v-for="p in updaterProviders" :key="p.extensionId" :value="p.extensionId">
              {{ extDisplayName(p.extensionId) }}{{ activeUpdater === p.extensionId ? ' ✓' : '' }}
            </option>
          </select>
        </div>
        <p v-if="updaterProviders.length === 0" class="config-desc">
          {{ t('settings.update.noProvider') }}
        </p>
        <div v-if="activeUpdater" class="config-row actions-row">
          <button
            class="btn"
            :disabled="isStatus('checking') || isStatus('downloading')"
            @click="checkUpdate"
          >
            {{
              isStatus('checking') ? t('settings.update.checking') : t('settings.update.checkBtn')
            }}
          </button>
          <button
            v-if="isStatus('available')"
            class="btn"
            :disabled="isStatus('downloading')"
            @click="downloadUpdate"
          >
            {{
              isStatus('downloading')
                ? t('settings.update.downloading', { percent: downloadPercent })
                : t('settings.update.downloadBtn')
            }}
          </button>
          <button v-if="isStatus('downloaded')" class="btn primary" @click="installUpdate">
            {{ t('settings.update.installBtn') }}
          </button>
        </div>
        <p v-if="isStatus('uptodate')" class="config-success">
          {{ t('settings.update.upToDate') }}
        </p>
        <p v-if="isStatus('available')" class="config-info">{{ updateMsg }}</p>
        <p v-if="isStatus('downloaded')" class="config-success">
          {{ t('settings.update.downloaded') }}
        </p>
        <p v-if="isStatus('error')" class="config-error">{{ updateMsg }}</p>
      </div>

      <!-- 网络（代理） -->
      <div v-else-if="active === 'network'" class="config-block">
        <h2>{{ t('settings.network.title') }}</h2>
        <p class="config-desc">{{ t('settings.network.proxyDesc') }}</p>
        <div class="config-row">
          <label>
            <input v-model="proxyConfig.enabled" type="checkbox" @change="saveProxy" />
            {{ t('settings.network.enabled') }}
          </label>
        </div>
        <div class="config-row">
          <label>{{ t('settings.network.host') }}</label>
          <input v-model="proxyConfig.host" class="text-input" @change="saveProxy" />
        </div>
        <div class="config-row">
          <label>{{ t('settings.network.port') }}</label>
          <input
            v-model.number="proxyConfig.port"
            class="text-input"
            type="number"
            @change="saveProxy"
          />
        </div>
        <div class="config-row">
          <label>{{ t('settings.network.username') }}</label>
          <input v-model="proxyConfig.username" class="text-input" @change="saveProxy" />
        </div>
        <div class="config-row">
          <label>{{ t('settings.network.password') }}</label>
          <input
            v-model="proxyConfig.password"
            class="text-input"
            type="password"
            @change="saveProxy"
          />
        </div>
        <div class="config-row">
          <label>
            <input v-model="proxyConfig.ignoreSSL" type="checkbox" @change="saveProxy" />
            {{ t('settings.network.ignoreSSL') }}
          </label>
        </div>
        <div class="config-row">
          <label>{{ t('settings.network.noProxy') }}</label>
          <textarea v-model="noProxyText" class="text-input" rows="3" @change="saveProxy" />
        </div>
      </div>

      <!-- 通知（逐扩展开关） -->
      <div v-else-if="active === 'notification'" class="config-block">
        <h2>{{ t('settings.notification.title') }}</h2>
        <p class="config-desc">{{ t('settings.notification.desc') }}</p>
        <p v-if="notificationExts.length === 0" class="config-desc">
          {{ t('settings.notification.empty') }}
        </p>
        <div v-for="ext in notificationExts" :key="ext.id" class="config-row">
          <label>
            <input
              type="checkbox"
              :checked="!isNotifDisabled(ext.id)"
              @change="toggleNotif(ext.id, !($event.target as HTMLInputElement).checked)"
            />
            {{ extDisplayName(ext.id) }}
          </label>
        </div>
      </div>

      <!-- 扩展设置 -->
      <div v-else class="config-block">
        <h2>
          {{
            activeExt
              ? extDisplayName(activeExt) + ' ' + t('settings.tree.extensions')
              : t('settings.tree.extensions')
          }}
        </h2>
        <p v-if="!activeExt && extIds.length === 0" class="config-desc">
          {{ t('settings.extensionsSection.empty') }}
        </p>
        <p v-if="!activeExt && extIds.length > 0" class="config-desc">
          {{ t('settings.extensionsSection.select') }}
        </p>
        <template v-if="activeExt">
          <div
            v-for="page in extensionPages.filter((p) => p.extensionId === activeExt)"
            :key="page.id"
          >
            <h3>{{ page.title }}</h3>
            <div v-for="field in page.fields" :key="field.key" class="config-row">
              <label>{{ field.label }}</label>
              <input
                v-if="field.type === 'text'"
                class="text-input"
                :value="(fieldValue(page, field.key) as string) ?? (field.default as string) ?? ''"
                @change="onFieldChange(page, field.key, ($event.target as HTMLInputElement).value)"
              />
              <input
                v-else-if="field.type === 'number'"
                class="text-input"
                type="number"
                :value="(fieldValue(page, field.key) as number) ?? (field.default as number) ?? 0"
                @change="
                  onFieldChange(page, field.key, Number(($event.target as HTMLInputElement).value))
                "
              />
              <input
                v-else-if="field.type === 'boolean'"
                type="checkbox"
                :checked="
                  (fieldValue(page, field.key) as boolean) ?? (field.default as boolean) ?? false
                "
                @change="
                  onFieldChange(page, field.key, ($event.target as HTMLInputElement).checked)
                "
              />
              <select
                v-else-if="field.type === 'select'"
                :value="(fieldValue(page, field.key) as string) ?? (field.default as string) ?? ''"
                @change="onFieldChange(page, field.key, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="opt in field.options" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
              <p v-if="field.description" class="config-desc">{{ field.description }}</p>
            </div>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  height: 100%;
  background: var(--bg, #1e1e1e);
  color: var(--fg, #cccccc);
}
.settings-tree {
  width: 200px;
  border-right: 1px solid var(--border, #3c3c3c);
  padding: 8px 0;
  overflow-y: auto;
  flex-shrink: 0;
}
.tree-node {
  padding: 6px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--fg-dim, #9d9d9d);
  display: flex;
  align-items: center;
  gap: 6px;
}
.tree-node:hover {
  color: var(--fg, #cccccc);
}
.tree-node.active {
  background: var(--accent, #007acc);
  color: #ffffff;
}
.tree-node.child {
  padding-left: 28px;
}
.tree-children {
  border-left: 1px solid var(--border, #3c3c3c);
  margin-left: 16px;
}
.settings-content {
  flex: 1;
  padding: 20px 28px;
  overflow-y: auto;
}
.config-block h2 {
  font-size: 18px;
  margin: 0 0 16px;
  color: var(--fg-bright, #e8e8e8);
}
.config-block h3 {
  font-size: 14px;
  margin: 16px 0 8px;
  color: var(--fg-bright, #e8e8e8);
}
.config-row {
  margin-bottom: 16px;
}
.config-row label {
  display: block;
  font-size: 13px;
  margin-bottom: 6px;
  color: var(--fg, #cccccc);
}
.config-row select,
.config-row .text-input {
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  color: var(--fg, #cccccc);
  padding: 5px 8px;
  font-size: 13px;
  min-width: 220px;
}
.config-row input[type='checkbox'] {
  accent-color: var(--accent, #007acc);
}
.config-desc {
  font-size: 12px;
  color: var(--fg-dim, #6e6e6e);
  margin-top: 4px;
}
.config-error {
  font-size: var(--font-size-sm, 12px);
  color: var(--fg-error, #f48771);
  margin-top: 8px;
}
.config-success {
  font-size: var(--font-size-sm, 12px);
  color: var(--fg-success, #4ec9b0);
  margin-top: 8px;
}
.config-info {
  font-size: var(--font-size-sm, 12px);
  color: var(--fg-link, #75beff);
  margin-top: 8px;
}
.config-value {
  color: var(--fg-bright, #e8e8e8);
  font-family: ui-monospace, monospace;
}
.actions-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.btn.primary {
  background: var(--accent, #007acc);
  border-color: var(--accent, #007acc);
  color: #ffffff;
}
.keybindings-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.keybindings-table th,
.keybindings-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, #3c3c3c);
}
.keybindings-table th {
  color: var(--fg-dim, #9d9d9d);
  font-weight: 500;
}
kbd {
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 12px;
  font-family: inherit;
}
kbd.capturing {
  color: var(--accent, #007acc);
}
.btn {
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  color: var(--fg, #cccccc);
  padding: 3px 12px;
  font-size: 12px;
  cursor: pointer;
  margin-right: 6px;
}
.btn:hover {
  background: var(--hover-bg, #454545);
}
.btn.ghost {
  background: transparent;
}
.capture-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 5000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.capture-box {
  background: var(--bg-panel, #252526);
  border: 1px solid var(--border, #454545);
  padding: 24px 40px;
  border-radius: 4px;
  outline: none;
}
.capture-box p {
  font-size: 14px;
  color: var(--fg, #cccccc);
}
</style>
