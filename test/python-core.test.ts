/**
 * Python 接入核心的纯函数测试（issue #51 / ADR-0018）。
 * 覆盖：声明校验矩阵、路径约定、环境白名单与注入、cmd 引号转义、通道名、进程树命令、输出截断。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PYTHON_CHANNEL,
  PythonCoreError,
  appendWithCap,
  buildPythonCommandLine,
  buildPythonEnv,
  isPythonCoreError,
  normalizeChannelName,
  processTreeKillCommand,
  pythonExecutablePath,
  pythonUserSiteDir,
  quoteWindowsArg,
  validatePythonDeclaration
} from '../src/main/pythonCore'

describe('validatePythonDeclaration', () => {
  it('接受合法声明并保留可选 requirements（逐项 trim）', () => {
    expect(
      validatePythonDeclaration(
        { arch: 'x64', python: '3.13', requirements: [' matplotlib ', 'numpy'] },
        'x64'
      )
    ).toEqual({ arch: 'x64', python: '3.13', requirements: ['matplotlib', 'numpy'] })
  })

  it('未声明 requirements 时不产生该字段', () => {
    const result = validatePythonDeclaration({ arch: 'arm64', python: '3.12' }, 'arm64')
    expect(result).toEqual({ arch: 'arm64', python: '3.12' })
    expect('requirements' in result).toBe(false)
  })

  it('架构与当前设备不符 → arch-mismatch（安装期拦下）', () => {
    try {
      validatePythonDeclaration({ arch: 'arm64', python: '3.13' }, 'x64')
      throw new Error('应当抛错')
    } catch (error) {
      expect(isPythonCoreError(error)).toBe(true)
      expect((error as PythonCoreError).code).toBe('arch-mismatch')
      expect((error as PythonCoreError).message).toContain('arm64')
      expect((error as PythonCoreError).message).toContain('x64')
    }
  })

  it('不支持或缺失的架构、非对象声明、坏版本号、坏 requirements → invalid-declaration', () => {
    const badInputs: Array<[unknown, string]> = [
      [undefined, '非对象'],
      [null, 'null'],
      [{ arch: 'ia32', python: '3.13' }, '不支持架构'],
      [{ python: '3.13' }, '缺 arch'],
      [{ arch: 'x64' }, '缺 python'],
      [{ arch: 'x64', python: '3' }, '版本缺次版本'],
      [{ arch: 'x64', python: '3.13.1' }, '版本带补丁号'],
      [{ arch: 'x64', python: '3.13', requirements: 'matplotlib' }, 'requirements 非数组'],
      [{ arch: 'x64', python: '3.13', requirements: ['ok', '  '] }, 'requirements 含空串']
    ]
    for (const [input, label] of badInputs) {
      try {
        validatePythonDeclaration(input, 'x64')
        throw new Error(`应当抛错：${label}`)
      } catch (error) {
        expect((error as PythonCoreError).code, label).toBe('invalid-declaration')
      }
    }
  })
})

describe('路径约定', () => {
  it('解释器固定在 <扩展>/python/python.exe', () => {
    expect(pythonExecutablePath('C:\\ext\\demo')).toBe(
      join('C:\\ext\\demo', 'python', 'python.exe')
    )
  })

  it('用户库固定在 <data>/user-site', () => {
    expect(pythonUserSiteDir('C:\\data\\demo')).toBe(join('C:\\data\\demo', 'user-site'))
  })

  it('空目录参数 → invalid-declaration', () => {
    for (const call of [() => pythonExecutablePath(''), () => pythonUserSiteDir('')]) {
      expect(() => call()).toThrowError(PythonCoreError)
    }
  })
})

describe('buildPythonEnv', () => {
  const baseEnv = {
    PATH: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    HOME: 'C:\\Users\\u',
    USERPROFILE: 'C:\\Users\\u',
    LANG: 'zh_CN.UTF-8',
    HTTP_PROXY: 'http://proxy:8080',
    OPENAI_API_KEY: 'sk-secret',
    PYTHONPATH: 'C:\\system\\paths'
  }

  it('只放行白名单键（代理与密钥不进入子进程）', () => {
    const env = buildPythonEnv({
      baseEnv,
      extensionDir: 'C:\\ext\\demo',
      dataDir: 'C:\\data\\demo'
    })
    expect(env.PATH).toBe('C:\\Windows')
    expect(env.LANG).toBe('zh_CN.UTF-8')
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  it('注入 PYTHONHOME / PYTHONPATH(user-site) / PYTHONNOUSERSITE，并覆盖继承来的 PYTHONPATH', () => {
    const env = buildPythonEnv({
      baseEnv,
      extensionDir: 'C:\\ext\\demo',
      dataDir: 'C:\\data\\demo'
    })
    expect(env.PYTHONHOME).toBe(join('C:\\ext\\demo', 'python'))
    expect(env.PYTHONPATH).toBe(join('C:\\data\\demo', 'user-site'))
    expect(env.PYTHONNOUSERSITE).toBe('1')
  })

  it('空字符串的环境值不入结果', () => {
    const env = buildPythonEnv({
      baseEnv: { PATH: '', TEMP: 'C:\\Temp' },
      extensionDir: 'C:\\ext',
      dataDir: 'C:\\data'
    })
    expect('PATH' in env).toBe(false)
    expect(env.TEMP).toBe('C:\\Temp')
  })
})

describe('quoteWindowsArg / buildPythonCommandLine', () => {
  it('无需引号的参数保持原样（含结尾反斜杠）', () => {
    expect(quoteWindowsArg('abc')).toBe('abc')
    expect(quoteWindowsArg(String.raw`C:\py\python.exe`)).toBe(String.raw`C:\py\python.exe`)
    expect(quoteWindowsArg('a\\')).toBe('a\\')
  })

  it('空串给成对引号', () => {
    expect(quoteWindowsArg('')).toBe('""')
  })

  it('含空白或 shell 元字符的参数整体加引号', () => {
    expect(quoteWindowsArg('a b')).toBe('"a b"')
    expect(quoteWindowsArg('a&b')).toBe('"a&b"')
    expect(quoteWindowsArg(String.raw`C:\Program Files\py\python.exe`)).toBe(
      String.raw`"C:\Program Files\py\python.exe"`
    )
  })

  it('内部引号被转义', () => {
    expect(quoteWindowsArg('say "hi"')).toBe(String.raw`"say \"hi\""`)
  })

  it('被引号包裹且以反斜杠结尾时反斜杠加倍（避免吞掉收尾引号）', () => {
    expect(quoteWindowsArg('a b\\')).toBe('"a b\\\\"')
  })

  it('命令行 = 解释器 + 脚本 + 逐个转义的参数', () => {
    expect(buildPythonCommandLine({ pythonExe: 'py.exe', script: 's.py' })).toBe('py.exe s.py')
    expect(
      buildPythonCommandLine({
        pythonExe: 'C:\\Program Files\\python.exe',
        script: 'scripts\\run.py',
        args: ['--mode', 'a b', '']
      })
    ).toBe(String.raw`"C:\Program Files\python.exe" scripts\run.py --mode "a b" ""`)
  })

  it('缺解释器或脚本 → invalid-declaration', () => {
    expect(() => buildPythonCommandLine({ pythonExe: '', script: 's.py' })).toThrowError(
      PythonCoreError
    )
    expect(() => buildPythonCommandLine({ pythonExe: 'py.exe', script: '' })).toThrowError(
      PythonCoreError
    )
  })
})

describe('normalizeChannelName', () => {
  it('缺省为 python；合法名原样保留', () => {
    expect(normalizeChannelName(undefined)).toBe(DEFAULT_PYTHON_CHANNEL)
    expect(normalizeChannelName(null)).toBe(DEFAULT_PYTHON_CHANNEL)
    expect(normalizeChannelName('')).toBe(DEFAULT_PYTHON_CHANNEL)
    expect(normalizeChannelName('py1')).toBe('py1')
    expect(normalizeChannelName('obox.python_1')).toBe('obox.python_1')
  })

  it('非法名报 invalid-declaration（与 api.ipc 通道名规则一致）', () => {
    for (const bad of ['-x', '.x', 'a b', 'py:1', 42]) {
      expect(() => normalizeChannelName(bad)).toThrowError(PythonCoreError)
    }
  })
})

describe('processTreeKillCommand', () => {
  it('Windows 下用 taskkill 连子孙一起结束', () => {
    expect(processTreeKillCommand(1234)).toEqual({
      program: 'taskkill',
      args: ['/PID', '1234', '/T', '/F']
    })
  })

  it('非法进程号 → launch-failed', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      try {
        processTreeKillCommand(bad)
        throw new Error('应当抛错')
      } catch (error) {
        expect((error as PythonCoreError).code).toBe('launch-failed')
      }
    }
  })
})

describe('appendWithCap', () => {
  it('未超上限时追加且不标记截断', () => {
    expect(appendWithCap('ab', 'cd', 10)).toEqual({ text: 'abcd', truncated: false })
  })

  it('已达上限时不再追加并标记截断', () => {
    expect(appendWithCap('abcdef', 'x', 6)).toEqual({ text: 'abcdef', truncated: true })
  })

  it('超出时按剩余字节截断并标记（多字节字符不切碎）', () => {
    const result = appendWithCap('', '中文字', 7)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('中文')
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(7)
  })

  it('空块不改变状态；缺省上限大于 1MB', () => {
    expect(appendWithCap('abc', '')).toEqual({ text: 'abc', truncated: false })
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThan(1024 * 1024)
  })
})
