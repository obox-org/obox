/**
 * 扩展**安装成功**后的系统通知（Windows 右下角 toast）。
 *
 * 为什么在 main 发：安装动作发生在主进程（`installOixFromPath`），而"装完立刻提醒 + 一键重启"
 * 属于应用级提示，不该依赖某个扩展页面是否开着（用户也可能用拖拽或命令行触发安装）。
 *
 * 为什么把"重启"挂在**点击通知本身**而不是 toast 按钮：Windows 的 toast 按钮需要自定义
 * `toastXml`，而 Electron 的 `action` 事件文档只覆盖 macOS —— 真机上按了没反应比没有按钮更糟。
 * 现在的语义是"整条通知就是那个按钮"：点击 → 与扩展管理器的「重启 obox」走同一条路
 * （`app.relaunch()` + `app.exit(0)`，先 relaunch 再 exit）。
 *
 * 文案随「应用语言」变（`locale:apply` 推给 main 的那个值），与托盘/关于框同一来源。
 */
import { app, Notification } from 'electron'
import type { InstallOixResult } from '../shared/types'
import { getMainLocale } from './locale'

export interface InstalledNotice {
  title: string
  body: string
}

/** 组装通知文案（纯函数，单测直接喂 zh/en） */
export function buildInstalledNotice(
  result: Pick<
    InstallOixResult,
    'name' | 'displayName' | 'version' | 'replaced' | 'previousVersion'
  >,
  locale: 'zh' | 'en'
): InstalledNotice {
  const name = result.displayName || result.name
  // 同版本覆盖安装（修损坏/重装）也算"已安装"：说成"从 v1.0.0 升级到 v1.0.0"会让人以为版本变了
  const upgraded =
    result.replaced === true &&
    Boolean(result.previousVersion) &&
    result.previousVersion !== result.version
  if (locale === 'en') {
    const action = upgraded
      ? `${name} upgraded ${result.previousVersion} → v${result.version}.`
      : `${name} v${result.version} is installed.`
    return {
      title: upgraded ? 'Extension updated' : 'Extension installed',
      body: `${action} Click this notification to restart obox and activate it.`
    }
  }
  const action = upgraded
    ? `「${name}」已从 v${result.previousVersion} 升级到 v${result.version}。`
    : `「${name}」v${result.version} 已安装。`
  return {
    title: upgraded ? '扩展已更新' : '扩展已安装',
    body: `${action}点击本通知重启 obox 以启用它（卡片与命令重启后出现）。`
  }
}

/** 重启应用：与扩展管理器「重启 obox」同一条路（先 relaunch 再 exit） */
export function relaunchForExtensions(): void {
  setImmediate(() => {
    app.relaunch()
    app.exit(0)
  })
}

/**
 * 弹出"扩展已安装"通知。返回是否真的显示（`Notification.isSupported()` 为假时静默跳过，
 * 例如无通知服务的 Linux 环境）。
 *
 * @param onRestart 点击通知时的动作（默认重启应用；单测注入假件以免真的退出）
 */
export function notifyExtensionInstalled(
  result: Pick<
    InstallOixResult,
    'name' | 'displayName' | 'version' | 'replaced' | 'previousVersion'
  >,
  options: { onRestart?: () => void } = {}
): boolean {
  if (!Notification.isSupported()) {
    console.warn('[install] 当前系统不支持通知，跳过"扩展已安装"提醒')
    return false
  }
  const notice = buildInstalledNotice(result, getMainLocale())
  const notification = new Notification({ title: notice.title, body: notice.body })
  notification.on('click', () => (options.onRestart ?? relaunchForExtensions)())
  notification.show()
  console.log(`[install] 已发送安装通知：${notice.title} — ${notice.body}`)
  return true
}
