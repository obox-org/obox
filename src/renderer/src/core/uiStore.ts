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
  /** 点击遮罩是否关闭（默认 true；false 只能经选择/取消按钮关闭） */
  closeOnClickOutside: boolean
  resolve: (value: string | undefined) => void
}

interface InputBoxState {
  title?: string
  value: string
  placeHolder?: string
  password: boolean
  closeOnClickOutside: boolean
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

/** 表单字段（api.ui.showForm） */
export interface FormField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'date' | 'time' | 'select' | 'checkbox'
  required?: boolean
  placeholder?: string
  default?: unknown
  options?: Array<{ value: string; label: string }>
}

export interface FormState {
  title?: string
  fields: FormField[]
  values: Record<string, unknown>
  /** 点击遮罩是否关闭（默认 true；false 只能经取消/确定关闭） */
  closeOnClickOutside: boolean
  resolve: (value: Record<string, unknown> | undefined) => void
}

export const uiState = reactive({
  quickPick: null as QuickPickState | null,
  inputBox: null as InputBoxState | null,
  form: null as FormState | null,
  toasts: [] as ToastItem[],
  progress: null as ProgressState | null
})

let toastSeq = 0

export const uiStore = {
  /** 打开快速选择面板，返回选中项 label（取消 → undefined） */
  showQuickPick(
    items: QuickPickOption[],
    opts?: { title?: string; placeHolder?: string; closeOnClickOutside?: boolean }
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      uiState.quickPick = {
        items,
        title: opts?.title,
        placeHolder: opts?.placeHolder,
        selectedIndex: 0,
        query: '',
        closeOnClickOutside: opts?.closeOnClickOutside ?? true,
        resolve
      }
    })
  },

  resolveQuickPick(value: string | undefined): void {
    uiState.quickPick?.resolve(value)
    uiState.quickPick = null
  },

  /** 打开输入框，返回输入值（取消 → undefined） */
  showInputBox(opts?: {
    title?: string
    value?: string
    placeHolder?: string
    password?: boolean
    closeOnClickOutside?: boolean
  }): Promise<string | undefined> {
    return new Promise((resolve) => {
      uiState.inputBox = {
        title: opts?.title,
        value: opts?.value ?? '',
        placeHolder: opts?.placeHolder,
        password: opts?.password ?? false,
        closeOnClickOutside: opts?.closeOnClickOutside ?? true,
        resolve
      }
    })
  },

  resolveInputBox(value: string | undefined): void {
    uiState.inputBox?.resolve(value)
    uiState.inputBox = null
  },

  /** 多字段表单模态框（返回字段键值；取消 → undefined） */
  showForm(opts: {
    title?: string
    fields: FormField[]
    closeOnClickOutside?: boolean
  }): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve) => {
      const values: Record<string, unknown> = {}
      for (const f of opts.fields) {
        const d = f.default
        if (f.type === 'checkbox') values[f.key] = Array.isArray(d) ? [...d] : []
        else if (d !== undefined) values[f.key] = d
        else values[f.key] = ''
      }
      uiState.form = {
        title: opts.title,
        fields: opts.fields,
        values,
        closeOnClickOutside: opts.closeOnClickOutside ?? true,
        resolve
      }
    })
  },

  resolveForm(value: Record<string, unknown> | undefined): void {
    uiState.form?.resolve(value)
    uiState.form = null
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
