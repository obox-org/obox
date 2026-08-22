import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { MainApi, MainEvents, WindowAction } from '../shared/types'

// 渲染进程可调用的能力桥（经 contextBridge 暴露为 window.api）
const api: MainApi = {
  windowAction: (action: WindowAction) => ipcRenderer.invoke('window:action', action),
  getWindowState: () => ipcRenderer.invoke('window:get-state'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  listUserExtensions: () => ipcRenderer.invoke('extensions:list-user'),
  uninstallUserExtension: (id) => ipcRenderer.invoke('extensions:uninstall', id),
  runUninstallHook: (id) => ipcRenderer.invoke('extensions:run-uninstall-hook', id),
  capture: (outPath) => ipcRenderer.invoke('window:capture', outPath),
  eval: (script) => ipcRenderer.invoke('window:eval', script),
  openAppWindow: (req) => ipcRenderer.invoke('app:open-window', req)
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
