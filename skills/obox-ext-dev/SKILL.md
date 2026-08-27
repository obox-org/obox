---
name: obox-ext-dev
description: 在 Obox 桌面应用（Electron + Vue + Cordis 扩展系统）中开发扩展的完整指南。使用当用户要编写、修改、调试 Obox 扩展，或要注册插件卡片到 App（应用）扩展时。涵盖 manifest 声明、贡献点、扩展 API、入口约定、内置/用户扩展、App 子窗口与常见坑。
---

# Obox 扩展开发

本 skill 指导在 Obox 中开发扩展。Obox 是一个基于 Electron + Vue + TypeScript 的桌面程序宿主，扩展系统基于 Cordis，扩展宿主运行在渲染进程，仿照 VS Code 扩展模型（声明式贡献点 + 宿主解析注册 + 两阶段启动）。

## 何时使用

- 用户要**新建/修改/调试** Obox 扩展（导航项、状态栏项、命令、视图组件）
- 用户要把插件卡片**注册进 App（应用）扩展**，点击弹出独立子窗口
- 用户要理解扩展 API、manifest 格式、贡献点声明或常见坑

## 核心概念

- **扩展（Extension）**：为 Obox 贡献能力的可插拔单元。清单（manifest）声明贡献点，入口导出 Cordis 插件函数 + 具名导出视图组件。详见 `references/manifest-reference.md`。
- **贡献点（Contribution Point）**：扩展在 manifest 中声明的能力注册点——导航项、状态栏项、命令，由宿主解析注册（声明式，不是命令式 `ctx.register*`）。
- **扩展 API**：宿主在激活时注入的 `ExtensionActivationApi`，扩展在插件函数里通过它注册命令实现、更新状态栏、设徽标、读写 Memento、发事件、调窗口能力。详见 `references/api-reference.md`。
- **App 注册**：扩展可调用 `api.app.register(...)` 把插件卡片注册进"应用"扩展，点击弹出独立子窗口（iframe 渲染 URL/HTML + postMessage 窗口控制桥）。**CSP 已放行 `app:` scheme**：用户扩展可用 `url: 'app://extensions/<id>/todo.html'` 由 iframe 同源加载静态页，子窗口内可执行脚本、用 localStorage（按 app:// 源持久化）；无 allow-modals，禁 alert/confirm/prompt。详见 `references/guides.md`。
- **oix 分发与安装**：用户扩展（非内置）以 **.oix**（zip，根目录含 manifest.json + 入口 + 静态资源）分发，源码在 **`obox-org/<扩展id>` 独立仓库**托管（obox 不持有，`extensions/` gitignore 本地保留）。扩展管理器工具栏「安装扩展」按钮或**拖拽 .oix 到视图**安装：校验 manifest → 防路径穿越解压到 `userData/extensions/<name>_<author>/` → 同名覆盖 → **热生效**（宿主立即扫描、注册贡献点、激活，列表即时出现且立即可用，无需重启）。
- **调试扩展（VS Code 调试，不安装）**：`obox --debug-extension <id>@<本地目录>`（可重复）把扩展本地目录直接当扩展源加载，**不做 .oix 安装**（不写 userData、重启消失、管理器显示"调试中"）；经 `app://debug/<id>/` 加载；配合 `--remote-debugging-port`（CDP）可在 VS Code 打断点（pathMapping `app://debug/<id>/ → ${workspaceFolder}`）。扩展仓库自建 `.vscode/launch.json`（模板见 `references/guides.md`），无需 obox 源码。

## 标准流程

1. **读现状**：先读 `src/api/`（扩展 API 类型；`src/renderer/src/core/types.ts` 为再导出兼容入口）、`CONTEXT.md`（术语表）、已有的 `src/renderer/src/extensions/*/`（示例扩展：`ext-manager`、`app`）。
2. **定扩展 id**：`name` 字段（manifest），`^[a-z0-9][a-z0-9._-]*$`，建议短前缀如 `my-ext`；命令 id 用 `<扩展名>.<动作>`，导航/状态栏/App 卡片 id 建议含扩展名前缀。
3. **写 manifest**：`src/renderer/src/extensions/<id>/manifest.json`（内置）——必填 `name`/`version`/`main`，可选 `contributes`（navItems/statusBarItems/commands）、`extensionDependencies`、`uninstall`。
4. **写入口**：同目录 `index.ts`——`default` 导出插件函数 `(api) => cleanup`，具名导出视图组件（导航项 `view` 字段引用）。所有注册（命令/事件/App 卡片）返回的 Disposable 或 cleanup 函数要能统一释放。
5. **注册贡献点**：导航项 `view` 引用具名导出组件；状态栏项/命令在 manifest 声明即可，实现（命令 handler）在插件函数里用 `api.registerCommand` 绑定；**未在 manifest 声明的命令会被宿主警告**。
6. **（可选）注册到 App**：`api.app.register({ id, name, version, author, description, icon, url | html, multiOpen, width, height })`，点击卡片弹出独立子窗口。详见 `references/guides.md` 的 App 部分。
7. **验证**：`npm run typecheck`、`npm run lint`（改扩展后必须过）；`npm run dev` 跑起来看导航/状态栏/命令面板/App 视图。

## 规则与约束

- **声明式贡献点**：导航项/状态栏项/命令的元数据必须写进 manifest `contributes`，不要用 `ctx.register*` 命令式注册。宿主只认 manifest。
- **命令必须声明**：`api.registerCommand(id, handler)` 的命令 id 必须已在该扩展 manifest `contributes.commands` 里声明，否则宿主打 warning。
- **视图必须导出**：导航项 `view` 字段引用的组件必须在入口**具名导出**（如 `export const MyView`），否则宿主打 warning 且内容栏空白。
- **Disposable 形状**：所有注册 API（`registerCommand`、`on`、`app.register`）返回 `{ dispose(): void }`；插件函数返回值（cleanup 函数）会被宿主收集，扩展停用时统一释放。不返回/不 dispose 会在热重载时泄漏。
- **内置扩展只读**：`src/renderer/src/extensions/` 下是内置扩展（随应用打包，不可卸载）；用户扩展放 `userData/extensions/<name>_<author>/`（经 `app://extensions/<id>/` 加载），可卸载，经 .oix 安装（扩展管理器按钮/拖拽）。开发用户扩展建议建独立项目 `extensions/<id>/`（自带 package.json/tsconfig/构建，仅依赖扩展 API），**入口 main 须为纯 ESM JavaScript**（用户扩展无 Vite 转换）。**纯 JS 扩展零 npm 依赖**（运行时只有宿主注入的 `api`；测试 `node --test`、打包系统 zip，无需 `npm install`，见 guides.md）。
- **子窗口内容**：`html` 用于 srcdoc 渲染，`url` 优先（app:// 或 https）。用户扩展富界面建议用 `url: app://extensions/<id>/<page>.html` 加载自建静态资源（Vue 编译产物）。**iframe 内联 `onclick` 会被 CSP 阻止**——用外部 `<script>` 或事件绑定；`app://` 页面本身无 CSP 头可执行脚本，但 srcdoc 页面内联脚本同样被 `script-src 'self'` 拦截。窗口控制用 postMessage（`parent.postMessage({source:'obox-app', action:'close'|'minimize'|'maximize'}, '*')`）。
- **依赖与环**：`extensionDependencies` 声明依赖；宿主按拓扑序激活，检测到环会跳过并标记。缺失依赖不阻塞激活。

## 持续更新要求（重要）

**本 skill 必须与代码库保持同步**。以下任一情况发生后，必须更新本 skill 及 `references/`：

- 修改/新增扩展 API（`src/api/` 的 `ExtensionActivationApi`、`AppRegistration`、贡献点类型）
- 修改贡献点 schema 或 manifest 校验规则（`core/manifest.ts`）
- 修改宿主生命周期（`core/host.ts` 的激活/停用/依赖排序）
- 修改主进程能力服务或 IPC（`src/main/*`：窗口控制、App 子窗口、app:// 协议、**.oix 安装**）
- 新增/移除内置扩展目录约定
- 修改用户扩展分发/安装机制（oix 格式、安装目录命名、CSP 放行）
- 修复了新的常见坑（追加到 `references/troubleshooting.md`）

修改这些文件时，先更新对应 reference，再更新本文件。子文档分工：

- `references/manifest-reference.md`：manifest 字段、贡献点 schema、校验规则
- `references/api-reference.md`：`ExtensionActivationApi` 全量方法签名与语义
- `references/themes-settings.md`：主题 token 全量参考、主题扩展编写、设置系统（外观/语言/快捷键/扩展设置）
- `references/guides.md`：从零写扩展教程、注册到 App、调试技巧
- `references/troubleshooting.md`：常见错误与修复

## 工具脚本

`scripts/` 目录提供：

- `create-extension`：脚手架——在当前项目生成新内置扩展的目录 + manifest + 入口模板（Node.js，跨平台）
- `validate-manifest`：校验扩展 manifest（字段/版本/依赖/入口引用），开发期或 CI 调用

用法见 `scripts/README.md`。
