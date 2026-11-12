# Design

## Context

见 [proposal.md](proposal.md) - Why。影响设计的既有事实：

- 25 个 token 在三处必须逐项对齐：`src/renderer/src/assets/main.css` 的 `:root`、两个主题扩展的 `contributes.themes[].tokens`、`docs/extension-api/themes-settings.md` 的对照表（该文档末尾自己写着"三处任一处增删或改名 token，本表必须同步"）。
- `ui.css` 的门禁禁止字面色值（`#hex` / `rgb()`），所以"白字"只能来自 token（`test/ui-css.test.ts`）。
- 页面上下文推送用 `tokens` 的**生效值**（`main.css` 默认 + 主题覆盖），扩展页面拿到的是全量键，因此**新增 token 对旧页面是纯加法**。
- `.obox-btn--primary`、`.obox-btn--danger:hover` 之外，`ui.css` 里还有若干"填充色 + 前景"组合（实心 tag、进度条、开关、单选圆点等），需要逐条核对而不是只改用户看到的那一个。

## Goals / Non-Goals

**Goals:**

- 引入一个**不随明暗翻转**的前景色 token，把"填充色之上的文字"统一收口。
- 让浅色主题下的主按钮恢复为白字；顺带修掉深色主题下"红底黑字"的反向问题。
- 新增 token 时，第三方主题/旧页面不升级也不坏（回落默认值）。

**Non-Goals:**

- 不重新设计浅色主题的**整体**配色（背景/边框/正文色保持现状）。
- 不改任何组件的尺寸、间距、圆角与阴影（那是另一个 change 的事）。
- 不删除已有的 25 个 token，不改它们的语义。

## Decisions

### D1：新增语义 token `--fg-on-accent`，而不是"让主按钮不用实心底"

备选方案是"把主按钮改成浅底 + 强调色文字/描边"，那样不需要新 token。但：

- 实心主按钮是既有视觉语言（`--primary` 在设计里就是"最重的动作"），改成描边会让主次弱化；
- 问题不是主按钮，而是**所有填充色上的前景**（danger hover、实心 tag、开关圆点…），逐个改成"浅底派"等于重画一套组件；
- 语义 token 是**一次性投资**：以后新增实心组件直接复用。

### D2：取值 `#ffffff`，两套主题同值

- 填充色 `--accent` 是 `#007acc`（两套主题相同），白字对比度约 4.8:1，达 AA（普通文字稍紧，但按钮文字是 14px 半粗，可接受；如需更稳可后续换 `#f5f5f5`）。
- `--fg-error` 深色 `#f48771` / 浅色 `#c42b1c`：白字在两者上分别是 2.1:1（深色主题偏浅的红，白字偏弱）与 5.9:1。**深色主题的 danger hover 因此仍不够**——设计里记下这个已知取舍：hover 态是瞬时反馈，且危险按钮的正文色仍是 `--fg-error`（描边派），只有 hover 才填色。
- 若以后要为"浅色填充"（如 `--fg-warning` `#cca700`）也提供前景，可再加 `--fg-on-warning`；本次不做。

**实施回填（2026-11-12）**：危险按钮 hover **没有**采用"加深填充 + 白字"，改为**淡底 + 危险色文字**
（`background: color-mix(in srgb, var(--fg-error) 18%, transparent)` + `color: var(--fg-error)`）。原因：
`--fg-error` 在深色主题是偏浅的红、浅色主题是较深的红，任何"压暗到白字可读"的混色在另一套主题里都会变糊；
淡底方案在两套主题下都由同一个 token 决定文字色，最稳。代价是 hover 反馈变柔和（有 `--obox-transition` 过渡补足观感）。

### D3：改法的边界 —— 只改"背景是填充色"的规则

判据：该规则自己声明了 `background: var(--accent)` / `var(--fg-error)` / `var(--fg-success)` / `var(--fg-warning)` 这类**实心填充**，且同时声明了 `color:`。只改这些；`--selection-bg`、`--hover-bg`、`--bg-*` 这些"表面/半透明"背景上的文字仍用 `--fg` / `--fg-bright`（它们本来就是随主题走的，正确）。

### D4：门禁怎么写

- `test/ui-css.test.ts` 增加一条：凡是"实心填充 + color"的规则，`color` MUST 是 `var(--fg-on-accent)`；
- `test/page-context.test.ts` / `test/overlay-theme.test.ts` 里写死的 25 改为"与 `main.css` 的 `:root` 键集合逐个相等"（不再硬编码数字），这样以后加 token 只改一处。
- 主题一致性门禁（如有）继续断言"两个主题的键集合 = `main.css` 的键集合"。

## Risks / Trade-offs

- **[对比度不足]** 深色主题 `--fg-error` (#f48771) 上的白字只有 2.1:1 → 危险按钮 hover 的可读性没有真正解决。
  缓解：把 hover 态改为"加深的填充"（例如用 `color-mix` 把 error 压暗 15%）或改用 `--fg-error` 文字 + 淡底；实施时以真机截图定，并在 design 里留记录。
- **[第三方主题]** 旧主题没声明 `--fg-on-accent` → 回落白字，主按钮正常；但如果第三方主题把 `--accent` 改成很浅的颜色，白字会看不清。
  缓解：文档写明"若你的主题把 `--accent` 调浅，请一并声明 `--fg-on-accent`"。
- **[数字写死处遗漏]** "25 个 token"散落在文档与多个测试里 → 改成"与 `:root` 键集合相等"后，仍需全仓搜一遍 `25` 确认没有别的硬编码断言。

## Migration Plan

1. 加 token：两个主题 manifest + `main.css` 默认值。
2. 改 `ui.css` 的填充类规则（逐条核对，见 tasks）。
3. 改文档 token 表与数量表述。
4. 改门禁（数量→键集合相等；新增"填充色前景"断言）。
5. 真机：深/浅两主题各截 `扩展管理`（主按钮）、`设置-通用`（danger 按钮无）、`关于` 等含实心按钮的位置。
6. 回滚：一次 `git revert`；token 是纯加法，回滚不会留下孤儿引用。

## Open Questions

无。
