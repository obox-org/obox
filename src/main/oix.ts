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
import { getSystemExtensionsDir } from './paths'
import { addKnownExtension } from './extGuard'
import { notifyExtensionInstalled } from './installNotify'
import { registerHookIpc, runExtensionHook } from './hookRunner'
import {
  installFromPackage,
  OixInstallError,
  readExtensionMeta,
  recordInstallHookResult
} from './oixCore'
import { decideInstallHook } from '../shared/hookState'

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

/**
 * 安装完成后**立刻**请渲染进程执行 install 钩子（issue #52）。
 *
 * 只在这两种情况下记录"该版本已跑过"：请求**送达**渲染进程，且**不是 deferred**
 * （deferred = 扩展还没加载到宿主）。其余情况（窗口不可用、超时、扩展未加载）
 * 一律保留 `.obox-meta.json` 里的 `pendingInstall`，下次启动扫描期补跑——
 * 绝不能把"没跑"记成"跑过了"，否则钩子会被永久跳过。
 *
 * 失败不阻塞安装结果：钩子失败由渲染进程记入既有 `activationError` 通道。
 */
async function triggerInstallHook(input: {
  /** 实际落盘的扩展目录（运行时包装在系统扩展根，不能按用户根硬拼） */
  dir: string
  id: string
  version: string
  replaced: boolean
  previousVersion?: string
}): Promise<void> {
  const dir = input.dir
  try {
    // "同一版本只跑一次"的判定（与渲染进程共用 src/shared/hookState.ts 的同一套规则）：
    // 同版本重装时该版本已跑过 → 跳过；但要把 pendingInstall 清掉，否则下次启动扫描期又会补跑一次
    const meta = await readExtensionMeta(dir)
    const decision = decideInstallHook({
      state: meta,
      version: input.version,
      upgraded: input.replaced,
      atInstallTime: true
    })
    if (!decision.run) {
      const previous = meta.install
      if (previous) await recordInstallHookResult(dir, previous.version, previous.ok, previous.at)
      return
    }
    const outcome = await runExtensionHook({
      extId: input.id,
      phase: 'install',
      version: input.version,
      upgraded: input.replaced,
      previousVersion: input.previousVersion
    })
    if (!outcome.delivered || outcome.deferred === true) return
    await recordInstallHookResult(dir, input.version, outcome.ok)
  } catch (err) {
    // 钩子链路自身的问题不影响安装结果（pendingInstall 保留，下次启动补跑）
    console.warn('[oix] 触发 install 钩子失败：', err instanceof Error ? err.message : String(err))
  }
}

/** 从 .oix 文件安装扩展（经核心；失败返回错误码，不抛错） */
export async function installOixFromPath(filePath: string): Promise<InstallOixOutcome> {
  const root = getUserExtensionsDir()
  try {
    const result = await installFromPackage(filePath, {
      targetRoot: root,
      // 暂存目录与安装根同一卷（userData/extensions/.tmp），rename 才是原子的
      tmpRoot: join(root, '.tmp'),
      // 运行时包（包根带 runtime.json）装到**系统扩展目录**（用户裁定）：
      // 它仍是用户手动安装的包，只是落点与系统扩展一致；暂存目录由核心按目标根自算。
      runtimeTargetRoot: getSystemExtensionsDir(),
      // 同版本唯一性要跨根检查：用户根里可能有 2.2.x 装的旧副本（成功后由核心迁走）
      runtimeOtherRoots: [root]
    })
    // 登记进"已知扩展"集合（成员校验的真值来源之一）
    addKnownExtension(result.id)
    // 装完立刻在右下角提醒（点击通知 = 重启 obox 让新扩展的卡片/命令生效）
    notifyExtensionInstalled(result)
    // 安装完成后立刻跑 install 钩子（渲染进程执行；见上面 triggerInstallHook 的降级语义）
    await triggerInstallHook({
      dir: result.dir,
      id: result.id,
      version: result.version,
      replaced: result.replaced,
      previousVersion: result.previousVersion
    })
    return { ok: true, result }
  } catch (err) {
    return toOutcome(err)
  }
}

export function registerOixIpc(): void {
  // 生命周期钩子的回包通道（主进程 → 渲染进程跑钩子；与安装/卸载同一批注册）
  registerHookIpc()
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
