# RDP 扩展：主题跟随 obox + 修复新建/编辑选项错乱 + 表单说明文本

- 状态：待用户确认（确认后才进入设计文档）
- 需求来源：用户 2026-10-11 提出的三条（主题跟随 / 选项错乱 / 每项独占一行并带灰色说明）
- 范围切分：三条一次做完（用户已确认）

## 1. 背景与问题

1. **主题不一致**：扩展 App 子窗口的 `src/styles.css` 自建了一套配色（深色硬编码），obox 切换主题时子窗口外观不变，与宿主割裂。
   已查明：宿主**已经**会把当前主题 token 注入 App 子窗口，并在主题变化时重渲染 iframe——
   `src/renderer/src/AppWindow.vue` 的 `themeKey` / `themeStyleHtml` / `stateStore.onSettingsChanged` / `:key="themeKey"`。
   因此本需求**不需要改宿主**，问题在扩展自己没用宿主 token。
2. **新建/编辑时选项错乱**：用户实测"新建或编辑时，选项会错乱"。
   两个嫌疑（设计阶段先复现确认，不盲改）：
   - `src/components/ConnectionModal.vue:23` `const form = reactive(rowToForm(props.row))` —— 只在组件创建时求值一次；若新建/编辑复用同一实例，上一次的值会残留；
   - 上一轮新增的 `visibleFields(group)` 过滤（`ConnectionModal.vue:123/150`）与 `v-for` 的 key 组合。
3. **表单可读性**：现在每个字段只有标签，没有说明；60+ 项（含高级折叠）对使用者是黑盒，尤其 `select`/`radio` 的取值含义无从得知。

## 2. 需求

### R-D1 主题跟随（完全使用宿主 token，不自创风格）
- `src/styles.css` 的颜色、边框、字号、字体**全量替换**为宿主 token（`src/renderer/src/assets/main.css` 定义、主题可覆盖）：
  `--bg --bg-panel --bg-sidebar --bg-titlebar --bg-input --border --fg --fg-dim --fg-bright --fg-link --fg-error --fg-warning --fg-success --accent --hover-bg --selection-bg --nav-icon --statusbar-bg --statusbar-fg --font-family --font-size --font-size-sm --font-size-lg --icon-size --nav-icon-size`
- **禁止**再出现自造的颜色字面量（如 `#2d2d30`）；确需半透明遮罩时用 `--hover-bg` 或色值经 `color-mix()` 从 token 派生，并在设计文档里写明理由。
- obox 切换主题 → 子窗口**立即**呈现新主题（无需重开卡片）；设计文档需给出验证手段。
- 允许保留的扩展自有样式仅限**布局**（间距、栅格、宽度、行高），不得含色彩与字体族。

### R-D2 修复新建/编辑时选项错乱
- 先写**复现测试**（headless，mock api 或直接测 `fields.js` + 组件逻辑边界），**先红后修**。
- 判定根因后修复，保证：同一张卡片连续「编辑 → 保存 → 再编辑」与「新建 → 保存 → 再新建」得到的表单值互不串扰；切换不同行编辑不残留上一行的值。
- 修复点必须落到"组件生命周期/状态重建"或"过滤逻辑"二者之一（由设计文档定），不允许用"每次强制销毁重建"这类掩盖根因的补丁，除非设计文档论证其必要。

### R-D3 表单结构与说明文本
- 每个选项**独占一行**（成对字段如分辨率可两输入一行，但整项仍独占一行）；选项多时允许折行，不再使用当前"两列/多列栅格"挤压布局。
- 每个选项**下方**加一行灰色说明文本，说明它的作用：
  - 用宿主 token `--fg-dim` + `--font-size-sm`；
  - 说明取自**微软 RDP 属性文档**，中文、**一句话**（超长内容由设计文档决定是否截断或折叠）。
- `select` / `radio`：**每个取值**都要有简短说明（在设计文档中以表格列出：取值 → 中文说明），呈现方式（行内小字/下拉项副标题/选中后下方说明）由设计文档决定并给出理由。
- 校验错误仍在字段附近显示（`--fg-error`），与说明文本不互相遮挡。

## 3. 验收标准

1. 扩展卡片在 obox 的**每个主题**下外观与宿主一致（配色、边框、字号来源均为宿主 token）；切换主题即刻生效。
2. `src/styles.css` 中不再存在自造颜色/字体字面量（可用脚本/正则核查，验收记录附命令与输出）。
3. 复现测试：修复前红、修复后绿，附测试名与前后输出。
4. 表单：每个选项独占一行、每项下方有灰色说明；所有 `select`/`radio` 的每个取值都有说明文本（覆盖数在设计文档中给出并核对为 100%）。
5. `node --test`（扩展全部用例）+ `npx prettier --check .`（扩展内）通过；界面 `npm run build` 通过。
6. 真机验证：重启 obox 后新建一条、编辑一条、切换主题各一次，截图留证。
7. 术语与字段名以现有 `src/fields.js` 与 `lib/rdpFile.mjs` 为准，不改数据模型（本次**不新增/不重命名**任何 DB 列）。

## 4. 影响面（预计改动文件）

- `extensions/rdp/src/styles.css`（全量改为 token）
- `extensions/rdp/src/App.vue`、`src/components/*.vue`（布局与说明文本渲染）
- `extensions/rdp/src/fields.js`（新增每字段描述、每个 select/radio 取值的说明；如 R-D2 根因在此则一并修）
- `extensions/rdp/test/**`（新增复现测试与 token 核查测试）
- `extensions/rdp/README.md`（说明文本来源与主题跟随的实现约定）
- 归档：`extensions/rdp/docs/spec/`、`extensions/rdp/docs/adr/`

## 5. 不在范围内

- 不改宿主（`src/**`）；若设计阶段发现必须改宿主，**停下来问**并按约定把 ADR 落位到仓库 `docs/adr/`。
- 不改 `.rdp` 字段集合与数据模型；不做深浅色以外的主题定制。
- 不处理上一轮遗留项（`adminSession` 默认值、用户名形态提示、保存后回读校验、归档文档 prettier）——它们各自独立，另行安排。

## 6. 风险

- **token 覆盖不全**：若某处视觉在宿主主题下对比度不足（例如自造的半透明遮罩），需在设计文档给出核查清单，避免"跟随了主题但看不清"。
- **说明文本体量**（约 60 字段 + 若干取值）：可能显著拉长表单，需要折叠/分组的呈现决策，否则"说明"反而降低可用性。
- **R-D2 根因若在宿主侧**（例如 App 子窗口的组件复用行为），则需停下并改判范围。
