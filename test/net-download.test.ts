import { describe, expect, it } from 'vitest'
import { isSafeRelativePath, numberedName, planDownload } from '../src/shared/netDownload'

/**
 * `api.net.download` 落盘策略（用户确认的语义）：
 * 相对数据目录 + 已存在处理（rename/overwrite/skip）+ 返回相对路径（skip 且存在 → undefined 语义）。
 */
const joinAbs = (rel: string): string => `C:/data/${rel}`
const noneExists = (): boolean => false
const only =
  (...paths: string[]) =>
  (rel: string): boolean =>
    paths.includes(rel)

describe('相对路径安全', () => {
  it('接受普通相对路径与子目录', () => {
    expect(isSafeRelativePath('a.zip')).toBe(true)
    expect(isSafeRelativePath('sub/dir/a.zip')).toBe(true)
    expect(isSafeRelativePath('sub\\dir\\a.zip')).toBe(true)
  })

  it('拒绝绝对路径 / 盘符 / .. / 空段', () => {
    for (const bad of ['/abs/a.zip', 'C:/a.zip', 'a/../b.zip', 'a//b.zip', '']) {
      expect(isSafeRelativePath(bad), bad).toBe(false)
    }
  })
})

describe('自动重命名', () => {
  it('保留扩展名追加序号（含子目录）', () => {
    expect(numberedName('a.zip', 1)).toBe('a (1).zip')
    expect(numberedName('sub/a.tar.gz', 2)).toBe('sub/a.tar (2).gz')
    expect(numberedName('noext', 3)).toBe('noext (3)')
  })
})

describe('planDownload 策略', () => {
  it('目标不存在 ⇒ 直接写', () => {
    const plan = planDownload('update.exe', 'rename', noneExists, joinAbs)
    expect(plan).toEqual({ action: 'write', relPath: 'update.exe', absPath: 'C:/data/update.exe' })
  })

  it('已存在 + overwrite ⇒ 覆盖同一路径', () => {
    const plan = planDownload('update.exe', 'overwrite', only('update.exe'), joinAbs)
    expect(plan).toMatchObject({ action: 'write', relPath: 'update.exe' })
  })

  it('已存在 + skip ⇒ action=skip（调用方据此返回 undefined）', () => {
    const plan = planDownload('update.exe', 'skip', only('update.exe'), joinAbs)
    expect(plan).toMatchObject({ action: 'skip', relPath: 'update.exe' })
  })

  it('已存在 + rename ⇒ 找到第一个空位（a.zip → a (1).zip → a (2).zip）', () => {
    const plan = planDownload('a.zip', 'rename', only('a.zip', 'a (1).zip'), joinAbs)
    expect(plan).toMatchObject({ action: 'write', relPath: 'a (2).zip' })
  })

  it('非法路径 ⇒ error（带可读原因）', () => {
    const plan = planDownload('../evil.exe', 'rename', noneExists, joinAbs)
    expect(plan.action).toBe('error')
    if (plan.action === 'error') expect(plan.message).toContain('相对路径')
  })
})
