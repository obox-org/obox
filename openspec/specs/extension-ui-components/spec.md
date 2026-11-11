# extension-ui-components Specification

## Purpose
宿主提供一套预编译、随包分发的组件样式，让扩展页面不必自造外观就能与 obox 保持一致；这套样式只消费主题 token，因此切换主题时扩展页面自动跟随。

## Requirements

### Requirement: 组件样式表可被扩展页面加载

宿主 SHALL 通过 `app://obox/ui.css` 提供一份随安装包分发的预编译组件样式表。该地址 MUST 在打包版与开发版都可用，且 MUST 支持以 `<link rel="stylesheet">` 直接引用。

#### Scenario: 打包版加载

- **WHEN** 扩展页面在打包版 obox 中写入 `<link rel="stylesheet" href="app://obox/ui.css">`
- **THEN** 样式表加载成功（HTTP 语义上等价于 200），按钮等组件呈现库内定义的外观

#### Scenario: 开发版加载

- **WHEN** 同一页面运行在 `npm run dev` 的开发版中
- **THEN** 该地址同样可用，指向仓库内的同一份源文件

#### Scenario: 地址穿越

- **WHEN** 页面请求 `app://obox/../obox/ui.css` 或 `app://obox/%2e%2e/ui.css`
- **THEN** 宿主返回 4xx，不返回扩展目录之外的文件

### Requirement: 页面运行时自动注入

`startPageContext()` SHALL 默认注入该样式表，注入 MUST 幂等；调用方可传 `disableUiCss: true` 明确关闭。

#### Scenario: 默认注入

- **WHEN** 页调用 `startPageContext({ onChange })` 而不传 `disableUiCss`
- **THEN** 文档 `head` 中出现且仅出现一个指向 `app://obox/ui.css` 的 `<link>`

#### Scenario: 重复启动

- **WHEN** 同一文档内 `startPageContext` 被调用两次
- **THEN** 仍然只有一个该 `<link>`（不重复注入）

#### Scenario: 显式关闭

- **WHEN** 页调用 `startPageContext({ disableUiCss: true })`
- **THEN** 不注入任何样式表，页面自带的样式照常工作

### Requirement: 组件以 obox- 前缀暴露且状态用语义属性

组件 MUST 以 `obox-` 前缀的 class 暴露，并通过 `aria-*` / `data-*` 表达状态；MUST NOT 要求页面添加 `is-*` 之类的私有状态类。

#### Scenario: 按钮变体与尺寸

- **WHEN** 页面写 `<button class="obox-btn obox-btn--primary obox-btn--sm">`
- **THEN** 呈现主色小号按钮；`obox-btn--danger` / `--ghost` / `--text` / `--dashed` / `--link` 与 `--lg` 同规则生效

#### Scenario: 禁用与加载

- **WHEN** 按钮带 `aria-disabled="true"`，或带 `data-loading="true"`
- **THEN** 分别呈现禁用外观（不可点感）与加载外观（转圈占位、文本变淡），且都不改变 disabled 之外的布局尺寸

#### Scenario: 表单错误态

- **WHEN** 输入框带 `aria-invalid="true"`
- **THEN** 边框与辅助文字转为错误色，且不只是颜色变化（同时有图标或边框样式差异）

### Requirement: 组件库只消费主题 token

组件库中所有颜色、边框、阴影、字体 MUST 取自主题 token（`--bg`、`--fg`、`--accent`、`--border`、`--fg-error` 等）；MUST NOT 在组件规则里写死十六进制色值。主题切换 MUST 在不重载样式表的情况下立即改变组件外观。

#### Scenario: 深色切换到浅色

- **WHEN** 当前主题从 `theme-dark` 切到 `theme-light`
- **THEN** 使用组件库的页面里按钮、输入框、卡片底色随之变化，页面无需重新加载样式表

#### Scenario: 无主题扩展

- **WHEN** 没有任何主题扩展注册
- **THEN** 组件回落到 `main.css` 的 `:root` 默认值，仍可正常显示

### Requirement: 组件覆盖面

组件库 MUST 覆盖布局、排版、按钮、表单、数据展示、反馈与导航七类组件；每类 MUST 至少包含下列成员，且每个成员都支持禁用态与至少一种尺寸或变体。

#### Scenario: 布局与排版

- **WHEN** 页面使用布局与排版组件
- **THEN** 可用：容器/侧栏/头部/内容区、栅格（12 分段 + gap）、分隔线、标题（h1–h4）、正文与辅助文本、链接、行内代码、键盘键帽

#### Scenario: 表单

- **WHEN** 页面使用表单组件
- **THEN** 可用：表单项（标签/必填标记/帮助文字/错误文字）、输入框（前缀/后缀/尺寸）、文本域、下拉选择、复选、单选、开关、数字输入、日期/时间输入、按钮组

#### Scenario: 数据展示

- **WHEN** 页面展示数据
- **THEN** 可用：卡片、列表（含紧凑/带分隔）、表格（边框/斑马纹/悬停/紧凑）、标签、徽标、头像、进度条、统计数值、描述列表、空态、骨架屏

#### Scenario: 反馈

- **WHEN** 页面需要提示反馈
- **THEN** 可用：警告条（info/success/warning/error）、加载指示器、模态框外观（遮罩/面板/头/体/脚）、抽屉外观、气泡与悬停提示外观

#### Scenario: 导航

- **WHEN** 页面需要导航类组件
- **THEN** 可用：标签页（含选中态）、面包屑、分页、步骤条、树形节点（含选中/展开）、分段控件、下拉菜单外观

### Requirement: 只提供样式，不提供交互行为

组件库 MUST 是纯 CSS：MUST NOT 注入或要求加载任何脚本，MUST NOT 接管 DOM 事件；需要开合、切换、定位的组件只提供外观与状态属性约定。

#### Scenario: 弹窗开合由页面负责

- **WHEN** 页面需要显示模态框
- **THEN** 页面自己控制其显示与销毁（加/去 class 或节点），组件库只决定它长什么样

#### Scenario: 未引入脚本

- **WHEN** 页面只引入 `app://obox/ui.css`
- **THEN** 不产生任何网络请求之外的副作用（无全局变量、无事件监听、无 MutationObserver）

### Requirement: 三个系统扩展页使用组件库

`app`、`settings`、`ext-manager` 三个系统扩展页 SHALL 使用组件库实现通用外观；各页 `page.css` MUST NOT 再重复定义库内已提供的组件样式。

#### Scenario: 设置页不再自定义按钮

- **WHEN** 检查 `system-extensions/settings/page.css`
- **THEN** 其中不含按钮、输入框、下拉框的通用外观规则（只保留布局与页面专有样式）

#### Scenario: 三页主题联动

- **WHEN** 在设置页把主题切到浅色
- **THEN** 三页的所有组件同时变浅，无需各自改 CSS

### Requirement: 不污染宿主与页面既有样式

组件库 MUST NOT 使用无前缀的元素选择器或全局重置去改变宿主壳子与其他页面的既有外观；除库自身的尺寸变量外 MUST NOT 新增主题 token。

#### Scenario: 宿主壳子不受影响

- **WHEN** 在扩展页面引入组件库
- **THEN** 主窗口导航栏、状态栏、命令面板的样式与未引入时完全一致

#### Scenario: 未引入的页面零变化

- **WHEN** 某个扩展页面没有引用组件库
- **THEN** 它的渲染结果与引入该能力之前完全一致

### Requirement: 卡片尺寸下限与内部节奏

组件库的卡片 SHALL 提供足够的内容区留白与行间节奏：`.obox-card__body` 内边距 MUST 不小于 16px；
`.obox-card__header` / `.obox-card__footer` 上下内边距 MUST 不小于 12px、左右 MUST 不小于 16px；
卡片内相邻内容行 MUST 有不小于 12px 的间距。`.obox-card-grid` 的最小卡片宽度默认值 MUST 不小于 300px，
网格间距 MUST 不小于 16px（页面显式设置 `--obox-card-min-w` 时以页面值为准）。

#### Scenario: 内容区有标题与副行的卡片

- **WHEN** 页面渲染一张在 `.obox-card__body` 内含标题行与说明行的卡片（如 rdp 的连接卡片）
- **THEN** 内容区四周内边距不小于 16px，标题行与说明行之间间距不小于 12px，
  页眉/页脚上下内边距不小于 12px 且左右与内容区对齐

#### Scenario: 卡片网格默认宽度

- **WHEN** 卡片列表使用 `.obox-card-grid` 且页面未定义 `--obox-card-min-w`
- **THEN** 最小卡片宽度为 300px、网格间距为 16px；页面显式定义该变量时以页面值为准

#### Scenario: 字号不随尺寸变化

- **WHEN** 对比本次改动前后同一张卡片
- **THEN** 卡片内标题与说明的字号保持不变（标题 13px、说明 12px），变化的只有内边距、行间距与卡片宽度

#### Scenario: 既有卡片消费者不错位

- **WHEN** `ext-manager` 的列表行卡片与 `app` 页卡片在新尺寸下渲染
- **THEN** 内容不被裁切、不出现横向滚动条；`app` 页 `.app-card` 自身的 `padding` / `min-height` 仍以页面值为准

### Requirement: 卡片直下文本行的对齐

组件库 SHALL 支持"把文本行直接放在卡片下、不经 `.obox-card__body`"的写法：这些行的左右内边距 MUST
与页眉/页脚一致（不小于 16px），相邻直下文本行之间 MUST 有不小于 12px 的间距；最后一行直下文本与
`.obox-card__footer` 之间同样 MUST 保留不小于 12px 的间距。

#### Scenario: 网址与说明行直接挂在卡片下

- **WHEN** 页面把两行 `.obox-text` 直接放在 `.obox-card` 元素下（如 webapp 的条目卡片）
- **THEN** 两行的左右内边距为 16px（与页眉/页脚对齐），文字不贴卡片边框，两行之间间距不小于 12px

#### Scenario: 直下文本行之后紧跟页脚

- **WHEN** 最后一行直下文本的后面是 `.obox-card__footer`
- **THEN** 文本行与页脚分隔线之间有 12px 间距，分隔线不压住文字

#### Scenario: 没有直下文本行的卡片不受影响

- **WHEN** 卡片的全部内容都在 `__header` / `__body` / `__footer` 里（如 `ext-manager` 的列表行）
- **THEN** 不出现额外的内边距或空白，卡片高度只由既有规则决定
