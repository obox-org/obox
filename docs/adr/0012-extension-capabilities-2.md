# 扩展能力扩展（二批）：网络、文件系统、对话框、快捷键、剪贴板、环境、主题、任务栏进度

在一批（sqlite/timer/notification，ADR 0011）基础上再给扩展 API 增加：`api.net`（网络请求）、`api.fs`（文件系统，限定扩展数据目录）、`api.dialog`/`api.shell`/`api.clipboard`/`api.env`/`api.theme`/`api.window.setProgressBar`，以及 manifest 贡献点 `contributes.keybindings`（快捷键）。

## 背景与问题

1. **扩展无法联网**：渲染进程 CSP（`default-src 'self' app:`，无 connect-src）禁止 fetch 外部网络——扩展要访问第三方 API 必须走主进程。
2. **无文件系统**：扩展只能经 sqlite/Memento 存数据，无法读写自己的非结构化文件（导入导出/日志/配置）。
3. **无交互能力**：对话框（文件选择/消息框）、打开外部链接、剪贴板、任务栏进度都没有。
4. **快捷键只有内置**：扩展命令只能从命令面板/状态栏触发；App.vue 的快捷键分发只响应内置命令面板。

## 决策

1. **网络走主进程**（`api.net.fetch`）：主进程 Node fetch + 自动应用设置-网络代理（env 变量，与更新下载一致）+ 默认 30s 超时 + AbortController；返回 `{ok, status, data?}`（按 Content-Type 解析 JSON/文本，`json:true` 强制）。渲染进程保持 CSP 收紧。
2. **文件系统限定扩展数据目录**（`api.fs`）：与 sqlite 完全一致的安全模型——相对路径解析到 `userData/extensions/<扩展id>/data/`，拒绝绝对路径/`..`/盘符；readFile/writeFile/readDir/exists/remove，自动建目录。**不开放任意路径读写**（恶意/缺陷扩展不可读系统文件）；dialog 选到的外部路径不可用 api.fs 读写。
3. **对话框/外链/剪贴板/进度条**：Electron 现成能力薄封装（dialog/shell/clipboard/BrowserWindow.setProgressBar）；openExternal 仅限 http/https。
4. **快捷键用 manifest 贡献点**（`contributes.keybindings`）：复用宿主 keybindingStore——自动获得冲突检测、用户可改、设置页展示、持久化；command 必须已在 contributes.commands 声明（否则 warning 跳过）；注册时默认键冲突则 warning 跳过。App.vue 全局快捷键分发改为通用执行（`host.executeCommand`，命令面板特例保留）。
5. **api.env 静态值走 preload**（process.platform/arch/versions.node 直接暴露，无需 IPC）；api.theme 纯渲染侧（读 themeStore + 设置变更订阅）。
6. **apiVersion 不递增**（保持 1）：全部纯新增，无破坏性变更（符合 ADR 0010）。

## 备选与权衡

- 开放渲染 fetch（放宽 CSP connect-src）：省主进程中转，但绕过代理体系且扩大攻击面 → 否定，走主进程 + 代理。
- api.fs 任意路径：能力最大但可读系统任意文件 → 否定，限定扩展 data 目录。
- 快捷键运行时 API（api.keybindings.register）：与现有 keybindingStore 两套并存、无设置页/持久化 → 否定，用 manifest 声明复用宿主体系。
- 新建窗口（api.window.create）：多窗口用 api.app.register 插件卡片子窗口已覆盖 → 不做。

Status: accepted
