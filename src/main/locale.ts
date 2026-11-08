/**
 * 主进程的界面语言（change `unified-page-context` 任务 5.3）。
 *
 * 现状问题：主进程的托盘菜单、关窗提示、关于对话框此前各自调 `app.getLocale()`（**操作系统语言**），
 * 而应用语言是**渲染侧设置**——用户在设置里切成英文后，托盘仍是系统语言，重启也不会变。
 *
 * 本模块把"当前应用语言"变成主进程里的一个缓存：
 * - 启动时用 `app.getLocale()` 兜底（渲染侧还没推过来）；
 * - 渲染侧启动与切换语言时经 IPC `locale:apply` 推过来，之后所有主进程文案都读这里；
 * - 变化时通过回调让托盘重建菜单（`applyMainLocale` 的调用方负责接线）。
 *
 * 为什么语言源在渲染侧：设置持久化在渲染进程的 localStorage（`stateStore`），主进程读不到。
 * "渲染侧推配置"是本仓库既有模式（`proxy:apply` / `theme:push-tokens`），这里沿用。
 */
import { app, ipcMain } from 'electron'
import { pickLocale } from './windowBehaviorCore'

/** 渲染侧 → main：把当前应用语言推过来（与 `proxy:apply` 同款的"推配置"通道） */
export const LOCALE_APPLY_CHANNEL = 'locale:apply'

/** 已应用的语言（null = 渲染侧还没推过，回退系统语言） */
let applied: 'zh' | 'en' | null = null

/** 当前主进程文案该用的语言：优先渲染侧推来的值，否则系统语言（zh/en 归一） */
export function getMainLocale(): 'zh' | 'en' {
  if (applied !== null) return applied
  try {
    return pickLocale(app.getLocale())
  } catch {
    return 'zh'
  }
}

/**
 * 应用一份来自渲染侧的语言值。
 *
 * @returns 应用后的语言 + 是否真的发生变化（调用方据此决定是否重建托盘菜单）
 */
export function applyMainLocale(raw: unknown): { locale: 'zh' | 'en'; changed: boolean } {
  const previous = getMainLocale()
  const next = raw === 'zh' || raw === 'en' ? raw : previous
  applied = next
  return { locale: next, changed: next !== previous }
}

/**
 * 注册 `locale:apply` IPC。
 *
 * @param onChanged 语言真的变化时回调（主进程用它刷新托盘；首次推送也可能触发一次，重建是幂等的）
 */
export function registerLocaleIpc(onChanged: (locale: 'zh' | 'en') => void): void {
  ipcMain.handle(LOCALE_APPLY_CHANNEL, (_event, raw: unknown): 'zh' | 'en' => {
    const result = applyMainLocale(raw)
    if (result.changed) onChanged(result.locale)
    return result.locale
  })
}

/** 测试用：清掉已应用值（生产不需要调用） */
export function resetMainLocale(): void {
  applied = null
}
