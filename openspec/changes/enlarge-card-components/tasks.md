# Tasks

## 1. 卡片骨架尺寸（网格 + 页眉/页脚 + 内容区）

- [x] 1.1 `.obox-card-grid` 最小卡片宽默认值 200px → **300px**、网格间距改 `var(--obox-space-5)`（16px），
      `--obox-card-min-w` 变量名与覆盖机制保持不变；在 `test/ui-css.test.ts` 增加断言
      （`minmax(var(--obox-card-min-w, 300px)`、`gap: var(--obox-space-5)`），`npx vitest run test/ui-css.test.ts` 通过
- [x] 1.2 `.obox-card__header` 与 `.obox-card__footer` 内边距改为 `var(--obox-space-4) var(--obox-space-5)`
      （上下 12px、左右 16px）；断言两条规则的 padding 相同且左右为 `space-5`，测试通过
- [x] 1.3 `.obox-card__body` 内边距 `var(--obox-space-4)` → `var(--obox-space-5)`（16px）；
      断言 padding 为 `space-5`，测试通过
- [x] 1.4 同步 `docs/extension-api/ui-components.md`：`obox-card` 那一行补尺寸说明，并在「尺寸约定」后补一段
      卡片规格（网格最小宽 300px / 间距 16px / 内容区 16px / 页眉页脚 12×16px）；
      验证：文档中出现这三个数值且与 `src/page-runtime/ui.css` 的实际值逐个对照一致

## 2. 卡片内行间距与直下文本行对齐

- [x] 2.1 `.obox-card__body` 改为 `display: flex; flex-direction: column; gap: var(--obox-space-4)`（行间距 12px），
      并新增 `.obox-card__body > .obox-title { margin-bottom: 0 }` 避免与标题自带 8px 叠加成 20px；
      断言 gap 为 `space-4` 且该 title 规则存在，测试通过
- [x] 2.2 新增 `.obox-card > .obox-text` 三条规则：左右内边距 `space-5`、相邻直下文本行之间
      与「页眉之后 / 页脚之前」各 `space-4` 的间距；断言选择器是**直接子元素**形态
      （防止误伤 `__body` 内的 `.obox-text`），测试通过
- [x] 2.3 在 `docs/extension-api/ui-components.md` 补"直下文本行"写法与对齐规则（webapp 卡片那种形态），
      并写明与"放进 `__body`"的取舍；验证：按文档示例写的 HTML 在本机渲染后左右内边距为 16px、
      行间距 12px（与 3.4 的量测共用一次运行）

## 3. 既有消费者回归 + 目标页量测

- [x] 3.1 真机回归 `扩展管理`（`ext-manager` 列表行卡片）：`npm run dev` 后截图，
      确认内容不被裁切、无横向滚动条、行高变高后仍可接受；把结论（含截图路径）写进 PR 描述
- [x] 3.2 真机回归 `应用`（`obox-card app-card`）：截图确认图标方块与两行文案仍居中，
      `.app-card` 的 `padding` / `min-height` 仍以页面值为准；结论写进 PR 描述
- [x] 3.3 对照项：`设置`页（不使用卡片）截图确认与改动前零差异
- [x] 3.4 目标页量测 `rdp` 与 `webapp` 卡片：用 CDP 读取计算样式，断言内容区 padding=16px、
      相邻行间距=12px、网格 `gridTemplateColumns` 的最小宽=300px、`gap`=16px；
      深色与浅色主题各截一张图，图与数值一起贴进 PR 描述

## 4. 集成验证与交付

- [x] 4.1 三条门槛全绿：`npm run typecheck`、`npm run lint`（0 error）、`npm test`（含 1.x/2.x 新增断言）
- [x] 4.2 从 master 拉 `feat/card-size` 分支提交（中文 commit message），推送并开 PR，正文附 3.x 的截图与量测结论；
      CI `check` 绿后按 AGENTS 规则 squash 合并并删除分支
- [x] 4.3 合并后复核依赖面：`npm run security:audit --registry=https://registry.npmjs.org` = 0、
      Dependabot 开放告警 = 0
- [x] 4.4 确认 `rdp` / `webapp` 两个扩展**无需改代码**（它们引用宿主 `app://obox/ui.css`）；
      是否随之发布宿主新版本（版本号）由用户决定，本 change 不自行发版

## Workflow follow-up

- 全部任务完成后，按项目流程归档本 change（`openspec archive enlarge-card-components`），
  并确认 `openspec/specs/extension-ui-components/spec.md` 已纳入两条新要求。
