# Design

## Context

见 `proposal.md - Why`。设计相关现状：

- 扩展页面分三类，全部是**独立文档**：系统 nav 页（`app://extensions/<dir>/index.html`）、App `url` 卡片、overlay；三类都由 `src/main/protocol.ts` 的 `app://obox` 命名空间之外的目录提供，`app://obox/*` 单独映射到页面运行时目录（`src/main/paths.ts` 的 `getPageRuntimeDir()`，打包为 `<resources>/page-runtime`）。
- 页面运行时 `src/page-runtime/page.js` 已是所有新页面的统一入口（`startPageContext`），负责 token/`colorScheme`/`t()`；它是最自然的注入点。
- `app://` 响应**没有 CSP 头**，扩展页面文档不受外壳 CSP 约束 ⇒ `<link href="app://obox/ui.css">` 可直接加载，**无需修改任何 CSP**。
- 主题 = 25 个 CSS 变量（`main.css` 默认值 + 主题扩展覆盖），宿主套到 `:root`；页面通过 `obox:context.tokens` 拿到生效值并写入自己的 `:root`。因此组件只要用 `var(--token)` 就自动跟随主题，包括"页面自己那份 `:root`"。
- 三个系统扩展页目前各自有一份 `page.css`，其中大量规则与另外两页重复（按钮、输入、卡片、列表、树节点、提示文字）。

## Goals / Non-Goals

**Goals:**

- 扩展页面"零样式"也能得到与 obox 一致的外观：只写 class。
- 主题（深/浅/无主题）切换立即生效，页面不重载。
- 三个系统扩展页成为组件库的第一批真实使用者与视觉回归样本。
- 组件库可独立演进（纯 CSS、无构建步骤、无 JS 依赖）。

**Non-Goals:**

- 不提供 JS 行为（弹窗开合、下拉定位、Tabs 切换、Toast 自动消失）——由页面自己写，库只给外观与状态属性。
- 不改宿主主窗口的 Vue 壳子样式（导航栏/状态栏/命令面板仍用 `main.css` 与组件内 `var()`）。
- 不引入 Tailwind 式原子类体系，也不引入 CSS-in-JS、预处理器运行时。
- 不新增主题 token（token 集仍是 25 个）；库内尺寸变量用独立 `--obox-*` 命名空间。

## Decisions

### D1. 单文件纯 CSS，无构建步骤

- **选择**：一份 `src/page-runtime/ui.css` 直出（允许在仓库内用注释分区组织），随 `extraResources` 分发。
- **理由**：扩展页面既能 `<link>` 也能被 runtime 注入；若拆成多文件按需引入，无打包器的静态页要写很多 `<link>`，且与"预编译产物"的定位冲突。
- **替代方案**：① 拆成 per-component 文件（否决：加载数量与顺序易错，收益低）；② 用 Sass 预编译（否决：仓库当前无 Sass 依赖，且产物仍需单文件，引入构建步骤只为组织代码不值得）。**"预编译"在此的含义 = 随包分发的成品 CSS，而不是运行时生成。**

### D2. 命名：`obox-` 前缀 + 双横线变体后缀，状态用语义属性

- **选择**：`obox-btn`、`obox-btn--primary`、`obox-btn--sm`、`obox-input`、`obox-card`…；状态 `aria-disabled` / `aria-invalid` / `aria-busy` / `data-loading` / `data-size`。
- **理由**：`aria-*` 同时服务可访问性与样式选择器，避免"样式改了、语义没跟上"；`is-*` 私有类在 AntD/Element 里是内部约定，对外暴露会把可访问性做丢。
- **替代方案**：① 纯 BEM（`obox-btn__icon--left`）——对图标/前后缀仍保留少量 `__` 元素类，但状态不用 BEM 修饰符；② 无前缀（否决：会与页面自有 class 冲突）。

### D3. 颜色只走 token，尺寸走库内变量

- **选择**：颜色/边框/阴影/字体 → `var(--bg)`、`var(--fg-dim)`、`var(--border)`、`var(--accent)`、`var(--fg-error)`…；尺寸/圆角/层级 → `--obox-space-1..6`、`--obox-radius-sm|md|lg`、`--obox-z-modal`。
- **理由**：颜色必须跟主题；尺寸不该由主题决定（否则换主题会让布局跳动）。尺寸变量固定在 `:root` 且带 `--obox-` 前缀，避免污染主题 token 集与宿主变量。
- **替代方案**：把尺寸也做成主题 token（否决：25 个 token 是公开契约，扩集要改页面上下文协议与文档，收益不匹配）。

### D4. 注入：runtime 默认注入 + `<link>` 手写，用 `<link>` 而非 `adoptedStyleSheets`

- **选择**：`startPageContext()` 在初始化时若 `document.head` 中没有 `link[data-obox-ui]`，则插入 `<link rel="stylesheet" href="app://obox/ui.css" data-obox-ui>`；`disableUiCss: true` 关闭。
- **理由**：`<link>` 有浏览器缓存、可与首帧并行加载、无需 fetch（`connect-src` 也可能被页面自身的 CSP 限制）；构造样式表需要先读文本，多一次请求且更难调试。
- **替代方案**：① `fetch` + `new CSSStyleSheet()` + `adoptedStyleSheets`（否决：页面若自带 CSP 可能挡 fetch；调试时看不到样式表来源）；② 只在文档里要求扩展手写 `<link>`（否决：多一步易漏，且无法统一升级）。

### D5. 不写全局元素选择器，避免污染

- **选择**：库内不出现裸 `button {}` / `input {}` / `ul {}` 规则，也不做全局 `*` 重置；需要基线时只在 `:root` 定义 `--obox-*` 变量与 `box-sizing` 说明（由页面自行 `*{box-sizing:border-box}`，或使用 `obox-*` 组件容器）。
- **理由**：扩展页面可能自带一套样式；全局重置会静默改变它们。宿主壳子也可能复用同名元素。
- **替代方案**：带作用域的 `@scope`（Chromium 支持但会锁死 Electron 版本，且老宿主不支持）。

### D6. 三个系统页改造：删重复、留布局

- **选择**：把 `page.css` 里按钮/输入/选择/卡片/列表/表格/树/提示等**通用外观**移除，改用 `obox-*` class；保留 `.settings`/`.tree`/`.panel` 这类页面级布局与专有尺寸。
- **理由**：三个页面是组件库的第一批真实用例，能立刻暴露缺失的组件与状态；同时减小重复代码。
- **替代方案**：新做一个示例页（否决：示例页无人维护，系统页天天被用）。
- **顺序**：先 `ext-manager`（结构最简单）→ `app` → `settings`（表单最多，最后做，便于一次补齐表单组件）。

### D7. 视觉回归靠"真机 + CDP 断言"，不引视觉快照库

- **选择**：用已有做法（CDP 驱动真实窗口）断言关键计算样式（颜色/尺寸/状态差异），并人工看深/浅两套；不引入 Playwright 截图比对。
- **理由**：仓库当前测试全是 vitest（node 环境），引入浏览器截图测试会带来下载与 flake 成本；而"是否用对 token"可以用计算样式精确断言。
- **替代方案**：Playwright + pixelmatch（否决：CI 成本与维护成本高于收益，暂不做）。

## Risks / Trade-offs

- [样式表体积增长 → 页面加载变慢] → 目标 ≤ 60 KB（未压缩）；只写实际会用的组合，不做穷举矩阵；测量并记入验证记录。
- [与页面自有样式冲突（同名 class、元素样式）] → 全面前缀 + 禁止裸元素选择器；文档给出"只想用一部分组件"的用法。
- [三个系统页改造引入视觉回归] → 按 D6 顺序逐页改造，每页改造后跑既有门禁 + CDP 关键样式断言；保留旧 CSS 直到该页验证通过再删除。
- [`aria-*` 状态依赖页面正确设置] → 文档给出可直接复制的片段（禁用/加载/错误三态），并在系统页里都有实例；诊断不依赖 JS。
- [浅色主题下对比度不足] → 组件的 hover/active 用 `--hover-bg`/`--selection-bg` 等语义 token，不在库内硬造色；浅色主题由主题扩展保证取值，验证时对两套主题各看一遍。

## Migration Plan

1. 先落 `ui.css` 与注入（纯新增）⇒ 对现有页面零影响。
2. 逐页改造系统扩展（ext-manager → app → settings），每页一个提交、每页验证；改造期间保留旧 `page.css`，验证通过后再删重复规则。
3. 文档与 README 随代码同 PR 更新；`docs/extension-api/ui-components.md` 是唯一真相。
4. 回滚：删除 `ui.css` 与注入代码、恢复三页旧 `page.css` 即可；不涉及数据与协议，无迁移状态。

## Open Questions

- 无阻塞项。后续可选（不属于本 change）：是否提供配套的 `app://obox/ui.js` 行为层（当前明确不做，见 proposal 与 D1/Non-Goals）。
