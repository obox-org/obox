/**
 * 扩展主进程资源的**统一清理**（ADR-0019 决策 10）。
 *
 * 一处定义、两处使用：渲染进程热移除（IPC `extension:cleanup`）与**应用退出**（`before-quit`）。
 * 退出时遍历"已知扩展"跑同一组清理。动机有实测证据：宿主被强杀时 Python 对端会变成孤儿进程并占住
 * IPC 端点，导致下次启动出现 `not-connected`（见 skills 的 troubleshooting #28）。
 */
import { knownExtensionIds } from './extGuard'
import { closeExtensionTimers } from './timer'
import { closeExtensionDbs } from './sqlite'
import { closeExtensionWatchers } from './fs'
import { closeExtensionNotifications } from './notification'
import { closeExtensionIpc } from './ipc'
import { closeExtensionPython } from './python'

/** 退出清理的兜底超时（当前各组清理都是同步的，正常路径立即完成） */
export const QUIT_CLEANUP_TIMEOUT_MS = 3000

/**
 * 单个扩展的主进程资源清理：定时器 / SQLite 句柄 / 文件监听 / 系统通知 / IPC 通道 / Python 进程树。
 * 与渲染进程热移除路径**同一组函数**（不要另写一份）。
 */
export function cleanupExtensionResources(extId: string): void {
  closeExtensionTimers(extId)
  closeExtensionDbs(extId)
  closeExtensionWatchers(extId)
  closeExtensionNotifications(extId)
  closeExtensionIpc(extId)
  closeExtensionPython(extId)
}

export interface QuitCleanupResult {
  /** 成功清理的扩展数 */
  cleaned: number
  /** 清理抛错的扩展数（只记日志，不阻塞退出） */
  failed: number
  /** 是否触发了兜底超时 */
  timedOut: boolean
}

/**
 * 退出前清理所有"已知扩展"的主进程资源。
 *
 * 单个扩展失败不影响其它扩展；超时只作为将来引入异步清理时的兜底（系统关机/注销时不能拖住退出）。
 */
export async function cleanupAllExtensionResources(
  timeoutMs: number = QUIT_CLEANUP_TIMEOUT_MS
): Promise<QuitCleanupResult> {
  const ids = knownExtensionIds()
  let cleaned = 0
  let failed = 0
  const work = Promise.all(
    ids.map(async (id) => {
      try {
        cleanupExtensionResources(id)
        cleaned += 1
      } catch (err) {
        failed += 1
        console.warn(`[quit] 清理扩展 ${id} 的主进程资源失败:`, err)
      }
    })
  )
  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve()
    }, timeoutMs)
  })
  await Promise.race([work, timeout])
  if (timer) clearTimeout(timer)
  return { cleaned, failed, timedOut }
}
