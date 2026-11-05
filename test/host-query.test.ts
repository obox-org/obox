import { describe, expect, it } from 'vitest'
import { runHostQuery, type HostQueryDeps } from '../src/renderer/src/core/hostQuery'

/**
 * `ui.hostQuery` 的渲染侧分发（change `system-extensions-from-install-dir` 任务 5.1 / 5.2）。
 *
 * 为什么做成"一个通道 + op 分发"而不是每个 API 一条 RPC：系统扩展需要的是一批**只读/简单写**
 * 的宿主状态（主题、快捷键、扩展表、卡片表、命令表、宿主设置），逐条加 RPC 会把 `ui-plane`、
 * `host-main`、`extensionHostConsumer` 三处都改成流水账；一个可控的 op 表更好审计，
 * 也更容易对"未知 op / 参数类型错"给出统一错误。
 */
function deps(overrides: Partial<HostQueryDeps> = {}): HostQueryDeps {
  return {
    listExtensions: () => [
      { id: 'pet.chenzhi', source: 'user', version: '2.0.2' },
      { id: 'settings', source: 'system', version: '1.0.0' }
    ],
    setEnabled: () => undefined,
    uninstall: async () => undefined,
    restartHost: () => undefined,
    apps: () => [{ id: 'rdp', title: '远程桌面' }],
    openApp: () => undefined,
    installExtension: async () => ({ ok: true }),
    settingsSnapshot: async () => ({ app: { version: '2.0.5' } }),
    setCloseBehavior: () => undefined,
    setLocale: () => undefined,
    commands: () => [{ id: 'app.showCommands', label: '命令面板' }],
    menus: () => [{ id: 'card.rdp', items: [] }],
    themeList: () => [{ id: 'theme-dark', label: '深色' }],
    themeCurrent: () => 'theme-dark',
    setTheme: () => undefined,
    keybindingsList: () => [{ command: 'app.showCommands', combo: 'Ctrl+Shift+P' }],
    setKeybinding: () => undefined,
    resetKeybinding: () => undefined,
    hostSettingGet: () => 'dark',
    hostSettingSet: () => undefined,
    openPage: () => undefined,
    ...overrides
  }
}

describe('ui.hostQuery 分发', () => {
  it('extensions.list 返回扩展表（含来源）', async () => {
    const result = (await runHostQuery('extensions.list', {}, deps())) as Array<{
      id: string
      source: string
    }>
    expect(result.map((e) => `${e.id}:${e.source}`)).toEqual([
      'pet.chenzhi:user',
      'settings:system'
    ])
  })

  it('extensions.setEnabled 把参数透传给宿主', async () => {
    const calls: Array<[string, boolean]> = []
    await runHostQuery(
      'extensions.setEnabled',
      { id: 'pet.chenzhi', enabled: false },
      deps({ setEnabled: (id, enabled) => calls.push([id, enabled]) })
    )
    expect(calls).toEqual([['pet.chenzhi', false]])
  })

  it('extensions.setEnabled 拒绝缺失/非法参数', async () => {
    await expect(runHostQuery('extensions.setEnabled', {}, deps())).rejects.toThrow(/id/)
    await expect(
      runHostQuery('extensions.setEnabled', { id: 'x', enabled: 'no' }, deps())
    ).rejects.toThrow(/enabled/)
  })

  it('theme.set / theme.list / theme.current', async () => {
    const applied: string[] = []
    const d = deps({ setTheme: (id) => applied.push(id) })
    expect(await runHostQuery('theme.current', {}, d)).toBe('theme-dark')
    expect(await runHostQuery('theme.list', {}, d)).toEqual([{ id: 'theme-dark', label: '深色' }])
    await runHostQuery('theme.set', { themeId: 'theme-light' }, d)
    expect(applied).toEqual(['theme-light'])
  })

  it('apps.list / commands.list / commands.menus', async () => {
    expect(await runHostQuery('apps.list', {}, deps())).toEqual([{ id: 'rdp', title: '远程桌面' }])
    expect(await runHostQuery('commands.list', {}, deps())).toEqual([
      { id: 'app.showCommands', label: '命令面板' }
    ])
    expect(await runHostQuery('commands.menus', {}, deps())).toEqual([
      { id: 'card.rdp', items: [] }
    ])
  })

  it('settings.host.get / set', async () => {
    const writes: Array<[string, unknown]> = []
    const d = deps({ hostSettingSet: (key, value) => writes.push([key, value]) })
    expect(await runHostQuery('settings.host.get', { key: 'theme' }, d)).toBe('dark')
    await runHostQuery('settings.host.set', { key: 'theme', value: 'light' }, d)
    expect(writes).toEqual([['theme', 'light']])
  })

  it('keybindings.list / set / reset', async () => {
    const ops: string[] = []
    const d = deps({
      setKeybinding: (command, combo) => ops.push(`set:${command}:${combo}`),
      resetKeybinding: (command) => ops.push(`reset:${command}`)
    })
    expect(await runHostQuery('keybindings.list', {}, d)).toHaveLength(1)
    await runHostQuery('keybindings.set', { command: 'app.showCommands', combo: 'Ctrl+K' }, d)
    await runHostQuery('keybindings.reset', { command: 'app.showCommands' }, d)
    expect(ops).toEqual(['set:app.showCommands:Ctrl+K', 'reset:app.showCommands'])
  })

  it('pages.open 与 extensions.restartHost', async () => {
    const opened: string[] = []
    let restarted = 0
    const d = deps({
      openPage: (id) => opened.push(id),
      restartHost: () => {
        restarted += 1
      }
    })
    await runHostQuery('pages.open', { pageId: 'settings' }, d)
    await runHostQuery('extensions.restartHost', {}, d)
    expect(opened).toEqual(['settings'])
    expect(restarted).toBe(1)
  })

  it('未知 op 给出可读错误（含 op 名）', async () => {
    await expect(runHostQuery('nope.nope', {}, deps())).rejects.toThrow(/nope\.nope/)
  })
})
describe('apps.open', () => {
  it('把卡片 id 透传给宿主（打开子窗口）', async () => {
    const opened: string[] = []
    await runHostQuery('apps.open', { id: 'rdp' }, deps({ openApp: (id) => opened.push(id) }))
    expect(opened).toEqual(['rdp'])
  })

  it('缺 id → 可读错误', async () => {
    await expect(runHostQuery('apps.open', {}, deps())).rejects.toThrow(/id/)
  })
})
describe('extensions.install', () => {
  it('返回安装结果（由文件选择器决定）', async () => {
    const result = await runHostQuery(
      'extensions.install',
      {},
      deps({ installExtension: async () => ({ ok: true, id: 'pet.chenzhi' }) })
    )
    expect(result).toEqual({ ok: true, id: 'pet.chenzhi' })
  })
})
describe('settings.snapshot / 关闭行为 / 语言', () => {
  it('snapshot 原样返回（页面一次拿全量）', async () => {
    expect(await runHostQuery('settings.snapshot', {}, deps())).toEqual({
      app: { version: '2.0.5' }
    })
  })

  it('设置关闭行为与语言走专用 op', async () => {
    const calls: string[] = []
    const d = deps({
      setCloseBehavior: (b) => calls.push('close:' + b),
      setLocale: (c) => calls.push('locale:' + c)
    })
    await runHostQuery('window.setCloseBehavior', { behavior: 'hide' }, d)
    await runHostQuery('i18n.setLocale', { code: 'en' }, d)
    expect(calls).toEqual(['close:hide', 'locale:en'])
  })
})
