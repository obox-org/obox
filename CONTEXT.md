# Obox

一个基于 Electron + Vue + TypeScript 的桌面程序宿主。以布局框架为骨架，通过扩展系统（基于 Cordis，仿照 VS Code 扩展模型）向应用贡献功能。

## Language

**Title Bar / 标题栏**:
窗口顶部横条区域，右侧包含最小化、最大化、关闭三个窗口控制按钮。无边框窗口自绘，支持拖拽、双击最大化、失焦变灰、fullscreen 隐藏控件。
_Avoid_: 菜单栏、工具栏

**Navigation Bar / 导航栏**:
窗口中部左侧竖条，仅显示图标，悬停显示名称，点击在内容栏渲染对应视图。顶部组为可排序业务导航，底部组为固定全局区（扩展管理器入口等），支持数字徽标。
_Avoid_: 侧边栏、Activity Bar

**Content Area / 内容栏**:
窗口中部右侧区域，渲染当前导航项对应的视图组件（keep-alive 保留状态）。

**Status Bar / 状态栏**:
窗口底部横条，左右分区 + primary/secondary 两级优先级排序，扩展可贡献可点击的条目。
_Avoid_: 状态条

**Extension / 扩展**:
为宿主贡献能力的可插拔单元。清单（manifest）声明贡献点（导航项、状态栏项、命令），宿主导入后统一解析注册；入口导出 Cordis 插件函数 + 具名导出视图组件。
_Avoid_: 插件、模块

**Extension Manager / 扩展管理器**:
内置扩展，以 Grid 网格展示已安装扩展（名称/版本/作者/简介），点击查看详情，支持禁用/卸载/搜索/排序/来源标注。

**App / 应用**:
内置扩展（中文名"应用"）。其他扩展可向它注册"插件卡片"（icon/名称/版本/作者/简介 + 内容 URL/HTML），App 以 Grid 网格展示，点击卡片弹出独立子窗口渲染插件内容。导航项位于顶部组。
_Avoid_: 应用中心、应用市场

**App Registration / 插件卡片**:
扩展经 `api.app.register` 注册进 App 的条目。含多开开关（multiOpen）、子窗口尺寸（width/height）等配置。

**App Window / 子窗口**:
点击插件卡片弹出的独立 BrowserWindow（无边框）。加载同一渲染入口（`?obox-window=app&appId=xxx`），复用 TitleBar 组件（标题=插件名），内容栏用 iframe 渲染插件提供的 URL 或 HTML（srcdoc）。主窗口关闭时一并关闭。
_Avoid_: 弹窗、模态框

**Contribution Point / 贡献点**:
扩展在 manifest 中声明的能力注册点（导航项、状态栏项、命令），由宿主解析注册。
_Avoid_: 插件点、扩展点

**Command / 命令**:
扩展注册的可执行动作，有全局唯一 id（`<扩展名>.<动作>`），可从命令面板（Ctrl+Shift+P）、其他扩展、状态栏项触发。

**Cordis**:
本项目采用的插件框架，扩展宿主运行在渲染进程，扩展基于其服务注入 + 事件总线运行。

**Memento**:
扩展的状态存储 API（workspaceState/globalState），get/update 键值，底层存 userData JSON。

**Disposable**:
扩展 API 的统一清理形状，所有注册 API 返回 dispose()；扩展上下文的 subscriptions 数组在停用时统一释放。
