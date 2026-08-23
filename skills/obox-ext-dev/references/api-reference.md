# API Reference

宿主在激活扩展时构造并注入 `ExtensionActivationApi`，作为插件函数的唯一参数（`api`）。类型定义在 `src/renderer/src/core/types.ts`。

## 入口契约

```ts
// src/renderer/src/extensions/<id>/index.ts
export const HomeView = /* Vue 组件 */   // 具名导出：导航项 view 字段引用
export default function myExt(api: ExtensionActivationApi): (() => void) | void {
  // ... 注册命令实现、事件、App 卡片 ...
  return () => { /* 清理：dispose 所有注册 */ }
}
```

- `default` 导出插件函数：宿主以 `plugin(api)` 调用；返回值（函数）作为清理函数被宿主收集，扩展停用时执行
- 具名导出：视图组件（`view` 字段引用）；宿主把具名导出组件登记进注册表

## 方法总览

### registerCommand(id, handler) → Disposable

绑定 manifest 已声明命令的实现。

```ts
const d = api.registerCommand('my-ext.do', async (arg) => {
  // handler 可返回 Promise；executeCommand 返回其结果
  return 'done'
})
// 命令 id 必须已在 manifest contributes.commands 声明，否则宿主 console.warn
```

### executeCommand<T>(id, ...args) → Promise<T>

跨扩展执行命令（命令 id 是跨扩展稳定契约）。

```ts
const result = await api.executeCommand('other-ext.act', payload)
// 未找到命令/无 handler → 抛错
```

### statusBar

操作 manifest 声明的状态栏项（`id` 对应 `statusBarItems[].id`）：

```ts
api.statusBar.setText('my-ext.status', '运行中')   // 更新文本（支持 $(icon)）
api.statusBar.setTooltip('my-ext.status', '提示')
api.statusBar.show('my-ext.status')                // 显示
api.statusBar.hide('my-ext.status')                // 隐藏
```

### navbar

```ts
api.navbar.setBadge('my-ext.home', 5)   // 设数字徽标（>999 显示 1K+）
api.navbar.setBadge('my-ext.home', undefined)  // 清除
```

### workspaceState / globalState（Memento）

每扩展独立命名空间的键值存储（JSON 值，底层 userData JSON）：

```ts
api.workspaceState.get<string>('key')            // 读
api.workspaceState.get('key', 'default')         // 读带默认
api.workspaceState.update('key', value)          // 写（undefined 删 key）
api.workspaceState.keys()
// globalState 同构（首版与 workspaceState 共用同一命名空间存储）
```

### on(event, listener) → Disposable / emit(event, ...args)

Cordis 事件总线（跨扩展广播；`emit` 同名事件所有 `on` 监听者收到）：

```ts
const off = api.on('my-ext:changed', (payload) => { /* ... */ })
api.emit('my-ext:changed', { some: 'data' })
// 注意：事件名建议含扩展前缀，避免与其他扩展冲突
```

### window（经 preload IPC 到主进程）

```ts
await api.window.minimize()
await api.window.toggleMaximize()
await api.window.close()
const isMax = await api.window.isMaximized()
```

### appInfo

```ts
const { name, version } = await api.appInfo.get()
```

### app.register(registration) → Disposable

把插件卡片注册进"应用"扩展（App 视图 Grid 展示，点击弹出独立子窗口）：

```ts
const d = api.app.register({
  id: 'my-ext.calculator',     // 唯一，建议含扩展前缀
  name: '计算器',               // 卡片标题 + 子窗口标题
  version: '1.0.0',
  author: 'Obox',
  description: '一个计算器',
  icon: '<svg .../>',          // SVG 字符串或图片 URL
  url: 'app://extensions/...', // 子窗口内容 URL（优先）
  // 或 html: '<!doctype html>...',   // 无 url 时用 srcdoc 渲染
  multiOpen: false,            // true=每次点击新建窗口(标题加序号)；false=重复点击聚焦
  width: 900,                  // 子窗口宽（默认 900）
  height: 640                  // 子窗口高（默认 640）
})
```

- 扩展停用时宿主自动清理其注册的全部卡片
- 子窗口标题 = `name`（多开时 `name 2`、`name 3`…）
- 子窗口内容通信：iframe 内 `parent.postMessage({source:'obox-app', action:'close'|'minimize'|'maximize'}, '*')` 控制子窗口（**不要用内联 onclick，会被 CSP 阻止**）
- **url 加载用户扩展静态页**：CSP 已放行 `app:` scheme，`url: 'app://extensions/<id>/todo.html'` 可由 iframe 同源加载（页面可执行脚本、可用 localStorage）；子窗口 iframe 无 allow-modals，禁 alert/confirm/prompt

### i18n（扩展多语言）

扩展语言包与宿主语言包独立命名空间，互不冲突：

```ts
// 运行时注册语言包（或 manifest contributes.i18n 声明）
api.i18n.registerMessages({
  zh: { hello: '你好' },
  en: { hello: 'Hello' }
})
// 按当前语言取文案（缺省返回 key）
const text = api.i18n.t('hello', { name: 'Obox' })  // 支持 {param} 插值
// 当前语言代码
const locale = api.i18n.locale // 'zh' | 'en'
// 语言切换监听（返回 Disposable），扩展据此刷新自身 UI
api.i18n.onLocaleChanged((locale) => { /* 重新渲染 */ })
```

### settings（扩展设置项）

扩展设置页显示在"设置"左侧树的"扩展"节点下（按扩展名展开）：

```ts
// 运行时注册设置页（或 manifest contributes.settings 声明）
const page = api.settings.register({
  id: 'my-ext.settings',
  title: '我的扩展设置',
  fields: [
    { key: 'my-ext.interval', label: '刷新间隔', type: 'number', default: 30 },
    { key: 'my-ext.mode', label: '模式', type: 'select', options: [{ value: 'a', label: 'A' }], default: 'a' }
  ]
})
// 读写设置值（统一设置存储，key 建议含扩展前缀；set 立即持久化并通知）
const v = api.settings.get('my-ext.interval', 30)
api.settings.set('my-ext.interval', 60)
page.dispose() // 注销设置页
```

设置字段类型：`text` / `number` / `boolean` / `select`（见 `SettingField` 类型）。

## 宿主生命周期语义

- **两阶段启动**：扫描 → 注册贡献点 → 释放 barrier → 激活（`plugin(api)`）。UI 等 barrier 后才消费注册表
- **依赖拓扑序**：`extensionDependencies` 先激活依赖；检测环跳过并标记；缺失依赖不阻塞
- **停用**：扩展停用（禁用/重启/卸载）时，宿主执行插件返回的 cleanup、dispose 全部注册（命令 handler 清空、App 卡片移除、事件监听移除）
- **热生效**：安装 .oix 后宿主立即热加载（扫描→注册贡献点→激活），无需重启；禁用/卸载未激活扩展立即热移除，已激活扩展显示"立即重启"按钮（重载渲染进程生效）
- **激活失败**：`plugin(api)` 抛错 → `activationError` 记录，扩展管理器详情页展示，不影响其他扩展
- **热重载（dev）**：Vite HMR 会重载扩展模块；注册必须可清理，否则重复注册冲突

## 类型文件位置

- `src/renderer/src/core/types.ts`：`ExtensionActivationApi`、`AppRegistration`、`ExtensionManifest`、贡献点类型、`Memento`、`Disposable`
- 扩展开发时经相对路径或 `@renderer` 别名导入类型
