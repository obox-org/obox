/**
 * 相对路径校验单测（sqlite 与 fs 共享的安全边界）。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { validateRelPath } from '../src/main/sqliteCore'

describe('validateRelPath', () => {
  it('合法相对路径通过并规范化为平台分隔符', () => {
    expect(validateRelPath('todo.db')).toBe('todo.db')
    expect(validateRelPath('sub/a.db')).toBe(join('sub', 'a.db'))
    expect(validateRelPath('a\\b.txt')).toBe(join('a', 'b.txt'))
  })

  it('拒绝绝对路径（Unix/Windows/盘符）', () => {
    expect(() => validateRelPath('/abs.txt')).toThrow()
    expect(() => validateRelPath('C:\\abs.txt')).toThrow()
    expect(() => validateRelPath('c:/abs.txt')).toThrow()
  })

  it('拒绝路径穿越（.. / 空段 / 空值）', () => {
    expect(() => validateRelPath('../x')).toThrow()
    expect(() => validateRelPath('a/../x')).toThrow()
    expect(() => validateRelPath('a//b')).toThrow()
    expect(() => validateRelPath('')).toThrow()
    expect(() => validateRelPath('  ')).toThrow()
  })
})
