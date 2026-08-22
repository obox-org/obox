/**
 * 待办扩展入口（用户扩展，经 .oix 安装到 userData/extensions/<name>_<author>/）。
 * 与 obox 宿主只有扩展 API 依赖关系：api.app.register 注册 App 卡片，
 * 点击卡片弹出独立子窗口，iframe 加载本扩展目录下的静态页面（app://extensions/<id>/todo.html）。
 *
 * 注意：用户扩展入口为纯 ESM JavaScript（宿主动态 import，无构建转换）。
 */
export default function todoExtension(api) {
  // 经 import.meta.url 推导安装目录（app://extensions/<id>/），不硬编码目录名
  const base = new URL('.', import.meta.url).href
  const card = api.app.register({
    id: 'todo.main',
    name: '待办',
    version: '1.0.0',
    author: 'chenzhi',
    description: '待办事项：我的一天 / 全部待办 / 日历 / 标签',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="m9 15 2 2 4-4"/></svg>',
    url: new URL('./todo.html', base).href,
    multiOpen: false,
    width: 1024,
    height: 700
  })

  return () => {
    card.dispose()
  }
}
