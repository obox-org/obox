import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { findRuntimeVersionConflict, readRuntimeMarker } from '../src/main/runtimeInstallGuard'

/**
 * 同版本内置运行时唯一性（change「开发运行时」，用户明确要求）。
 *
 * 用真实临时目录：这是安装期守卫，靠 mock fs 测不出"覆盖安装忽略自身"这类真实路径行为。
 */
let root = ''

async function makeRuntime(extensionsDir: string, dir: string, version: string): Promise<void> {
  await mkdir(join(extensionsDir, dir), { recursive: true })
  await writeFile(
    join(extensionsDir, dir, 'runtime.json'),
    JSON.stringify({ language: 'python', version }),
    'utf8'
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'obox-runtime-guard-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('运行时 marker 读取', () => {
  it('合法 marker 返回版本；缺文件/坏 JSON/非 python 返回 null', async () => {
    const okDir = join(root, 'ok')
    await mkdir(okDir, { recursive: true })
    await writeFile(join(okDir, 'runtime.json'), '{"language":"python","version":"3.12.4"}')
    expect(await readRuntimeMarker(okDir)).toEqual({ version: '3.12.4' })

    expect(await readRuntimeMarker(join(root, 'nope'))).toBeNull()

    const badDir = join(root, 'bad')
    await mkdir(badDir, { recursive: true })
    await writeFile(join(badDir, 'runtime.json'), '{broken')
    expect(await readRuntimeMarker(badDir)).toBeNull()

    const nodeDir = join(root, 'node')
    await mkdir(nodeDir, { recursive: true })
    await writeFile(join(nodeDir, 'runtime.json'), '{"language":"node","version":"20"}')
    expect(await readRuntimeMarker(nodeDir)).toBeNull()
  })
})

describe('同版本冲突', () => {
  it('已有同版本 ⇒ 返回冲突目录名', async () => {
    await makeRuntime(root, 'python3.12.obox', '3.12.4')
    expect(await findRuntimeVersionConflict(root, '3.12.4')).toBe('python3.12.obox')
  })

  it('版本不同 ⇒ 不冲突（允许并存）', async () => {
    await makeRuntime(root, 'python3.12.obox', '3.12.4')
    expect(await findRuntimeVersionConflict(root, '3.11.9')).toBeNull()
  })

  it('覆盖安装忽略自身目录', async () => {
    await makeRuntime(root, 'python3.12.obox', '3.12.4')
    expect(await findRuntimeVersionConflict(root, '3.12.4', 'python3.12.obox')).toBeNull()
  })

  it('普通扩展（无 marker）不参与冲突', async () => {
    await mkdir(join(root, 'pet.chenzhi'), { recursive: true })
    expect(await findRuntimeVersionConflict(root, '3.12.4')).toBeNull()
  })

  it('目录不存在 ⇒ null（不抛）', async () => {
    expect(await findRuntimeVersionConflict(join(root, 'missing'), '3.12.4')).toBeNull()
  })
})
