<script setup lang="ts">
/**
 * 设置视图：左侧树（外观/语言/快捷键/扩展）+ 右侧配置表单。
 * - 外观：主题下拉（主题扩展贡献）
 * - 语言：语言下拉（本地化名称：中文/English）
 * - 快捷键：内置快捷键列表 + 修改 + 冲突检测
 * - 扩展：非内置扩展设置项（api.settings.register / manifest 声明）
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { themeStore } from '../../core/theme'
import { keybindingStore } from '../../core/keybindings'
import { stateStore } from '../../core/state'
import { extensionSettingsStore } from '../../core/extensionSettings'
import { host } from '../../core/host'
import { LOCALES, setLocale, type LocaleCode } from '../../i18n'
import type { RegisteredSettingsPage } from '../../core/extensionSettings'
import type { SettingField } from '../../../../api/contributions'

const { t } = useI18n()

type TreeKey =
  | 'appearance'
  | 'general'
  | 'language'
  | 'keyboard'
  | 'update'
  | 'network'
  | 'notification'
  | 'extension'

const active = ref<TreeKey>('appearance')
const activeExt = ref<string | null>(null)

/** 点左树「扩展」节点：切到扩展分区**列表态**（清子项选中，否则右侧仍停在上次打开的扩展上） */
function selectExtensions(): void {
  active.value = 'extension'
  activeExt.value = null
}

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

// 设置存储任意变更的计数：让"渲染期直读 stateStore"的表单重新求值。
// 声明在使用点之前（`const` 在渲染期访问不会有 TDZ 问题）。
const settingsRevision = ref(0)

// ---- 快捷键 ----
/**
 * 依赖 `settingsRevision`：`keybindingStore.list()` 内部直读 `stateStore`，
 * 单靠 `entries`（reactive）**不会**在"改键写盘"后重新求值——改完键表格仍显示旧按键，
 * 直到别的响应式源触发重渲染（实测复现，issue #85）。
 */
const keybindings = computed(() => {
  void settingsRevision.value
  return keybindingStore.list()
})
const capturing = ref<string | null>(null)
const conflictMsg = ref('')
/** 捕获框元素：显示后必须显式 focus()，否则 keydown 事件根本到不了它（issue #85） */
const captureBox = ref<HTMLElement | null>(null)

async function startCapture(command: string): Promise<void> {
  capturing.value = command
  conflictMsg.value = ''
  // 全局守卫：捕获期间 matchKeydown / App.vue 的全局 keydown 处理器都不触发命令
  keybindingStore.setCapturing(true)
  // 覆盖层是本帧 v-if 出来的：nextTick 之后才拿得到元素
  await nextTick()
  captureBox.value?.focus()
}

/** 退出捕获态（Esc / 取消按钮 / 改键成功 / 组件卸载都要走这里，避免守卫卡住不放） */
function cancelCapture(): void {
  capturing.value = null
  keybindingStore.setCapturing(false)
}

function onCaptureKeydown(e: KeyboardEvent): void {
  if (!capturing.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    cancelCapture()
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
  cancelCapture()
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
  const result = await window.api.checkUpdate({
    feedUrl: active.feedUrl,
    proxy: { ...proxyConfig }
  })
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
import type { AutoStartState, CloseBehavior } from '../../../../shared/types'
const DEFAULT_PROXY: ProxyConfig = { enabled: false, host: '', noProxy: [] }

/** `localStorage['obox:state:v1'].settings['network.proxy']` 的快照或空配置 */
function readProxyConfig(): ProxyConfig {
  return stateStore.getSetting<ProxyConfig>('network.proxy') ?? { ...DEFAULT_PROXY }
}

/**
 * 首屏值来自持久化快照；**并订阅后续变更**（issue #85：此前是一次性快照，
 * 状态在挂载后被替换（跨窗口 `storage` 合并 / 主进程回写）时表单会停在旧值）。
 * `savingProxy` 抑制"自己写入 → 自己收到通知 → 再写回"的回环。
 */
const proxyConfig = reactive<ProxyConfig>(readProxyConfig())
const noProxyText = computed({
  get: () => (proxyConfig.noProxy ?? []).join('\n'),
  set: (value: string) => {
    proxyConfig.noProxy = value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }
})

let savingProxy = false

function syncProxyFromStore(): void {
  if (savingProxy) return
  const next = readProxyConfig()
  proxyConfig.enabled = next.enabled ?? false
  proxyConfig.host = next.host ?? ''
  proxyConfig.port = next.port
  proxyConfig.username = next.username
  proxyConfig.password = next.password
  proxyConfig.ignoreSSL = next.ignoreSSL
  proxyConfig.noProxy = [...(next.noProxy ?? [])]
}

function saveProxy(): void {
  savingProxy = true
  try {
    stateStore.setSetting('network.proxy', {
      ...proxyConfig,
      noProxy: [...(proxyConfig.noProxy ?? [])]
    })
  } finally {
    savingProxy = false
  }
}

// ---- 通知（逐扩展开关） ----
const notificationExts = computed(() => host.getExtensions())
// 计数值：通知开关直接读 stateStore（渲染期读取即建立依赖），这里只需在变更时触发重渲染
const notificationRevision = ref(0)

function isNotifDisabled(id: string): boolean {
  void notificationRevision.value
  return stateStore.isNotificationDisabled(id)
}

function toggleNotif(id: string, disabled: boolean): void {
  stateStore.setNotificationDisabled(id, disabled)
  notificationRevision.value++
}

// ---- 通用：关闭行为（偏好存主进程 userData/app-preferences.json；仅 Windows 有托盘，见 ADR-0019） ----
const isWindows = window.api.env.platform === 'win32'
const closeBehavior = ref<CloseBehavior>('ask')
void window.api.getCloseBehavior().then((value) => {
  closeBehavior.value = value
})

async function onCloseBehaviorChange(e: Event): Promise<void> {
  const value = (e.target as HTMLSelectElement).value as CloseBehavior
  const previous = closeBehavior.value
  closeBehavior.value = value
  try {
    await window.api.setCloseBehavior(value)
  } catch (err) {
    // 写失败回弹到上一次的生效值（主进程是权威）
    closeBehavior.value = previous
    console.error('[settings] 写入关闭行为失败', err)
  }
}

// ---- 通用：开机自启（仅 Windows 且非开发版；状态以系统为准，ADR-0019 决策 12–14） ----
const autoStart = ref<AutoStartState>({ supported: false, enabled: false })
void window.api.getAutoStart().then((state) => {
  autoStart.value = state
})

async function onAutoStartChange(checked: boolean): Promise<void> {
  // 失败/不支持时后端会回传**系统真实状态**与原因，前端照抄即可（开关自然回弹）
  autoStart.value = await window.api.setAutoStart(checked)
}

// ---- 扩展设置 ----
const extensionPages = computed<RegisteredSettingsPage[]>(() => extensionSettingsStore.pages)
const extIds = computed(() => extensionSettingsStore.extensionIds)

function extDisplayName(id: string): string {
  const info = host.getExtension(id)
  return info?.manifest.displayName ?? info?.manifest.name ?? id
}

function fieldValue(_page: RegisteredSettingsPage, key: string): unknown {
  void settingsRevision.value
  return stateStore.getSetting(key)
}

function onFieldChange(_page: RegisteredSettingsPage, key: string, value: unknown): void {
  stateStore.setSetting(key, value)
}

/** 字段的稳定标识（页 id + 字段 key）：directory 的错误提示与未知类型警告都按它去重/记账 */
function fieldSlot(page: RegisteredSettingsPage, key: string): string {
  return `${page.id}::${key}`
}

// ---- directory 字段：目录选择 ----

/** 目录选择失败信息（按 fieldSlot 记账，渲染在该字段下方；失败必须可见，不能静默） */
const directoryErrors = ref<Record<string, string>>({})

/**
 * 点输入框或「浏览…」：弹系统**目录**选择器，选中后把**绝对路径**写回设置；取消不改动。
 *
 * 走宿主已具备的能力：`window.api.dialogOpen`（preload）→ `dialog:open` IPC →
 * `dialog.showOpenDialog({ properties: ['openDirectory'] })`（`src/main/ext.ts:31-49` 归一、
 * `:53-66` 调用；目录模式下 filters 被丢弃）。**不是**另造保存通路——写值仍走 text 的
 * `onFieldChange` → `stateStore.setSetting`（输入框 `readonly`，这里是唯一写值入口）。
 */
async function browseDirectory(page: RegisteredSettingsPage, field: SettingField): Promise<void> {
  const slot = fieldSlot(page, field.key)
  try {
    const result = await window.api.dialogOpen({
      title: field.label,
      properties: ['openDirectory']
    })
    if (!result.ok) {
      const message = result.error ?? '打开目录选择器失败'
      directoryErrors.value = { ...directoryErrors.value, [slot]: message }
      console.error('[settings] 打开目录选择器失败：', message)
      return
    }
    // 取消：不得改动设置项（尤其不能写空串）
    if (result.canceled) return
    const picked = result.filePaths?.[0]
    if (!picked) return
    directoryErrors.value = { ...directoryErrors.value, [slot]: '' }
    onFieldChange(page, field.key, picked)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    directoryErrors.value = { ...directoryErrors.value, [slot]: message }
    console.error('[settings] 打开目录选择器异常：', err)
  }
}

// ---- status 字段：只读状态展示 ----

/**
 * `status` 字段的只读文本行。值 = 该字段 `key` 在**统一设置存储**里的值，由扩展经
 * `api.settings.set(key, value)` 写入（`host.ts:440`），宿主只渲染、**不提供任何编辑控件**。
 *
 * - 非字符串值按 `String(value)` 展示（扩展写数字进度也算状态）；
 * - 设置里没有该键时回退 `field.default`；
 * - 值含 `\n`（CRLF 归一为 LF）时切成多行，供模板按行渲染成列表；
 * - 值空 / 全空白（含只有换行）时回落成占位文案——字段下方不能一片空白看不出状态。
 *
 * 取值仍走 `fieldValue`，因此与 text/number 等字段**同一条响应式路径**
 * （见下方 `onMounted` 的 `stateStore.onSettingsChanged` 订阅）。
 */
function statusLines(page: RegisteredSettingsPage, field: SettingField): string[] {
  const raw = fieldValue(page, field.key) ?? field.default
  const text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  // 去掉首尾空行（多行文本常见的尾随换行），保留中间空行
  while (lines.length > 0 && !lines[0].trim()) lines.shift()
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  return lines.length > 0 ? lines : [t('settings.extensionsSection.noValue')]
}

// ---- 未知字段类型：回落成文本框 ----

/** 已警告过的字段（按 fieldSlot 去重；渲染期调用，不能每次渲染都刷屏） */
const warnedUnknownFieldTypes = new Set<string>()

/**
 * 未知字段类型的兜底取值：**按 text 语义渲染**（可编辑、经同一条 `onFieldChange` 保存），
 * 并 `console.warn` 一条说明，避免宿主类型演进时该设置项"凭空消失"且无迹可循。
 */
function unknownTypeValue(page: RegisteredSettingsPage, field: SettingField): string {
  const slot = fieldSlot(page, field.key)
  if (!warnedUnknownFieldTypes.has(slot)) {
    warnedUnknownFieldTypes.add(slot)
    console.warn(
      `[settings] 未知设置字段类型 "${String(field.type)}"（${slot}）已回落为文本框渲染；请升级宿主或修正扩展声明`
    )
  }
  return (fieldValue(page, field.key) as string) ?? (field.default as string) ?? ''
}

let offSettingsChanged: (() => void) | undefined

onMounted(() => {
  offSettingsChanged = stateStore.onSettingsChanged((key) => {
    settingsRevision.value++
    if (key === undefined || key === 'network.proxy') syncProxyFromStore()
  })
})

onUnmounted(() => {
  offSettingsChanged?.()
  // 卸载时释放捕获守卫，避免"改键到一半切走"把全局快捷键永久挡住
  if (keybindingStore.isCapturing) keybindingStore.setCapturing(false)
})
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
      <div class="tree-node" :class="{ active: active === 'general' }" @click="active = 'general'">
        <span class="tree-label">{{ t('settings.tree.general') }}</span>
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
      <div
        class="tree-node"
        :class="{ active: active === 'extension' && !activeExt }"
        @click="selectExtensions()"
      >
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

      <!-- 通用：关闭行为（仅 Windows 有系统托盘，非 Windows 显示说明） -->
      <div v-if="active === 'general'" class="config-block">
        <h2>{{ t('settings.general.title') }}</h2>
        <div v-if="isWindows" class="config-row">
          <label>{{ t('settings.general.closeBehavior') }}</label>
          <select :value="closeBehavior" @change="onCloseBehaviorChange">
            <option value="ask">{{ t('settings.general.closeAsk') }}</option>
            <option value="hide">{{ t('settings.general.closeHide') }}</option>
            <option value="quit">{{ t('settings.general.closeQuit') }}</option>
          </select>
          <p class="config-desc">{{ t('settings.general.closeBehaviorDesc') }}</p>
        </div>
        <div v-if="isWindows" class="config-row">
          <label>
            <input
              type="checkbox"
              :checked="autoStart.enabled"
              :disabled="!autoStart.supported"
              @change="onAutoStartChange(($event.target as HTMLInputElement).checked)"
            />
            {{ t('settings.general.autoStart') }}
          </label>
          <p class="config-desc">{{ t('settings.general.autoStartDesc') }}</p>
          <p v-if="autoStart.message" class="config-desc config-error">{{ autoStart.message }}</p>
        </div>
        <p v-else class="config-desc">{{ t('settings.general.windowsOnly') }}</p>
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
                <button v-else class="btn" @click="cancelCapture">
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
        <!-- 捕获按键的覆盖层：显示后由 startCapture() 聚焦 capture-box -->
        <div v-if="capturing" class="capture-overlay" @click="cancelCapture">
          <div
            ref="captureBox"
            class="capture-box"
            tabindex="0"
            @keydown="onCaptureKeydown"
            @click.stop
          >
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
              <!--
                directory：**点输入框或按钮都弹框**（用户裁定：选目录是主要输入方式）——输入框 `readonly` + `@click`，值只能由选择器写入；「浏览…」按钮保留（键盘可达、冗余）。代价：路径不能手工输入/粘贴。
              -->
              <div v-else-if="field.type === 'directory'" class="directory-input">
                <input
                  class="text-input"
                  readonly
                  :value="
                    (fieldValue(page, field.key) as string) ?? (field.default as string) ?? ''
                  "
                  @click="browseDirectory(page, field)"
                  @change="
                    onFieldChange(page, field.key, ($event.target as HTMLInputElement).value)
                  "
                />
                <button class="btn" type="button" @click="browseDirectory(page, field)">
                  {{ t('settings.extensionsSection.browse') }}
                </button>
              </div>
              <p
                v-if="field.type === 'directory' && directoryErrors[fieldSlot(page, field.key)]"
                class="config-error"
              >
                {{ directoryErrors[fieldSlot(page, field.key)] }}
              </p>
              <!--
                status：**只读**状态展示 —— 无输入框、无按钮、无 @change，宿主不接受用户输入。
                值 = 该字段 key 在统一设置存储里的值（由扩展经 api.settings.set 写入，host.ts:440），
                经 fieldValue → stateStore.getSetting 取值（与其它字段同一条响应式路径）。
                含 \n 的值按行渲染成列表（多行进度/明细）；空值渲染占位文案（statusLines）。
              -->
              <div v-else-if="field.type === 'status'" class="config-value status-value">
                <ul v-if="statusLines(page, field).length > 1" class="status-lines">
                  <li v-for="(line, idx) in statusLines(page, field)" :key="idx">{{ line }}</li>
                </ul>
                <span v-else>{{ statusLines(page, field)[0] }}</span>
              </div>
              <!--
                兜底：未知类型回落为文本框（可编辑、可保存，经同一条 onFieldChange 落库），
                并由 unknownTypeValue 打一条 console.warn —— 宿主新增类型时不至于"设置项凭空消失"。
              -->
              <input
                v-else
                class="text-input"
                :value="unknownTypeValue(page, field)"
                @change="onFieldChange(page, field.key, ($event.target as HTMLInputElement).value)"
              />
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
/* directory 字段：文本框占满剩余宽度，「浏览…」按钮跟在右侧 */
.config-row .directory-input {
  display: flex;
  align-items: center;
  gap: 8px;
}
.config-row .directory-input .text-input {
  flex: 1;
  min-width: 0;
  /* 只读输入框 = 点击弹框的触发器，给出手型光标提示可点 */
  cursor: pointer;
}
.config-row .directory-input .btn {
  margin-right: 0;
  flex-shrink: 0;
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
/* status 字段：只读状态展示（无输入框/按钮），沿用 .config-value 的配色，不自造色值 */
.config-row .status-value {
  white-space: pre-wrap;
}
/* 多行状态按行渲染成列表（每行一条进度/明细），行间距紧凑以免撑高设置页 */
.config-row .status-lines {
  margin: 0;
  padding-left: 18px;
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
