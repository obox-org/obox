<script setup lang="ts">
/**
 * 设置视图：左侧树（外观/语言/快捷键/扩展）+ 右侧配置表单。
 * - 外观：主题下拉（主题扩展贡献）
 * - 语言：语言下拉（本地化名称：中文/English）
 * - 快捷键：内置快捷键列表 + 修改 + 冲突检测
 * - 扩展：非内置扩展设置项（api.settings.register / manifest 声明）
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { themeStore } from '../../core/theme'
import { keybindingStore } from '../../core/keybindings'
import { stateStore } from '../../core/state'
import { extensionSettingsStore } from '../../core/extensionSettings'
import { host } from '../../core/host'
import {
  EXTENSION_HOST_SOURCE_TEXT,
  clearRendererFallback,
  extensionHostFallbackNotice,
  readExtensionHostSwitch,
  type ExtensionHostSwitchDecision
} from '../../core/extensionHostBridge'
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
  | 'ai'
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
import { plainProxyConfig } from '../../core/plainProxy'
const updaterProviders = computed(() => updaterStore.providers)
/**
 * 当前生效的更新提供者 id。
 *
 * ⚠️ 必须显式依赖 `settingsRevision`：`stateStore` 的 state 是**普通对象**（`core/state.ts:85`
 * 直接 `load()`，不是 reactive），读设置**不被追踪**，于是这个 computed 会把首次结果（通常是
 * `undefined`）永久缓存；而设置页在 `KeepAlive` 里，切走再回来也不会重算。
 * 实测（打包版 1.0.10）：在「更新」页选中提供者后，`v-if="activeUpdater"` 的
 * **「检查更新」按钮始终不出现**，只有重启应用才行。同一约定见本文件快捷键区的 computed。
 */
const activeUpdater = computed(() => {
  void settingsRevision.value
  return updaterStore.activeId
})
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
    proxy: plainProxyConfig(proxyConfig)
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
import type { AutoStartState, CloseBehavior, LegacyProxyConfig } from '../../../../shared/types'
import { normalizeProxyConfig } from '../../../../shared/proxyConfig'
/** 表单默认值（新形态：单一代理 URL） */
const DEFAULT_PROXY: ProxyConfig = { enabled: false, url: '', noProxy: [] }

/**
 * `localStorage['obox:state:v1'].settings['network.proxy']` 的快照或空配置。
 *
 * **旧值迁移就在这里**：1.0.11 及更早持久化的是 `{enabled,host,port,username,password,...}`，
 * `normalizeProxyConfig()` 会把它拼成 `http://[user:pass@]host[:port]`（唯一实现在
 * `src/shared/proxyConfig.ts`），所以升级后设置不丢、首屏直接显示成 URL。
 * 返回值是**纯对象**（新对象 + 新数组），可直接进 IPC（见 `core/plainProxy.ts`）。
 *
 * `void settingsRevision.value`：`stateStore` 的 state 是普通对象（`core/state.ts:85`），读设置
 * **不被追踪**；集中在这里读一下版本号，任何把它放进 computed/effect 的调用方都能正确重算
 * （本文件其它读 stateStore 的 computed 同一约定）。
 */
function readProxyConfig(): ProxyConfig {
  void settingsRevision.value
  // 泛型带上 LegacyProxyConfig：持久化里可能还是 ≤1.0.11 的旧形态（由 normalizeProxyConfig 迁移）
  const stored = stateStore.getSetting<ProxyConfig | LegacyProxyConfig>('network.proxy')
  return normalizeProxyConfig(stored ?? DEFAULT_PROXY)
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
  proxyConfig.enabled = next.enabled
  proxyConfig.url = next.url
  proxyConfig.ignoreSSL = next.ignoreSSL
  proxyConfig.noProxy = [...(next.noProxy ?? [])]
}

function saveProxy(): void {
  savingProxy = true
  try {
    // 归一化后再写盘：存进设置的**永远是纯对象**的新形态（不会被 reactive Proxy 污染）
    stateStore.setSetting('network.proxy', normalizeProxyConfig(proxyConfig))
  } finally {
    savingProxy = false
  }
}

// ---- AI（OpenAI 兼容接口参数；决策与取舍见 docs/adr/0025-host-ai-options.md） ----

/**
 * 五个设置键（一律统一设置存储，前缀 `ai.`）。
 *
 * ⚠️ 读值必须重算：`stateStore` 的 state 是**普通对象**（`core/state.ts:85`），读设置**不被追踪**，
 * 且设置页在 `KeepAlive` 里；所以每个取值函数都先 `void settingsRevision.value`
 * （与代理表单、快捷键表格同一约定），`setSetting` 会触发订阅 → 计数变化 → 当帧重读。
 */
const AI_KEYS = {
  baseUrl: 'ai.baseUrl',
  apiKey: 'ai.apiKey',
  model: 'ai.model',
  contextLen: 'ai.contextLen',
  dailyLimit: 'ai.dailyLimit'
} as const

/** `contextLen` 的默认值（缺省/非法/小于 1 时回落到它） */
const DEFAULT_CONTEXT_LEN = 8192
/** `contextLen` 的上限（超过按上限钳制；1M token 已远超任何现实端点） */
const MAX_CONTEXT_LEN = 1_048_576
/** 模板里展示默认值用的文本（模板只认白名单全局，这里先算好） */
const DEFAULT_CONTEXT_LEN_TEXT = String(DEFAULT_CONTEXT_LEN)

/** 读一个 AI 设置值（依赖 `settingsRevision`，见 `AI_KEYS` 注释） */
function aiStored(key: string): unknown {
  void settingsRevision.value
  return stateStore.getSetting(key)
}

/** 文本类字段的显示值（未设置/非字符串 → 空串） */
function aiTextOf(key: string): string {
  const value = aiStored(key)
  return typeof value === 'string' ? value : ''
}

/**
 * 数字类字段的显示值：未设置或存值不是有限数字 → `fallback`（`''` = 空输入框）。
 * 存值为数字时按数字显示——**`0` 要显示成 `0`**（与"空"区分，`dailyLimit` 的语义靠它）。
 */
function aiNumberTextOf(key: string, fallback: string): string {
  const value = aiStored(key)
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback
}

/**
 * `contextLen` 的归一策略（纯函数；测试从本文件源码原样提取后直接跑，避免"测试里复制实现"）：
 * - 空串 / 全空白 / null / undefined / 非数字文本 / NaN / ±Infinity → **默认 8192**
 * - 小数 → 向下取整
 * - `< 1`（0 与负数）→ **默认 8192**（"1 token 上下文"没有意义，回落到可用的默认值比钳到 1 更可预期）
 * - `> MAX_CONTEXT_LEN` → **钳到上限**（荒谬的大值不该原样存下去，也别让输入框"拒绝保存"没有反馈）
 */
function normalizeContextLen(raw: unknown): number {
  const value = typeof raw === 'string' ? raw.trim() : raw
  if (value === '' || value === null || value === undefined) return DEFAULT_CONTEXT_LEN
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return DEFAULT_CONTEXT_LEN
  const floored = Math.floor(num)
  return floored < 1 ? DEFAULT_CONTEXT_LEN : Math.min(floored, MAX_CONTEXT_LEN)
}

/**
 * `dailyLimit` 的归一策略（纯函数；同上）：
 * - 空串 / 全空白 / null / undefined → **`null` = 不限**（用户明确要求"每日限额可以为空"）
 * - 非有限（NaN / ±Infinity / 非数字文本）→ `null`
 * - 负数 → `null`（负数限额没有意义；归一为"不限"而不是 0——归一为 0 等于把一次误填变成
 *   "禁止使用"，那是更坏的降级）
 * - 其余 → 向下取整的非负整数；**`0` 保留为 `0`**（"额度 0"，与空的"不限"是两回事）
 */
function normalizeDailyLimit(raw: unknown): number | null {
  const value = typeof raw === 'string' ? raw.trim() : raw
  if (value === '' || value === null || value === undefined) return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return null
  const floored = Math.floor(num)
  return floored < 0 ? null : floored
}

/** 文本字段保存（baseUrl / model：与其它页一致走 `@change`，失焦即落库） */
function saveAiText(key: string, value: string): void {
  stateStore.setSetting(key, value)
}

/** `contextLen` 保存：空/非法按默认归一后落库（输入框随之显示归一结果） */
function onContextLenChange(e: Event): void {
  stateStore.setSetting(
    AI_KEYS.contextLen,
    normalizeContextLen((e.target as HTMLInputElement).value)
  )
}

/** `dailyLimit` 保存：空 ⇒ `null`（不限）；`0` ⇒ `0`（额度 0） */
function onDailyLimitChange(e: Event): void {
  stateStore.setSetting(
    AI_KEYS.dailyLimit,
    normalizeDailyLimit((e.target as HTMLInputElement).value)
  )
}

/**
 * apiKey 的掩码态开关（`false` = 掩码）。
 *
 * **只影响显示**：它是组件内的 ref，既不写设置、也不落盘，切走页面即回到掩码态
 * （组件被 KeepAlive 缓存，重挂载时重新初始化为 `false`）。掩码态**不渲染密钥明文**
 * （只渲染固定圆点串，见模板）：比 `type="password"` 更硬的保证——DOM 里根本没有明文。
 */
const showApiKey = ref(false)

/** 掩码显示的固定圆点串：**与密钥长度无关**（固定 8 个），避免从点的数量反推长度 */
const MASKED_KEY = '••••••••'

/** 是否已配置密钥（只对外暴露这一个布尔量，不暴露内容；未配置时掩码位置显示「未配置」） */
function hasApiKey(): boolean {
  return aiTextOf(AI_KEYS.apiKey).trim() !== ''
}

/**
 * apiKey 保存走 `@input`（**不是** `@change`）：掩码切换会重建这个输入框，"输入到一半点隐藏"
 * 若等失焦才保存就会丢输入；逐键落库让"切换/失焦丢输入"不可能发生（localStorage 写入很小）。
 * 值相同时 Vue 不重写 DOM，光标不会跳。
 */
function onApiKeyInput(e: Event): void {
  stateStore.setSetting(AI_KEYS.apiKey, (e.target as HTMLInputElement).value)
}

// ---- AI：测试连接 ----
const aiTestState = ref<'idle' | 'testing'>('idle')
const aiTestOk = ref(false)
const aiTestMessage = ref('')

/**
 * 「测试连接」：**先本地快速失败，再发请求**。
 *
 * - baseUrl 空 ⇒ 提示「请先填写 baseUrl」并**直接 return**（不发任何 IPC / 网络请求）；
 * - baseUrl 非 `http(s)://` ⇒ 同样本地拒绝（与主进程同口径；主进程侧仍会再校验一次，防绕过）；
 * - 通过后交给**主进程**：`window.api.aiTestConnection` → `ai:test-connection`
 *   （`src/main/ai.ts`），请求在 `netSession()` 上发 ⇒ **自动继承「设置 → 网络」的代理与
 *   忽略 SSL 设置**（与 `api.net.fetch` 同一条链路；渲染进程自己 fetch 走默认 session、不经代理）。
 * - 期间 `aiTestState = 'testing'`：按钮进 loading 态并禁用，UI 不阻塞（不 await 到渲染里）。
 * - 结果文案由主进程给（中文，含状态码/Chromium 错误名等一手信息）；IPC 本身失败（如老宿主
 *   没有这个方法）时用 i18n 文案兜底，不让异常冒泡成白屏。
 */
async function testAiConnection(): Promise<void> {
  const baseUrl = aiTextOf(AI_KEYS.baseUrl).trim()
  aiTestOk.value = false
  aiTestMessage.value = ''
  if (!baseUrl) {
    aiTestMessage.value = t('settings.ai.needBaseUrl')
    return
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    aiTestMessage.value = t('settings.ai.invalidBaseUrl')
    return
  }
  aiTestState.value = 'testing'
  try {
    const result = await window.api.aiTestConnection({
      baseUrl,
      apiKey: aiTextOf(AI_KEYS.apiKey).trim()
    })
    aiTestOk.value = result.ok
    aiTestMessage.value = result.message
  } catch (err) {
    aiTestMessage.value = t('settings.ai.testFailed', {
      msg: err instanceof Error ? err.message : String(err)
    })
  } finally {
    aiTestState.value = 'idle'
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

// ---- 通用：扩展执行位置（EH-D2a） ----
/**
 * 「在独立进程中运行扩展」开关（2.0.0 起**默认开**）。
 *
 * 判定本体只有一处：`core/extensionHostBridge.ts` 的 `readExtensionHostSwitch()`
 * （设置项 > 环境变量 `OBOX_EXTENSION_HOST` > 默认开；本窗口启动失败过 ⇒ 临时回退）。
 * 本页只做两件事：**显示当前生效值 + 来源**，以及把用户的选择写进设置。
 *
 * ⚠️ **不做热切换**：宿主已经启动、扩展已经在跑，换执行位置只能重启应用。保存后只提示
 * "重启 Obox 后生效"（与「关闭行为」「开机自启」这类需要系统/进程级生效的项同一取舍）。
 * 依赖 `settingsRevision` 的理由同本文件其它读 `stateStore` 的取值（state 是普通对象，读不被追踪）。
 */
function extensionHostDecision(): ExtensionHostSwitchDecision {
  void settingsRevision.value
  return readExtensionHostSwitch()
}

/** 开关显示值 = **当前生效**值（env 显式关 / 已回退时显示关，避免"勾着却没生效"） */
function extensionHostOn(): boolean {
  return extensionHostDecision().enabled
}

/** 当前生效值的来源说明（设置项 / 环境变量 / 默认 / 启动失败回退） */
function extensionHostSourceText(): string {
  return EXTENSION_HOST_SOURCE_TEXT[extensionHostDecision().source]
}

/** 保存后要提示"重启生效"（只在用户真的动过开关之后显示；进页面不乱弹） */
const extensionHostRestartHint = ref(false)

/**
 * 写开关。**先清回退标记再落库**：回退标记优先级高于设置项（防崩溃循环），不清掉的话
 * 用户点开关会看起来毫无反应。
 */
function onExtensionHostToggle(enabled: boolean): void {
  clearRendererFallback()
  stateStore.setExtensionHostEnabled(enabled)
  extensionHostRestartHint.value = true
}

/** 上次启动失败的回退提示（跨 reload 保留在 sessionStorage 里；没有则空串，整行不渲染） */
function extensionHostFallbackText(): string {
  void settingsRevision.value
  return extensionHostFallbackNotice() ?? ''
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

// ---- modal 字段：不可关闭的等待模态框 ----

/**
 * `modal` 只对 `type: 'status'` 有意义（值仍是字符串）。类型判断里的 `'status'` 走这个常量：
 * 测试门禁用 `src.indexOf("field.type === 'status'")` 定位**模板**里 status 分支的位置，
 * 脚本里再出现同一字面量会把定位点前移，门禁就形同虚设。
 */
const MODAL_FIELD_TYPE: SettingField['type'] = 'status'

/** 是否声明了「以模态框展示」（`modal: true` 且类型是 status） */
function isModalField(field: SettingField): boolean {
  return field.modal === true && field.type === MODAL_FIELD_TYPE
}

/**
 * 模态框的显示判据：值**非空**才显示，空值 ⇒ 什么都不渲染。
 *
 * - 只取**设置存储里的值**（`fieldValue`），**不**回退 `field.default`：扩展若声明了非空
 *   `default`，模态框会在它还没开始任务时就常驻，而且**关不掉**（不可关闭是刻意设计）。
 * - 去空白后再判空：`''` / `'   '` / `'\n'` 都算"没有进度"。渲染一个全空白且关不掉的模态框
 *   等于把设置页锁死，所以这类值按空处理。
 * - 取值经 `fieldValue` ⇒ 与 text/number 字段**同一条响应式路径**（`settingsRevision`）。
 */
function statusHasValue(page: RegisteredSettingsPage, field: SettingField): boolean {
  const raw = fieldValue(page, field.key)
  if (raw === undefined || raw === null) return false
  const text = typeof raw === 'string' ? raw : String(raw)
  return text.trim() !== ''
}

/** 当前生效的等待模态框内容（没有则为 `null`） */
interface WaitModal {
  label: string
  lines: string[]
}

/**
 * 当前该弹出的等待模态框（扫**所有**已注册设置页，而不只是左树选中的那个扩展）：
 * 模态框是"迁移没完不许操作"的阻塞层，若只扫当前选中页，用户点一下左树另一个节点
 * 就能把它"关掉"——那就是一条隐蔽的关闭通路。多个字段同时非空时取第一个。
 *
 * 行文本复用 `statusLines()`（CRLF 归一、拆分多行、去首尾空行）——与只读展示同一套语义。
 */
const activeModal = computed<WaitModal | null>(() => {
  for (const page of extensionPages.value) {
    for (const field of page.fields) {
      if (!isModalField(field) || !statusHasValue(page, field)) continue
      return { label: field.label, lines: statusLines(page, field) }
    }
  }
  return null
})

/**
 * 对话框元素：出现后必须显式 `focus()`，否则键盘焦点留在被遮住的背景上
 * （模态没有关闭按钮、也不接 Esc，焦点跑出去用户就完全失去着力点）。
 */
const modalBox = ref<HTMLElement | null>(null)
watch(
  activeModal,
  async (modal) => {
    if (!modal) return
    await nextTick()
    modalBox.value?.focus()
  },
  { immediate: true }
)

// ---- progress 字段：只读进度条 ----

/**
 * `progress` 的类型判断走这个常量（与上方 `MODAL_FIELD_TYPE` 同一约定）：
 * 接线门禁（test/settings-view-wiring.test.ts）用**带引号的字面量**匹配链上的分支条件，
 * 钉住既有六分支的序列与「directory 尾 → status 起点」「status 尾 → 兜底」两段缝隙的紧邻性。
 * 常量不改变任何语义：模板仍是**一条完整相邻**的 `v-if / v-else-if / v-else` 链，
 * progress 分支仍在链上、仍在兜底之前（为什么必须如此见模板处注释）。
 */
const PROGRESS_FIELD_TYPE: SettingField['type'] = 'progress'

/** progress 字段的显示状态（`progressMetrics` 的输出，模板直接消费） */
interface ProgressMetrics {
  /** 生效上限（`max` 声明缺失/非法时回落 100） */
  max: number
  /** 值是否为有限数字（false ⇒ 按 0 渲染，`progressView` 发去重 warn） */
  numeric: boolean
  /** 填充宽度百分比（0..100，**未取整**——为什么见 `progressMetrics` 文档） */
  width: number
  /** 钳制后向下取整的当前值（`{cur}` 显示与 aria-valuenow 用） */
  now: number
  /** 右侧文本 `{cur}/{max}` */
  text: string
}

/**
 * progress 的显示口径（**纯函数**，不触 store——测试可把它从本文件源码里原样提取后直接跑
 * 行为用例，见 test/settings-progress-field.test.ts，避免"测试里复制一份实现"漂移）：
 *
 * - `{cur}` = `floor(clamp(cur, 0, max))`；条宽 = `clamp(cur, 0, max) / max` 的**未取整**比例。
 *   为什么条宽不取整：宽度若也取整，条与数字会在边界处互相矛盾——cur=99.9 时数字显示
 *   `99/100`，宽度按真实 99.9% 才能"贴边"；两边各自取整则永远对不齐
 *   （pet-settings spec Requirement 2 的显示口径逐字如此）。
 * - 非数字值（`'abc'` / null / undefined / NaN / ±Infinity / 布尔 / 对象）⇒ 按 0 渲染
 *   （`numeric: false`，由 `progressView` 据此发**去重**的 warn），绝不抛错：设置页是宿主
 *   内置页面，扩展写坏一个值不能整页白屏。
 * - `max` 缺省 **100**；`max` 声明本身非法（非数字 / ≤0 / 非有限）⇒ 同样回落 100
 *   （manifest 校验层已把它拦成 error——scripts/validate-manifest.mjs，这里只是运行期自保）。
 */
function progressMetrics(rawValue: unknown, declaredMax: unknown): ProgressMetrics {
  const max =
    typeof declaredMax === 'number' && Number.isFinite(declaredMax) && declaredMax > 0
      ? declaredMax
      : 100
  const numeric = typeof rawValue === 'number' && Number.isFinite(rawValue)
  const cur = numeric ? (rawValue as number) : 0
  const clamped = Math.min(Math.max(cur, 0), max)
  const now = Math.floor(clamped)
  return { max, numeric, width: (clamped / max) * 100, now, text: `${now}/${max}` }
}

/** 已警告过的非法 progress 值（按 fieldSlot 去重：渲染期调用，不能每次重渲染都刷屏） */
const warnedProgressFields = new Set<string>()

/**
 * progress 字段的显示状态（模板的唯一取值入口）。取值路径与 status/text **完全同源**：
 * `fieldValue`（`settingsRevision` → `stateStore.getSetting`，无值回退 `field.default`）⇒
 * 扩展经 `api.settings.set`（= `stateStore.setSetting`，core/host.ts:467）写入数字后，
 * `setSetting` 同步通知订阅者、`settingsRevision++`，已打开的设置页**当帧刷新**——
 * 不需要重进页面，也不需要为 progress 新增任何订阅机制。
 */
function progressView(page: RegisteredSettingsPage, field: SettingField): ProgressMetrics {
  const raw = fieldValue(page, field.key) ?? field.default
  const metrics = progressMetrics(raw, field.max)
  if (!metrics.numeric) {
    const slot = fieldSlot(page, field.key)
    if (!warnedProgressFields.has(slot)) {
      warnedProgressFields.add(slot)
      console.warn(
        `[settings] progress 字段 "${slot}" 的值不是有限数字（收到 ${String(raw)}），已按 0 渲染；请扩展用 api.settings.set 写入 0..max 的数字`
      )
    }
  }
  return metrics
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
      <!--
        AI 节点放在「网络」之后、「通知」之前：AI 配置是"对外连接"类设置（它的「测试连接」还
        直接吃「网络」里的代理），与代理相邻最符合排查路径（连不上时第一反应是查代理）；
        也不插在末尾靠近「通知/扩展」这两个与本地扩展管理相关的节点。
      -->
      <div class="tree-node" :class="{ active: active === 'ai' }" @click="active = 'ai'">
        <span class="tree-label">{{ t('settings.tree.ai') }}</span>
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
        <!--
          扩展执行位置（EH-D2a）：2.0.0 起默认在 Extension Host 进程里跑用户扩展。
          开关写的是**设置项**（`extensionHost.enabled`），判定与回退都在
          `core/extensionHostBridge.ts`；这里**不做热切换**，只提示重启生效。
          放在平台相关项之前：它不是 Windows 专属设置（macOS/Linux 同样生效）。
        -->
        <div class="config-row">
          <label>
            <input
              type="checkbox"
              :checked="extensionHostOn()"
              @change="onExtensionHostToggle(($event.target as HTMLInputElement).checked)"
            />
            在独立进程中运行扩展
          </label>
          <p class="config-desc">
            扩展在独立的 Extension Host 进程中执行，单个扩展卡死或崩溃不会带走主界面。 需重启 Obox
            后生效；关闭后扩展回到主界面进程执行，兼容旧行为。
          </p>
          <p class="config-desc">当前生效：{{ extensionHostSourceText() }}</p>
          <p v-if="extensionHostRestartHint" class="config-info">已保存，重启 Obox 后生效。</p>
          <p v-if="extensionHostFallbackText()" class="config-error">
            {{ extensionHostFallbackText() }}
          </p>
        </div>
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
      <div v-else-if="active === 'network'" class="config-block network-block">
        <h2>{{ t('settings.network.title') }}</h2>
        <p class="config-desc">{{ t('settings.network.proxyDesc') }}</p>
        <div class="config-row">
          <label>
            <input v-model="proxyConfig.enabled" type="checkbox" @change="saveProxy" />
            {{ t('settings.network.enabled') }}
          </label>
        </div>
        <div class="config-row">
          <label>{{ t('settings.network.url') }}</label>
          <input
            v-model="proxyConfig.url"
            class="text-input"
            :placeholder="t('settings.network.urlPlaceholder')"
            @change="saveProxy"
          />
          <!-- 字段说明放在本行内：贴近输入框；与下一个选项的距离由本行 margin-bottom 提供 -->
          <p class="config-desc">{{ t('settings.network.urlHint') }}</p>
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

      <!--
        AI（OpenAI 兼容接口参数）：五个设置键见脚本里的 AI_KEYS，一律走 stateStore。
        本期**只存储 + 展示**（没有消费者会拿它们去调用模型），唯一的动作是「测试连接」。
        决策与取舍（掩码控件为什么不新增公开字段类型、key 明文存储的退场条件、测试连接为什么
        必须在主进程走 netSession）见 docs/adr/0025-host-ai-options.md。
      -->
      <div v-else-if="active === 'ai'" class="config-block ai-block">
        <h2>{{ t('settings.ai.title') }}</h2>
        <p class="config-desc">{{ t('settings.ai.intro') }}</p>

        <div class="config-row">
          <label>{{ t('settings.ai.baseUrl') }}</label>
          <input
            class="text-input"
            :value="aiTextOf(AI_KEYS.baseUrl)"
            :placeholder="t('settings.ai.baseUrlPlaceholder')"
            @change="saveAiText(AI_KEYS.baseUrl, ($event.target as HTMLInputElement).value)"
          />
          <p class="config-desc">{{ t('settings.ai.baseUrlHint') }}</p>
        </div>

        <!--
          apiKey：**本页专用掩码控件**（不新增公开的 SettingFieldType——那属扩展可见能力，
          要 bump apiVersion 3，见 ADR-0025）。
          掩码态只渲染固定圆点串（MASKED_KEY，与密钥长度无关）：**密钥明文不进 DOM**；
          点「显示」才挂载明文输入框（`v-else` 分支里唯一的密钥取值点）。
          切换只改组件内的 showApiKey（不写设置、不落盘、不触发保存）；明文不入任何日志/提示。
        -->
        <div class="config-row">
          <label>{{ t('settings.ai.apiKey') }}</label>
          <div v-if="!showApiKey" class="api-key-row">
            <span class="config-value masked-key">
              {{ hasApiKey() ? MASKED_KEY : t('settings.ai.apiKeyEmpty') }}
            </span>
            <button class="btn" type="button" @click="showApiKey = true">
              {{ t('settings.ai.show') }}
            </button>
          </div>
          <div v-else class="api-key-row">
            <input
              class="text-input"
              type="text"
              :value="aiTextOf(AI_KEYS.apiKey)"
              @input="onApiKeyInput"
            />
            <button class="btn" type="button" @click="showApiKey = false">
              {{ t('settings.ai.hide') }}
            </button>
          </div>
          <p class="config-desc">{{ t('settings.ai.apiKeyHint') }}</p>
        </div>

        <div class="config-row">
          <label>{{ t('settings.ai.model') }}</label>
          <input
            class="text-input"
            :value="aiTextOf(AI_KEYS.model)"
            :placeholder="t('settings.ai.modelPlaceholder')"
            @change="saveAiText(AI_KEYS.model, ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="config-row">
          <label>{{ t('settings.ai.contextLen') }}</label>
          <input
            class="text-input"
            type="number"
            min="1"
            :value="aiNumberTextOf(AI_KEYS.contextLen, DEFAULT_CONTEXT_LEN_TEXT)"
            @change="onContextLenChange"
          />
          <p class="config-desc">
            {{
              t('settings.ai.contextLenHint', {
                default: DEFAULT_CONTEXT_LEN,
                max: MAX_CONTEXT_LEN
              })
            }}
          </p>
        </div>

        <div class="config-row">
          <label>{{ t('settings.ai.dailyLimit') }}</label>
          <input
            class="text-input"
            type="number"
            min="0"
            :value="aiNumberTextOf(AI_KEYS.dailyLimit, '')"
            @change="onDailyLimitChange"
          />
          <p class="config-desc">{{ t('settings.ai.dailyLimitHint') }}</p>
        </div>

        <div class="config-row actions-row">
          <button class="btn" :disabled="aiTestState === 'testing'" @click="testAiConnection">
            {{ aiTestState === 'testing' ? t('settings.ai.testing') : t('settings.ai.test') }}
          </button>
          <!-- 结果：成功绿、失败红（文案由主进程给的中文原因，见 testAiConnection） -->
          <span v-if="aiTestMessage" :class="aiTestOk ? 'config-success' : 'config-error'">
            {{ aiTestMessage }}
          </span>
        </div>
        <p class="config-desc">{{ t('settings.ai.testHint') }}</p>
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
                progress：**只读**进度条（扩展写、宿主只渲染；取值与 status 同一条响应式路径：
                progressView → fieldValue → settingsRevision/stateStore.getSetting）。
                ⚠️ 为什么必须在链尾兜底 v-else **之前**：兜底把未知类型渲染成**可编辑文本框**
                （unknownTypeValue），progress 落到兜底就成了用户能改坏的输入框——宠物三行属性
                会变回三个可编辑框，误编辑即覆盖扩展经 api.settings.set 写的数值状态。
                ⚠️ 为什么插在 select 之后而不是「status 之后」：接线门禁
                （settings-view-wiring.test.ts）把「directory 尾 → status 起点」「status 尾 → 兜底」
                两段缝隙钉死为紧邻（其间不得出现任何分支指令），status 之后没有合法插入点；
                分支顺序对语义无影响（类型互斥，每个字段恰好命中一个分支）。
                类型判断走 PROGRESS_FIELD_TYPE 常量（与 MODAL_FIELD_TYPE 同一约定，见脚本注释）。
                **不渲染** description（spec Requirement 2 的 MUST NOT：行保持紧凑）——
                排除条件写在下方 description <p> 的 v-if 上，不在本分支内另造节点。
              -->
              <div v-else-if="field.type === PROGRESS_FIELD_TYPE" class="progress-field">
                <div
                  class="progress-track"
                  role="progressbar"
                  :aria-label="field.label"
                  :aria-valuemin="0"
                  :aria-valuemax="progressView(page, field).max"
                  :aria-valuenow="progressView(page, field).now"
                >
                  <!-- 填充宽度 = clamp(cur,0,max)/max 的**未取整**百分比（口径见 progressMetrics 注释） -->
                  <div
                    class="progress-fill"
                    :style="{ width: progressView(page, field).width + '%' }"
                  ></div>
                </div>
                <span class="config-value progress-text">{{ progressView(page, field).text }}</span>
              </div>
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
                <!--
                  ⚠️ 错误提示必须放在**这个 div 内部**：`v-if/v-else-if/v-else` 链要求各分支是**相邻兄弟**，
                  一旦在链中间插入一个带 `v-if` 的兄弟元素（这里曾把 `<p v-if="… directoryErrors …">` 放在
                  div 之后），后面的 `v-else-if status` 与 `v-else` 就会**挂到那个 `<p>` 上**，导致
                  所有非 status 字段都额外渲染一个"未知类型兜底文本框"并刷 console.warn。
                -->
                <p v-if="directoryErrors[fieldSlot(page, field.key)]" class="config-error">
                  {{ directoryErrors[fieldSlot(page, field.key)] }}
                </p>
              </div>
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
              <!--
                progress 字段**不渲染** description（即使声明了也忽略——spec Requirement 2 的
                MUST NOT：进度行保持紧凑）。排除条件写在这里而不是给 progress 分支加节点：
                本 <p> 在字段链之外，动它的 v-if 不影响链的完整性。
              -->
              <p v-if="field.description && field.type !== PROGRESS_FIELD_TYPE" class="config-desc">
                {{ field.description }}
              </p>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!--
      等待模态框（字段 modal: true + 值非空）：渲染在**字段行之外**（视图根部的独立节点），
      绝不插进 `v-if / v-else-if / v-else` 字段链中间——插进去会让后面的分支挂到新节点上，
      非 status 字段就会多渲染一个兜底文本框并刷 console.warn（见 directory 分支里的记录）。
      值被扩展清空（api.settings.set(key, '')）⇒ activeModal 变 null ⇒ v-if 立即卸载本节点。
      不可关闭：没有关闭按钮、没有 @click / @keydown（Esc 因此无效、点遮罩不关闭），
      也没有任何 dismiss 通路；遮罩覆盖整个视口并吃掉指针事件，背景既点不到也不会跟着滚。
      焦点：对话框 tabindex="-1" 并在出现后 focus()（按约定不做完整 focus-trap）。
    -->
    <div
      v-if="activeModal"
      class="settings-modal-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="activeModal.label"
    >
      <div ref="modalBox" class="settings-modal" tabindex="-1">
        <h2 class="settings-modal-title">{{ activeModal.label }}</h2>
        <ul v-if="activeModal.lines.length > 1" class="status-lines settings-modal-lines">
          <li v-for="(line, idx) in activeModal.lines" :key="idx">{{ line }}</li>
        </ul>
        <span v-else class="settings-modal-line">{{ activeModal.lines[0] }}</span>
      </div>
    </div>
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
/*
 * 网络分区（代理地址 / 排除列表）的输入框：**按内容区比例缩放**，不再是固定窄条。
 * 之前 `.config-row .text-input` 只有 `min-width: 220px`（连 `http://127.0.0.1:7890` 都显示不全），
 * 后来加宽到固定 440px 在宽窗口下又显得空。现在占满本行可用宽度 ⇒ 随内容区（窗口）等比缩放。
 */
.network-block .config-row .text-input {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}
/*
 * AI 分区：baseUrl / model / 两个数字框都按内容区比例缩放（与网络分区同一理由：地址比
 * 固定 220px 长得多）。**只作用于 `.config-row` 的直接子元素**——apiKey 那一行的输入框在
 * `.api-key-row` 里，由下面的 flex 规则控制宽度。
 */
.ai-block .config-row > .text-input {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}
/* apiKey 掩码行：只读圆点/「未配置」（或明文输入框）+「显示/隐藏」按钮 */
.ai-block .api-key-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ai-block .api-key-row .text-input {
  flex: 1;
  min-width: 0;
}
/*
 * 掩码显示框：沿用输入类控件的底色/边框 token，视觉上就是"一个被遮住的输入框"
 * （不自造色值、不新增主题 token）。
 */
.ai-block .masked-key {
  flex: 1;
  min-width: 0;
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  padding: 5px 8px;
  font-size: 13px;
  /* 圆点串之间留点空隙，读起来像掩码而不是乱码 */
  letter-spacing: 2px;
}
/*
 * 字段级说明（如代理地址下方的 urlHint）：**紧贴它描述的那个控件**，与下一个选项拉开距离。
 * 做法是结构上把说明放进同一个 `.config-row`（见模板），于是上间距由这里给 6px，
 * 下间距由 `.config-row` 自己的 16px margin-bottom 提供 —— 正好是"贴近控件、远离下一项"。
 */
.config-row .config-desc {
  margin-top: 6px;
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
/*
 * progress 字段：只读进度条（槽 + 填充 + 右侧 {cur}/{max} 文本）。
 * 设置页是宿主内置页面 ⇒ 颜色一律走宿主主题 token（不新增 token、不写死色值；
 * var() 的 fallback 是 themes-settings.md token 表记录的文档默认值，与既有写法一致）：
 * 槽 = --bg-input（输入类控件的底色）、填充 = --accent（强调色）、
 * 文本沿用 .config-value（--fg-bright + 等宽字体）。标签列沿用 .config-row label
 * （块级、左对齐、固定样式）——design「UI 视觉规范」硬约束第 3 条：不新造布局。
 */
.config-row .progress-field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.config-row .progress-track {
  flex: 1;
  min-width: 0;
  height: 10px;
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
}
.config-row .progress-fill {
  height: 100%;
  background: var(--accent, #007acc);
}
.config-row .progress-text {
  flex-shrink: 0;
  font-size: var(--font-size-sm, 12px);
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
/*
  等待模态框（字段 modal: true + 值非空）：全屏遮罩 + 对话框。
  遮罩取值沿用上方既有 `.capture-overlay` 的同一个遮罩（不新造色值）；比改键捕获层（5000）更高，
  保证它压在所有内容之上。对话框配色全部走既有主题 token（--bg-panel / --border / --fg*）。
*/
.settings-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 6000;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 遮罩自己吃掉滚轮/触摸滚动，被遮住的设置页不跟着滚 */
  overscroll-behavior: contain;
}
.settings-modal {
  background: var(--bg-panel, #252526);
  border: 1px solid var(--border, #454545);
  border-radius: 4px;
  padding: 20px 28px;
  outline: none;
  max-width: 520px;
  max-height: 70vh;
  overflow-y: auto;
}
.settings-modal-title {
  font-size: 14px;
  color: var(--fg-bright, #e8e8e8);
  margin: 0 0 10px;
}
.settings-modal-line,
.settings-modal-lines {
  font-family: ui-monospace, monospace;
  font-size: var(--font-size-sm, 12px);
  color: var(--fg, #cccccc);
}
/* 多行进度逐行渲染（与 status 字段的 .status-lines 同形，但那是 .config-row 下的选择器） */
.settings-modal-lines {
  margin: 0;
  padding-left: 18px;
}
</style>
