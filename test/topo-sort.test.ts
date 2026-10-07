/**
 * 扩展依赖拓扑排序单测（manifest.topoSort）。
 * 覆盖：依赖先于被依赖者、缺失依赖不阻塞、依赖环被标记。
 */
import { describe, expect, it } from 'vitest'
import { topoSort } from '../src/renderer/src/core/manifest'
import type { ExtensionInfo } from '../src/renderer/src/core/types'

/** 构造最小可用的 ExtensionInfo（只用到 id/enabled/manifest.extensionDependencies） */
function ext(id: string, deps: string[] = [], enabled = true): ExtensionInfo {
  return {
    id,
    manifest: { name: id, version: '1.0.0', main: './index.js', extensionDependencies: deps },
    source: 'user',
    isValid: true,
    validations: [],
    enabled,
    isActive: false
  }
}

const ids = (list: ExtensionInfo[]): string[] => list.map((e) => e.id)

describe('topoSort', () => {
  it('依赖排在被依赖者之前（链式 a → b → c）', () => {
    // a 依赖 b，b 依赖 c：激活顺序应为 c, b, a
    const { ordered, cyclic } = topoSort([ext('a', ['b']), ext('b', ['c']), ext('c')])
    expect(ids(ordered)).toEqual(['c', 'b', 'a'])
    expect(cyclic).toEqual([])
  })

  it('无依赖时保持输入顺序', () => {
    const { ordered } = topoSort([ext('x'), ext('y'), ext('z')])
    expect(ids(ordered)).toEqual(['x', 'y', 'z'])
  })

  it('缺失依赖不阻塞（依赖不在列表中也能排入）', () => {
    const { ordered } = topoSort([ext('only', ['missing'])])
    expect(ids(ordered)).toEqual(['only'])
  })

  it('依赖环被标记（环内扩展仍进入 ordered）', () => {
    const { ordered, cyclic } = topoSort([ext('a', ['b']), ext('b', ['a'])])
    // 实现标记的是"回边指向的节点"（a→b→a 时标 a），不展开整个环；
    // 但保证环内扩展仍会进入 ordered（排在最后），不会因环而漏激活
    expect(ids(cyclic)).toEqual(['a'])
    expect(ids(ordered).sort()).toEqual(['a', 'b'])
  })

  it('菱形依赖：共同依赖只出现一次', () => {
    // a → (b, c) → d
    const { ordered } = topoSort([ext('a', ['b', 'c']), ext('b', ['d']), ext('c', ['d']), ext('d')])
    expect(ids(ordered).filter((x) => x === 'd')).toHaveLength(1)
    expect(ids(ordered).indexOf('d')).toBeLessThan(ids(ordered).indexOf('b'))
    expect(ids(ordered).indexOf('d')).toBeLessThan(ids(ordered).indexOf('c'))
    expect(ids(ordered).indexOf('a')).toBe(ids(ordered).length - 1)
  })
})
