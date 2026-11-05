/**
 * `ui.hostQuery` 的**渲染侧分发**（change `system-extensions-from-install-dir` 任务 5.1 / 5.2）。
 *
 * 为什么是"一个通道 + op 表"而不是每个 API 一条 RPC：三个系统扩展（设置 / 应用 / 扩展管理）
 * 需要的是同一类东西——**宿主状态的读写**（扩展表、卡片表、命令表、主题、快捷键、宿主设置）。
 * 逐条加 RPC 会让 `ui-plane`、`host-main`、`extensionHostConsumer` 三处都变成流水账；
 * 一个集中式的 op 表更便于审计与统一错误（未知 op / 参数类型错）。
 *
 * 纯函数 + 依赖注入：不 import 任何 store，单测直接喂假 deps（下方 `test/host-query.test.ts`）。
 * 渲染侧的真实接线在 `extensionHostConsumer.ts`，把 store/host 的方法填进 {@link HostQueryDeps}。
 */

/** 分发器需要的宿主能力（渲染侧真实实现注入；单测注入假实现） */
export interface HostQueryDeps {
  listExtensions(): unknown[] | Promise<unknown[]>
  setEnabled(id: string, enabled: boolean): void
  uninstall(id: string): Promise<void>
  restartHost(): void
  apps(): unknown[] | Promise<unknown[]>
  commands(): unknown[] | Promise<unknown[]>
  menus(): unknown[] | Promise<unknown[]>
  themeList(): unknown[]
  themeCurrent(): string
  setTheme(themeId: string): void
  keybindingsList(): unknown[]
  setKeybinding(command: string, combo: string): void
  resetKeybinding(command: string): void
  hostSettingGet(key: string): unknown
  hostSettingSet(key: string, value: unknown): void
  openPage(pageId: string): void
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
}

function requireString(args: unknown, field: string): string {
  const value = asRecord(args)[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`缺少参数 ${field}（必须是非空字符串）`)
  }
  return value
}

function requireBoolean(args: unknown, field: string): boolean {
  const value = asRecord(args)[field]
  if (typeof value !== 'boolean') {
    throw new Error(`缺少参数 ${field}（必须是布尔值）`)
  }
  return value
}

/**
 * 执行一条宿主查询。未知 op 抛错（错误里带 op 名，便于扩展自查拼写）。
 *
 * 所有写操作都是**同步生效**的宿主动作（与设置页/管理器的既有行为一致）；
 * 卸载与重启这类需要 IO 的用 await。
 */
export async function runHostQuery(
  op: string,
  args: unknown,
  deps: HostQueryDeps
): Promise<unknown> {
  switch (op) {
    case 'extensions.list':
      return await deps.listExtensions()
    case 'extensions.setEnabled':
      deps.setEnabled(requireString(args, 'id'), requireBoolean(args, 'enabled'))
      return null
    case 'extensions.uninstall':
      await deps.uninstall(requireString(args, 'id'))
      return null
    case 'extensions.restartHost':
      deps.restartHost()
      return null
    case 'apps.list':
      return await deps.apps()
    case 'commands.list':
      return await deps.commands()
    case 'commands.menus':
      return await deps.menus()
    case 'theme.list':
      return deps.themeList()
    case 'theme.current':
      return deps.themeCurrent()
    case 'theme.set':
      deps.setTheme(requireString(args, 'themeId'))
      return null
    case 'settings.host.get':
      return deps.hostSettingGet(requireString(args, 'key'))
    case 'settings.host.set': {
      const key = requireString(args, 'key')
      deps.hostSettingSet(key, asRecord(args).value)
      return null
    }
    case 'keybindings.list':
      return deps.keybindingsList()
    case 'keybindings.set':
      deps.setKeybinding(requireString(args, 'command'), requireString(args, 'combo'))
      return null
    case 'keybindings.reset':
      deps.resetKeybinding(requireString(args, 'command'))
      return null
    case 'pages.open':
      deps.openPage(requireString(args, 'pageId'))
      return null
    default:
      throw new Error(
        `未知的宿主查询 op：${op}（可用：extensions.* / apps.list / commands.* / theme.* / settings.host.* / keybindings.* / pages.open）`
      )
  }
}

/** 宿主侧可用的 op 名单（文档与自检用；与上面的 switch 必须同步） */
export const HOST_QUERY_OPS = [
  'extensions.list',
  'extensions.setEnabled',
  'extensions.uninstall',
  'extensions.restartHost',
  'apps.list',
  'commands.list',
  'commands.menus',
  'theme.list',
  'theme.current',
  'theme.set',
  'settings.host.get',
  'settings.host.set',
  'keybindings.list',
  'keybindings.set',
  'keybindings.reset',
  'pages.open'
] as const
