# Spec Delta

## MODIFIED Requirements

### Requirement: 不污染宿主与页面既有样式

组件库 MUST NOT 使用无前缀的元素选择器或全局重置去改变宿主壳子与其他页面的既有外观；除库自身的尺寸变量与**语义对比色 token**外 MUST NOT 新增主题 token。语义对比色 token 指"填充色/强调色之上的前景色"这类**不随明暗翻转**的颜色（如 `--fg-on-accent`）；新增该类 token 时 MUST 同时写入两套官方主题（`theme-dark` / `theme-light`）与 `main.css` 的 `:root` 默认值，且取值 MUST 在两套主题下都与承载它的填充色保持可读对比。

#### Scenario: 宿主壳子不受影响

- **WHEN** 在扩展页面引入组件库
- **THEN** 主窗口导航栏、状态栏、命令面板的样式与未引入时完全一致

#### Scenario: 未引入的页面零变化

- **WHEN** 某个扩展页面没有引用组件库
- **THEN** 它的渲染结果与引入该能力之前完全一致

#### Scenario: 填充色之上的前景在两种主题下都可读

- **WHEN** 浅色主题下渲染 `.obox-btn--primary`（`background: var(--accent)`）
- **THEN** 其文字颜色取自 `--fg-on-accent`，不取自任何会随明暗翻转的 token
- **AND** 深色主题下同一组件的文字颜色同样取自 `--fg-on-accent`，两套主题下都是可读的对比色

#### Scenario: 第三方主题没声明该 token 时仍可读

- **WHEN** 某个第三方主题只声明了旧的 25 个 token，没有 `--fg-on-accent`
- **THEN** 组件回落到 `main.css` 的 `:root` 默认值，主按钮仍是白字，不出现黑字蓝底
