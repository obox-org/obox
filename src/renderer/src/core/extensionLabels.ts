/**
 * 扩展贡献文本的 `%key%` 解析（change `unified-page-context` 任务 4.1）。
 *
 * manifest 里由**壳子渲染**的文本（`displayName` / `description` / `navItems[].title` /
 * `commands[].title` / `statusBarItems[].name` / `settings.title` 与字段 `label`/`description` /
 * 主题 `label`）可以写成 `%key%`，宿主按**该贡献所属扩展**的 `contributes.i18n` 解析。
 *
 * 为什么不用内联 `{ zh, en }`：词条会与 `contributes.i18n` 形成两套源，页面与标签各存一份，
 * 改文案要改两处；`%key%` 复用已有词条（`api.i18n` 与页面上下文用的是同一份）。
 *
 * 缺 key 的行为：返回**占位符原文**（`%nav.home%`）并对每个扩展的每个 key 只告警一次。
 * 不回退成"去掉百分号"或 key 名——界面出现 `nav.home` 这种半截文本更难排查。
 */
import { getExtensionMessages } from './extensionI18n'

/** `%key%` 占位符：整串必须就是一个占位符（`xx %key% yy` 这种拼接不支持，避免误伤含 `%` 的普通文本） */
const PLACEHOLDER_RE = /^%([^%]+)%$/

/** 已告警过的 `扩展id:key`（同一个 key 不重复刷日志；测试用 `resetLabelWarnings` 清） */
const warned = new Set<string>()

/**
 * 解析一条扩展贡献文本。
 *
 * @param value manifest 里的原文（非字符串一律按空串处理：清单校验层已挡，但导入路径可能绕过）
 * @param extensionId 贡献所属扩展（决定用哪份词条）
 * @param locale 显式语言（缺省取当前界面语言；测试用）
 */
export function resolveExtensionLabel(
  value: unknown,
  extensionId: string,
  locale?: 'zh' | 'en'
): string {
  if (typeof value !== 'string' || value === '') return ''
  const match = PLACEHOLDER_RE.exec(value)
  if (!match) return value
  const key = match[1].trim()
  if (key === '') return value
  const messages = getExtensionMessages(extensionId, locale)
  const hit = messages[key]
  if (hit !== undefined) return hit
  const warnKey = `${extensionId}:${key}`
  if (!warned.has(warnKey)) {
    warned.add(warnKey)
    console.warn(`[i18n] 扩展 ${extensionId} 的文本引用了不存在的词条 %${key}%（已显示占位符原文）`)
  }
  return value
}

/** 清空告警去重表（单测用；生产不需要调用） */
export function resetLabelWarnings(): void {
  warned.clear()
}

/**
 * 解析一个扩展条目里的 manifest 标签（`displayName` / `description`）。
 *
 * 为什么放在这里而不是 `hostQueryDeps`：扩展管理器与设置页拿到的条目必须是**成品文本**，
 * 而这条规则只应有一份实现——集中在此，方便单测直接断言"页面拿到的是解析后的文本"。
 */
export function resolveManifestLabels<T extends { id: string; manifest?: Record<string, unknown> }>(
  ext: T
): T {
  const manifest = ext.manifest
  if (!manifest) return ext
  return {
    ...ext,
    manifest: {
      ...manifest,
      ...(manifest.displayName === undefined
        ? {}
        : { displayName: resolveExtensionLabel(manifest.displayName, ext.id) }),
      ...(manifest.description === undefined
        ? {}
        : { description: resolveExtensionLabel(manifest.description, ext.id) })
    }
  }
}

/** 设置字段的 `label`/`description` 一次性解析（页面快照里成批出现） */
export function resolveFieldLabels<T extends { label?: unknown; description?: unknown }>(
  field: T,
  extensionId: string
): T {
  return {
    ...field,
    ...(field.label === undefined
      ? {}
      : { label: resolveExtensionLabel(field.label, extensionId) }),
    ...(field.description === undefined
      ? {}
      : { description: resolveExtensionLabel(field.description, extensionId) })
  }
}
