/**
 * 关闭行为（Close Behavior）的**纯逻辑**：偏好解析、关闭决策矩阵、原生提示的文案/按钮/勾选语义。
 *
 * electron-free，便于确定性单测（ADR-0019 决策 11）；Electron 接线与 IO 在 `windowBehavior.ts`。
 *
 * 主进程没有渲染进程的 i18n（`app.getLocale()` 是唯一的语言来源），因此提示文案按 `locale`
 * 在这里给出 zh/en 两份，避免"主进程对话框只有中文"。
 */

/** 关闭行为偏好：询问 / 收进托盘 / 退出 */
export type CloseBehavior = 'ask' | 'hide' | 'quit'

/** 默认值：询问（ADR-0019 决策 5） */
export const DEFAULT_CLOSE_BEHAVIOR: CloseBehavior = 'ask'

/** 偏好文件名（放 userData 根，先例 secrets.json） */
export const APP_PREFERENCES_FILE = 'app-preferences.json'

/** 更名前的旧文件名（读取一次并迁移） */
export const LEGACY_WINDOW_BEHAVIOR_FILE = 'window-behavior.json'

/** 开机自启默认关（ADR-0019 决策 12） */
export const DEFAULT_LAUNCH_AT_LOGIN = false

/** 偏好状态（文件名已更名，接口名保留以免无谓改动） */
export interface WindowBehaviorState {
  closeBehavior: CloseBehavior
  /** 开机自启偏好；**系统真实状态**才是权威（见 autoStartCore） */
  launchAtLogin: boolean
}

/** 语言归一：zh* → zh，其余 → en */
export function pickLocale(locale: string | undefined): 'zh' | 'en' {
  return (locale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 单个取值容错：非法值回落默认（偏好文件被手改坏也不该拦住启动） */
export function parseCloseBehavior(raw: unknown): CloseBehavior {
  return raw === 'ask' || raw === 'hide' || raw === 'quit' ? raw : DEFAULT_CLOSE_BEHAVIOR
}

/** 偏好文件内容 → 状态（非对象/字段缺失都容错） */
/** 布尔容错：只接受真正的布尔（字符串 "true" 之类一律回落默认） */
export function parseBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

export function parseWindowBehavior(raw: unknown): WindowBehaviorState {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    closeBehavior: parseCloseBehavior(record.closeBehavior),
    launchAtLogin: parseBoolean(record.launchAtLogin, DEFAULT_LAUNCH_AT_LOGIN)
  }
}

/** 更名前的旧文件内容（只有 closeBehavior）→ 新状态 */
export function parseLegacyPreferences(raw: unknown): WindowBehaviorState {
  return parseWindowBehavior(raw)
}

export interface CloseActionInput {
  /** 托盘是否可用（非 Windows 或无托盘 → 不拦截关闭，保持旧行为） */
  trayAvailable: boolean
  /** 是否已经在退出流程里（托盘"退出"/系统关机）——必须绕过拦截，否则退不掉 */
  quitting: boolean
}

/**
 * 关闭/最小化按钮该做什么：
 * - 已在退出流程 → `quit`（放行，不弹框）
 * - 没有托盘 → `quit`（保持旧行为：关窗即退出）
 * - 偏好 hide/quit → 直接照做
 * - 偏好 ask → `ask`（弹原生提示）
 */
export function decideCloseAction(
  behavior: CloseBehavior,
  input: CloseActionInput
): 'ask' | 'hide' | 'quit' {
  if (input.quitting) return 'quit'
  if (!input.trayAvailable) return 'quit'
  if (behavior === 'hide' || behavior === 'quit') return behavior
  return 'ask'
}

export interface ClosePrompt {
  message: string
  detail: string
  /** 顺序与 response 索引对应：0 收进托盘 / 1 退出 / 2 取消 */
  buttons: string[]
  checkboxLabel: string
  defaultId: number
  cancelId: number
}

/** 关闭提示的原生对话框选项（默认安全项=收进托盘，取消=什么都不做） */
export function buildClosePrompt(locale: string | undefined, appName = 'obox'): ClosePrompt {
  const lang = pickLocale(locale)
  if (lang === 'zh') {
    return {
      message: `要退出 ${appName}，还是收进托盘继续在后台运行？`,
      detail: '收进托盘后主窗口会隐藏，可从托盘图标重新打开；退出会结束所有扩展与子进程。',
      buttons: ['收进托盘', '退出', '取消'],
      checkboxLabel: '记住我的选择',
      defaultId: 0,
      cancelId: 2
    }
  }
  return {
    message: `Quit ${appName}, or hide it to the tray and keep it running?`,
    detail:
      'Hiding keeps the app running in the notification area; you can reopen it from the tray icon. Quitting ends all extensions and child processes.',
    buttons: ['Hide to tray', 'Quit', 'Cancel'],
    checkboxLabel: 'Remember my choice',
    defaultId: 0,
    cancelId: 2
  }
}

export interface ClosePromptOutcome {
  /** 勾选"记住"时要写入的偏好（未勾选 → 保持 current） */
  behavior: CloseBehavior
  /** 本次要执行的动作 */
  next: 'hide' | 'quit' | 'none'
  /** 是否需要把 behavior 落盘 */
  persist: boolean
}

/** 原生对话框返回值 → 动作 + 是否记住（response 越界一律当作取消） */
export function applyClosePromptResult(
  result: { response: number; checkboxChecked: boolean },
  current: CloseBehavior
): ClosePromptOutcome {
  const next: 'hide' | 'quit' | 'none' =
    result.response === 0 ? 'hide' : result.response === 1 ? 'quit' : 'none'
  const persist = result.checkboxChecked && next !== 'none'
  return { behavior: persist ? next : current, next, persist }
}

export interface AboutPrompt {
  message: string
  detail: string
  buttons: string[]
}

/** "关于"对话框（托盘菜单）：名称 + obox 版本 + Electron/Chromium/Node 版本 */
export function buildAboutPrompt(
  locale: string | undefined,
  info: { appName: string; version: string; electron?: string; chrome?: string; node?: string }
): AboutPrompt {
  const lang = pickLocale(locale)
  const detail = [
    `Electron ${info.electron ?? '-'}`,
    `Chromium ${info.chrome ?? '-'}`,
    `Node ${info.node ?? '-'}`
  ].join('\n')
  if (lang === 'zh') {
    return { message: `${info.appName} ${info.version}`, detail, buttons: ['确定'] }
  }
  return { message: `${info.appName} ${info.version}`, detail, buttons: ['OK'] }
}
