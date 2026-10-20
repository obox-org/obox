/**
 * manifest 校验规则单测（validateManifest）。
 * 覆盖：name/version/main/apiVersion/extensionDependencies（含非数组值不得抛错的回归，
 * issue #83）/keybindings/contributes/贡献点数组形状（issue #84 的四类补充 + contributesArray 防御）。
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeActivationEvents,
  contributesArray,
  makeExtensionInfo,
  normalizeActivationEvents,
  validateManifest,
  withDefaultActivation,
  ACTIVATION_EVENT_HINT
} from '../src/renderer/src/core/manifest'
import { parseActivationEvent } from '../src/shared/extensionHostProtocol'
import type { ExtensionManifest } from '../src/renderer/src/core/types'
import { checkIpcChannelList } from '../src/shared/ipcDeclaration'

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

  // issue #43（Q2 = 方案 A 锁死）：清单声明面不新增 `mode`；写了未知键**不报错也不生效**
  // （服务端角色由运行时 `api.ipc.listen()` 建立，与清单无关）。
  //
  // 用**非法枚举值**（`bogus`）而不是 `'server'`：若将来有人给声明加"mode 必须 ∈ {client,server}
  // 否则 throw"的严格校验，合法值不会红、非法值才会红 —— 这条断言因此真的锁住"未知键静默忽略"。
  it('未知键：contributes.ipcChannels 项带 mode（含非法枚举值）时清单仍然有效', () => {
    expect(
      errors({
        ...valid,
        contributes: { ipcChannels: [{ id: 'bus', transport: 'pipe', mode: 'bogus' }] }
      })
    ).toEqual([])
  })

  // V15 的语义面：清单里写它**不生效** —— 校验过后声明里没有任何角色位，
  // 因此不会带来任何监听（监听只能由运行时 api.ipc.listen() 建立）。
  it('未知键：mode 不进校验后的声明（无角色位 → 不产生监听）', () => {
    const checked = checkIpcChannelList([{ id: 'bus', transport: 'pipe', mode: 'bogus' }])
    expect(checked).toEqual({ ok: true, declarations: [{ id: 'bus', transport: 'pipe' }] })
    if (checked.ok) {
      expect(Object.keys(checked.declarations[0])).toEqual(['id', 'transport'])
    }
  })

  /**
   * issue #44（Q2 = 方案 A 的第二把锁 · **锁 1b**）：`autoReconnect` 在**运行时**声明里
   * 是**被校验的已知键**，因此必须保证它**不会**让清单校验面开始校验它 —— 否则清单里写
   * `{ retries: -1 }` 这类值会让**整个清单无效**（违反 R13"不报错"）。
   *
   * 喂**非法值**而不是合法值：只喂 `{}` 时，若有人给清单路径加上"值必须合法"的校验，
   * 该用例仍会绿 —— 无效锁。
   */
  it('autoReconnect：清单项带该键（含非法值 {retries:-1}）时清单仍然有效（锁 1b）', () => {
    expect(
      errors({
        ...valid,
        contributes: {
          ipcChannels: [
            { id: 'bus', transport: 'pipe', autoReconnect: { retries: -1 } },
            { id: 'bus2', transport: 'pipe', autoReconnect: {} },
            { id: 'bus3', transport: 'pipe', autoReconnect: 5 }
          ]
        }
      })
    ).toEqual([])

    // 同一把锁的构造面：校验过后的声明里没有该键（因此清单里写的策略不可能生效）
    const checked = checkIpcChannelList([
      { id: 'bus', transport: 'pipe', autoReconnect: { retries: 5, backoffMs: 1 } }
    ])
    expect(checked).toEqual({ ok: true, declarations: [{ id: 'bus', transport: 'pipe' }] })
    if (checked.ok) {
      expect('autoReconnect' in checked.declarations[0]).toBe(false)
      expect(Object.keys(checked.declarations[0])).toEqual(['id', 'transport'])
    }
  })
})

describe('validateManifest 贡献点数组形状（issue #84）', () => {
  // 这四类此前**完全不校验**形状：`"navItems": {}` 能通过校验、进入激活阶段，
  // 然后宿主注册期的 `for (const x of ({} ?? []))` 抛 `TypeError: {} is not iterable`。
  const cases: Array<[string, string, unknown]> = [
    ['导航项', 'navItems', {}],
    ['状态栏项', 'statusBarItems', 5],
    ['命令', 'commands', true],
    ['主题', 'themes', {}]
  ]

  it.each(cases)(
    '%s（contributes.%s）非数组 → 干净的形状 error，逐字对齐脚本副本',
    (label, key, value) => {
      const expected: Record<string, string> = {
        navItems: 'navItems 必须是 [{id, title, icon, view?}] 数组',
        statusBarItems: 'statusBarItems 必须是 [{id, name}] 数组',
        commands: 'commands 必须是 [{command, title}] 数组',
        themes: 'themes 必须是 [{id, label, tokens}] 数组'
      }
      let messages: ReturnType<typeof validateManifest> = []
      expect(() => {
        messages = validateManifest({ ...valid, contributes: { [key]: value } })
      }, label).not.toThrow()
      expect(messages.map((m) => `${m.severity}:${m.message}`)).toEqual([`error:${expected[key]}`])
    }
  )

  it('非数组一律报 error（{} / 5 / true / 字符串 / null 全覆盖，且都不抛）', () => {
    for (const key of ['navItems', 'statusBarItems', 'commands', 'themes']) {
      for (const value of [{}, 5, true, 'x', null]) {
        const raw = { ...valid, contributes: { [key]: value } }
        let messages: ReturnType<typeof validateManifest> = []
        expect(
          () => {
            messages = validateManifest(raw)
          },
          `${key}=${JSON.stringify(value)}`
        ).not.toThrow()
        expect(
          messages.map((m) => m.message),
          `${key}=${JSON.stringify(value)}`
        ).toEqual([expect.stringContaining('必须是')])
      }
    }
  })

  it('合法数组行为不变：完整声明无 error，逐项缺字段仍只是宿主侧 warning（校验层不管）', () => {
    expect(
      errors({
        ...valid,
        contributes: {
          navItems: [{ id: 'a.main', title: '主页', icon: '<svg/>' }],
          statusBarItems: [{ id: 'a.status', name: '状态' }],
          commands: [{ command: 'a.do', title: '做事' }],
          themes: [{ id: 'a.theme', label: '主题', tokens: { '--bg': '#000' } }]
        }
      })
    ).toEqual([])
    // 数组里逐项缺字段：校验层不看（宿主注册期给 warning）
    expect(errors({ ...valid, contributes: { commands: [{ command: 'a.do' }] } })).toEqual([])
  })

  it('contributesArray：宿主消费前的形状防御（非数组 → 空数组，绝不抛）', () => {
    expect(contributesArray([1, 2])).toEqual([1, 2])
    expect(contributesArray(undefined)).toEqual([])
    for (const value of [{}, 5, true, 'x', null]) {
      expect(() => contributesArray(value), JSON.stringify(value)).not.toThrow()
      expect(contributesArray(value)).toEqual([])
    }
  })
})

/* ============================================================================================ */
/* activationEvents（EH-C1 / ADR-0026 决策 6）                                                    */
/* ============================================================================================ */

/** 4 类合法事件（清单里的字符串形态） */
const LEGAL_ACTIVATION_EVENTS = [
  '*',
  'onStartupFinished',
  'onCommand:my-ext.hello',
  'onView:my-ext.panel'
] as const

describe('validateManifest activationEvents（EH-C1：4 类 + 缺省 *）', () => {
  it('缺省（不写该字段）→ 无 error：现有 5 个扩展都不写，行为必须与今天一致', () => {
    expect(errors(valid)).toEqual([])
    expect('activationEvents' in valid).toBe(false)
  })

  it.each(LEGAL_ACTIVATION_EVENTS)('合法事件 %s → 无 error', (event) => {
    expect(errors({ ...valid, activationEvents: [event] })).toEqual([])
  })

  it('4 类混写 → 无 error（顺序不影响结论）', () => {
    expect(errors({ ...valid, activationEvents: [...LEGAL_ACTIVATION_EVENTS] })).toEqual([])
  })

  it('未知事件 → error：文案点明非法值与 4 类合法值（中文可执行）', () => {
    const messages = errors({ ...valid, activationEvents: ['onDebug:foo'] })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('"onDebug:foo"')
    expect(messages[0]).toContain('不受支持')
    expect(messages[0]).toContain(ACTIVATION_EVENT_HINT)
    // 4 类合法值必须逐字出现在文案里（用户照着改就行）
    expect(messages[0]).toContain('* / onStartupFinished / onCommand:<id> / onView:<id>')
  })

  it('空后缀 → error：onCommand: / onView: 与只有空白的 id 都报「<id> 不能为空」', () => {
    const messages = errors({ ...valid, activationEvents: ['onCommand:', 'onView:', 'onView:   '] })
    expect(messages).toHaveLength(3)
    for (const message of messages) expect(message).toContain('<id> 不能为空')
  })

  it.each([
    ['数字', 5],
    ['布尔', true],
    ['对象', {}],
    ['null', null]
  ])('非字符串项（%s）→ error，不抛错', (_label, value) => {
    let messages: string[] = []
    expect(() => {
      messages = errors({ ...valid, activationEvents: [value] })
    }).not.toThrow()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('必须是字符串')
    expect(messages[0]).toContain(ACTIVATION_EVENT_HINT)
  })

  it.each([
    ['对象', {}],
    ['字符串', 'onCommand:my-ext.hello'],
    ['布尔', true],
    ['数字', 5]
  ])('activationEvents 是%s（非数组）→ error', (_label, value) => {
    expect(errors({ ...valid, activationEvents: value })).toEqual([
      `activationEvents 必须是字符串数组（${ACTIVATION_EVENT_HINT}）`
    ])
  })

  it('多个非法项 → 逐项各一条 error（一处错一行，不合并成一句）', () => {
    const messages = errors({
      ...valid,
      activationEvents: ['onDebug:foo', 'onCommand:my-ext.hello', 'onCommand:', 7]
    })
    expect(messages).toHaveLength(3)
    expect(messages.filter((m) => m.includes('不受支持'))).toHaveLength(1)
    expect(messages.filter((m) => m.includes('<id> 不能为空'))).toHaveLength(1)
    expect(messages.filter((m) => m.includes('必须是字符串'))).toHaveLength(1)
  })

  it('清单校验失败 ⇒ ExtensionInfo.isValid=false（扩展被标记无效，loader 因此不收集它）', () => {
    const bad = {
      ...valid,
      activationEvents: ['onDebug:foo']
    } as unknown as ExtensionManifest
    const info = makeExtensionInfo('my-ext', bad, 'user', true)
    expect(info.isValid).toBe(false)
    expect(info.validations.some((v) => v.severity === 'error')).toBe(true)

    const good = {
      ...valid,
      activationEvents: ['onCommand:my-ext.hello']
    } as unknown as ExtensionManifest
    expect(makeExtensionInfo('my-ext', good, 'user', true).isValid).toBe(true)
  })
})

describe('activationEvents 归一化（normalizeActivationEvents）', () => {
  it('缺失 / null / 空数组 ⇒ ["*"]（缺省 = 立即激活，现有扩展行为不变）', () => {
    expect(normalizeActivationEvents(undefined)).toEqual(['*'])
    expect(normalizeActivationEvents(null)).toEqual(['*'])
    expect(normalizeActivationEvents([])).toEqual(['*'])
    // 非数组同样退回 ['*']：清单已判无效，归一化只负责给宿主一个可用的默认值
    expect(normalizeActivationEvents('onCommand:x')).toEqual(['*'])
  })

  it('4 类事件 → 结构化原因（字符串两种 / {command} / {view}）', () => {
    expect(normalizeActivationEvents([...LEGAL_ACTIVATION_EVENTS])).toEqual([
      '*',
      'onStartupFinished',
      { command: 'my-ext.hello' },
      { view: 'my-ext.panel' }
    ])
  })

  it('非法项丢弃、合法项保留；全非法 ⇒ ["*"]', () => {
    expect(normalizeActivationEvents(['onDebug:x', 'onCommand:my-ext.hello'])).toEqual([
      { command: 'my-ext.hello' }
    ])
    expect(normalizeActivationEvents(['onDebug:x', 'onCommand:', 5])).toEqual(['*'])
  })

  it('withDefaultActivation：非空原样（拷贝）、空补 *', () => {
    const input = [{ command: 'my-ext.hello' }] as const
    const filled = withDefaultActivation(input)
    expect(filled).toEqual([{ command: 'my-ext.hello' }])
    expect(filled).not.toBe(input)
    expect(withDefaultActivation([])).toEqual(['*'])
  })

  it('与宿主侧 parseActivationEvent 同语义：逐条字符串结论一致（不写第二份解析）', () => {
    const samples = [
      '*',
      'onStartupFinished',
      'onCommand:my-ext.hello',
      'onView:my-ext.panel',
      'onCommand:',
      'onView:',
      'onView:   ',
      'onDebug:foo',
      'onStartupFinished ',
      'ONCOMMAND:x',
      ''
    ]
    for (const sample of samples) {
      const parsed = parseActivationEvent(sample)
      const analysis = analyzeActivationEvents([sample])
      // 宿主解析器的结论 → 本层应当给出的结论（唯一额外判据：id 只有空白时本层拦下，
      // 因为协议侧 validateActivationReason 要求 trim() 非空，否则激活信封会被宿主判 EH_INTERNAL）
      const target =
        parsed !== null && typeof parsed === 'object'
          ? 'command' in parsed
            ? parsed.command
            : parsed.view
          : null
      const blankId = target !== null && target.trim() === ''
      if (parsed === null) {
        expect(analysis.problems, sample).toHaveLength(1)
      } else if (blankId) {
        expect(analysis.problems, sample).toHaveLength(1)
        expect(analysis.problems[0], sample).toContain('<id> 不能为空')
      } else {
        expect(analysis.problems, sample).toEqual([])
        expect(analysis.reasons, sample).toEqual([parsed])
      }
    }
  })
})
