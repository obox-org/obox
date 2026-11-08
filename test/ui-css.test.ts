/**
 * 组件库样式表（`src/page-runtime/ui.css`）的契约门禁（change `component-css-library`）。
 *
 * 为什么要门禁：这套 CSS 是"随包分发的公共资产"，最容易在演进中破掉三条硬约定——
 * 写死色值（主题切换就失效）、写裸元素选择器（污染扩展页面自带样式）、用 `!important`
 * （页面无法覆盖）。这些都只能靠静态检查守住。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cssPath = fileURLToPath(new URL('../src/page-runtime/ui.css', import.meta.url))
const css = readFileSync(cssPath, 'utf8')
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取出所有选择器（`{` 之前那段），跳过 at-rule（`@media` 等）内部的嵌套 */
function selectors(source: string): string[] {
  const out: string[] = []
  for (const block of source.split('}')) {
    const at = block.lastIndexOf('{')
    if (at < 0) continue
    const selector = block.slice(0, at)
    // 只保留最后一个换行之后的内容：避免把上一层 at-rule 的尾巴带进来
    for (const part of selector.split(/[\n{]/).slice(-1)) {
      const trimmed = part.trim()
      if (!trimmed) continue
      // 跳过 at-rule 与关键帧台阶（`from` / `to` / `40%`），它们不是元素选择器
      if (trimmed.startsWith('@')) continue
      if (/^(?:from|to|\d+(?:\.\d+)?%)$/.test(trimmed)) continue
      out.push(trimmed)
    }
  }
  return out
}

describe('ui.css · 只消费主题 token', () => {
  it('不出现十六进制色值（主题切换才不会失效）', () => {
    const hex = cssNoComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hex).toEqual([])
  })

  it('颜色相关属性用 var(--…)，不用 rgb()/hsl() 字面量', () => {
    const colourDecls =
      cssNoComments.match(
        /(?:^|[\s;{])(?:color|background|border(?:-color)?|box-shadow)\s*:[^;}]+/g
      ) ?? []
    const literal = colourDecls.filter((decl) => /(?:rgb|hsl)a?\(/.test(decl))
    // 只允许遮罩层用 rgba(0,0,0,…)（主题里没有"半透明黑"这个 token）
    const offenders = literal.filter((decl) => !/rgba\(0,\s*0,\s*0/.test(decl))
    expect(offenders).toEqual([])
  })
})

describe('ui.css · 不污染页面既有样式', () => {
  it('不写裸元素选择器（button/input/table/ul…）', () => {
    const bare = /^(?:[a-z][a-z0-9]*)$/i
    const offenders = selectors(cssNoComments).filter((sel) =>
      sel
        .split(',')
        .map((part) => part.trim())
        .some((part) => bare.test(part))
    )
    expect(offenders).toEqual([])
  })

  it('所有选择器都带 obox- 前缀（或 :root / 带前缀的后代）', () => {
    const offenders = selectors(cssNoComments)
      .filter((sel) => !sel.startsWith('@'))
      .filter((sel) =>
        sel
          .split(',')
          .map((part) => part.trim())
          .some((part) => {
            if (part === ':root') return false
            // 允许 `:root[data-…]`、以及以 .obox- 开头的组合
            if (part.startsWith(':root')) return false
            return !part.includes('.obox-')
          })
      )
    expect(offenders).toEqual([])
  })

  it('不使用 !important', () => {
    expect(cssNoComments).not.toContain('!important')
  })
})

describe('ui.css · 覆盖面', () => {
  const groups: Record<string, string[]> = {
    布局: ['.obox-layout', '.obox-layout__sider', '.obox-row', '.obox-col--6', '.obox-divider'],
    排版: ['.obox-title', '.obox-text', '.obox-link', '.obox-code', '.obox-kbd', '.obox-truncate'],
    按钮: [
      '.obox-btn',
      '.obox-btn--primary',
      '.obox-btn--danger',
      '.obox-btn--ghost',
      '.obox-btn--sm'
    ],
    表单: [
      '.obox-form-item',
      '.obox-input',
      '.obox-textarea',
      '.obox-select',
      '.obox-checkbox',
      '.obox-radio',
      '.obox-switch',
      '.obox-number'
    ],
    数据展示: [
      '.obox-card',
      '.obox-list',
      '.obox-table',
      '.obox-tag',
      '.obox-badge',
      '.obox-avatar',
      '.obox-progress',
      '.obox-stat',
      '.obox-desc',
      '.obox-empty',
      '.obox-skeleton'
    ],
    反馈: [
      '.obox-alert',
      '.obox-spinner',
      '.obox-modal__panel',
      '.obox-drawer',
      '.obox-tooltip',
      '.obox-popover'
    ],
    导航: [
      '.obox-tabs',
      '.obox-breadcrumb',
      '.obox-pagination',
      '.obox-steps',
      '.obox-tree',
      '.obox-segmented',
      '.obox-menu'
    ]
  }

  it.each(Object.entries(groups))('%s 类组件都在库里', (_group, classes) => {
    for (const cls of classes) {
      expect(cssNoComments, `缺 ${cls}`).toContain(`${cls} `)
    }
  })

  it('状态用语义属性（aria-disabled / aria-invalid / data-loading）', () => {
    expect(cssNoComments).toContain("[aria-disabled='true']")
    expect(cssNoComments).toContain("[aria-invalid='true']")
    expect(cssNoComments).toContain("[data-loading='true']")
    expect(cssNoComments).not.toMatch(/\.is-(?:active|disabled|loading)/)
  })

  it('尊重 prefers-reduced-motion（动效可关）', () => {
    expect(cssNoComments).toContain('prefers-reduced-motion')
  })
})

describe('ui.css · 体积', () => {
  it('未压缩不超过 60 KB', () => {
    const size = statSync(cssPath).size
    expect(size).toBeLessThan(60 * 1024)
  })
})
