/**
 * `dialog:open` 的 properties 归一与接线门禁（spec §9.11 H-1 / H-6）。
 *
 * 背景：宿主原先把 `properties` **硬编码**为 `['openFile']`（旧 `src/main/ext.ts:22-31`），
 * 扩展无法弹「选目录」框。本轮是**纯加法**：新增可选 `properties`，默认行为必须逐字不变。
 *
 * 为什么这样测：仓库 vitest 是 `environment: 'node'`（无 jsdom、**不 mock Electron**，
 * 先例 `test/settings-view-wiring.test.ts:1-11`）⇒ 不尝试真正弹框；用
 * ① 纯函数表驱动 + ② 读源文件断言接线 覆盖，与既有测试风格一致。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isDirectoryProperties,
  normalizeDialogProperties,
  type NormalizedDialogProperties
} from '../src/main/ext'
import type { DialogProperty } from '../src/shared/types'

/** ext.ts 源码（去掉块注释、行注释，避免文档里的示例字符串把断言喂成假绿） */
function extSource(): string {
  const path = fileURLToPath(new URL('../src/main/ext.ts', import.meta.url))
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('normalizeDialogProperties · properties 归一（表驱动）', () => {
  const cases: Array<{
    name: string
    input?: Parameters<typeof normalizeDialogProperties>[0]
    expected: NormalizedDialogProperties
  }> = [
    // —— 默认行为逐字不变 ——
    { name: '不传 opts ⇒ 默认 openFile', input: undefined, expected: ['openFile'] },
    { name: '传空对象 ⇒ 默认 openFile', input: {}, expected: ['openFile'] },
    {
      name: 'properties 显式 undefined ⇒ 默认 openFile',
      input: { properties: undefined },
      expected: ['openFile']
    },
    {
      name: 'properties 传空数组 ⇒ 默认 openFile',
      input: { properties: [] },
      expected: ['openFile']
    },
    // —— 既有调用者的两种老写法 ——
    {
      name: '单传 openFile ⇒ 保持 openFile',
      input: { properties: ['openFile'] },
      expected: ['openFile']
    },
    {
      name: '旧字段 multiSelect:true ⇒ openFile + multiSelections',
      input: { multiSelect: true },
      expected: ['openFile', 'multiSelections']
    },
    // —— 新增能力 ——
    {
      name: '单传 openDirectory ⇒ 目录模式',
      input: { properties: ['openDirectory'] },
      expected: ['openDirectory']
    },
    {
      name: 'openDirectory + multiSelections ⇒ 两者都在（目录在前）',
      input: { properties: ['openDirectory', 'multiSelections'] },
      expected: ['openDirectory', 'multiSelections']
    },
    // —— 互斥：同时传按 openDirectory 归一，丢弃 openFile ——
    {
      name: 'openFile + openDirectory 同传 ⇒ 只保留 openDirectory',
      input: { properties: ['openFile', 'openDirectory'] },
      expected: ['openDirectory']
    },
    {
      name: '三个同传（+ multiSelections）⇒ 只保留 openDirectory + multiSelections',
      input: { properties: ['openFile', 'openDirectory', 'multiSelections'] },
      expected: ['openDirectory', 'multiSelections']
    },
    {
      name: '目录模式 + 旧字段 multiSelect:true ⇒ 目录模式仍带 multiSelections',
      input: { properties: ['openDirectory'], multiSelect: true },
      expected: ['openDirectory', 'multiSelections']
    },
    {
      name: '目录模式下 multiSelect:false 不追加 multiSelections',
      input: { properties: ['openDirectory'], multiSelect: false },
      expected: ['openDirectory']
    },
    // —— 未知值：忽略，不抛错 ——
    {
      name: '未知值单独传 ⇒ 回落默认 openFile',
      input: { properties: ['showHiddenFiles'] as unknown as DialogProperty[] },
      expected: ['openFile']
    },
    {
      name: '未知值 + openFile ⇒ 只留 openFile',
      input: { properties: ['openFile', 'nonsense'] as unknown as DialogProperty[] },
      expected: ['openFile']
    },
    {
      name: '未知值 + 两个合法值 ⇒ 未知值被丢掉',
      input: {
        properties: ['bogus', 'openFile', 'multiSelections'] as unknown as DialogProperty[]
      },
      expected: ['openFile', 'multiSelections']
    },
    {
      name: 'properties 传非数组（宿主侧可能收到退化输入）⇒ 不抛错、回落默认',
      input: { properties: 'openDirectory' } as unknown as Parameters<
        typeof normalizeDialogProperties
      >[0],
      expected: ['openFile']
    }
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(normalizeDialogProperties(c.input)).toEqual(c.expected)
    })
  }

  it('返回值是**新数组**，改它不会污染后续调用（无模块级可变状态）', () => {
    const first = normalizeDialogProperties()
    first.push('openDirectory')
    expect(normalizeDialogProperties()).toEqual(['openFile'])
  })

  it('isDirectoryProperties：只有目录模式为 true', () => {
    expect(isDirectoryProperties(['openDirectory'])).toBe(true)
    expect(isDirectoryProperties(['openDirectory', 'multiSelections'])).toBe(true)
    expect(isDirectoryProperties(['openFile'])).toBe(false)
    expect(isDirectoryProperties(['openFile', 'multiSelections'])).toBe(false)
  })
})

/**
 * 源码门禁（spec §9.11 H-6 第 ②③ 条）：不能重新长出硬编码 `properties`。
 * 纯函数单测证明"归一结果对不对"，这里证明"handler 真的用了它、并且两分支共用一个结果"。
 */
describe('src/main/ext.ts · dialog:open 接线门禁', () => {
  it("handler 里**不再**硬编码 properties: ['openFile'（全文件都不许出现）", () => {
    const src = extSource()
    expect(src).not.toContain("properties: ['openFile'")
    expect(src).not.toContain('properties: ["openFile"')
  })

  it('properties 由 normalizeDialogProperties(opts) 得到，且 win / 无 win **两分支共用同一结果**', () => {
    const src = extSource()
    expect(src).toContain('export function normalizeDialogProperties(')
    // 归一结果先落到一个局部变量……
    expect(src).toContain('const properties = normalizeDialogProperties(opts)')
    // ……再被两个分支各自引用（不是各写一遍属性数组）：opts.properties / 参数 / 局部变量 / 调用，至少 4 处
    const mentions = src.match(/\bproperties\b/g) ?? []
    expect(mentions.length).toBeGreaterThanOrEqual(4)
    expect(src).toContain('dialog.showOpenDialog(win, { title: opts?.title, filters, properties })')
    expect(src).toContain('dialog.showOpenDialog({ title: opts?.title, filters, properties })')
  })

  it('目录模式下 filters 被丢弃（Electron 不对目录应用过滤器）', () => {
    const src = extSource()
    expect(src).toContain(
      'const filters = isDirectoryProperties(properties) ? undefined : opts?.filters'
    )
    expect(src).toContain('export function isDirectoryProperties(')
  })

  it('返回形状不变（仍是 filePaths/canceled，两条分支同一个 return）', () => {
    const src = extSource()
    expect(src).toContain(
      'return { ok: true, filePaths: result.filePaths, canceled: result.canceled }'
    )
    // 只取 dialog:open 那一段实现体：从 `'dialog:open',` 到下一个 `ipcMain.handle(`
    const start = src.indexOf("'dialog:open',")
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('ipcMain.handle(', start)
    const body = src.slice(start, end === -1 ? undefined : end)
    expect(body).not.toBe('')
    // handler 里只有这两处 return：成功形状不变（仍是 filePaths/canceled），失败形状不变
    const returns = body.match(/return \{[^}]*\}/g) ?? []
    expect(returns).toEqual([
      'return { ok: true, filePaths: result.filePaths, canceled: result.canceled }',
      'return { ok: false, error: err instanceof Error ? err.message : String(err) }'
    ])
    // 成功形状在**全文件**里也只准出现这一次（不许别的分支另造一个返回形状）
    expect(src.match(/filePaths: result\.filePaths/g) ?? []).toHaveLength(1)
  })

  it('preload / host 仍是直通（无需改代码，只是类型换成了共用类型）', () => {
    const preload = readFileSync(
      fileURLToPath(new URL('../src/preload/index.ts', import.meta.url)),
      'utf8'
    )
    expect(preload).toContain("dialogOpen: (opts) => ipcRenderer.invoke('dialog:open', opts)")
    const host = readFileSync(
      fileURLToPath(new URL('../src/renderer/src/core/host.ts', import.meta.url)),
      'utf8'
    )
    expect(host).toContain('showOpenDialog: (opts) => window.api.dialogOpen(opts ?? {})')
  })
})
