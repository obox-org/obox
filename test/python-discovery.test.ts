import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  mergeBuiltinRuntimes,
  normalizeCandidates,
  parsePyLauncherList,
  parseRuntimeMarker,
  parseWhereOutput,
  RUNTIME_MARKER_FILE,
  type BuiltinRuntime
} from '../src/main/pythonDiscovery'

/**
 * 「开发运行时」Python 发现（change 新增分区）的纯逻辑。
 *
 * 用真机上 `py -0p` 的真实输出做样例：格式一变测试就红，而不是等用户发现列表空了。
 */
describe('py 启动器解析', () => {
  it('解析真实输出：版本、默认标记、路径', () => {
    const out = [
      ' -V:3.12 *        C:\\Program Files\\Python312\\python.exe',
      ' -V:3.11          C:\\Users\\x\\AppData\\Local\\Temp\\uv\\cpython-3.11\\python.exe'
    ].join('\r\n')
    const list = parsePyLauncherList(out)
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      path: 'C:\\Program Files\\Python312\\python.exe',
      version: '3.12',
      isDefault: true
    })
    expect(list[1].isDefault).toBe(false)
  })

  it('跳过表头/空行/非 python.exe 的行；同路径去重', () => {
    const out = [
      'Installed Pythons found by C:\\WINDOWS\\py.exe Launcher for Windows',
      '',
      ' -V:3.12          C:\\a\\python.exe',
      ' -V:3.12          C:\\a\\python.exe',
      ' -V:3.13          C:\\b\\pythonw.exe'
    ].join('\n')
    expect(parsePyLauncherList(out)).toHaveLength(1)
  })
})

describe('where python 解析', () => {
  it('只因 python.exe 结尾才算候选；去掉空行', () => {
    const out = ['C:\\Program Files\\Python312\\python.exe', '', 'C:\\x\\notepad.exe'].join('\r\n')
    expect(parseWhereOutput(out)).toEqual([
      { path: 'C:\\Program Files\\Python312\\python.exe', version: '' }
    ])
  })
})

describe('内置运行时 marker', () => {
  it('marker 文件名固定为 runtime.json', () => {
    expect(RUNTIME_MARKER_FILE).toBe('runtime.json')
  })

  it('合法 marker：language=python + version', () => {
    expect(parseRuntimeMarker({ language: 'python', version: '3.12.4' })).toEqual({
      language: 'python',
      version: '3.12.4'
    })
  })

  it('非 python / 缺版本 / 非对象 ⇒ null（坏 marker 不进列表）', () => {
    expect(parseRuntimeMarker({ language: 'node', version: '20' })).toBeNull()
    expect(parseRuntimeMarker({ language: 'python' })).toBeNull()
    expect(parseRuntimeMarker('python')).toBeNull()
    expect(parseRuntimeMarker(null)).toBeNull()
  })
})

describe('候选归并', () => {
  it('默认版本排最前，其余按版本号降序（3.12 在 3.9 前）', () => {
    const list = normalizeCandidates([
      { path: 'C:\\p39\\python.exe', version: '3.9' },
      { path: 'C:\\p312\\python.exe', version: '3.12' },
      { path: 'C:\\p311\\python.exe', version: '3.11', isDefault: true }
    ])
    expect(list.map((x) => x.version)).toEqual(['3.11', '3.12', '3.9'])
  })

  it('同路径保留信息更全的那条（默认标记不丢）', () => {
    const list = normalizeCandidates([
      { path: 'C:\\p\\python.exe', version: '' },
      { path: 'C:\\p\\python.exe', version: '3.12', isDefault: true }
    ])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ version: '3.12', isDefault: true })
  })

  it('compareVersions 按数字段比较', () => {
    expect(compareVersions('3.12', '3.9')).toBeGreaterThan(0)
    expect(compareVersions('3.12.1', '3.12')).toBeGreaterThan(0)
    expect(compareVersions('3.12', '3.12')).toBe(0)
  })
})

/**
 * 两个扩展根的内置运行时合并（obox 2.3：运行时包装进系统扩展根；用户根只兼容 2.2.x 旧位置）。
 */
describe('内置运行时合并（系统根优先）', () => {
  const runtime = (
    extensionId: string,
    version: string,
    source: 'system' | 'user'
  ): BuiltinRuntime => ({
    extensionId,
    dir: `${source === 'system' ? 'C:/app' : 'C:/user'}/extensions/${extensionId}`,
    version,
    language: 'python',
    hasExecutable: true,
    source
  })

  it('同一版本两个根都有 ⇒ 只留系统根那份', () => {
    const merged = mergeBuiltinRuntimes(
      [runtime('python3.11_runtime', '3.11.9', 'system')],
      [runtime('python3.11_runtime.obox', '3.11.9', 'user')]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ extensionId: 'python3.11_runtime', source: 'system' })
  })

  it('不同版本 ⇒ 都保留，按版本降序', () => {
    const merged = mergeBuiltinRuntimes(
      [runtime('python3.11_runtime', '3.11.9', 'system')],
      [runtime('python3.12_runtime.obox', '3.12.4', 'user')]
    )
    expect(merged.map((r) => r.version)).toEqual(['3.12.4', '3.11.9'])
  })

  it('同 id 时系统那份胜出（不被后者的版本覆盖）', () => {
    const merged = mergeBuiltinRuntimes(
      [runtime('py', '3.11.9', 'system')],
      [runtime('py', '3.13.0', 'user')]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ source: 'system', version: '3.11.9' })
  })

  it('空输入 ⇒ 空数组（扫描失败不抛）', () => {
    expect(mergeBuiltinRuntimes([], [])).toEqual([])
  })
})
