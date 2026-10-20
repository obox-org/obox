# API Reference

> **本文件是 obox 扩展 API 的唯一真相（single source of truth），位置 `docs/extension-api/`**：`ExtensionActivationApi`、宿主能力与贡献点注册的说明只此一份，仓库内其它文档（九步链各阶段、扩展工程文档）一律引用本目录，不复制副本。

宿主在激活扩展时构造 `ExtensionActivationApi` 作为插件函数的唯一参数注入（`api`）。本文按其成员逐节说明；类型定义的物理位置见文末「类型文件位置」。

> **代码引用约定**：未写目录的 `xxx.ts` 一律指 `src/renderer/src/core/xxx.ts`（如 `host.ts`、`registry.ts`、`manifest.ts`、`appStore.ts`）；`src/api/*`、`src/main/*`、`src/shared/*`、`src/extension-host/*` 一律写全相对路径（如 `src/api/types.ts`、`src/main/timer.ts`、`src/extension-host/activator.ts`）。注意 `core/types.ts` 只是 `src/api` 的历史兼容再导出（`core/types.ts:7`），**类型定义在 `src/api/types.ts`**。

## 运行模型（ADR-0026，先读这一节）

obox 有**两个扩展运行时**，代码落在哪一侧决定了你能用什么：

|              | 用户扩展（`.oix`）                                                                                      | 内置扩展                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 执行位置     | **Extension Host Process**：主进程用 Electron `utilityProcess` 拉起的独立 **Node 进程**，随主窗口同生共死 | **Renderer Runtime**：渲染进程（源码在 `src/renderer/src/extensions/<id>/`）    |
| Node 能力    | **完整 Node**：`node:fs` / `node:child_process` / `node:sqlite` / 任意内置模块，入口按 `file://` 动态 `import()` | 无 Node（只有注入的 `api`，能力经 `window.api` 走主进程）                       |
| DOM          | **没有**（宿主进程没有 DOM、没有 `window`、没有 `localStorage`）                                        | 有（与 UI 同一个进程）                                                         |
| 界面怎么来   | 贡献点 + `app://` 静态页（App 卡片 / overlay 页面）、树视图数据源                                       | 另有 `navItems[].view` 指向的**具名导出 Vue 组件**                             |
| 激活时机     | 按 `activationEvents` 懒激活（缺省 `*` = 立即，见 [manifest-reference.md](manifest-reference.md)）       | **立即激活**，不参与懒激活                                                     |

- **API 交付方式没变**：仍是 `export default function (api) {…}`，`api` 由宿主按扩展 id 现场构造后作为**唯一参数**传入（不是 `require('obox')` 拦截，也不是全局变量）。
- **宿主进程没有 Electron API**：`safeStorage`（`api.secrets`）、系统对话框、通知、窗口与托盘、菜单、`app://` 协议、自动更新都仍**经主进程**执行；扩展看到的方法签名不变。
- **跨进程约束**（写代码时就要按这个来）：每次 `api.*` 都是 RPC（或宿主内直达）。参数与返回值**只过 JSON 值 + 二进制旁路**——函数 / Symbol / 类实例 / 循环引用 / `Map` / `Set` 一律拒绝（`EH_UNSERIALIZABLE`），单帧上限 **8MB**（`EH_FRAME_TOO_LARGE`）。排查见 [troubleshooting.md](troubleshooting.md)。
- **`api.on` / `api.emit` 不跨运行时**：事件只在**同一个运行时内**广播——用户扩展之间互通、内置扩展之间互通，**两者之间不再互通**（用户扩展已不在渲染进程，这条是结构性的，不是缺陷）。
- **`api.executeCommand` 只能执行用户扩展的命令**：命令表在宿主里（含全部用户扩展），内置扩展的命令不在其中 ⇒ 执行内置命令会得到 `command not found: <id>`。
- **`workspaceState` / `globalState` 在宿主模式下是真隔离**：两份独立存储（`state/workspace.json` / `state/global.json`）。v1 里"两者其实指向同一份 store"是假隔离，已修正——依赖"两者其实同一份"的扩展会感知到差异。
- **默认与开关**：obox **2.0.0 起宿主进程默认开启**（用户扩展在 Extension Host Process 里执行）。可在 **设置 → 通用 → 「在独立进程中运行扩展」** 关掉（**需重启生效**，关掉后扩展回到渲染进程执行、`activationEvents` 不生效且全部立即激活）。环境变量 `OBOX_EXTENSION_HOST`（`0`/`false` 关闭）保留为开发者兜底，优先级为 **设置项 > 环境变量 > 默认开**。**宿主启动失败会自动回退**到渲染进程执行并给出提示（见 troubleshooting #41）。无论哪种模式，扩展都必须**按宿主进程这一侧写**（不碰 DOM / localStorage）。
- 逐条**降级实现**（同步 API 退化成缓存、字节分帧、未自动化验证的重连等）集中登记在文末「宿主模式的降级与限制」。

## 入口契约

用户扩展的入口在**扩展自己的目录**（`manifest.main`，纯 ESM JavaScript，宿主在宿主进程里按 `file://` 动态 `import`）；内置扩展入口是 `src/renderer/src/extensions/<id>/index.ts`（Vite `import.meta.glob` 收集，可用 `.ts` / `.vue`，差异见 [guides-builtin.md](guides-builtin.md)）。

```ts
// 内置扩展：src/renderer/src/extensions/<id>/index.ts
// 用户扩展：<扩展仓库>/index.js（manifest.main 指向的文件）
export const HomeView = /* Vue 组件（仅内置扩展） */   // 具名导出：导航项 view 字段引用
export default function myExt(api: ExtensionActivationApi): (() => void) | void {
  // ... 注册命令实现、事件、App 卡片 ...
  return () => { /* 清理：dispose 所有注册 */ }
}
```

- `default` 导出插件函数：宿主以 `plugin(api)` 调用；返回值（函数或 `{ dispose() }`）作为清理函数被宿主收集，扩展停用时执行
- 具名导出：视图组件（`view` 字段引用）；宿主把具名导出组件登记进注册表。**只有内置扩展能这么用**——用户扩展没有 Vue 运行时，界面走 App 卡片静态页或 `contributes.views` 树视图（见 [guides-user.md](guides-user.md)）
- 扩展 id（目录名与 `manifest.name`）的合法字符集是 `^[a-z0-9][a-z0-9._-]*$`，该正则**不带 `i` 标志**（`core/manifest.ts:11`，issue #77）——**只接受小写**，含大写（如 `MyExt`）即清单无效。完整校验规则见 `manifest-reference.md`

## 宿主生命周期语义

> 本节描述**渲染侧**的时序（两个运行时共用）。用户扩展（宿主模式）的 `plugin(api)` 不在渲染进程跑：渲染侧只注册它的贡献点，激活由宿主进程按 `activationEvents` 完成（`*` 在 `init` 后、`onStartupFinished` 在 `*` 之后、`onCommand:<id>` 在执行该命令之前、`onView:<id>` 在打开该导航项时）。**内置扩展仍在渲染侧立即激活**，不参与懒激活。

- **两阶段启动**：扫描 → 注册贡献点 → 释放 barrier → 激活（`plugin(api)`）。UI 等 barrier 后才消费注册表（`host.ts` 的 `start()`）
- **激活触发（宿主模式）**：`onCommand:<id>` 由 `executeCommand` 前置触发（判断"命令归属的扩展是否在宿主里"，是则先请宿主激活、再**重查** handler；激活失败则**中止**动作并给出中文原因，不会执行一个没有实现的命令）；`onView:<id>` 由导航栏点击（`App.vue` 的 `selectNav`）与 `nav:open`（主进程请求切页）各接一路。同一扩展的并发触发会**合并成一次**激活，激活请求超时 **10 秒**（`ACTIVATION_TIMEOUT_MS`，不是普通 RPC 的 3 秒）
- **App 子窗口不激活扩展，但仍会 import 入口**：子窗口（`?obox-window=app`；overlay 窗体 `?obox-window=overlay` 同判，`src/renderer/src/main.ts:21-23`）由 `src/renderer/src/main.ts:37` 传 `activateExtensions:false`，**只跳过阶段二**（不调用 `plugin(api)`，`host.ts:1006-1012`）；**阶段一照常执行**——宿主仍 `await load()` 每个扩展入口模块并 `registerContributions`（`host.ts:986-1000`）。也就是说：**入口模块的顶层代码会在每个 App 子窗口重跑**，`default` 插件函数才只在主窗口执行一次。因此**副作用（连 IPC、写盘、起定时器、装监听、注册命令）必须放进插件函数**，写在模块顶层会在每个子窗口重复执行。子窗口渲染所需的数据来自贡献点注册表与（与主窗口同源的）localStorage 里的 App 卡片（`appStore`）；子窗口内的交互请走 `api.app.onMessage` 消息桥
- **依赖拓扑序**：`extensionDependencies` 先激活依赖；**检测到环不跳过**——环内扩展仍会被激活，只是排到最后（`manifest.ts:197-200` 把环内扩展补进 `ordered`，`host.ts:1013-1022` 照常激活）；宿主启动日志末尾会列出环内 id（`host.ts:1024-1031` 的 `依赖环 …`）。缺失依赖不阻塞，扩展照常激活（`manifest.ts:187`）
- **命令归属**：命令 id 全局唯一，`api.registerCommand(id, handler)` 只能绑定**本扩展 manifest 声明**的命令；绑定别人声明的 id 会被拒绝（`console.warn` + 返回空 Disposable，`registry.ts:206-211`），绑定完全未声明的 id 直接抛错（见 `registerCommand`）。扩展被热移除/卸载/覆盖安装时，其命令会从注册表**物理移除**，同 id 可被其它版本或扩展重新声明（`registry.ts:189-191`）
- **停用**：扩展停用（禁用/重启/卸载）时，宿主执行插件返回的 cleanup、dispose 全部注册（命令 handler 清空、App 卡片移除、事件监听移除）
- **热生效**：安装 .oix 后宿主立即热加载（扫描→注册贡献点→激活），无需重启；禁用/卸载未激活扩展立即热移除，已激活扩展显示"立即重启"按钮（重载渲染进程生效）
- **激活失败**：`plugin(api)` 抛错 → `activationError` 记录（`host.ts:1019-1021`），扩展管理器详情页展示，不影响其他扩展
- **热重载（dev）**：Vite HMR 会重载扩展模块；注册必须可清理，否则重复注册冲突

## 方法总览

以下小节都是 `api` 对象的成员（含 `### overlay` / `### api.ipc` / `### api.python`）。

### registerCommand(id, handler) → Disposable

绑定 manifest 已声明命令的实现。

```ts
const d = api.registerCommand('my-ext.do', async (arg) => {
  // handler 可返回 Promise；executeCommand 返回其结果
  return 'done'
})
// d.dispose() 解除绑定
```

- **命令必须已在 `manifest.contributes.commands` 声明**：未声明时宿主先打一条 `console.warn`（`host.ts:313-317`），紧接着 `registry.setCommandHandler` **抛错**（`registry.ts:203`）——错误从 `plugin(api)` 冒出，扩展被标红 `activationError`，host 捕获后**不再继续激活该扩展**（`host.ts:1019-1021`）
- 归属校验：id 已被别的扩展声明时只 `console.warn` 并返回空 Disposable，即**静默不绑定**（`registry.ts:206-211`）

### executeCommand<T>(id, ...args) → Promise<T>

执行命令（命令 id 是跨扩展稳定契约）。

```ts
const result = await api.executeCommand('other-ext.act', payload)
// 未找到命令/无 handler → 抛 Error(`command not found: <id>`)
```

- **只能执行用户扩展的命令**（含自己）：命令表在宿主进程里，只收集用户扩展 `api.registerCommand` 绑定的实现；**内置扩展的命令不在其中**，执行会得到 `command not found: <id>`
- 目标扩展还没激活时，宿主会**先按 `onCommand:<id>` 触发激活**再执行（见「宿主生命周期语义」）；激活失败 ⇒ 抛中文错误并中止，不会执行半个动作
- handler 的返回值可过 RPC：纯 JSON 值可回，函数 / 类实例等过不去（`EH_UNSERIALIZABLE`）。二进制用 `Uint8Array` / `ArrayBuffer`

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

- 上面前四个方法作用于**已声明**的项：id 不存在时静默无操作（`host.ts:322-338`）
- `createItem(init?)` 的 `init` 可选字段：`text` / `tooltip` / `alignment`（`'left' | 'right'`）/ `priority`（`src/api/types.ts:141-146`）

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
// globalState 同构
```

> **宿主模式下两者是真隔离**（两份文件：扩展 data 目录下的 `state/workspace.json` 与 `state/global.json`，各一套键空间）。v1 把 `workspaceState` 与 `globalState` 指向同一个 store（假隔离），本版按名字给出真隔离——**依赖"两者其实是同一份"的扩展会感知到差异**。回退开关关闭（扩展仍在渲染进程）时仍是 v1 的共用存储。

### on(event, listener) / emit(event, ...args)

事件总线（**同一个运行时内**广播；`emit` 同名事件的所有 `on` 监听者都会收到）：

```ts
const off = api.on('my-ext:changed', (payload) => {
  /* ... */
})
api.emit('my-ext:changed', { some: 'data' })
// 注意：事件名建议含扩展前缀，避免与其他扩展冲突
```

- **不跨运行时**：用户扩展的事件在 Extension Host Process 里广播，内置扩展的事件在 Renderer Runtime 里广播，**两者之间不再互通**（这是 ADR-0026 的结构性后果，不是缺陷）
- payload 过 RPC：纯 JSON 值可传，函数 / 类实例 / 循环引用过不去（`EH_UNSERIALIZABLE`）

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

- `icon` 必填；`iconUrl` 只接受 `app://extensions/<id>/<rest>` 形状——主进程解析成 `userData/extensions/<id>/<rest>` 设为**子窗口任务栏图标**，其它形状或含 `..` 时静默忽略、回落应用默认图标（`src/main/appWindow.ts:34-44,83-86`）
- `app://` 三个主机名（`src/main/protocol.ts:13-15,46-58`，越出根目录或含 `..` 返回 403/404）：
  - `app://extensions/<id>/<rest>` → `userData/extensions/<id>/<rest>`（用户扩展；宿主还会二次校验符号链接解析后的真实路径）
  - `app://builtin/<id>/<rest>` → `resources/extensions/<id>/<rest>`（`src/main/paths.ts:16-19`）；**当前打包配置未产出该目录**（`electron-builder.yml` 无对应 `extraResources`，仓库 `resources/` 只有 `icon.png`/`tray.ico`），故该通道虽注册但无内容可服务
  - `app://debug/<id>/<rest>` → `--debug-extension` 声明的本地目录首段为 id（调试扩展用）
- 扩展停用时宿主自动清理其注册的全部卡片
- 子窗口标题 = `name`（多开时 `name 2`、`name 3`…）
- 子窗口内容通信：iframe 内 `parent.postMessage({source:'obox-app', action:'close'|'minimize'|'maximize'}, '*')` 控制子窗口（**不要用内联 onclick，会被 CSP 阻止**）
- **url 加载用户扩展静态页**：CSP 已放行 `app:` scheme（`src/renderer/index.html:10` 的 `default-src 'self' app:` 也覆盖 `frame-src`，故 iframe 可加载），`url: 'app://extensions/<id>/todo.html'` 的页面可执行脚本、可用 localStorage；子窗口 iframe 无 allow-modals，禁 alert/confirm/prompt
- **这是跨源加载，不是同源**：父文档在 dev 是 `http://localhost:5173`（`ELECTRON_RENDERER_URL`）、打包是 `file://`（`src/main/appWindow.ts:26-31`），而 `app:` 是独立注册的 standard scheme（`src/main/protocol.ts:18-29`）——`app://extensions` 与父文档**不同源**，靠 CSP 放行而非同源策略。因此该静态页有**自己的 localStorage**，与主窗口/扩展的 localStorage **不共享**（跨窗口传数据请走 `api.app.onMessage` 消息桥）
- **主题下发（宿主 → 子窗口，单向）**：`url` 型卡片跨源，宿主**注入不了** CSS（`iframe.contentDocument` 恒为 `null`），CSS 变量也不跨文档继承 ⇒ token 只能经消息送达。宿主在 iframe `load` 完成、每次主题变化、以及收到子页面请求这三个时机，向 `iframe.contentWindow` 发 `{source:'obox-app', action:'obox-theme', themeId, tokens}`：`tokens` 是宿主 25 个 token 的**生效值**快照（与主窗口所见一致），扩展侧把每条 `documentElement.style.setProperty(k, v)` 即跟随主题；拿不到时用**内置兜底**（不报错、不空白）。子页面可用 `{source:'obox-app', action:'obox-theme-request'}` 请宿主重发。**`url` 型卡片切主题不再重渲染**（`:key` 为 `url:<url>`，与主题无关 ⇒ 页内表单内容不丢），**`srcdoc` 型仍靠重渲染**（`:key` 为 `srcdoc:<themeId>`）。协议细节、最小接收代码与降级行为见 [themes-settings.md](themes-settings.md#app-子窗口url-型主题下发协议)；实现见 `src/renderer/src/core/appTheme.ts` 与 `src/renderer/src/AppWindow.vue`

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

- `handler(channel, payload)` 可返回 Promise；结果（或错误）经桥回传 iframe；**60s 超时**（放宽以容纳 handler 内弹模态框等需用户填写的场景；实现是 `src/main/appWindow.ts:190-193`，`60_000` 这个超时值全文件只设定在这一处）。**overlay 窗体复用同一座桥与同一超时**——扩展若用"入口 → 页面"的**长轮询 hold** 做状态同步，hold 时长必须**小于** 60s（宠物扩展用 25s，`extensions/pet/lib/constants.js:38-40`），否则宿主先超时、页面收到的是「扩展未响应（超时）」而不是订阅结果（见下方 `### overlay`）
- `appId` = 扩展注册卡片的 id；扩展停用时 handler 自动注销（每个扩展只保留**最后一个** handler，`host.ts:426-433`）
- **路由现支持 overlay（卡片路径行为逐字不变）**：归属查找走纯函数 `resolveMessageExtId`——**先按 `appId` 查 App 卡片**（`appStore.findById(appId)?.extensionId`），**未命中再按 `overlayId` 查 overlay 路由表**（`overlayOwners`），都未命中回**既有**错误「扩展未注册消息处理器」（`host.ts:89-95,622-646`；门禁 `test/overlay-window.test.ts` 的「宿主 · 消息路由」）。overlay 页面把自己的 `overlayId` 当 `appId` 原样发即可；外壳对 overlay 窗口还会**强制**用查询串里的 `appId`（= `overlayId`），页面无法借道指定别人的卡片 id 发消息（`src/renderer/src/AppWindow.vue:204-210`）
- `app.onMessage` 是**请求/响应**桥（经主进程 IPC、需要扩展注册 handler、有 `requestId` 与超时）。**主题是宿主单向推送**，不经该桥、**不需要** handler、也没有 `requestId`（见上面 `app.register` 的"主题下发"一条）——两者**不要混用**

### overlay（Overlay 窗体：无边框 / 可透明 / 可置顶 / 不占任务栏的固定小窗）

桌面宠物、悬浮小部件一类的**常驻桌面 UI**。与 `api.app` 的区别：overlay **不注册卡片、不进启动器/导航区、不写 `appStore`**，由扩展**自行创建与销毁**——因此**后台扩展**（完全不注册 App 卡片）也能有桌面界面。窗体尺寸固定（不可调整大小、不可最大化），定位在**主显示器工作区**（`workArea`，不含任务栏）内按 `anchor` 贴角。

> **本命名空间随 API v2 引入**（`src/api/types.ts:187-252`；`setPosition` 为卡 14 增补）。它在类型上是**必填**成员（不是 `overlay?`）：宿主 `buildApi` 构造 api 时必定注入（`host.ts:435,581-614`），所以过了门槛成功激活的扩展可以直接 `api.overlay.create(...)`，**不需要可选链**。"老宿主没有本命名空间"由 manifest `apiVersion` 门槛兜底——声明 `apiVersion: 2` 的扩展在老宿主上**直接被拒绝加载**（`core/manifest.ts:28-38`），而不是运行到一半 `undefined`（见 `manifest-reference.md`）。

#### 四方法签名

```ts
// 创建：失败**不抛错**，返回 { ok:false, error }（中文可执行原因）
const r = await api.overlay.create({
  id: 'pet.overlay', // 必填：overlay id，建议含扩展名前缀
  url: 'app://extensions/pet/overlay.html', // 必填：**本扩展目录内**的页面
  width: 220, // 必填：> 0（像素）
  height: 460, // 必填：> 0
  anchor: 'bottom-right', // 必填：四个合法值之一
  margin: 24, // 可选：≥ 0，缺省 24
  transparent: true, // 可选：缺省 false，**只在创建时决定**
  alwaysOnTop: true, // 可选：缺省 false
  skipTaskbar: true // 可选：缺省 false
})
if (!r.ok) console.error(r.error)
else console.log(r.position) // R31：{ x, y } = anchor/margin 解析后的**实际窗体坐标**（拖动换算的绝对基准）

await api.overlay.destroy('pet.overlay') // **真销毁**（不是隐藏）；幂等
await api.overlay.setMouseThrough('pet.overlay', false) // false=接收鼠标事件；true=整窗穿透

// 运行期移动（卡 14）：把窗体左上角移到屏幕坐标 (x, y)；成功时 position = **钳制后的实际坐标**
const moved = await api.overlay.setPosition('pet.overlay', 120, 340)
if (moved.ok) console.log(moved.position) // { x, y }（扩展拿不到 workArea，用它校正扩展记录）
```

签名逐字取自 `src/api/types.ts:207-252`：

| 方法                                                        | 返回                       | 实现                                        |
| ----------------------------------------------------------- | -------------------------- | ------------------------------------------- |
| `create(options: CreateOverlayRequest)`                      | `Promise<OverlayResult>`   | `src/main/appWindow.ts:391-502`             |
| `destroy(id: string)`                                        | `Promise<OverlayResult>`   | `src/main/appWindow.ts:504-533`             |
| `setMouseThrough(id: string, through: boolean)`              | `Promise<OverlayResult>`   | `src/main/appWindow.ts:535-572`             |
| `setPosition(id: string, x: number, y: number)`              | `Promise<OverlayResult>`   | `src/main/appWindow.ts:599-660`             |

参数与返回形状定义在 **`src/shared/types.ts:521-580`**（`OverlayAnchor` / `CreateOverlayRequest` / `OverlayResult`）——主进程窗体实现、preload 类型与扩展 API **三处共用同一份**，防签名漂移（与对话框类型同先例）；由 `src/api/types.ts:14-32` 再导出 ⇒ 扩展照旧 `import type { CreateOverlayRequest } from '<...>/api'`。`OverlayResult` 就是 `{ ok: boolean; error?: string; position?: { x: number; y: number } }`（失败不抛错，与 `notification.show` / `shell.openExternal` 同风格）——**`position` 由 `create` 与 `setPosition` 成功时回传**（create = anchor/margin 解析后的初始绝对位置；setPosition = 钳制后的实际位置；destroy/setMouseThrough 不带），用途是给扩展侧一个**绝对坐标基准**：扩展拿不到 `workArea`，既算不出 anchor 落点也不知道宿主钳到了哪（R31）。四条 IPC 通道是 `overlay:create` / `overlay:destroy` / `overlay:set-mouse-through` / `overlay:set-position`（`src/preload/index.ts:69-76`、注册在 `src/main/appWindow.ts:669-686`，由 `src/main/index.ts:103` 挂载）。

#### 参数契约（`CreateOverlayRequest`）与校验

| 字段          | 必填 | 类型                                                                                             | 约束与缺省                                                                                                                                                       |
| ------------- | ---- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | ✅   | string                                                                                           | 非空。**全局唯一**（不是"每扩展唯一"）：同扩展重复创建被拒（提示先 `destroy`），**别的扩展占了同 id 也被拒**（消息桥按 overlayId 全局寻址，`src/main/appWindow.ts:401-411`） |
| `url`         | ✅   | string                                                                                           | 非空，且必须指向**调用方扩展目录内**的页面（判据见下方「url 双重校验」）                                                                                            |
| `width`       | ✅   | number                                                                                           | 有限且 **> 0**（像素）。尺寸固定：不可调整大小、不可最大化                                                                                                        |
| `height`      | ✅   | number                                                                                           | 有限且 **> 0**                                                                                                                                                     |
| `anchor`      | ✅   | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'`                                    | 必须是这四个之一（`src/shared/types.ts:515`；运行期白名单 `src/main/appWindow.ts:255`）——贴**主显示器工作区**的哪个角                                                        |
| `margin`      | ❌   | number                                                                                           | 有限且 **≥ 0**（负值拒绝）；**缺省 24**（`src/main/appWindow.ts:258,413`）。可以为 0（完全贴角）                                                                            |
| `transparent` | ❌   | boolean                                                                                          | **缺省 false**。**只在创建时决定，创建后不可运行时切换**（Electron 限制）；透明时宿主不绘制任何窗体背景并关闭阴影/系统边框/圆角。Windows 上依赖 DWM 合成             |
| `alwaysOnTop` | ❌   | boolean                                                                                          | **缺省 false**。全屏独占应用下仍可能被遮挡——平台行为，非宿主缺陷                                                                                                  |
| `skipTaskbar` | ❌   | boolean                                                                                          | **缺省 false**（true = 不占任务栏）                                                                                                                                |

- 校验实现在纯函数 `validateOverlayRequest`（`src/main/appWindow.ts:293-329`，`test/overlay-window.test.ts` 直接喂非法值断言被拒）：三个开关传了非布尔也拒（`:323-327`）；`extId` 不是非空字符串 ⇒ 报「缺少扩展 id（宿主接线错误：overlay 四方法必须由宿主绑定扩展 id 调用）」（`:294-296`）。
- **所有失败都是 `{ ok:false, error }`，一个窗体都不建、也不抛错**；`error` 是中文可执行原因（如 `anchor 必须是 bottom-right / bottom-left / top-right / top-left 之一：bottom-center`）。

**`setPosition(id, x, y)` 的参数契约（运行期移动，卡 14）**：

| 参数 | 必填 | 类型   | 约束                                                                                                                       |
| ---- | ---- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `id` | ✅   | string | 非空；作用域同下节（越权 ⇒ `ok:false` + error 指认真实属主；不存在/已销毁 ⇒ `ok:false`，与 `setMouseThrough` 同口径）          |
| `x`  | ✅   | number | **有限数字**；NaN / Infinity / 非数字（含字符串 `'10'`）/ 缺参一律 `ok:false` 拒绝（**不钳不猜**）；合法数字被钳进工作区（见下） |
| `y`  | ✅   | number | 同 `x`                                                                                                                      |

- 成功返回 `{ ok: true, position: { x, y } }`，`position` = **钳制后的实际坐标**（与 `create` 回传初始绝对位置同一字段，R31）；失败/拒绝路径**不带** `position`（不回传任何"猜测"出来的坐标）。
- 校验与钳位实现在 `setOverlayPosition`（`src/main/appWindow.ts:599-660`）+ 纯函数 `clampOverlayPosition`（`:574-597`，`test/overlay-window.test.ts` 直接喂边界值断言钳制结果）；钳位公式见下方「窗体参数与定位 · 运行期移动」。

#### 作用域安全（只能操作自己创建的 overlay）

四个方法都只能操作**调用方扩展自己创建的** overlay，越权一律 `{ ok:false }` + 中文 error + `[overlay]` 前缀 `console.warn`：

- **定位方式**：主进程登记表 key = `overlayKey(extId, overlayId)` = `` `${extId}:${overlayId}` ``（`src/main/appWindow.ts:240-252`；扩展 id 字符集不含 `:`，故首冒号即分界）。
- **区分"别人的"与"不存在"**：`findOverlayOwner(overlayId)` 扫登记表找所属扩展（`:384-389`）。找到且不是调用方 ⇒ **越权拒绝**：`destroy` 回「越权被拒：overlay X 由扩展 Y 创建，Z 只能销毁自己创建的 overlay」（`:516-525`），`setMouseThrough` 回同款文案（`:555-562`），`setPosition` 与 `setMouseThrough` **完全同构**（越权 `:627-634`，不存在 `:635-636`，卡 14）；找不到 ⇒ `destroy` **静默成功**（幂等），`setMouseThrough` / `setPosition` **明确报错**（见下方生命周期）。
- **宿主侧把 `ext.id` 绑死在闭包里**：`buildOverlayApi(ext, disposables)` 构造的四个方法都只转发 `ext.id`（`host.ts:581-614`），扩展拿不到别人的绑定，也无法从参数里伪造。
- **这是能力封装，不是安全边界**：用户扩展跑在 Extension Host Process（与 UI 不同进程），但仍是受信代码、无沙箱，宿主模式下还有完整 Node（ADR-0015）。作用域校验防的是**误用/串号**；不限定作用域等于任一扩展都能销毁、穿透或**移走**别人的窗体，所以必须严格。门禁：`test/overlay-window.test.ts` 的「主进程 · 作用域安全」与「主进程 · setPosition」。

#### 生命周期

| 事件                     | 行为                                                                                                                                                                                                                            | 证据                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 创建成功                 | 窗体**默认鼠标穿透**（等效已调用 `setMouseThrough(id, true)`）——透明 overlay 不应一出现就吞掉其覆盖区域的桌面点击；实现是 `setIgnoreMouseEvents(true, { forward: true })`                                                          | `src/main/appWindow.ts:459-462`                                      |
| 创建成功回传位置         | `create` 成功回包带 `position` = anchor/margin 解析后的**实际窗体坐标**（与创建日志里的 `@(x,y)` 同一份，不重算）——扩展拿不到 workArea，首次拖动（存档还没有位置）时入口靠它建立绝对基准（R31）                                        | `src/main/appWindow.ts:498-501`                                      |
| 显示时机                 | `show:false` 创建，`ready-to-show`（首帧绘制完成）后才 `show()`——避免创建瞬间闪一块底色                                                                                                                                           | `src/main/appWindow.ts:447-448,474`                                  |
| `destroy(id)`            | **真销毁**（`win.destroy()`，不是隐藏）：页面与驱动它的 rAF/定时器动画循环随之终止，CPU 占用回落；权威状态应由扩展入口持有，不随窗体销毁丢失                                                                                       | `src/main/appWindow.ts:527-531`；**已实机验证**：卡 01 证据 §4        |
| `destroy` 幂等           | 不存在（或已销毁）的 `id` 重复销毁**静默成功**（`ok:true`）；销毁后同 id 可重建（登记表已被 `closed` 清理）                                                                                                                        | `src/main/appWindow.ts:516-525,475-480`                              |
| `setMouseThrough` 不存在 | 与 `destroy` 的幂等**不同**：对不存在/已销毁的 id 返回 **`ok:false`**（`overlay 不存在（或已销毁）：X`）——切换穿透没有"默认成功"语义，明确报错让扩展能自查                                                                          | `src/main/appWindow.ts:555-564`                                      |
| `setPosition` 不存在/已销毁 | 与 `setMouseThrough` **同口径**：返回 **`ok:false`**（`overlay 不存在（或已销毁）：X`），**不抛错**——移动没有幂等语义，明确报错让扩展能自查                                                                                        | `src/main/appWindow.ts:635-636`                                      |
| 扩展停用 / 卸载          | **自动回收**该扩展的全部 overlay：`create` 发起时就把「销毁该 overlay」挂进 `disposables`，走既有 cleanup 路径（`disposeAll` / `removeExtension` 的 `cleanup()`）；`removeExtension` 另对路由表做**兜底清扫**，防路由项残留        | `host.ts:586-596,1132-1152`                                 |
| 主窗口关闭               | overlay 一并关闭（对齐 App 子窗口的既有行为）：overlay 是扩展的附属桌面 UI，主窗口没了它就没有存在意义（消息桥的对端宿主也没了）                                                                                                    | `src/main/appWindow.ts:217-232`（由 `src/main/index.ts:54` 接线）     |
| 窗体 `closed`            | 清登记表 + **立即结算**该窗口发出、还在等扩展回复的桥请求（`flushPendingReplies`，以「overlay 窗体已销毁」为 error），不让它空挂 60s                                                                                               | `src/main/appWindow.ts:162-170,475-480`                              |
| 不进启动器               | overlay **不写 `appStore`、不注册卡片**：宿主只在 `overlayOwners`（overlayId → 扩展 id）里登记一条路由项，且**只收成功创建的** overlay（失败不登记）                                                                              | `host.ts:115-122,597-600`                                   |

#### 窗体参数与定位（主进程实现）

`new BrowserWindow({...})` 的全部选项（`src/main/appWindow.ts:424-455`）：

- **尺寸与位置**：`width` / `height`（= 请求值）、`x` / `y`（= `overlayPosition` 算出）
- **透明相关**：`transparent`（= 请求值，缺省 false）、`backgroundColor`（**`transparent` 为 true 时 `'#00000000'`，否则回落 `'#1e1e1e'`**——带 alpha 的背景必须与 `transparent:true` 同用，否则不透明窗会渲染成黑/灰底；卡 01 证据 §5 对照 1 实测单独留 `'#00000000'` 得到 `#f3f3f3`）
- **无边框 / 固定尺寸**：`hasShadow:false`、`thickFrame:false`、`roundedCorners:false`（三者全关 = 完全无边框；Wayland/GTK 下 `hasShadow` 不关会留阴影边框）、`resizable:false`、`maximizable:false`、`frame:false`
- **行为开关**：`alwaysOnTop` / `skipTaskbar`（= 请求值，缺省 false）、`acceptFirstMouse:true`（macOS：未聚焦时第一次点击也直接生效）、`autoHideMenuBar:true`、`show:false`（+ `ready-to-show` 后 `show()`）
- **webPreferences**：`preload`（与 App 子窗口同一份）、`sandbox:false`、`contextIsolation:true`、`nodeIntegration:false`

上述 11 个与"透明 + 固定尺寸"直接相关的开关（`transparent` / `hasShadow` / `thickFrame` / `roundedCorners` / `acceptFirstMouse` / `alwaysOnTop` / `skipTaskbar` / `resizable` / `maximizable` / `frame` / `show`）连同 `backgroundColor` 与尺寸/坐标，由 `test/overlay-window.test.ts:272-297` 逐项钉住。

**定位公式**（纯函数 `overlayPosition`，`src/main/appWindow.ts:339-362`）：基准是 **主显示器工作区** `screen.getPrimaryDisplay().workArea`（不含任务栏；多显示器环境**只用主显示器**，不用光标所在屏），

```text
靠右的 anchor：x = workArea.x + workArea.width  - width  - margin
靠左的 anchor：x = workArea.x + margin
靠下的 anchor：y = workArea.y + workArea.height - height - margin
靠上的 anchor：y = workArea.y + margin
```

`margin` 可为 0（完全贴角）；公式对负 `workArea` 原点（多显示器副屏坐标）同样成立（`test/overlay-window.test.ts` 的「四个 anchor 的定位公式」）。**已实机验证**：卡 01 证据 §0 记录探测窗体实际 bounds 与公式预测**完全一致**。

**运行期移动（`setPosition`，卡 14）**：创建后位置不是死的——扩展可调 `api.overlay.setPosition(id, x, y)` 把窗体**左上角**移到屏幕坐标 (x, y)（拖宠物换位，宠物扩展 design D-13）。`create` 成功即回传初始绝对位置（`OverlayResult.position`，R31），扩展拖动时以它为基准把增量换算成绝对坐标。

- **钳位双保险（扩展主钳、宿主兜底）**：**扩展侧主钳**（入口累加拖动增量后先钳到工作区再调 `setPosition`，design D-13）；**宿主侧兜底**——把 x/y 钳到主显示器工作区：`x ∈ [wa.x, wa.x+wa.width-w]`、`y ∈ [wa.y, wa.y+wa.height-h]`（w/h 取该 overlay **当前尺寸**，`getBounds()`；纯函数 `clampOverlayPosition`，`src/main/appWindow.ts:574-597`，与 D-13 扩展侧公式**完全一致**）。为什么要宿主兜底：扩展拿不到 `workArea`，换显示器/改分辨率后仍可能算出越界值；兜底保证窗体左上角不出工作区（不越界、不盖任务栏）。
- **不钳不猜**：非法坐标（NaN/Infinity/非数字/缺参）**直接拒绝**（`ok:false` + 中文可执行 error，`:614-626`），不做任何静默"修正"——钳位语义只针对**合法数字**超出工作区的情形。
- **回传钳制后的实际坐标**：成功时 `OverlayResult.position = { x, y }`，扩展入口用它校正自己记录的位置，避免账实不符（被钳过之后只有扩展自己算的值是错的）。
- **移动只改位置**：不触碰 `transparent` / `alwaysOnTop` / 鼠标穿透态等其它窗体属性（穿透态由 `setMouseThrough` 专管；拖动期间指针在窗体内，穿透本就是关的，无需联动）；实现只调 `win.setPosition`（`:641-651`）。
- **日志**：一条 `[overlay] setPosition: <extId>/<id> …`；被钳时含钳前钳后坐标（`请求(x,y) 钳制后(x',y')`，`:652-657`）。
- 门禁：`test/overlay-window.test.ts` 的「主进程 · setPosition」（越权/非法坐标/钳位边界/不存在/已销毁/属性不变/连续两次移动）。

#### 消息桥（overlay 页面 ↔ 扩展入口）

overlay 页面里**没有 `api` 对象**（扩展入口只跑在主窗口），要用宿主能力就复用**既有**的 `api.app.onMessage` 桥（见上节；路由按 `overlayId` 找所属扩展）。

- **查询串契约（五个参数，名字与顺序固定）**：`obox-window=overlay&extId=<扩展id>&overlayId=<overlay id>&appId=<overlay id>&url=<encodeURIComponent(扩展页URL)>`（纯函数 `overlayQuery`，`src/main/appWindow.ts:364-381`）。
  - `appId` **为什么填 overlayId**：消息桥按 appId 路由（先查卡片、未命中按 overlayId 查 `overlayOwners`），页面把自己的 overlayId 当 appId 原样发即可，外壳转发代码几乎不用改；
  - `url` **为什么要带**：preload 只桥接 overlay 四方法（没有一个 IPC 面可查页面地址），overlay 又不进 `appStore`（拿不到卡片注册的 url），只能随查询串下发。
- **url 双重校验（防御纵深，两处同判据、不得单边放宽）**：主进程 `isOverlayUrlInsideExtension`（`src/main/appWindow.ts:260-286`）与外壳 `isOverlayUrlAllowed`（`src/renderer/src/AppWindow.vue:66-85`）判据**完全一致**：① 协议必须是 `app:`（http/file/相对路径一律拒）；② hostname 必须是 `app://` 的三个合法 host 之一 —— `extensions`（用户扩展）/ `builtin`（内置扩展）/ `debug`（`--debug-extension` 调试扩展）；③ 路径首段必须等于**调用方扩展 id**；④ 首段之后**必须有子路径**（`app://extensions/<id>/` 是目录本身，拒）；⑤ 含 `..` 一律拒。
- **非法 url 的后果**：主进程侧 `create` 直接拒绝（`ok:false` + 中文原因）；即便查询串被手工构造绕过来，外壳也**不加载 iframe、渲染空白**（透明窗体直接透出桌面，连空态提示都不画——空态文字也是像素）并 `console.warn` 一条 `[overlay] 拒绝非法 url: …`，该日志经 `console-message` 转发进主进程终端（前缀 `[child-renderer:warning]`，`src/main/appWindow.ts:482-491`）。
- **overlay 的 iframe 只有 url 型**：不走 `srcdoc` 注入，且 `:key` 恒定（`overlayUrl` 是不变常量）⇒ **永不因主题切换重渲染**，页面动画/状态不被打断（`src/renderer/src/AppWindow.vue:137-155`）。
- **overlay 不参与 `api.ui` 模态框转发**：主进程 `ui.ts` 的 `isChild` 判定按 `obox-window=app` 命中，overlay 不命中 ⇒ `api.ui.showForm` 一类回**主窗口**本地渲染（`{ local: true }`）。这是**预期取舍**而不是 bug（overlay 页面本身没有 api 对象、也开不了模态框，`src/renderer/src/AppWindow.vue:307-313`、`src/renderer/src/main.ts:18-19`）。
- **60s 请求超时（overlay 复用）**：`app:extension-message` 桥的超时仍是 **60s**（`src/main/appWindow.ts:185-193`；`60_000` 这个值全文件只设定在这一处），overlay 走同一条逻辑。因此扩展若用**长轮询 hold**（入口 hold 到状态变化或超时再 reply）做"入口 → 页面"的状态同步，**hold 必须小于 60s**（宠物扩展用 25s，`extensions/pet/lib/constants.js:38-40`，其 `test/bridge.test.js:131-133` 把"`SUBSCRIBE_HOLD_MS` < `HOST_REQUEST_TIMEOUT_MS`"钉成断言）。`destroy` 时该窗口的 pending 请求由 `flushPendingReplies` **立即**以「overlay 窗体已销毁」结算，不用空等 60s（`:162-170,475-480`）。

#### 透明窗体的五处绘制点（宿主外壳侧）

透明 overlay 要"完全透出桌面"，宿主侧一共改了**五处**，任一处漏改都会得到不透明窗体（排查清单见 [troubleshooting.md 第 34 条](troubleshooting.md#34-透明-overlay-窗体看起来不透明)）：

| #   | 位置                                                                                                     | 内容                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1/5 | 主进程窗体参数（`src/main/appWindow.ts:429-441`）                                                          | `transparent:true` + `backgroundColor:'#00000000'`，并关掉 `hasShadow` / `thickFrame` / `roundedCorners`                     |
| 2/5 | `src/renderer/src/AppWindow.vue:287-314`                                                                   | overlay 模式**不渲染** `<TitleBar>` 与 `<PromptHost>`（任何不透明像素都会破坏"完全透出桌面"，模态遮罩同理）                   |
| 3/5 | `src/renderer/src/AppWindow.vue:336-345`                                                                   | 根 class `.app-window--overlay` 下 `.app-window` / `.app-window-content` 的 `var(--bg)` 背景置 `transparent`                 |
| 4/5 | 同上                                                                                                       | `.app-frame` 的**白底覆盖**为 `transparent`——最容易漏的一处：iframe 默认白底会把内容糊成白色矩形                              |
| 5/5 | `src/renderer/src/assets/main.css:53-61` + `src/renderer/src/AppWindow.vue:1-17`                            | 全局 `body { background: var(--bg) }` 对**每个窗口**都生效 ⇒ 用 `html.obox-overlay` 规则把 html/body 就地置透明；class 由 SFC **模块级 script** 在**首帧前**挂上（等挂载再改会闪一块底色） |

- 五处都由 `isOverlay` 单一开关隔离，**App 卡片子窗口的基础样式逐字保留**（回归约束；门禁 `test/overlay-window.test.ts` 的「外壳 · 五处透明改动」，含"卡片模式基础样式逐字保留"一条）。
- **已实机验证**：卡 01 证据 §1 —— 判据点取色 `maxdiff=0`（≤ 2/255），窗体区域完全透出桌面壁纸；§5 的两组反向对照（`transparent:false`）证明该判据有区分力。证据文件：`extensions/pet/openspec/changes/pet-desktop-companion/notes/evidence/overlay-feasibility.md`。
- 引用设计证据链时可指向宠物扩展的 design D-11（`extensions/pet/openspec/changes/pet-desktop-companion/design.md`）。

#### 平台限制与已知取舍

- **打开 DevTools 时透明窗体会变不透明**（Electron 官方限制）⇒ 验收取色**必须不开 DevTools**。**未实机验证**（卡 01 证据 §6-6：只做了防御性守卫，未主动开 DevTools 复现）。
- **Windows 上透明依赖 DWM 合成**：被组策略关闭时退化为不透明。**未实机验证**（卡 01 证据 §6-5：该场景未测）。
- **`transparent` 创建后不可运行时切换**（Electron 限制）；同理透明窗**不可 resize**、Windows 下**不可最大化**，故宿主强制固定尺寸。**未实机验证**（卡 01 证据 §6-5：仅引用官方文档，未主动复测）。
- **全屏独占应用下 `alwaysOnTop` 窗体可能被遮挡**——平台行为，非宿主缺陷。**未实机验证**（卡 01 证据 §6-5）。`alwaysOnTop` 本身**已实机验证**（§3：`isAlwaysOnTop()=true` + 压在普通窗口之上的截图证据）；`skipTaskbar` **已实机验证但只有截图/目检证据**（§3：任务栏条目 11 → 11，同 app 的普通窗对照 11 → 12 → 11）。
- **鼠标穿透是整窗切换**：`setIgnoreMouseEvents(true, { forward: true })` 没有逐像素 alpha 穿透（Electron 无此能力）⇒ 关闭穿透期间，窗体**空白区也会捕获点击**（已知取舍，**已实机验证**：卡 01 证据 §2 记录 IGNORE_OFF 下点空白区得到 `target=body`）。
- **`forward:true` 对注入式合成输入间歇性不转发**（**已实机验证的负记录**：卡 01 证据 §2/§6-2，5 组合成扫掠中 2 组收到事件、3 组为 0；根因未查明，疑与本机虚拟显示/远控输入栈有关）⇒ 排查 hover 命中时先用**真实鼠标**或 `WindowFromPoint` 复核，别先怀疑宿主。穿透开关本身双向生效**已实机验证**（§2：IGNORE_ON 下窗内三点 `WindowFromPoint` = 桌面 `SysListView32/FolderView`，IGNORE_OFF 下 = 本窗 `Chrome_RenderWidgetHostHWND`）。
- **overlay 页面里 `alert` / `confirm` / `prompt` 无效**：iframe sandbox 无 `allow-modals`（`src/renderer/src/AppWindow.vue:298`），与 App 卡片子窗口同款，见 [troubleshooting.md 第 36 条](troubleshooting.md#36-overlay-里-alertconfirmprompt-无效)。
- 多显示器/混合 DPI 下"只用主显示器工作区"的行为**未实机验证**（卡 01 证据 §6-5：本机仅 1 个显示器、`scaleFactor=1`）。

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
    },
    {
      key: 'my-ext.dataDir',
      label: '数据根目录',
      // directory：值是**绝对路径**；点输入框或「浏览…」都弹系统目录选择器（输入框只读）
      // 空串 = 未选择（默认目录由扩展自行决定）
      type: 'directory',
      default: ''
    },
    {
      key: 'my-ext.migrationStatus',
      label: '浏览器数据迁移进度',
      // status：**只读**状态展示（无输入框/按钮），值由扩展经 api.settings.set 写入；
      // 值里含 \n 时按行渲染成列表，空值显示占位「（无）」
      type: 'status',
      // modal: true ⇒ 值**非空**时渲染成**不可关闭的等待模态框**（迁移没完不许操作设置页）；
      // 值空 ⇒ 什么都不渲染。default 必须为空串：模态框只看设置值，不看 default。
      modal: true,
      default: ''
    },
    {
      key: 'my-ext.syncProgress',
      label: '同步进度',
      // progress：**只读**进度条（宿主渲染条 + 右侧 {cur}/{max}，零可编辑控件）。
      // 值是**数字**，由扩展经 api.settings.set 写入；max 可选、缺省 100；
      // 声明了 description 也**不渲染**（进度行保持紧凑）
      type: 'progress',
      max: 100,
      default: 0
    }
  ]
})
// 读写设置值（统一设置存储，key 建议含扩展前缀；set 立即持久化并通知）
const v = api.settings.get('my-ext.interval', 30)
api.settings.set('my-ext.interval', 60)
// status/modal 字段的值就是扩展写进来的这条设置：宿主只渲染，不提供编辑控件
api.settings.set('my-ext.migrationStatus', '正在迁移：书签 3/8\n已完成：历史记录')
// 迁移结束：必须清空同一个键（写 ''）——这是等待模态框唯一的消失通路，忘了写用户就被永久挡住
api.settings.set('my-ext.migrationStatus', '')
// progress 字段同理：写**数字**（0..max），宿主只渲染；文本 {cur} 向下取整、条宽用未取整的真实比例
api.settings.set('my-ext.syncProgress', 42)
page.dispose() // 注销设置页
```

设置字段类型（`type`）与可选属性（`default` / `options` / `description` / `max` / `modal`）的**完整清单与逐类型契约见 [themes-settings.md](themes-settings.md#扩展设置页双通道)——它是主题与设置的唯一真相，本文件不复制副本**（类型定义在 `src/api/contributions.ts:106-150`）。扩展可用 `api.settings.set` 写状态键，供设置页的**只读**字段展示（宿主不弹任何编辑控件）：`status` 是只读文本（含 `\n` 按行渲染），`progress` 是只读进度条（值是数字，宿主渲染条 + `{cur}/{max}`，`max` 缺省 100，显示值向下取整而条宽用未取整比例，见 [themes-settings.md 的「`progress` 字段」](themes-settings.md#progress-字段只读进度条)）；`status` + `modal: true` 时值非空即弹**不可关闭的等待模态框**，扩展清空该键后模态框消失。

`directory`（目录选择）的契约：

- **值的语义**：**绝对路径字符串**；空串 / 未设置 = 未选择，**默认目录由扩展自行决定**（宿主不填默认值）。
- **交互**：设置页渲染为**只读文本框 + 「浏览…」按钮**，**点输入框或按钮都弹**系统目录选择器（`properties: ['openDirectory']`），选中后把绝对路径写回该设置项；**取消不改动**；打开失败（`ok: false`）会在字段下方显示错误。输入框是 `readonly`：**选目录是主要输入方式，路径不能手工输入/粘贴**（「浏览…」按钮保留，用于键盘可达 + 显式入口）。
- **宿主只负责"选目录"**：不校验该目录是否存在 / 是否可写 / 是否受扩展管理，扩展侧读取该值时须**自行校验**。
- **老宿主（≤ v1.0.8）**：这些版本的设置字段渲染链没有兜底分支（`v-if / v-else-if` 到 `select` 即止），`directory` 字段**不会渲染出任何控件**（label 仍在、内容为空）。需要老宿主上也可用，扩展应自行降级为 `text`。

`status`（只读状态展示）的契约：

- **只读**：宿主渲染成纯文本（无 `input` / `button` / `select`，也不接保存通路），用户**不能**在设置页改动它；值由扩展用 `api.settings.set(key, value)` 写入统一设置存储（`host.ts:467`），宿主只负责显示。
- **多行**：值里含 `\n` 时按行渲染为列表（首尾空行忽略、中间空行保留）；空值 / 全空白显示占位「（无）」。非字符串值按 `String(value)` 展示。
- **写后设置页立即刷新**：扩展写键与设置页读值落在**同一渲染进程的同一个 `stateStore`**（`api.settings.set` = `stateStore.setSetting`），`setSetting` 同步通知订阅者，设置页据此重渲染（`SettingsView.vue:322-325,565-570`、`core/state.ts:143-148`）——**不需要重进设置页**。
- **老宿主（≤ v1.0.8）**：与 `directory` 相同，渲染链无兜底分支 ⇒ `status` 字段不渲染任何控件（label 仍在、内容为空）。**认识 `directory` 但没有 `status` 分支的中间版本宿主**会把它按未知类型兜底成**可编辑文本框**（值仍取自同一设置存储，但用户误编辑会覆盖扩展写的状态）；需要兼容这类宿主时请自行降级或自绘视图。

`status` + `modal: true`（**不可关闭的等待模态框**）的契约：

- **何时显示**：值**非空**（去空白后有内容）⇒ 设置页渲染全屏遮罩 + 对话框（`role="dialog"` + `aria-modal="true"`），框内显示字段 `label` 与按行拆分的值；值**空**（未设置 / `''` / 全空白）⇒ **什么都不渲染**。判据只取**设置值**、**不**回退 `default`（`default` 请写 `''`）。
- **写入 / 清空**：扩展在任务开始时 `api.settings.set(key, '步骤 1\n步骤 2…')`（可反复覆盖刷新进度），任务结束时**必须** `api.settings.set(key, '')` —— 这是模态框**唯一**的消失通路（写 `undefined` 删键等效于空值）。
- **不可关闭**：没有关闭按钮、`Esc` 无效、点遮罩不关闭；遮罩覆盖整个视口并挡住背景的滚动与交互。宿主只做"初始聚焦"（对话框 `tabindex="-1"`），**不**提供完整 focus-trap。
- **扫全部设置页**：只要有任一 `modal` 字段的值非空就弹（切左树分区不会关掉它）；多个字段同时非空时取第一个。
- **老宿主（≤ v1.0.8）忽略 `modal`**：它是新增的**可选**属性，老宿主不认识也不会读——照旧按 `status` 渲染（≤ v1.0.8 连 `status` 都不认识 ⇒ 不渲染任何控件），既不报错也不崩，只是**不弹模态框**。需要老宿主上也有反馈时自行降级。详见 `themes-settings.md` 的「`modal` 属性（等待模态框）」。

变更监听（≈VS Code `onDidChangeConfiguration`）：

```ts
const off = api.settings.onChanged((key) => {
  const v = api.settings.get('my-ext.interval', 30)
})
off.dispose()
```

> 回调参数是**变更的设置项 key**（如 `my-ext.interval`）；无具体 key 的场景（如语言切换）传空字符串（`host.ts:469-470`）。监听者仍可用 `api.settings.get` 读取当前值。

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
// { enabled, url, ignoreSSL?, noProxy? }   ← 1.0.12 起：**单一代理 URL**
// 例：'http://127.0.0.1:7890' / 'https://proxy:8443' / 'socks5://127.0.0.1:1080' /
//     'http://user:pass@host:1080'；空串 = 直连
```

obox 主进程的网络请求（更新下载等）自动使用该代理；内置扩展经 `api.proxy.get()` 读取并应用；用户扩展在宿主模式下由 `api.net.fetch` **自动继承同一份配置**，不需要自己读。

> **形态迁移（1.0.12 起，用户裁定"单一 URL"）**：设置里存的是一个 URL（`http://127.0.0.1:7890`、`socks5://…`、可含 `user:pass@`），不再是 host/port/username/password 四栏。**旧值自动迁移**：读到 1.0.11 及更早的 `{enabled,host,port,username,password,...}` 时会拼成 `http://[user:pass@]host[:port]`，设置不丢。迁移实现在 `src/shared/proxyConfig.ts`；URL 解析与规则串派生在 `src/main/proxy.ts`。
>
> **代理如何生效——两条链路两种机制**（别按其中一条的机制排查另一条）：
>
> - **主进程 / 渲染侧**（内置扩展的联网、electron-updater 的检查与下载）：在**发请求的 session** 上应用（`src/main/proxy.ts` 的 `applyProxyToSession`）——`setProxy`（URL → `proxyRules`，`noProxy` → `proxyBypassRules`；未启用 / 空 URL → `mode:'direct'`）与 `setCertificateVerifyProc`（`ignoreSSL` → 放行全部证书），同一份配置同时应用到扩展联网 session（`obox-net`）与 electron-updater session，配置指纹未变则不重复调用。
> - **宿主进程**（用户扩展的 `api.net.fetch`）：宿主没有 Electron API、也没有 Chromium session，因此**在宿主内自行应用**——配置先向 main 要（宿主内部 RPC `host.proxyConfig`），**读不到或通道未接线时回落环境变量**（`HTTPS_PROXY` > `HTTP_PROXY` > `ALL_PROXY`，另认 `NO_PROXY` / `NODE_TLS_REJECT_UNAUTHORIZED`）。请求走 Node `http`/`https`：**http 目标用代理的绝对 URI 形式**，**https 目标走 CONNECT 隧道 + `tls.connect({ rejectUnauthorized: !ignoreSSL })`**；默认 30s 超时、响应体上限 8MB、最多跟随 5 次重定向。因此代理与 `ignoreSSL` **真实作用于请求**，两条链路也不会互相覆盖。
>
> **账号密码进不了规则串**（Chromium 的 `proxyRules` 语法没有 userinfo 位）：认证凭据只从 URL 的 `user:pass@` 解析出来，主进程侧走 session 的 **login 事件**回填——更新下载经 `autoUpdater.on('login')`（`src/main/updater.ts:121-130`）生效；宿主侧直接把 `Proxy-Authorization` 头写进 CONNECT / 绝对 URI 请求。`api.net.fetch` **不支持逐请求凭据**（见 `docs/update-and-release-verification.md` 第 2 节）。
>
> **环境变量只是兜底，不是配置手段**：主进程链路（Chromium session）**完全不读**环境变量；宿主链路只在"拿不到 main 的配置"时才读，并会 warn 一次。所以改 `HTTP_PROXY` 不会覆盖设置-网络里的值，也不要靠它配代理——要改代理请改设置-网络。
>
> **代理相关的已知降级（宿主侧，逐条来自技术债）**：
>
> - `proxy.get()` 是**同步**签名而 RPC 是异步的 ⇒ 宿主读的是**快照**，默认 **1 秒 TTL**（过期后后台刷新）。语义是"最多旧 1 秒"，不再是 v1 的"每次读都是最新"；
> - 只支持 **http / https 代理**：填 `socks5://…` 时 `api.net.fetch` **明确报错**（"宿主进程暂不支持 socks 代理…，请在设置-网络里改用 http 代理"），不会静默直连；
> - `noProxy` **不支持 CIDR**（`10.0.0.0/8` 这种写法不生效），只支持 `*` / `example.com` / `.example.com` / `*.example.com` / `example.com:8080`。

### timer（全局定时器，秒粒度，不受后台节流）

宿主级定时器跑在**扩展自己所在的运行时进程**里，两条路径都不在渲染进程 ⇒ 不受后台节流影响（窗口最小化/不可见时渲染进程的 `setTimeout` 会被节流到 1s 粒度）。用户扩展（宿主模式）由 Extension Host Process 的 Node 定时器实现；内置扩展走主进程的宿主级定时器。**间隔为整数秒（≥1s）**；同 id 重复设置会重置；扩展停用/卸载时宿主自动清理全部定时器。

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

- 回调在**扩展自己的上下文**执行（用户扩展 = 宿主进程；内置扩展 = 渲染进程），**无 payload**（纯"到点了"），需要数据的扩展在回调里自行查询
- 定时器 id 在**扩展内**唯一即可（内部 key = `<扩展id>:<id>`，跨扩展自动隔离）
- `seconds` 必须是 **≥1 的整数**。**上限 86400（1 天）只在内置扩展那条路径上校验**（`src/main/timer.ts`）；宿主路径只校验"≥1 的整数"，所以**不要写超大值**——`seconds * 1000` 超过 2³¹−1 时 Node 会把延时钳成 1ms，`setInterval` 会退化成"每毫秒一次"的事件风暴
- **非法 `seconds` 的失败形态两条路径不同**：宿主模式**抛 `Error`**（`timer.setTimeout 的 seconds 必须是 ≥1 的整数（秒，宿主 timer 为秒粒度）`）；渲染进程模式是**静默失败**——主进程只回 `{ok:false, error}`，宿主侧用 `void` 丢弃该结果，既不抛错也不提示，定时器**不会建立**、回调永不触发

### sqlite（数据库，node:sqlite 内置驱动）

宿主内置 SQLite（Node 22 `node:sqlite`，**零依赖**）。`open(name)` 必须传**相对路径**（拒绝绝对路径/`..`/盘符），解析到**扩展自己的数据目录** `userData/extensions/<扩展id>/data/<name>`（宿主自动建目录）——扩展拿不到磁盘路径，数据天然按扩展隔离。相对路径可含子目录（如 `sub/a.db`，Windows 上写 `/` 亦可）；**不同子目录下的同名库互不干扰**（列类型元数据按库路径隔离）。

> **SQL 限制**：`exec` / `query` 会拒绝 `ATTACH` / `DETACH` / `VACUUM` / `PRAGMA` / `load_extension`——这些语句能读写库外文件或加载外部代码，会绕过"仅限扩展 data 目录"的封装。两者的失败形态不同：`exec` **原样返回** `{ ok:false, error:'不允许的 SQL 语句：…' }`，`query` **抛 `Error`**。常规 `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`CREATE`/`ALTER`/`WITH` 等不受影响。

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
- 除 `exec` 与 `close` 外，所有方法的失败都是**抛 `Error`**（宿主把内部的 `{ok:false}` 转成抛错）；`exec` 走另一条路——**原样返回** `{ ok:false, error }`（见上）；`close()` 不经抛错通路（主进程侧是无返回值句柄关闭），因此对不存在的库 `close()` 静默无操作、**不会抛错**
- 全部方法 `async`；扩展停用/卸载时宿主自动关闭其数据库连接（也可手动 `close()`）
- **宿主模式下这不是安全边界**：`import { DatabaseSync } from 'node:sqlite'` 可以自己开任意库、执行任意 SQL。`api.sqlite` 的价值是"按扩展隔离的数据目录 + 自动建表 + 表集合操作"，不是沙箱
- **数据目录的生命周期**：库文件在 `<扩展>/data/<name>.db`（安装态即 `userData/extensions/<扩展id>/data/`）；**覆盖安装（升级）时宿主保留 `data/`**，所以数据不会因升级丢失；**卸载时 `data/` 随扩展目录一起删除**。因此打包时不要把 `data/` 放进 `.oix`——宿主会直接拒收（见 `docs/extension-api/guides-user.md` §6「打包 `.oix`」）

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
- **已知降级（宿主模式）**：宿主发起的通知**暂不遵循「设置-通知」里的逐扩展开关**——那份开关状态在渲染侧（`stateStore`），main 与宿主进程都读不到，因此即使某个扩展在设置里被关掉，它在宿主里调用 `api.notification.show` 仍会弹出。等设置状态交给宿主（或由渲染侧代发）后消除；内置扩展（渲染侧）不受影响，开关照旧生效

### net（网络请求）

**内置扩展**：渲染进程的 CSP（`default-src 'self' app:`）禁止直接 `fetch` 外部网络，联网必须走 `api.net.fetch`（主进程经 Chromium session 发请求）。**用户扩展（宿主模式）**：宿主有完整 Node，你本来就能自己 `fetch` / 用 `node:http`，`api.net.fetch` 的价值是**自动继承设置-网络里的代理与 `ignoreSSL`** 并把响应按 Content-Type 解析好。

`api.net.fetch` 的契约两条路径一致：默认 **30s 超时**、响应体上限 **8MB**、最多跟随 **5 次重定向**：

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

代理与 `ignoreSSL` 的作用方式见上方 `proxy` 一节——**两条链路两种机制**：内置扩展走 Chromium session（主进程 `setProxy` / `setCertificateVerifyProc`）；用户扩展由**宿主进程自行应用**（`host.proxyConfig` 取配置 → http 走绝对 URI / https 走 CONNECT 隧道 + `rejectUnauthorized`；取不到配置时才回落环境变量）。**socks 代理在宿主侧会明确报错**，`noProxy` 不支持 CIDR。

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

### dialog.openDirectory（选**目录**：`showOpenDialog` 的 `properties`）

`showOpenDialog` 的 `opts` 多了一个可选 `properties`（`DialogProperty[]`）——**不传 ⇒ `['openFile']`，即既有行为逐字不变**。要弹**文件夹**选择框：

```ts
const r = await api.dialog.showOpenDialog({ title: '选择目录', properties: ['openDirectory'] })
if (r.ok && !r.canceled && r.filePaths?.[0]) {
  const picked = r.filePaths[0] // 目录模式下这里是**一个目录**（不是文件）
}
```

| 规则 | 说明 |
| --- | --- |
| 取值 | `properties?: Array<'openFile' \| 'openDirectory' \| 'multiSelections'>`；**未知值被宿主忽略，不抛错** |
| 互斥 | `openDirectory` 与 `openFile` **互斥**；同时传时按**目录模式**归一（只保留 `openDirectory` + 可选 `multiSelections`） |
| `filters` | **目录模式下被丢弃**（Electron 不对目录应用过滤器）；只对文件模式生效 |
| 多选 | `properties: ['openDirectory','multiSelections']`，或旧字段 `multiSelect: true`（**继续兼容**，与目录模式可叠加） |
| 返回值 | **形状完全不变**：仍是 `{ ok, filePaths?, canceled?, error? }`——目录选择与文件选择**共用 `filePaths`**，没有新增字段（老扩展零感知） |
| 取消 | `canceled: true`；`filePaths` 为空但 `canceled !== true` 也按取消处理 |
| 边界 | 宿主**只负责弹对框**，不做任何路径合法性校验；根的合法性与安全边界**永远在扩展/助手侧** |
| `api.fs` | 选到的是**外部路径** ⇒ **不能**用 `api.fs` 读写（它只覆盖扩展自己的 data 目录，见下节） |

> ⚠️ **老宿主会忽略 `properties`**（旧版本把 `properties` 硬编码成 `['openFile']`）⇒ 你仍然只拿到 `filePaths`，但里面是**文件**。扩展**必须自证"选到的确实是目录"**，不能假定新字段生效：把路径交给自己的 JS 助手/Python 侧判定 `isDirectory`（`fs.stat` 之类），是文件就取其父目录并给出诚实提示。**不要**用 obox 版本号字符串判断能力；判定凭据只有"返回值/它到底是不是目录"。详见 [troubleshooting.md 第 32 节](troubleshooting.md#32-扩展要选文件夹弹出的却是选文件框)。

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

`api.theme` **只提供主题 id**，**不提供 token 值**（这是有意的边界，见 ADR-0022）。App 子窗口里的页面**没有** `api` 对象，取 token 请用上面 `app.register` 小节的**主题下发协议**（`obox-theme` 推送，详见 [themes-settings.md](themes-settings.md#app-子窗口url-型主题下发协议)）。

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

- 除 `watch` 的超限错误外，所有失败都是**抛 `Error`**（宿主把主进程的 `{ok:false}` 转成 `throw new Error(...)`，`host.ts:669-675`）
- `watch`：**单扩展并发监听上限 16**（`src/main/fs.ts:25`）；超限时主进程返回 `{ok:false, error:'监听数量已达上限（16）'}`（`src/main/fs.ts:154-156`），宿主**转成抛错**（`host.ts:692-699`）。同 id 重复 `watch` 会先关掉旧监听、不占新增额度（`src/main/fs.ts:151-153`）
- 监听目录被删 / 权限变化 → 宿主记录并自动关闭该监听（`src/main/fs.ts:166-170`），扩展侧此后收不到事件（不会崩主进程）
- 扩展停用/卸载时宿主自动关闭全部监听
- `api.fs` 只能读写扩展自己的 data 目录；`api.dialog` 选到的外部路径**不能**用 `api.fs` 读写
- **宿主模式下这不是安全边界**：宿主进程有完整 Node，`import fs from 'node:fs'` 就能读写任意路径。`api.fs` 的"仅 data 目录"是**能力封装**（防误用、给数据一个稳定落点），不是沙箱；扩展整体仍是受信代码（ADR-0015）

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

- channel 的方法就这 5 个：`append(text)` / `appendLine(text)` / `show()` / `clear()` / `dispose()`（`src/api/types.ts:86-93`）
- **没有 `api.output.append(...)`**：`append` 只在 `createChannel(name)` 返回的 channel 上（`src/api/types.ts:608-611`）

### secrets（密钥存储，safeStorage 加密）

token/凭据安全存储（主进程 safeStorage 加密存 userData；**不要**用 Memento 存密钥）：

```ts
await api.secrets.set('github_token', 'ghp_xxx')
const token = await api.secrets.get('github_token') // undefined = 未设置
await api.secrets.delete('github_token')
```

> 系统加密不可用（或 Linux 上后端回落为明文 `basic_text`）时，`api.secrets.*` **抛 `Error`**（`host.ts:545-559`），而不是明文落盘（fail-closed），也不是返回错误对象——调用方需 `try/catch` 并把该功能视为不可用。

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
- 节点可选 `icon`（SVG 字符串，`src/api/types.ts:106-120`）

### api.ipc（与外部进程的端口无关 IPC，见 ADR-0016）

与**其它语言写的进程**双向通信。**不使用任何 TCP 端口**（不会端口冲突、不触发防火墙），传输只有两种：

- `stdio`：宿主**帮你拉起**子进程，用它的 stdin/stdout 通信、stderr 作日志；
- `pipe`：连接**已在运行**的进程（Windows 命名管道 / POSIX Unix 域套接字），端点由宿主按「扩展 id + 通道名」推导。

协议是 **JSON-RPC 2.0**（请求/响应/错误/通知），分帧默认 `Content-Length`（二进制安全），也可 `ndjson`。

> **`Content-Length` 按字节计，不是字符数**——这是 sidecar 侧最容易踩的一处：宿主写的是 `Content-Length: <payload 的 UTF-8 字节数>`（`Buffer.length`），一个中文字符算 **3 字节**。你的对端若按"字符数/码点数"算长度，读到一半就会被截断或吞掉下一帧，表现是**中文乱码 / 偶发丢帧 / `protocol-error`**。分帧实现见 `src/main/ipcCore.ts`（宿主与主进程共用同一份）。

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

// 2b) 断线自动重连（issue #44）：只对 **pipe** 的**运行时**声明生效
await api.ipc.connect({
  id: 'bus',
  transport: 'pipe',
  autoReconnect: { retries: 5, backoffMs: 250 } // 缺省 retries=3 / backoffMs=250
})
api.ipc.onReconnect('bus', async ({ attempts }) => {
  console.log(`第 ${attempts} 次尝试连上了，重新握手`)
  await api.ipc.request('bus', 'hello', { proto: 2 }) // 协议层状态已归零，自行握手
})

// 3) 请求 / 通知
const sum = await api.ipc.request('worker', 'sum', { a: 1, b: 2 }) // → 3
await api.ipc.notify('worker', 'log', { text: 'hello' })

// 3b) 服务端：宿主 listen 一个端点并接受**多条**连接（issue #43；对端是拨号方）
await api.ipc.listen({ id: 'svc', transport: 'pipe' }) // 端点 = \\.\pipe\obox-<扩展id>-svc（POSIX 为 <userData>/ipc/obox-<扩展id>-svc.sock）
api.ipc.onConnection('svc', (connectionId) => console.log('连入', connectionId))
api.ipc.onDisconnect('svc', (connectionId, err) => console.log('断开', connectionId, err.code))
const pong = await api.ipc.request('svc', 'ping', {}, { connectionId: 1 }) // 定向到某条连接
await api.ipc.broadcast('svc', 'tick', { n: 1 }) // 向所有连接各发一条**通知**（不收集回包）
await api.ipc.close('svc') // 停止监听并断开它的**全部**连接

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

**JS 助手的运行时语义**：`program` 以 `.js` / `.cjs` / `.mjs` 结尾时，宿主用**宿主进程自带的 Node**（`process.execPath`）运行它，并给子进程注入 `ELECTRON_RUN_AS_NODE=1`（`resolveStdioSpawn`，宿主与主进程共用同一份实现）——助手是**纯 Node 程序**，不是 Electron 应用（`process.versions.electron` 仍有值，用的还是同一个可执行文件，只是按 Node 模式启动）。**拉子进程的那一侧**：宿主模式由 Extension Host Process 自己 spawn（它有 `child_process`），渲染进程模式由主进程 spawn；两种模式下 stdin/stdout 归属、cwd 与 env 白名单一致。

- **可用 `node:*` 内置模块**：`node:fs` / `node:path` / `node:child_process`…都行，**包括 `node:sqlite`**——助手可以**自己建库、自己读写**，不必绕经 `api.sqlite`（`api.*` 那条路按扩展隔离数据目录；助手这条路就是普通 Node 进程）
- **stdin / stdout 正常工作**：宿主按声明的 `framing` 把请求写进 stdin，助手从 stdout 回包即可；日志一律写 **stderr**（stdout 只放协议数据）
- **Node 版本 = 宿主内置 Electron 的 Node**（助手内 `process.versions.node` 可查，与 `api.env.nodeVersion` 同一份运行时）：宿主**不额外安装 Node**，助手也不要假设系统 PATH 上有独立的 `node`
- **cwd = 扩展源目录下的 `data/`**：安装态是 `userData/extensions/<扩展id>/data`，调试态是**调试目录的 `data/`**（见下表「stdio 的 cwd」）

| 项             | 说明                                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 限额           | 每扩展最多 **4 条通道**（`src/main/ipc.ts:43`；**server 与 client 共用同一名字空间**，一条 server 只占 1 条）；**单个 server 最多 16 条连接**（`src/main/ipc.ts:45`，连接**不计入** 4 条上限，第 17 条被拒）；**每通道并发请求上限 64**（`src/main/ipcCore.ts:27`，超出抛 `too-many-requests`）；单条消息上限 **8MB**（`src/main/ipcCore.ts:23`）；请求默认 **30s** 超时（`src/main/ipcCore.ts:25`，`request(..., { timeoutMs })` 可覆盖） |
| 错误码         | `invalid-declaration` / `connect-failed` / `not-connected` / `protocol-error` / `timeout` / `cancelled` / `message-too-large` / `too-many-requests` / `too-many-channels` / `too-many-connections` / `peer-crashed` / `channel-closed`（失败一律以错误码抛出，不静默挂起；自动重连**不新增**错误码：重连窗口期复用 `not-connected`，放弃后复用断连那次的 `peer-crashed` + 后续 `not-connected`）                                                     |
| 生命周期       | 通道由扩展**显式**打开；扩展停用/卸载/重载、窗口关闭、应用退出时宿主统一断开（并终止由宿主拉起的子进程；server 则停止监听并断开全部连接）                                                                                                                                                              |
| 任何语言可接入 | 对端只要会读写标准输入输出（stdio）或连上套接字（pipe）即可；**不需要开端口**，也不需要网络配置                                                                                                                                                                                                       |
| stdio 的 cwd   | 宿主拉起对端时 **cwd = `<扩展>/data`**（`src/main/ipc.ts:262`，不是扩展根目录）：`program` 相对**扩展目录**解析，但 `args` 里若写相对路径要按 cwd 算（例如脚本在 `<扩展>/scripts/x.py` 时写 `['../scripts/x.py']`；E2E 实测踩过，写 `['scripts/x.py']` 会让对端立刻退出并表现为 `not-connected`） |
| 清单声明       | 在 `contributes.ipcChannels` 静态声明后，代码里只写 `api.ipc.connect('<通道id>')`；声明**不自动连接**，非法声明会让清单无效（见 manifest-reference）                                                                                                                                                  |
| 信任边界       | 与 ADR-0015 一致：这是**能力封装而非安全边界**——用户扩展跑在 Extension Host Process（与 UI 不同进程），但仍是**受信代码、无沙箱**；宿主模式下有完整 Node，`child_process` 本来就能起任意进程                                                                                                                                                                                                                      |

#### api.ipc 服务端（多连接，issue #43）

宿主也可以当**服务端**：`listen` 一个 pipe 端点，接受**多条**对端连接。适合"扩展起一个本地服务，多个外部进程/工具连进来"的场景。

```ts
await api.ipc.listen({ id: 'svc', transport: 'pipe', framing: 'content-length' })

api.ipc.onConnection('svc', (connectionId) => console.log('连入', connectionId))
api.ipc.onDisconnect('svc', (connectionId, err) => console.log('断开', connectionId, err.code))

api.ipc.onRequest('svc', (method, params) => ({ echo: params })) // client / server 通道都可用
const pong = await api.ipc.request('svc', 'ping', {}, { connectionId }) // **必须**指定 connectionId
api.ipc.notify('svc', 'log', { t: 1 }, { connectionId })
await api.ipc.broadcast('svc', 'tick', { n: 1 }) // 全部连接各收一条通知

for (const name of await api.ipc.channels()) console.log(name) // server 名也在其中
await api.ipc.close('svc') // 停止监听 + 断开全部连接；不存在时静默成功、可重复调用
```

约束与语义（逐条都有测试锁死，见 `test/ipc-server.test.ts`）：

- **只支持 pipe**：`listen({ transport: 'stdio' })` 报 `invalid-declaration`（服务端不能拉起子进程；stdio 请用 `connect`）。
- **名字唯一且与 client 通道共用命名空间**：同名再 `connect` 或 `listen` 都报 `invalid-declaration`；一条 server 只占"每扩展 4 条通道"里的 1 条。
- **端点不带随机后缀**：Windows `\\.\pipe\obox-<扩展id>-<通道名>`；POSIX `<userData>/ipc/obox-<扩展id>-<通道名>.sock`。对端必须按这个约定拨号。
- **`connectionId`**：进程内单调递增的**正数**，从 1 起、**永不复用**（同名 server 关闭后重建也不复用）；在 `(扩展id, 通道名, connectionId)` 三元组内解释，可直接打印进日志。宿主**不自动重连**服务端连接——对端回来就是一次新连入、拿一个新 ID（`autoReconnect` 只作用于 **client 通道**，见下方「api.ipc 自动重连」）。
- **定向 vs 广播**：server 名字下 `request` / `notify` **必须**给 `opts.connectionId`（省略报 `invalid-declaration`，避免"静默挑一条"的误投）；指向已断开/不存在的连接报 `not-connected`。反过来，**client 通道**传 `connectionId` 也报 `invalid-declaration`。
  **广播是通知语义**：`broadcast(name, method, params)` 不收集回包（返回 `Promise<void>`），已断开的连接跳过，**无连接时静默成功**；要"定向请求"请用 `request(..., { connectionId })`。
- **连接上限 16**：第 17 条由宿主回一条 `{jsonrpc:'2.0', id:null, error:{code:-32603, message:'[too-many-connections] …'}}`（用该 server 声明的 `framing` 编码）后关闭，**不触发** `onConnection` / `onDisconnect`，已建立的 16 条不受影响。该错误码只对**对端**可见（扩展侧不触发事件）。
- **断开与在途请求**：每条已被接受的连接**恰好触发一次** `onDisconnect(connectionId, { code, message })`；`code` 为 `peer-crashed`（对端崩溃/断开）、`protocol-error`（对端发非法帧）、`channel-closed`（扩展 `close()` / 扩展停用 / 应用退出）。断开瞬间该连接上**双向**的在途请求立即以断因码失败，**绝不重放**到后续新连接；同一 server 的其它连接完全不受影响。
- **`close(name)` 统一语义**：按名字关闭该名字下的**一切**（client 通道或 server），**幂等**，都不存在时静默成功。关闭时该通道的收尾事件**照常投递**（client 通道 → `onClose{channel-closed}`；server 通道 → 每条活动连接各一次 `onDisconnect{channel-closed}`），投递完成后该名字上的**监听器订阅一并作废**——同名通道再次 `listen` / `connect` 后要**重新注册** `onRequest` / `onClose` / `onDisconnect` 等处理器（否则收不到任何事件）。
- **每连接独立会话（已知限制，issue #43 D2）**：`onRequest(name, handler)` **按通道名寻址**，回调签名只有 `(method, params)`——**不携带 `connectionId`**（回包由宿主按内部 requestId 路由，响应方向不需要 ID）。因此服务端侧**拿不到请求来自哪条连接**：需要按连接分派时只能在 `onConnection` / `onDisconnect` 里自行维护映射（例如按连入顺序排队 + 每条连接一个应用层会话 id，请求参数或回包里带上它）。`{ connectionId }` 只在**扩展主动发起**的 `request` / `notify` 上可用。
- **同一通道名的多个 handler：只生效最先注册的那个**（不是"后面的覆盖前面的"）：宿主派发时取该通道名**插入序第一个** handler，后注册的既不生效也不覆盖前一个；只有当前一个被 `dispose()` 之后，下一个才顶上。所以每个通道名**只注册一个**请求处理器；要换实现请先 `dispose()` 旧的（`const d = api.ipc.onRequest(...)` → `d.dispose()`）。多实例子进程各自一个通道名，或改用 `onNotification` / `request` 分派，都是比"同名单挂多个 handler"更可靠的写法。
- **平台差异**：
  - **Windows**：命名管道在内核命名空间、**无落盘文件** → 服务端不探测陈旧端点、不 `chmod`；
  - **POSIX**：`listen` 前会**试连探测**端点——连得上说明有活着的服务端 → 报 `connect-failed`（文案含"已被占用"）且**不删除**该文件；连不上（陈旧 `.sock`）→ `unlink` 后重新 `listen`；`listen` 成功后 `chmod 0600`；`close()` / 停用时 `unlink`。
- **能力边界**：服务端意味着"**任何同机进程**都能连上"（POSIX 的 `0600` 只能挡其它用户），**不做**对端身份校验（ADR-0015：能力封装不是安全边界）。
- **旧宿主兼容**：`api.ipc.listen` 是**新增**方法且 `apiVersion` 仍为 1，旧宿主上调用会得到 `TypeError`。请先做特性检测：
  ```ts
  if (typeof api.ipc.listen !== 'function') throw new Error('当前宿主版本不支持 pipe 服务端（需要 api.ipc.listen）')
  ```

#### api.ipc 自动重连（客户端通道，issue #44）

**默认不重连**（行为与以前逐字节一致）。让一条 **pipe** 通道在意外断线后由宿主自动重建：

> **验证状态（如实登记）**：重连语义的用例（`test/ipc-reconnect.test.ts`）覆盖的是**主进程**那条实现；**宿主进程侧** `pipe + autoReconnect` 的实现是照同一套控制器写的，但**尚无自动化用例**（技术债 #8）。用它做关键链路时请自行在真机上验一遍断线重连（拔对端 / 杀进程），不要只信文档。

```ts
await api.ipc.connect({ id: 'bus', transport: 'pipe', autoReconnect: { retries: 5, backoffMs: 250 } })

api.ipc.onClose('bus', (err) => console.log('断了', err.code))          // 意外断线：每个断连周期**恰好一次**
api.ipc.onReconnect('bus', async ({ attempts }) => {                  // 每次重连成功后一次
  console.log('连上了，共尝试', attempts)
  await api.ipc.request('bus', 'hello')                               // 协议层状态已归零：自行握手
})
```

> **`onClose` 的计数口径（别被"恰好一次"误导）**：`恰好一次` 只描述**一个意外断连周期**内部的
> 去重（第一次退避重试之前广播一次；用尽 `retries` 放弃时**不**再补一次）。你自己调用
> `api.ipc.close('bus')` 是**另一次**关闭：窗口期（含重连尝试在途）里它仍会按既有语义
> **额外补发一条 `close{code:'channel-closed'}`**——于是"一次意外断线 + 一次主动 close"
> 会看到 **2 条** `onClose`（先 `peer-crashed`，后 `channel-closed`）。这与**未启用重连**的通道
> 完全一致（那里也是"意外断线一次 + 主动 close 一次"），不是重连特有的额外事件。
> `test/ipc-reconnect.test.ts` 的 `第二个断连周期的窗口期内 close()` 用例把这条口径钉死。

**三条语义**（逐条都有测试锁死，见 `test/ipc-reconnect.test.ts`）：

| 时刻 | 你会看到什么 |
| --- | --- |
| **在途请求** | 断线瞬间该通道所有挂起请求**立即**以 `peer-crashed` 失败；**绝不重放**（也不会在重连后补发）——要重发就自己在 `onReconnect` 里做 |
| **重连期新请求** | `request` / `notify` 立即以 `not-connected` 失败（不排队、不延迟），文案含"正在重连"；`channels()` **仍含**该通道名 |
| **状态保留** | 通道名 / 声明 / `framing` / 重连策略保留并沿用；**协议层状态全部丢弃**（新通道、请求 id 从 1 重新开始、挂起表为空） |

**两种"不见了"必须分清**（只有这个判据，没有额外的失败事件）：

- `await api.ipc.channels()` **仍含**该通道名 = **正在重连**（此时请求报 `not-connected` + "正在重连"）；
- `channels()` **不含**该通道名 = **已放弃**（重试用尽；之后请求报既有的 `not-connected`）。
- 放弃时**不会**补发第二次 `onClose`（同一断连周期只有那一次），也不会触发 `onReconnect`。
  **注意与主动 `close()` 区分**：`api.ipc.close(name)` 无论在窗口期还是在途尝试期间都会**额外**
  补发一次 `close{channel-closed}`（见上方"`onClose` 的计数口径"）。

**配置与触发规则**：

| 项 | 值 |
| --- | --- |
| 缺省 | `retries = 3`、`backoffMs = 250` |
| 退避 | `250 → 500 → 1000 …`（×2）；**单次等待**封顶 **30000ms**；`retries` 本身**不封顶**（非负整数即可） |
| `retries: 0` | 等价于**关闭**自动重连（与不写该键同效） |
| `backoffMs: 0` | 合法 = 不等待（仍异步） |
| 触发 | **首次连接成功后**发生 `peer-crashed`（对端进程退出 / 套接字关闭） |
| **不触发** | `channel-closed`（你自己 `close()` / 扩展停用）、宿主清理、`protocol-error`（对端发非法帧，避免与坏对端无限拉锯）、**首次 `connect()` 失败**（仍抛 `connect-failed`，扩展自己决定要不要退避重试） |
| 只对 pipe | `connect({ transport: 'stdio', autoReconnect: … })` → `invalid-declaration`（文案提示"自行 `connect()` 或改用 pipe"）。stdio 场景请在 `onClose` 里自己退避重连：`onClose` → `setTimeout` → 重新 `connect()` |
| **只写在运行时对象里** | `autoReconnect` 只认 `connect({...})` 传的**运行时**声明对象；写进 manifest 的 `contributes.ipcChannels` **既不报错也不生效**（宿主会把这个键剥掉）。运行时对象上的非法值（负数 / 非整数 / 非对象）→ `invalid-declaration` |
| 服务端不适用 | `autoReconnect` 只作用于 **client 通道**；`listen` 的服务端连接断连只通知（`onDisconnect`），对端回来是新连接、新 `connectionId` |
| 并发（issue #44 整改） | 同一条通道**同一时刻最多一个**重连控制器在跑；一个**意外断连周期**内**不重复**广播 `close`；重连尝试**在途**时若本通道又断一次，该次尝试一律**自弃**（不挂传输、不触发任何事件、不留无人引用的连接），并交回**同一个**控制器按退避继续。宿主自检出口：`src/main/ipc.ts` 的 `reconnectControllerCount()`（与 `pendingForwardCount()` 同风格，仅供诊断/测试，**不经 preload 暴露**给扩展） |
| 重连期额度 | 窗口期**仍占** 1 条通道额度，因此此时不能再 `connect` 同名通道（会报"已打开"）；`close(name)` 在窗口期（含重连尝试**在途**时）**立即**取消剩余重试（幂等，之后不再有 `onReconnect`），并**额外**补发一条 `close{channel-closed}`（与那次 `peer-crashed` 各计一次） |

**旧宿主兼容**（新扩展 + 旧宿主）：旧宿主不认识 `autoReconnect`（走白名单校验，未知键静默忽略）→ 通道**照常打开**、只是**不会重连**；`api.ipc.onReconnect` 也不存在。请特性检测：

```ts
if (typeof api.ipc.onReconnect !== 'function') {
  // 旧宿主：自行在 onClose 里退避重连
}
```

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
| 依赖           | 依赖由扩展作者在打包时预置在 `<扩展>/python/Lib/site-packages`（随包替换）；用户自行装的库落在 `<扩展>/data/user-site`（升级保留）。**清单里的 `python.requirements` 已移除（issue #82）**：它从未被安装器传入、实际不可达，宿主不做"安装期装依赖"；旧清单残留该键只被忽略、不报错（`main/pythonCore.ts:84-110`）。**调试扩展**（`--debug-extension`）按**调试目录**找 `<扩展>/python/`，因此带运行时的扩展也能用调试方式开发（数据目录仍在 userData） |
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

## 宿主模式的降级与限制（技术债，逐条登记）

扩到宿主进程时，有些能力只能**降级实现**。这里逐条写清"降级成什么样、你该怎么绕"，避免它们悄悄变成长期方案（来源：`docs/extension-host-migration.md` 的技术债表）。

| # | 降级 / 限制 | 对你的影响 | 绕法 |
| --- | --- | --- | --- |
| 1 | **`main` → 宿主的事件是 250ms 轮询**（不是推送；协议还没有 main→host 的信封） | `api.update.onEvent`、通知点击等经 main 转发的事件**最多晚 250ms** | 事件驱动的地方按"可能延迟一个轮询周期"写，别依赖毫秒级时序；需要极实时就自己 `api.ipc` 起 sidecar |
| 2 | **`proxy.get()` 是 1 秒 TTL 的快照** | 改完设置-网络后立刻读，可能还是旧值 | 隔 >1s 再读，或直接信任 `api.net.fetch`（它会用最新配置） |
| 3 | **`net.fetch` 只支持 http / https 代理** | 填 `socks5://…` 会**明确报错**，不会静默直连 | 改用 http 代理；必须 socks 就自己起本地 http→socks 转发 |
| 4 | **`noProxy` 不支持 CIDR** | `10.0.0.0/8` 这类规则不生效 | 用域名/主机名规则，或让目标走直连（关掉代理） |
| 5 | **`api.ipc` 的 `Content-Length` 按字节计**（不是字符数） | 对端按字符数算长度时中文会乱码 / 丢帧 | 对端按 UTF-8 字节数编码（见 `api.ipc` 一节） |
| 6 | **宿主侧 `pipe + autoReconnect` 无自动化用例** | 断线重连的时序没被测试钉住 | 关键链路真机验一遍（杀对端），或自己在 `onClose` 里退避重连 |
| 7 | **宿主发起的通知不遵循「设置-通知」的逐扩展开关** | 用户在设置里关掉通知后，宿主扩展仍会弹 | **暂时没有绕法**：那份开关是渲染侧 `state` 里的数组（`notificationDisabledExtensions`），不是设置项，宿主与扩展都读不到。等它交给宿主后才恢复 |
| 8 | **`workspaceState` 与 `globalState` 真隔离**（v1 是同一份 store） | 靠"两者其实同一份"做的迁移逻辑会失效 | 需要共享就把同一个键显式写两处，或只用一个 |
| 9 | **`executeCommand` 执行不了内置扩展的命令** | `api.executeCommand('ext-manager.xxx')` 会 `command not found` | 内置能力请走对应 `api.*`（`api.ui` / `api.settings` 等），别去点内置扩展的命令 |
| 10 | **`on` / `emit` 不跨运行时** | 内置扩展收不到用户扩展的事件（反之亦然） | 用户扩展之间用事件；跨运行时的数据流请走贡献点 + 消息桥（`api.app.onMessage`） |
| 11 | **宿主扩展创建的 overlay 收不到 `api.app.onMessage`**（overlay→扩展的路由表由渲染侧 `api.overlay.create` 回填） | overlay 页面发来的消息会被判"扩展未注册消息处理器" | 需要双向通信时先用 `api.output` / `api.fs` 落盘或用 `api.ipc` pipe；这条退场前别把关键交互只压在 overlay 消息桥上 |

> 这张表只列**扩展作者看得见**的降级。宿主/渲染侧的接缝缺陷、内部实现细节不在本表（见迁移文档的技术债表）。

## 类型文件位置

- `src/api/`（聚合出口 `src/api/index.ts`）：`src/api/types.ts` = `ExtensionActivationApi` / `SqliteDb` / `OutputChannel` / `TreeItem`；`src/api/contributions.ts` = 贡献点类型；`src/api/manifest.ts` = `ExtensionManifest`；`src/api/registration.ts` = `AppRegistration`；`src/api/shared.ts` = `Memento` / `UpdateEvent` / `ProxyConfig` / `IpcChannelDeclaration`；`src/api/runtime.ts` = `ExtensionInfo` / `Disposable` / `ExtensionModule` 等
- 对话框类型（`DialogProperty` / `DialogOpenOptions` / `DialogOpenResult` / `DialogFilter`）**定义在 `src/shared/types.ts`**（主进程 / preload 类型 / 扩展 API **三处共用同一份**，避免签名漂移），由 `src/api/types.ts` 再导出 ⇒ 扩展照旧 `import type { DialogOpenOptions } from '<...>/api'` 即可（`src/api/types.ts` 的 `dialog` 段）
- overlay 类型（`OverlayAnchor` / `CreateOverlayRequest` / `OverlayResult`）**沿用同一先例，也定义在 `src/shared/types.ts:521-580`**（扩展 API 与主进程窗体实现共用一份契约，防签名漂移），由 `src/api/types.ts:14-32` 再导出 ⇒ 扩展 `import type { CreateOverlayRequest } from '<...>/api'` 即可；主进程侧的四个 IPC 方法（`overlayCreate` / `overlayDestroy` / `overlaySetMouseThrough` / `overlaySetPosition`）声明在同一份 `MainApi` 里（`src/shared/types.ts:338-367`），preload 桥在 `src/preload/index.ts:69-76`
- `src/renderer/src/core/types.ts` 是历史兼容入口（再导出 `src/api`，旧 import 零改动）；**新代码直接 import `src/api`**
- 扩展经相对路径导入类型，如内置扩展入口 `import type { ExtensionActivationApi } from '../../../../api'`
