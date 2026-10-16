# 主题与设置参考

> **本文件是 obox 主题与设置（主题 token、设置页字段、App 子窗口主题下发）的唯一真相，位置 `docs/extension-api/`**：仓库内其它文档一律引用本文件，不复制副本。

Obox 的主题与设置系统：主题由**主题扩展**提供（CSS 变量 token），设置由内置 `settings` 扩展管理。左侧树共八个分区：外观 / 通用 / 语言 / 快捷键 / 更新 / 网络 / 通知 / 扩展（`src/renderer/src/extensions/settings/SettingsView.vue:229-268`，`TreeKey` 定义见 `:21-29`）。

## 主题系统

### 机制

- 主题 = 主题扩展 `contributes.themes` 声明的 CSS 变量 token 组（`src/api/contributions.ts:63-70`）
- 宿主收集所有主题扩展的贡献（`src/renderer/src/core/host.ts:195`），设置"外观"节点下拉选择；选中后把 token `setProperty` 到 `document.documentElement`（`:root`）并持久化（`src/renderer/src/core/theme.ts:50-77`）。持久化值失效时缺省取 id 含 `dark` 的主题（`theme.ts:37-44`）
- 宿主 UI 组件用 `var(--token, fallback)` 引用 token，主题切换即时生效
- **每个渲染窗口各有一份 `:root`**：App 子窗口（`?obox-window=app`）启动时由 `host.start()` 收尾的 `applyCurrent()` 应用一次（`src/renderer/src/core/host.ts:1034`）；主窗口此后切主题时，新快照经 `storage` 事件合并进子窗口（`src/renderer/src/core/state.ts` 的 `applyExternal`）并重新应用、再下发给 iframe（见下条与 ADR-0022）
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
- **overlay 窗体（`?obox-window=overlay`）复用同一份外壳，但本协议对它是"不触达"的**：overlay 由 `api.overlay.create` 创建（见 `api-reference.md` 的 `### overlay`），加载的同样是 `AppWindow.vue`（`src/renderer/src/main.ts:21-23,40-44`），但它**不进 `appStore`**（不注册卡片）⇒ 外壳里 `registration` 恒为 `undefined`（`src/renderer/src/AppWindow.vue:102`），而 `pushThemeTokens()` 的第一行就是 `if (!registration.value?.url) return`（`:161-171`）——因此 iframe `load`、主题变化、`obox-theme-request` 三个时机的推送**都会提前返回**，overlay 页面**收不到** `obox-theme`（宿主侧刻意不加新分支，`:35-36` 的注释即此取舍）。扩展要"不接主题"什么都不用做（这正是宠物扩展的选择：窗体是 artwork 覆盖层、固定配色，宿主 25 个 token 在其页面内**零引用**，见 `extensions/pet/openspec/changes/pet-desktop-companion/design.md` D-6/D-12）；反过来，overlay 页面**确实需要** token 时只能自己经消息桥向扩展入口要（`api.app.onMessage`，见 `api-reference.md`），别指望本协议。

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
- **网络**：代理设置（启用 / **代理地址 URL** / 忽略 SSL 校验 / 排除列表），存设置存储 `network.proxy`（`SettingsView.vue:204-265` 读值-迁移-保存，`:811-839` 表单），由宿主 session 级生效（`api.proxy`，见 `api-reference.md`）。1.0.12 起主输入是**单一 URL**（http/https/socks4/socks5，可含 `user:pass@`）；旧形态（host/port/username/password）在读取时自动迁移，实现在 `src/shared/proxyConfig.ts`
- **通知**：逐扩展的系统通知开关（`SettingsView.vue:172-181`）；被关闭的扩展其 `api.notification.show` 直接返回 `{ ok: true }` 不弹出（`src/renderer/src/core/host.ts:797-799`）
- **扩展**：注册了设置页的扩展（按扩展名展开）。点该节点回到扩展分区**列表态**（`@click="selectExtensions()"` 置 `active = 'extension'` 并清 `activeExt`，`SettingsView.vue:272-278`、`:34-38`）；再点子项才在右侧显示该扩展的设置页（`:280-290`）。此前该节点漏了 `@click` 导致整个分区不可达（issue #80，已修复，回归门禁见 `test/settings-view-wiring.test.ts`）

### 扩展设置页（双通道）

1. **运行时**：`api.settings.register({ id, title, fields })`，返回的 `Disposable` 只注销自己那一页（`src/renderer/src/core/host.ts:459-464`）
2. **manifest 声明**：`contributes.settings`，形状是**单个** `{ id, title, fields }`（与 `api.settings.register` 的参数同型，不是数组；`src/api/contributions.ts:152-160`），由 `host.ts:205` 注册。**清单声明的 settings 另有一层发布前静态校验**（`scripts/validate-manifest.mjs`，宿主运行期不做）：规则与错误文案见 `manifest-reference.md` 的「settings 字段校验（`scripts/validate-manifest.mjs`，脚本独有）」

字段类型 `SettingField`（`src/api/contributions.ts:106-150`）：`key` / `label` / `type`（`text` / `number` / `boolean` / `select` / `directory` / `status` / `progress`——**这七个就是白名单的全部**，与 `SettingFieldType` 联合逐字同序，`src/api/contributions.ts:106-107`；发布前校验脚本用同一份白名单，`scripts/validate-manifest.mjs:226-234`，一致性有门禁 `test/settings-progress-field.test.ts` ⑨）/ `default?` / `options?`（select 的 `{ value, label }[]`）/ `description?`（设置页在字段下方渲染为说明文字，`SettingsView.vue:1005-1007`；**`progress` 字段不渲染它**，见下方「`progress` 字段」）/ `max?`（**只对 `progress` 有意义**：进度上限，缺省 100，`src/api/contributions.ts:123-134`）/ `modal?`（**只对 `status` 有意义**：值非空即以**不可关闭的等待模态框**展示，见下方「`modal` 属性」）。设置值存统一设置存储（`stateStore.settings`），`api.settings.set` 立即持久化并通知（`host.ts:459-473`）；落盘是渲染进程 localStorage 的 `obox:state:v1`（Electron 下位于 userData，`src/renderer/src/core/state.ts:1-15`），**不是**可直接编辑的 JSON 文件。凡注册了设置页的扩展都列在"扩展"节点下，代码未按内置/用户过滤（`src/renderer/src/core/extensionSettings.ts:47-49`）。

#### `directory` 字段（目录选择）

- **渲染**：**只读**文本框 + 「浏览…」按钮（`SettingsView.vue:953-977`）。**点输入框或按钮都弹**系统目录选择器：`window.api.dialogOpen({ title, properties: ['openDirectory'] })` → `dialog:open` IPC → `dialog.showOpenDialog`（`src/main/ext.ts:31-49` 归一、`:53-66` 调用；目录模式下 `filters` 被丢弃）。选中的**绝对路径**经 text 同一条保存通路写入（`browseDirectory`，`SettingsView.vue:349-373` → `onFieldChange` → `stateStore.setSetting`）。
- **交互取舍（用户裁定）**：输入框是 `readonly` **且带 `@click`** —— **选目录是该字段的主要输入方式**，点输入框即弹框，路径**不能**手工输入/粘贴（`browseDirectory` 是该字段唯一的写值入口）。「浏览…」按钮保留：一是键盘可达（Tab 到按钮回车即可），二是冗余的显式入口（`:965-967`）。
- **值的语义**：**绝对路径字符串**；空串 / `undefined` = 未选择，**默认目录由扩展自行决定**。
- **取消与失败**：`canceled: true` **不改动**该设置项（早退在写值之前，`:363`）；`ok: false`（含老宿主不支持该能力、后端异常）在字段下方显示可见错误并 `console.error`，**不静默**（`:356-361`、`:974-976`）。
- **宿主只负责选目录，不负责校验**：不校验目录是否存在 / 是否可写 / 是否受扩展管理，扩展侧读取该值时须自行校验。
- **老宿主（≤ v1.0.8）**：v1.0.8 的字段渲染链到 `select` 即止且**没有兜底分支**（无 `v-else`），因此 `directory` 字段**不渲染任何控件**（label 仍在、内容为空），既不会退化成文本框也不报错。需要兼容老宿主时，扩展应自行降级为 `text`。本仓库新版宿主对**未知类型**统一按 `text` 兜底渲染并 `console.warn`（`SettingsView.vue:994-999`、`unknownTypeValue` `:552-561`），所以这种情况只出现在老宿主上。

#### `status` 字段（只读状态展示）

- **只读**：宿主**不提供任何编辑控件**——渲染链里该分支没有 `input` / `button` / `select`，也不接 `onFieldChange`（`SettingsView.vue:984-989`）。用户在设置页**无法**改动这个值，只能由扩展写。
- **值从哪来**：只读文本就是该字段 `key` 在**统一设置存储**里的值，由扩展自己调 `api.settings.set(key, value)` 写入（`host.ts:467`）；设置里没有该键时回退 `field.default`。非字符串值按 `String(value)` 展示（写数字进度也可以）。宿主**不**为它另建存储。
- **多行语义**：值里含 `\n`（CRLF 归一为 LF）时**按行渲染成列表**（`<ul class="status-lines">` + 每行一个 `<li>`，`SettingsView.vue:985-988`）；去首尾空行、保留中间空行；单行时渲染一行文本。
- **空值**：值空 / 全空白（含只有换行）时渲染占位文案「（无）」（`settings.extensionsSection.noValue`，`zh.ts:149` / `en.ts:149`），字段下方不留空白。
- **扩展写键后设置页会立即刷新**（无需重进设置页）：`api.settings.set` 与设置页读值是**同一个渲染进程里的同一个 `stateStore`**——扩展侧 `api.settings.set` = `stateStore.setSetting`（`host.ts:467`），设置页侧 `fieldValue` 读 `stateStore.getSetting`（`SettingsView.vue:322-325`）且 `onMounted` 订阅 `stateStore.onSettingsChanged` 把 `settingsRevision++` 触发重渲染（`SettingsView.vue:565-570`）；`setSetting` 在 `save()` 之后**同步**遍历订阅者（`state.ts:143-148`）。回归门禁见 `test/settings-first-paint.test.ts`。**前提（源码级）**：扩展宿主与设置页在**同一个渲染进程（主窗口）**里——宿主 `api` 由 `src/renderer/src/core/host.ts` 构建；设置页视图由内置 settings 扩展注册（`src/renderer/src/extensions/settings/index.ts`），只由主窗口的 `App.vue` 渲染。子窗口（`?obox-window=app` 的 App 卡片窗口与 `?obox-window=overlay` 的 overlay 窗体，两者都由 `src/renderer/src/main.ts:21-23` 的 `isChildWindow` 判定）只渲染外壳 + 内容 iframe（`AppWindow.vue`）且**不激活扩展**（`:37` 的 `activateExtensions: !isChildWindow`），因此不存在"扩展在另一个窗口写设置、设置页收不到"的路径。`storage` 事件 → `stateStore.applyExternal` 那条**整份快照替换**的通路只用于窗口间主题同步（`state.ts:159-177,207-213`）。
- **老宿主（≤ v1.0.8）**：与 `directory` 同样断在"渲染链到 `select` 即止、无兜底分支" ⇒ `status` 字段**不渲染任何控件**（label 仍在、内容为空），既不显示状态也不报错（`type: 'status'` 从未被老宿主认识）。
- **认识 `directory` 但尚未实现 `status` 的中间版本宿主**：这类宿主**有**未知类型兜底 ⇒ `status` 会按 `text` 渲染成一个**可编辑文本框**。值仍取自同一设置存储（首屏显示扩展写的状态是正常的），但用户可以在框里改并保存，把扩展写的状态覆盖掉。若该类宿主仍需兼容，扩展应在初始化时检测宿主是否支持或改用不带编辑控件的自绘视图。注：`directory` 与未知类型兜底都是**本仓库尚未发布的改动**，已发布的 v1.0.8 及更早两者都没有（属上一条）；也就是说 `status` 一旦随本次改动发布，就不存在"已发布但只会兜底成文本框"的宿主版本。

#### `progress` 字段（只读进度条）

`type: 'progress'`（随 **API v2** 新增，`src/api/contributions.ts:87-92,106-107`）是**只读进度条**：语义沿用 `status` 的"扩展写、宿主只渲染"，区别是值是**数字**（`0..max`）而不是字符串，且渲染成条 + 文本而非纯文本。

- **只读**：分支里只有进度条与右侧文本，**没有任何可编辑控件**（无 `input` / `button` / `select`，也不接 `onFieldChange`，`SettingsView.vue:933-949`）；条上有 `role="progressbar"` + `aria-valuemin/valuemax/valuenow`（`:936-940`），可供辅助技术读出。用户在设置页**无法**改动这个值。
- **值从哪来（与 `status` 同存储、同刷新路径）**：值就是该字段 `key` 在**统一设置存储**里的值，**由扩展用 `api.settings.set(key, 数字)` 写入**（`host.ts:467` = `stateStore.setSetting`）；设置页经 `progressView` → `fieldValue` → `stateStore.getSetting` 读值（`SettingsView.vue:528-541,322-325`），并靠 `onSettingsChanged` 订阅把 `settingsRevision++` 当帧刷新（`:565-570`）——**不需要重进设置页、不需要轮询**，也没有为 `progress` 新增任何订阅机制。设置里没有该键时回退 `field.default`（`default` 必须是数字，见 `manifest-reference.md` 的「settings 字段校验」）。
- **`max`**：可选，**缺省 100**；值域 `0..max`。`max` 声明本身非法（非数字 / ≤ 0 / 非有限）时**运行期回落 100**（`SettingsView.vue:506-510`）——发布前的清单校验已把它拦成 error（`scripts/validate-manifest.mjs:260-267`），运行期这层只是自保，不报错、不白屏。
- **显示口径（取整只作用于文本）**：右侧文本是 `{cur}/{max}`，其中 `{cur}` = `Math.floor(clamp(cur, 0, max))`（**先钳制到 `[0, max]`，再向下取整**）；进度条**宽度用未取整的真实比例** `clamp(cur,0,max)/max * 100%`（`SettingsView.vue:506-516`）。为什么条宽不取整：`cur = 99.9` 时文本显示 `99/100`，条宽按真实 99.9% 才"贴边"；两边各自取整会永远对不齐。越界值按钳制处理（`-5` ⇒ `0/100` 条宽 0%；`180` ⇒ `100/100` 条宽 100%）。回归门禁：`test/settings-progress-field.test.ts` 的「③ 取整口径」「④ 钳制与自定义 max」。
- **不渲染 `description`**：即使字段声明了 `description` 也**不显示**——排除条件写在字段链之外那个 `<p v-if="field.description && field.type !== PROGRESS_FIELD_TYPE">` 上（`SettingsView.vue:1005-1007`），进度行因此保持紧凑。这是**显示约定，不是实现遗漏**（门禁：`test/settings-progress-field.test.ts` 的「② description 即使声明也不显示」）。
- **非数字值**：`'abc'` / `null` / `undefined` / `NaN` / `±Infinity` / 布尔 / 对象一律**按 0 渲染**，并打**一条** `console.warn`（按 `fieldSlot` = `页 id::字段 key` 去重，不随重渲染刷屏，`SettingsView.vue:518-541`）；**绝不抛错**——设置页是宿主内置页面，扩展写坏一个值不能整页白屏。注意"声明了数字 `default` 但设置里还没值"**不算坏值**：那是合法回退，不 warn。
- **样式只用既有 token（无新增 token、无写死色值）**：槽 = `--bg-input`、填充 = `--accent`、边框 = `--border`、文本字号 = `--font-size-sm`（`SettingsView.vue:1189-1208`，`var()` 的 fallback 就是上文 token 表记录的文档默认值）；文本另沿用 `.config-value`（`--fg-bright` + 等宽字体），标签列沿用 `.config-row label`——不新造布局。
- **老宿主行为（与 `status` 的"中间版本宿主"问题同款）**：`progress` 是**新增类型**，不认识它的宿主会走**未知类型兜底 ⇒ 渲染成可编辑文本框**（`SettingsView.vue:994-999` + `unknownTypeValue` `:552-561`，值仍取自同一设置存储 ⇒ 首屏显示正常，但用户误编辑会覆盖扩展写的数值），并刷一条 `[settings] 未知设置字段类型 …` 的 warn；**≤ v1.0.8** 的宿主渲染链没有兜底分支 ⇒ 该字段**不渲染任何控件**（label 仍在）。扩展要在老宿主上有正确表现，只有两条路：**自行降级**（改用 `status` / `text`，或自绘视图；写入侧仍是同一把 key，不需要改）或**依赖 `apiVersion` 门槛**——manifest 声明 `apiVersion: 2` 后，老宿主直接**拒绝加载**该扩展（`core/manifest.ts:28-38`），而不是把它降级显示。
- **overlay / 无主题窗体不消费 token**：`progress` 只由**宿主设置页**渲染，因此天然跟随宿主主题，扩展不需要为自己的窗体做任何主题工作。反过来说，扩展用 `api.overlay.create` 开的 overlay 窗体（见 `api-reference.md` 的 `### overlay`）**不接本协议的主题下发**（原因见上文「App 子窗口（`url` 型）主题下发协议」末条），它可以完全用自己的固定配色——宠物扩展就是这么做的：窗体是桌面上的 artwork 覆盖层，宿主 25 个 token 在其页面内**零引用**（`extensions/pet/openspec/changes/pet-desktop-companion/design.md` D-6/D-12，该扩展已把"零自造色值"硬约束**显式豁免**并登记了退场条件）。也就是说：**用 `progress` 展示进度与"窗体是否消费 token"是两件无关的事**。

#### `modal` 属性（等待模态框）

`modal?: boolean`（`src/api/contributions.ts:135-149`）是 `SettingField` 的**可选**属性，与 `type: 'status'` **组合**使用（值仍是字符串）：把只读状态渲染成**不可关闭的全屏模态框**，用于"迁移 / 初始化没完成之前不许操作设置页"这类阻塞场景。典型用法：设置页上 `directory` 字段选完目录后，扩展开始迁移并写进度，迁移结束再清空。

- **渲染**：值**非空** ⇒ 在设置页渲染 **全屏遮罩 + 对话框**（`role="dialog"` + `aria-modal="true"`，模板见 `SettingsView.vue:1023-1037`，样式 `:1285-1321` 全部走既有主题 token）；框内显示字段 `label` 与按行拆分的值（行文本复用 `statusLines()`：CRLF 归一、去首尾空行、中间空行保留；单行渲染一行文本，多行渲染成列表）。
- **值空 ⇒ 什么都不渲染**：判据是 `statusHasValue()`（`SettingsView.vue:422-427`）——设置值存在、且 `String(value).trim() !== ''`。因此 `''` / `'   '` / `'\n'` 都算"没有进度"，`activeModal` 为 `null`（`SettingsView.vue:442-450`）⇒ 模态块被 `v-if` **整块卸载**（不是隐藏）。
- **显示判据只取设置值，不回退 `default`**：`default` 非空会让模态框在扩展还没开始任务时就常驻、而且**关不掉**（不可关闭是刻意设计）。`modal` 字段请写 `default: ''`。
- **写入与清空约定**：值由扩展经 `api.settings.set(key, value)` 写入同一设置存储（`host.ts:467`）。**扩展必须在任务结束时写 `''` 清空该键**——这是模态框**唯一**的消失通路；写 `undefined`（= 删除该键）等效于空值。忘记清空 = 用户被永久挡在设置页里（只能重启或靠扩展停用）。
- **不可关闭（刻意设计）**：模态模板里**没有**关闭按钮，也**没有** `@click` / `@keydown` / `@keyup` 绑定——因此 `Esc` 无效、点遮罩不关闭；对话框本身只有 `tabindex="-1"`（`SettingsView.vue:1030`），没有 `@keydown.esc` 之类的出口。遮罩是 `position: fixed; inset: 0` 且 `z-index: 6000`（高于改键捕获层的 5000），覆盖整个视口并吃掉指针事件，背景既点不到、也不会跟着滚（`overscroll-behavior: contain`）。同一份源码级门禁（`test/settings-view-wiring.test.ts` 的「modal 字段（等待模态框）」）会断言这些"关闭通路"确实不存在。
- **焦点**：只做"初始聚焦"——对话框 `tabindex="-1"`，`activeModal` 变为非空后 `await nextTick()` 再 `focus()`（`SettingsView.vue:456-465`）；按约定**不**上完整 focus-trap，Tab 仍可能跑到被遮住的背景控件上（背景不可交互，跑出去只是失去可见焦点）。
- **扫全部设置页**：`activeModal` 遍历**所有**已注册设置页，而不只是左树当前选中的那个扩展。模态框是阻塞层，若只在当前页扫，用户点一下左树另一个节点就等于"关掉"它（那是一条隐蔽的关闭通路）。多个 `modal` 字段同时非空时取**第一个**。
- **老宿主降级（不会崩、不报错）**：`modal` 是**新增的可选属性**，老宿主的字段链不认识它、也不会读它——老宿主照旧按 `type: 'status'` 渲染（≤ v1.0.8 连 `status` 都不认识 ⇒ 该字段不渲染任何控件、label 仍在），因此**只是不弹模态框**：既不抛错也不崩，进度值安静地留在设置里。扩展要在老宿主上也有反馈，得自行降级（`text` 字段 / `api.notification.show` / 自绘视图）：老宿主既不会报错、也不会有任何提示，模态框就是不出现。

### 快捷键

- 内置：`app.showCommands` 默认 `Ctrl+Shift+P`（`src/renderer/src/core/host.ts:874-880`）
- 扩展：manifest `contributes.keybindings` 把已声明命令绑定默认键，注册进同一个 `keybindingStore`（`host.ts:231`）；该键已被其他命令占用时**不注册**并记 warning（`host.ts:217-229`，重名按 `normalizeKey` 归一后比较）
- 修改：设置"快捷键"页点编辑，按下新组合（Esc 取消，`SettingsView.vue:63-81`）
- 冲突检测：同键被其他命令占用时提示且**不写入**（`src/renderer/src/core/keybindings.ts:39-46`）；比较走 `normalizeKey`，**大小写与修饰键名会归一**（issue #79：`Ctrl+Shift+k` 与 `Ctrl+Shift+K` 视为同一绑定，`keybindings.ts:87-149`）
- 持久化：设置存储 `keybinding.<command>`；重置即删除该键、回落默认（`keybindings.ts:17,47,53`）

### 语言（i18n）

- 宿主与内置扩展界面文案走 vue-i18n key；语言列表见 `src/renderer/src/i18n/index.ts:19-22`（中文 → "中文"、English → "English"）。主进程对话框自备 zh/en 文案，不共用渲染进程语言包（`src/main/windowBehaviorCore.ts:6-7`）
- 扩展语言包：`api.i18n.registerMessages` 或 manifest `contributes.i18n`，按扩展 id 独立命名空间；`api.i18n.t(key, params)` 缺词条时返回 key 本身（`src/renderer/src/core/extensionI18n.ts:15-49`、`src/api/contributions.ts:142-143`）
- 切换立即生效并持久化：`setLocale` 写 `obox:locale:v1` 并广播设置变更（`i18n/index.ts:57-63`）
