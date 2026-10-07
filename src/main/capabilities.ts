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
import { runExtensionHook } from './hookRunner'

/** 路径约定实现在 ./paths（独立模块，避免与 hookRunner 形成循环依赖）；此处转出以兼容既有引用 */
import { getBuiltinExtensionsDir, getUserExtensionsDir } from './paths'

export { getBuiltinExtensionsDir, getUserExtensionsDir }

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * 用户扩展目录清单。
 *
 * 过滤两类目录：
 * 1. `.` 开头的内部目录（如安装暂存目录 `.tmp`）；
 * 2. **没有 `manifest.json` 的目录**——扩展运行时会用 `extensions/<id>/data` 存数据，调试扩展
 *    （`--debug-extension`）的 id 也会在这里出现；不过滤的话渲染进程会把数据目录当扩展去读清单，
 *    打出 `manifest 读取失败或缺失` 的噪音（GUI 级端到端验证时看到的）。这类目录记一条日志，
 *    真正损坏的安装仍能被发现。
 */
async function listUserExtensionIds(): Promise<string[]> {
  const root = getUserExtensionsDir()
  const ids = (await listDirectories(root)).filter((id) => !id.startsWith('.'))
  const valid: string[] = []
  for (const id of ids) {
    try {
      await fs.access(join(root, id, 'manifest.json'))
      valid.push(id)
    } catch {
      console.warn(`[capabilities] 跳过没有 manifest.json 的目录: ${id}（扩展数据目录或调试扩展）`)
    }
  }
  return valid
}

/** 刷新"已知扩展"的磁盘扫描部分（启动与每次列目录时调用；不影响调试扩展与安装登记） */
function refreshKnownExtensions(ids: string[]): void {
  refreshScannedExtensions(ids)
}

/** 读扩展清单里的版本（供卸载钩子的请求上下文用；读不到给占位值，不阻塞卸载） */
async function readManifestVersion(dir: string): Promise<string> {
  try {
    const raw = await fs.readFile(join(dir, 'manifest.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
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
    // 先跑卸载钩子（尽力而为）：**入口导出的 uninstall 优先**，旧固定文件 `.uninstall.cjs` 回退。
    // 钩子在渲染进程执行（扩展入口只在那里被 import）；窗口不可用或入口未加载 → 回退旧文件。
    // 无论钩子成败都继续删除：否则一个写错的钩子会让扩展永远删不掉（issue #52 的既定语义）。
    const version = await readManifestVersion(target)
    const outcome = await runExtensionHook({
      extId: safeId,
      phase: 'uninstall',
      version,
      upgraded: false
    })
    const handledByEntry =
      outcome.delivered && outcome.deferred !== true && outcome.skipped !== true
    if (!handledByEntry) {
      try {
        const hook = join(target, '.uninstall.cjs')
        await fs.access(hook)
        await runHook(hook)
      } catch {
        // 无旧钩子或执行失败：继续删除
      }
    }
    if (outcome.delivered && outcome.ok === false && outcome.deferred !== true) {
      console.warn(
        `[capabilities] 扩展 ${safeId} 的 uninstall 钩子失败：${outcome.error ?? '未知错误'}`
      )
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
