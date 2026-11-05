import { describe, expect, it } from 'vitest'
import { deriveDirName } from '../src/main/oixCore'
import { expectedExtensionId, scanExtensionSources } from '../src/main/extensionSources'

/**
 * 用户扩展目录名规则（change `system-extensions-from-install-dir`）：`<name>.<author>`。
 *
 * 安装器（`deriveDirName`）与扫描器（`expectedExtensionId`）必须**逐字同一规则**，
 * 否则装完的扩展会被扫描判成"目录名与清单不一致"而不加载（真机验收会直接撞上）。
 */
describe('用户扩展目录名', () => {
  it('安装器用点号连接 name 与 author', () => {
    expect(deriveDirName('pet', 'chenzhi')).toBe('pet.chenzhi')
    expect(deriveDirName('rdp', 'chenzhi')).toBe('rdp.chenzhi')
  })

  it('author 做同样的清洗：小写 + 去掉非法字符', () => {
    expect(deriveDirName('pet', 'Chen Zhi')).toBe('pet.chenzhi')
    expect(deriveDirName('pet', '')).toBe('pet')
    expect(deriveDirName('pet', undefined)).toBe('pet')
  })

  it('扫描器的期望 id 与安装器一致（含大小写/空格清洗）', () => {
    expect(expectedExtensionId('user', { name: 'pet', author: 'chenzhi' })).toBe('pet.chenzhi')
    expect(expectedExtensionId('user', { name: 'pet', author: 'Chen Zhi' })).toBe('pet.chenzhi')
    expect(expectedExtensionId('user', { name: 'pet' })).toBe('pet')
    expect(expectedExtensionId('system', { name: 'app', author: 'obox' })).toBe('app')
  })

  it('用安装器算出的目录名去扫描，能通过一致性校验', async () => {
    const dirName = deriveDirName('pet', 'chenzhi')
    const entries = await scanExtensionSources({
      systemRoot: 'C:/sys',
      userRoot: 'C:/user',
      // 系统根为空、只有用户根有这个目录（否则会被当成系统扩展而 author 校验失败）
      listDirectories: async (root: string) => (root === 'C:/user' ? [dirName] : []),
      readManifest: async () => ({ name: 'pet', author: 'chenzhi' })
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('pet.chenzhi')
    expect(entries[0].error).toBeUndefined()
  })
})
