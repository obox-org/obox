/**
 * App 卡片诊断态接线（change `fix-app-card-blank-page`）。
 *
 * 覆盖判据（真机：旧扩展的 file:// 卡片被 CSP 拦掉 ⇒ 纯白窗口）：
 * - 地址经 `normalizeCardUrl` 判定后再进 iframe，不可用时**不渲染 iframe**；
 * - 诊断块含应用名 / 原始地址 / 原因 / 修法四类信息；
 * - 归一化与拒绝各只告警一次，前缀 `[AppWindow]`；
 * - iframe 底色走主题 token（不再写死白色）；
 * - 文案在 zh/en 两侧都存在（缺一条就会在英文界面露出中文）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const appWindow = repoFile('src/renderer/src/AppWindow.vue')

describe('卡片地址判定接线', () => {
  it('经 normalizeCardUrl 判定，且只在可用时渲染 iframe', () => {
    expect(appWindow).toContain('normalizeCardUrl(registration.value?.url)')
    expect(appWindow).toContain('usableCardUrl(cardUrl.value)')
    expect(appWindow).toContain('v-if="showFrame"')
  })

  it('不可用时不创建 iframe，而是渲染诊断块', () => {
    expect(appWindow).toMatch(/v-else-if="cardFailure"/)
    expect(appWindow).toContain('app-window-diag')
    // 四类信息：应用名、原始地址、原因、修法
    expect(appWindow).toContain("t('appExt.loadFailed.appLabel')")
    expect(appWindow).toContain("t('appExt.loadFailed.urlLabel')")
    expect(appWindow).toContain('cardFailureText.reason')
    expect(appWindow).toContain('cardFailureText.hint')
  })

  it('原始地址可选中复制（不做按钮：app:// 下剪贴板不可靠）', () => {
    expect(appWindow).toMatch(/\.diag-url\s*{[^}]*user-select:\s*text/)
  })

  it('overlay 仍保持"不画像素"：诊断块只对卡片窗口生效', () => {
    expect(appWindow).toMatch(
      /if \(isOverlay \|\| !registration\.value \|\| usesSrcdoc\.value\) return null/
    )
  })
})

describe('告警去重与前缀', () => {
  it('归一化/拒绝各只告警一次（键含 appId 与地址）', () => {
    expect(appWindow).toContain('const warnedCardUrls = new Set<string>()')
    expect(appWindow).toMatch(/const key = `\$\{appId\}\|/)
    expect(appWindow).toContain('warnedCardUrls.has(key)')
  })

  it('前缀固定 [AppWindow]，便于从主进程终端 grep', () => {
    expect(appWindow).toContain('[AppWindow] 卡片地址已归一化')
    expect(appWindow).toContain('[AppWindow] 卡片地址不可用')
  })
})

describe('iframe 底色跟随主题', () => {
  it('.app-frame 用主题 token 而不是白色', () => {
    const styleBlock = appWindow.slice(appWindow.indexOf('<style scoped>'))
    expect(styleBlock).toMatch(/\.app-frame\s*{[^}]*background:\s*var\(--bg,\s*#1e1e1e\)/)
    expect(styleBlock).not.toContain('background: #ffffff;')
  })
})

describe('诊断文案 zh/en 齐全', () => {
  const keys = [
    'title',
    'appLabel',
    'urlLabel',
    'protocol',
    'file',
    'host',
    'invalid',
    'empty',
    'hint'
  ]
  it.each(['zh', 'en'])('%s 侧都有 loadFailed 的 9 条文案', (locale) => {
    const src = repoFile(`src/renderer/src/i18n/locales/${locale}.ts`)
    const block = src.slice(
      src.indexOf('loadFailed:'),
      src.indexOf('},', src.indexOf('loadFailed:'))
    )
    for (const key of keys) {
      expect(block, `${locale} 缺 ${key}`).toContain(`${key}:`)
    }
  })
})
