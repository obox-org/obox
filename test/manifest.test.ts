/**
 * manifest 校验规则单测（validateManifest）。
 * 覆盖：name/version/main/apiVersion/extensionDependencies（含非数组值不得抛错的回归，
 * issue #83）/keybindings/contributes。
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

  // issue #77：正则原带 `i`，`MyExt`/`MY-EXT` 实际通过；标题写「大写 → error」却没有大写断言。
  // 现去掉 `i`，大写真正非法。文案与 skill 脚本副本逐字一致（差分门禁会把关）。
  it('name 非法（大写/空格/点开头）→ error', () => {
    const NAME_ERROR = 'name 必填，且只能含字母/数字/./_/-'
    expect(errors({ ...valid, name: 'MyExt' })).toEqual([NAME_ERROR])
    expect(errors({ ...valid, name: 'MY-EXT' })).toEqual([NAME_ERROR])
    expect(errors({ ...valid, name: 'My Ext' })).toEqual([NAME_ERROR])
    expect(errors({ ...valid, name: '.abc' })).toEqual([NAME_ERROR])
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
      errors({ ...valid, extensionDependencies: [1] }).some((e) =>
        e.includes('extensionDependencies')
      )
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
      errors({
        ...valid,
        contributes: { keybindings: [{ command: 'my-ext.do', key: 'Ctrl+Shift+K' }] }
      })
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

describe('validateManifest extensionDependencies 非数组（issue #83）', () => {
  const nonArrays: Array<[string, unknown]> = [
    ['对象', {}],
    ['数字', 5],
    ['布尔', true],
    ['字符串', 'app'],
    ['null', null]
  ]

  // 此前 `(m.extensionDependencies as string[])?.includes(...)` 对"非 null 但非数组"的值不短路，
  // 直接抛 `TypeError: …includes is not a function`；而该函数对每个扫描到的 manifest 都会调用，
  // 于是一个坏清单会打断整轮扫描/加载，而不是产出一条校验 error。
  it.each(nonArrays)(
    'extensionDependencies 是%s → 返回干净的 error，不抛 TypeError',
    (_label, value) => {
      let messages: ReturnType<typeof validateManifest> = []
      expect(() => {
        messages = validateManifest({ ...valid, extensionDependencies: value })
      }).not.toThrow()
      // 文案与 skill 脚本副本逐字一致（差分门禁 test/manifest-script-parity.test.ts 会把关）
      expect(messages.map((m) => `${m.severity}:${m.message}`)).toEqual([
        'error:extensionDependencies 必须是字符串数组'
      ])
    }
  )

  it('非数组只报形状 error，不叠加"扩展不能依赖自身"', () => {
    expect(errors({ ...valid, extensionDependencies: {} })).toEqual([
      'extensionDependencies 必须是字符串数组'
    ])
  })

  it('合法字符串数组行为不变：外部依赖无 error、含自身报"扩展不能依赖自身"', () => {
    expect(errors({ ...valid, extensionDependencies: ['other-ext'] })).toEqual([])
    expect(errors({ ...valid, extensionDependencies: ['my-ext'] })).toEqual(['扩展不能依赖自身'])
  })
})

describe('validateManifest contributes.ipcChannels（issue #45）', () => {
  it('合法声明 → 无 error', () => {
    expect(
      errors({
        ...valid,
        contributes: {
          ipcChannels: [{ id: 'worker', transport: 'stdio', program: 'bin/worker.js' }]
        }
      })
    ).toEqual([])
  })

  it('非法声明 → 清单无效（带明确错误，而不是等 connect() 才炸）', () => {
    const e = errors({
      ...valid,
      contributes: { ipcChannels: [{ id: 'worker', transport: 'tcp' }] }
    })
    expect(e).toHaveLength(1)
    expect(e[0]).toMatch(/contributes\.ipcChannels 非法/)
    expect(e[0]).toMatch(/不支持 TCP\/端口/)
  })

  it('非数组 → error', () => {
    expect(errors({ ...valid, contributes: { ipcChannels: {} } })[0]).toMatch(/必须是数组/)
  })

  it('重复 id → error', () => {
    const e = errors({
      ...valid,
      contributes: {
        ipcChannels: [
          { id: 'w', transport: 'pipe' },
          { id: 'w', transport: 'pipe' }
        ]
      }
    })
    expect(e[0]).toMatch(/通道 id 重复/)
  })
})
