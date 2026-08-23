# Obox

基于 Electron + Vue + TypeScript 的桌面程序宿主。以布局框架为骨架，通过**基于 Cordis 的扩展系统**（仿照 VS Code 扩展模型）向应用贡献功能。

- 布局：无边框自定义标题栏 + 图标导航栏 + 内容栏（keep-alive）+ 状态栏
- 扩展：声明式贡献点（导航项/状态栏项/命令），两阶段启动，依赖拓扑排序，清单校验
- 内置扩展：**扩展管理器**（Grid 展示/详情/禁用/卸载）、**应用**（插件卡片注册 + 独立子窗口 iframe 渲染）

## 核心架构

```
src/
├── main/            # Electron 主进程
│   ├── index.ts     # 入口：窗口创建、协议、IPC 注册
│   ├── window.ts    # 无边框窗口 + 窗口控制 IPC（最小化/最大化/关闭/状态推送）
│   ├── appWindow.ts # App 子窗口管理（单开聚焦/多开序号/主机关闭全关）
│   ├── capabilities.ts # 能力服务：应用信息、用户扩展扫描/卸载/卸载钩子
│   ├── oix.ts       # .oix 扩展包安装（校验 + 防路径穿越解压 + 安装 IPC）
│   └── protocol.ts  # app:// 自定义协议（用户扩展 ESM 加载 + 静态资源）
├── preload/         # contextBridge 桥：window.api（能力）+ window.events（主进程事件）
├── shared/          # 三端共享类型（IPC 契约）
└── renderer/        # Vue 渲染进程（扩展宿主所在地）
    └── src/
        ├── main.ts        # 入口：启动扩展宿主 → 按 URL 参数渲染主布局或 AppWindow
        ├── App.vue        # 主布局（标题栏/导航栏/内容栏/状态栏 + 命令面板）
        ├── AppWindow.vue  # App 子窗口布局（TitleBar + iframe 内容 + postMessage 窗口控制桥）
        ├── components/    # TitleBar / NavBar / ContentArea / StatusBar / CommandPalette
        ├── core/          # 扩展系统核心（见下）
        └── extensions/    # 内置扩展目录（每个扩展 = manifest.json + index.ts + 视图组件）
extensions/          # 用户扩展独立项目（仅依赖扩展 API，经 .oix 分发；如 todo/）
```

### 扩展系统核心（`renderer/src/core/`）

| 文件 | 职责 |
|---|---|
| `types.ts` | 扩展 API 类型：`ExtensionActivationApi`、`AppRegistration`、贡献点类型（含 themes/settings/i18n）、Memento/Disposable |
| `host.ts` | 扩展宿主：两阶段启动（注册贡献点 → 释放 barrier → 激活）、依赖拓扑排序、热安装/热移除/禁用卸载重启生效 |
| `manifest.ts` | 清单校验（name/version/main 必填、semver、依赖检测）+ 错误收集 |
| `registry.ts` | 贡献点注册表：导航项/状态栏项/命令 + 视图组件表（Vue reactive） |
| `loader.ts` | 内置扩展 Vite 静态收集 + 用户扩展 app:// 运行时加载 |
| `state.ts` | 状态持久化（userData JSON）：禁用列表、上次导航项、Memento、**统一设置存储（主题/快捷键/扩展设置）** |
| `appStore.ts` | App（应用）插件卡片注册表（reactive + 持久化 + 停用清理） |
| `theme.ts` | 主题系统：收集 themes 贡献、套用 CSS 变量到 :root、持久化当前主题 |
| `keybindings.ts` | 快捷键系统：内置快捷键注册表、修改、冲突检测、持久化 |
| `extensionSettings.ts` | 扩展设置页注册表（api.settings.register / manifest 声明） |
| `extensionI18n.ts` | 扩展语言包注册表（api.i18n，与宿主语言包独立命名空间） |

### i18n（`renderer/src/i18n/`）

- vue-i18n 11 实例 + 中英语言包（`locales/zh.ts` / `en.ts`）
- 切换立即生效 + 持久化；语言下拉显示各语言本地化名称（中文 → "中文"、English → "English"）
- 覆盖宿主布局框架 + 内置扩展全部文案；扩展经 `api.i18n` 使用自己的语言包

### 内置扩展（`renderer/src/extensions/`）

- `ext-manager/`：扩展管理器——Grid 展示已安装扩展，详情页（Identifier/Source/Last Updated/校验信息），安装（.oix 按钮/拖拽，**热生效**）、禁用/卸载（未激活热移除，已激活弹"立即重启"）、默认隐藏内置扩展（"显示内置"开关）
- `app/`：应用（App）——其他扩展经 `api.app.register` 注册插件卡片，Grid 展示，点击弹出独立子窗口（URL 或 HTML srcdoc + iframe + postMessage 窗口控制桥，**srcdoc 自动注入主题变量**）
- `settings/`：设置——左侧树（外观/语言/快捷键/扩展）+ 右侧配置表单；主题下拉（主题扩展贡献）、语言下拉、快捷键修改、扩展设置项
- `theme-dark/`、`theme-light/`：主题扩展（contributes.themes 声明 CSS 变量组），设置"外观"选择

### 用户扩展（`extensions/`）

- 独立项目，仅依赖扩展 API；以 **.oix**（zip）分发，扩展管理器安装（**热生效**）
- **源码独立仓库托管**：每个扩展在 `github.com/obox-org/<扩展id>` 独立仓库维护（如 [obox-org/todo](https://github.com/obox-org/todo)），obox 仓库不持有扩展源码（`extensions/` 已 gitignore，本地保留副本供开发/打包）
- `todo/`：待办扩展（作者 chenzhi）——App 卡片打开独立子窗口，内含 Vue 子应用（左侧边栏：我的一天/全部待办/日历/标签 CRUD + 内容栏：快速添加/勾选/行内编辑/优先级），数据 localStorage 持久化（app:// 源）

## 常用命令

| 命令 | 说明 |
|---|---|
| `yarn dev` | 开发模式（HMR，Electron 窗口自动打开） |
| `npm run typecheck` | 类型检查（node 主进程 + web 渲染进程） |
| `npm run lint` | ESLint 检查（0 errors 为门槛） |
| `npm run build` | typecheck + electron-vite 构建到 `out/` |
| `npm run build:win` | 打包 Windows 安装包（electron-builder） |
| `npm run format` | Prettier 格式化 |
| `npm run build:todo` / `pack:todo` / `dev:todo` / `release:todo` | 待办用户扩展：构建子应用 / 打包 .oix / 子应用 watch / typecheck+build+pack（在 `extensions/todo/` 内执行） |
| `node skills/obox-ext-dev/scripts/create-extension.mjs <id>` | 生成新内置扩展骨架 |
| `node skills/obox-ext-dev/scripts/validate-manifest.mjs --all` | 校验全部内置扩展 manifest |

## 快速上手（新会话必读）

1. **读本文件**：了解项目概览与架构（上文）
2. **读约定**：`AGENTS.md`（开发约定 + 强制提交流程）、`CONTEXT.md`（术语表）
3. **运行**：`yarn dev` 启动应用，观察布局与内置扩展（导航栏"扩展"和"应用"入口）
4. **改扩展**：按 `skills/obox-ext-dev/SKILL.md` 流程——manifest 声明贡献点 → 入口绑定命令实现/注册 App 卡片 → `npm run typecheck && npm run lint` → 提交。**用户扩展**：`extensions/<id>/` 独立项目，`npm run release` 产出 .oix，扩展管理器安装（重启生效）
5. **改架构**：改动 `core/`、`src/main/*`、IPC、贡献点 schema 后，**必须同步更新** `skills/obox-ext-dev/` 文档（见 AGENTS.md 约定）和本文件

## 文档导航

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 本文件：项目概览 / 快速上手（导航入口，不重复细节） |
| [CONTEXT.md](CONTEXT.md) | 术语表（Title Bar/导航栏/内容栏/状态栏/扩展/贡献点/命令/App 等） |
| [AGENTS.md](AGENTS.md) | 开发者约定：obox-ext-dev 文档同步要求 + 强制提交流程（五步）+ 质量门槛 |
| [skills/obox-ext-dev/SKILL.md](skills/obox-ext-dev/SKILL.md) | 扩展开发完整指南（含 references/ 与 scripts/） |
| [docs/adr/](docs/adr/) | 架构决策记录（渲染进程宿主/声明式贡献点/禁用重启生效/两阶段启动/oix 分发与安装） |

## 技术栈

- **Electron** 39 + **Vue** 3.5 + **TypeScript** 5.9（electron-vite 5 构建）
- **@cordisjs/core** 3.18（扩展宿主插件框架，运行在渲染进程）
- 无 UI 组件库：手写 CSS 暗色主题（VS Code 风格）
