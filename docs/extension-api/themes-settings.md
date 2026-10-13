# 主题与设置参考

> **本文件是 obox 主题与设置（主题 token、设置页字段、App 子窗口主题下发）的唯一真相，位置 `docs/extension-api/`**：仓库内其它文档一律引用本文件，不复制副本。

Obox 的主题与设置系统：主题由**主题扩展**提供（CSS 变量 token），设置由内置 `settings` 扩展管理。左侧树共八个分区：外观 / 通用 / 语言 / 快捷键 / 更新 / 网络 / 通知 / 扩展（`src/renderer/src/extensions/settings/SettingsView.vue:229-268`，`TreeKey` 定义见 `:21-29`）。

## 主题系统

### 机制

- 主题 = 主题扩展 `contributes.themes` 声明的 CSS 变量 token 组（`src/api/contributions.ts:63-70`）
- 宿主收集所有主题扩展的贡献（`src/renderer/src/core/host.ts:169`），设置"外观"节点下拉选择；选中后把 token `setProperty` 到 `document.documentElement`（`:root`）并持久化（`src/renderer/src/core/theme.ts:50-77`）。持久化值失效时缺省取 id 含 `dark` 的主题（`theme.ts:37-44`）
- 宿主 UI 组件用 `var(--token, fallback)` 引用 token，主题切换即时生效
- **每个渲染窗口各有一份 `:root`**：App 子窗口（`?obox-window=app`）启动时由 `host.start()` 收尾的 `applyCurrent()` 应用一次（`src/renderer/src/core/host.ts:952`）；主窗口此后切主题时，新快照经 `storage` 事件合并进子窗口（`src/renderer/src/core/state.ts` 的 `applyExternal`）并重新应用、再下发给 iframe（见下条与 ADR-0022）
- **App 子窗口的主题 token 投递（ADR-0022）分两条路**：
  1. **`srcdoc`（`html`）卡片**：宿主把当前 token 拼成 `<style>:root{…}</style>` 注入**同一份文档**（`src/renderer/src/AppWindow.vue` 的 `iframeSrcdoc`）。CSS 自定义属性不跨文档继承，`srcdoc` 能生效正因为它与宿主同文档；切主题时 iframe **重渲染**（`:key="srcdoc:<themeId>"`）。
  2. **`url` 卡片（新增）**：iframe 是 `app://extensions|debug/<id>/…`，与父文档**跨源** ⇒ `iframe.contentDocument` 恒为 `null`，宿主**注入不了** CSS/`<style>`，也继承不到变量。因此宿主在三个时机向 `iframe.contentWindow` **单向推送**消息（协议与载荷见下）：① iframe `load` 完成；② 主题变化；③ 收到子页面的 `obox-theme-request`。扩展侧把 `tokens` 逐条 `document.documentElement.style.setProperty(k, v)` 即跟随主题——**不再需要**用 `var(--token, fallback)` 的 fallback 当实际色值（兜底只用于"推送到达前/老宿主"的首帧）。
  - **`url` 型卡片切主题不再重渲染**：iframe 的 `:key` 是 `url:<url>`，与主题无关（表单里正在填的内容不会被清空）；`srcdoc` 型仍是 `srcdoc:<themeId>`，切主题重建。判据实现为纯函数 `appFrameKey`（`src/renderer/src/core/appTheme.ts`）。

### App 子窗口（`url` 型）主题下发协议

宿主 `postMessage` 的消息形状（实现在 `src/renderer/src/core/appTheme.ts` + `src/renderer/src/AppWindow.vue`）：

| 方向          | 消息                                                          | 触发                                                  |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| 宿主 → 子窗口 | `{ source:'obox-app', action:'obox-theme', themeId, tokens }` | iframe `load` / 主题变化 / 收到请求                   |
| 子窗口 → 宿主 | `{ source:'obox-app', action:'obox-theme-request' }`          | 扩展启动后（建议 0/300/1000 ms 各一次，收到推送即停） |

- `themeId`：当前主题 id（如 `theme-dark`；空串表示当前没有主题扩展）。**不要**把它当色值用；要决定原生控件深浅请按 `/light/i` 判 `'light'` / 否则 `'dark'` 设 `documentElement.style.colorScheme`
- `tokens`：`Record<token 名, 生效值>`，键形如 `--bg`；**值**取自宿主 `:root` 上 `getComputedStyle` 的**生效值**（`collectThemeTokens`，25 个 token 白名单），因此与宿主主窗口所见一致。非法键名 / 非字符串 / 空串会被宿主在构造时丢弃，扩展侧建议**再过滤一次**（双保险）
- 这条推送**不经** `api.app.onMessage` 桥（那条要经主进程 IPC、需要扩展注册 handler）——它是"宿主渲染进程 → iframe"的直连消息，**不需要**在扩展入口做任何事
- 扩展页里**没有** `api` 对象，也**读不到** token 值（`api.theme.getCurrent()` 只给 id，见 `api-reference.md`）；上面这条推送是 `url` 型页面拿到 token 的**唯一**途径

最小接收代码（复制到你的静态页入口，**在挂载 UI 之前**先同步写一份兜底，首帧就不会白闪）：

```js
const FALLBACK = { '--bg': '#1e1e1e', '--fg': '#cccccc' /* …按 themes-settings 的 token 表补齐… */ }

function applyTokens(tokens, root = document.documentElement) {
  for (const [k, v] of Object.entries(tokens)) {
    if (/^--[a-z0-9-]+$/.test(k) && typeof v === 'string' && v) root.style.setProperty(k, v)
  }
}

// ① 同步兜底（老宿主 / 推送未达时不空白）
applyTokens(FALLBACK)
document.documentElement.style.colorScheme = 'dark'

// ② 收推送（只认 parent 发来的本协议消息）
window.addEventListener('message', (e) => {
  const d = e.data
  if (!d || d.source !== 'obox-app' || d.action !== 'obox-theme') return
  if (e.source !== window.parent) return
  applyTokens(d.tokens)
})

// ③ 请求重发（宿主若先于监听就绪发过一次，这里补上）
for (const ms of [0, 300, 1000]) {
  setTimeout(
    () => window.parent.postMessage({ source: 'obox-app', action: 'obox-theme-request' }, '*'),
    ms
  )
}
```

> 收到推送后可以停掉后续重试（记一个 `received` 标志）。`scripts/create-user-extension.mjs` 生成的骨架已内置这段逻辑（`installAppThemeBridge()`）。

### Token 全量参考

| Token             | 默认值（Dark）                 | 说明                                          |
| ----------------- | ------------------------------ | --------------------------------------------- |
| `--bg`            | `#1e1e1e`                      | 全局背景（内容区）                            |
| `--bg-panel`      | `#252526`                      | 面板背景（卡片/弹窗/命令面板）                |
| `--bg-sidebar`    | `#333333`                      | 侧栏/导航栏背景                               |
| `--bg-titlebar`   | `#323233`                      | 标题栏背景                                    |
| `--bg-input`      | `#3c3c3c`                      | 输入框/下拉/按钮背景                          |
| `--border`        | `#3c3c3c`                      | 边框                                          |
| `--fg`            | `#cccccc`                      | 主文字色                                      |
| `--fg-dim`        | `#6e6e6e`                      | 次要文字/图标色                               |
| `--fg-bright`     | `#ffffff`                      | 高亮文字（标题/激活项）                       |
| `--fg-link`       | `#75beff`                      | 链接/信息色                                   |
| `--fg-error`      | `#f48771`                      | 错误文字/边框                                 |
| `--fg-warning`    | `#cca700`                      | 警告文字                                      |
| `--fg-success`    | `#4ec9b0`                      | 成功文字                                      |
| `--accent`        | `#007acc`                      | 强调色（激活项背景/徽标/选中）                |
| `--hover-bg`      | `rgba(255, 255, 255, 0.1)`     | 悬停背景                                      |
| `--selection-bg`  | `#094771`                      | 选中背景（命令面板/提示/App 列表条目）        |
| `--nav-icon`      | `#858585`                      | 导航栏图标默认色                              |
| `--statusbar-bg`  | `#2a2a2a`                      | 状态栏背景                                    |
| `--statusbar-fg`  | `#cccccc`                      | 状态栏文字                                    |
| `--font-family`   | 系统字体栈（`main.css:22-23`） | 全局字体族                                    |
| `--font-size`     | `13px`                         | 全局基准字号                                  |
| `--font-size-sm`  | `12px`                         | 小字号（提示/版本号）                         |
| `--font-size-lg`  | `16px`                         | 大字号——宿主**只声明、无 `var()` 使用**       |
| `--nav-icon-size` | `24px`                         | 导航栏图标尺寸（宿主已用）                    |
| `--icon-size`     | `24px`                         | 通用图标尺寸——宿主**只声明、无 `var()` 使用** |

**核对结论（当前一致）**：上表 25 个 token 与 `src/renderer/src/assets/main.css:2-29` 的 `:root` 默认值、`src/renderer/src/extensions/theme-dark/manifest.json:13-39` 的 token 取值逐项相同；`theme-light/manifest.json:13-39` 键集合相同、取值不同。三处任一处增删或改名 token，本表必须同步。`--font-size-lg` / `--icon-size` 仅 `:root` 与两个主题声明（`main.css:26,28`），宿主 CSS 中没有任何 `var()` 消费——扩展仍可用 `var(--icon-size)` 取到 24px，但不要当成宿主既有约定。

### 图标尺寸

- 导航栏图标尺寸用 `var(--nav-icon-size)`（宿主已消费：`src/renderer/src/components/NavBar.vue:186-191`）
- `--icon-size` 宿主只声明未使用（`main.css:28`）；扩展要自定义图标尺寸时按需自定 token

### 编写主题扩展

```json
{
  "name": "my-theme",
  "version": "1.0.0",
  "displayName": "我的主题",
  "main": "./index.ts",
  "contributes": {
    "themes": [
      {
        "id": "my-theme.blue",
        "label": "蓝色",
        "tokens": {
          "--bg": "#0d1117",
          "--fg": "#c9d1d9",
          "--accent": "#58a6ff"
        }
      }
    ]
  }
}
```

- 只需声明想覆盖的 token；未声明的由 `main.css` 的 `:root` 兜底。**切换主题时会清掉上一主题写入、本次不再声明的键（issue #81）**：`apply()` 记录上一次写入的键集合，对"上次有、这次没有"的键调 `removeProperty`（`src/renderer/src/core/theme.ts:58-77`），因此从"全量主题"切到"部分 token 主题"时，未声明的键会**回落到 `main.css` 的默认值**，不会保留上一个主题的值。（修复前是"只写不清"，旧文档记的残留行为已作废。）
  - 因此下发给 App 子窗口的 token 快照也更干净：快照取自 `getComputedStyle(document.documentElement)` 的**生效值**（`src/renderer/src/core/appTheme.ts` 的 `collectThemeTokens`），现在等于"`main.css` 默认值 + **当前主题**覆盖"，子窗口与主窗口**所见一致**且无上一主题残留
  - 时序边界：首启（没有上一主题）不清任何键；同一主题重复 `apply()` 集合相同、不误删；新主题声明更多键时只写不删
- 主题扩展入口保持最小：`export default function themeDark() { return () => undefined }`（`src/renderer/src/extensions/theme-dark/index.ts:5-7`）
- 宿主已内置 `theme-dark`（深色）/ `theme-light`（浅色）；设置"外观"下拉列出所有主题扩展

## 设置系统

### 左侧树节点

- **外观**：主题下拉（主题扩展贡献，`SettingsView.vue:286-297`）
- **通用**：关闭行为 + 开机自启。节点**始终显示**（`SettingsView.vue:236-239` 无平台判断）；两行控件仅在 Windows 渲染（`v-if="isWindows"`，`:302`、`:311`），非 Windows 只显示 `windowsOnly` 说明（`:324`，词条见 `src/renderer/src/i18n/locales/zh.ts:194`）
  - 关闭行为（询问 / 收进托盘 / 退出，ADR-0019）：偏好存**主进程** `userData/app-preferences.json`（`src/main/windowBehaviorCore.ts:17`；由 `window-behavior.json` 更名并在启动时迁移，`src/main/index.ts:80`），设置页经 `window.api.get/setCloseBehavior` 读写（`SettingsView.vue:190-194`）
  - 开机自启（ADR-0019 决策 12–16）：`window.api.get/setAutoStart`，**仅 Windows 且非开发版**支持（`src/main/autoStartCore.ts:85-87`）；状态以系统为准，失败/不支持时后端回传真实状态与原因，开关回弹并在下方显示（`src/main/autoStart.ts:53-63,87-98`、`SettingsView.vue:322`）
- **语言**：语言下拉，选项显示各语言自己的本地化名称
- **快捷键**：内置快捷键修改 + 冲突检测
- **更新**：选择"更新提供者扩展"（manifest `contributes.updater`，只能一个生效，`src/renderer/src/core/updaterStore.ts:54-62`）+ 显示当前版本 + 检查 / 下载 / 安装（`SettingsView.vue:388-444`）；未选择提供者时不检查更新
- **网络**：代理设置（启用 / 主机 / 端口 / 用户名 / 密码 / 忽略 SSL 校验 / 排除列表），存设置存储 `network.proxy`（`SettingsView.vue:159-170`），由宿主 session 级生效（`api.proxy`，见 `api-reference.md`）
- **通知**：逐扩展的系统通知开关（`SettingsView.vue:172-181`）；被关闭的扩展其 `api.notification.show` 直接返回 `{ ok: true }` 不弹出（`src/renderer/src/core/host.ts:701-703`）
- **扩展**：注册了设置页的扩展（按扩展名展开）。点该节点回到扩展分区**列表态**（`@click="selectExtensions()"` 置 `active = 'extension'` 并清 `activeExt`，`SettingsView.vue:272-278`、`:34-38`）；再点子项才在右侧显示该扩展的设置页（`:280-290`）。此前该节点漏了 `@click` 导致整个分区不可达（issue #80，已修复，回归门禁见 `test/settings-view-wiring.test.ts`）

### 扩展设置页（双通道）

1. **运行时**：`api.settings.register({ id, title, fields })`，返回的 `Disposable` 只注销自己那一页（`src/renderer/src/core/host.ts:432-437`）
2. **manifest 声明**：`contributes.settings`，形状是**单个** `{ id, title, fields }`（与 `api.settings.register` 的参数同型，不是数组；`src/api/contributions.ts:144-145`），由 `host.ts:179` 注册

字段类型 `SettingField`（`src/api/contributions.ts:76-89`）：`key` / `label` / `type`（`text` / `number` / `boolean` / `select`）/ `default?` / `options?`（select 的 `{ value, label }[]`）/ `description?`（设置页在字段下方渲染为说明文字，`SettingsView.vue:570`）。设置值存统一设置存储（`stateStore.settings`），`api.settings.set` 立即持久化并通知（`host.ts:438-446`）；落盘是渲染进程 localStorage 的 `obox:state:v1`（Electron 下位于 userData，`src/renderer/src/core/state.ts:1-15`），**不是**可直接编辑的 JSON 文件。凡注册了设置页的扩展都列在"扩展"节点下，代码未按内置/用户过滤（`src/renderer/src/core/extensionSettings.ts:47-49`）。

### 快捷键

- 内置：`app.showCommands` 默认 `Ctrl+Shift+P`（`src/renderer/src/core/host.ts:779-782`）
- 扩展：manifest `contributes.keybindings` 把已声明命令绑定默认键，注册进同一个 `keybindingStore`（`host.ts:205`）；该键已被其他命令占用时**不注册**并记 warning（`host.ts:192-204`，重名按 `normalizeKey` 归一后比较）
- 修改：设置"快捷键"页点编辑，按下新组合（Esc 取消，`SettingsView.vue:63-81`）
- 冲突检测：同键被其他命令占用时提示且**不写入**（`src/renderer/src/core/keybindings.ts:39-46`）；比较走 `normalizeKey`，**大小写与修饰键名会归一**（issue #79：`Ctrl+Shift+k` 与 `Ctrl+Shift+K` 视为同一绑定，`keybindings.ts:87-149`）
- 持久化：设置存储 `keybinding.<command>`；重置即删除该键、回落默认（`keybindings.ts:17,47,53`）

### 语言（i18n）

- 宿主与内置扩展界面文案走 vue-i18n key；语言列表见 `src/renderer/src/i18n/index.ts:19-22`（中文 → "中文"、English → "English"）。主进程对话框自备 zh/en 文案，不共用渲染进程语言包（`src/main/windowBehaviorCore.ts:6-7`）
- 扩展语言包：`api.i18n.registerMessages` 或 manifest `contributes.i18n`，按扩展 id 独立命名空间；`api.i18n.t(key, params)` 缺词条时返回 key 本身（`src/renderer/src/core/extensionI18n.ts:15-49`、`src/api/contributions.ts:142-143`）
- 切换立即生效并持久化：`setLocale` 写 `obox:locale:v1` 并广播设置变更（`i18n/index.ts:57-63`）
