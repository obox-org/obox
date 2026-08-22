/**
 * App（应用）内置扩展。
 * 入口：default 导出插件函数（宿主 apply），具名导出视图组件 AppView。
 * 作用：提供 api.app.register 供其他扩展注册插件卡片（注册逻辑在宿主 appStore）。
 */
import AppView from './AppView.vue'

export { AppView }

export default function appExtension(): () => void {
  // 注册 API 由宿主 buildApi 提供（api.app.register → appStore），此处仅挂载视图
  return () => undefined
}
