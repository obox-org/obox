# API Reference

宿主在激活扩展时构造 `ExtensionActivationApi` 作为插件函数的唯一参数注入（`api`）。本文按其成员逐节说明；类型定义的物理位置见文末「类型文件位置」。

> **代码引用约定**：未写目录的 `xxx.ts` 一律指 `src/renderer/src/core/xxx.ts`（如 `host.ts`、`registry.ts`、`manifest.ts`、`appStore.ts`）；`src/api/*`、`src/main/*`、`src/shared/*` 一律写全相对路径（如 `src/api/types.ts`、`src/main/timer.ts`）。注意 `core/types.ts` 只是 `src/api` 的历史兼容再导出（`core/types.ts:7`），**类型定义在 `src/api/types.ts`**。

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
- 扩展 id（目录名与 `manifest.name`）的合法字符集是 `^[a-z0-9][a-z0-9._-]*$`，且该正则**带 `i` 标志**（`core/manifest.ts:9`）——大写字母同样合法（`MyExt` 通过）。完整校验规则见 `manifest-reference.md`

## 宿主生命周期语义

- **两阶段启动**：扫描 → 注册贡献点 → 释放 barrier → 激活（`plugin(api)`）。UI 等 barrier 后才消费注册表（`host.ts:882-918`）
- **App 子窗口不激活扩展，但仍会 import 入口**：子窗口（`?obox-window=app`）由 `src/renderer/src/main.ts:27` 传 `activateExtensions:false`，**只跳过阶段二**（不调用 `plugin(api)`，`host.ts:902-908`）；**阶段一照常执行**——宿主仍 `await load()` 每个扩展入口模块并 `registerContributions`（`host.ts:883-896`）。也就是说：**入口模块的顶层代码会在每个 App 子窗口重跑**，`default` 插件函数才只在主窗口执行一次。因此**副作用（连 IPC、写盘、起定时器、装监听、注册命令）必须放进插件函数**，写在模块顶层会在每个子窗口重复执行。子窗口渲染所需的数据来自贡献点注册表与（与主窗口同源的）localStorage 里的 App 卡片（`appStore`）；子窗口内的交互请走 `api.app.onMessage` 消息桥
- **依赖拓扑序**：`extensionDependencies` 先激活依赖；**检测到环不跳过**——环内扩展仍会被激活，只是排到最后（`manifest.ts:165-168` 把环内扩展补进 `ordered`，`host.ts:909` 照常激活）；宿主启动日志末尾会列出环内 id（`host.ts:921-927` 的 `依赖环 …`）。缺失依赖不阻塞，扩展照常激活（`manifest.ts:155`）
- **命令归属**：命令 id 全局唯一，`api.registerCommand(id, handler)` 只能绑定**本扩展 manifest 声明**的命令；绑定别人声明的 id 会被拒绝（`console.warn` + 返回空 Disposable，`registry.ts:196-201`），绑定完全未声明的 id 直接抛错（见 `registerCommand`）。扩展被热移除/卸载/覆盖安装时，其命令会从注册表**物理移除**，同 id 可被其它版本或扩展重新声明（`registry.ts:179-181`）
- **停用**：扩展停用（禁用/重启/卸载）时，宿主执行插件返回的 cleanup、dispose 全部注册（命令 handler 清空、App 卡片移除、事件监听移除）
- **热生效**：安装 .oix 后宿主立即热加载（扫描→注册贡献点→激活），无需重启；禁用/卸载未激活扩展立即热移除，已激活扩展显示"立即重启"按钮（重载渲染进程生效）
- **激活失败**：`plugin(api)` 抛错 → `activationError` 记录（`host.ts:915-917`），扩展管理器详情页展示，不影响其他扩展
- **热重载（dev）**：Vite HMR 会重载扩展模块；注册必须可清理，否则重复注册冲突

## 方法总览

以下小节都是 `api` 对象的成员（含 `### api.ipc` / `### api.python`）。

### registerCommand(id, handler) → Disposable

绑定 manifest 已声明命令的实现。

```ts
const d = api.registerCommand('my-ext.do', async (arg) => {
  // handler 可返回 Promise；executeCommand 返回其结果
  return 'done'
})
// d.dispose() 解除绑定
```

- **命令必须已在 `manifest.contributes.commands` 声明**：未声明时宿主先打一条 `console.warn`（`host.ts:265-269`），紧接着 `registry.setCommandHandler` **抛错**（`registry.ts:193`）——错误从 `plugin(api)` 冒出，扩展被标红 `activationError`，host 捕获后**不再继续激活该扩展**（`host.ts:915-917`）
- 归属校验：id 已被别的扩展声明时只 `console.warn` 并返回空 Disposable，即**静默不绑定**（`registry.ts:196-201`）

### executeCommand<T>(id, ...args) → Promise<T>

跨扩展执行命令（命令 id 是跨扩展稳定契约）。

```ts
const result = await api.executeCommand('other-ext.act', payload)
// 未找到命令/无 handler → 抛 Error(`command not found: <id>`)
```

### statusBar（状态栏项）

操作 manifest 声明的状态栏项（`id` 对应 `statusBarItems[].id`）：

```ts
api.statusBar.setText('my-ext.status', '运行中') // 更新文本（按 HTML 渲染，见下）
api.statusBar.setTooltip('my-ext.status', '提示')
api.statusBar.show('my-ext.status') // 显示
api.statusBar.hide('my-ext.status') // 隐藏
```

运行时创建/销毁状态栏项（区别于 manifest 静态声明，≈VS Code `createStatusBarItem`）：

```ts
const item = api.statusBar.createItem({ text: '同步中…', alignment: 'right', priority: 10 })
item.text = '完成 ✓' // 更新文本（按 HTML 渲染，见下）
item.tooltip = '点击打开'
item.hide() // 隐藏
item.show() // 显示
item.dispose() // 销毁（扩展停用宿主自动清理）
```

- 上面前四个方法作用于**已声明**的项：id 不存在时静默无操作（`host.ts:275-290`）
- `createItem(init?)` 的 `init` 可选字段：`text` / `tooltip` / `alignment`（`'left' | 'right'`）/ `priority`（`src/api/types.ts:118-123`）

### navbar（导航栏徽标）

```ts
api.navbar.setBadge('my-ext.home', 5) // 设数字徽标（>999 显示 1K+）
api.navbar.setBadge('my-ext.home', undefined) // 清除
```

### workspaceState / globalState（Memento）

每扩展独立命名空间的键值存储（JSON 值，底层 userData JSON）：

```ts
api.workspaceState.get<string>('key') // 读
api.workspaceState.get('key', 'default') // 读带默认
api.workspaceState.update('key', value) // 写（undefined 删 key）
api.workspaceState.keys()
// globalState 同构（当前与 workspaceState 共用同一命名空间存储：obox 无"工作区"概念，两者都是应用级）
```

### on(event, listener) / emit(event, ...args)

Cordis 事件总线（跨扩展广播；`emit` 同名事件所有 `on` 监听者收到）：

```ts
const off = api.on('my-ext:changed', (payload) => {
  /* ... */
})
api.emit('my-ext:changed', { some: 'data' })
// 注意：事件名建议含扩展前缀，避免与其他扩展冲突
```

### window（窗口控制，经 preload IPC 到主进程）

> 宿主行为（ADR-0019，**仅 Windows**）：主窗口**不在任务栏显示**并常驻系统托盘；`api.window.close()` 按用户偏好
> "询问 / 收进托盘 / 退出"处理（询问时弹原生对话框），`api.window.minimize()` 同样是**收进托盘**而非系统最小化。
> 关窗不再等于退出，因此**不要**把清理逻辑只挂在窗口关闭上——扩展停用/卸载仍会走 `extension:cleanup`。
>
> **开机自启**（仅 Windows，默认关，设置-通用）：登录后**静默启动**（不显示主窗口、只留托盘），启动项带 `--autostart`；`--autostart` 拉起的第二实例静默退出、不唤前台。开发版不注册，卸载时清理启动项。

```ts
await api.window.minimize()
await api.window.toggleMaximize()
await api.window.close()
const isMax = await api.window.isMaximized()
await api.window.setProgressBar(0.5) // 0~1 主窗口任务栏进度
await api.window.setProgressBar(null) // 清除进度
const focused = await api.window.isFocused() // 见下方"作用窗口"说明
```

- **作用窗口**：`minimize` / `toggleMaximize` / `close` 作用于**当前焦点窗口**（主进程取 `BrowserWindow.getFocusedWindow() ?? 主窗口`，`src/main/window.ts:97`）；`isMaximized` / `isFocused` 读同一取值（`src/main/window.ts:115-118`）。因此焦点在 App 子窗口时，`close()` 关的是**子窗口**，而 `isFocused()` 返回子窗口的聚焦状态（只要有任何窗口聚焦就几乎恒为 `true`）
- `onFocusChanged(cb) → Disposable` 的口径与 `isFocused()` **不同**：状态变化只由**主窗口**的 `focus` / `blur` / `maximize` 等事件推送（`src/main/window.ts:57-62`，子窗口不推送），所以它反映的是**主窗口**是否聚焦
- `setProgressBar` 也是特例：作用于**主窗口**（取第一个非 `obox-window=app` 的窗口，`src/main/ext.ts:136-145`），并被钳到 `0~1`
- 上方 ADR-0019 的托盘 / "询问 / 收进托盘 / 退出"语义描述的是**主窗口**的关窗行为

### appInfo

```ts
const { name, version } = await api.appInfo.get()
```

### app.register(registration) → Disposable

把插件卡片注册进"应用"扩展（App 视图 Grid 展示，点击弹出独立子窗口）：

```ts
const d = api.app.register({
  id: 'my-ext.calculator', // 唯一，建议含扩展前缀
  name: '计算器', // 卡片标题 + 子窗口标题
  version: '1.0.0',
  author: 'Obox',
  description: '一个计算器',
  icon: '<svg .../>', // 必填：SVG 字符串或图片 URL
  iconUrl: 'app://extensions/my-ext/icon.png', // 可选：子窗口任务栏图标（只认 app://extensions/…）
  url: 'app://extensions/my-ext/todo.html', // 子窗口内容 URL（优先）
  // 或 html: '<!doctype html>...',   // 无 url 时用 srcdoc 渲染
  multiOpen: false, // true=每次点击新建窗口(标题加序号)；false=重复点击聚焦
  width: 900, // 子窗口宽（默认 900）
  height: 640 // 子窗口高（默认 640）
})
```

- `icon` 必填；`iconUrl` 只接受 `app://extensions/<id>/<rest>` 形状——主进程解析成 `userData/extensions/<id>/<rest>` 设为**子窗口任务栏图标**，其它形状或含 `..` 时静默忽略、回落应用默认图标（`src/main/appWindow.ts:33-43,82-85`）
- `app://` 三个主机名（`src/main/protocol.ts:13-15,46-58`，越出根目录或含 `..` 返回 403/404）：
  - `app://extensions/<id>/<rest>` → `userData/extensions/<id>/<rest>`（用户扩展；宿主还会二次校验符号链接解析后的真实路径）
  - `app://builtin/<id>/<rest>` → `resources/extensions/<id>/<rest>`（`src/main/paths.ts:16-19`）；**当前打包配置未产出该目录**（`electron-builder.yml` 无对应 `extraResources`，仓库 `resources/` 只有 `icon.png`/`tray.ico`），故该通道虽注册但无内容可服务
  - `app://debug/<id>/<rest>` → `--debug-extension` 声明的本地目录首段为 id（调试扩展用）
- 扩展停用时宿主自动清理其注册的全部卡片
- 子窗口标题 = `name`（多开时 `name 2`、`name 3`…）
- 子窗口内容通信：iframe 内 `parent.postMessage({source:'obox-app', action:'close'|'minimize'|'maximize'}, '*')` 控制子窗口（**不要用内联 onclick，会被 CSP 阻止**）
- **url 加载用户扩展静态页**：CSP 已放行 `app:` scheme（`src/renderer/index.html:10` 的 `default-src 'self' app:` 也覆盖 `frame-src`，故 iframe 可加载），`url: 'app://extensions/<id>/todo.html'` 的页面可执行脚本、可用 localStorage；子窗口 iframe 无 allow-modals，禁 alert/confirm/prompt
- **这是跨源加载，不是同源**：父文档在 dev 是 `http://localhost:5173`（`ELECTRON_RENDERER_URL`）、打包是 `file://`（`src/main/appWindow.ts:25-30`），而 `app:` 是独立注册的 standard scheme（`src/main/protocol.ts:18-29`）——`app://extensions` 与父文档**不同源**，靠 CSP 放行而非同源策略。因此该静态页有**自己的 localStorage**，与主窗口/扩展的 localStorage **不共享**（跨窗口传数据请走 `api.app.onMessage` 消息桥）

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
  {
    source: 'obox-app',
    action: 'obox-extension',
    requestId: 1,
    appId: 'todo.main',
    channel: 'todos:list',
    payload: undefined
  },
  '*'
)
// 结果回传：parent 收到后 postMessage { source:'obox-app', action:'obox-extension-reply', requestId, result:{ok,data|error} }
```

- `handler(channel, payload)` 可返回 Promise；结果（或错误）经桥回传 iframe；**60s 超时**（放宽以容纳 handler 内弹模态框等需用户填写的场景）
- `appId` = 扩展注册卡片的 id；扩展停用时 handler 自动注销（每个扩展只保留**最后一个** handler，`host.ts:378-384`）

### i18n（扩展多语言）

扩展语言包与宿主语言包独立命名空间，互不冲突：

```ts
// 运行时注册语言包（或 manifest contributes.i18n 声明）
api.i18n.registerMessages({
  zh: { hello: '你好' },
  en: { hello: 'Hello' }
})
// 按当前语言取文案（缺省返回 key）
const text = api.i18n.t('hello', { name: 'Obox' }) // 支持 {param} 插值
// 当前语言代码
const locale = api.i18n.locale // 'zh' | 'en'
// 语言切换监听（返回 Disposable），扩展据此刷新自身 UI
api.i18n.onLocaleChanged((locale) => {
  /* 重新渲染 */
})
// 注意：底层复用设置变更通知，但**只在语言真的变化时**才回调（设置变更通知的触发面远大于语言切换）
```

> 取值顺序：当前语言 → **回退 `zh`**（当前语言没有条目时）→ 都没有则返回 key 本身。因此只提供 `zh` 语言包不会在英文界面下变成裸 key。

### settings（扩展设置项）

扩展设置页显示在"设置"左侧树的"扩展"节点下（按扩展名展开）：

```ts
// 运行时注册设置页（或 manifest contributes.settings 声明）
const page = api.settings.register({
  id: 'my-ext.settings',
  title: '我的扩展设置',
  fields: [
    {
      key: 'my-ext.interval',
      label: '刷新间隔',
      type: 'number',
      default: 30,
      description: '单位秒' // 可选：字段下方的说明文字
    },
    {
      key: 'my-ext.mode',
      label: '模式',
      type: 'select',
      options: [{ value: 'a', label: 'A' }],
      default: 'a'
    }
  ]
})
// 读写设置值（统一设置存储，key 建议含扩展前缀；set 立即持久化并通知）
const v = api.settings.get('my-ext.interval', 30)
api.settings.set('my-ext.interval', 60)
page.dispose() // 注销设置页
```

设置字段类型：`text` / `number` / `boolean` / `select`；可选 `default` / `options` / `description`（`src/api/contributions.ts:76-89`）。

变更监听（≈VS Code `onDidChangeConfiguration`）：

```ts
const off = api.settings.onChanged((key) => {
  const v = api.settings.get('my-ext.interval', 30)
})
off.dispose()
```

> 回调参数是**变更的设置项 key**（如 `my-ext.interval`）；无具体 key 的场景（如语言切换）传空字符串（`host.ts:421`）。监听者仍可用 `api.settings.get` 读取当前值。

### update（更新能力，仅更新提供者扩展可用）

扩展 manifest 声明 `contributes.updater` 后成为"更新提供者扩展"，并在**设置-更新**中选择为生效提供者（只能一个）后，可调用：

```ts
// 当前 obox 版本号
const version = await api.update.getVersion()
// 解析 GitHub 仓库的更新源（取最近若干 release 中第一个含 latest.yml 的正式版）
const feed = await api.update.resolveFeed('obox-org/obox')
// feed = { ok, tag: 'v1.1.0', feedUrl: 'https://github.com/obox-org/obox/releases/download/v1.1.0/', publishedAt }
// 检查更新（feedUrl 为更新源；无默认源，未配置 feed 或未选中时报错）
const r = await api.update.check(feed.feedUrl)
// 下载更新（不自动安装）
const d = await api.update.download()
// 安装并重启（下载完成后）
await api.update.install()
// 强制重装 / 降级：直接下载本机架构安装包、校验 sha512、启动安装向导（应用不退出）
// 绕开 electron-updater 的版本门控（allowDowngrade=false + 同版本判"无更新"），同版本重装与降级都能做
const forced = await api.update.install({ force: true, feedUrl: feed.feedUrl })
// forced = { ok, version?, error? }；feedUrl 省略时用提供者 manifest 里的 contributes.updater.feedUrl
// 订阅更新事件（返回注销函数）
api.update.onEvent((e) => {
  switch (e.type) {
    case 'update-available':
      /* e.version */ break
    case 'update-not-available':
      /* 已是最新，无附加字段 */ break
    case 'download-progress':
      /* e.percent / e.bytesPerSecond / e.transferred / e.total */ break
    case 'update-downloaded':
      /* e.version */ break
    case 'error':
      /* e.message */ break
  }
})
```

> `UpdateEvent` 共 5 种：`update-available` / `update-not-available` / `download-progress` / `update-downloaded` / `error`（`src/api/shared.ts:7-18`）；`update-not-available` 与 `error` 是 `check()` 之外的独立回调路径，别只处理前三种。
>
> 更新执行由宿主 electron-updater 完成；扩展提供更新源与触发时机。未在设置-更新选中的扩展调用 update API 会抛错。
>
> **更新源解析**：`resolveFeed(repo)` 走主进程调 GitHub REST API，取最近若干 release 中**第一个可用项**——非 draft、非 prerelease，且资产里含 `latest.yml`（即"确实编译出了更新元数据"），返回该 tag 的 `releases/download/<tag>/` 作为 feedUrl；**不依赖 GitHub 的 latest 标记**（latest 可能指向未完成编译或预发布的 release）。无可用项时返回 `ok:false`，**扩展应自行回落** `https://github.com/<owner>/<repo>/releases/latest/download/`。Windows 上 electron-builder 生成的更新元数据固定叫 `latest.yml`（无架构后缀），files 含全部架构安装包，electron-updater 按机器架构自动选匹配的安装包，扩展无需关心架构。

### proxy（代理配置）

```ts
// 读取当前代理配置（设置-网络页；obox 与内置扩展自动使用）
const p = api.proxy.get()
// { enabled, host, port?, username?, password?, ignoreSSL?, noProxy? }
```

obox 主进程的网络请求（更新下载等）自动使用该代理；内置扩展经 `api.proxy.get()` 读取并应用；非内置扩展可选使用。

> **代理如何生效**（`src/main/proxy.ts:44-78`）：主进程在**发请求的 session** 上调用 `setProxy`（`proxyRules` + `noProxy` → `proxyBypassRules`；未启用/无 host → `mode:'direct'`）与 `setCertificateVerifyProc`（`ignoreSSL` → 放行全部证书），同一份配置同时应用到扩展联网 session（`obox-net`）与 electron-updater session；配置指纹未变则不重复调用。因此代理与 `ignoreSSL` **真实作用于请求**，且不会互相覆盖。
>
> **不要**试图用环境变量配代理：写 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `NODE_TLS_REJECT_UNAUTHORIZED` **对两条链路都无效**——Node 的 `fetch`（undici）与 Electron `net.request`（Chromium）都不读这些变量（早期实现正是如此，实测把 `HTTP_PROXY` 指向不可达代理仍直连成功，`src/main/proxy.ts:1-7`）。

### timer（全局定时器，主进程精确计时）

宿主级定时器跑在**主进程**，不受渲染进程后台节流影响（窗口最小化/不可见时渲染进程 `setTimeout` 会被节流到 1s 粒度）。**间隔为整数秒（≥1s，上限 86400 秒 = 1 天）**；同 id 重复设置会重置；扩展停用/卸载时宿主自动清理全部定时器（`src/main/timer.ts:60-64`）。

> **秒级倒计时怎么写**：每次 tick 用 `Date.now()` 与目标时间**重算剩余**再 `setText`，不要靠 tick 次数累加——定时器只保证「不小于间隔」，累加会漂移；长计时也不要放在渲染进程的 `setTimeout` 里（最小化会被节流）。

```ts
// 一次性：5 秒后执行一次
api.timer.setTimeout('sync', 5, () => {
  /* ... */
})
// 重复：每 60 秒执行一次
api.timer.setInterval('tick', 60, () => {
  /* ... */
})
// 取消（无此 id 时无操作）
api.timer.clearTimeout('sync')
api.timer.clearInterval('tick')
```

- 回调在扩展上下文（渲染进程）执行，**无 payload**（纯"到点了"），需要数据的扩展在回调里自行查询
- 定时器 id 在**扩展内**唯一即可（内部 key = `<扩展id>:<id>`，跨扩展自动隔离，`src/main/timer.ts:16-18`）
- `seconds` 必须是 **1–86400 的整数**（`src/main/timer.ts:29-37`）。上限的存在理由：`seconds * 1000` 超过 2³¹−1 时 Node 会把延时钳成 1ms，`setInterval` 退化成"每毫秒广播 `timer:fire`"的事件风暴（`src/main/timer.ts:26-27`）
- **非法 `seconds` 是静默失败，不会抛错**：主进程校验失败只返回 `{ ok:false, error }`（`src/main/timer.ts:69-88`），宿主用 `void` 丢弃该结果（`host.ts:604-609`）——既不抛错也不提示，定时器**不会建立**、回调永不触发

### sqlite（数据库，node:sqlite 内置驱动）

宿主内置 SQLite（Node 22 `node:sqlite`，**零依赖**）。`open(name)` 必须传**相对路径**（拒绝绝对路径/`..`/盘符），解析到**扩展自己的数据目录** `userData/extensions/<扩展id>/data/<name>`（宿主自动建目录）——扩展拿不到磁盘路径，数据天然按扩展隔离。相对路径可含子目录（如 `sub/a.db`，Windows 上写 `/` 亦可）；**不同子目录下的同名库互不干扰**（列类型元数据按库路径隔离）。

> **SQL 限制**：`exec` / `query` 会拒绝 `ATTACH` / `DETACH` / `VACUUM` / `PRAGMA` / `load_extension`——这些语句能读写库外文件或加载外部代码，会绕过"仅限扩展 data 目录"的沙箱。两者的失败形态不同：`exec` **原样返回** `{ ok:false, error:'不允许的 SQL 语句：…' }`（`host.ts:634`），`query` 经内部 `call()` **抛 `Error`**（`host.ts:626-632,635-637`）。常规 `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`CREATE`/`ALTER`/`WITH` 等不受影响。

```ts
const db = await api.sqlite.open('todo.db') // → userData/extensions/todo_chenzhi/data/todo.db
// 首次写入自动建表（id 主键自增；列按 JS 类型声明：number/boolean→INTEGER，string→TEXT；boolean 读写自动 0/1 还原）
await db.insert({ title: '买菜', done: false }) // → 新行（含 id）
await db.insert({ id: 1, title: '买菜改', done: true }) // 含 id = upsert
await db.get(1) // → { id:1, title:'…', done:true }
await db.get_all() // → 全部行
await db.get_by({ done: false }) // 结构体匹配：等值多键 AND → 数组
await db.update({ done: false }, { done: true }) // 等值条件更新 → 受影响行数
await db.del(1) // 按 id 删除 → 受影响行数
await db.del_by({ done: false }) // 等值条件删除
await db.clear() // 清空表
await db.exec('CREATE INDEX idx_t ON todo(title)') // 任意 SQL 脚本（不返回结果集）
await db.query('SELECT title, COUNT(*) AS n FROM todo GROUP BY title') // 复杂查询 → 对象数组
await db.close()
```

- 默认表名 = 数据库文件名去扩展名（`open('todo.db')` → 表 `todo`）；`query`/`exec` 作用于整个库
- 条件对象（`get_by`/`update`/`del_by` 的 where）只支持**等值匹配**，多键为 AND；复杂条件用 `query` 写 SQL
- 除 `exec` 与 `close` 外，所有方法的失败都是**抛 `Error`**（宿主内部 `call()` 把主进程的 `{ok:false}` 转成抛错，`host.ts:626-632`）；`exec` 走另一条路——**原样返回** `{ ok:false, error }`（见上）；`close()` 也**不经 `call()`**，直接返回 IPC 原始结果（`host.ts:656`，主进程侧是无返回值句柄关闭，`src/main/sqlite.ts:78-80`），因此对不存在的库 `close()` 静默无操作、**不会抛错**
- 全部方法 `async`（经 IPC 到主进程）；扩展停用/卸载时宿主自动关闭其数据库连接（也可手动 `close()`）
- **数据目录的生命周期**：库文件在 `<扩展>/data/<name>.db`（安装态即 `userData/extensions/<扩展id>/data/`）；**覆盖安装（升级）时宿主保留 `data/`**，所以数据不会因升级丢失；**卸载时 `data/` 随扩展目录一起删除**。因此打包时不要把 `data/` 放进 `.oix`——宿主会直接拒收（见 [guides-user.md](guides-user.md) §6）

### notification（系统提醒，操作系统通知）

调用操作系统通知 API（Windows Toast / macOS 通知中心）。设置-通知可**逐扩展关闭**，关闭后该扩展 `show` 无操作。

```ts
const r = await api.notification.show({
  title: '任务到期',
  body: '「买菜」已到期',
  icon: 'app://extensions/todo/icon.png', // 可选：app:// URL / http(s) / data: URI / 本地路径
  onClick: () => {
    /* 点击通知时执行（宿主自动聚焦主窗口） */
  }
})
```

- `title` 必填，`body`/`icon`/`onClick` 可选；`onClick` 每次 show 独立绑定，点击后自动注销
- 扩展停用/卸载后不再收到通知点击事件

### net（网络请求）

渲染进程 CSP（`default-src 'self' app:`）**禁止扩展直接 fetch 外部网络**——联网必须走 `api.net.fetch`（主进程经 **Chromium session** 发请求，**自动应用设置-网络代理**，默认 30s 超时，响应体上限 8MB）：

```ts
const r = await api.net.fetch('https://api.example.com/items', {
  method: 'POST',
  json: true,
  body: { page: 1 }
})
if (r.ok) {
  /* r.status, r.data（JSON 已解析或文本） */
}
// GET 默认；data 按响应 Content-Type 自动解析 JSON/文本；opts.json=true 强制 JSON
// 失败：r.ok=false, r.error（含超时/网络错误）
```

代理与 `ignoreSSL` 的作用方式见上方 `proxy` 一节（session 级，不是环境变量）。

### dialog / shell / clipboard（对话框 / 外链 / 剪贴板）

```ts
// 文件选择（返回路径数组；拿到路径后可配合 api.fs 只能读自己的 data 目录——外部路径仅作展示/传给 api.shell）
const { ok, filePaths, canceled } = await api.dialog.showOpenDialog({
  filters: [{ name: 'JSON', extensions: ['json'] }],
  multiSelect: false
})
const { filePath } = await api.dialog.showSaveDialog({ defaultName: 'export.json' })
const { response } = await api.dialog.showMessageBox({
  type: 'question',
  message: '确定？',
  buttons: ['是', '否']
})
// 打开外部链接/路径（系统默认程序）
await api.shell.openExternal('https://example.com') // 仅 http/https
await api.shell.openPath('C:\\path\\to\\file.txt')
// 剪贴板
await api.clipboard.writeText('hello')
const text = await api.clipboard.readText()
```

### env（运行环境）

```ts
api.env.platform // 'win32' | 'darwin' | 'linux'
api.env.arch // 'x64' | 'arm64'
api.env.nodeVersion // 宿主内置 Node 版本
api.env.language // 当前 UI 语言 'zh' | 'en'
await api.env.getOboxVersion() // obox 版本号
```

### theme（主题）

```ts
api.theme.getCurrent() // 当前主题 id（如 'theme-dark'）
const off = api.theme.onChanged((id) => {
  /* 主题切换时刷新自身 UI */
})
off.dispose()
```

### fs（文件系统，限定扩展数据目录）

与 sqlite 同安全模型：**相对路径**解析到 `userData/extensions/<扩展id>/data/`，拒绝绝对路径/`..`/盘符；自动建目录：

```ts
await api.fs.writeFile('export/data.json', JSON.stringify(rows)) // 写（自动建目录）
const content = await api.fs.readFile('export/data.json') // 读
const entries = await api.fs.readDir('.') // [{ name, isDir }]
const exists = await api.fs.exists('export/data.json')
await api.fs.remove('export') // 删除文件/目录（递归）
// 监听 data 目录内变化（相对路径事件）
await api.fs.watch('watch-1', '.', (e) => {
  console.log('文件变化:', e.relPath) // 相对监听目录
})
await api.fs.unwatch('watch-1') // 停止监听
```

- 除 `watch` 的超限错误外，所有失败都是**抛 `Error`**（宿主把主进程的 `{ok:false}` 转成 `throw new Error(...)`，`host.ts:551-557`）
- `watch`：**单扩展并发监听上限 16**（`src/main/fs.ts:25`）；超限时主进程返回 `{ok:false, error:'监听数量已达上限（16）'}`（`src/main/fs.ts:154-156`），宿主**转成抛错**（`host.ts:574-581`）。同 id 重复 `watch` 会先关掉旧监听、不占新增额度（`src/main/fs.ts:151-153`）
- 监听目录被删 / 权限变化 → 宿主记录并自动关闭该监听（`src/main/fs.ts:166-170`），扩展侧此后收不到事件（不会崩主进程）
- 扩展停用/卸载时宿主自动关闭全部监听
- `api.fs` 只能读写扩展自己的 data 目录；`api.dialog` 选到的外部路径**不能**用 `api.fs` 读写（安全边界）

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
api.ui.showMessage('已保存', 'success') // 'info' | 'warning' | 'error' | 'success'
// 多字段表单模态框（返回 {field: value}；取消或必填未过 → undefined）
const form = await api.ui.showForm({
  title: '添加待办',
  closeOnClickOutside: false, // 可选：点击遮罩是否关闭（默认 true；false 只能经取消/确定关闭，避免误触丢失输入）
  fields: [
    { key: 'title', label: '标题', type: 'text', required: true, placeholder: '待办内容' },
    { key: 'notes', label: '备注', type: 'textarea' },
    { key: 'dueDate', label: '截止日期', type: 'date' },
    { key: 'dueTime', label: '截止时间', type: 'time' },
    {
      key: 'priority',
      label: '优先级',
      type: 'select',
      default: 'medium',
      options: [{ value: 'high', label: '高' }]
    },
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

扩展日志/结果展示（主窗口底部面板，多通道 tab）。`createChannel(name)` 的参数是**显示名**（通道内部 id 由宿主自增生成），每次调用创建一个新通道（`outputStore.ts:22-31`）：

```ts
const log = api.output.createChannel('我的扩展日志')
log.appendLine('开始处理…')
log.append('进度 30%')
log.show() // 打开底部面板并切到该通道
log.clear() // 清空
log.dispose() // 关闭并移除通道
```

- channel 的方法就这 5 个：`append(text)` / `appendLine(text)` / `show()` / `clear()` / `dispose()`（`src/api/types.ts:62-70`）
- **没有 `api.output.append(...)`**：`append` 只在 `createChannel(name)` 返回的 channel 上（`src/api/types.ts:420-422`）

### secrets（密钥存储，safeStorage 加密）

token/凭据安全存储（主进程 safeStorage 加密存 userData；**不要**用 Memento 存密钥）：

```ts
await api.secrets.set('github_token', 'ghp_xxx')
const token = await api.secrets.get('github_token') // undefined = 未设置
await api.secrets.delete('github_token')
```

> 系统加密不可用（或 Linux 上后端回落为明文 `basic_text`）时，`api.secrets.*` **抛 `Error`**（`host.ts:502-516`），而不是明文落盘（fail-closed），也不是返回错误对象——调用方需 `try/catch` 并把该功能视为不可用。

### views（树视图，contributes.views 声明 + 数据源注册）

先在 manifest 声明树视图（见 manifest-reference），激活时注册数据源：

```ts
const off = api.views.registerTreeProvider('my-ext.tree', {
  async getChildren(element) {
    if (!element) return [{ id: 'root-1', label: '分组 1', icon: '<svg .../>', collapsible: true }]
    if (element.id === 'root-1') {
      return [{ id: 'item-1', label: '任务 A', command: 'my-ext.open', args: ['item-1'] }]
    }
    return []
  }
})
off.dispose() // 注销数据源
```

- 节点 `collapsible: true` 展开时才调用 `getChildren(element)` 加载子节点
- 节点 `command` 点击时执行（`args` 作为参数传给命令 handler；命令须已声明）
- 节点可选 `icon`（SVG 字符串，`src/api/types.ts:84-97`）

### api.ipc（与外部进程的端口无关 IPC，见 ADR-0016）

与**其它语言写的进程**双向通信。**不使用任何 TCP 端口**（不会端口冲突、不触发防火墙），传输只有两种：

- `stdio`：宿主**帮你拉起**子进程，用它的 stdin/stdout 通信、stderr 作日志；
- `pipe`：连接**已在运行**的进程（Windows 命名管道 / POSIX Unix 域套接字），端点由宿主按「扩展 id + 通道名」推导。

协议是 **JSON-RPC 2.0**（请求/响应/错误/通知），分帧默认 `Content-Length`（二进制安全），也可 `ndjson`。

```ts
// 1) stdio：把随扩展分发的程序跑起来（program 必须是扩展目录内的相对路径）
//    `.js/.cjs/.mjs` 以纯 Node 运行（语义见下方「JS 助手的运行时语义」）；其它（Rust/Python/Go 产物）直接执行
await api.ipc.connect({
  id: 'worker',
  transport: 'stdio',
  program: 'bin/worker.exe',
  args: ['--serve']
})

// 1b) 清单里静态声明过（contributes.ipcChannels）的通道：只写 id 即可
await api.ipc.connect('worker')
// 传对象时**运行时声明优先**；清单里没声明的 id 会直接报 invalid-declaration（不会静默失败）

// 2) pipe：连接已在运行的进程（对端需按同样的端点命名约定监听）
await api.ipc.connect({ id: 'svc', transport: 'pipe' })

// 3) 请求 / 通知
const sum = await api.ipc.request('worker', 'sum', { a: 1, b: 2 }) // → 3
await api.ipc.notify('worker', 'log', { text: 'hello' })

// 4) 查询当前已打开的通道名
const open = await api.ipc.channels() // → ['worker']

// 5) 双向：对端也能调用宿主（返回值即 JSON-RPC result）
api.ipc.onRequest('worker', (method, params) =>
  method === 'hostInfo' ? { version: '1.0.4' } : undefined
)
api.ipc.onNotification('worker', (method, params) => console.log(method, params))
// 对端 stderr 落进输出通道：append 在 createChannel 返回的 channel 上（没有 api.output.append）
const log = api.output.createChannel('worker 日志')
api.ipc.onStderr('worker', (text) => log.append(text))
api.ipc.onClose('worker', (err) => console.warn('通道关闭', err.code))

// 6) 关闭（扩展停用/卸载时宿主也会自动清理）
await api.ipc.close('worker')
```

**JS 助手的运行时语义**：`program` 以 `.js` / `.cjs` / `.mjs` 结尾时，宿主用**宿主进程自带的 Node**（`process.execPath`）运行它，并给子进程注入 `ELECTRON_RUN_AS_NODE=1`（`src/main/ipc.ts:155-163`、`src/main/ipcTransport.ts:28-35`）——助手是**纯 Node 程序**，不是 Electron 应用（`process.versions.electron` 仍有值，用的还是同一个可执行文件，只是按 Node 模式启动）：

- **可用 `node:*` 内置模块**：`node:fs` / `node:path` / `node:child_process`…都行，**包括 `node:sqlite`**——助手可以**自己建库、自己读写**，不必绕经 `api.sqlite`（`api.*` 那条路按扩展隔离数据目录；助手这条路就是普通 Node 进程）
- **stdin / stdout 正常工作**：宿主按声明的 `framing` 把请求写进 stdin，助手从 stdout 回包即可；日志一律写 **stderr**（stdout 只放协议数据）
- **Node 版本 = 宿主内置 Electron 的 Node**（助手内 `process.versions.node` 可查，与 `api.env.nodeVersion` 同一份运行时）：宿主**不额外安装 Node**，助手也不要假设系统 PATH 上有独立的 `node`
- **cwd = 扩展源目录下的 `data/`**：安装态是 `userData/extensions/<扩展id>/data`，调试态是**调试目录的 `data/`**（见下表「stdio 的 cwd」）

| 项             | 说明                                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 限额           | 每扩展最多 **4 条通道**（`src/main/ipc.ts:27`）；**每通道并发请求上限 64**（`src/main/ipcCore.ts:27`，超出抛 `too-many-requests`）；单条消息上限 **8MB**（`src/main/ipcCore.ts:23`）；请求默认 **30s** 超时（`src/main/ipcCore.ts:25`，`request(..., { timeoutMs })` 可覆盖）                         |
| 错误码         | `invalid-declaration` / `connect-failed` / `not-connected` / `protocol-error` / `timeout` / `cancelled` / `message-too-large` / `too-many-requests` / `too-many-channels` / `peer-crashed` / `channel-closed`（失败一律以错误码抛出，不静默挂起）                                                     |
| 生命周期       | 通道由扩展**显式**打开；扩展停用/卸载/重载、窗口关闭、应用退出时宿主统一断开（并终止由宿主拉起的子进程）                                                                                                                                                                                              |
| 任何语言可接入 | 对端只要会读写标准输入输出（stdio）或连上套接字（pipe）即可；**不需要开端口**，也不需要网络配置                                                                                                                                                                                                       |
| stdio 的 cwd   | 宿主拉起对端时 **cwd = `<扩展>/data`**（`src/main/ipc.ts:153-161`，不是扩展根目录）：`program` 相对**扩展目录**解析，但 `args` 里若写相对路径要按 cwd 算（例如脚本在 `<扩展>/scripts/x.py` 时写 `['../scripts/x.py']`；E2E 实测踩过，写 `['scripts/x.py']` 会让对端立刻退出并表现为 `not-connected`） |
| 清单声明       | 在 `contributes.ipcChannels` 静态声明后，代码里只写 `api.ipc.connect('<通道id>')`；声明**不自动连接**，非法声明会让清单无效（见 manifest-reference）                                                                                                                                                  |
| 信任边界       | 与 ADR-0015 一致：这是**能力封装而非安全边界**（扩展与宿主同上下文，属受信代码）                                                                                                                                                                                                                      |

### api.python（扩展自带的 Python 运行时，见 ADR-0018）

**只提供 `run`**，用来跑随扩展包分发的 Python 脚本（运行时与依赖都在扩展包内，宿主不下载、不代管 pip）。

```js
// 跑一个随扩展分发的脚本。默认不超时：脚本里 plt.show() 会开窗等用户关窗
const { code, stdout, stderr } = await api.python.run('scripts/run.py', ['--flag', 'a b'])

// 需要与宿主双向通信时，把该进程注册成一条 api.ipc 通道
await api.python.run('scripts/serve.py', [], { channel: 'py1' })
api.ipc.onRequest('py1', (method, params) => ({ echo: params })) // Python 侧需自行实现协议
const answer = await api.ipc.request('py1', 'compute', { n: 7 })
```

| 项             | 说明                                                                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 调用方式       | 宿主以 **shell** 方式启动 `<扩展>/python/python.exe`（参数按 cmd 规则转义）；工作目录是扩展 data 目录                                                                                                                                                                   |
| 返回值         | `{ code, stdout, stderr }`；**脚本失败不抛错**（`code` 非零 + `stderr`），调用方必须自己判断 `code`                                                                                                                                                                     |
| 超时           | **默认不超时**（交互式脚本会一直等到进程结束）；写错脚本（死循环/`input()`）会挂住调用方                                                                                                                                                                                |
| 错误码（抛出） | `python-missing`（包里没有该架构的运行时）/ `arch-mismatch` / `launch-failed` / `invalid-declaration`（如脚本越出扩展目录）                                                                                                                                             |
| 通道           | `opts.channel`：省略/`false` = 不建；`true` = 建一条名为 `python` 的通道；字符串 = 指定名。**计入"每扩展 4 条通道"限额**                                                                                                                                                |
| 协议           | 走通道时 Python 侧需自行实现 JSON-RPC 2.0 + `Content-Length` 分帧；**不建议再往 stdout 打印**（会破坏分帧）                                                                                                                                                             |
| 环境           | 子进程只拿白名单 env（PATH/SystemRoot/TEMP/TMP/HOME/USERPROFILE/LANG）+ `PYTHONHOME`/`PYTHONPATH(<扩展>/data/user-site)`/`PYTHONNOUSERSITE`；**宿主的代理设置对 Python 无效**（pip 需自行处理网络）                                                                     |
| 依赖           | 依赖由扩展作者在打包时预置在 `<扩展>/python/Lib/site-packages`（随包替换）；用户自行装的库落在 `<扩展>/data/user-site`（升级保留）。**调试扩展**（`--debug-extension`）按**调试目录**找 `<扩展>/python/`，因此带运行时的扩展也能用调试方式开发（数据目录仍在 userData） |
| 生命周期       | 扩展停用/卸载/重载时宿主**杀进程树**并注销通道（与定时器/DB/watch 同一时机）                                                                                                                                                                                            |
| 信任边界       | 与 ADR-0015 一致：能力封装而非安全边界；Python 代码与扩展同等受信，**不构成沙箱**                                                                                                                                                                                       |

## 生命周期钩子（install / uninstall）

扩展入口可具名导出两个**可选**钩子；不写即跳过（不报错）：

```js
// 扩展入口（manifest.main 指向的文件）
export function install(ctx) {
  // .oix 安装完成后「立刻执行一次」。覆盖安装（升级）会重跑，ctx.upgraded === true
}
export function uninstall(ctx) {
  // 卸载时「删除目录之前」执行
}
```

| 项             | 说明                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上下文         | `ctx.extensionId` / `ctx.upgraded` / `ctx.previousVersion` / `ctx.api`（与激活时同一套能力面）                                                                                                                                                                                                                                                                                      |
| 能力边界       | 钩子期**注册类能力不生效**（命令/视图/状态栏/App 卡片等属"激活后"的注册）；钩子只做环境准备与清理（写自己的 data 目录、准备依赖、删缓存）                                                                                                                                                                                                                                           |
| install 时机   | 安装完成后立刻；若此刻主窗口不可用或扩展尚未加载到宿主，则**留待下次启动、激活之前补跑一次**（同一版本只跑一次，升级会重跑且给出 `ctx.previousVersion`）                                                                                                                                                                                                                            |
| uninstall 时机 | 删除目录之前；**禁用态的扩展也会临时加载入口**来跑它。注意：**刚装完（同一个会话内）立刻卸载**时，渲染进程还没有该扩展的加载器 → 入口 `uninstall` 不会执行、回退 `.uninstall.cjs`（重启后再卸载才会走入口钩子）                                                                                                                                                                     |
| 钩子超时       | 入口钩子（两阶段都是）默认 **10s**（`src/main/hookBridge.ts:16`）；超时按钩子失败处理（`src/main/hookBridge.ts:99-105`）——`install` 超时归为激活失败，`uninstall` 超时只告警并继续删目录。渲染进程**没送到**（`send` 抛错）不算钩子失败：返回 `delivered:false`，安装场景据此保留待下次启动补跑（`src/main/hookBridge.ts:107-116`）                                                 |
| install 失败   | 归为**激活失败**（扩展标红、写 `activationError`）；文件层不回滚                                                                                                                                                                                                                                                                                                                    |
| uninstall 失败 | 只告警（`[capabilities] 扩展 X 的 uninstall 钩子失败：…`），**仍继续删除目录**（否则写错的钩子会让扩展永远删不掉）                                                                                                                                                                                                                                                                  |
| 幂等要求       | 宿主保证"同扩展同阶段不并发"；跨安装（升级重跑、补跑）可能再次执行，**钩子需自行保证幂等**                                                                                                                                                                                                                                                                                          |
| 旧机制兼容     | 固定文件 `.uninstall.cjs` 仍作为**回退**（`spawn(process.execPath, [hookPath])`，5 秒超时）。触发条件不止"入口未导出 `uninstall`"：主进程判定式是 `delivered && !deferred && !skipped`（`src/main/capabilities.ts:102-112`），该式**不成立**时都会回退到该文件——即入口未导出钩子（`skipped`）、**扩展当时未加载到宿主**或**渲染进程/主窗口不可用**（`deferred` / 未送达）同样走回退 |

## 类型文件位置

- `src/api/`（聚合出口 `src/api/index.ts`）：`src/api/types.ts` = `ExtensionActivationApi` / `SqliteDb` / `OutputChannel` / `TreeItem`；`src/api/contributions.ts` = 贡献点类型；`src/api/manifest.ts` = `ExtensionManifest`；`src/api/registration.ts` = `AppRegistration`；`src/api/shared.ts` = `Memento` / `UpdateEvent` / `ProxyConfig` / `IpcChannelDeclaration`；`src/api/runtime.ts` = `ExtensionInfo` / `Disposable` / `ExtensionModule` 等
- `src/renderer/src/core/types.ts` 是历史兼容入口（再导出 `src/api`，旧 import 零改动）；**新代码直接 import `src/api`**
- 扩展经相对路径导入类型，如内置扩展入口 `import type { ExtensionActivationApi } from '../../../../api'`
