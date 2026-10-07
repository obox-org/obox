/**
 * 真实 Python 的端到端测试（issue #51）：**只有设置 `OBOX_PYTHON_EXE` 时才运行**，
 * 这样 CI 不必下载运行时，而本地/发布前可以真机验证。
 *
 *   $env:OBOX_PYTHON_EXE = "$env:TEMP\obox-python-real\python\python.exe"; npm test
 *
 * 它验证的是"单测用 Node 冒充解释器"覆盖不到的部分：真实解释器 + shell 调用 + 分帧 + 双向 + 进程树终止，
 * 以及 ADR-0018 里那份"不可删清单"（tkinter/ssl/sqlite3/unicodedata/venv/ensurepip/tomllib/pip）在真机上确实可用。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openStreamTransport } from '../src/main/ipcTransport'
import { buildPythonEnv, pythonUserSiteDir } from '../src/main/pythonCore'
import { startPythonRun } from '../src/main/pythonRun'

const pythonExe = process.env.OBOX_PYTHON_EXE
const peerScript = resolve('scripts', 'fixtures', 'python-peer.py')
/**
 * 含 `python/` 的那一层目录（真实部署里就是扩展目录）。
 * 注意：`buildPythonEnv` 会把 `PYTHONHOME` 设成 `<extensionDir>/python`——传错这一层解释器直接起不来
 * （本地第一次跑就是这么挂了 4 个用例），所以这里从 python.exe 的路径反推：`<ext>/python/python.exe`。
 */
const extensionDir = pythonExe ? resolve(pythonExe, '..', '..') : resolve('.')

describe.skipIf(!pythonExe)('真实 Python 端到端（裁剪运行时）', () => {
  let dataDir = ''

  const env = (): Record<string, string> =>
    buildPythonEnv({ baseEnv: process.env, extensionDir, dataDir })

  const runScript = (
    script: string,
    args?: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    startPythonRun({ pythonExe: pythonExe as string, script, args, cwd: dataDir, env: env() })
      .result

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'obox-py-real-'))
    await fs.mkdir(pythonUserSiteDir(dataDir), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('跑脚本：退出码与 stdout 正常', async () => {
    const script = join(dataDir, 'hello.py')
    await fs.writeFile(script, 'print("hello-from-real-python")\n', 'utf8')
    const result = await runScript(script)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('hello-from-real-python')
  })

  it('不可删清单在真机上成立（tkinter/ssl/sqlite3/unicodedata/ctypes/venv/ensurepip/tomllib/pip）', async () => {
    const script = join(dataDir, 'mods.py')
    await fs.writeFile(
      script,
      [
        'import importlib.util, sys',
        'mods = ["tkinter", "ssl", "sqlite3", "unicodedata", "ctypes", "hashlib", "venv", "ensurepip", "tomllib", "zlib", "lzma", "bz2", "xml.etree.ElementTree"]',
        'missing = [m for m in mods if importlib.util.find_spec(m) is None]',
        'print("missing:", missing)',
        'print("pip:", importlib.util.find_spec("pip") is not None)',
        'sys.exit(1 if missing else 0)'
      ].join('\n'),
      'utf8'
    )
    const result = await runScript(script)
    expect(result.stdout).toContain('missing: []')
    expect(result.stdout).toContain('pip: True')
    expect(result.code).toBe(0)
  })

  it('shell 调用的参数转义在真实解释器上成立（含空格与元字符）', async () => {
    const script = join(dataDir, 'argv.py')
    await fs.writeFile(script, 'import json, sys\nprint(json.dumps(sys.argv[1:]))\n', 'utf8')
    const result = await runScript(script, ['a b', 'x&y', ''])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual(['a b', 'x&y', ''])
  })

  it('双向 JSON-RPC 通道打通，且 kill() 终止进程树', async () => {
    const handle = startPythonRun({
      pythonExe: pythonExe as string,
      script: peerScript,
      cwd: dataDir,
      env: env()
    })
    const streams = handle.streams()
    expect(streams.stdin).not.toBeNull()
    expect(streams.stdout).not.toBeNull()
    const transport = openStreamTransport({
      readable: streams.stdout!,
      writable: streams.stdin!
    })
    const notifications: Array<[string, unknown]> = []
    transport.channel.onNotification((method, params) => notifications.push([method, params]))
    transport.channel.handle('hostTime', () => ({ ok: true }))

    await expect(transport.channel.request('sum', { a: 20, b: 22 })).resolves.toBe(42)
    await expect(transport.channel.request('pyVersion')).resolves.toMatch(/^3\./)

    const deadline = Date.now() + 5000
    while (!notifications.some(([m]) => m === 'gotReply') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(notifications.map(([m]) => m)).toContain('ready')
    expect(notifications.find(([m]) => m === 'gotReply')?.[1]).toEqual({ result: { ok: true } })

    const startedAt = Date.now()
    await handle.kill()
    await handle.result
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    transport.dispose()
  }, 30_000)
})
