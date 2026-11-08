/**
 * 卡片地址判定与归一化（change `fix-app-card-blank-page`）。
 *
 * 覆盖判据（真机缺陷：旧扩展的 `file://` 卡片地址被 CSP 拦掉 ⇒ 纯白窗口）：
 * - `app://` 三 host ⇒ 原样可用；未知 host / `..` ⇒ 不可用；
 * - `file://…/extensions/<目录>/…` ⇒ 归一化为 `app://extensions/<目录>/…`（Windows 反斜杠、编码空格、中文目录）；
 * - `file://` 不在 extensions 下 ⇒ 不可用且**不猜**；
 * - `http(s)` / `data:` / 空串 / 解析失败 ⇒ 各自的原因码。
 */
import { describe, expect, it } from 'vitest'
import { normalizeCardUrl, usableCardUrl } from '../src/renderer/src/core/appPageUrl'

describe('可用地址原样通过', () => {
  it.each([
    'app://extensions/rdp.chenzhi/ui/index.html',
    'app://builtin/app/index.html',
    'app://debug/my-ext/ui/index.html'
  ])('%s', (url) => {
    const result = normalizeCardUrl(url)
    expect(result).toEqual({ kind: 'ok', url })
    expect(usableCardUrl(result)).toBe(url)
  })

  it('未知 host 拒绝（与主进程命名空间保持一致）', () => {
    const result = normalizeCardUrl('app://evil/x.html')
    expect(result).toMatchObject({ kind: 'unusable', reason: 'app-not-allowed' })
  })

  it('路径里的 . / .. 由 URL 解析器收敛，不会逃出 extensions 命名空间', () => {
    // `new URL()` 在解析阶段就消掉了 `.` / `..`（含 `%2e%2e`），所以这里的断言是"收敛结果"，
    // 而不是"模块自己拒绝"——越界拒绝由主进程 appUrlCore 负责（规范化后必须仍在扩展根之下）。
    expect(normalizeCardUrl('app://extensions/a/%2e%2e/%2e%2e/etc/passwd')).toEqual({
      kind: 'ok',
      url: 'app://extensions/a/%2e%2e/%2e%2e/etc/passwd'
    })
    expect(normalizeCardUrl('app://extensions/a/../../etc/passwd')).toEqual({
      kind: 'ok',
      url: 'app://extensions/a/../../etc/passwd'
    })
  })
})

describe('file:// 归一化', () => {
  it('Windows 用户扩展目录（正斜杠）', () => {
    const result = normalizeCardUrl(
      'file:///C:/Users/chenzhi/AppData/Roaming/obox/extensions/rdp.chenzhi/ui/index.html'
    )
    expect(result).toEqual({
      kind: 'normalized',
      url: 'app://extensions/rdp.chenzhi/ui/index.html',
      from: 'file:///C:/Users/chenzhi/AppData/Roaming/obox/extensions/rdp.chenzhi/ui/index.html'
    })
    expect(usableCardUrl(result)).toBe('app://extensions/rdp.chenzhi/ui/index.html')
  })

  it('反斜杠路径同样识别', () => {
    const result = normalizeCardUrl('file:///C:/obox/extensions/my-ext/ui/index.html?x=1#hash')
    expect(result).toMatchObject({
      kind: 'normalized',
      url: 'app://extensions/my-ext/ui/index.html'
    })
  })

  it('编码空格与中文目录名按段还原', () => {
    const result = normalizeCardUrl(
      'file:///C:/Users/%E5%BC%A0%E4%B8%89/obox/extensions/%E6%8E%A2%E9%92%88/ui/index.html'
    )
    expect(result.kind).toBe('normalized')
    expect(result.kind === 'unusable' ? '' : result.url).toBe(
      `app://extensions/${encodeURIComponent('探针')}/ui/index.html`
    )
  })

  it('不在 extensions 下的 file:// 不猜（走诊断态）', () => {
    expect(normalizeCardUrl('file:///C:/temp/whatever.html')).toMatchObject({
      kind: 'unusable',
      reason: 'file-not-extension'
    })
  })

  it('extensions 后面缺目录/文件段也拒绝', () => {
    expect(normalizeCardUrl('file:///C:/obox/extensions/onlydir')).toMatchObject({
      kind: 'unusable',
      reason: 'file-not-extension'
    })
  })

  it('file:// 里的 . / .. 同样被解析器收敛 ⇒ 落到"不在扩展目录内"', () => {
    // 解析器把它收敛成 `/C:/obox/extensions/secret.html`：`extensions` 后面只剩一段，
    // 无法判定"目录 + 文件"，因此走不可用（而不是白屏）。
    expect(normalizeCardUrl('file:///C:/obox/extensions/ext/%2e%2e/secret.html')).toMatchObject({
      kind: 'unusable',
      reason: 'file-not-extension'
    })
  })
})

describe('不可用地址', () => {
  it('空串（卡片本该走 html/srcdoc）', () => {
    expect(normalizeCardUrl('')).toMatchObject({ kind: 'unusable', reason: 'empty' })
    expect(normalizeCardUrl(null)).toMatchObject({ kind: 'unusable', reason: 'empty' })
    expect(normalizeCardUrl('   ')).toMatchObject({ kind: 'unusable', reason: 'empty' })
  })

  it('http(s) / data: 等协议', () => {
    expect(normalizeCardUrl('https://example.com/')).toMatchObject({
      kind: 'unusable',
      reason: 'unsupported-protocol',
      detail: 'https'
    })
    expect(normalizeCardUrl('data:text/html,<p>x</p>')).toMatchObject({
      kind: 'unusable',
      reason: 'unsupported-protocol',
      detail: 'data'
    })
  })

  it('解析失败', () => {
    expect(normalizeCardUrl('not a url')).toMatchObject({ kind: 'unusable', reason: 'invalid' })
  })

  it('不可用时 usableCardUrl 返回 undefined（上层据此不渲染 iframe）', () => {
    expect(usableCardUrl(normalizeCardUrl('https://example.com/'))).toBeUndefined()
  })
})
