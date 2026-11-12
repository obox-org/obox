# Tasks

## 1. 新增 token 与默认值

- [x] 1.1 在 `src/renderer/src/assets/main.css` 的 `:root` 增加 `--fg-on-accent: #ffffff;`（放在 `--accent` 之后）；
      验证：`grep -n "fg-on-accent" src/renderer/src/assets/main.css` 命中一行
- [x] 1.2 在 `theme-dark` 与 `theme-light` 两个主题 manifest 的 `contributes.themes[].tokens` 各加一行 `"--fg-on-accent": "#ffffff"`；
      验证：两套主题的键集合与 `main.css` 的 `:root` 键集合**逐个相等**（写一段 node 脚本比对，输出差集为空）

## 2. 组件库改用新 token

- [x] 2.1 逐条清点 `src/page-runtime/ui.css` 里"声明了实心填充 `background: var(--accent|--fg-error|--fg-success|--fg-warning)` 且同时声明 `color:`"的规则，
      把 `color` 换成 `var(--fg-on-accent)`（已知至少 `.obox-btn--primary`、`.obox-btn--primary:hover`、`.obox-btn--danger:hover`，
      实心 tag / 进度条 / 开关 / 单选圆点等以清点结果为准）；
      验证：`grep -n "background: var(--accent)" -A6 src/page-runtime/ui.css` 逐条核对，`color` 不再是 `--fg-bright` / `--bg`
- [x] 2.2 处理深色主题下 `--fg-error` (#f48771) 上白字对比度只有 2.1:1 的问题：把危险按钮 hover 的填充改为加深的红
      （如 `color-mix(in srgb, var(--fg-error) 85%, var(--bg))`）或改为"淡底 + 危险色文字"，二选一并在 design 里回填结论；
      验证：深色主题下截图，按钮文字清晰可读
- [x] 2.3 `test/ui-css.test.ts` 增加断言：任何"实心填充 + color"的规则，`color` MUST 为 `var(--fg-on-accent)`；
      验证：`npx vitest run test/ui-css.test.ts` 通过，且临时把某条规则改回 `--fg-bright` 时该用例变红（手测一次后还原）

## 3. 文档与规格同步

- [x] 3.1 `docs/extension-api/themes-settings.md`：token 对照表加 `--fg-on-accent` 一行（两主题同值），
      并把"25 个 token"改为"全部主题 token（当前 26 个）"；补一句给第三方主题的提示（若把 `--accent` 调浅，请一并声明 `--fg-on-accent`）；
      验证：文档里出现的 token 数量与实际 `:root` 键数一致，且表中每一行都能在 `main.css` 找到
- [x] 3.2 全仓搜硬编码的 `25 个 token` / `25` 断言，改为"与 `main.css` 的 `:root` 键集合相等"；
      验证：`grep -rn "25 个" docs/ test/ src/` 只剩历史 ADR 记录，无活代码/活文档

## 4. 集成验证与交付

- [x] 4.1 门槛全绿：`npm run typecheck` + `npm run lint`（0 error）+ `npm test`
- [x] 4.2 真机回归：深色与浅色主题分别截 `扩展管理`（主按钮「安装扩展…」）、`应用`、`设置-通用`；
      浅色下主按钮为白字，深色下不出现红底黑字；截图贴进 PR
- [x] 4.3 从 master 拉 `fix/on-accent-color-token` 分支，中文 commit message，推送并开 PR，CI `check` 绿后 squash 合并并删分支
- [x] 4.4 合并后复核 `npm run security:audit --registry=https://registry.npmjs.org` = 0 与 Dependabot = 0

## Workflow follow-up

- 合并后归档本 change（`openspec archive on-accent-color-token`），确认 `extension-ui-components` 与
  `extension-page-context` 两份主规格都已吸收本次的 MODIFIED 内容。
