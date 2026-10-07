import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { spawn } from 'child_process'
import type { AppInfo, UserExtensionEntry } from '../shared/types'
import {
  normalizeExtensionId,
  refreshScannedExtensions,
  removeKnownExtension,
  requireKnownExtension
} from './extGuard'

/** 用户扩展目录：userData/extensions */
export function getUserExtensionsDir(): string {
  return join(app.getPath('userData'), 'extensions')
}

/** 内置扩展目录（打包后 resources/extensions；开发期返回 null，由渲染进程走 Vite） */
export function getBuiltinExtensionsDir(): string {
  return join(process.resourcesPath, 'extensions')
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** 用户扩展目录清单（过滤 `.` 开头的内部目录，如安装暂存目录 `.tmp`） */
async function listUserExtensionIds(): Promise<string[]> {
  const root = getUserExtensionsDir()
  return (await listDirectories(root)).filter((id) => !id.startsWith('.'))
}

/** 刷新"已知扩展"的磁盘扫描部分（启动与每次列目录时调用；不影响调试扩展与安装登记） */
function refreshKnownExtensions(ids: string[]): void {
  refreshScannedExtensions(ids)
}

export function registerCapabilityIpc(): void {
  ipcMain.handle('app:get-info', (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion()
  }))

  ipcMain.handle('extensions:list-user', async (): Promise<UserExtensionEntry[]> => {
    const root = getUserExtensionsDir()
    const ids = await listUserExtensionIds()
    refreshKnownExtensions(ids)
    return ids.map((id) => ({ id, path: join(root, id) }))
  })

  ipcMain.handle('extensions:uninstall', async (_e, id: string): Promise<void> => {
    const root = getUserExtensionsDir()
    // 防路径穿越：id 一律经守卫规范化（只允许 [a-z0-9._-]，拒绝分隔符与 ..），
    // 再校验目标确实是 userData/extensions 的直接子目录
    const safeId = normalizeExtensionId(id)
    const target = join(root, safeId)
    const parent = join(target, '..')
    if (basename(target) !== safeId || parent !== root) {
      throw new Error(`unsafe path: ${target}`)
    }
    // 先跑卸载钩子（尽力而为）
    try {
      const hook = join(target, '.uninstall.cjs')
      await fs.access(hook)
      await runHook(hook)
    } catch {
      // 无钩子或执行失败：继续删除
    }
    await fs.rm(target, { recursive: true, force: true })
    // 已不在磁盘上：从已知集合移除（避免陈旧 id 通过成员校验）
    removeKnownExtension(safeId)
  })

  ipcMain.handle('extensions:run-uninstall-hook', async (_e, id: string): Promise<boolean> => {
    // 成员校验用在这里：只有"main 已知的扩展"才值得执行卸载钩子（id 非法或未知一律 false）
    let safeId: string
    try {
      safeId = requireKnownExtension(id)
    } catch {
      return false
    }
    const hook = join(getUserExtensionsDir(), safeId, '.uninstall.cjs')
    try {
      await fs.access(hook)
      await runHook(hook)
      return true
    } catch {
      return false
    }
  })
}

function runHook(hookPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      stdio: 'ignore',
      detached: false
    })
    const timer = setTimeout(() => child.kill(), 5000)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`hook exited with code ${code}`))
    })
  })
}
