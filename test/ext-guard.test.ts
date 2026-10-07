/**
 * 扩展身份守卫单测（extGuard）。
 * 覆盖：id 规范化拒绝矩阵、已知集合维护、成员校验的错误码与消息前缀。
 *
 * 注意：这些断言针对**对外契约**（返回值/抛出的错误码），不涉及内部存储实现。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ExtGuardError,
  addKnownExtension,
  isKnownExtension,
  knownExtensionIds,
  normalizeExtensionId,
  refreshScannedExtensions,
  removeKnownExtension,
  requireKnownExtension,
  setKnownExtensions
} from '../src/main/extGuard'

describe('extGuard · id 规范化', () => {
  it('合法 id 原样返回（含大小写与点/下划线/连字符）', () => {
    expect(normalizeExtensionId('todo_chenzhi')).toBe('todo_chenzhi')
    expect(normalizeExtensionId('obox-updater')).toBe('obox-updater')
    expect(normalizeExtensionId('my.ext_2')).toBe('my.ext_2')
    expect(normalizeExtensionId('  padded  ')).toBe('padded')
  })

  it.each([
    ['空串', ''],
    ['纯空白', '   '],
    ['非字符串', 123],
    ['undefined', undefined],
    ['null', null],
    ['以点开头', '.hidden'],
    ['以连字符开头', '-bad'],
    ['含正斜杠', 'a/b'],
    ['含反斜杠', 'a\\b'],
    ['含双点段', 'a..b'],
    ['单个双点', '..'],
    ['含空格', 'a b'],
    ['含中文', '扩展']
  ])('非法 id（%s）→ invalid-extension-id', (_label, raw) => {
    expect(() => normalizeExtensionId(raw)).toThrowError(ExtGuardError)
    try {
      normalizeExtensionId(raw)
    } catch (err) {
      expect((err as ExtGuardError).code).toBe('invalid-extension-id')
    }
  })

  it('错误对象带 name 与 [code] 消息前缀（便于日志 grep 与展示）', () => {
    const err = (() => {
      try {
        normalizeExtensionId('a/b')
      } catch (e) {
        return e as ExtGuardError
      }
      return null
    })()
    expect(err).toBeInstanceOf(ExtGuardError)
    expect(err?.name).toBe('ExtGuardError')
    expect(err?.code).toBe('invalid-extension-id')
    expect(err?.message.startsWith('[invalid-extension-id]')).toBe(true)
  })
})

describe('extGuard · 已知扩展集合', () => {
  beforeEach(() => setKnownExtensions([]))

  it('setKnownExtensions 替换集合并忽略不合规目录名', () => {
    setKnownExtensions(['ext-a', '.staging-123', 'bad name', 'ext-b'])
    expect(knownExtensionIds().sort()).toEqual(['ext-a', 'ext-b'])
  })

  it('add / remove / isKnown 的增删语义', () => {
    addKnownExtension('ext-c')
    expect(isKnownExtension('ext-c')).toBe(true)
    removeKnownExtension('ext-c')
    expect(isKnownExtension('ext-c')).toBe(false)
  })

  it('removeKnownExtension 传入非法 id 不抛错（清理路径不应因参数失败）', () => {
    expect(() => removeKnownExtension('../evil')).not.toThrow()
  })

  it('isKnownExtension 对非法 id 返回 false 而非抛错', () => {
    expect(isKnownExtension('a/b')).toBe(false)
  })

  it('重复 add 不产生重复项', () => {
    addKnownExtension('ext-d')
    addKnownExtension('ext-d')
    expect(knownExtensionIds().filter((id) => id === 'ext-d')).toHaveLength(1)
  })

  it('refreshScannedExtensions 替换磁盘扫描结果，但**不冲掉**调试/已安装登记', () => {
    setKnownExtensions(['scanned-1'])
    addKnownExtension('debug-ext')
    refreshScannedExtensions(['scanned-2'])
    expect(isKnownExtension('scanned-2')).toBe(true)
    expect(isKnownExtension('scanned-1')).toBe(false)
    // 调试扩展与安装登记属于 extra，不应被磁盘刷新清掉
    expect(isKnownExtension('debug-ext')).toBe(true)
  })
})

describe('extGuard · 成员校验', () => {
  beforeEach(() => setKnownExtensions(['installed-ext']))

  it('已知扩展 → 返回规范化 id', () => {
    expect(requireKnownExtension(' installed-ext ')).toBe('installed-ext')
  })

  it('未知但格式合法 → unknown-extension', () => {
    try {
      requireKnownExtension('other-ext')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ExtGuardError)
      expect((err as ExtGuardError).code).toBe('unknown-extension')
    }
  })

  it('格式非法 → 优先报 invalid-extension-id（与"未知扩展"区分）', () => {
    try {
      requireKnownExtension('a/b')
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as ExtGuardError).code).toBe('invalid-extension-id')
    }
  })
})
