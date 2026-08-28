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
  cleanupExtension: (extId) => ipcRenderer.invoke('extension:cleanup', extId),
  // 扩展能力：网络（主进程 fetch + 代理）
  netFetch: (req, proxy) => ipcRenderer.invoke('net:fetch', req, proxy),
  // 扩展能力：文件系统（限定扩展 data 目录）
  fsReadFile: (extId, rel) => ipcRenderer.invoke('fs:read-file', extId, rel),
  fsWriteFile: (extId, rel, content) => ipcRenderer.invoke('fs:write-file', extId, rel, content),
  fsReadDir: (extId, rel) => ipcRenderer.invoke('fs:read-dir', extId, rel),
  fsExists: (extId, rel) => ipcRenderer.invoke('fs:exists', extId, rel),
  fsRemove: (extId, rel) => ipcRenderer.invoke('fs:remove', extId, rel),
  // 扩展能力：对话框 / 外链 / 剪贴板 / 任务栏进度
  dialogOpen: (opts) => ipcRenderer.invoke('dialog:open', opts),
  dialogSave: (opts) => ipcRenderer.invoke('dialog:save', opts),
  dialogMessage: (opts) => ipcRenderer.invoke('dialog:message', opts),
  shellOpenExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  shellOpenPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  setProgressBar: (progress) => ipcRenderer.invoke('window:set-progress-bar', progress),
  env: {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node
  }
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
