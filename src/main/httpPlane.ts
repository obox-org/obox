/**
 * HTTP 指令面的主进程接线（2.0.3）。
 *
 * 职责只有三件：
 * 1. 启动服务端（随机端口 + 令牌 + 端点文件，见 `./httpServer`）；
 * 2. 把一条指令转发给**主窗口渲染进程**，并等它的 `http:reply` 回来（与 `extension:message`
 *    同一套 requestId 配对思路；超时后回一条可读错误，不静默挂着）；
 * 3. 应用退出时关掉服务端（端口不让它跟着残留）。
 *
 * 为什么不在渲染进程里起服务器：端口必须跟着**应用**走（扩展宿主可能崩溃重启，端口不能变），
 * 而且外部调用方需要一个稳定入口 —— 主进程是唯一稳定的那个。
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import { HTTP_COMMAND_TIMEOUT_MS, type HttpCommandResult } from '../shared/httpCommand'
import { startHttpCommandServer, type HttpCommandServerHandle } from './httpServer'

let handle: HttpCommandServerHandle | null = null
let seq = 0
const pending = new Map<number, (result: HttpCommandResult) => void>()
let replyListenerInstalled = false
/** 已注册的指令名（`GET /commands` 用；由渲染侧在有变动时同步过来） */
let knownCommands: string[] = []

function installReplyListener(): void {
  if (replyListenerInstalled) return
  replyListenerInstalled = true
  ipcMain.on(
    'http:reply',
    (
      _event,
      payload: { requestId?: unknown; ok?: unknown; data?: unknown; error?: unknown }
    ): void => {
      const requestId = typeof payload?.requestId === 'number' ? payload.requestId : -1
      const resolve = pending.get(requestId)
      if (!resolve) return // 超时后才到的回包：丢弃（与 extension:reply 同口径）
      pending.delete(requestId)
      resolve({
        ok: payload.ok === true,
        data: payload.data,
        error: typeof payload.error === 'string' ? payload.error : undefined
      })
    }
  )
}

/**
 * 启动 HTTP 指令面。失败只记日志（不能让控制面把主程序拖垮）。
 */
export async function startHttpCommandPlane(
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  if (handle) return
  installReplyListener()
  try {
    handle = await startHttpCommandServer({
      userDataDir: app.getPath('userData'),
      version: app.getVersion(),
      listCommands: (): string[] => knownCommands,
      dispatch: (command, payload): Promise<HttpCommandResult> =>
        new Promise<HttpCommandResult>((resolve) => {
          const win = getMainWindow()
          if (!win || win.isDestroyed()) {
            resolve({ ok: false, error: '主窗口不可用（指令面只在主窗口存在时工作）' })
            return
          }
          const requestId = ++seq
          const timer = setTimeout((): void => {
            pending.delete(requestId)
            resolve({
              ok: false,
              error: `指令 ${command} 在 ${HTTP_COMMAND_TIMEOUT_MS}ms 内没有响应（扩展可能仍在执行）`
            })
          }, HTTP_COMMAND_TIMEOUT_MS)
          pending.set(requestId, (result: HttpCommandResult): void => {
            clearTimeout(timer)
            resolve(result)
          })
          win.webContents.send('http:command', { requestId, command, payload })
        })
    })
    console.log(`[http] 指令面已启动：${handle.info.url}`)
  } catch (error) {
    handle = null
    console.warn(`[http] 指令面启动失败（将不提供外部指令）：${String(error)}`)
  }
}

/** 渲染侧同步"当前已注册的指令名"（`GET /commands` 用它） */
export function registerHttpCommandsSync(): void {
  ipcMain.on('http:sync-commands', (_event, names: unknown): void => {
    knownCommands = Array.isArray(names)
      ? names.filter((n): n is string => typeof n === 'string')
      : []
  })
}

/** 应用退出时收掉服务端（幂等） */
export function stopHttpCommandPlane(): void {
  const current = handle
  handle = null
  if (!current) return
  void current.close()
}
