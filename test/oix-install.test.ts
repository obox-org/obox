/**
 * .oix 安装核心单测（oixCore.installFromPackage）。
 * 覆盖：正常安装、覆盖安装、**失败回滚（旧版本不丢）**、**并发串行（不产生半安装目录）**、
 * 解压限额、zip-slip 条目拒绝、错误码分类、元数据写入。
 *
 * 先例：test/sqlite-core.test.ts（electron-free 核心 + 真实临时目录），本文件用真实 .oix（zip）fixture。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { installFromPackage, OixInstallError } from '../src/main/oixCore'

let workDir = ''
let targetRoot = ''
let tmpRoot = ''

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'obox-oix-'))
  targetRoot = join(workDir, 'extensions')
  tmpRoot = join(targetRoot, '.tmp')
  await fs.mkdir(targetRoot, { recursive: true })
})

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

/** 造一个 .oix 包；entries 为 <包内路径, 内容> */
async function makeOix(
  fileName: string,
  entries: Array<[string, string]>,
  manifest?: Record<string, unknown>
): Promise<string> {
  const zip = new AdmZip()
  const mf =
    manifest ??
    ({ name: 'demo-ext', version: '1.0.0', main: './index.js', author: 'chenzhi' } as Record<
      string,
      unknown
    >)
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(mf), 'utf8'))
  for (const [p, content] of entries) zip.addFile(p, Buffer.from(content, 'utf8'))
  const file = join(workDir, fileName)
  zip.writeZip(file)
  return file
}

/**
 * 手写最小 ZIP（stored 不压缩）。
 * 必须手写：AdmZip 的 addFile 会规范化条目名（去掉 `../`、剥掉前导 `/`、`\` → `/`），
 * 用不了它来造 zip-slip 之类的**恶意条目** fixture。
 */
function makeRawZip(file: string, entries: Array<[string, string]>): void {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = crc32(data) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))
    offset += local.length + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  writeFileSync(file, Buffer.concat([...parts, cdBuf, eocd]))
}

/** 造一个含恶意条目路径的 .oix（manifest/main 合法，仅额外条目非法） */
function makeMaliciousOix(file: string, evilEntry: string): string {
  makeRawZip(file, [
    [
      'manifest.json',
      JSON.stringify({ name: 'demo-ext', version: '1.0.0', main: './index.js', author: 'chenzhi' })
    ],
    ['index.js', 'BAD'],
    [evilEntry, 'evil']
  ])
  return file
}

const opts = (): { targetRoot: string; tmpRoot: string } => ({ targetRoot, tmpRoot })

describe('oixCore · 正常安装', () => {
  it('解压到 <name>_<author> 目录，写入 .obox-meta.json，返回扩展信息', async () => {
    const file = await makeOix('ok.oix', [['index.js', 'export default () => {}\n']])
    const r = await installFromPackage(file, opts())
    expect(r).toEqual({
      id: 'demo-ext_chenzhi',
      name: 'demo-ext',
      displayName: undefined,
      version: '1.0.0',
      author: 'chenzhi',
      replaced: false
    })
    const dir = join(targetRoot, 'demo-ext_chenzhi')
    expect(existsSync(join(dir, 'index.js'))).toBe(true)
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true)
    const meta = JSON.parse(readFileSync(join(dir, '.obox-meta.json'), 'utf8')) as {
      installedTimestamp?: number
      pendingInstall?: { version: string; at: number }
    }
    expect(typeof meta.installedTimestamp).toBe('number')
    // 安装完成即标记"待执行 install 钩子"（渲染进程执行后回写 install 并清除本字段，见 issue #52）
    expect(meta.pendingInstall).toEqual({ version: '1.0.0', at: meta.installedTimestamp })
    // 子目录条目也能落地
  })

  it('子目录条目按层级解压', async () => {
    const file = await makeOix('sub.oix', [
      ['index.js', 'x'],
      ['app/page.html', '<html/>']
    ])
    await installFromPackage(file, opts())
    expect(existsSync(join(targetRoot, 'demo-ext_chenzhi', 'app', 'page.html'))).toBe(true)
  })

  it('author 缺失 → 目录名退化为纯 name', async () => {
    const file = await makeOix('noauthor.oix', [['index.js', 'x']], {
      name: 'plain',
      version: '2.0.0',
      main: './index.js'
    })
    const r = await installFromPackage(file, opts())
    expect(r.id).toBe('plain')
  })

  it('覆盖安装：replaced=true 且内容被替换', async () => {
    const v1 = await makeOix('v1.oix', [['index.js', 'v1']])
    await installFromPackage(v1, opts())
    const v2 = await makeOix('v2.oix', [['index.js', 'v2']], {
      name: 'demo-ext',
      version: '2.0.0',
      main: './index.js',
      author: 'chenzhi'
    })
    const r = await installFromPackage(v2, opts())
    expect(r.replaced).toBe(true)
    expect(r.version).toBe('2.0.0')
    expect(readFileSync(join(targetRoot, 'demo-ext_chenzhi', 'index.js'), 'utf8')).toBe('v2')
  })

  it('安装结束后不残留暂存/备份目录', async () => {
    const file = await makeOix('clean.oix', [['index.js', 'x']])
    await installFromPackage(file, opts())
    await installFromPackage(file, opts()) // 再覆盖一次
    const leftovers = existsSync(tmpRoot) ? await fs.readdir(tmpRoot) : []
    expect(leftovers).toEqual([])
  })
})

describe('oixCore · 失败不破坏已安装版本（回滚）', () => {
  it.each([
    ['相对路径穿越', '../escape.txt'],
    ['深层穿越', 'a/../../b.txt'],
    ['绝对路径', '/abs.txt'],
    ['反斜杠', 'back\\slash.txt']
  ])('非法条目（%s）→ entry-invalid，且旧版本文件保持不变', async (_label, evilEntry) => {
    const good = await makeOix('good.oix', [['index.js', 'GOOD']])
    await installFromPackage(good, opts())

    const bad = makeMaliciousOix(join(workDir, 'bad.oix'), evilEntry)
    await expect(installFromPackage(bad, opts())).rejects.toMatchObject({ code: 'entry-invalid' })

    const dir = join(targetRoot, 'demo-ext_chenzhi')
    expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe('GOOD')
    expect(existsSync(join(workDir, 'escape.txt'))).toBe(false)
    // 暂存目录被清理（不留半安装状态）
    const leftovers = existsSync(tmpRoot) ? await fs.readdir(tmpRoot) : []
    expect(leftovers).toEqual([])
  })

  it('入口文件不在包内 → entry-missing，且不产生目标目录', async () => {
    const file = await makeOix('noentry.oix', [['other.js', 'x']], {
      name: 'no-entry',
      version: '1.0.0',
      main: './index.js'
    })
    await expect(installFromPackage(file, opts())).rejects.toBeInstanceOf(OixInstallError)
    await expect(installFromPackage(file, opts())).rejects.toMatchObject({ code: 'entry-missing' })
    expect(existsSync(join(targetRoot, 'no-entry'))).toBe(false)
  })
})

describe('oixCore · 并发串行', () => {
  it('同一扩展并发安装：串行完成，最终目录完整（不会半安装）', async () => {
    const a = await makeOix('a.oix', [
      ['index.js', 'A'],
      ['a1.txt', 'A1'],
      ['a2.txt', 'A2']
    ])
    const b = await makeOix('b.oix', [
      ['index.js', 'B'],
      ['b1.txt', 'B1'],
      ['b2.txt', 'B2']
    ])
    const [ra, rb] = await Promise.all([
      installFromPackage(a, opts()),
      installFromPackage(b, opts())
    ])
    // 两者都成功且指向同一目录；后完成者的内容为最终状态
    expect([ra.id, rb.id]).toEqual(['demo-ext_chenzhi', 'demo-ext_chenzhi'])
    const dir = join(targetRoot, 'demo-ext_chenzhi')
    const finalIndex = readFileSync(join(dir, 'index.js'), 'utf8')
    expect(['A', 'B']).toContain(finalIndex)
    // 关键：最终目录是"某一个完整包"的状态，不存在另一个包的残留文件
    const names = (await fs.readdir(dir)).sort()
    if (finalIndex === 'B') {
      expect(names).not.toContain('a1.txt')
    } else {
      expect(names).not.toContain('b1.txt')
    }
    const leftovers = existsSync(tmpRoot) ? await fs.readdir(tmpRoot) : []
    expect(leftovers).toEqual([])
  })
})

describe('oixCore · 限额', () => {
  it('条目数超限 → too-large 且不产生目标目录', async () => {
    const entries: Array<[string, string]> = [['index.js', 'x']]
    for (let i = 0; i < 20; i++) entries.push([`f${i}.txt`, 'x'])
    const file = await makeOix('many.oix', entries)
    await expect(installFromPackage(file, { ...opts(), maxEntries: 5 })).rejects.toMatchObject({
      code: 'too-large'
    })
    expect(existsSync(join(targetRoot, 'demo-ext_chenzhi'))).toBe(false)
  })

  it('解压总量超限 → too-large', async () => {
    const big = 'x'.repeat(4096)
    const file = await makeOix('big.oix', [
      ['index.js', 'x'],
      ['big1.txt', big],
      ['big2.txt', big]
    ])
    await expect(
      installFromPackage(file, { ...opts(), maxTotalBytes: 2048 })
    ).rejects.toMatchObject({ code: 'too-large' })
  })
})

describe('oixCore · 错误码分类', () => {
  it('路径不存在 → path-invalid', async () => {
    await expect(installFromPackage(join(workDir, 'nope.oix'), opts())).rejects.toMatchObject({
      code: 'path-invalid'
    })
  })

  it('空路径 → path-invalid', async () => {
    await expect(installFromPackage('   ', opts())).rejects.toMatchObject({ code: 'path-invalid' })
  })

  it('非 zip 文件 → invalid-package', async () => {
    const file = join(workDir, 'notzip.oix')
    await fs.writeFile(file, 'this is not a zip', 'utf8')
    await expect(installFromPackage(file, opts())).rejects.toMatchObject({
      code: 'invalid-package'
    })
  })

  it('缺根 manifest → invalid-manifest', async () => {
    const zip = new AdmZip()
    zip.addFile('index.js', Buffer.from('x'))
    const file = join(workDir, 'nomanifest.oix')
    zip.writeZip(file)
    await expect(installFromPackage(file, opts())).rejects.toMatchObject({
      code: 'invalid-manifest'
    })
  })

  it('name/version 非法 → invalid-manifest', async () => {
    const badName = await makeOix('badname.oix', [['index.js', 'x']], {
      name: 'Bad Name',
      version: '1.0.0',
      main: './index.js'
    })
    await expect(installFromPackage(badName, opts())).rejects.toMatchObject({
      code: 'invalid-manifest'
    })
    const badVer = await makeOix('badver.oix', [['index.js', 'x']], {
      name: 'okname',
      version: '1.0',
      main: './index.js'
    })
    await expect(installFromPackage(badVer, opts())).rejects.toMatchObject({
      code: 'invalid-manifest'
    })
  })

  it('错误对象带 name 与 code，便于上层映射', async () => {
    const err = await installFromPackage(join(workDir, 'none.oix'), opts()).catch((e) => e)
    expect(err).toBeInstanceOf(OixInstallError)
    expect(err.name).toBe('OixInstallError')
    expect(err.code).toBe('path-invalid')
  })
})
