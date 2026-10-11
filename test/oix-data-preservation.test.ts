/**
 * 扩展运行时数据目录（`<扩展目录>/data`）的两条新规则：
 * 1. **覆盖安装保留 `data/`**——此前整体替换目录会把 `api.sqlite` 的库与 `api.fs` 的文件一起删掉；
 * 2. **包内不得含 `data/`**——否则旧包会用陈旧数据覆盖用户数据。
 */
import { afterEach, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { promises as fs, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXT_DATA_DIR, OixInstallError, installFromPackage } from '../src/main/oixCore'

const workDir = join(tmpdir(), `obox-data-${process.pid}-${Date.now()}`)
const targetRoot = join(workDir, 'extensions')
const tmpRoot = join(targetRoot, '.tmp')

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

async function makeOix(
  fileName: string,
  entries: Array<[string, string]>,
  manifest: Record<string, unknown>
): Promise<string> {
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'))
  for (const [p, content] of entries) zip.addFile(p, Buffer.from(content, 'utf8'))
  const file = join(workDir, fileName)
  zip.writeZip(file)
  return file
}

const manifest = (version: string): Record<string, unknown> => ({
  name: 'probe-ext',
  version,
  main: './index.js',
  author: 'chenzhi'
})

describe('扩展 data/ 目录：升级保留 + 包内禁含', () => {
  it('覆盖安装保留 data/（库与文件都还在），入口更新为新版本', async () => {
    await fs.mkdir(targetRoot, { recursive: true })
    const opts = { targetRoot, tmpRoot }

    await installFromPackage(await makeOix('v1.oix', [['index.js', 'v1']], manifest('1.0.0')), opts)

    const dataDir = join(targetRoot, 'probe-ext_chenzhi', EXT_DATA_DIR)
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(join(dataDir, 'rdp.db'), 'SQLite format 3\0', 'utf8')
    await fs.writeFile(join(dataDir, 'notes.txt'), '用户数据', 'utf8')

    const upgraded = await installFromPackage(
      await makeOix('v2.oix', [['index.js', 'v2']], manifest('2.0.0')),
      opts
    )
    expect(upgraded.replaced).toBe(true)

    // 新版本入口已就位
    expect(await fs.readFile(join(targetRoot, 'probe-ext_chenzhi', 'index.js'), 'utf8')).toBe('v2')
    // 数据被保留
    expect(existsSync(join(dataDir, 'rdp.db'))).toBe(true)
    expect(existsSync(join(dataDir, 'notes.txt'))).toBe(true)
    expect(await fs.readFile(join(dataDir, 'notes.txt'), 'utf8')).toBe('用户数据')
    // 暂存/备份目录不留残留
    const leftovers = existsSync(tmpRoot) ? await fs.readdir(tmpRoot) : []
    expect(leftovers.filter((n) => n.includes('probe-ext_chenzhi'))).toEqual([])
  })

  it('首次安装（非覆盖）不涉及保留逻辑，正常成功', async () => {
    await fs.mkdir(targetRoot, { recursive: true })
    const first = await installFromPackage(
      await makeOix('first.oix', [['index.js', 'v1']], manifest('1.0.0')),
      { targetRoot, tmpRoot }
    )
    expect(first.replaced).toBe(false)
    expect(existsSync(join(targetRoot, 'probe-ext_chenzhi', 'index.js'))).toBe(true)
  })

  it('拒绝含 data/ 的包：抛 forbidden-entry，且不落盘、无残留', async () => {
    await fs.mkdir(targetRoot, { recursive: true })
    const withData = await makeOix(
      'with-data.oix',
      [
        ['index.js', 'v1'],
        ['data/rdp.db', 'stale-db']
      ],
      manifest('1.0.0')
    )

    await expect(installFromPackage(withData, { targetRoot, tmpRoot })).rejects.toBeInstanceOf(
      OixInstallError
    )
    await expect(installFromPackage(withData, { targetRoot, tmpRoot })).rejects.toMatchObject({
      code: 'forbidden-entry'
    })

    expect(existsSync(join(targetRoot, 'probe-ext_chenzhi'))).toBe(false)
    const leftovers = existsSync(tmpRoot) ? await fs.readdir(tmpRoot) : []
    expect(leftovers).toEqual([])
  })

  it('拒绝 data 目录下的嵌套条目（data/sub/x）', async () => {
    await fs.mkdir(targetRoot, { recursive: true })
    const nested = await makeOix(
      'nested.oix',
      [
        ['index.js', 'v1'],
        ['data/sub/x.json', '{}']
      ],
      manifest('1.0.0')
    )
    await expect(installFromPackage(nested, { targetRoot, tmpRoot })).rejects.toMatchObject({
      code: 'forbidden-entry'
    })
  })
})
