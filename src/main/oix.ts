/**
 * .oix 扩展包安装能力（electron 层薄壳）。
 * 安装逻辑（校验/限额/原子替换/串行化）在 **oixCore.ts**（不依赖 electron，可单测）；
 * 这里只负责：对话框取路径、解析安装根目录/暂存目录、把 `OixInstallError` 转成带错误码的返回值。
 *
 * - .oix 本质是 zip：根目录含 manifest.json + 入口 + 静态资源（扁平布局）
 * - 目录名 = <name>_<清洗后 author>（author 清洗后为空则退化为纯 name）
 * - 同名存在 → 覆盖安装（升级语义）：旧目录先备份，替换失败会**回滚**，不会丢旧版本
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import type { InstallOixOutcome } from '../shared/types'
import { getUserExtensionsDir } from './capabilities'
import { addKnownExtension } from './extGuard'
import { installFromPackage, OixInstallError } from './oixCore'

export { deriveDirName } from './oixCore'

/** 把核心抛出的错误统一转成返回值（error 消息可直接展示给用户） */
function toOutcome(err: unknown): InstallOixOutcome {
  if (err instanceof OixInstallError) return { ok: false, code: err.code, error: err.message }
  return {
    ok: false,
    code: 'write-failed',
    error: err instanceof Error ? err.message : String(err)
  }
}

/** 从 .oix 文件安装扩展（经核心；失败返回错误码，不抛错） */
export async function installOixFromPath(filePath: string): Promise<InstallOixOutcome> {
  const root = getUserExtensionsDir()
  try {
    const result = await installFromPackage(filePath, {
      targetRoot: root,
      // 暂存目录与安装根同一卷（userData/extensions/.tmp），rename 才是原子的
      tmpRoot: join(root, '.tmp')
    })
    // 登记进"已知扩展"集合（成员校验的真值来源之一）
    addKnownExtension(result.id)
    return { ok: true, result }
  } catch (err) {
    return toOutcome(err)
  }
}

export function registerOixIpc(): void {
  // 对话框选 .oix 并安装；取消返回 null
  ipcMain.handle('extensions:install-oix-dialog', async (e): Promise<InstallOixOutcome | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      title: '安装扩展',
      filters: [{ name: 'Obox 扩展包', extensions: ['oix'] }],
      properties: ['openFile']
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return null
    return installOixFromPath(picked.filePaths[0])
  })

  // 按路径安装（拖拽场景：渲染进程经 webUtils.getPathForFile 取得真实路径）
  ipcMain.handle(
    'extensions:install-oix-path',
    async (_e, filePath: unknown): Promise<InstallOixOutcome> => {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { ok: false, code: 'path-invalid', error: '无效的安装路径' }
      }
      return installOixFromPath(filePath)
    }
  )
}
