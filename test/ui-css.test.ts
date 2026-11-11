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

  it('所有选择器都带 obox- 前缀（或 :root / 滚动条伪元素 / 带前缀的后代）', () => {
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
            // 滚动条样式只能写在 `::-webkit-scrollbar*` 伪元素上（没有对应的 class 写法）
            if (part.startsWith('::-webkit-scrollbar')) return false
            return !part.includes('.obox-')
          })
      )
    expect(offenders).toEqual([])
  })

  it('单选卡片：选中态是绿色边框 + 右下角打勾（颜色走 token，不写死）', () => {
    // 选中态靠 :has(input:checked)（原生 radio 是真实控件，键盘/读屏可用）
    expect(cssNoComments).toMatch(/\.obox-radio-card:has\(\.obox-radio-card__input:checked\)/)
    // 绿色边框取主题 token；外框 + 1px 内描边避免选中时布局跳动
    expect(cssNoComments).toMatch(
      /\.obox-radio-card:has\([^)]*:checked\)\s*\{[^}]*border-color:\s*var\(--fg-success\)/
    )
    expect(cssNoComments).toMatch(
      /:has\([^)]*:checked\)[^{]*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--fg-success\)/
    )
    // 打勾标记：默认不显示，选中才 flex；对勾用边框旋转画（不引图标）
    expect(cssNoComments).toMatch(/\.obox-radio-card__check\s*\{[^}]*display:\s*none/)
    expect(cssNoComments).toMatch(/__check::after\s*\{[^}]*transform:\s*rotate\(-45deg\)/)
    expect(cssNoComments).toMatch(/> \.obox-radio-card__check\s*\{[^}]*display:\s*flex/)
  })

  it('滚动条是最小形态：6px 细滑块、滑轨透明、无两端箭头', () => {
    expect(cssNoComments).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*6px/)
    expect(cssNoComments).toMatch(/::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/)
    expect(cssNoComments).toMatch(/::-webkit-scrollbar-button[^{]*\{[^}]*display:\s*none/)
    // 标准属性也要写（Chromium 121+ / Firefox），颜色随 token
    expect(cssNoComments).toMatch(/scrollbar-width:\s*thin/)
    expect(cssNoComments).toMatch(/scrollbar-color:\s*var\(--border\)\s+transparent/)
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
    单选卡片: [
      '.obox-radio-group',
      '.obox-radio-card',
      '.obox-radio-card__title',
      '.obox-radio-card__path',
      '.obox-radio-card__check'
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

describe('ui.css · 卡片尺寸与内部节奏（change enlarge-card-components）', () => {
  /** 取某个选择器的规则体（用于断言具体声明）；按行首锚定，避免被 `.a > .b {` 这类后代规则抢先命中 */
  const ruleOf = (selector: string): string => {
    const at = cssNoComments.search(
      new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`)
    )
    expect(at, `找不到规则 ${selector}`).toBeGreaterThan(-1)
    return cssNoComments.slice(at, cssNoComments.indexOf('}', at))
  }

  it('卡片网格：最小卡片宽默认 300px、间距 16px（页面仍可用 --obox-card-min-w 覆盖）', () => {
    const grid = ruleOf('.obox-card-grid')
    expect(grid).toContain('minmax(var(--obox-card-min-w, 300px), 1fr)')
    expect(grid).toMatch(/gap:\s*var\(--obox-space-5\)/)
  })

  it('卡片内容区内边距 16px', () => {
    expect(ruleOf('.obox-card__body')).toMatch(/padding:\s*var\(--obox-space-5\)/)
  })

  it('页眉与页脚：上下 12px、左右 16px，且两者一致', () => {
    const pad = /padding:\s*([^;]+);/
    const header = pad.exec(ruleOf('.obox-card__header'))?.[1]?.trim()
    const footer = pad.exec(ruleOf('.obox-card__footer'))?.[1]?.trim()
    expect(header).toBe('var(--obox-space-4) var(--obox-space-5)')
    expect(footer).toBe(header)
  })

  it('卡片内相邻内容行有 12px 间距，标题自带外边距归零（避免叠加成 20px）', () => {
    // 行距用子元素的 margin-top，而不是把 __body 改成 flex 列：
    // ext-manager 把 __body 当整行容器（.ext-main 自带 display:flex），库里写 flex-direction:column
    // 会把那一行压成竖排（真机踩到，见 change 的 tasks 3.1）
    const body = ruleOf('.obox-card__body')
    expect(body).not.toMatch(/display:\s*flex/)
    expect(body).not.toMatch(/flex-direction:\s*column/)

    expect(ruleOf('.obox-card__body > .obox-title')).toMatch(/margin-bottom:\s*0/)
    expect(ruleOf('.obox-card__body > .obox-text')).toMatch(/margin-top:\s*var\(--obox-space-4\)/)
    expect(ruleOf('.obox-card__body > .obox-text:first-child')).toMatch(/margin-top:\s*0/)
  })

  it('直下文本行：左右 16px、与相邻行及页眉页脚各 12px；选择器是直接子元素', () => {
    // 直接子元素形态：`__body` 里的 `.obox-text` 不受影响
    expect(cssNoComments).toMatch(/\.obox-card > \.obox-text \{/)
    expect(cssNoComments).not.toMatch(/\.obox-card \.obox-text \{/)
    expect(ruleOf('.obox-card > .obox-text')).toMatch(/padding:\s*0 var\(--obox-space-5\)/)
    // 三条间距规则：相邻文本行、页眉之后、页脚之前
    for (const prev of [
      '.obox-card > .obox-text + .obox-text',
      '.obox-card > .obox-card__header + .obox-text'
    ]) {
      const at = cssNoComments.indexOf(prev)
      expect(at, `缺间距规则 ${prev}`).toBeGreaterThan(-1)
      expect(cssNoComments.slice(at, cssNoComments.indexOf('}', at))).toMatch(
        /margin-top:\s*var\(--obox-space-4\)/
      )
    }
    expect(cssNoComments).toMatch(
      /\.obox-card > \.obox-text \+ \.obox-card__footer \{[^}]*margin-top:\s*var\(--obox-space-4\)/
    )
  })
})

describe('ui.css · 体积', () => {
  it('未压缩不超过 60 KB', () => {
    const size = statSync(cssPath).size
    expect(size).toBeLessThan(60 * 1024)
  })
})
