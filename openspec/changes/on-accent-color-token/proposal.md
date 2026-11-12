# Proposal

## Why

组件库里"**实心底色上的文字**"用的是会随主题翻转的 token，于是两套主题各坏一处：

| 项 | 深色主题 | 浅色主题 | 后果 |
| --- | --- | --- | --- |
| `.obox-btn--primary`：`background: var(--accent)` + `color: var(--fg-bright)` | `--fg-bright` = `#ffffff` ⇒ 白字蓝底 ✅ | `--fg-bright` = `#1e1e1e` ⇒ **黑字蓝底** ❌ | 用户反馈：浅色下「安装扩展…」按钮黑字看不清 |
| `.obox-btn--danger:hover`：`background: var(--fg-error)` + `color: var(--bg)` | `--bg` = `#1e1e1e` ⇒ **黑字红底** ❌ | `--bg` = `#f3f3f3` ⇒ 浅字红底 ✅ | 反向的同类错误，没人报过但一样坏 |

根因不是某一处写错，而是**缺一层语义**：`--fg-bright` / `--bg` 的职责是"表面与正文"，它们的定义就是随明暗翻转；而"填充色之上的前景"需要的是**不翻转**的对比色。现有 25 个 token 里没有任何一个在两个主题下都足够浅（`--fg-dim` 两边都是 `#6e6e6e`，`--accent` 两边都是 `#007acc`）。

## What Changes

- 新增主题 token **`--fg-on-accent`**：两套主题取同一值 `#ffffff`（深蓝/浅蓝填充上都是白字），
  并在 `src/renderer/src/assets/main.css` 的 `:root` 里给默认值。
- `ui.css` 里所有"填充色 + 前景文字"的组合统一改用 `--fg-on-accent`：
  `.obox-btn--primary`（含 hover）、`.obox-btn--danger:hover`、实心 `--info`/`--success` 标签、
  进度条填充上的文字、开关/单选圆点的对勾与圆点等（实施时逐条核对，见 tasks）。
- 同步 `docs/extension-api/themes-settings.md`：token 表加一行；"25 个 token"的表述改为"全部主题 token（当前 26 个）"。
- 同步受影响的断言：`test/page-context.test.ts`、`test/overlay-theme.test.ts`、`test/ui-css.test.ts` 里对 token 数量/token 名的断言。
- **规格改动**：`extension-ui-components` 那条"MUST NOT 新增主题 token"放开**语义对比色**这一类；
  `extension-page-context` 里"25 个主题 token"改为"全部主题 token（当前 26 个）"。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `extension-ui-components`：`不污染宿主与页面既有样式` 一条从"禁止新增任何主题 token"改为
  "允许新增**语义对比色** token（用于填充色之上的前景），且必须同时出现在两套主题与 `main.css` 默认值里"。
- `extension-page-context`：`统一的页面上下文消息` 一条把硬编码的"25 个 token"改为"全部主题 token（当前 26 个）"，
  避免每加一个 token 就要改规格。

## Impact

- **主题**：`src/renderer/src/extensions/theme-dark/manifest.json`、`theme-light/manifest.json`（各加一行 token）。
- **默认值**：`src/renderer/src/assets/main.css` 的 `:root`。
- **组件库**：`src/page-runtime/ui.css`（若干 `color:` 改为 `var(--fg-on-accent)`）。
- **文档**：`docs/extension-api/themes-settings.md`（token 对照表 + 数量表述）。
- **门禁**：`test/page-context.test.ts`、`test/overlay-theme.test.ts`、`test/ui-css.test.ts`（token 数量与"不得字面色值"）。
- **扩展兼容**：新增 token 属**纯加法**——扩展页面拿到的 `tokens` 多一个键，旧页面不认识也不影响；
  未升级的主题扩展若没声明该 token，取 `main.css` 默认值（白），因此第三方主题也不会坏。
