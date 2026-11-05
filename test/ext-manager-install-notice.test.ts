import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 扩展管理器「安装成功」的提示文案门禁（2.0.4）。
 *
 * 真机反馈：宿主模式下安装宠物后顶部提示「「宠物」清单无效」——其实装好了。
 * 根因：`loadUserExtension` 在宿主模式**不**在渲染进程激活（激活交给扩展宿主），
 * `info.isActive` 恒为 false，而 `hotInstall` 把"没激活"直接映射成"清单无效"。
 *
 * 这里钉死判定顺序：isActive → isValid → activationError → 宿主模式（重启生效），
 * 且不允许再出现"用一个三元表达式把非激活一律说成清单无效"的旧写法。
 */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')
}

const view = read('src/renderer/src/extensions/ext-manager/ExtensionManagerView.vue')

describe('扩展管理器 · 安装成功提示', () => {
  it('hotInstall 的判定顺序：激活 → 真无效 → 激活失败 → 宿主模式（重启生效）', () => {
    const start = view.indexOf('async function hotInstall(')
    expect(start).toBeGreaterThan(-1)
    const body = view.slice(start, view.indexOf('/** 工具栏按钮', start))

    const order = [
      'if (info.isActive)',
      'else if (!info.isValid)',
      'else if (info.activationError)',
      "t('extManager.notices.installedHostMode'"
    ]
    let last = -1
    for (const marker of order) {
      const at = body.indexOf(marker)
      expect(at, `${marker} 必须出现在 hotInstall 里`).toBeGreaterThan(-1)
      expect(at, `${marker} 的顺序应符合判定优先级`).toBeGreaterThan(last)
      last = at
    }
  })

  it('不再把"未激活"直接说成"清单无效"（旧的三元写法必须消失）', () => {
    const start = view.indexOf('async function hotInstall(')
    const body = view.slice(start, view.indexOf('/** 工具栏按钮', start))
    expect(body).not.toContain(
      "info.activationError ? t('extManager.states.activationFailed') + ': ' + t('extManager.invalidManifest')"
    )
    // 真无效时也要带上第一条原因，而不是只给四个字
    expect(body).toContain('info.validations[0]?.message')
  })

  it('两个语言包都有 installedHostMode', () => {
    for (const locale of ['zh', 'en']) {
      const src = read(`src/renderer/src/i18n/locales/${locale}.ts`)
      expect(src).toContain('installedHostMode')
    }
  })
})
