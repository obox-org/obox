# API Reference

宿主在激活扩展时构造并注入 `ExtensionActivationApi`，作为插件函数的唯一参数（`api`）。类型定义在 `src/api/`（聚合出口 `src/api/index.ts`；`src/renderer/src/core/types.ts` 再导出兼容旧 import）。

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

### app.onMessage(handler) → Disposable（App 子窗口 ↔ 扩展消息桥）

子窗口 iframe 里的页面**没有 api 对象**（扩展入口运行在主窗口）。要用 `api.sqlite`/`api.notification`/`api.timer` 等宿主能力，扩展入口注册消息处理器，子应用经 postMessage 请求：

```ts
// 扩展入口（index.js，主窗口）
const off = api.app.onMessage(async (channel, payload) => {
  switch (channel) {
    case 'todos:list':
      return await db.query('SELECT * FROM todos')
    case 'todos:add':
      await db.query('INSERT INTO todos ...', [...])
      return { ok: true }
    default:
      throw new Error(`未知操作: ${channel}`)
  }
})
off.dispose()
```

```ts
// 子应用（iframe 内）
window.parent.postMessage(
  { source: 'obox-app', action: 'obox-extension', requestId: 1, appId: 'todo.main', channel: 'todos:list', payload: undefined },
  '*'
)
// 结果回传：parent 收到后 postMessage { source:'obox-app', action:'obox-extension-reply', requestId, result:{ok,data|error} }
```

- `handler(channel, payload)` 可返回 Promise；结果（或错误）经桥回传 iframe；10s 超时
- `appId` = 扩展注册卡片的 id；扩展停用时 handler 自动注销

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

### update（更新能力，仅更新提供者扩展可用）

扩展 manifest 声明 `contributes.updater` 后成为"更新提供者扩展"，并在**设置-更新**中选择为生效提供者（只能一个）后，可调用：

```ts
// 当前 obox 版本号
const version = await api.update.getVersion()
// 解析 GitHub 仓库"最后一次编译"的 release 更新源（按创建时间最新，不依赖 latest 标记）
const feed = await api.update.resolveFeed('obox-org/obox')
// feed = { ok, tag: 'v1.1.0', feedUrl: 'https://github.com/obox-org/obox/releases/download/v1.1.0/', publishedAt }
// 检查更新（feedUrl 为更新源；无默认源，未配置 feed 或未选中时报错）
const r = await api.update.check(feed.feedUrl)
// 下载更新（不自动安装）
const d = await api.update.download()
// 安装并重启（下载完成后）
await api.update.install()
// 订阅更新事件（发现新版本/下载进度/下载完成/错误），返回注销函数
api.update.onEvent((e) => {
  if (e.type === 'update-available') { /* e.version */ }
  if (e.type === 'download-progress') { /* e.percent */ }
  if (e.type === 'update-downloaded') { /* e.version */ }
})
```

> 更新执行由宿主 electron-updater 完成；扩展提供更新源与触发时机。未在设置-更新选中的扩展调用 update API 会抛错。
>
> **更新源解析**：`resolveFeed(repo)` 走主进程调 GitHub REST API 取该仓库最新创建的 release（draft 除外），返回该 tag 的 `releases/download/<tag>/` 作为 feedUrl——**不依赖 GitHub 的 latest 标记**，保证拿到的是"最后一次编译"的产物。Windows 上 electron-builder 生成的更新元数据固定叫 `latest.yml`（无架构后缀），files 含全部架构安装包，electron-updater 按机器架构自动选匹配的安装包，扩展无需关心架构。

### proxy（代理配置）

```ts
// 读取当前代理配置（设置-网络页；obox 与内置扩展自动使用）
const p = api.proxy.get()
// { enabled, host, port?, username?, password?, ignoreSSL?, noProxy? }
```

obox 主进程的网络请求（更新下载等）自动使用该代理；内置扩展经 `api.proxy.get()` 读取并应用；非内置扩展可选使用。

### timer（全局定时器，主进程精确计时）

宿主级定时器跑在**主进程**，不受渲染进程后台节流影响（窗口最小化/不可见时渲染进程 `setTimeout` 会被节流到 1s 粒度）。**间隔为整数秒（≥1s）**；同 id 重复设置会重置；扩展停用/卸载时宿主自动清理全部定时器。

```ts
// 一次性：5 秒后执行一次
api.timer.setTimeout('sync', 5, () => { /* ... */ })
// 重复：每 60 秒执行一次
api.timer.setInterval('tick', 60, () => { /* ... */ })
// 取消（无此 id 时无操作）
api.timer.clearTimeout('sync')
api.timer.clearInterval('tick')
```

- 回调在扩展上下文（渲染进程）执行，**无 payload**（纯"到点了"），需要数据的扩展在回调里自行查询
- 定时器 id 在**扩展内**唯一即可（跨扩展自动隔离）；`seconds` 必须是 ≥1 的整数，否则抛错

### sqlite（数据库，node:sqlite 内置驱动）

宿主内置 SQLite（Node 22 `node:sqlite`，**零依赖**）。`open(name)` 必须传**相对路径**（拒绝绝对路径/`..`/盘符），解析到**扩展自己的数据目录** `userData/extensions/<扩展id>/data/<name>`（宿主自动建目录）——扩展拿不到磁盘路径，数据天然按扩展隔离。

```ts
const db = await api.sqlite.open('todo.db')   // → userData/extensions/todo_chenzhi/data/todo.db
// 首次写入自动建表（id 主键自增；列按 JS 类型声明：number/boolean→INTEGER，string→TEXT；boolean 读写自动 0/1 还原）
await db.insert({ title: '买菜', done: false })          // → 新行（含 id）
await db.insert({ id: 1, title: '买菜改', done: true })  // 含 id = upsert
await db.get(1)                                          // → { id:1, title:'…', done:true }
await db.get_all()                                       // → 全部行
await db.get_by({ done: false })                         // 结构体匹配：等值多键 AND → 数组
await db.update({ done: false }, { done: true })         // 等值条件更新 → 受影响行数
await db.del(1)                                          // 按 id 删除 → 受影响行数
await db.del_by({ done: false })                         // 等值条件删除
await db.clear()                                         // 清空表
await db.exec('CREATE INDEX idx_t ON todo(title)')       // 任意 SQL 脚本（不返回结果集）
await db.query('SELECT title, COUNT(*) AS n FROM todo GROUP BY title')  // 复杂查询 → 对象数组
await db.close()
```

- 默认表名 = 数据库文件名去扩展名（`open('todo.db')` → 表 `todo`）；`query`/`exec` 作用于整个库
- 条件对象（`get_by`/`update`/`del_by` 的 where）只支持**等值匹配**，多键为 AND；复杂条件用 `query` 写 SQL
- 全部方法 `async`（经 IPC 到主进程）；扩展停用/卸载时宿主自动关闭其数据库连接（也可手动 `close()`）

### notification（系统提醒，操作系统通知）

调用操作系统通知 API（Windows Toast / macOS 通知中心）。设置-通知可**逐扩展关闭**，关闭后该扩展 `show` 无操作。

```ts
const r = await api.notification.show({
  title: '任务到期',
  body: '「买菜」已到期',
  icon: 'app://extensions/todo/icon.png', // 可选：app:// URL / http(s) / data: URI / 本地路径
  onClick: () => { /* 点击通知时执行（宿主自动聚焦主窗口） */ }
})
```

- `title` 必填，`body`/`icon`/`onClick` 可选；`onClick` 每次 show 独立绑定，点击后自动注销
- 扩展停用/卸载后不再收到通知点击事件

### net（网络请求）

渲染进程 CSP（`default-src 'self' app:`）**禁止扩展直接 fetch 外部网络**——联网必须走 `api.net.fetch`（主进程发请求，**自动应用设置-网络代理**，默认 30s 超时）：

```ts
const r = await api.net.fetch('https://api.example.com/items', { method: 'POST', json: true, body: { page: 1 } })
if (r.ok) { /* r.status, r.data（JSON 已解析或文本） */ }
// GET 默认；data 按响应 Content-Type 自动解析 JSON/文本；opts.json=true 强制 JSON
// 失败：r.ok=false, r.error（含超时/网络错误）
```

### dialog / shell / clipboard（对话框 / 外链 / 剪贴板）

```ts
// 文件选择（返回路径数组；拿到路径后可配合 api.fs 只能读自己的 data 目录——外部路径仅作展示/传给 api.shell）
const { ok, filePaths, canceled } = await api.dialog.showOpenDialog({ filters: [{ name: 'JSON', extensions: ['json'] }], multiSelect: false })
const { filePath } = await api.dialog.showSaveDialog({ defaultName: 'export.json' })
const { response } = await api.dialog.showMessageBox({ type: 'question', message: '确定？', buttons: ['是', '否'] })
// 打开外部链接/路径（系统默认程序）
await api.shell.openExternal('https://example.com')   // 仅 http/https
await api.shell.openPath('C:\\path\\to\\file.txt')
// 剪贴板
await api.clipboard.writeText('hello')
const text = await api.clipboard.readText()
```

### env（运行环境）

```ts
api.env.platform      // 'win32' | 'darwin' | 'linux'
api.env.arch          // 'x64' | 'arm64'
api.env.nodeVersion   // 宿主内置 Node 版本
await api.env.getOboxVersion()  // obox 版本号
```

### theme（主题）

```ts
api.theme.getCurrent()                    // 当前主题 id（如 'theme-dark'）
const off = api.theme.onChanged((id) => { /* 主题切换时刷新自身 UI */ })
off.dispose()
```

### fs（文件系统，限定扩展数据目录）

与 sqlite 同安全模型：**相对路径**解析到 `userData/extensions/<扩展id>/data/`，拒绝绝对路径/`..`/盘符；自动建目录：

```ts
await api.fs.writeFile('export/data.json', JSON.stringify(rows))   // 写（自动建目录）
const content = await api.fs.readFile('export/data.json')          // 读
const entries = await api.fs.readDir('.')                          // [{ name, isDir }]
const exists = await api.fs.exists('export/data.json')
await api.fs.remove('export')                                       // 删除文件/目录（递归）
```

> 注意：`api.fs` 只能读写扩展自己的 data 目录；`api.dialog` 选到的外部路径**不能**用 `api.fs` 读写（安全边界）。

### window.setProgressBar（任务栏进度）

```ts
await api.window.setProgressBar(0.5)   // 0~1 主窗口任务栏进度
await api.window.setProgressBar(null)  // 清除进度
```

### ui（交互输入：QuickPick / InputBox / toast / 进度）

应用内 UI（非模态），命令参数化交互的常用入口：

```ts
// 选项选择面板（返回选中项 label；取消 → undefined）
const choice = await api.ui.showQuickPick(
  [{ label: '全部', description: '不过滤' }, { label: '已完成' }],
  { title: '筛选', placeHolder: '输入过滤…' }
)
// 单行输入框（password 遮蔽；取消 → undefined）
const name = await api.ui.showInputBox({ title: '新建待办', placeHolder: '任务名称', value: '' })
const token = await api.ui.showInputBox({ title: '输入 Token', password: true })
// 应用内 toast（非模态，自动消失；区别于 dialog 阻塞框与系统 notification）
api.ui.showMessage('已保存', 'success')   // 'info' | 'warning' | 'error' | 'success'
// 多字段表单模态框（返回 {field: value}；取消或必填未过 → undefined）
const form = await api.ui.showForm({
  title: '添加待办',
  closeOnClickOutside: false, // 可选：点击遮罩是否关闭（默认 true；false 只能经取消/确定关闭，避免误触丢失输入）
  fields: [
    { key: 'title', label: '标题', type: 'text', required: true, placeholder: '待办内容' },
    { key: 'notes', label: '备注', type: 'textarea' },
    { key: 'dueDate', label: '截止日期', type: 'date' },
    { key: 'dueTime', label: '截止时间', type: 'time' },
    { key: 'priority', label: '优先级', type: 'select', default: 'medium', options: [{ value: 'high', label: '高' }] },
    { key: 'tags', label: '标签', type: 'checkbox', options: [{ value: 't1', label: '工作' }] }
  ]
})
// 字段类型：text / textarea / number / date / time / select / checkbox（checkbox 值为选中 value 数组）
// showQuickPick / showInputBox 同样支持 closeOnClickOutside 配置
// 任务进度（完成自动关闭；report(percent) 更新进度条）
await api.ui.withProgress('正在同步…', async (report) => {
  report(30)
  await doSync()
  report(100)
})
```

> **模态框显示位置**：`showQuickPick` / `showInputBox` / `showForm` 的模态框按**当前焦点窗口**显示——在 App 子窗口（扩展页面）操作时弹在子窗口，在主窗口操作时弹在主窗口（子窗口模态框结果经宿主桥回传）。

### output（输出通道，底部输出面板）

扩展日志/结果展示（主窗口底部面板，多通道 tab）：

```ts
const log = api.output.createChannel('我的扩展日志')
log.appendLine('开始处理…')
log.append('进度 30%')
log.show()       // 打开底部面板并切到该通道
log.clear()      // 清空
log.dispose()    // 关闭并移除通道
```

### secrets（密钥存储，safeStorage 加密）

token/凭据安全存储（主进程 safeStorage 加密存 userData；**不要**用 Memento 存密钥）：

```ts
await api.secrets.set('github_token', 'ghp_xxx')
const token = await api.secrets.get('github_token')   // undefined = 未设置
await api.secrets.delete('github_token')
```

### fs.watch（文件监听）

监听扩展 data 目录内变化（相对路径事件）：

```ts
await api.fs.watch('watch-1', '.', (e) => {
  console.log('文件变化:', e.relPath)   // 相对监听目录
})
// 停止监听
await api.fs.unwatch('watch-1')
// 扩展停用/卸载时宿主自动关闭全部监听
```

### settings.onChanged（设置变更监听，≈onDidChangeConfiguration）

```ts
const off = api.settings.onChanged(() => {
  const v = api.settings.get('my-ext.interval', 30)
})
off.dispose()
```

### env.language / window 聚焦

```ts
api.env.language              // 当前 UI 语言 'zh' | 'en'
await api.window.isFocused()  // 主窗口是否聚焦
const off = api.window.onFocusChanged((focused) => { /* 聚焦/失焦 */ })
off.dispose()
```

### statusBar.createItem（动态状态栏项，≈VS Code createStatusBarItem）

运行时创建/销毁状态栏项（区别于 manifest 静态声明）：

```ts
const item = api.statusBar.createItem({ text: '同步中…', alignment: 'right', priority: 10 })
item.text = '完成 ✓'        // 更新文本（支持 $(icon)）
item.tooltip = '点击打开'
item.hide()                 // 隐藏
item.show()                 // 显示
item.dispose()              // 销毁（扩展停用宿主自动清理）
```

### views（树视图，contributes.views 声明 + 数据源注册）

先在 manifest 声明树视图（见 manifest-reference），激活时注册数据源：

```ts
const off = api.views.registerTreeProvider('my-ext.tree', {
  async getChildren(element) {
    if (!element) return [{ id: 'root-1', label: '分组 1', collapsible: true }]
    if (element.id === 'root-1') {
      return [
        { id: 'item-1', label: '任务 A', command: 'my-ext.open', args: ['item-1'] }
      ]
    }
    return []
  }
})
off.dispose()   // 注销数据源
```

- 节点 `collapsible: true` 展开时才调用 `getChildren(element)` 加载子节点
- 节点 `command` 点击时执行（`args` 作为参数传给命令 handler）

## 宿主生命周期语义

- **两阶段启动**：扫描 → 注册贡献点 → 释放 barrier → 激活（`plugin(api)`）。UI 等 barrier 后才消费注册表
- **依赖拓扑序**：`extensionDependencies` 先激活依赖；检测环跳过并标记；缺失依赖不阻塞
- **停用**：扩展停用（禁用/重启/卸载）时，宿主执行插件返回的 cleanup、dispose 全部注册（命令 handler 清空、App 卡片移除、事件监听移除）
- **热生效**：安装 .oix 后宿主立即热加载（扫描→注册贡献点→激活），无需重启；禁用/卸载未激活扩展立即热移除，已激活扩展显示"立即重启"按钮（重载渲染进程生效）
- **激活失败**：`plugin(api)` 抛错 → `activationError` 记录，扩展管理器详情页展示，不影响其他扩展
- **热重载（dev）**：Vite HMR 会重载扩展模块；注册必须可清理，否则重复注册冲突

## 类型文件位置

- `src/api/`：扩展 API 类型总目录（面向扩展作者；聚合出口 `src/api/index.ts`）：
  - `types.ts`：`ExtensionActivationApi`
  - `contributions.ts`：贡献点类型（NavItem/StatusBarItem/Command/Theme/Setting/SettingsPage/ContributionManifest）
  - `manifest.ts`：`ExtensionManifest`
  - `registration.ts`：`AppRegistration`
  - `runtime.ts`：`ExtensionInfo`/`ExtensionContextLike`/`Disposable`/`ExtensionModule` 等
  - `shared.ts`：`Memento`/`UpdateEvent`/`ProxyConfig`
- `src/renderer/src/core/types.ts`：历史兼容入口（再导出 `src/api`，保持旧 import 零改动）；**新代码应直接 import `src/api`**
- 扩展开发时经相对路径导入类型（如内置扩展入口 `import type { ExtensionActivationApi } from '../../../../api'`）
