/**
 * .oix 解压限额（issue #51 决策 12）与元数据形状防漂移（issue #52）。
 *
 * 限额因"运行时等大文件随扩展包分发"而放宽，但**仍是硬上限**：
 * 超限依旧以 `too-large` 拒绝并回滚（具体用例见 test/oix-install.test.ts 的限额分支）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES } from '../src/main/oixCore'
import type { ExtensionMeta } from '../src/shared/types'
import type { HookState } from '../src/renderer/src/core/hookState'

// 类型层防漂移：`.obox-meta.json` 的元数据形状必须与 hookState 的 HookState 双向兼容，
// 否则主进程写的标记渲染进程读不懂（编译期就会在这里报错，而不是运行时静默失效）。
const metaSample: ExtensionMeta = {
  installedTimestamp: 1,
  pendingInstall: { version: '1.0.0', at: 1 }
}
const asHookState: HookState = metaSample
const hookStateSample: HookState = { install: { version: '1.0.0', at: 1, ok: true } }
const asMeta: ExtensionMeta = hookStateSample

describe('oix 解压限额（已放宽，仍是硬上限）', () => {
  it('条目上限 10000、总量上限 512 MiB', () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(10000)
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(512 * 1024 * 1024)
  })

  it('限额与钩子元数据形状可双向赋值（防主进程与渲染进程两套定义漂移）', () => {
    expect(asHookState.pendingInstall?.version).toBe('1.0.0')
    expect(asMeta.install?.ok).toBe(true)
    expect(Object.keys(metaSample)).toContain('pendingInstall')
  })
})
