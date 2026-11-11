# Proposal

## Why

2.0.2 把组件库的控件整体放大后（输入框 34px、勾选框 16px、行内表单标签列 140px），**卡片没跟上**：
`.obox-card` 的内容内边距仍是 12px、页眉/页脚上下只有 8px，卡片网格的最小宽度仍是 200px、间距 12px。
用卡片列表的 `rdp` / `webapp` 两个扩展因此显得又窄又挤——卡片里放三行信息（标题 / 网址 / 说明）时，
相邻文本行之间**没有任何间距**（`.obox-text` 的 margin 为 0），webapp 的网址与说明行还直接挂在
`.obox-card` 下、不在 `__body` 里，连左右内边距都没有，文字贴着卡片边框。

这类"卡片看起来太小太挤"的观感问题只能改宿主侧样式表解决：两个扩展 1.1.0 起已删除自带样式表，
并有门禁禁止 `src/` 下再出现 `.css`（外观统一交给宿主组件库）。

## What Changes

- **卡片网格** `.obox-card-grid`：最小卡片宽 `--obox-card-min-w` 默认值 200px → **300px**，网格间距 12px → **16px**。
- **卡片内容区** `.obox-card__body`：内边距 12px → **16px**；改为纵向 flex 布局并统一行间距 **12px**，
  卡片内 `.obox-title` 的 `margin-bottom` 交给容器 gap（避免 8+12 双份）。
- **页眉 / 页脚** `.obox-card__header` / `.obox-card__footer`：上下内边距 8px → **12px**，左右 12px → **16px**。
- **卡片直下的文本行** `.obox-card > .obox-text`：补左右 16px 内边距（与页眉/页脚对齐），
  相邻文本行之间、与页眉/页脚之间各留 12px 间距——修掉 webapp 卡片文字贴边与零行距。
- 字号体系**不动**（卡片内标题 13px、说明 12px）；不新增 class、不新增主题 token、不引入修饰类。
- **BREAKING（视觉，仅内部页面）**：`ext-manager` 的列表行卡片与 `app` 页卡片复用同一条 `.obox-card` 规则，
  会一起变高变宽；`app` 页 `.app-card` 自带的 `padding` / `min-height` 保持不变。需逐页回归。
- `rdp` / `webapp` 两个扩展**不需要改代码、不需要重新发版**：它们引用的是宿主的 `app://obox/ui.css`。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `extension-ui-components`：新增一条"卡片尺寸与内部间距"的规格要求——卡片内容区与页眉/页脚的
  最小内边距、卡片内相邻内容行的最小间距、卡片直下文本行必须与页眉/页脚左右对齐，以及卡片网格的
  最小卡片宽度与间距下限；同时把「组件覆盖面 / 数据展示」里的卡片一项与该要求挂钩。

## Impact

- **样式**：`src/page-runtime/ui.css` 的 `.obox-card`、`.obox-card__header`、`.obox-card__body`、
  `.obox-card__footer`、`.obox-card-grid`，以及新增的 `.obox-card > .obox-text` 规则。
- **受影响界面**：`extensions/rdp`（连接卡片）、`extensions/webapp`（条目卡片）、`system-extensions/ext-manager`
  （列表行卡片）、`system-extensions/app`（应用卡片，自带 `.app-card` 覆盖部分尺寸）。前三者是本次目标，
  后两者需回归确认没有错位。
- **门禁**：`test/ui-css.test.ts` 增加卡片尺寸与间距断言；`test/system-extensions-independence.test.ts`
  与两个扩展仓库的 `uiLibrary` 门禁只校验 class 名，不受影响。
- **文档**：`docs/extension-api/ui-components.md` 的「数据展示」与「尺寸约定」需补卡片规格。
- **不涉及**：扩展 API、IPC、主进程、manifest 校验规则、主题 token，均无变化。
