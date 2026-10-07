/**
 * 许可汇总 CLI 的集成测试（issue #51）：真实调用 `scripts/collect-python-licenses.mts`，
 * 用临时夹具覆盖 生成 → --check 通过 → 内容变更 → --check 失败 → BOM 容错。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ext = ''
const cli = join(process.cwd(), 'scripts', 'collect-python-licenses.mts')

beforeEach(async () => {
  ext = await fs.mkdtemp(join(tmpdir(), 'obox-lic-'))
  await fs.mkdir(join(ext, 'python', 'Lib', 'site-packages', 'x-1.0.dist-info', 'licenses'), {
    recursive: true
  })
  await fs.mkdir(join(ext, 'python', 'tcl', 'tcl8.6'), { recursive: true })
  await fs.writeFile(join(ext, 'manifest.json'), JSON.stringify({ name: 'demo-ext' }), 'utf8')
  await fs.writeFile(
    join(ext, 'python-package.json'),
    JSON.stringify({ arch: 'x64', python: '3.13.16' }),
    'utf8'
  )
  await fs.writeFile(
    join(ext, 'python', 'LICENSE.txt'),
    'Copyright (c) 2001 Python Software Foundation; All Rights Reserved',
    'utf8'
  )
  await fs.writeFile(
    join(ext, 'python', 'Lib', 'site-packages', 'x-1.0.dist-info', 'licenses', 'LICENSE'),
    'MIT License',
    'utf8'
  )
  await fs.writeFile(
    join(ext, 'python', 'tcl', 'tcl8.6', 'license.terms'),
    'Tcl license terms',
    'utf8'
  )
})

afterEach(async () => {
  await fs.rm(ext, { recursive: true, force: true })
})

function runCli(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('collect-python-licenses.mts', () => {
  it('生成声明与指纹，随后 --check 通过', async () => {
    const generated = runCli(['--ext', ext])
    expect(generated.output).toContain('已写')
    const notices = await fs.readFile(join(ext, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
    expect(notices).toContain('demo-ext 第三方许可与声明')
    expect(notices).toContain('CPython 3.13.16，x64')
    // 三份许可都被收进来：运行时 LICENSE、wheel 的 dist-info/licenses、Tcl 的 license.terms
    expect(notices).toContain('--- python/LICENSE.txt ---')
    expect(notices).toContain('--- python/Lib/site-packages/x-1.0.dist-info/licenses/LICENSE ---')
    expect(notices).toContain('--- python/tcl/tcl8.6/license.terms ---')
    // PSF 第 3 条要求的"对 Python 的修改摘要"
    expect(notices).toContain('对 Python 的修改摘要')

    const checked = runCli(['--ext', ext, '--check'])
    expect(checked.status).toBe(0)
    expect(checked.output).toContain('✓')
  })

  it('包内许可内容变化后 --check 失败（防漂移）', async () => {
    runCli(['--ext', ext])
    await fs.appendFile(
      join(ext, 'python', 'Lib', 'site-packages', 'x-1.0.dist-info', 'licenses', 'LICENSE'),
      '\nchanged-after-generation',
      'utf8'
    )
    const checked = runCli(['--ext', ext, '--check'])
    expect(checked.status).toBe(1)
    expect(checked.output).toContain('许可内容已变化')
    expect(checked.output).toContain('重新生成')
  })

  it('缺声明文件时 --check 失败', async () => {
    const checked = runCli(['--ext', ext, '--check'])
    expect(checked.status).toBe(1)
    expect(checked.output).toContain('缺少 THIRD-PARTY-NOTICES.txt')
  })

  it('清单带 BOM 也能读（别的工具/编辑器写出来的情况）', async () => {
    // 模拟 PowerShell `Set-Content -Encoding utf8` 的产物：UTF-8 **带** BOM
    await fs.writeFile(
      join(ext, 'python-package.json'),
      `\uFEFF${JSON.stringify({ arch: 'arm64', python: '3.13.16' })}`,
      'utf8'
    )
    const generated = runCli(['--ext', ext])
    expect(generated.status).toBe(0)
    const notices = await fs.readFile(join(ext, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
    expect(notices).toContain('CPython 3.13.16，arm64')
  })

  it('缺运行时目录时给出可执行的报错', async () => {
    await fs.rm(join(ext, 'python'), { recursive: true, force: true })
    const generated = runCli(['--ext', ext])
    expect(generated.status).not.toBe(0)
    expect(generated.output).toContain('build-python-runtime.mts')
  })
})
