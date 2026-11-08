/**
 * 扩展语言包（contributes.i18n）的清单校验 + 系统扩展词条对齐（change `unified-page-context` 任务 6.4）。
 *
 * 覆盖判据：
 * - 三个系统扩展与两个内置主题的 `contributes.i18n`：zh/en **键集合完全一致**（不漏翻）；
 * - 宿主 `validateManifest` 与仓库脚本 `validate-manifest.mjs` 对 i18n 形状给同一组文案（差分门禁）；
 * - 形状错误（非对象 / 非字符串值）是 error；zh/en 不一致是 warning（不阻断加载）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../src/renderer/src/core/manifest'
import { validateManifest as validateManifestScript } from '../scripts/validate-manifest.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${repoRoot}${rel}`, 'utf8')) as Record<string, unknown>
}

function zhEnKeys(dict: Record<string, unknown>): { zh: string[]; en: string[] } {
  return {
    zh: Object.keys((dict.zh as Record<string, unknown>) ?? {}),
    en: Object.keys((dict.en as Record<string, unknown>) ?? {})
  }
}

const MANIFESTS = [
  'system-extensions/app/manifest.json',
  'system-extensions/settings/manifest.json',
  'system-extensions/ext-manager/manifest.json',
  'src/renderer/src/extensions/theme-dark/manifest.json',
  'src/renderer/src/extensions/theme-light/manifest.json'
]

describe('系统扩展与主题的 zh/en 词条对齐', () => {
  it.each(MANIFESTS)('%s：zh/en 键集合完全一致', (rel) => {
    const manifest = readJson(rel)
    const dict = (manifest.contributes as Record<string, unknown>).i18n as Record<string, unknown>
    expect(dict, `${rel} 缺少 contributes.i18n`).toBeTruthy()
    const { zh, en } = zhEnKeys(dict)
    expect(zh.length).toBeGreaterThan(0)
    expect([...zh].sort()).toEqual([...en].sort())
  })
})

describe('清单校验：宿主与脚本同文案', () => {
  function both(raw: unknown): { host: string[]; script: string[] } {
    return {
      host: validateManifest(raw).map((m) => `${m.severity}\u0000${m.message}`),
      script: validateManifestScript(raw, 4).map(
        (m: { level: string; message: string }) => `${m.level}\u0000${m.message}`
      )
    }
  }

  it('合法 i18n：两侧都不报', () => {
    const raw = {
      name: 'demo',
      version: '1.0.0',
      main: './index.js',
      contributes: { i18n: { zh: { a: '甲' }, en: { a: 'A' } } }
    }
    const { host, script } = both(raw)
    expect(host).toEqual([])
    expect(script).toEqual([])
  })

  it('zh/en 键不一致：两侧同一句 warning', () => {
    const raw = {
      name: 'demo',
      version: '1.0.0',
      main: './index.js',
      contributes: { i18n: { zh: { a: '甲', b: '乙' }, en: { a: 'A' } } }
    }
    const { host, script } = both(raw)
    const expected = 'warning\u0000contributes.i18n 的 zh/en 词条键不一致：b'
    expect(host).toEqual([expected])
    expect(script).toEqual([expected])
  })

  it('非对象 / 非字符串：两侧同一组 error', () => {
    for (const i18n of [5, [], { zh: 'x' }, { zh: { a: 1 } }]) {
      const raw = {
        name: 'demo',
        version: '1.0.0',
        main: './index.js',
        contributes: { i18n }
      }
      const { host, script } = both(raw)
      expect(script, JSON.stringify(i18n)).toEqual(host)
      expect(host.every((line) => line.startsWith('error'))).toBe(true)
    }
  })
})
