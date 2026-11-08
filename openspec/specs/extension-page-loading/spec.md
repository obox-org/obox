# extension-page-loading Specification

## Purpose
扩展页面（App 卡片窗口与 overlay 浮层里的 iframe）必须能可靠加载；当卡片注册的地址不可用时，宿主必须把"为什么打不开"直接告诉用户与扩展作者，而不是留下一片空白。

## Requirements

### Requirement: 旧式 `file://` 卡片地址的等价归一化

宿主 SHALL 在把卡片地址交给 iframe 之前，把指向扩展目录内页面的 `file://` 地址归一化为等价的 `app://` 地址；对无法判定归属的地址 MUST NOT 猜测其映射。

#### Scenario: 安装在用户扩展目录的旧卡片

- **WHEN** 卡片注册的 url 是 `file:///C:/Users/<用户>/AppData/Roaming/obox/extensions/rdp.chenzhi/ui/index.html`
- **THEN** iframe 实际加载 `app://extensions/rdp.chenzhi/ui/index.html`
- **AND** 控制台输出一条 `[AppWindow]` 前缀的警告，同时含原始地址与归一化后的地址

#### Scenario: 调试扩展的本地目录

- **WHEN** 卡片 url 是 `file:///D:/work/my-ext/ui/index.html`，而 `D:/work/my-ext` 正是通过 `--debug-extension` 注册的目录
- **THEN** 归一化为 `app://debug/<该扩展 id>/ui/index.html`

#### Scenario: 不属于任何扩展目录

- **WHEN** 卡片 url 是 `file:///C:/temp/whatever.html`（不在任何扩展根目录内）
- **THEN** 不做归一化，改走「不可用地址」的诊断路径

#### Scenario: 已经是 `app://` 的地址

- **WHEN** 卡片 url 已是 `app://extensions/rdp.chenzhi/ui/index.html`
- **THEN** 原样加载，不产生任何警告

### Requirement: 不可用地址的诊断态

当卡片地址不是可加载的 `app://` 地址（协议不符、或归一化后仍无法确定目标）时，内容区 SHALL 渲染诊断信息，MUST NOT 渲染空白 iframe。诊断内容 MUST 包含应用名或扩展 id、原始地址、失败原因与修复提示。

#### Scenario: `http(s)` 地址

- **WHEN** 扩展注册的卡片 url 是 `https://example.com/`
- **THEN** 内容区显示诊断块：标题、原始 url、原因「仅支持 `app://` 协议」、提示「改用 `appPageUrl()` 或 `app://extensions/<安装目录名>/…`」

#### Scenario: 卡片既无 url 也无 html

- **WHEN** 卡片没有 url 也没有 html
- **THEN** 显示既有的空态提示（行为不变），不显示诊断块

#### Scenario: 归一化失败的 `file://`

- **WHEN** 卡片 url 是 `file:///C:/temp/whatever.html`
- **THEN** 内容区显示诊断块，原因写明「`file://` 会被 CSP 拦截，且无法判定它属于哪个扩展」

### Requirement: 未加载时的底色跟随主题

App 卡片窗口的 iframe 底色 SHALL 使用主题背景 token，MUST NOT 固定为白色；页面未加载、加载失败或被拒绝时不得出现整块亮白。

#### Scenario: 深色主题下页面尚未加载

- **WHEN** 当前主题的 `--bg` 是 `#1e1e1e`
- **THEN** iframe 未加载完成时的底色与主题一致，不出现白色块

#### Scenario: 浅色主题

- **WHEN** 当前主题的 `--bg` 是 `#f3f3f3`
- **THEN** iframe 底色随之变为浅灰，而不是纯白

### Requirement: 诊断与归一化各只告警一次

归一化与拒绝 MUST 各只输出一条警告；同一次窗口生命周期内同一地址重复判定 MUST NOT 重复刷屏。警告前缀固定为 `[AppWindow]`，以便经 `console-message` 转发到主进程终端后检索。

#### Scenario: 重渲染导致重复判定

- **WHEN** 因主题或语言变化导致同一非法地址被判定多次
- **THEN** 控制台仍只有一条对应警告
