import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { spawn } from 'child_process'
import type { AppInfo, UserExtensionEntry } from '../shared/types'

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

export function registerCapabilityIpc(): void {
  ipcMain.handle('app:get-info', (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion()
  }))

  ipcMain.handle('extensions:list-user', async (): Promise<UserExtensionEntry[]> => {
    const root = getUserExtensionsDir()
    const dirs = await listDirectories(root)
    return dirs.filter((id) => !id.startsWith('.')).map((id) => ({ id, path: join(root, id) }))
  })

  ipcMain.handle('extensions:uninstall', async (_e, id: string): Promise<void> => {
    const root = getUserExtensionsDir()
    // 防路径穿越：只允许删除 userData/extensions 下的直接子目录
    const safe = /^[a-z0-9._-]+$/i.test(id)
    if (!safe) throw new Error(`invalid extension id: ${id}`)
    const target = join(root, id)
    const parent = join(target, '..')
    if (basename(target) !== id || parent !== root) throw new Error(`unsafe path: ${target}`)
    // 先跑卸载钩子（尽力而为）
    try {
      const hook = join(target, '.uninstall.cjs')
      await fs.access(hook)
      await runHook(hook)
    } catch {
      // 无钩子或执行失败：继续删除
    }
    await fs.rm(target, { recursive: true, force: true })
  })

  ipcMain.handle('extensions:run-uninstall-hook', async (_e, id: string): Promise<boolean> => {
    const root = getUserExtensionsDir()
    const safe = /^[a-z0-9._-]+$/i.test(id)
    if (!safe) return false
    const hook = join(root, id, '.uninstall.cjs')
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
