# Spec Delta

## Purpose

把「设置 / 应用 / 扩展管理」三个宿主界面改造成随安装包分发的**系统扩展**（author=obox），并且只通过公共 `api.*` 工作。目的是让应用界面本身也走扩展机制（统一加载、校验、主题、生命周期），同时为这些界面补上它们需要的公共能力。

## ADDED Requirements

### Requirement: 三个宿主界面作为系统扩展

`settings`、`app`、`ext-manager` MUST 以系统扩展形式存在（清单 `author` 为 `obox`），从 `<安装目录>\extensions\<name>` 加载；仓库内源码 MUST 位于 `extensions/<name>/` 并被 git 跟踪。

#### Scenario: 应用启动后的首页

- **WHEN** 应用启动且系统扩展可用
- **THEN** 首页由系统 `app` 扩展渲染，导航项来自这三个扩展声明的贡献点

#### Scenario: 系统扩展未随包安装

- **WHEN** 安装目录缺少 `app` 扩展
- **THEN** 外壳显示可读的错误页（说明缺少系统扩展），不留白屏

### Requirement: 系统扩展只能使用公共 API

三个系统扩展 MUST 只调用 `api.*` 公共能力；MUST NOT 依赖渲染进程内部单例（`host`、`stateStore`、`themeStore`、`keybindingStore`、`appStore`、`registry`）。

#### Scenario: 代码门禁

- **WHEN** 任意系统扩展源码里出现对内部单例的 import
- **THEN** 构建期或测试期失败并指出文件与依赖

### Requirement: 公共 API 增量

为支撑三个界面，MUST 新增下列公共能力并写入 `api-reference`：宿主级设置读写与变更事件、主题列表与切换、快捷键列表/设置/重置、扩展列表/启用禁用/卸载/热重载/重启宿主、卡片列表、命令与菜单查询、打开宿主页面。

#### Scenario: 设置页修改代理

- **WHEN** 系统 `settings` 扩展通过公共 API 写入宿主代理设置
- **THEN** 主进程立即生效，其它窗口通过既有设置同步收到变更

#### Scenario: 管理器禁用扩展

- **WHEN** 系统 `ext-manager` 扩展通过公共 API 禁用某用户扩展
- **THEN** 该扩展停止运行、状态持久化，重启后仍为禁用

### Requirement: 公共 API 对所有扩展可见

上述新增能力 MUST 对所有扩展可用（不设"仅系统扩展可用"的例外），与仓库既定的信任模型一致：扩展本就拥有完整运行权限，能力封装不是安全边界。

#### Scenario: 第三方扩展调用管理能力

- **WHEN** 任意用户扩展调用扩展列表/禁用接口
- **THEN** 调用成功，行为与系统扩展调用一致

### Requirement: 系统扩展的页面构建与加载

三个系统扩展 MUST 各自独立构建为静态页面产物（HTML + JS），随安装包分发；页面 MUST 通过 `app://` 协议加载，并接收宿主下发的主题 token。

#### Scenario: 主题跟随

- **WHEN** 用户切换深色/浅色主题
- **THEN** 三个系统扩展页面即时跟随，无需重启

### Requirement: 系统扩展不提供禁用/卸载入口

扩展管理器 MUST 不在系统扩展上渲染「禁用」「卸载」按钮；详情页 MUST 说明其为系统扩展。

#### Scenario: 查看系统扩展详情

- **WHEN** 在管理器中打开 `ext-manager` 自身
- **THEN** 显示「系统扩展」标识，禁用/卸载按钮不存在
