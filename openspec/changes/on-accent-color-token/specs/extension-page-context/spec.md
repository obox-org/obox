# Spec Delta

## MODIFIED Requirements

### Requirement: 统一的页面上下文消息

宿主 SHALL 向扩展页面发送单一形状的 `obox:context` 消息，字段固定为 `type`、`version`、`themeId`、`colorScheme`、`tokens`、`locale`、`messages`。`tokens` MUST 是当前生效值（`main.css` 默认值 + 当前主题覆盖）的**全部主题 token**（当前 26 个，含新增的语义对比色 token `--fg-on-accent`），而不是主题声明值；数量以 `main.css` 的 `:root` 键集合为准，规格不再逐次跟进具体数字。`messages` MUST 只包含接收页面所属扩展自己的词条。

#### Scenario: 推送载荷是生效值

- **WHEN** 当前主题只声明了 `--bg`，宿主向扩展页面推送上下文
- **THEN** `tokens` 仍包含全部主题 token（当前 26 个），未声明的键取 `main.css` 默认值
- **AND** 键名形如 `--bg`（已带 `--` 前缀），值非空字符串

#### Scenario: 词条按扩展隔离

- **WHEN** 扩展 A 的页面打开，宿主推送上下文
- **THEN** `messages` 只包含 A 在 `contributes.i18n` 中声明的词条
- **AND** 不包含扩展 B 的任何词条

#### Scenario: 主题没有扩展时也能推送

- **WHEN** 用户没有安装任何主题扩展
- **THEN** `themeId` 为空串
- **AND** `tokens` 仍然是全部默认值（当前 26 个），页面得到与宿主一致的配色

#### Scenario: 新增 token 不要求页面改动

- **WHEN** 宿主新增一个主题 token（如 `--fg-on-accent`）后向**旧版本**扩展页面推送上下文
- **THEN** 旧页面可以完全忽略这个多余键，渲染结果与之前一致
