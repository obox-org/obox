/**
 * IPC 通道声明校验的测试（issue #45：清单静态声明与运行时声明**同一套规则**）。
 * 覆盖：单条校验矩阵、清单列表校验（数组/逐项/重复 id）、按 id 解析。
 */
import { describe, expect, it } from 'vitest'
import {
  checkIpcChannelList,
  checkIpcDeclaration,
  isValidIpcName,
  IpcDeclarationError,
  resolveIpcChannelDeclaration,
  validateIpcDeclaration
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
