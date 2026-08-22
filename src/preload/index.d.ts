import { ElectronAPI } from '@electron-toolkit/preload'
import type { MainApi, MainEvents } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: MainApi
    events: { on<K extends keyof MainEvents>(channel: K, listener: MainEvents[K]): () => void }
  }
}
