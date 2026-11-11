# Design

## Context

见 `proposal.md - Why`。这里只记实现约束：

- `rdp` 与 `webapp` 自 1.1.0 起**删除了自带样式表**，并有门禁断言 `src/` 下不存在 `.css`
  （`extensions/{rdp,webapp}/test/uiLibrary.test.js`），因此两页的卡片外观只能由宿主 `ui.css` 决定。
- 卡片当前由库里的五个规则构成：`.obox-card`（列布局 + 边框 + `overflow: hidden`）、
  `.obox-card__header`（`8px 12px` + 下边框）、`.obox-card__body`（`12px`）、
  `.obox-card__footer`（`8px 12px` + 上边框）、`.obox-card-grid`（`minmax(200px, 1fr)` + `12px`）。
- 两个扩展的结构不同：**rdp** 把标题与副行放进 `__body`；**webapp** 把网址/说明行**直接挂在**
  `.obox-card` 下（既不在 `__body` 里，也没有任何左右内边距），行与行之间为 0 间距
  （`.obox-text` 的 `margin: 0`）。
- `.obox-card` 还有两个既有消费者：`system-extensions/ext-manager`（列表行卡片）与
  `system-extensions/app`（`obox-card app-card`，页面自己定义了 `padding` / `min-height`）。
- 库门禁：颜色只能走 token、选择器只能带 `obox-` 前缀（禁裸元素选择器）、不得使用 `!important`
  （`test/ui-css.test.ts`）。

## Goals / Non-Goals

**Goals:**

- 卡片显著变大变松：内容区 16px、页眉/页脚上下 12px 左右 16px、行间距 12px、网格最小宽 300px、间距 16px。
- 修掉 webapp 卡片"文字贴边框、行与行零间距"的结构性缺陷——**在库里解决**，不靠改扩展。
- 尺寸全部走 `--obox-space-*` 与 `--obox-radius-*` 这类库内变量，不写像素字面量（除网格最小宽这一新默认值）。
- 保持字号体系不变，避免与设置页 13/14px 体系冲突。

**Non-Goals:**

- 不改 `.obox-card` 的 class 名、不新增修饰类、不新增主题 token。
- 不改 `rdp` / `webapp` 的组件代码，也不要求它们重新发版。
- 不改 `app` 页 `.app-card` 自身的 `padding` / `min-height`（那是页面级布局职责）。
- 不调整卡片内字号、不引入新组件。

## Decisions

### D1：改库内默认值，而不是新增"宽松卡片"修饰类

用户裁定"修改 obox 提供的卡片"。选默认值而非修饰类，理由：两个目标页**没有**自带样式能力
（门禁禁 `.css`），若加修饰类就还得改两个扩展的组件并各发一版；而尺寸是宿主观感的一部分，
放默认值里只需重装宿主。

代价是 `ext-manager` 的列表行卡片也跟着变大——已列入回归项（见 Risks）。

### D2：间距用既有的 `--obox-space-*`，网格最小宽保留可覆盖变量

映射：`--obox-space-4` = 12px、`--obox-space-5` = 16px。

- `.obox-card__body`：`padding: var(--obox-space-5)`
- `.obox-card__header` / `__footer`：`padding: var(--obox-space-4) var(--obox-space-5)`
- `.obox-card-grid`：`gap: var(--obox-space-5)`
- `.obox-card-grid` 的 `minmax(var(--obox-card-min-w, 200px), 1fr)` → 默认值改 **300px**，
  **变量名与覆盖机制不变**（页面仍可压回 180px 之类）。

300px 是本改动唯一的字面量：`--obox-space-*` 最大只到 24px，硬凑会失去语义；而 300px 是
"一行至少放得下 40 字符左右的路径/地址"的经验值，rdp 的 `user@host:port` 与 webapp 的网址都在这个量级。

### D3：行间距用"直接文本子元素上的 margin-top"，**不**把 `__body` 改成 flex 列

```css
.obox-card__body > .obox-title { margin-bottom: 0; }
.obox-card__body > .obox-text { margin-top: var(--obox-space-4); }
.obox-card__body > .obox-text:first-child { margin-top: 0; }
```

**为什么不用 flex**（这是实施期真机回归推翻的第一版方案）：`ext-manager` 把 `.obox-card__body`
**同时当作整行容器**用——`<div class="obox-card__body ext-main">`，而 `.ext-main` 在 `page.css` 里是
`display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between`。库规则与页面规则
同特异性、而 `ui.css` 由运行时注入在 `head` 末尾 ⇒ 库里只要写 `display:flex; flex-direction:column`，
就**压掉**页面的行方向，`.ext-main` 被压成竖排：标题居中、按钮掉到标题下面（3.1 截图实测）。
改成只加 `margin-top` 后 `__body` 保持块级，页面自己的 `display:flex` 照常生效。

alternatives considered：

- **`display:flex; flex-direction:column; gap:12px`**：观感最好但不兼容"把 `__body` 当行容器"的既有页面，实测破版，弃。
- **`.obox-card__body > * + * { margin-top: 12px }`**：会把间距加到 `.ext-main` 的**非文本子元素**上
  （`div.ext-actions` 拿到 12px 上外边距，在居中对齐的 flex 行里把按钮整体推下 6px），弃。
  只给 `.obox-title` / `.obox-text` 这两类**排版类**子元素加间距，影响面才收得住。
- **不动容器、把 `.obox-title` 的 margin 从 8px 提到 12px**：只修了标题→副行一条边，
  副行与后续行仍无间距，弃。

### D4：直下文本行用 `.obox-card > .obox-text` 兜住，不碰裸元素

新增三条规则（选择器均为库自己的 class，满足"禁裸元素选择器"门禁）：

```css
.obox-card > .obox-text { margin: 0; padding: 0 var(--obox-space-5); }
.obox-card > .obox-text + .obox-text,
.obox-card > .obox-card__header + .obox-text { margin-top: var(--obox-space-4); }
.obox-card > .obox-text + .obox-card__footer { margin-top: var(--obox-space-4); }
```

- 影响面精确：`__body` 里的 `.obox-text` 不受影响（选择器是**直接子元素**）；
  没有直下文本行的卡片（`ext-manager`）零变化。
- alternatives considered：**让 webapp 把三行包进 `.obox-card__body`**——结构上更干净，
  但要改扩展代码并再发一版，且库仍应容忍"直下文本行"这种写法（1.1.0 就是这么写的），
  否则下次别人照抄又会贴边。故选择在库侧兜住，同时在 tasks 里留一条"webapp 可择机收进 `__body`"。

### D5：页眉/页脚左右同步提到 16px

现在的对齐关系是 `header/footer 12px` = `body 12px`。body 提到 16px 后，若不同步改页眉/页脚，
标题与内容会错位 4px。故三者左右统一为 `var(--obox-space-5)`。

## Risks / Trade-offs

- **[`ext-manager` 列表行变高变型]（已发生并已修）** 该页一行一个卡片，且把 `__body` 当整行容器用；
  第一版把 `__body` 改成 flex 列后，这一行被压成竖排（标题居中、按钮下移），3.1 截图发现 →
  改为"只给文本子元素加 margin-top"（D3），并在 `test/ui-css.test.ts` 加了
  "`__body` 不得出现 `display:flex` / `flex-direction:column`" 的断言，防止再犯。
- **[`ext-manager` 列表行变稀]** 行高变大是本次的预期代价 → 已截图评估（见 tasks 3.1）；
  若后续觉得太松，可在该页 `page.css` 单独收紧（布局属页面职责，不违反门禁）。
- **[`app` 页卡片被顶破]** `app-card` 覆盖了 `padding` / `min-height`，但仍是 `.obox-card` →
  回归时检查图标方块与两行文案是否仍居中，必要时只调 `.app-card` 的页面级尺寸。
- **[窄窗口下网格列数变化]** 300px 最小宽会让卡片子窗口（rdp 默认 1024×720）从每行 4–5 列变成 3 列 →
  回归时确认不出现横向滚动条；若用户觉得列数太少，只需改 `--obox-card-min-w` 一个值。
- **[双份间距]** 标题既有 `.obox-title` 自带的 `margin-bottom: 8px`，又有新加的 12px →
  已把卡片内标题的 `margin-bottom` 归零，并用门禁断言两者同时成立。
- **[浅色主题下间距更显眼]** 颜色没动，但留白变化在浅色下更明显 → 深/浅各截一张图。

## Migration Plan

纯宿主样式改动，无数据与 API 变更：

1. 改 `src/page-runtime/ui.css` → `npm run build:extensions`（页面运行时不需要构建，改完即生效）。
2. 门禁：`npm run typecheck` + `npm run lint` + `npm test`（含新增的卡片尺寸断言）。
3. 真机：开发版启动，分别截 `设置`（对照，保持原样）、`扩展管理`（回归）、`应用`（回归）、
   `rdp 卡片列表`（目标）、`webapp 卡片列表`（目标）在深/浅两主题下的图。
4. 回滚：`git revert` 该提交即可，`ui.css` 是单文件、无状态。

## Open Questions

- webapp 的直下文本行是否择机收进 `.obox-card__body`？这只影响该扩展的内部排版风格，
  不影响本规格（库必须同时支持两种写法），可等 webapp 下次有实质改动时一并处理。
