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

**Main Window / 主窗口**:
承载导航栏/内容栏/状态栏的主 BrowserWindow，扩展在其中被激活（`plugin(api)` 只在这里执行一次）。与 App 子窗口相对；关闭或最小化它默认按"关闭行为"收进托盘。
_Avoid_: 主界面、首页窗口

**Taskbar / 任务栏**:
Windows 上显示运行中窗口与开始按钮的系统横条。obox **主窗口不在任务栏显示**（`skipTaskbar`），App 子窗口仍正常显示。
_Avoid_: 托盘（托盘指通知区域里的图标，两者不同）

**Notification Area / 通知区域**:
Windows 任务栏右端的系统区域，常驻程序在此放图标（口语称"系统托盘"）。obox 的托盘图标落在这里。
_Avoid_: 系统托盘区、任务栏

**Tray / 托盘**:
obox 在通知区域的常驻图标（**仅 Windows**）：**左键单击无任何行为**、**双击**打开主窗口、**右键**弹出托盘菜单（打开/设置/关于/退出）。悬停提示会写明"双击打开 / 右键菜单"（单击无反馈，靠它弥补）。Windows 11 默认把新图标收进"隐藏图标浮出层"，用户可能要先点任务栏托盘区的 `^` 才看得到。
_Avoid_: 系统托盘、任务栏图标

**Hide to Tray / 收进托盘**:
把主窗口 `hide()`（**不销毁**，状态保留）并只留托盘图标；与"最小化（minimize，通常仍在任务栏显示）"不同。obox 的关闭按钮与最小化按钮都触发它。
_Avoid_: 最小化到托盘（易与 minimize 混淆）

**Close Behavior / 关闭行为**:
用户偏好，三态——`询问`（关闭时弹原生提示让用户选）、`收进托盘`、`退出`；默认 `询问`，提示里勾选"记住"后写入偏好。设置-通用（仅 Windows 显示）。
_Avoid_: 关闭策略、退出方式

**Single Instance / 单实例**:
同一时刻只允许一个 obox 进程；再次启动只把已有主窗口唤到前台，其启动参数被忽略。
_Avoid_: 互斥锁、唯一实例

**Launch at Login / 开机自启**:
用户偏好（**仅 Windows**，默认关，设置-通用）：登录后在后台启动 obox。**静默启动**——不显示主窗口、只出现在托盘；
实现方式为启动项带 `--autostart` 参数（Electron 44 已移除 `openAsHidden`，Windows 无系统级"由登录项启动"标识）。
开发版不注册；卸载时清理启动项。
_Avoid_: 开机启动项、自启动服务

**Silent Start / 静默启动**:
由开机自启拉起的启动形态：不显示主窗口、不弹提示，只创建托盘图标（与"手动启动"的差别仅此一处）。
_Avoid_: 后台启动、守护进程

**App Preferences / 通用设置**:
主进程持有的应用偏好（`userData/app-preferences.json`），当前含**关闭行为**与**开机自启**；设置-通用读写，
**系统真实状态**（如任务管理器里的启动项启用状态）为准并回写。
_Avoid_: 窗口配置、用户配置

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
用户扩展的分发格式，本质是 zip 压缩包（根目录含 manifest.json + 入口 + 静态资源）。宿主校验 manifest、防路径穿越解压，**安装（含同名覆盖）热生效**——立即注册贡献点并激活，无需重启；禁用/卸载已激活的扩展才需要重启。
_Avoid_: 安装包、插件包

**Sidecar / 边车**:
扩展通过 `api.ipc` 通信的外部进程：可以由宿主拉起，也可以是已在运行的本地进程。协议与通道由宿主管理。
_Avoid_: 对端（那是"通道另一端"的泛称，可能是边车也可能不是）、子进程（只涵盖宿主拉起的那一种）

**Python Runtime / Python 运行时**:
obox 侧管理、供扩展执行 Python 代码的运行时，与具体扩展解耦，并按平台与 CPU 架构区分。
_Avoid_: Python 解释器（口语可用，术语统一用"运行时"）

**Python 环境 / Python Environment**:
某个扩展的 Python 三方库落点：由该扩展在运行时安装三方库形成，与解释器本体分开保管，扩展升级时被保留（除非声明的运行时版本发生变化）。
_Avoid_: 解释器、运行时（那是共用的本体）

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

## 扩展开发流程（obox-ext 九步链）

**Stage Chain / 九步链**:
扩展开发的固定阶段顺序：**init → grill → proposal → design → validation → task → dev → check → ship**，每步一个独立技能（`obox-ext-*`），上一步的产物是下一步的输入。
_Avoid_: 流水线、pipeline

**Gate / 门禁**:
每个阶段结尾对用户的提问，固定四选项：**通过并自动进入下一步 / 部分修改后重跑本步 / 回到上一步 / 暂停**。任何阶段都不得跳过门禁自行推进。
_Avoid_: 确认框、检查点

**Change / 变更**:
一次需求在扩展工程 `openspec/changes/<change-id>/` 下的产物集合，含官方四件套（proposal / design / tasks / specs）与自研产物（`notes/`）。
_Avoid_: 任务、工单

**Change ID**:
变更的机器标识，**lower-case kebab-case 英文短名**（OpenSpec 强制：禁大写、下划线、连续连字符、中文）。用于目录名与 `openspec validate`。
_Avoid_: 变更名、需求号

**UID / 归档标识**:
变更的人读标识，形如 `UID-{YYYYMMDDHHmmss}-{≤10字中文描述}`，用作交付归档目录名；与 Change ID **双向映射**（change 的 `.openspec.yaml` 记 `uid`，归档的 `index.md` 记 `change-id`）。
_Avoid_: 编号、序号

**Feature Archive / 交付归档**:
`ship` 阶段写入 `<扩展工程>/docs/spec/UID-…/` 的最终产物副本（含 proposal / design / tasks / spec delta / validation / check 报告与映射 `index.md`），面向人阅读与随扩展发版。
_Avoid_: 备份、导出

**API Common Home / API 公共目录**:
仓库级 `docs/extension-api/`，是扩展 API、manifest 贡献点与主题/设置文档的**唯一真相**；九步链的 proposal / design / validation / dev 等阶段都引用它，不在扩展工程内保留副本。
_Avoid_: API 文档、接口清单

**Finding Grade / 问题三档**:
`validation` 与 `check` 对发现的结论分级：**一般建议 / 普通问题 / 严重问题**；每条附修复意见，随后按档提问——严重问题逐条问、普通问题合并为一次多选、一般建议默认登记并在门禁统一问一次。
_Avoid_: 缺陷等级、bug 级别
