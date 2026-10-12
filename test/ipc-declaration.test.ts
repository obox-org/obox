/**
 * IPC 通道声明校验的测试（issue #45：清单静态声明与运行时声明**同一套规则**）。
 * 覆盖：单条校验矩阵、清单列表校验（数组/逐项/重复 id）、按 id 解析。
 */
import { describe, expect, it } from 'vitest'
import {
  checkIpcChannelList,
  checkIpcDeclaration,
  DEFAULT_RECONNECT_BACKOFF_MS,
  DEFAULT_RECONNECT_RETRIES,
  isValidIpcName,
  IpcDeclarationError,
  MAX_BACKOFF_MS,
  resolveIpcChannelDeclaration,
  validateIpcDeclaration,
  validateRuntimeIpcDeclaration
} from '../src/shared/ipcDeclaration'

describe('validateIpcDeclaration 矩阵', () => {
  it('stdio：合法声明（program 归一化为 posix 相对路径）', () => {
    expect(
      validateIpcDeclaration({
        id: 'worker',
        transport: 'stdio',
        program: '.\\bin\\worker.js',
        args: ['--serve'],
        framing: 'ndjson'
      })
    ).toEqual({
      id: 'worker',
      transport: 'stdio',
      framing: 'ndjson',
      program: 'bin/worker.js',
      args: ['--serve']
    })
  })

  it('pipe：不应声明 program/args', () => {
    expect(validateIpcDeclaration({ id: 'bus', transport: 'pipe' })).toEqual({
      id: 'bus',
      transport: 'pipe'
    })
    expect(() => validateIpcDeclaration({ id: 'bus', transport: 'pipe', program: 'x' })).toThrow(
      /不应声明 program\/args/
    )
  })

  it('拒绝 TCP/端口类传输（本能力只用 stdio 或 pipe）', () => {
    expect(() => validateIpcDeclaration({ id: 'a', transport: 'tcp' })).toThrow(/不支持 TCP\/端口/)
    expect(() => validateIpcDeclaration({ id: 'a', transport: 'http' })).toThrow(
      /transport 必须是 'stdio' 或 'pipe'/
    )
  })

  it('stdio 必须有 program，且不能是绝对路径或含 ..', () => {
    expect(() => validateIpcDeclaration({ id: 'a', transport: 'stdio' })).toThrow(
      /必须声明 program/
    )
    expect(() => validateIpcDeclaration({ id: 'a', transport: 'stdio', program: '   ' })).toThrow(
      /必须声明 program/
    )
    expect(() =>
      validateIpcDeclaration({ id: 'a', transport: 'stdio', program: 'C:\\tools\\x.exe' })
    ).toThrow(/必须是扩展目录内的相对路径/)
    expect(() =>
      validateIpcDeclaration({ id: 'a', transport: 'stdio', program: '/usr/bin/x' })
    ).toThrow(/必须是扩展目录内的相对路径/)
    expect(() =>
      validateIpcDeclaration({ id: 'a', transport: 'stdio', program: '../x.exe' })
    ).toThrow(/必须是扩展目录内的相对路径/)
  })

  it('args 必须是字符串数组；framing 只接受两种取值', () => {
    expect(() =>
      validateIpcDeclaration({ id: 'a', transport: 'stdio', program: 'x.js', args: 'nope' })
    ).toThrow(/args 必须是字符串数组/)
    expect(() =>
      validateIpcDeclaration({ id: 'a', transport: 'stdio', program: 'x.js', args: [1] })
    ).toThrow(/args 必须是字符串数组/)
    expect(() => validateIpcDeclaration({ id: 'a', transport: 'pipe', framing: 'lines' })).toThrow(
      /framing 非法/
    )
  })

  it('id / 形状非法', () => {
    expect(() => validateIpcDeclaration(null)).toThrow(/必须是对象/)
    expect(() => validateIpcDeclaration({ transport: 'pipe' })).toThrow(/通道 id 非法/)
    expect(() => validateIpcDeclaration({ id: '..', transport: 'pipe' })).toThrow(/通道 id 非法/)
    expect(() => validateIpcDeclaration({ id: 'a/b', transport: 'pipe' })).toThrow(/通道 id 非法/)
    expect(() => validateIpcDeclaration({ id: 'a b', transport: 'pipe' })).toThrow(/通道 id 非法/)
  })

  it('抛的是 IpcDeclarationError（主进程据此转成 invalid-declaration）', () => {
    try {
      validateIpcDeclaration({ id: 'a', transport: 'tcp' })
      throw new Error('应当抛错')
    } catch (err) {
      expect(err).toBeInstanceOf(IpcDeclarationError)
      expect((err as IpcDeclarationError).code).toBe('invalid-declaration')
    }
  })

  it('isValidIpcName 与校验规则一致（规则只有一份）', () => {
    expect(isValidIpcName('worker-1.x')).toBe(true)
    expect(isValidIpcName(' worker ')).toBe(true)
    expect(isValidIpcName('')).toBe(false)
    expect(isValidIpcName('..')).toBe(false)
    expect(isValidIpcName('-x')).toBe(false)
    expect(isValidIpcName(42)).toBe(false)
  })
})

describe('checkIpcDeclaration（不抛错形式，供清单校验汇总）', () => {
  it('合法 → ok:true + 声明', () => {
    const r = checkIpcDeclaration({ id: 'w', transport: 'pipe' })
    expect(r).toEqual({ ok: true, declaration: { id: 'w', transport: 'pipe' } })
  })

  it('非法 → ok:false + 文案', () => {
    const r = checkIpcDeclaration({ id: 'w', transport: 'tcp' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/不支持 TCP\/端口/)
  })
})

/**
 * issue #43（Q2 = 方案 A）：清单声明面**一字不动**，`mode` 这类"角色键"在本方案里根本不存在
 * （服务端由独立的 `api.ipc.listen()` 建立，不需要清单里的角色位）。
 *
 * 该用例把"写了 `mode` 既不报错也不生效"这一**静默行为**锁死：将来若有人真的给声明加 `mode` 语义，
 * 必须先让这条红，从而被迫回到 spec/设计。
 *
 * 喂的必须是**非法枚举值**（`bogus`）与未知键：只喂合法值 `'server'` 时，若有人加
 * "mode 必须 ∈ {client,server} 否则 throw" 的严格校验，这些用例会照样全绿 —— 无效锁。
 */
describe('未知键静默忽略（issue #43 Q2=A 锁死）', () => {
  it('未知键：清单形状带 mode（含非法枚举值）/role 不报错，且归一化后的声明不含它们', () => {
    const shapes = [
      { id: 'bus', transport: 'pipe', mode: 'server' },
      { id: 'bus', transport: 'pipe', mode: 'bogus' },
      { id: 'bus', transport: 'pipe', role: 'server' }
    ]
    for (const raw of shapes) {
      const label = JSON.stringify(raw)
      // ① 逐键白名单读取：不抛错（**非法枚举值也不抛**），且返回的声明里没有未知键
      expect(validateIpcDeclaration(raw), label).toEqual({ id: 'bus', transport: 'pipe' })
      expect(Object.keys(validateIpcDeclaration(raw)), label).toEqual(['id', 'transport'])
      expect(JSON.stringify(validateIpcDeclaration(raw)), label).not.toContain('mode')
      expect(JSON.stringify(validateIpcDeclaration(raw)), label).not.toContain('role')
      // ② 清单列表校验同样通过
      const checked = checkIpcChannelList([raw])
      expect(checked.ok, label).toBe(true)
      if (checked.ok) {
        expect('mode' in checked.declarations[0], label).toBe(false)
        expect(checked.declarations[0], label).toEqual({ id: 'bus', transport: 'pipe' })
      }
      // ③ 也不产生任何"服务端角色"信息：按 id 解析出来还是普通声明（= 采集端连接目标，不是监听）
      expect(resolveIpcChannelDeclaration([validateIpcDeclaration(raw)], 'bus'), label).toEqual({
        id: 'bus',
        transport: 'pipe'
      })
    }
  })
})

describe('checkIpcChannelList（contributes.ipcChannels）', () => {
  const ok = { id: 'worker', transport: 'stdio', program: 'bin/worker.js' }

  it('缺省/空数组视为没有声明', () => {
    expect(checkIpcChannelList(undefined)).toEqual({ ok: true, declarations: [] })
    expect(checkIpcChannelList([])).toEqual({ ok: true, declarations: [] })
  })

  it('非数组 → 报错', () => {
    const r = checkIpcChannelList({ id: 'w' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe('必须是数组')
  })

  it('逐项校验并给出序号', () => {
    const r = checkIpcChannelList([ok, { id: 'bad', transport: 'tcp' }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/^第 2 项：/)
  })

  it('同扩展内 id 必须唯一', () => {
    const r = checkIpcChannelList([ok, { ...ok, program: 'other.js' }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe('通道 id 重复: worker')
  })

  it('多条合法 → 原样返回', () => {
    const r = checkIpcChannelList([ok, { id: 'bus', transport: 'pipe' }])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.declarations.map((d) => d.id)).toEqual(['worker', 'bus'])
  })
})

describe("resolveIpcChannelDeclaration（connect('<通道id>') 的解析）", () => {
  const declarations = [
    { id: 'worker', transport: 'stdio' as const, program: 'bin/worker.js' },
    { id: 'bus', transport: 'pipe' as const }
  ]

  it('按 id 命中', () => {
    expect(resolveIpcChannelDeclaration(declarations, 'worker')).toEqual(declarations[0])
    expect(resolveIpcChannelDeclaration(declarations, ' bus ')).toEqual(declarations[1])
  })

  it('未声明/空清单 → undefined（调用方给明确错误）', () => {
    expect(resolveIpcChannelDeclaration(declarations, 'nope')).toBeUndefined()
    expect(resolveIpcChannelDeclaration([], 'worker')).toBeUndefined()
    expect(resolveIpcChannelDeclaration(undefined, 'worker')).toBeUndefined()
  })
})

/**
 * issue #44 R18 的四把锁（**双锁死**：接受面 + 归一化构造）。这是本 PR 风险最高的不变量：
 * `autoReconnect` 必须是**运行时的已知键**（R1/R2），而清单里写它必须**既不报错也不生效**（R13/Q2=A）。
 * 靠"没人读它"是不够的 —— 清单里的对象是**原样**送进主进程校验器的（F12），只有
 * `resolveIpcChannelDeclaration` 的白名单归一化能由**构造**保证它进不去。
 */
describe('autoReconnect：清单路径的接受面与归一化（issue #44 R18）', () => {
  it('锁 1a：清单路径的校验器不校验它（未知键静默忽略），且归一化后不含该键', () => {
    const shapes = [
      { id: 'bus', transport: 'pipe', autoReconnect: { retries: -1 } },
      { id: 'bus', transport: 'pipe', autoReconnect: 5 },
      { id: 'bus', transport: 'pipe', autoReconnect: null }
    ]
    for (const raw of shapes) {
      const label = JSON.stringify(raw)
      // ① 不抛错（**非法值也不抛**：清单不会因为这个键变成无效）
      expect(() => validateIpcDeclaration(raw), label).not.toThrow()
      // ② 返回值只有白名单字段
      expect(validateIpcDeclaration(raw), label).toEqual({ id: 'bus', transport: 'pipe' })
      expect(Object.keys(validateIpcDeclaration(raw)), label).toEqual(['id', 'transport'])
      // ③④ 不抛错形式的两个清单入口同样通过
      const checked = checkIpcDeclaration(raw)
      expect(checked.ok, label).toBe(true)
      if (checked.ok) expect('autoReconnect' in checked.declaration, label).toBe(false)
      const list = checkIpcChannelList([raw])
      expect(list.ok, label).toBe(true)
      if (list.ok) expect('autoReconnect' in list.declarations[0], label).toBe(false)
    }
  })

  it('锁 2：resolveIpcChannelDeclaration 归一化后不含该键（清单里写它不生效）', () => {
    const resolved = resolveIpcChannelDeclaration(
      [{ id: 'bus', transport: 'pipe', autoReconnect: { retries: 5, backoffMs: 1 } }],
      'bus'
    )
    expect(resolved).toEqual({ id: 'bus', transport: 'pipe' })
    expect('autoReconnect' in (resolved ?? {})).toBe(false)
    expect(Object.keys(resolved ?? {})).toEqual(['id', 'transport'])

    // 顺带把 #43 R15 的"未知键静默"一并钉住（同一个归一化器）
    const unknown = resolveIpcChannelDeclaration(
      [{ id: 'bus', transport: 'pipe', mode: 'server' } as never],
      'bus'
    )
    expect(unknown).toEqual({ id: 'bus', transport: 'pipe' })
    expect('mode' in (unknown ?? {})).toBe(false)
  })

  it('锁 3（运行时对照）：只有运行时入口校验并归一化 autoReconnect（缺省填充 / 非法拒绝 / stdio 拒绝）', () => {
    // 缺省填充
    expect(
      validateRuntimeIpcDeclaration({ id: 'bus', transport: 'pipe', autoReconnect: {} })
    ).toEqual({ id: 'bus', transport: 'pipe', autoReconnect: { retries: 3, backoffMs: 250 } })
    // 只给一个字段
    expect(
      validateRuntimeIpcDeclaration({ id: 'bus', transport: 'pipe', autoReconnect: { retries: 5 } })
    ).toEqual({ id: 'bus', transport: 'pipe', autoReconnect: { retries: 5, backoffMs: 250 } })
    // E2：retries **不封顶**（扩展声明的意图不被静默截断）
    expect(
      validateRuntimeIpcDeclaration({
        id: 'bus',
        transport: 'pipe',
        autoReconnect: { retries: 100_000 }
      }).autoReconnect
    ).toEqual({ retries: 100_000, backoffMs: 250 })
    // E4：backoffMs: 0 合法（= 不等待）
    expect(
      validateRuntimeIpcDeclaration({
        id: 'bus',
        transport: 'pipe',
        autoReconnect: { backoffMs: 0 }
      }).autoReconnect
    ).toEqual({ retries: 3, backoffMs: 0 })
    // E3：未知键静默忽略（与顶层逐键白名单同风格）
    expect(
      validateRuntimeIpcDeclaration({
        id: 'bus',
        transport: 'pipe',
        autoReconnect: { retries: 5, jitterMs: 50 }
      }).autoReconnect
    ).toEqual({ retries: 5, backoffMs: 250 })

    // `retries: 0` = 关闭（R2）：**不写回**该键 → 调用方不挂任何重连绑定
    const disabled = validateRuntimeIpcDeclaration({
      id: 'bus',
      transport: 'pipe',
      autoReconnect: { retries: 0 }
    })
    expect(disabled).toEqual({ id: 'bus', transport: 'pipe' })
    expect('autoReconnect' in disabled).toBe(false)

    // 非法值：负数 / 非整数 / 非数字 / 非有限 / 非对象 / 数组
    const bad = [
      { retries: -1 },
      { retries: 1.5 },
      { retries: Number.NaN },
      { retries: '3' },
      { backoffMs: -1 },
      { backoffMs: Number.POSITIVE_INFINITY },
      { backoffMs: 'x' },
      'nope',
      5,
      null,
      []
    ]
    for (const autoReconnect of bad) {
      const label = JSON.stringify(autoReconnect)
      expect(
        () => validateRuntimeIpcDeclaration({ id: 'bus', transport: 'pipe', autoReconnect }),
        label
      ).toThrow(IpcDeclarationError)
    }

    // Q3 = A（R12）：stdio + autoReconnect → invalid-declaration（文案给出替代路径）
    expect(() =>
      validateRuntimeIpcDeclaration({
        id: 'w',
        transport: 'stdio',
        program: 'bin/w.js',
        autoReconnect: {}
      })
    ).toThrow(/只支持 pipe/)
    expect(() =>
      validateRuntimeIpcDeclaration({
        id: 'w',
        transport: 'stdio',
        program: 'bin/w.js',
        autoReconnect: {}
      })
    ).toThrow(/自行 connect\(\)/)

    // 不传该键 → 与清单路径**同形**（运行时能力存在，但不声明就不启用）
    expect(validateRuntimeIpcDeclaration({ id: 'bus', transport: 'pipe' })).toEqual({
      id: 'bus',
      transport: 'pipe'
    })

    // 常量单源
    expect(MAX_BACKOFF_MS).toBe(30_000)
    expect(DEFAULT_RECONNECT_RETRIES).toBe(3)
    expect(DEFAULT_RECONNECT_BACKOFF_MS).toBe(250)
  })
})
