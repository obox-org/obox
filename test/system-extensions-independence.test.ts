import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toSerializable } from '../src/renderer/src/core/hostQuery'

/**
 * 系统扩展的**独立性门禁**（change 任务 6.5）与序列化清洗（真机踩到的问题）。
 */
const root = fileURLToPath(new URL('../system-extensions/', import.meta.url))

describe('系统扩展独立性（6.5）', () => {
  it('系统扩展的脚本不得 import 渲染进程内部单例（core/*）', () => {
    const offenders: string[] = []
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      for (const file of readdirSync(`${root}${dir.name}`)) {
        if (!/\.(js|mjs)$/.test(file)) continue
        const src = readFileSync(`${root}${dir.name}/${file}`, 'utf8')
        // 系统扩展是页面脚本：只能经 obox:page-call 调公共 API，不得碰壳子内部模块
        if (/from\s+['"].*core\//.test(src) || /import\(['"].*core\//.test(src)) {
          offenders.push(`${dir.name}/${file}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('三个系统扩展都有清单与入口，且 author 都是 obox', () => {
    for (const name of ['app', 'settings', 'ext-manager']) {
      const dir = `${root}${name}`
      expect(existsSync(`${dir}/manifest.json`), `${name} 缺清单`).toBe(true)
      expect(existsSync(`${dir}/index.html`), `${name} 缺页面`).toBe(true)
      const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')) as {
        name: string
        author: string
      }
      expect(manifest.author).toBe('obox')
      expect(manifest.name).toBe(name)
    }
  })
})

describe('查询结果可序列化（真机问题）', () => {
  it('去掉 Proxy/函数，只留纯数据', () => {
    const reactiveLike = new Proxy(
      { id: 'theme-dark', label: '深色', setTheme: (): void => undefined },
      {}
    )
    const plain = toSerializable(reactiveLike) as Record<string, unknown>
    expect(plain).toEqual({ id: 'theme-dark', label: '深色' })
  })

  it('undefined 原样返回、循环引用回退 null（不让整条调用失败）', () => {
    expect(toSerializable(undefined)).toBeUndefined()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(toSerializable(cyclic)).toBeNull()
  })
})
