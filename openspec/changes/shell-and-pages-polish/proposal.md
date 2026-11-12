# Proposal

## Why

五条界面/壳子上的具体问题（用户 2026-11-12 反馈），都是"能用但不好用"：

1. **主窗口不在任务栏**：建窗即 `skipTaskbar: true`（[`src/main/window.ts:35`](../../../src/main/window.ts)），
   ADR-0019 决策 2 当年为了"常驻托盘、任务栏不占位"这么定；实际使用中从任务栏切回窗口是刚需，
   而"收进托盘时窗口隐藏、任务栏自然消失"这件事本来就不需要 `skipTaskbar` 来保证。
2. **扩展页顶部一句多余的统计**：「共 N 个扩展（系统扩展不可卸载/禁用）」每次进页面都占一行，
   既不随筛选变化，也不是用户要的信息。
3. **扩展页没有搜索、系统扩展混在列表里**：装到十几个扩展后找一条要滚半天；系统扩展（app / settings /
   ext-manager）不可卸载/禁用却和用户扩展排在一起，干扰判断。
4. **设置-更新页过于紧凑**：两行表单项、提供者列表、状态行、按钮行、事件区直接堆叠，块与块之间零留白。
5. **设置-扩展的父节点只有 16px 小箭头能展开**：点「扩展」这一行只切到列表态，想展开得精准点箭头。

## What Changes

- **任务栏可见**：去掉主窗口的 `skipTaskbar`（仅影响 Windows 建窗参数）；**关闭/最小化的三态行为完全不变**
  （`hide()` 到托盘时任务栏按钮随之消失）。ADR-0019 追加"修订（2026-11-12）"段，历史正文保留。
- **删掉扩展页的统计行**：`ext.status.count` 不再渲染；状态行保留，但只承载操作反馈
  （安装成功/失败、读取失败）。
- **扩展页加搜索 + 系统扩展开关**：搜索匹配 `id` / `displayName` / `author` / `description`
  （与 App 页搜索框同口径，大小写不敏感）；系统扩展**默认隐藏**，用页面内的开关临时显示，
  **不持久化**（每次进页面回到默认隐藏）。
- **组件库的行内表单与列表间距**：`.obox-form-item--inline` 增加上下内边距、`.obox-list` 增加行间距与
  上下外边距，并**同时收掉设置页里那条更高特异性的覆盖**（否则页面覆盖会盖住库的改动而看不到效果）。
- **设置-扩展父节点点行即开合**：点「扩展」行 = 折叠/展开其下的扩展子项 **且** 右侧回到扩展列表态；
  小箭头保留作为可见提示（点它仍只做开合，不触发右侧跳转）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。这批改动是界面与壳子行为，不改变扩展 API、manifest 约定、IPC 能力面与既有 capability 的规格语义
（任务栏那条是 ADR 决策变更，用 ADR 修订段记录）。因此 `.openspec.yaml` 设 `skip_specs: true`。

## Impact

- **主进程**：`src/main/window.ts`（`skipTaskbar`）、`docs/adr/0019-tray-and-close-behavior.md`（修订段）。
- **扩展页**：`system-extensions/ext-manager/{index.html,page.js,page.css,manifest.json}`（搜索框、开关、删统计行、i18n）。
- **组件库**：`src/page-runtime/ui.css`（`.obox-form-item--inline` / `.obox-list` / `.obox-list__item` 间距）。
- **设置页**：`system-extensions/settings/{page.js,page.css}`（树行点击、去掉或放宽行内表单的覆盖）。
- **受影响界面**（需逐页回归）：设置页 9 个分区、rdp、webapp、app、ext-manager —— 库级间距改动会让所有
  使用 `.obox-form-item--inline` 与 `.obox-list` 的页面一起变松。
- **门禁**：`test/ui-css.test.ts`（新增间距断言）、`test/system-extension-ext-manager.test.ts`（搜索/开关/无统计行）、
  `test/extension-skills.test.ts` 不受影响；若有断言 `skipTaskbar: true` 的用例需一并更新。
