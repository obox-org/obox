import { describe, expect, it } from 'vitest'
import {
  expectedExtensionId,
  toUserExtensionEntry,
  isLegacyExtensionDirName,
  resolveExtensionRoot,
  scanExtensionSources,
  systemExtensionError,
  selectLoadableExtensions,
  type ScannedExtension
} from '../src/main/extensionSources'

/**
 * 双根扫描规则（change `system-extensions-from-install-dir` 的任务 1.2 / 1.3 / 1.5）。
 *
 * 用假目录树注入 IO：扫描规则不该靠真机验证。
 */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

function tree(files: Record<string, { name?: string; author?: string } | null>): {
  listDirectories: (root: string) => Promise<string[]>
  readManifest: (dir: string) => Promise<{ name?: unknown; author?: unknown } | null>
} {
  const dirs = Object.entries(files).map(([dir, manifest]) => ({ dir: norm(dir), manifest }))
  return {
    listDirectories: async (root: string): Promise<string[]> => {
      const base = norm(root)
      return dirs
        .filter((d) => d.dir.startsWith(`${base}/`))
        .map((d) => d.dir.slice(base.length + 1))
    },
    readManifest: async (dir: string): Promise<{ name?: unknown; author?: unknown } | null> => {
      const target = norm(dir)
      const hit = dirs.find((d) => d.dir === target)
      return hit ? (hit.manifest as { name?: unknown; author?: unknown } | null) : null
    }
  }
}

const SYSTEM = 'C:/app/extensions'
const USER = 'C:/user/extensions'

async function scan(
  files: Record<string, { name?: string; author?: string } | null>
): Promise<{ entries: ScannedExtension[]; warnings: string[] }> {
  const warnings: string[] = []
  const entries = await scanExtensionSources({
    systemRoot: SYSTEM,
    userRoot: USER,
    ...tree(files),
    warn: (m: string) => warnings.push(m)
  })
  return { entries, warnings }
}

describe('扩展来源扫描', () => {
  it('系统根：目录名即 id，author 必须是 obox', async () => {
    const { entries } = await scan({
      [`${SYSTEM}/settings`]: { name: 'settings', author: 'obox' },
      [`${SYSTEM}/app`]: { name: 'app', author: 'obox' }
    })
    expect(entries.map((e) => [e.id, e.source, e.error])).toEqual([
      ['settings', 'system', undefined],
      ['app', 'system', undefined]
    ])
  })

  it('用户根：目录名必须是 <name>.<author>', async () => {
    const { entries, warnings } = await scan({
      [`${USER}/pet.chenzhi`]: { name: 'pet', author: 'chenzhi' },
      [`${USER}/bad_name`]: { name: 'bad', author: 'name' }
    })
    const pet = entries.find((e) => e.id === 'pet.chenzhi')
    expect(pet?.source).toBe('user')
    expect(pet?.error).toBeUndefined()
    // 下划线命名不识别，且只告警一次
    expect(entries.some((e) => e.id === 'bad_name')).toBe(false)
    expect(warnings.filter((w) => w.includes('跳过旧命名目录'))).toHaveLength(1)
  })

  it('同 id：系统优先，用户那份标 shadowed', async () => {
    const { entries } = await scan({
      [`${SYSTEM}/settings`]: { name: 'settings', author: 'obox' },
      [`${USER}/settings`]: { name: 'settings', author: 'obox' }
    })
    const system = entries.find((e) => e.id === 'settings' && e.source === 'system')
    const user = entries.find((e) => e.id === 'settings' && e.source === 'user')
    expect(system?.shadowed).toBeUndefined()
    expect(user?.shadowed).toBe(true)
    // 可加载集合只保留系统那份
    expect(selectLoadableExtensions(entries).map((e) => e.source)).toEqual(['system'])
  })

  it('系统扩展 author 不是 obox ⇒ 记 error 且不加载', async () => {
    const { entries } = await scan({
      [`${SYSTEM}/pet`]: { name: 'pet', author: 'chenzhi' }
    })
    expect(entries[0].error).toContain('author 必须是 obox')
    expect(selectLoadableExtensions(entries)).toEqual([])
  })

  it('系统扩展目录名与清单 name 不一致 ⇒ error', async () => {
    const { entries } = await scan({
      [`${SYSTEM}/settings`]: { name: 'preferences', author: 'obox' }
    })
    expect(entries[0].error).toContain('目录名必须等于清单 name')
  })

  it('用户扩展清单拼不出目录名 ⇒ error', async () => {
    const { entries } = await scan({
      [`${USER}/pet.other`]: { name: 'pet', author: 'chenzhi' }
    })
    expect(entries[0].error).toContain('<name>.<author>')
  })

  it('没有 manifest 的目录静默跳过（数据目录/安装暂存）', async () => {
    const { entries, warnings } = await scan({
      [`${USER}/pet.chenzhi`]: { name: 'pet', author: 'chenzhi' },
      [`${USER}/some.data`]: null
    })
    expect(entries).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('根目录不存在时不抛错', async () => {
    const entries = await scanExtensionSources({
      systemRoot: 'C:/nope',
      userRoot: 'C:/also-nope',
      listDirectories: async () => {
        throw new Error('ENOENT')
      },
      readManifest: async () => null
    })
    expect(entries).toEqual([])
  })

  it('expectedExtensionId / isLegacyExtensionDirName 与扫描规则一致', () => {
    expect(expectedExtensionId('system', { name: 'settings', author: 'obox' })).toBe('settings')
    expect(expectedExtensionId('user', { name: 'pet', author: 'chenzhi' })).toBe('pet.chenzhi')
    expect(expectedExtensionId('user', { name: 'pet' })).toBe('pet')
    expect(expectedExtensionId('user', {})).toBeNull()
    expect(isLegacyExtensionDirName('pet_chenzhi')).toBe(true)
    expect(isLegacyExtensionDirName('pet.chenzhi')).toBe(false)
    expect(isLegacyExtensionDirName('settings')).toBe(false)
  })
})
describe('IPC 载荷映射', () => {
  it('正常条目只带 id/path/source；遮蔽与错误才追加字段', () => {
    expect(
      toUserExtensionEntry({ id: 'settings', source: 'system', dir: 'C:/app/extensions/settings' })
    ).toEqual({ id: 'settings', path: 'C:/app/extensions/settings', source: 'system' })
    expect(
      toUserExtensionEntry({
        id: 'settings',
        source: 'user',
        dir: 'C:/user/extensions/settings',
        shadowed: true
      })
    ).toEqual({
      id: 'settings',
      path: 'C:/user/extensions/settings',
      source: 'user',
      shadowed: true
    })
    expect(
      toUserExtensionEntry({ id: 'x', source: 'user', dir: 'C:/u/x', error: '坏清单' })
    ).toEqual({ id: 'x', path: 'C:/u/x', source: 'user', error: '坏清单' })
  })
})
describe('根解析与系统扩展保护', () => {
  const roots = { systemRoot: 'C:/app/extensions', userRoot: 'C:/user/extensions' }
  const existsIn =
    (dirs: string[]) =>
    (dir: string): boolean =>
      dirs.includes(dir.replace(/\\/g, '/'))

  it('同 id 两个根都有 ⇒ 系统根优先', () => {
    const root = resolveExtensionRoot(
      'settings',
      roots,
      existsIn(['C:/app/extensions/settings', 'C:/user/extensions/settings'])
    )
    expect(root).toBe(roots.systemRoot)
  })

  it('只在用户根 ⇒ 用户根', () => {
    expect(
      resolveExtensionRoot('pet.chenzhi', roots, existsIn(['C:/user/extensions/pet.chenzhi']))
    ).toBe(roots.userRoot)
  })

  it('两个根都没有 ⇒ null', () => {
    expect(resolveExtensionRoot('nope', roots, () => false)).toBeNull()
  })

  it('系统扩展不可卸载/禁用；用户扩展不受限', () => {
    const entries = [
      { id: 'settings', source: 'system' as const, dir: 'C:/app/extensions/settings' },
      { id: 'pet.chenzhi', source: 'user' as const, dir: 'C:/user/extensions/pet.chenzhi' }
    ]
    expect(systemExtensionError(entries, 'settings', '卸载')).toContain('系统扩展不可卸载')
    expect(systemExtensionError(entries, 'settings', '禁用')).toContain('系统扩展不可禁用')
    expect(systemExtensionError(entries, 'pet.chenzhi', '卸载')).toBeNull()
  })
})
