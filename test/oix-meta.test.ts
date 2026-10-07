/**
 * 扩展元数据读写（`.obox-meta.json`）的测试：兼容旧文件、失败也记录、清 pendingInstall（issue #52）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readExtensionMeta, recordInstallHookResult } from '../src/main/oixCore'

let dir = ''
const metaPath = (): string => join(dir, '.obox-meta.json')

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'obox-meta-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('readExtensionMeta', () => {
  it('文件不存在 → 空对象（旧安装/未安装都能安全读）', async () => {
    await expect(readExtensionMeta(dir)).resolves.toEqual({})
  })

  it('JSON 损坏或非对象 → 空对象，不抛错', async () => {
    await fs.writeFile(metaPath(), '{ not json', 'utf8')
    await expect(readExtensionMeta(dir)).resolves.toEqual({})
    await fs.writeFile(metaPath(), '"a string"', 'utf8')
    await expect(readExtensionMeta(dir)).resolves.toEqual({})
  })

  it('读回已有字段（含旧文件的 installedTimestamp）', async () => {
    await fs.writeFile(metaPath(), JSON.stringify({ installedTimestamp: 123, extra: true }), 'utf8')
    await expect(readExtensionMeta(dir)).resolves.toMatchObject({ installedTimestamp: 123 })
  })
})

describe('recordInstallHookResult', () => {
  it('写入 install 记录并保留其它字段（如安装时间戳）', async () => {
    await fs.writeFile(metaPath(), JSON.stringify({ installedTimestamp: 111 }), 'utf8')
    const next = await recordInstallHookResult(dir, '1.2.0', true, 999)
    expect(next).toEqual({
      installedTimestamp: 111,
      install: { version: '1.2.0', at: 999, ok: true }
    })
    await expect(readExtensionMeta(dir)).resolves.toEqual(next)
  })

  it('清除 pendingInstall（跑过就不再补跑）', async () => {
    await fs.writeFile(
      metaPath(),
      JSON.stringify({ pendingInstall: { version: '1.2.0', at: 5 } }),
      'utf8'
    )
    const next = await recordInstallHookResult(dir, '1.2.0', false, 999)
    expect(next.pendingInstall).toBeUndefined()
    expect(next.install).toEqual({ version: '1.2.0', at: 999, ok: false })
  })

  it('元数据文件不存在时也能写出（重装/手工删除后仍可用）', async () => {
    const next = await recordInstallHookResult(dir, '1.0.0', true, 7)
    expect(next).toEqual({ install: { version: '1.0.0', at: 7, ok: true } })
    await expect(fs.readFile(metaPath(), 'utf8')).resolves.toContain('"1.0.0"')
  })
})
