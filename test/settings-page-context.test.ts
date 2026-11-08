/**
 * 设置页的上下文响应（真机缺陷回归）：
 *
 * - 主题变化只改 CSS 变量（运行时写 `:root`），**不能整页重渲染**，否则下拉框会用旧快照重建；
 * - 上下文到达时先用 `ctx` 修正快照（themeId/locale），再决定是否重渲染；
 * - 语言变化要重新拉快照（主题名、扩展设置字段标签是宿主按语言预解析的）；
 * - 两个下拉框的 change 回调先更新快照再发请求（请求回来前若有重渲染也不回跳）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../system-extensions/settings/page.js', import.meta.url)),
  'utf8'
)

describe('设置页：主题/语言下拉不回跳', () => {
  it('上下文回调区分"主题变"与"语言变"：只有语言变才重拉快照', () => {
    expect(source).toContain('const localeChanged = ctx.locale !== lastLocale')
    expect(source).toContain('if (localeChanged && snapshot) void reload()')
    // 旧实现：任何上下文变化都 render()（下拉框会被旧快照重建）
    expect(source).not.toMatch(/onChange: \(\) => \{\s*applyStaticText\(\)\s*render\(\)/)
  })

  it('上下文到达时先用 ctx 修正快照', () => {
    expect(source).toContain('snapshot.locale.current = ctx.locale')
    expect(source).toContain('snapshot.theme.current = ctx.themeId')
  })

  it('两个下拉框先写快照再发请求', () => {
    expect(source).toMatch(/snapshot\.theme\.current = id[\s\S]{0,120}theme\.set/)
    expect(source).toMatch(/snapshot\.locale\.current = code[\s\S]{0,120}i18n\.setLocale/)
  })
})
