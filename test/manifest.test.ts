/**
 * manifest 校验规则单测（validateManifest）。
 * 覆盖：name/version/main/apiVersion/extensionDependencies/keybindings/contributes。
 */
import { describe, expect, it } from 'vitest'
import { validateManifest } from '../src/renderer/src/core/manifest'

function errors(raw: unknown): string[] {
  return validateManifest(raw)
    .filter((m) => m.severity === 'error')
    .map((m) => m.message)
}

const valid = {
  name: 'my-ext',
  version: '1.0.0',
  main: './index.js'
}

describe('validateManifest 基础字段', () => {
  it('合法 manifest → 无 error', () => {
    expect(errors(valid)).toEqual([])
  })

  it('非对象 → error', () => {
    expect(errors(null)).toHaveLength(1)
    expect(errors('x')).toHaveLength(1)
  })

  it('name 非法（大写/空格/点开头）→ error', () => {
    expect(errors({ ...valid, name: 'My Ext' }).some((e) => e.includes('name'))).toBe(true)
    expect(errors({ ...valid, name: '.abc' }).some((e) => e.includes('name'))).toBe(true)
  })

  it('version 非法（非 semver）→ error', () => {
    expect(errors({ ...valid, version: '1.0' }).some((e) => e.includes('version'))).toBe(true)
  })

  it('main 缺失/为空 → error', () => {
    expect(errors({ ...valid, main: '' }).some((e) => e.includes('main'))).toBe(true)
  })
})

describe('validateManifest apiVersion（ADR 0010）', () => {
  it('缺失（视为 0）→ 通过', () => {
    expect(errors(valid)).toEqual([])
  })

  it('合法整数 → 通过', () => {
    expect(errors({ ...valid, apiVersion: 0 })).toEqual([])
    expect(errors({ ...valid, apiVersion: 1 })).toEqual([])
  })

  it('非整数/负数/字符串 → error', () => {
    expect(errors({ ...valid, apiVersion: 1.5 }).some((e) => e.includes('apiVersion'))).toBe(true)
    expect(errors({ ...valid, apiVersion: -1 }).some((e) => e.includes('apiVersion'))).toBe(true)
    expect(errors({ ...valid, apiVersion: '1' }).some((e) => e.includes('apiVersion'))).toBe(true)
  })

  it('高于 obox 的 apiVersion → error（需要更高版本）', () => {
    const msgs = errors({ ...valid, apiVersion: 999 })
    expect(msgs.some((e) => e.includes('需要 obox API') && e.includes('或更高'))).toBe(true)
  })
})

describe('validateManifest 依赖与贡献点', () => {
  it('extensionDependencies 非字符串数组 → error；依赖自身 → error', () => {
    expect(
      errors({ ...valid, extensionDependencies: [1] }).some((e) => e.includes('extensionDependencies'))
    ).toBe(true)
    expect(
      errors({ ...valid, extensionDependencies: ['my-ext'] }).some((e) => e.includes('依赖自身'))
    ).toBe(true)
  })

  it('contributes 非对象 → error', () => {
    expect(errors({ ...valid, contributes: 'x' }).some((e) => e.includes('contributes'))).toBe(true)
  })

  it('keybindings 合法数组 → 通过', () => {
    expect(
      errors({ ...valid, contributes: { keybindings: [{ command: 'my-ext.do', key: 'Ctrl+Shift+K' }] } })
    ).toEqual([])
  })

  it('keybindings 非法（缺 command/key）→ error', () => {
    expect(
      errors({ ...valid, contributes: { keybindings: [{ command: 'my-ext.do' }] } }).some((e) =>
        e.includes('keybindings')
      )
    ).toBe(true)
    expect(
      errors({ ...valid, contributes: { keybindings: 'x' } }).some((e) => e.includes('keybindings'))
    ).toBe(true)
  })
})
