/**
 * 扩展源目录解析的测试（`--debug-extension` 与已安装扩展的差别）。
 * 不依赖 electron：`resolveExtensionDir` 的回落基准目录由调用方注入。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  clearDebugExtensionDirs,
  debugExtensionDir,
  registerDebugExtensionDirs,
  resolveExtensionDir
} from '../src/main/extensionDirs'

const userBase = join('C:', 'userData', 'extensions')

afterEach(() => {
  clearDebugExtensionDirs()
})

describe('registerDebugExtensionDirs / debugExtensionDir', () => {
  it('登记后可查到；未登记返回 undefined', () => {
    registerDebugExtensionDirs([['demo', 'C:\\dev\\demo']])
    expect(debugExtensionDir('demo')).toBe('C:\\dev\\demo')
    expect(debugExtensionDir('other')).toBeUndefined()
  })

  it('重复登记覆盖旧值；空 id/空目录被忽略', () => {
    registerDebugExtensionDirs([['demo', 'C:\\dev\\v1']])
    registerDebugExtensionDirs([['demo', 'C:\\dev\\v2']])
    expect(debugExtensionDir('demo')).toBe('C:\\dev\\v2')
    registerDebugExtensionDirs([
      ['', 'C:\\x'],
      ['empty', '']
    ])
    expect(debugExtensionDir('')).toBeUndefined()
    expect(debugExtensionDir('empty')).toBeUndefined()
  })
})

describe('resolveExtensionDir', () => {
  it('调试扩展优先（这就是"调试扩展找不到自己 python/ 运行时"的修复点）', () => {
    registerDebugExtensionDirs([['demo', join('C:', 'dev', 'demo')]])
    expect(resolveExtensionDir('demo', userBase)).toBe(join('C:', 'dev', 'demo'))
  })

  it('未登记的扩展回落到 <userData>/extensions/<id>', () => {
    expect(resolveExtensionDir('installed', userBase)).toBe(join(userBase, 'installed'))
  })

  it('调试目录查询函数可注入（便于确定性与隔离）', () => {
    expect(resolveExtensionDir('x', userBase, () => undefined)).toBe(join(userBase, 'x'))
    expect(resolveExtensionDir('x', userBase, () => 'D:\\debug\\x')).toBe('D:\\debug\\x')
  })

  it('clearDebugExtensionDirs 清空登记（重启语义）', () => {
    registerDebugExtensionDirs([['demo', 'C:\\dev\\demo']])
    clearDebugExtensionDirs()
    expect(debugExtensionDir('demo')).toBeUndefined()
    expect(resolveExtensionDir('demo', userBase)).toBe(join(userBase, 'demo'))
  })
})
