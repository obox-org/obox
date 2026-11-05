import { describe, expect, it } from 'vitest'
import {
  hostPlatformLabel,
  isPlatformCompatible,
  KNOWN_PLATFORMS,
  oixFileName,
  parsePlatforms,
  platformMismatchMessage
} from '../src/main/oixPlatform'

/**
 * `.oix` 平台规则（用户确认的规则表）。这些用例就是规则的可执行版本：
 * 改规则必须先改这里，否则安装器/发布脚本会与文档漂移。
 */
const winX64 = { os: 'win32', arch: 'x64' }
const winArm = { os: 'win32', arch: 'arm64' }
const linuxX64 = { os: 'linux', arch: 'x64' }

describe('产物文件名', () => {
  it('四类后缀：通用无后缀、win、win-x64、win-arm64', () => {
    expect(oixFileName('pet', '2.0.2', 'universal')).toBe('pet-2.0.2.oix')
    expect(oixFileName('pet', '2.0.2', 'win32')).toBe('pet-2.0.2-win.oix')
    expect(oixFileName('python3.11', '3.11.9', 'win32-x64')).toBe('python3.11-3.11.9-win-x64.oix')
    expect(oixFileName('python3.11', '3.11.9', 'win32-arm64')).toBe(
      'python3.11-3.11.9-win-arm64.oix'
    )
  })
})

describe('清单 platforms 解析', () => {
  it('缺省 / 空数组 ⇒ universal', () => {
    expect(parsePlatforms(undefined)).toEqual(['universal'])
    expect(parsePlatforms([])).toEqual(['universal'])
  })

  it('合法数组去重并小写', () => {
    expect(parsePlatforms(['WIN32-X64', 'win32-x64', 'win32'])).toEqual(['win32-x64', 'win32'])
  })

  it('非法（未知标识 / 非字符串 / 非数组）⇒ null（由调用方报错）', () => {
    expect(parsePlatforms(['win64'])).toBeNull()
    expect(parsePlatforms([1])).toBeNull()
    expect(parsePlatforms('win32-x64')).toBeNull()
  })
})

describe('兼容性判定', () => {
  it('universal 谁都能装', () => {
    for (const host of [winX64, winArm, linuxX64]) {
      expect(isPlatformCompatible(['universal'], host)).toBe(true)
    }
  })

  it('win32 只限 Windows（不限架构）', () => {
    expect(isPlatformCompatible(['win32'], winX64)).toBe(true)
    expect(isPlatformCompatible(['win32'], winArm)).toBe(true)
    expect(isPlatformCompatible(['win32'], linuxX64)).toBe(false)
  })

  it('win32-x64 只在 Windows x64 可装', () => {
    expect(isPlatformCompatible(['win32-x64'], winX64)).toBe(true)
    expect(isPlatformCompatible(['win32-x64'], winArm)).toBe(false)
    expect(isPlatformCompatible(['win32-x64'], linuxX64)).toBe(false)
  })

  it('多平台数组命中任一即可', () => {
    expect(isPlatformCompatible(['win32-arm64', 'linux-x64'], linuxX64)).toBe(true)
  })

  it('错误文案带双方平台', () => {
    const msg = platformMismatchMessage(['win32-arm64'], winX64)
    expect(msg).toContain('win32-arm64')
    expect(msg).toContain('win32-x64')
  })

  it('宿主标签与已知平台表一致（防止规则表加了一半）', () => {
    expect(hostPlatformLabel(winX64)).toBe('win32-x64')
    expect(KNOWN_PLATFORMS).toContain('win32-x64')
    expect(KNOWN_PLATFORMS).toContain('universal')
  })
})
