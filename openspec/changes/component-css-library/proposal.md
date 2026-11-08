# Proposal

## Why

扩展页面的样式目前各写各的：三个系统扩展各自维护一份 `page.css`，用户扩展只能抄宿主或自造外观。结果是同一个"按钮 / 输入 / 卡片 / 表格"在不同页面长得不一样；主题切换时页面要不要跟随全靠作者自觉——历史上就出过系统页把 `--bg` 又拼一层 `--`（写成 `----bg`）、主题从未生效的事故。

obox 已经有一条可靠的状态通道（`obox:context` 下发 25 个主题 token 与 `colorScheme`），但**缺一套宿主预定义、随主题自动变化的组件样式**。没有它，"让扩展页面看起来像 obox"只能靠每个作者重新发明；有了它，扩展只需写 class。

## What Changes

- **新增 `app://obox/ui.css`**：宿主预定义、随包分发的**预编译**组件样式表（纯 CSS、无框架、无 JS），覆盖布局、排版、按钮、表单、数据展示、反馈、导航等组件，并含尺寸（sm/md/lg）、变体（primary/secondary/dashed/text/link/danger/ghost）与状态（hover/active/focus-visible/disabled/readonly/loading/invalid）。
- **命名与状态约定**：全部以 `obox-` 前缀 class 暴露；状态优先用 `aria-*` / `data-*`（`aria-disabled`、`aria-invalid`、`aria-busy`、`data-loading`、`data-size`），不靠 `is-*` 私有类，保证可访问性与可测试性。
- **主题联动**：所有颜色、边框、阴影、字体一律取自主题 token（`--bg`、`--fg`、`--accent`…）⇒ 切主题（含浅色）**即时生效**，不需要重载样式表；组件库自身只额外定义与主题无关的尺寸/间距变量（`--obox-space-*`、`--obox-radius-*`），不新增主题 token。
- **注入方式**：页面运行时 `startPageContext()` 自动注入（幂等、可关闭）；不用运行时的页面可手写 `<link rel="stylesheet" href="app://obox/ui.css">`。
- **系统扩展自查**：`app` / `settings` / `ext-manager` 三页改造为使用组件库，删除各自 `page.css` 里重复的通用外观，只保留页面级布局与专有样式——三页从此是组件库的活文档与回归样本。
- **文档**：新增 `docs/extension-api/ui-components.md`（组件清单、class、状态、可复制示例），并更新 `guides-user.md` / `guides-builtin.md` / `README.md`。

## Capabilities

### New Capabilities

- `extension-ui-components`: 宿主预定义的组件样式库——组件覆盖面与命名、状态与变体约定、主题联动（只用 token）、注入与加载方式、可访问性要求，以及"是否必须使用"的边界。

### Modified Capabilities

（无。`extension-page-context` 的 token / locale 契约不变：组件库只**消费** token，不新增协议字段。）

## Impact

- **新增**：`src/page-runtime/ui.css`（预编译产物，经 electron-builder `extraResources` 随包分发，由 `app://obox` 提供）。
- **修改**：`src/page-runtime/page.js`（自动注入 + `disableUiCss` 开关）、`system-extensions/{app,settings,ext-manager}/page.{css,js,html}`。
- **文档**：新增 `docs/extension-api/ui-components.md`；更新 `guides-user.md`、`guides-builtin.md`、`README.md`（目录树与文档导航）。
- **不影响**：扩展 API 面、manifest 契约、`apiVersion`、宿主主窗口壳子样式（`src/renderer/src/assets/main.css` 与各 Vue 组件不动）。
- **发布**：本次只做规划；实现与发版须等用户明确确认（当前策略：禁止自动发版）。
