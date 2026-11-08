# Proposal

## Why

主体界面已经从 Vue 内置视图迁到**磁盘系统扩展**（`system-extensions/{app,settings,ext-manager}` 的 HTML 页面），但"宿主 → 扩展页面"的运行时上下文没跟上，导致两件用户可见的事都不成立：

1. **主题只改了壳子**：系统扩展页收到的 token 键已经是 `--bg`，页面却又拼了一次 `--`（写进 `:root` 的是 `----bg`，见 `system-extensions/*/page.js`），等于从未生效；且只在 iframe `load` 时推一次（`src/renderer/src/components/ContentArea.vue`），切主题不会重推。App `url` 卡片/overlay 走的是另一套消息形状与另一份 token 快照（25 个生效值），两个协议并存。
2. **i18n 只到扩展代码**：`api.i18n` / `contributes.i18n` 只在扩展自己的 JS 里可用；壳子渲染的标签（`navItems[].title`、`commands[].title`、`statusBarItems[].name`、`displayName`、设置字段 `label`）只能查宿主语言包（`titleKey`），系统扩展与用户扩展都用不了；三个系统扩展页共约 1900 个写死中文字符；主进程托盘/关窗对话框另用 `app.getLocale()`，与设置里的语言是两套源。

## What Changes

- 新增**扩展页面上下文**：宿主向所有扩展页面（系统 nav 页 / App `url` 卡片 / overlay iframe）推送同一条 `obox:context` 消息（`themeId`、`colorScheme`、25 个**生效** token、`locale`、该扩展的 `messages`），并在 iframe load、主题变化、语言变化、页面主动请求四个时机推送。
- 新增**宿主页面运行时** `app://obox/page.js`（`protocol.ts` 增加一个 `obox` 命名空间）：页面一行引入即可写 `:root`、设 `colorScheme`、用 `t(key)`，并内置请求重试与去重；老页面不引入也照旧工作。
- **主题贡献点增加可选 `colorScheme`**（缺省按 id 推断），让 `solarized` 这类主题能正确驱动原生控件；token 集合仍为 25 个。
- **manifest 标签本地化**：`displayName` / `description` / `navItems[].title` / `commands[].title` / `statusBarItems[].name` / `settings.title` 与字段 `label`/`description` 支持 `%key%` 占位符，按**该扩展**的 `contributes.i18n` 解析；缺 key 显示占位符原文并一次性告警。`titleKey`（查宿主语言包）标记为遗留。
- **语言单一源**：语言收敛为设置项（旧 `obox:locale:v1` 一次性迁移），切换时同步到扩展宿主（既有 snapshot 机制）与**主进程**（托盘/关窗/关于跟随设置），不再只认 `app.getLocale()`。
- 三个系统扩展页面：删掉自建的主题收包代码，文案改用 `contributes.i18n` + `t()`，标签改 `%key%`。
- 兼容：新宿主同时保留旧的 `obox-theme`（App 卡片）与 `{type:'obox-theme'}`（系统页）推送**一个 minor 版本**；新页面在老宿主上检测不到 `obox:context` 时使用内置默认值（不报错、不白屏）。

## Capabilities

### New Capabilities

- `extension-page-context`: 宿主向扩展页面交付主题与语言上下文（消息契约、页面运行时、四个推送时机、老宿主/老页面兼容、`colorScheme`）。
- `extension-label-localization`: 壳子渲染的扩展贡献文本按扩展命名空间本地化（`%key%` + `contributes.i18n`、缺 key 行为、`titleKey` 退场）。
- `app-locale`: 应用语言的唯一来源与传播（设置项、迁移、宿主与主进程同步、受支持语言集合）。

### Modified Capabilities

<!-- 本项目 openspec/specs/ 目前为空（无既有 capability），本 change 只新增。 -->

## Impact

- **渲染进程**：`core/theme.ts`（colorScheme 入快照）、`core/extensionI18n.ts`（按 locale 取整包）、`core/registry.ts` / `components/NavBar.vue` / `components/CommandPalette.vue` / `components/TreeNode.ts`（标签解析）、`components/ContentArea.vue` 与 `AppWindow.vue`（上下文推送）、`core/hostQueryDeps.ts`（扩展列表/设置快照先解析标签）、`i18n/index.ts`（locale 迁移到设置）。
- **主进程**：`protocol.ts`（`app://obox` 命名空间）、`tray.ts` / `windowBehavior*.ts`（语言跟设置）、`preload/index.ts`（locale IPC）。
- **新增**：`src/shared/pageContext.ts`（形状与校验，纯模块）、`src/renderer/src/core/pageContext.ts`（组装与广播）、`src/page-runtime/page.js`（页面运行时）。
- **系统扩展**：`system-extensions/{app,settings,ext-manager}` 的 manifest 与 page.js。
- **扩展 API / manifest 契约**：`contributes.i18n` 用途扩大（页面 + 标签共用），`%key%` 成为公开写法；`api.theme` 无变化，`titleKey` 降级。
- **文档**：`docs/extension-api/{themes-settings,manifest-reference,guides-user,api-reference,troubleshooting}.md`；`themes-settings.md` 需按新契约重写（现有 overlay 段与代码已漂移）。
- **兼容性**：不破坏已发布扩展；`titleKey` 保留可用但不再推荐；旧主题无 `colorScheme` 时按 id 推断。
