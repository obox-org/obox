/**
 * 单实例纯逻辑的测试（ADR-0019 决策 9）：参数过滤与日志文案。
 * 关键行为是"用户参数要出现在日志里"（否则调试扩展被静默忽略会极难排查）。
 */
import { describe, expect, it } from 'vitest'
import { ignoredArgs, secondaryInstanceNotice } from '../src/main/singleInstanceCore'

describe('ignoredArgs', () => {
  it('挑出用户开关，忽略 Electron 自注入的开关', () => {
    expect(
      ignoredArgs([
        '.',
        '--debug-extension',
        'demo@C:\\dev\\demo',
        '--remote-debugging-port=9333',
        '--allow-file-access-from-files',
        '--user-data-dir=C:\\tmp\\ud',
        '--no-sandbox',
        'plain-arg'
      ])
    ).toEqual(['--debug-extension', 'demo@C:\\dev\\demo', '--remote-debugging-port=9333'])
  })

  it('没有开关时返回空数组', () => {
    expect(ignoredArgs(['.', 'plain'])).toEqual([])
    expect(ignoredArgs([])).toEqual([])
  })
})

describe('secondaryInstanceNotice', () => {
  it('列出被忽略的参数（可查性：调试扩展不会被静默吞掉）', () => {
    const notice = secondaryInstanceNotice(['.', '--debug-extension', 'demo@C:\\dev\\demo'])
    expect(notice).toContain('已有 obox 实例在运行')
    expect(notice).toContain('--debug-extension demo@C:\\dev\\demo')
    expect(notice).toContain('唤到前台')
  })

  it('无参数时给出不带清单的文案', () => {
    const notice = secondaryInstanceNotice(['.'])
    expect(notice).toContain('已有 obox 实例在运行')
    expect(notice).not.toContain('被忽略（')
  })

  it('应用名可注入', () => {
    expect(secondaryInstanceNotice(['.'], 'obox-dev')).toContain('obox-dev')
  })
})
