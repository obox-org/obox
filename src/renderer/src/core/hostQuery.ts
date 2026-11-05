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
  openApp(id: string): void | Promise<void>
  installExtension(): Promise<unknown>
  settingsSnapshot(): unknown | Promise<unknown>
  setCloseBehavior(behavior: string): void | Promise<void>
  setLocale(code: string): void | Promise<void>
  setNotificationDisabled(id: string, disabled: boolean): void | Promise<void>
  updateCheck(): unknown | Promise<unknown>
  updateDownload(): unknown | Promise<unknown>
  updateInstall(): unknown | Promise<unknown>
  aiTest(baseUrl: string, apiKey: string): unknown | Promise<unknown>
  pickDirectory(title: string): unknown | Promise<unknown>
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
    case 'extensions.install':
      return await deps.installExtension()
    case 'extensions.restartHost':
      deps.restartHost()
      return null
    case 'apps.list':
      return await deps.apps()
    case 'apps.open':
      await deps.openApp(requireString(args, 'id'))
      return null
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
    case 'settings.snapshot':
      return await deps.settingsSnapshot()
    case 'window.setCloseBehavior':
      await deps.setCloseBehavior(requireString(args, 'behavior'))
      return null
    case 'i18n.setLocale':
      await deps.setLocale(requireString(args, 'code'))
      return null
    case 'update.check':
      return await deps.updateCheck()
    case 'update.download':
      return await deps.updateDownload()
    case 'update.install':
      await deps.updateInstall()
      return null
    case 'ai.test':
      return await deps.aiTest(
        requireString(args, 'baseUrl'),
        typeof args === 'object' &&
          args !== null &&
          typeof (args as Record<string, unknown>).apiKey === 'string'
          ? String((args as Record<string, unknown>).apiKey)
          : ''
      )
    case 'dialog.openDirectory':
      return await deps.pickDirectory(
        typeof args === 'object' &&
          args !== null &&
          typeof (args as Record<string, unknown>).title === 'string'
          ? String((args as Record<string, unknown>).title)
          : '选择目录'
      )
    case 'settings.notification.set':
      await deps.setNotificationDisabled(
        requireString(args, 'id'),
        requireBoolean(args, 'disabled')
      )
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
  'extensions.install',
  'extensions.restartHost',
  'apps.list',
  'apps.open',
  'commands.list',
  'commands.menus',
  'theme.list',
  'theme.current',
  'theme.set',
  'settings.snapshot',
  'window.setCloseBehavior',
  'i18n.setLocale',
  'settings.notification.set',
  'update.check',
  'update.download',
  'update.install',
  'ai.test',
  'dialog.openDirectory',
  'settings.host.get',
  'settings.host.set',
  'keybindings.list',
  'keybindings.set',
  'keybindings.reset',
  'pages.open'
] as const
/**
 * 把查询结果清洗成**可跨文档/跨进程传输**的纯数据。
 *
 * 为什么必须做：主题/快捷键/卡片表来自 Vue 的 `reactive`，直接 `postMessage` 会抛
 * "could not be cloned"（真机踩到：设置页初始化直接失败）。JSON 往返会同时去掉 Proxy、
 * 函数与不可枚举列——扩展页面本来也只能用纯数据。
 * 循环引用等极端情况回退为 null（宁可少一个字段，也不能让整条调用失败）。
 */
export function toSerializable(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return null
  }
}
