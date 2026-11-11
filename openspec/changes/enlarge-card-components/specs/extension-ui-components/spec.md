# Spec Delta

## ADDED Requirements

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
