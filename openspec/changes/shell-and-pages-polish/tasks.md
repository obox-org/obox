# Tasks

## 1. 主窗口进任务栏

- [ ] 1.1 删掉 `src/main/window.ts` 建窗参数里的 `skipTaskbar: process.platform === 'win32'`，并把注释改为
      "任务栏可见；收进托盘时窗口 `hide()`，任务栏按钮随之消失（ADR-0019 修订 2026-11-12）"；
      验证：`grep -n "skipTaskbar" src/main/window.ts` 无匹配，且 `npm run typecheck` 通过
- [ ] 1.2 在 `docs/adr/0019-tray-and-close-behavior.md` 追加"修订（2026-11-12）：主窗口回到任务栏"段，
      说明推翻决策 2 的理由与"关闭行为不变"；验证：ADR 中出现该修订段，历史正文未改动
- [ ] 1.3 检查测试里对 `skipTaskbar: true` 的断言（`test/` 全仓搜），改为不依赖该参数的写法或按新行为断言；
      验证：`npm test` 全绿

## 2. 扩展页：删统计行 + 搜索 + 系统扩展开关

- [ ] 2.1 `render()` 不再写 `ext.status.count`；状态行只在安装/读取等操作后写反馈，初始为空；
      验证：打开扩展页时顶部没有「共 N 个扩展（…）」那行（真机截图），`grep -c "ext.status.count" system-extensions/ext-manager/page.js` 为 0
- [ ] 2.2 顶部加搜索框（库 `obox-input`）与"显示系统扩展"开关（库 `obox-checkbox`），默认关闭；
      过滤逻辑抽成纯函数 `visibleExtensions(exts, { query, showSystem })`（匹配 id / displayName / author / description，
      大小写不敏感）；验证：`page.js` 里能读到该纯函数，且开关默认 `false`（不读 localStorage）
- [ ] 2.3 列表为空时给空态提示（区分"没有匹配"与"系统扩展已隐藏"两种原因），并在搜索框旁显示极小的结果计数（如 `3/12`）；
      验证：真机分别构造"搜不到"与"只有系统扩展"两种情形，提示文案正确
- [ ] 2.4 `system-extensions/ext-manager/manifest.json` 补 zh/en i18n：搜索占位、开关标签、空态两条、结果计数；
      验证：zh 与 en 键集合完全相同（脚本比对差集为空）
- [ ] 2.5 `test/system-extension-ext-manager.test.ts` 增加断言：页面不再渲染统计文案、存在搜索输入与系统扩展开关、
      过滤函数按 `source==='system'` 默认排除；验证：`npx vitest run test/system-extension-ext-manager.test.ts` 通过

## 3. 组件库与设置页间距

- [ ] 3.1 `src/page-runtime/ui.css`：`.obox-form-item--inline` 补 `padding-block: var(--obox-space-3)`；
      `.obox-list` 补 `display:flex; flex-direction:column; gap: var(--obox-space-2); margin-block: var(--obox-space-2)`；
      验证：`test/ui-css.test.ts` 新增两条断言（内边距/间距存在）并通过
- [ ] 3.2 `system-extensions/settings/page.css`：把 `.panel .obox-form-item--inline` 收缩为"只保留虚线分隔 + 左右内边距"，
      去掉上下 padding，让库的垂直节奏生效；验证：真机打开「设置-更新」，行与列表之间出现可见留白
- [ ] 3.3 逐页回归截图（深色）：`设置-更新`、`设置-网络`、`设置-通用`、`rdp` 表单、`webapp` 表单；
      确认没有错位/贴边；截图与结论贴进 PR；验证：五张截图人工确认

## 4. 设置-扩展：点行开合

- [ ] 4.1 `system-extensions/settings/page.js` 的父行点击处理改为"翻转 `extTreeOpen` + 回到列表态"，
      箭头仍 `stopPropagation` 只做开合；验证：真机点「扩展」一行即展开，再点折叠，右侧始终回到列表
- [ ] 4.2 `test/system-extension-settings-tree.test.ts`（若存在）或新增用例断言"父行点击同时翻 expanded 与回列表"；
      验证：`npx vitest run test/` 相关文件通过

## 5. 集成验证与交付

- [ ] 5.1 门槛全绿：`npm run typecheck` + `npm run lint`（0 error）+ `npm test`
- [ ] 5.2 真机验收：任务栏出现 obox 图标（关闭到托盘后消失）、扩展页搜索可用、系统扩展开关生效、
      设置-更新变松、设置-扩展点行开合；关闭行为三态与改动前一致；截图贴进 PR
- [ ] 5.3 从 master 拉 `feat/shell-and-pages-polish` 分支，中文 commit message，推送开 PR，CI `check` 绿后 squash 合并并删分支
- [ ] 5.4 合并后复核 `npm run security:audit --registry=https://registry.npmjs.org` = 0 与 Dependabot = 0

## Workflow follow-up

- 合并后归档本 change（`openspec archive shell-and-pages-polish`）；本 change 设 `skip_specs: true`，
  归档时不应改动 `openspec/specs/`。
