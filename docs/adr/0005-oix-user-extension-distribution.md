# 用户扩展以 .oix 分发并内置安装能力

用户扩展（非内置）以 **.oix** 文件（本质 zip）分发，宿主（扩展管理器）提供安装能力（按钮 + 拖拽），App 富界面扩展采用"Vue 编译为静态资源、经 app:// 同源加载"的子应用形态。

## 背景与问题

扩展系统原本只有"内置扩展（随应用打包）+ 用户扩展（手工放置目录到 userData/extensions/）"两种形态，存在三个断点：

1. **无分发/安装通道**：用户扩展只能手工拷目录，没有打包格式与安装入口；
2. **CSP 拦截用户扩展全链路**：渲染进程 CSP 为 `script-src 'self'`，而用户扩展的 manifest 拉取（connect-src）、入口 `import('app://...')`（script-src）、App 子窗口 iframe 加载 `app://...`（frame-src）全部非 'self'，按规范都会被拦截——用户扩展链路实际不可用；
3. **App 子窗口只能渲染 iframe**：想做富界面（左侧边栏 + 内容栏）只能写原生 HTML/JS 单文件（srcdoc 内联脚本还被 CSP 拦），或改宿主支持在子窗口渲染 Vue 视图。

## 决策

1. **oix 格式**：zip 扁平布局，根目录含 `manifest.json` + 入口 + 静态资源。安装目录 = `userData/extensions/<name>_<清洗后 author>/`（author 清洗为空则退化为纯 name），目录名即宿主 id。
2. **安装能力（宿主）**：主进程校验（manifest name/version/main、入口文件存在）→ **zip-slip 防护**解压（拒绝绝对路径/`..`/反斜杠/重复条目）→ 同名覆盖（升级语义）→ 写 `.obox-meta.json` 安装时间戳。入口为扩展管理器工具栏「安装扩展」按钮（文件对话框）与**拖拽 .oix 到视图**；安装后重启生效。
3. **CSP 放行 app: scheme**：`default-src 'self' app:; script-src 'self' app:; img-src 'self' data: app:`——让用户扩展全链路可加载。这**没有新增信任边界**：用户扩展入口本就在渲染进程执行任意代码，放行只是让既有设计真正生效。
4. **App 富界面 = 编译子应用**：不扩展宿主视图模式；富界面扩展自建独立 Vue 项目（如 `extensions/todo/`），编译为经典脚本 + 静态资源，随 oix 分发，App 卡片用 `url: app://extensions/<id>/todo.html` 由 iframe 同源加载。数据在 iframe 内自持（localStorage 按 app:// 源持久化）。
5. **独立项目边界**：`extensions/<id>/` 是与 obox 仓库仅依赖扩展 API 的独立项目（自带 package.json / tsconfig / 构建 / 质量门），不进 obox 的 electron-builder 打包。

## 备选与权衡

- **宿主 App 视图模式**（AppRegistration 增 `view` 字段、子窗口直接渲染扩展导出组件）：技术栈最顺，但要改宿主渲染模型、App 概念（App Window = iframe 沙箱）动摇，文档/迁移成本高；而 iframe 沙箱本就是"插件即隔离内容"的既有心智。选择了编译子应用，代价是富界面扩展需自建构建管线、与宿主无数据桥（v1 接受）。
- **CSP 加 'unsafe-inline'**：能解决 srcdoc 内联脚本，但全局降级脚本策略，否定。
- **全内联单 HTML（srcdoc）**：`script-src 'self'` 连内联 `<script>` 块一起拦截，且 srcdoc 相对路径基于父窗口 origin，无法触及扩展目录静态资源，否定。

## 后果

- 扩展管理器新增安装能力；用户扩展开发 = 独立项目 + `npm run release`（typecheck → build → pack 出 `.oix`）。
- 冒烟验证：安装 → 重启 → 宿主日志"3 个扩展激活 3"（用户扩展经 app:// 加载激活）；子窗口 iframe 加载 `app://extensions/<id>/todo.html`，模块脚本执行、Vue 挂载、暗色 CSS、localStorage 均正常。

Status: accepted
