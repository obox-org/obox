/**
 * 第三方许可汇总的纯函数测试（issue #51 / ADR-0018）。
 * 覆盖：许可文件识别（各命名习惯与 dist-info/licenses）、收集、文本生成（含 PSF 修改摘要）、指纹稳定。
 */
import { describe, expect, it } from 'vitest'
import {
  RUNTIME_MODIFICATIONS,
  buildNotices,
  collectLicenseFiles,
  isLicenseFile,
  noticesDigest,
  noticesMeta
} from '../src/main/licenseNotice'

describe('isLicenseFile', () => {
  it('识别常见命名（大小写与路径无关）', () => {
    for (const path of [
      'LICENSE.txt',
      'license',
      'COPYING',
      'NOTICE.txt',
      'tcl/tcl8.6/license.terms',
      'Lib/site-packages/matplotlib/LICENSE',
      'Lib/site-packages/numpy/LICENSE.txt'
    ]) {
      expect(isLicenseFile(path), path).toBe(true)
    }
  })

  it('识别 wheel 的 dist-info/licenses 下的任意文件', () => {
    expect(
      isLicenseFile(
        'Lib/site-packages/numpy-2.5.3.dist-info/licenses/numpy/fft/pocketfft/LICENSE.md'
      )
    ).toBe(true)
    expect(
      isLicenseFile(
        'Lib/site-packages/numpy-2.5.3.dist-info/licenses/numpy/_core/src/highway/THIRD-PARTY.txt'
      )
    ).toBe(true)
  })

  it('不误判普通源码与数据文件', () => {
    for (const path of [
      'Lib/os.py',
      'python.exe',
      'Lib/site-packages/pip/__init__.py',
      'DLLs/_ssl.pyd'
    ]) {
      expect(isLicenseFile(path), path).toBe(false)
    }
  })
})

describe('collectLicenseFiles', () => {
  it('保持传入顺序挑出许可文件', () => {
    const paths = ['python.exe', 'LICENSE.txt', 'Lib/os.py', 'tcl/tcl8.6/license.terms']
    expect(collectLicenseFiles(paths)).toEqual(['LICENSE.txt', 'tcl/tcl8.6/license.terms'])
  })
})

describe('buildNotices', () => {
  const input = {
    subject: 'demo-ext',
    pythonVersion: '3.13.16',
    arch: 'x64',
    files: [
      {
        path: 'LICENSE.txt',
        content: 'Copyright © 2001 Python Software Foundation; All Rights Reserved\n'
      },
      { path: 'Lib/site-packages/x-1.0.dist-info/licenses/LICENSE', content: 'MIT License\n' }
    ]
  }

  it('含标题、运行时信息、PSF 修改摘要与每份许可正文', () => {
    const text = buildNotices(input)
    expect(text).toContain('demo-ext 第三方许可与声明')
    expect(text).toContain('CPython 3.13.16，x64')
    expect(text).toContain('对 Python 的修改摘要（PSF License v2 第 3 条）')
    expect(text).toContain(RUNTIME_MODIFICATIONS[0])
    expect(text).toContain('--- LICENSE.txt ---')
    expect(text).toContain('Copyright © 2001 Python Software Foundation')
    expect(text).toContain('--- Lib/site-packages/x-1.0.dist-info/licenses/LICENSE ---')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('文件按路径排序输出（可复现）', () => {
    const text = buildNotices(input)
    expect(text.indexOf('--- LICENSE.txt ---')).toBeLessThan(
      text.indexOf('--- Lib/site-packages/x-1.0.dist-info/licenses/LICENSE ---')
    )
  })

  it('可覆盖修改摘要（供不同打包流程复用）', () => {
    const text = buildNotices({ ...input, modifications: ['只做了 X'] })
    expect(text).toContain('- 只做了 X')
    expect(text).not.toContain(RUNTIME_MODIFICATIONS[0])
  })
})

describe('noticesDigest / noticesMeta', () => {
  it('指纹与顺序无关，内容或路径变化即变', () => {
    const a = [
      { path: 'b', content: 'B' },
      { path: 'a', content: 'A' }
    ]
    const b = [
      { path: 'a', content: 'A' },
      { path: 'b', content: 'B' }
    ]
    expect(noticesDigest(a)).toBe(noticesDigest(b))
    expect(noticesDigest(a)).not.toBe(
      noticesDigest([
        { path: 'a', content: 'A!' },
        { path: 'b', content: 'B' }
      ])
    )
    expect(noticesDigest(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('元数据带文件数与指纹（CLI --check 用）', () => {
    const meta = noticesMeta({
      subject: 'demo-ext',
      pythonVersion: '3.13.16',
      arch: 'arm64',
      files: [{ path: 'LICENSE.txt', content: 'x' }]
    })
    expect(meta).toEqual({
      subject: 'demo-ext',
      pythonVersion: '3.13.16',
      arch: 'arm64',
      licenseFileCount: 1,
      digest: noticesDigest([{ path: 'LICENSE.txt', content: 'x' }])
    })
  })
})
