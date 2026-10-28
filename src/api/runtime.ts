/**
 * 扩展运行时类型（面向扩展作者；扩展经相对路径导入 src/api）。
 * 宿主激活扩展时构造的信息/上下文/模块契约。
 * 由 src/api/index.ts 聚合导出。
 * **纯接口层：不依赖任何宿主框架类型（vue 等）。**
 */
import type { ExtensionManifest } from './manifest'

/** 校验消息级别 */
export type ValidationSeverity = 'error' | 'warning' | 'info'

/** 校验消息 */
export interface ValidationMessage {
  severity: ValidationSeverity
  message: string
}

/** 扩展来源 */
export type ExtensionSource = 'builtin' | 'user' | 'debug'

/** 扩展运行时状态 */
export interface ExtensionInfo {
  /** 扩展 id */
  id: string
  /** manifest 原文 */
  manifest: ExtensionManifest
  /** 来源：内置（resources）/ 用户（userData） */
  source: ExtensionSource
  /** 是否通过校验（未通过则不加载，但出现在管理列表标红） */
  isValid: boolean
  /** 校验/错误消息 */
  validations: ValidationMessage[]
  /** 是否启用（不在禁用列表即启用，缺省即启用模型） */
  enabled: boolean
  /** 是否已激活 */
  isActive: boolean
  /** 激活失败的错误（若有） */
  activationError?: string
  /** 是否需重启生效（状态刚变更，尚未重启） */
  requiresRestart?: boolean
  /**
   * 待补跑的 install 钩子（安装时渲染进程不可用 → 下次启动补跑）。
   *
   * 管理器据此显示「待重启生效」徽标：这类扩展**清单合法、能正常加载**，只是安装钩子还没跑；
   * 不给徽标时，用户很容易把"待生效"误判成"包坏了"（2.0.0 上就发生过）。
   */
  pendingInstall?: { version: string; at: number; previousVersion?: string }
  /** 安装时间戳（用户扩展） */
  installedTimestamp?: number
}

/** 扩展上下文（扩展 apply(ctx) 中可用的宿主能力） */
export interface ExtensionContextLike {
  /** 扩展 id */
  extensionId: string
  /** 扩展目录的绝对路径（经 app:// 访问） */
  extensionUri: string
  /** 扩展 mode */
  extensionMode: 'production' | 'development'
  /** 统一清理：所有注册必须 push 进这里，停用时统一 dispose */
  subscriptions: Disposable[]
}

/** Disposable 统一清理形状 */
export interface Disposable {
  dispose(): void
}

/** 由扩展模块具名导出的视图组件表（宿主按 Vue 组件渲染；扩展作者无需关心框架类型） */
export type ExtensionViews = Record<string, unknown>

/** 扩展模块契约 */
export interface ExtensionModule {
  /** Cordis 插件函数（宿主以 apply(ctx) 调用） */
  default?: (ctx: unknown) => void | (() => void)
  /** 具名导出的视图组件（key = 导航项 contribution 的 view id） */
  [viewId: string]: unknown
}
