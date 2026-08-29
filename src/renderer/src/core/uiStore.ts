/**
 * 扩展 UI 状态（渲染侧）：QuickPick / InputBox / toast / withProgress。
 * Promise 驱动：api.ui.* 返回 Promise，UI 组件经 uiStore 状态渲染，选择/输入后 resolve。
 */
import { reactive } from 'vue'

export interface QuickPickOption {
  label: string
  description?: string
}

interface QuickPickState {
  items: QuickPickOption[]
  title?: string
  placeHolder?: string
  selectedIndex: number
  query: string
  resolve: (value: string | undefined) => void
}

interface InputBoxState {
  title?: string
  value: string
  placeHolder?: string
  password: boolean
  resolve: (value: string | undefined) => void
}

export interface ToastItem {
  id: number
  type: 'info' | 'warning' | 'error' | 'success'
  message: string
  duration: number
}

export interface ProgressState {
  title: string
  percent: number | null
}

export const uiState = reactive({
  quickPick: null as QuickPickState | null,
  inputBox: null as InputBoxState | null,
  toasts: [] as ToastItem[],
  progress: null as ProgressState | null
})

let toastSeq = 0

export const uiStore = {
  /** 打开快速选择面板，返回选中项 label（取消 → undefined） */
  showQuickPick(
    items: QuickPickOption[],
    opts?: { title?: string; placeHolder?: string }
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      uiState.quickPick = {
        items,
        title: opts?.title,
        placeHolder: opts?.placeHolder,
        selectedIndex: 0,
        query: '',
        resolve
      }
    })
  },

  resolveQuickPick(value: string | undefined): void {
    uiState.quickPick?.resolve(value)
    uiState.quickPick = null
  },

  /** 打开输入框，返回输入值（取消 → undefined） */
  showInputBox(opts?: { title?: string; value?: string; placeHolder?: string; password?: boolean }): Promise<string | undefined> {
    return new Promise((resolve) => {
      uiState.inputBox = {
        title: opts?.title,
        value: opts?.value ?? '',
        placeHolder: opts?.placeHolder,
        password: opts?.password ?? false,
        resolve
      }
    })
  },

  resolveInputBox(value: string | undefined): void {
    uiState.inputBox?.resolve(value)
    uiState.inputBox = null
  },

  /** 应用内 toast（非模态，自动消失） */
  showToast(message: string, type: 'info' | 'warning' | 'error' | 'success' = 'info', duration = 3000): void {
    const toast: ToastItem = { id: ++toastSeq, type, message, duration }
    uiState.toasts.push(toast)
    if (duration > 0) {
      setTimeout(() => uiStore.dismissToast(toast.id), duration)
    }
  },

  dismissToast(id: number): void {
    uiState.toasts = uiState.toasts.filter((t) => t.id !== id)
  },

  showProgress(title: string, percent: number | null): void {
    uiState.progress = { title, percent }
  },

  hideProgress(): void {
    uiState.progress = null
  }
}
