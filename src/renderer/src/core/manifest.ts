/**
 * manifest 解析与校验。
 * 内置扩展（resources/extensions 或开发期由 Vite 注入）与用户扩展（userData/extensions）统一走这里。
 */
import type { ExtensionInfo, ExtensionManifest, ExtensionSource, ValidationMessage } from './types'
import { checkIpcChannelList } from '../../../shared/ipcDeclaration'
import {
  ACTIVATION_EVENT_PREFIXES,
  parseActivationEvent,
  type ActivationReason
} from '../../../shared/extensionHostProtocol'
import oboxPackage from '../../../../package.json'

// issue #77：此前带 `i`，`MyExt`/`MY-EXT` 这类大写 id 会被接受；现按测试意图收紧为**仅小写**，
// 大写 id 一律「清单无效」。这是行为变更（已安装的大写 id 用户扩展会变成无效清单）。
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

/* -------------------------------------------------------------------------------------------- */
/* 激活事件（EH-C1 / ADR-0026 决策 6）                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * 4 类激活事件的**合法取值说明**。每一条激活事件 error 都带上它：用户不必去翻文档就知道该写什么。
 *
 * 与 `scripts/validate-manifest.mjs` 的同名常量**逐字一致**（差分门禁
 * `test/manifest-script-parity.test.ts` 比对整条文案，漂移会红）。
 */
export const ACTIVATION_EVENT_HINT = '合法值：* / onStartupFinished / onCommand:<id> / onView:<id>'

/** 清单里能写的 4 类激活事件（字符串形态）；结构化形态见 `ActivationReason` */
export type ManifestActivationEvent =
  '*' | 'onStartupFinished' | `onCommand:${string}` | `onView:${string}`

/**
 * 带 `activationEvents` 的清单类型（字段本身按 `unknown` 防御读取：它来自用户磁盘上的 JSON）。
 *
 * `ExtensionManifest`（`src/api/manifest.ts`）**尚未**声明该字段（EH-C1 的改动面被限定在
 * `core/`；字段进公共类型要连带改扩展脚手架的 d.ts，归 EH-D1 的文档/类型卡）。在补齐之前，
 * 仓库内读这个字段一律经本类型断言，避免各处各写一份 `as unknown as …`。
 */
export type ManifestWithActivationEvents = ExtensionManifest & { activationEvents?: unknown }

/** 错误文案里描述一个非字符串的激活事件值（`5` / `true` / `{}` / `null` …） */
function describeActivationValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 解析清单 `activationEvents`：**校验与归一化共用这一份**（宿主运行期 `loader` 也走它）。
 *
 * 返回结构化 `reasons` 与逐条中文问题：
 * - 缺失（`undefined` / `null`）⇒ 0 条 + 0 个问题（**缺省 = `*`**，由 `withDefaultActivation` 补；
 *   现有 5 个扩展都不写这个字段，行为必须不变）；
 * - 非数组 ⇒ 1 个问题；
 * - 逐项：非字符串 / 认不出的字符串 / `<id>` 为空 ⇒ 各 1 个问题（**一处错一行**，不是整段一句）。
 *
 * 合法/非法的判定**只由 `parseActivationEvent()` 决定**（`src/shared/extensionHostProtocol.ts`，
 * 宿主分派激活用的同一套语义），本文件不写第二份前缀解析——两处解析迟早分叉。
 * 唯一在本文件追加的判据是「`<id>` 不能只有空白」：`parseActivationEvent('onCommand:  ')` 会解出
 * `{ command: '  ' }`，而协议侧 `validateActivationReason` 要求 `command.trim()` 非空；不在这里
 * 拦下的话，清单能过、激活信封却会被宿主判 `EH_INTERNAL`。
 */
export function analyzeActivationEvents(raw: unknown): {
  reasons: ActivationReason[]
  problems: string[]
} {
  const reasons: ActivationReason[] = []
  const problems: string[] = []
  if (raw === undefined || raw === null) return { reasons, problems }
  if (!Array.isArray(raw)) {
    problems.push(`activationEvents 必须是字符串数组（${ACTIVATION_EVENT_HINT}）`)
    return { reasons, problems }
  }
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i]
    const at = `activationEvents 第 ${i + 1} 项`
    if (typeof item !== 'string') {
      problems.push(
        `${at}必须是字符串（收到 ${describeActivationValue(item)}，${ACTIVATION_EVENT_HINT}）`
      )
      continue
    }
    const parsed = parseActivationEvent(item)
    if (!parsed) {
      // `onCommand:` / `onView:` 这种「前缀对、后缀空」的写法单独给可执行文案：
      // 用户最常见的错就是写了前缀忘了 id，回「不受支持」会让人以为自己记错了事件名。
      const barePrefix =
        item === ACTIVATION_EVENT_PREFIXES.command || item === ACTIVATION_EVENT_PREFIXES.view
      problems.push(
        barePrefix
          ? `${at} ${JSON.stringify(item)} 的 <id> 不能为空（${ACTIVATION_EVENT_HINT}）`
          : `${at} ${JSON.stringify(item)} 不受支持（${ACTIVATION_EVENT_HINT}）`
      )
      continue
    }
    if (typeof parsed === 'object') {
      const target = 'command' in parsed ? parsed.command : parsed.view
      if (target.trim() === '') {
        problems.push(`${at} ${JSON.stringify(item)} 的 <id> 不能为空（${ACTIVATION_EVENT_HINT}）`)
        continue
      }
    }
    reasons.push(parsed)
  }
  return { reasons, problems }
}

/**
 * `reasons` 为空时补 `*`（缺省 = 立即激活）——**缺省语义的唯一实现**。
 * 非法项已被 `analyzeActivationEvents` 剔除；全部非法时同样退回 `['*']`：宁可照旧立即激活，
 * 也不要因为清单写错让扩展永不激活（清单错误本身已让该扩展标红 + 不加载）。
 */
export function withDefaultActivation(reasons: readonly ActivationReason[]): ActivationReason[] {
  return reasons.length > 0 ? [...reasons] : ['*']
}

/**
 * 清单 `activationEvents` → 宿主要的结构化 `ActivationReason[]`（纯归一化，不报错）。
 * 缺失 / 空数组 / 全非法 ⇒ `['*']`。重复声明**不去重**：宿主 `Activator.dispatch()` 对同一扩展
 * 只激活一次（`active` 表），保留用户原文更便于日志里对照清单。
 */
export function normalizeActivationEvents(raw: unknown): ActivationReason[] {
  return withDefaultActivation(analyzeActivationEvents(raw).reasons)
}

/** 校验 manifest，返回错误消息列表（空 = 合法） */
export function validateManifest(raw: unknown): ValidationMessage[] {
  const messages: ValidationMessage[] = []
  if (!raw || typeof raw !== 'object') {
    return [{ severity: 'error', message: 'manifest 必须是 JSON 对象' }]
  }
  const m = raw as Record<string, unknown>

  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) {
    messages.push({ severity: 'error', message: 'name 必填，且只能含字母/数字/./_/-' })
  }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) {
    messages.push({ severity: 'error', message: 'version 必填且必须是 semver（如 1.0.0）' })
  }
  // apiVersion 门槛：宿主值**单源**读根 `package.json` 的 `apiVersion`（ADR-0026 决策 8 起为 **3**，
  // 运行时环境变了：无 DOM/localStorage、能力来自宿主进程）。规则本身不变——清单声明 **高于**宿主值
  // 才拒绝加载（`2 <= 3` 合法：pet 这类老扩展照常加载）；文案里的"当前 obox 为 vN"也由该字段给出，
  // 不硬编码版本号，升级时不需要再回来改这一句。
  if (m.apiVersion !== undefined) {
    const apiVersion = m.apiVersion as unknown
    if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 0) {
      messages.push({ severity: 'error', message: 'apiVersion 必须是大于等于 0 的整数' })
    } else if (apiVersion > oboxPackage.apiVersion) {
      messages.push({
        severity: 'error',
        message: `需要 obox API v${apiVersion} 或更高（当前 obox 为 v${oboxPackage.apiVersion}）`
      })
    }
  }
  if (typeof m.main !== 'string' || !m.main.trim()) {
    messages.push({ severity: 'error', message: 'main（扩展入口）必填' })
  }
  // 激活事件（EH-C1 / ADR-0026 决策 6）：只认 4 类 + 缺省 `*`。未知事件 / `<id>` 空 / 非字符串一律
  // **error**——扩展被标记无效（isValid=false）且 loader 不再收集它，而不是"静默按 * 立即激活"。
  // 解析只走 `analyzeActivationEvents`（内部复用宿主侧 `parseActivationEvent`），不写第二份。
  for (const problem of analyzeActivationEvents(m.activationEvents).problems) {
    messages.push({ severity: 'error', message: problem })
  }
  if (m.contributes !== undefined && typeof m.contributes !== 'object') {
    messages.push({ severity: 'error', message: 'contributes 必须是对象' })
  }
  const contributes = m.contributes as Record<string, unknown> | undefined
  if (contributes?.ipcChannels !== undefined) {
    // issue #45：静态声明的 IPC 通道。复用与运行时声明**同一套**校验（src/shared/ipcDeclaration.ts），
    // 非法即让清单无效（扩展标红 + 明确错误），而不是等到 connect() 才炸。
    const checked = checkIpcChannelList(contributes.ipcChannels)
    if (!checked.ok) {
      messages.push({
        severity: 'error',
        message: `contributes.ipcChannels 非法：${checked.message}`
      })
    }
  }
  if (contributes?.keybindings !== undefined) {
    const kb = contributes.keybindings as unknown
    if (
      !Array.isArray(kb) ||
      kb.some(
        (k) =>
          !k ||
          typeof k !== 'object' ||
          typeof (k as Record<string, unknown>).command !== 'string' ||
          typeof (k as Record<string, unknown>).key !== 'string'
      )
    ) {
      messages.push({ severity: 'error', message: 'keybindings 必须是 [{command, key}] 数组' })
    }
  }
  if (contributes?.menus !== undefined) {
    const menus = contributes.menus as unknown
    if (
      !Array.isArray(menus) ||
      menus.some(
        (m) =>
          !m || typeof m !== 'object' || typeof (m as Record<string, unknown>).command !== 'string'
      )
    ) {
      messages.push({ severity: 'error', message: 'menus 必须是 [{command, when?}] 数组' })
    }
  }
  if (contributes?.views !== undefined) {
    const views = contributes.views as unknown
    if (
      !Array.isArray(views) ||
      views.some((v) => {
        const vv = v as Record<string, unknown> | null
        return (
          !vv ||
          typeof vv !== 'object' ||
          typeof vv.id !== 'string' ||
          typeof vv.title !== 'string' ||
          typeof vv.icon !== 'string'
        )
      })
    ) {
      messages.push({ severity: 'error', message: 'views 必须是 [{id, title, icon, group?}] 数组' })
    }
  }
  // issue #84：以下四类此前**完全不校验**形状，`"navItems": {}` 这种会让宿主注册期
  // `for...of` 抛 `TypeError: … is not iterable` 的清单能通过校验并进入激活阶段。
  // 这里只补"必须是数组"（与上面四类同风格）；数组里逐项缺字段仍是宿主侧的 warning，不是 error。
  if (contributes?.navItems !== undefined && !Array.isArray(contributes.navItems)) {
    messages.push({
      severity: 'error',
      message: 'navItems 必须是 [{id, title, icon, view?}] 数组'
    })
  }
  if (contributes?.statusBarItems !== undefined && !Array.isArray(contributes.statusBarItems)) {
    messages.push({ severity: 'error', message: 'statusBarItems 必须是 [{id, name}] 数组' })
  }
  if (contributes?.commands !== undefined && !Array.isArray(contributes.commands)) {
    messages.push({ severity: 'error', message: 'commands 必须是 [{command, title}] 数组' })
  }
  if (contributes?.themes !== undefined && !Array.isArray(contributes.themes)) {
    messages.push({ severity: 'error', message: 'themes 必须是 [{id, label, tokens}] 数组' })
  }
  const deps = m.extensionDependencies as unknown
  const invalidShape = !Array.isArray(deps) || deps.some((d) => typeof d !== 'string')
  if (deps !== undefined && invalidShape) {
    messages.push({ severity: 'error', message: 'extensionDependencies 必须是字符串数组' })
  }
  // 自依赖检查先判数组：非数组（{} / 5 / true）时 `?.includes` 不短路、会抛 TypeError 打断扫描（#83）
  if (Array.isArray(deps) && deps.includes(m.name as string)) {
    messages.push({ severity: 'error', message: '扩展不能依赖自身' })
  }
  return messages
}

/**
 * 贡献点数组形状防御（issue #84）：宿主消费 `contributes` 前统一走这里。
 *
 * manifest 把某类贡献点写成非数组（`{}` / `5` / `true`）时，`c.x ?? []` 只做空值兜底，
 * `for...of` 会抛 `TypeError: … is not iterable` 并打断整轮注册/激活。
 * 校验层已为 8 类贡献点补了 error（本文件上方），但宿主侧仍要自保：
 * 校验只在扫描期跑一次，热重载、旧清单快照、将来新增的读取点都可能绕过它。
 */
export function contributesArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** 构建 ExtensionInfo（扫描/加载后统一构造） */
export function makeExtensionInfo(
  id: string,
  manifest: ExtensionManifest,
  source: ExtensionSource,
  enabled: boolean,
  extra?: {
    installedTimestamp?: number
    pendingInstall?: { version: string; at: number; previousVersion?: string }
  }
): ExtensionInfo {
  const validations = validateManifest(manifest)
  return {
    id,
    manifest,
    source,
    isValid: validations.length === 0 || !validations.some((v) => v.severity === 'error'),
    validations,
    enabled,
    isActive: false,
    installedTimestamp: extra?.installedTimestamp,
    pendingInstall: extra?.pendingInstall
  }
}

/** 依赖拓扑排序：返回激活顺序；检测环（环内扩展排在最后并标记） */
export function topoSort(extensions: ExtensionInfo[]): {
  ordered: ExtensionInfo[]
  cyclic: ExtensionInfo[]
} {
  const byId = new Map(extensions.map((e) => [e.id, e]))
  const visited = new Set<string>()
  const stack = new Set<string>()
  const ordered: ExtensionInfo[] = []
  const cyclic = new Set<string>()

  function visit(id: string): void {
    if (visited.has(id) || cyclic.has(id)) return
    if (stack.has(id)) {
      cyclic.add(id)
      return
    }
    stack.add(id)
    const ext = byId.get(id)
    if (ext) {
      for (const dep of ext.manifest.extensionDependencies ?? []) {
        if (byId.has(dep)) visit(dep)
        // 缺失依赖：跳过（不阻塞），扩展仍激活
      }
    }
    stack.delete(id)
    visited.add(id)
    if (ext) ordered.push(ext)
  }

  for (const ext of extensions) visit(ext.id)
  // 环内扩展也进 ordered（最后），但标记 cyclic
  const cyclicList = extensions.filter((e) => cyclic.has(e.id))
  for (const c of cyclicList) {
    if (!ordered.includes(c)) ordered.push(c)
  }
  return { ordered, cyclic: cyclicList }
}
