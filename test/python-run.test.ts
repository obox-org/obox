/**
 * 解释器脚本启动/收尾的**真实子进程**测试（issue #51）。
 *
 * 用宿主自带的 Node 冒充"解释器"（本模块不关心解释器是什么，只关心 shell 调用、参数转义、
 * 输出收集与进程树终止），因此不需要真的 Python 运行时，也不涉及网络与端口。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startPythonRun } from '../src/main/pythonRun'

let dir = ''
const nodeExe = process.execPath

/** cmd.exe 需要的最小环境（SystemRoot 供 cmd.exe 自身启动，PATH 供定位 cmd.exe） */
const baseEnv: Record<string, string> = {
  SystemRoot: process.env.SystemRoot ?? '',
  PATH: process.env.PATH ?? '',
  TEMP: process.env.TEMP ?? '',
  TMP: process.env.TMP ?? ''
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'obox-pyrun-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function writeScript(name: string, body: string): Promise<string> {
  const file = join(dir, name)
  await fs.writeFile(file, body, 'utf8')
  return file
}

describe('startPythonRun · 启动与输出', () => {
  it('正常结束：取到退出码与 stdout', async () => {
    const script = await writeScript('ok.cjs', 'console.log("hello-stdout")\nprocess.exit(0)\n')
    const handle = startPythonRun({ pythonExe: nodeExe, script, cwd: dir, env: baseEnv })
    const result = await handle.result
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('hello-stdout')
    expect(result.stderr).toBe('')
    expect(result.truncated).toBe(false)
  })

  it('非零退出码原样返回（脚本自身失败不算宿主故障）', async () => {
    const script = await writeScript('fail.cjs', 'process.exit(3)\n')
    const result = await startPythonRun({
      pythonExe: nodeExe,
      script,
      cwd: dir,
      env: baseEnv
    }).result
    expect(result.code).toBe(3)
  })

  it('stderr 与 stdout 分开收集', async () => {
    const script = await writeScript('err.cjs', 'console.error("boom-stderr")\n')
    const result = await startPythonRun({
      pythonExe: nodeExe,
      script,
      cwd: dir,
      env: baseEnv
    }).result
    expect(result.stderr).toContain('boom-stderr')
    expect(result.stdout).toBe('')
  })

  it('工作目录生效（脚本里 process.cwd() 即传入的 cwd）', async () => {
    const script = await writeScript('cwd.cjs', 'console.log(process.cwd())\n')
    const result = await startPythonRun({
      pythonExe: nodeExe,
      script,
      cwd: dir,
      env: baseEnv
    }).result
    expect(resolve(result.stdout.trim().toLowerCase())).toBe(resolve(dir.toLowerCase()))
  })

  it('pid() 暴露直接子进程 pid（进程树终止用）', async () => {
    const script = await writeScript('pid.cjs', 'setTimeout(() => process.exit(0), 200)\n')
    const handle = startPythonRun({ pythonExe: nodeExe, script, cwd: dir, env: baseEnv })
    expect(typeof handle.pid()).toBe('number')
    expect(handle.pid()).toBeGreaterThan(0)
    await handle.result
  })

  it('streams() 交出 stdin/stdout（供 api.ipc 注册通道）', async () => {
    const script = await writeScript('stream.cjs', 'process.exit(0)\n')
    const handle = startPythonRun({ pythonExe: nodeExe, script, cwd: dir, env: baseEnv })
    const { stdin, stdout } = handle.streams()
    expect(stdin).not.toBeNull()
    expect(stdout).not.toBeNull()
    await handle.result
  })
})

describe('startPythonRun · 参数转义（走 shell）', () => {
  it('含空格与元字符的参数原样到达脚本', async () => {
    const script = await writeScript(
      'argv.cjs',
      'console.log(JSON.stringify(process.argv.slice(2)))\n'
    )
    const result = await startPythonRun({
      pythonExe: nodeExe,
      script,
      args: ['a b', '--flag', 'x&y', ''],
      cwd: dir,
      env: baseEnv
    }).result
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual(['a b', '--flag', 'x&y', ''])
  })
})

describe('startPythonRun · 输出上限与终止', () => {
  it('输出超限 → 截断并标记 truncated', async () => {
    const script = await writeScript('big.cjs', 'process.stdout.write("x".repeat(5000))\n')
    const result = await startPythonRun({
      pythonExe: nodeExe,
      script,
      cwd: dir,
      env: baseEnv,
      maxOutputBytes: 100
    }).result
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(100)
  })

  it('kill() 终止长跑脚本并等它结束（进程树终止）', async () => {
    const script = await writeScript('sleep.cjs', 'setTimeout(() => process.exit(0), 60000)\n')
    const handle = startPythonRun({ pythonExe: nodeExe, script, cwd: dir, env: baseEnv })
    await new Promise((r) => setTimeout(r, 300))
    const startedAt = Date.now()
    await handle.kill()
    const result = await handle.result
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(result.code).not.toBe(0)
  }, 20_000)
})
