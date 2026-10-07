/**
 * 更新元数据解析与产物挑选单测（updateFeed）。
 * 用**线上真实结构**的 latest.yml 作为主用例（v1.0.3 实测），并覆盖缺字段/异常输入的拒绝路径。
 */
import { describe, expect, it } from 'vitest'
import {
  UpdateFeedError,
  buildAssetUrl,
  normalizeVersion,
  parseUpdateFeed,
  pickArtifact
} from '../src/main/updateFeed'

/** 线上 v1.0.3 的真实结构（含无架构后缀 + x64 + arm64 三份产物） */
const REAL_YML = `version: 1.0.3
files:
  - url: obox-1.0.3-setup.exe
    sha512: XJQlG0tttncXWzZJMdjV4cy38h8wCsAMvXjLHjJfSPy6efr8CDFXJ9EXhKTnUUWJQy5Ye1f+vBEIWIWCHBw9Eg==
    size: 200988241
  - url: obox-1.0.3-x64-setup.exe
    sha512: ymScoK9JyNbhVCOpoDdWAKopZK5eTWCSdL93ppMjj3h252GszcyU8OvqVfJrsCiuQ9IJ8XGSLXZDIQXJm6dVwQ==
    size: 103015503
  - url: obox-1.0.3-arm64-setup.exe
    sha512: UkHrryt2zPpvunyip5mKz2pj7rdW4/YBHgnwzoiJuL/DCokPDr4VGUetfTefWfhupwLzAWNNuWNNH7uKfEreiw==
    size: 98810435
path: obox-1.0.3-setup.exe
sha512: XJQlG0tttncXWzZJMdjV4cy38h8wCsAMvXjLHjJfSPy6efr8CDFXJ9EXhKTnUUWJQy5Ye1f+vBEIWIWCHBw9Eg==
releaseDate: '2026-08-31T10:05:00.518Z'
`

describe('parseUpdateFeed', () => {
  it('解析真实 latest.yml：version / files（含 sha512 与 size）/ path', () => {
    const feed = parseUpdateFeed(REAL_YML)
    expect(feed.version).toBe('1.0.3')
    expect(feed.path).toBe('obox-1.0.3-setup.exe')
    expect(feed.files).toHaveLength(3)
    expect(feed.files.map((f) => f.url)).toEqual([
      'obox-1.0.3-setup.exe',
      'obox-1.0.3-x64-setup.exe',
      'obox-1.0.3-arm64-setup.exe'
    ])
    expect(feed.files[1]).toEqual({
      url: 'obox-1.0.3-x64-setup.exe',
      sha512:
        'ymScoK9JyNbhVCOpoDdWAKopZK5eTWCSdL93ppMjj3h252GszcyU8OvqVfJrsCiuQ9IJ8XGSLXZDIQXJm6dVwQ==',
      size: 103015503
    })
  })

  it('兼容 CRLF、单引号值与无 path 的元数据', () => {
    const yml = "version: '2.0.0'\r\nfiles:\r\n  - url: obox-2.0.0-setup.exe\r\n    size: 10\r\n"
    const feed = parseUpdateFeed(yml)
    expect(feed.version).toBe('2.0.0')
    expect(feed.files).toEqual([{ url: 'obox-2.0.0-setup.exe', size: 10 }])
    expect(feed.path).toBeUndefined()
  })

  it('缺 version → 报错', () => {
    expect(() => parseUpdateFeed('files:\n  - url: a.exe\n')).toThrowError(UpdateFeedError)
  })

  it('files 为空 → 报错', () => {
    expect(() => parseUpdateFeed('version: 1.0.0\nfiles: []\n')).toThrowError(UpdateFeedError)
  })

  it('空文本 → 报错', () => {
    expect(() => parseUpdateFeed('')).toThrowError(UpdateFeedError)
  })
})

describe('pickArtifact（按架构挑选）', () => {
  const feed = parseUpdateFeed(REAL_YML)

  it('x64 → 选 -x64-setup.exe', () => {
    expect(pickArtifact(feed, 'x64').url).toBe('obox-1.0.3-x64-setup.exe')
  })

  it('arm64 → 选 -arm64-setup.exe', () => {
    expect(pickArtifact(feed, 'arm64').url).toBe('obox-1.0.3-arm64-setup.exe')
  })

  it('无架构匹配 → 回退到顶层 path 指向的默认产物', () => {
    expect(pickArtifact(feed, 'ia32').url).toBe('obox-1.0.3-setup.exe')
  })

  it('无 path 且无架构匹配 → 回退到第一项', () => {
    const only = parseUpdateFeed('version: 1.0.0\nfiles:\n  - url: obox-1.0.0-setup.exe\n')
    expect(pickArtifact(only, 'x64').url).toBe('obox-1.0.0-setup.exe')
  })
})

describe('buildAssetUrl', () => {
  it('拼接基址与相对文件名（带/不带尾斜杠均可）', () => {
    expect(buildAssetUrl('https://example.com/dl/', { url: 'a.exe' })).toBe(
      'https://example.com/dl/a.exe'
    )
    expect(buildAssetUrl('https://example.com/dl', { url: './a.exe' })).toBe(
      'https://example.com/dl/a.exe'
    )
  })

  it('条目已是绝对地址时原样返回', () => {
    expect(buildAssetUrl('https://example.com/dl/', { url: 'https://cdn.example.com/a.exe' })).toBe(
      'https://cdn.example.com/a.exe'
    )
  })
})

describe('normalizeVersion', () => {
  it('去掉 v 前缀并 trim；非字符串输入安全处理', () => {
    expect(normalizeVersion('v1.0.3')).toBe('1.0.3')
    expect(normalizeVersion(' 1.0.3 ')).toBe('1.0.3')
    expect(normalizeVersion(undefined as unknown as string)).toBe('')
  })
})
