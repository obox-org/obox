/**
 * 设置内置扩展。入口：default 插件函数 + 具名导出 SettingsView。
 * 设置页左侧树（外观/语言/快捷键/扩展）与右侧配置表单见 SettingsView.vue。
 */
import SettingsView from './SettingsView.vue'

export { SettingsView }

export default function settingsExtension(): () => void {
  return () => undefined
}
