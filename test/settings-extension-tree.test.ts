/**
 * 设置页「扩展」折叠节点（需求：扩展是折叠节点，里面是每个已安装用户扩展注册的配置，没有则不显示）。
 *
 * 已定决策：
 * - 父行点击 = 进列表态；箭头独立，只切换展开（互不干扰）；
 * - 列表态 = 扩展清单（显示名 + 设置项数），点行进该扩展配置；
 * - 只列**用户扩展**（`source !== 'system'`），且必须真的注册了设置页；
 * - 默认折叠，展开状态不落盘。
 *
 * 仓库 vitest 是 node 环境、没有 DOM（先例：`test/settings-view-wiring.test.ts` 读源码断言），
 * 因此这里用源码门禁钉住上述结构；真实窗口行为由 CDP 手测（见 PR 说明）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const page = readFileSync(
  fileURLToPath(new URL('../system-extensions/settings/page.js', import.meta.url)),
  'utf8'
)
const deps = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/core/hostQueryDeps.ts', import.meta.url)),
  'utf8'
)

describe('「扩展」折叠节点 · 结构', () => {
  it('默认折叠（不落盘，只在会话内记忆）', () => {
    expect(page).toContain('let extTreeOpen = false')
    expect(page).not.toContain("localStorage.setItem('extTree")
  })

  it('箭头独立于父行：click 里 stopPropagation，且只切展开状态', () => {
    expect(page).toMatch(
      /arrow\.addEventListener\('click',\s*\(event\)\s*=>\s*\{[\s\S]{0,120}stopPropagation/
    )
    expect(page).toMatch(/extTreeOpen = !extTreeOpen/)
  })

  it('父行点击回列表态（清掉子项选中）', () => {
    expect(page).toMatch(/active = id[\s\S]{0,160}if \(isExtension\) activeExt = null/)
  })

  it('子项点击选中该扩展并高亮', () => {
    expect(page).toMatch(/activeExt = group\.extensionId/)
    expect(page).toMatch(/activeExt === group\.extensionId\) child\.classList\.add\('active'\)/)
  })
})

describe('「扩展」折叠节点 · 过滤', () => {
  it('只列用户扩展：system 一律不显示', () => {
    expect(page).toContain("filter((ext) => ext.source !== 'system')")
  })

  it('没有设置页的扩展不出现（子项由 extensionPages 驱动）', () => {
    expect(page).toMatch(/for \(const page of snapshot\?\.extensionPages \?\? \[\]\)/)
    // 没有对应扩展条目（已卸载）也跳过
    expect(page).toMatch(/if \(!info\) continue/)
  })
})

describe('「扩展」折叠节点 · 列表态与选中态', () => {
  it('列表态显示"名 + 设置项数"，并提供返回入口', () => {
    expect(page).toContain("t('settings.extension.count'")
    expect(page).toContain("t('settings.extension.back'")
    expect(page).toContain('openExtensionsList')
  })

  it('选中态渲染该扩展的全部设置页', () => {
    expect(page).toMatch(/for \(const page of selected\.pages\)/)
  })
})

describe('宿主快照提供子项显示名', () => {
  it('extensions 条目带 displayName，且 %key% 已按本扩展词条解析', () => {
    expect(deps).toMatch(
      /displayName:\s*resolveExtensionLabel\(e\.manifest\?\.displayName, e\.id\) \|\|\s*resolveExtensionLabel\(e\.manifest\?\.name, e\.id\) \|\|\s*e\.id/
    )
  })
})
