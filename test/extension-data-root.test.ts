import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dataDirForExtensionId } from '../src/extension-host/apiFactory'

/**
 * 数据根按 id、不按代码目录（change `system-extensions-from-install-dir` 任务 2.1 / 2.2）。
 *
 * 系统扩展的代码在 `<安装目录>/extensions/<name>`（Program Files，只读），数据必须落在
 * `<userData>/extensions/<id>/data`；否则会写失败或在升级时被覆盖。
 */
describe('扩展数据根', () => {
  it('按 userData + id 计算，与代码目录无关', () => {
    const root = dataDirForExtensionId('C:/Users/x/AppData/Roaming/obox', 'pet.chenzhi')
    expect(root.replace(/\\/g, '/')).toBe(
      'C:/Users/x/AppData/Roaming/obox/extensions/pet.chenzhi/data'
    )
  })

  it('系统扩展（代码在安装目录）也落在 userData', () => {
    const userData = 'C:/Users/x/AppData/Roaming/obox'
    const root = dataDirForExtensionId(userData, 'settings').replace(/\\/g, '/')
    expect(root).toBe(`${userData}/extensions/settings/data`)
    expect(root).not.toContain('Program Files')
  })

  it('id 里的点号不会被当成路径分隔', () => {
    const root = dataDirForExtensionId('C:/u', 'pet.chenzhi').replace(/\\/g, '/')
    expect(root).toBe('C:/u/extensions/pet.chenzhi/data')
  })

  it('宿主装配使用 userDataDir，而不是 ext.path 推导（源码门禁）', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/extension-host/apiFactory.ts', import.meta.url)),
      'utf8'
    )
    expect(src).toContain('dataDirForExtensionId(')
    // 装配处必须读 options.userDataDir（未给时才回退到旧的按目录推导）
    expect(src).toContain('options.userDataDir')
    // 回退分支必须在 userDataDir 之后（顺序保证"优先按 id"）
    expect(src.indexOf('options.userDataDir')).toBeLessThan(
      src.indexOf('extensionDataDirOf(extensionDir)')
    )
  })
})
