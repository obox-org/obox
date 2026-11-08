# extension-page-context Specification

## Purpose
定义宿主向扩展页面（系统 nav 页、App `url` 卡片、overlay iframe）交付运行时上下文的契约：一次推送同时包含主题 token、`colorScheme`、语言与该扩展的语言包，并提供可选页面运行时让页面一行接入。

## Requirements

### Requirement: 统一的页面上下文消息

宿主 SHALL 向扩展页面发送单一形状的 `obox:context` 消息，字段固定为 `type`、`version`、`themeId`、`colorScheme`、`tokens`、`locale`、`messages`。`tokens` MUST 是当前生效值（`main.css` 默认值 + 当前主题覆盖）的 25 个主题 token，而不是主题声明值；`messages` MUST 只包含接收页面所属扩展自己的词条。

#### Scenario: 推送载荷是生效值

- **WHEN** 当前主题只声明了 `--bg`，宿主向扩展页面推送上下文
- **THEN** `tokens` 仍包含全部 25 个 token，未声明的键取 `main.css` 默认值
- **AND** 键名形如 `--bg`（已带 `--` 前缀），值非空字符串

#### Scenario: 词条按扩展隔离

- **WHEN** 扩展 A 的页面打开，宿主推送上下文
- **THEN** `messages` 只包含 A 在 `contributes.i18n` 中声明的词条
- **AND** 不包含扩展 B 的任何词条

#### Scenario: 主题没有扩展时也能推送

- **WHEN** 用户没有安装任何主题扩展
- **THEN** `themeId` 为空串
- **AND** `tokens` 仍然是 25 个默认值，页面得到与宿主一致的配色

### Requirement: 四个推送时机

宿主 SHALL 在以下四个时机向页面推送上下文：iframe 加载完成、主题变化、语言变化、收到页面主动发来的 `obox:context-request`。主题或语言连续变化时，宿主 MUST 保证页面最终收到最新一次状态，不做无限重放。

#### Scenario: 切换主题即时生效

- **WHEN** 用户在设置页切换主题，而某个系统扩展页正打开
- **THEN** 该页面在不重新加载的情况下收到新的 `obox:context`，`:root` 上的 token 被更新

#### Scenario: 切换语言即时生效

- **WHEN** 用户切换语言，而某个扩展页面正打开
- **THEN** 该页面收到新的 `obox:context`，其中 `locale` 与新语言一致、`messages` 为新语言词条

#### Scenario: 页面晚于推送就绪

- **WHEN** 页面在宿主首次推送之后才注册监听，主动发出 `obox:context-request`
- **THEN** 宿主再次推送当前上下文

### Requirement: 可选页面运行时

宿主 SHALL 通过 `app://obox/` 命名空间提供页面运行时脚本，页面引入后 MUST 直接得到：写入 `:root` 的 token、`documentElement.style.colorScheme`、按 key 取当前语言文案的 `t()`、以及首帧竞态下的请求重试。未引入该脚本的页面 MUST 仍然工作（手动监听消息或使用默认样式）。

#### Scenario: 一行接入即可跟随

- **WHEN** 页面引入页面运行时并启动，宿主随后切换主题与语言
- **THEN** 页面无需自定义 `message` 监听，`:root` token、`colorScheme`、`t(key)` 返回值都随上下文更新

#### Scenario: 运行时未收到上下文

- **WHEN** 页面运行时的多次重试后仍未收到 `obox:context`
- **THEN** 页面保持内置默认 token 与 `colorScheme`，不抛错、不空白

#### Scenario: 不引入运行时的老页面

- **WHEN** 一个既有扩展页面完全不修改、继续只监听旧的 `obox-theme` 消息
- **THEN** 宿主仍向其推送旧格式消息，页面行为不变

### Requirement: 老协议保留与逐步退场

新宿主 SHALL 在至少一个 minor 版本内同时发送旧的 `obox-theme` 消息（App 卡片）与 `{ type: 'obox-theme' }` 消息（系统页），直到新协议被扩展生态采用；新页面 SHALL 在检测不到 `obox:context` 时按老宿主处理（使用默认值，不报错）。

#### Scenario: 老页面在新宿主上

- **WHEN** 用户扩展的静态页面只实现了旧主题协议
- **THEN** 宿主同时推送旧格式与 `obox:context`，页面按旧协议正常接受主题

#### Scenario: 新页面在老宿主上

- **WHEN** 新页面运行在只支持旧协议的宿主（≤ 2.3.x）上
- **THEN** 页面使用内置默认 token 与默认语言渲染，不出现异常或空白

### Requirement: 主题的 colorScheme 声明

主题贡献点 SHALL 支持可选 `colorScheme: 'dark' | 'light'`；宿主 MUST 在推送上下文时优先使用该声明，未声明时才按主题 id 是否包含 `light` 推断。该值 MUST 与 `tokens` 一起下发，使页面能设置原生控件与滚动条的深浅。

#### Scenario: 主题声明浅色

- **WHEN** 主题 id 为 `solarized` 且声明 `colorScheme: 'light'`
- **THEN** 上下文里 `colorScheme` 为 `light`，页面设置 `colorScheme = 'light'`

#### Scenario: 旧主题未声明

- **WHEN** 主题没有 `colorScheme` 字段且 id 不含 `light`
- **THEN** 上下文里 `colorScheme` 为 `dark`
