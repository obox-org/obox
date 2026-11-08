# extension-label-localization Specification

## Purpose
定义扩展贡献文本（壳子渲染的标签与扩展页面里的文案）如何本地化：词条只存于扩展自己的 `contributes.i18n`，标签用 `%key%` 占位符，由壳子按贡献所属扩展解析。

## Requirements

### Requirement: 标签的 `%key%` 占位符

manifest 中由壳子渲染的文本字段 SHALL 支持 `%key%` 形式：`displayName`、`description`、`navItems[].title`、`commands[].title`、`statusBarItems[].name`、`settings.title`、设置字段的 `label` 与 `description`、主题 `label`。解析 MUST 使用**该贡献所属扩展**的 `contributes.i18n` 词条，而不是宿主语言包；不含 `%` 的普通字符串 MUST 原样显示。

#### Scenario: 导航标题随语言切换

- **WHEN** 扩展的 manifest 写 `"title": "%nav.home%"`，`contributes.i18n.zh["nav.home"]` 为「应用」、`en` 为「Apps」
- **THEN** 中文界面显示「应用」，切换到英文后显示「Apps」

#### Scenario: 普通字符串不受影响

- **WHEN** manifest 的 `title` 是不含 `%` 的字符串
- **THEN** 该文本按原文显示，不触发任何词条查找

#### Scenario: 设置字段标签同样本地化

- **WHEN** 扩展的 `settings.fields[].label` 写成 `%field.interval%`
- **THEN** 设置页按当前语言显示该字段标签

### Requirement: 缺失词条的处理

当 `%key%` 在扩展词条中不存在时，宿主 MUST 显示占位符原文（如 `%nav.home%`）并对每个扩展的每个 key 至多告警一次；宿主 MUST NOT 抛错、不得因此拒绝加载扩展。

#### Scenario: 拼错 key

- **WHEN** manifest 引用 `%nav.hom%` 而词条里只有 `nav.home`
- **THEN** 界面显示 `%nav.hom%`，控制台出现一次告警

#### Scenario: 词条缺失仍能加载

- **WHEN** 扩展的 `contributes.i18n` 为空对象而标签使用了 `%key%`
- **THEN** 扩展照常加载、其余功能不受影响

### Requirement: 词条的唯一来源

扩展的页面文案与壳子标签 SHALL 共用 manifest `contributes.i18n`；扩展 MUST NOT 需要额外的语言包文件才能完成本地化。宿主支持的语言集合即为可用语言集合，词条中其它语言的键 MUST 被忽略而不是报错。

#### Scenario: 页面与标签共用词条

- **WHEN** 扩展在 `contributes.i18n` 中声明 `common.save`，页面与命令标题都引用它
- **THEN** 两处显示同一语言的同一文案

#### Scenario: 声明了未支持的语言

- **WHEN** 扩展声明了 `ja` 词条而宿主只支持 `zh`/`en`
- **THEN** 扩展正常加载，`ja` 词条不被使用，也不产生错误

### Requirement: `titleKey` 降级为遗留

`titleKey` SHALL 继续可用以便既有扩展不失效，但它只查询宿主语言包；文档 MUST 标注其遗留状态，新扩展 SHOULD 使用 `%key%`。

#### Scenario: 既有扩展不受影响

- **WHEN** 一个既有扩展仍在使用 `titleKey`
- **THEN** 其标签行为与升级前完全一致

### Requirement: 标签解析在壳子侧完成

所有对外提供的扩展条目（扩展管理器列表、设置页快照等）SHALL 已经包含解析后的标签文本；扩展页面 MUST NOT 需要再去解析其它扩展的 `%key%`。

#### Scenario: 扩展管理器显示本地化名称

- **WHEN** 扩展的 `displayName` 是 `%ext.title%`，用户切换到英文
- **THEN** 扩展管理器列表直接显示英文名称
