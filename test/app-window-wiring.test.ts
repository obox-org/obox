/**
 * AppWindow.vue 的接线门禁（读源文件断言关键接线，设计 §7.4 / ADR-0022）。
 *
 * 为什么读源文件而不是挂载组件：`app://` 协议由主进程注册，真实 iframe 需要 Electron 多进程
 * 环境，仓库也没有 DOM 测试先例（vitest 是 `environment: 'node'`、无 jsdom / @vue/test-utils）。
 * "是否重渲染"的判据已由 `appFrameKey` 的纯函数用例覆盖（test/app-theme.test.ts），
 * 这里只钉住"模板与处理函数确实接上了"，防接线被改回去。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 去掉块注释与行注释，避免文档里的示例字符串把断言喂成假绿 */
function source(): string {
  const path = fileURLToPath(new URL('../src/renderer/src/AppWindow.vue', import.meta.url))
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('AppWindow.vue · 主题下发接线', () => {
  it('iframe 以 frameKey 作 key（不再是 themeKey）', () => {
    const src = source()
    expect(src).toContain(':key="frameKey"')
    expect(src).not.toContain(':key="themeKey"')
    // frameKey 由纯函数算出（url 型与主题无关 / srcdoc 型随主题变化）
    expect(src).toContain('appFrameKey(')
  })

  it('iframe 绑定 ref 与 load 上的主题下发', () => {
    const src = source()
    expect(src).toContain('ref="frameRef"')
    expect(src).toContain('@load="pushThemeTokens"')
    expect(src).toContain('function pushThemeTokens(')
    expect(src).toContain('buildThemeMessage(')
  })

  it('处理 obox-theme-request 且校验 e.source 与 contentWindow', () => {
    const src = source()
    expect(src).toContain("case 'obox-theme-request'")
    expect(src).toContain('e.source !== frameRef.value?.contentWindow')
    expect(src).toContain('pushThemeTokens()')
  })

  it('只在 registration.url 存在时推送（srcdoc 型不叠加推送）', () => {
    const src = source()
    const body = /function pushThemeTokens\(\)[\s\S]*?\n}/.exec(src)?.[0] ?? ''
    expect(body).not.toBe('')
    expect(body).toContain('registration.value?.url')
    // 失败分支可观测：拿不到 contentWindow 时 warn 而不是静默
    expect(body).toContain('主题下发跳过')
  })

  it('主题变化订阅 refreshTheme，且 refreshTheme 只 applyCurrent + 推送（不写回 localStorage）', () => {
    const src = source()
    expect(src).toContain('stateStore.onSettingsChanged')
    expect(src).toContain("key === 'theme'")
    expect(src).toContain('refreshTheme()')
    const body = /function refreshTheme\(\)[\s\S]*?\n}/.exec(src)?.[0] ?? ''
    expect(body).toContain('themeStore.applyCurrent()')
    expect(body).toContain('pushThemeTokens()')
    // 子窗口绝不调 setTheme（会写 localStorage 反向污染主窗口权威快照）
    expect(src).not.toContain('themeStore.setTheme')
  })

  it('首次加载时序：token 快照在 setup 阶段同步取一次，并复用 collectThemeTokens', () => {
    const src = source()
    expect(src).toContain('const themeId = ref(themeStore.currentId)')
    expect(src).toContain('const themeTokens = ref<Record<string, string>>(readThemeTokens())')
    expect(src).toContain('collectThemeTokens(')
    expect(src).toContain('getComputedStyle')
    // srcdoc 注入读本地快照，而不是 themeStore.current.tokens（主题声明值）
    expect(src).not.toContain('themeStore.current?.tokens')
  })

  it('跨窗口主题变化的落点存在：state.ts 安装 storage 监听并调 applyExternal', () => {
    const path = fileURLToPath(new URL('../src/renderer/src/core/state.ts', import.meta.url))
    const src = readFileSync(path, 'utf8')
    expect(src).toContain("window.addEventListener('storage'")
    expect(src).toContain('stateStore.applyExternal(e.newValue)')
  })
})
