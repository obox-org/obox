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
内置扩展，以 Grid 网格展示已安装扩展（名称/版本/作者/简介），点击查看详情，支持**安装（.oix 按钮/拖拽）**、禁用/卸载/搜索/排序/来源标注。

**User Extension / 用户扩展**:
经 .oix 安装到 `userData/extensions/<name>_<author>/` 的扩展（非内置，可卸载）。入口须为纯 ESM JavaScript（宿主动态 import，无构建转换）；静态资源经 `app://extensions/<id>/` 由 App 子窗口 iframe 加载。
_Avoid_: 插件

**Debug Extension / 调试扩展**:
经 `obox --debug-extension <id>@<本地目录>` 声明的扩展：不写 userData、不做 .oix 安装、无安装时间戳，经 `app://debug/<id>/` 协议从本地目录直接加载，重启后消失；扩展管理器显示"调试中"、不可卸载。配合 `--remote-debugging-port`（CDP）可在 VS Code 中打断点调试，扩展仓库无需依赖 obox 源码。
_Avoid_: 开发扩展、测试扩展

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

**API Version / API 版本**:
obox 对外扩展 API 的版本号，**单个非负整数**，单源定义在根 `package.json` 的 `apiVersion` 字段（当前 `1`）。扩展在 manifest 里声明 `apiVersion` 声明其要求的版本：缺失视为 `0`（兼容所有），**高于 obox 当前版本时拒绝加载**；仅在新版 API 破坏性变更时递增，高版本 obox 始终兼容低版本扩展。
_Avoid_: 版本字符串、API level

**Cordis**:
本项目采用的插件框架，扩展宿主运行在渲染进程，扩展基于其服务注入 + 事件总线运行。

**Memento**:
扩展的状态存储 API（workspaceState/globalState），get/update 键值，底层存 userData JSON。

**oix / 扩展包**:
用户扩展的分发格式，本质是 zip 压缩包（根目录含 manifest.json + 入口 + 静态资源）。宿主校验 manifest、防路径穿越解压、覆盖安装，重启后生效。
_Avoid_: 安装包、插件包

**Todo / 待办**:
内置待办扩展（`extensions/todo`，以用户扩展形态经 .oix 分发）。一条待办含标题、备注、截止日期（仅日期粒度）、完成态、优先级（高/中/低）、标签引用。
_Avoid_: 任务、事项

**My Day / 我的一天**:
待办视图：未完成 且（今天到期 或 逾期未完成），逾期带标记。

**All Todos / 全部待办**:
待办视图：默认未完成（优先级 + 截止日期排序），已完成默认隐藏、可切换显示。

**Calendar / 日历**:
待办视图：月视图网格（周一开头），有待办的日期打点，点日期查看当日待办，今日高亮可回跳。

**Tag / 标签**:
待办的自定义分类：名称 + 颜色（色板），可新增/重命名/改色/删除；删除标签保留待办、仅清除引用。

**Priority / 优先级**:
待办字段：高/中/低（默认中），列表按优先级 + 截止日期排序。

**Disposable**:
扩展 API 的统一清理形状，所有注册 API 返回 dispose()；扩展上下文的 subscriptions 数组在停用时统一释放。

**System Notification / 系统提醒**:
经 `api.notification.show` 调用操作系统通知 API（Windows Toast / macOS 通知中心）弹出的提醒；点击通知宿主自动聚焦主窗口并回调扩展。设置-通知可**逐扩展关闭**（关闭后该扩展不再弹出）。
_Avoid_: 弹窗、应用内提醒

**Database / 数据库**:
扩展经 `api.sqlite.open(name)` 打开的 SQLite 数据库（宿主内置 node:sqlite 驱动，零依赖）。`name` 为**相对路径**，解析到该扩展自己的数据目录 `userData/extensions/<扩展id>/data/`（宿主自动建目录，天然按扩展隔离）；首次写入自动建表（id 主键，列按类型推断）。表集合操作 + 结构体匹配（等值 AND）+ `exec`/`query` 支持 SQL。
_Avoid_: 数据库路径、数据文件

**Global Timer / 全局定时器**:
经 `api.timer` 使用的宿主级定时器，运行在**主进程**（不受渲染进程后台节流影响），间隔为**整数秒**（≥1s）；按扩展隔离，扩展停用自动清理。与扩展自己 `setTimeout` 的区别：后者在渲染进程，窗口最小化时被节流到 1 秒粒度。
_Avoid_: 系统定时器、计划任务
