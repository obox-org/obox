# Tasks

> 顺序即实施顺序：先立库与注入（对现有页面零影响），再逐页改造系统扩展（ext-manager → app → settings），最后文档与验收。

## 1. 库骨架与主题契约

- [ ] 1.1 新增 `src/page-runtime/ui.css`：文件头写清"预编译产物、只消费主题 token、状态用语义属性"三条约定；建立分区注释（基础 / 布局 / 排版 / 按钮 / 表单 / 数据展示 / 反馈 / 导航）
- [ ] 1.2 定义库内尺寸变量（`:root` 上 `--obox-space-1..6`、`--obox-radius-sm|md|lg`、`--obox-z-modal|drawer|popover`、`--obox-transition`），全部 `--obox-` 前缀，不新增主题 token
- [ ] 1.3 基础契约：只允许 `var(--token)` 取色（禁写死十六进制）；不写裸元素选择器（`button`/`input`/`ul`）与 `*` 重置
- [ ] 1.4 单测/门禁：扫描 `ui.css` 断言无 `#[0-9a-fA-F]{3,8}` 色值、无裸元素选择器、无 `!important`（除明确的少量例外并注释）

## 2. 布局与排版

- [ ] 2.1 布局：`obox-layout` / `obox-layout__sider` / `obox-layout__header` / `obox-layout__content` / `obox-layout__footer`
- [ ] 2.2 栅格：`obox-row` + `obox-col--{1..12}` + gap 修饰（`obox-row--gap-sm|md|lg`），窄宽下可换行
- [ ] 2.3 分隔线：`obox-divider`（水平/`--vertical`，可带文字 `data-label`）
- [ ] 2.4 排版：`obox-title`（h1–h4 尺寸修饰 `--h1..h4`）、`obox-text`（`--secondary|--success|--warning|--danger|--disabled`）、`obox-link`、`obox-code`、`obox-kbd`、`obox-truncate`

## 3. 按钮

- [ ] 3.1 `obox-btn` 基础 + 变体 `--primary|--default|--dashed|--text|--link|--danger|--ghost` + 尺寸 `--sm|--lg` + `--block` + 图标位（`obox-btn__icon`）
- [ ] 3.2 状态：`:hover` / `:active` / `:focus-visible`（可见轮廓）/ `aria-disabled="true"` / `[data-loading="true"]`（转圈 + 文本变淡 + 保持宽度）
- [ ] 3.3 按钮组：`obox-btn-group`（首尾圆角处理、相邻边框合并）

## 4. 表单

- [ ] 4.1 `obox-form-item`：`__label`（含必填 `--required`）、`__help`、`__error`；错误时联动输入框 `aria-invalid`
- [ ] 4.2 `obox-input`：尺寸、`__prefix`/`__suffix`、`:focus-visible`、`[readonly]`、`aria-invalid`、`aria-disabled`
- [ ] 4.3 `obox-textarea`（可调高度提示、字符计数位）
- [ ] 4.4 `obox-select`（原生 select 的外观统一：箭头、内边距、禁用）
- [ ] 4.5 `obox-checkbox` / `obox-radio` / `obox-switch`（自定义外观 + `:checked`/`:focus-visible`/`aria-disabled`）
- [ ] 4.6 `obox-number`（步进按钮位）、`obox-date` / `obox-time`（原生控件的深浅一致性，配合 `color-scheme`）
- [ ] 4.7 键盘可达性检查：所有表单组件 `:focus-visible` 都有清晰轮廓且不被裁剪

## 5. 数据展示

- [ ] 5.1 `obox-card`（`__header`/`__body`/`__footer`，可 `--flat`/`--bordered`）
- [ ] 5.2 `obox-list` / `obox-list__item`（`--compact`、`--divided`、选中态 `aria-selected`）
- [ ] 5.3 `obox-table`（`--bordered|--striped|--hover|--compact`，表头粘附、数值右对齐位）
- [ ] 5.4 `obox-tag`（`--success|--warning|--danger|--info`、`--closable`）、`obox-badge`（`--dot`/数字）、`obox-avatar`（尺寸、圆形/方形）
- [ ] 5.5 `obox-progress`（`--line|--circle` 外观、`aria-valuenow` 联动）、`obox-stat`（数值 + 说明）
- [ ] 5.6 `obox-descriptions`（键值两列/多列）、`obox-empty`（图标位 + 文案 + 动作位）、`obox-skeleton`（`--text|--circle|--rect`、闪动受 `prefers-reduced-motion` 抑制）

## 6. 反馈

- [ ] 6.1 `obox-alert`（`--info|--success|--warning|--danger`，含图标位与关闭按钮位）
- [ ] 6.2 `obox-spinner`（尺寸修饰、`aria-busy` 语义说明）
- [ ] 6.3 `obox-modal` 外观：`obox-modal__mask` / `__panel` / `__header` / `__body` / `__footer`，尺寸 `--sm|--lg`，`role="dialog"` 示例写进文档
- [ ] 6.4 `obox-drawer` 外观（左/右/上/下）+ 宽度修饰
- [ ] 6.5 `obox-tooltip` / `obox-popover` 外观（仅视觉；定位由页面负责，文档给出最小定位片段）

## 7. 导航

- [ ] 7.1 `obox-tabs`（`__item`、选中 `aria-selected`、`--card` 变体）
- [ ] 7.2 `obox-breadcrumb`、`obox-pagination`、`obox-steps`（`--horizontal|--vertical`，当前步 `aria-current`）
- [ ] 7.3 `obox-tree`（`__node`、`__children`、选中 `aria-selected`、展开 `aria-expanded`，含连接线）
- [ ] 7.4 `obox-segmented`（分段控件，选中态）、`obox-menu` / `obox-menu__item`（下拉菜单外观）

## 8. 注入与运行时

- [ ] 8.1 `src/page-runtime/page.js`：`startPageContext({ disableUiCss })` 默认注入 `<link rel="stylesheet" href="app://obox/ui.css" data-obox-ui>`，幂等（已存在则跳过）；`disableUiCss` 时不注入
- [ ] 8.2 单测 `test/page-runtime-ui-css.test.ts`：默认注入一次、重复调用不重复、`disableUiCss` 不注入、注入发生在 `onChange` 之前
- [ ] 8.3 打包验证：`electron-builder --dir` 后确认 `<resources>/page-runtime/ui.css` 存在（沿用既有 `extraResources`）

## 9. 系统扩展改造（按复杂度递增）

- [ ] 9.1 `ext-manager`：改用 `obox-*`（列表、徽标、标签、按钮、详情表格、空态）；删除 `page.css` 中重复的通用外观；验证列表/详情/卸载/安装结果四类交互外观
- [ ] 9.2 `app`：改用 `obox-*`（卡片网格、搜索输入、空态、右键菜单外观）；验证搜索/空态/右键/打开失败提示
- [ ] 9.3 `settings`：改用 `obox-*`（左树、分区标题、表单行、下拉、快捷键表格、开发运行时列表、AI 测试按钮、通知清单）；这一页表单最全，补齐过程中缺失的表单组件必须回填到 `ui.css` 并补文档
- [ ] 9.4 三页改造后各自 `page.css` 只保留布局与专有样式；用门禁断言"不再含按钮/输入/下拉的通用外观"
- [ ] 9.5 三页在深/浅两套主题、zh/en 两种语言下逐页核对（CDP 断言关键计算样式 + 人工看截图）

## 10. 文档与 README

- [ ] 10.1 新增 `docs/extension-api/ui-components.md`：定位与边界（纯 CSS、无行为）、注入方式（runtime 自动 / 手写 `<link>` / `disableUiCss`）、命名与状态约定、**组件清单表**（每项：class、变体、状态、最小示例）、可复制片段（按钮组、表单项错误态、表格、模态框外观、空态）
- [ ] 10.2 `guides-user.md`：把"页面样式"一节指向组件库，给出 `<link>` + `startPageContext()` 的最小页面骨架
- [ ] 10.3 `guides-builtin.md`：系统扩展页使用组件库的约定（不得再各自定义通用组件外观）
- [ ] 10.4 `README.md`：目录树补 `src/page-runtime/ui.css`，文档导航补 `ui-components.md`，渲染侧运行时表补一行
- [ ] 10.5 `themes-settings.md`：在主题一节补一句"组件库只消费 token，因此切主题自动生效"，并指向 `ui-components.md`

## 11. 验收

- [ ] 11.1 门禁：`npm run typecheck` + `npm run lint`（0 error）+ `npm test` 全绿；新增 CSS 门禁（无色值/无裸元素选择器/无 `!important`）与 runtime 注入单测通过
- [ ] 11.2 体积：`ui.css` 未压缩 ≤ 60 KB，记录实际值
- [ ] 11.3 真机（开发版）：三个系统页在深/浅主题 + zh/en 下无错位、无对比度问题；`obox:context` 切换后组件即时变样
- [ ] 11.4 真机（打包版）：安装包内存在 `resources/page-runtime/ui.css`，系统页与一个 App 卡片页都能加载组件库
- [ ] 11.5 兼容：不引入组件库的旧页面（含 pet overlay）外观零变化；`apiVersion` 与扩展 API 未变
