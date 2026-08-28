import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { MainApi, MainEvents, WindowAction } from '../shared/types'

// 渲染进程可调用的能力桥（经 contextBridge 暴露为 window.api）
const api: MainApi = {
  windowAction: (action: WindowAction) => ipcRenderer.invoke('window:action', action),
  getWindowState: () => ipcRenderer.invoke('window:get-state'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  listUserExtensions: () => ipcRenderer.invoke('extensions:list-user'),
  listDebugExtensions: () => ipcRenderer.invoke('extensions:list-debug'),
  uninstallUserExtension: (id) => ipcRenderer.invoke('extensions:uninstall', id),
  runUninstallHook: (id) => ipcRenderer.invoke('extensions:run-uninstall-hook', id),
  installUserExtensionViaDialog: () => ipcRenderer.invoke('extensions:install-oix-dialog'),
  installUserExtensionFromPath: (filePath) =>
    ipcRenderer.invoke('extensions:install-oix-path', filePath),
  // 拖拽 .oix 安装：取 File 的真实磁盘路径（Electron 官方拖拽模式）
  getPathForFile: (file) => webUtils.getPathForFile(file as File),
  capture: (outPath) => ipcRenderer.invoke('window:capture', outPath),
  eval: (script) => ipcRenderer.invoke('window:eval', script),
  openAppWindow: (req) => ipcRenderer.invoke('app:open-window', req),
  getOboxVersion: () => ipcRenderer.invoke('update:get-version'),
  resolveUpdateFeed: (repo) => ipcRenderer.invoke('update:resolve-feed', repo),
  checkUpdate: (opts) => ipcRenderer.invoke('update:check', opts),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  // 扩展能力：定时器
  setTimerTimeout: (extId, id, seconds) => ipcRenderer.invoke('timer:set-timeout', extId, id, seconds),
  setTimerInterval: (extId, id, seconds) => ipcRenderer.invoke('timer:set-interval', extId, id, seconds),
  clearTimer: (extId, id) => ipcRenderer.invoke('timer:clear', extId, id),
  // 扩展能力：sqlite
  sqliteOpen: (extId, name) => ipcRenderer.invoke('sqlite:open', extId, name),
  sqliteClose: (extId, name) => ipcRenderer.invoke('sqlite:close', extId, name),
  sqliteExec: (extId, name, sql) => ipcRenderer.invoke('sqlite:exec', extId, name, sql),
  sqliteQuery: (extId, name, sql, params) => ipcRenderer.invoke('sqlite:query', extId, name, sql, params),
  sqliteInsert: (extId, name, row) => ipcRenderer.invoke('sqlite:insert', extId, name, row),
  sqliteUpdate: (extId, name, where, patch) =>
    ipcRenderer.invoke('sqlite:update', extId, name, where, patch),
  sqliteGet: (extId, name, id) => ipcRenderer.invoke('sqlite:get', extId, name, id),
  sqliteGetAll: (extId, name) => ipcRenderer.invoke('sqlite:get-all', extId, name),
  sqliteGetBy: (extId, name, where) => ipcRenderer.invoke('sqlite:get-by', extId, name, where),
  sqliteDel: (extId, name, id) => ipcRenderer.invoke('sqlite:del', extId, name, id),
  sqliteDelBy: (extId, name, where) => ipcRenderer.invoke('sqlite:del-by', extId, name, where),
  sqliteClear: (extId, name) => ipcRenderer.invoke('sqlite:clear', extId, name),
  // 扩展能力：系统提醒
  showNotification: (extId, opts) => ipcRenderer.invoke('notification:show', extId, opts),
  // 扩展停用/卸载/重载时清理主进程资源
  cleanupExtension: (extId) => ipcRenderer.invoke('extension:cleanup', extId)
}

// 主进程 → 渲染进程事件订阅
const events: { on<K extends keyof MainEvents>(channel: K, listener: MainEvents[K]): () => void } =
  {
    on: (channel, listener) => {
      const wrapped = (_e: unknown, ...args: unknown[]): void =>
        (listener as (...a: unknown[]) => void)(...args)
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    }
  }

// Custom APIs for renderer
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('events', events)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.events = events
}
