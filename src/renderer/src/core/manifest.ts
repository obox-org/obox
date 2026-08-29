/**
 * manifest 解析与校验。
 * 内置扩展（resources/extensions 或开发期由 Vite 注入）与用户扩展（userData/extensions）统一走这里。
 */
import type { ExtensionInfo, ExtensionManifest, ExtensionSource, ValidationMessage } from './types'
import oboxPackage from '../../../../package.json'

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

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
  if (m.apiVersion !== undefined) {
    const apiVersion = m.apiVersion as unknown
    if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 0) {
      messages.push({ severity: 'error', message: 'apiVersion 必须是大于等于 0 的整数' })
    } else if (apiVersion > oboxPackage.apiVersion) {
      messages.push({ severity: 'error', message: `需要 obox API v${apiVersion} 或更高（当前 obox 为 v${oboxPackage.apiVersion}）` })
    }
  }
  if (typeof m.main !== 'string' || !m.main.trim()) {
    messages.push({ severity: 'error', message: 'main（扩展入口）必填' })
  }
  if (m.contributes !== undefined && typeof m.contributes !== 'object') {
    messages.push({ severity: 'error', message: 'contributes 必须是对象' })
  }
  const contributes = m.contributes as Record<string, unknown> | undefined
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
  if (m.extensionDependencies !== undefined) {
    const deps = m.extensionDependencies as unknown
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
      messages.push({ severity: 'error', message: 'extensionDependencies 必须是字符串数组' })
    }
  }
  if ((m.extensionDependencies as string[] | undefined)?.includes(m.name as string)) {
    messages.push({ severity: 'error', message: '扩展不能依赖自身' })
  }
  return messages
}

/** 构建 ExtensionInfo（扫描/加载后统一构造） */
export function makeExtensionInfo(
  id: string,
  manifest: ExtensionManifest,
  source: ExtensionSource,
  enabled: boolean,
  extra?: { installedTimestamp?: number }
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
    installedTimestamp: extra?.installedTimestamp
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
