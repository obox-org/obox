/**
 * Python 打包规划的纯函数测试（issue #51 / ADR-0018）。
 * 只测规划结果（不下载、不解压、不联网）：三元组、归档名/地址、裁剪清单、限额汇总、树指纹、uv 参数。
 */
import { describe, expect, it } from 'vitest'
import {
  planRuntimeTrim,
  pythonTargetTriple,
  runtimeArchiveName,
  runtimeDownloadUrl,
  runtimeManifestFields,
  summarizeTree,
  treeDigest,
  uvWheelInstallArgs
} from '../src/main/pythonPackage'
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES } from '../src/main/oixCore'

describe('目标三元组与归档', () => {
  it('x64 / arm64 映射到 python-build-standalone 的 Windows 三元组', () => {
    expect(pythonTargetTriple('x64')).toBe('x86_64-pc-windows-msvc')
    expect(pythonTargetTriple('arm64')).toBe('aarch64-pc-windows-msvc')
  })

  it('归档名带版本、release tag、三元组，且是 install_only_stripped', () => {
    const input = { pythonVersion: '3.13.16', release: '20261003', arch: 'x64' as const }
    expect(runtimeArchiveName(input)).toBe(
      'cpython-3.13.16+20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'
    )
    expect(runtimeArchiveName({ ...input, arch: 'arm64' })).toContain('aarch64-pc-windows-msvc')
  })

  it('下载地址指向该 release 的资产', () => {
    const url = runtimeDownloadUrl({ pythonVersion: '3.13.16', release: '20261003', arch: 'arm64' })
    expect(url).toBe(
      'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/' +
        'cpython-3.13.16+20261003-aarch64-pc-windows-msvc-install_only_stripped.tar.gz'
    )
  })
})

describe('planRuntimeTrim（基线 stripped + 只删确定安全的）', () => {
  const paths = [
    'python.exe',
    'python3.dll',
    'python313.dll',
    'DLLs/_ssl.pyd',
    'DLLs/libcrypto-3-x64.dll',
    'DLLs/unicodedata.pyd',
    'include/Python.h',
    'include/internal/pycore_gc.h',
    'libs/python313.lib',
    'Lib/os.py',
    'Lib/tomllib/__init__.py',
    'Lib/ensurepip/__init__.py',
    'Lib/venv/__init__.py',
    'Lib/idlelib/idle.py',
    'Lib/turtledemo/clock.py',
    'Lib/tkinter/__init__.py',
    'Lib/site-packages/pip/__init__.py',
    'tcl/tcl8.6/init.tcl',
    'Lib/__pycache__/os.cpython-313.pyc'
  ]

  it('删 include / libs / idlelib / turtledemo（含目录本身与子项）', () => {
    const { remove } = planRuntimeTrim(paths)
    expect(remove).toEqual([
      'include/Python.h',
      'include/internal/pycore_gc.h',
      'libs/python313.lib',
      'Lib/idlelib/idle.py',
      'Lib/turtledemo/clock.py'
    ])
  })

  it('保留 tkinter/tcl、pip、venv、ensurepip、tomllib、python3.dll 与 __pycache__（不可删清单）', () => {
    const { keep } = planRuntimeTrim(paths)
    for (const must of [
      'Lib/tkinter/__init__.py',
      'tcl/tcl8.6/init.tcl',
      'Lib/site-packages/pip/__init__.py',
      'Lib/venv/__init__.py',
      'Lib/ensurepip/__init__.py',
      'Lib/tomllib/__init__.py',
      'python3.dll',
      'DLLs/unicodedata.pyd',
      'Lib/__pycache__/os.cpython-313.pyc'
    ]) {
      expect(keep).toContain(must)
    }
  })

  it('容错反斜杠与 ./ 前缀', () => {
    const { remove } = planRuntimeTrim(['.\\include\\Python.h', './libs/python313.lib'])
    expect(remove).toHaveLength(2)
  })
})

describe('summarizeTree（对照 .oix 限额）', () => {
  it('统计文件数与总字节；未超限时 over 为空', () => {
    const summary = summarizeTree([
      { path: 'a', size: 10 },
      { path: 'b', size: 20 }
    ])
    expect(summary).toEqual({ fileCount: 2, totalBytes: 30, over: [] })
    expect(DEFAULT_MAX_ENTRIES).toBe(10000)
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(512 * 1024 * 1024)
  })

  it('条目数或字节数超限时分别标记', () => {
    const entries = [
      { path: 'a', size: 100 },
      { path: 'b', size: 100 }
    ]
    expect(summarizeTree(entries, { maxEntries: 1, maxTotalBytes: 1000 }).over).toEqual(['entries'])
    expect(summarizeTree(entries, { maxEntries: 10, maxTotalBytes: 150 }).over).toEqual(['bytes'])
    expect(summarizeTree(entries, { maxEntries: 1, maxTotalBytes: 150 }).over).toEqual([
      'entries',
      'bytes'
    ])
  })

  it('边界：正好等于限额不算超', () => {
    const summary = summarizeTree([{ path: 'a', size: 100 }], { maxEntries: 1, maxTotalBytes: 100 })
    expect(summary.over).toEqual([])
  })
})

describe('treeDigest', () => {
  it('与输入顺序无关，尺寸变化会改变指纹', () => {
    const a = treeDigest([
      { path: 'b', size: 2 },
      { path: 'a', size: 1 }
    ])
    const b = treeDigest([
      { path: 'a', size: 1 },
      { path: 'b', size: 2 }
    ])
    expect(a).toBe(b)
    expect(treeDigest([{ path: 'a', size: 1 }])).not.toBe(treeDigest([{ path: 'a', size: 2 }]))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('uvWheelInstallArgs / runtimeManifestFields', () => {
  it('交叉取对应架构的 wheel，且禁止源码构建', () => {
    expect(
      uvWheelInstallArgs({
        arch: 'arm64',
        pythonVersion: '3.13',
        target: 'demo/python/Lib/site-packages',
        requirements: ['matplotlib==3.11.2']
      })
    ).toEqual([
      'pip',
      'install',
      '--target',
      'demo/python/Lib/site-packages',
      '--python-platform',
      'aarch64-pc-windows-msvc',
      '--python-version',
      '3.13',
      '--only-binary',
      ':all:',
      '--upgrade',
      'matplotlib==3.11.2'
    ])
  })

  it('manifest 声明片段：arch 与 python 成对', () => {
    expect(runtimeManifestFields({ arch: 'x64', pythonVersion: '3.13' })).toEqual({
      arch: 'x64',
      python: '3.13'
    })
  })
})
