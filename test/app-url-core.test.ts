/**
 * `app://` 解析核心（change `unified-page-context` 任务 3.2）。
 *
 * 只测**纯解析**（URL → 磁盘路径 + 越界拒绝），不碰 electron：
 * - 四个命名空间：extensions（系统根优先）/ builtin / debug / **obox（页面运行时）**；
 * - 非法百分号转义 → 400；未知 host、空路径、`..` → 404；规范化后越界 → 403；
 * - 解析成功时回传所属根（协议处理器用它做 realpath 二次校验）。
 */
import { describe, expect, it } from 'vitest'
import { resolveAppUrl, type AppUrlContext } from '../src/main/appUrlCore'

const SYSTEM = 'C:\\app\\extensions'
const USER = 'C:\\user\\extensions'
const RUNTIME = 'C:\\app\\resources\\page-runtime'

function ctx(overrides: Partial<AppUrlContext> = {}): AppUrlContext {
  const existing = new Set([`${SYSTEM}\\settings`, `${USER}\\pet.chenzhi`])
  return {
    systemRoot: SYSTEM,
    userRoot: USER,
    pageRuntimeDir: RUNTIME,
    debugExtensions: new Map([['dbg', 'C:\\dev\\dbg-ext']]),
    exists: (dir: string): boolean => existing.has(dir),
    ...overrides
  }
}

describe('app:// 解析 · 四个命名空间', () => {
  it('obox 命名空间映射到页面运行时目录（新增）', () => {
    const r = resolveAppUrl('app://obox/page.js', ctx())
    expect(r).toEqual({ status: 200, filePath: `${RUNTIME}\\page.js`, root: RUNTIME })
  })

  it('extensions 优先系统根，缺失时回落用户根', () => {
    expect(resolveAppUrl('app://extensions/settings/index.html', ctx())).toMatchObject({
      status: 200,
      root: SYSTEM,
      filePath: `${SYSTEM}\\settings\\index.html`
    })
    expect(resolveAppUrl('app://extensions/pet.chenzhi/page.html', ctx())).toMatchObject({
      status: 200,
      root: USER,
      filePath: `${USER}\\pet.chenzhi\\page.html`
    })
  })

  it('builtin 恒用系统根', () => {
    expect(resolveAppUrl('app://builtin/app/index.html', ctx())).toMatchObject({
      status: 200,
      root: SYSTEM
    })
  })

  it('debug 用调试扩展声明目录，并把 id 段从路径里剥掉', () => {
    expect(resolveAppUrl('app://debug/dbg/ui/index.html', ctx())).toMatchObject({
      status: 200,
      root: 'C:\\dev\\dbg-ext',
      filePath: 'C:\\dev\\dbg-ext\\ui\\index.html'
    })
  })
})

describe('app:// 解析 · 拒绝', () => {
  it('非法百分号转义 → 400', () => {
    expect(resolveAppUrl('app://obox/%', ctx()).status).toBe(400)
  })

  it('未知 host / 空路径 / 根解析不到 → 404', () => {
    expect(resolveAppUrl('app://nope/x', ctx()).status).toBe(404)
    expect(resolveAppUrl('app://box/', ctx()).status).toBe(404)
    expect(resolveAppUrl('app://extensions/missing/index.html', ctx()).status).toBe(404)
    expect(resolveAppUrl('app://debug/unknown/x', ctx()).status).toBe(404)
  })

  it('解码后含 .. 的段 → 404（URL 只归一化 `/` 分隔的 dot 段，反斜杠形式会落到实现里）', () => {
    expect(resolveAppUrl('app://obox/..%5Csecret.js', ctx()).status).toBe(404)
    expect(resolveAppUrl('app://extensions/settings/..%5C..%5Cx', ctx()).status).toBe(404)
  })

  it('URL 自带的 ../ 会被标准解析器归一化，但结果仍落在根内', () => {
    const r = resolveAppUrl('app://obox/../secret.js', ctx())
    expect(r.status).toBe(200)
    expect(r.status === 200 && r.filePath.startsWith(`${RUNTIME}\\`)).toBe(true)
  })

  it('盘符风格路径不会被拼出根外', () => {
    const r = resolveAppUrl('app://obox//C:/Windows/win.ini', ctx())
    // join 会把它当相对段拼在根下（Windows 下 `C:` 段不构成新盘符）；只要不逃出根就接受
    if (r.status === 200) {
      expect(r.filePath.startsWith(`${RUNTIME}\\`)).toBe(true)
    } else {
      expect([403, 404]).toContain(r.status)
    }
  })

  it('畸形 URL → 400', () => {
    expect(resolveAppUrl('not a url', ctx()).status).toBe(400)
  })
})
