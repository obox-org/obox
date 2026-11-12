---
name: obox-ext
description: obox 扩展开发的唯一入口：先判断当前在第几步，再读对应阶段文件并照做。当用户说"做一个 obox 扩展 / 继续扩展开发 / 按 obox-ext 走 / 现在到第几步了"，或要在既有扩展上改需求时使用。
---

# obox-ext — 扩展开发入口（九步链调度）

`skills/obox-ext/` 是一套完整的扩展开发流程：**本文件是唯一入口**，九个阶段文件在它的子目录里。
入口只做三件事——**判断阶段、读阶段文件、交接门禁**；流程细节一律以阶段文件为准。

> 公共总览（目录布局、双标识、API 唯一真相、门禁四选项、三档结论、并行规则）见
> `docs/extension-workflow.md`。本文件**不复制**这些内容；冲突时以总览 + 阶段文件为准。

## 怎么触发

仓库 `skills/` 不在 DSH 扫描路径内，按**路径手动触发**：

> "读 `skills/obox-ext/SKILL.md`，按它走扩展开发流程" ／ "…从第 N 步开始" ／ "…接着上次的进度"

## 调度：先判断阶段

按顺序判断，**只认证据不靠猜**：

1. **用户明说**第 N 步或点名某个阶段 ⇒ 直接用那一步。
2. **有既有产物** ⇒ 从产物倒推（看索引表"何时进这一步"）。例：只有 `openspec/` ⇒ 第 1 步的修复模式；
   有 `notes/grill.md` 但无 `proposal.md` ⇒ 第 3 步；有 `notes/check.md` 且结论通过 ⇒ 第 9 步。
3. **全新需求、没有扩展工程** ⇒ 第 1 步。
4. **判断不了或有冲突**（缺中间产物、产物属于别的 change 等）⇒ 用 `ask_user_question` 问一次
   "从哪一步开始"，给 2–4 个候选 + 「其他（我来说明）」，不要自行假设。

## 九步索引

| #   | 阶段文件                                            | 产出（写完即此步完成）                                    | 何时进这一步                     |
| --- | --------------------------------------------------- | --------------------------------------------------------- | -------------------------------- |
| 1   | `skills/obox-ext/obox-ext-init/SKILL.md`            | 扩展工程 + `openspec/` + `docs/spec/UID-…/`（新建时）      | 新需求无工程；或工程结构要修     |
| 2   | `skills/obox-ext/obox-ext-grill/SKILL.md`           | `notes/grill.md`（穷尽问答）                              | 需求含糊、边界没问清             |
| 3   | `skills/obox-ext/obox-ext-proposal/SKILL.md`        | `proposal.md` + spec delta                                | grill 结论齐了，要定"改什么"     |
| 4   | `skills/obox-ext/obox-ext-design/SKILL.md`          | `design.md`（含 UI 风格提问）                             | spec delta 定稿，要定交互与视觉  |
| 5   | `skills/obox-ext/obox-ext-validation/SKILL.md`      | `notes/validation.md`（三档结论 + 修复意见）              | spec + design 写完，写码前自查   |
| 6   | `skills/obox-ext/obox-ext-task/SKILL.md`            | `tasks.md` + `notes/tasks/<nn>-<slug>.md`                 | 规格通过，要拆任务卡             |
| 7   | `skills/obox-ext/obox-ext-dev/SKILL.md`             | 代码 + 测试 + `notes/dev.md`（**不提交**）                | 任务卡就绪，开始实现             |
| 8   | `skills/obox-ext/obox-ext-check/SKILL.md`           | `notes/check.md`（**纯检查，不改码**）                    | 实现完成，独立验收               |
| 9   | `skills/obox-ext/obox-ext-ship/SKILL.md`            | 交付归档 + `notes/ship.md` + 提交/发版                    | check 通过，收尾交付             |

## 执行循环（每一步都走这四拍）

1. **读**：读该阶段文件全文，照它的步骤做（不凭记忆、不凭印象简化）。
2. **做**：产出该阶段声明的文件；需要 API 事实时查 `docs/extension-api/`（唯一真相），给章节或 `文件:行`。
3. **门禁**：阶段结尾必须用 `ask_user_question` 问那**一次**四选项 —— **措辞只在该阶段文件里维护，本入口不复述**。
   按用户的选择处理：留在本阶段改 / 退回上一步重做 / 停手报告；只有"通过并进入下一步"才走到第 4 拍。
4. **交接**：选"通过，自动进入下一步" ⇒ **回到本索引表**定位下一步，读它的阶段文件继续。

## 硬约束

- **一次只在一步**：不并步、不预写后续阶段产物（例如没做 validation 就先写 `tasks.md`）。
- **不跳门禁**：下一步永远由用户在门禁里确认；不得自行推进。
- **失败回流**：`validation` 不通过由用户在门禁里选回 `proposal` 还是 `design`；
  `check` 的严重问题回 `dev` 修正后重跑（自动链最多 3 轮，之后交用户裁定）。
- **`dev` 只改代码不提交**，提交与发版在 `ship`，且**发版前必须单独问用户一次**。
- **证据**：任何"已完成"都要有命令输出或实机结果；未实机验证的显式标注。
- **提问规范**：中文、`ask_user_question`、单次一个问题、2–4 个具体选项 + 优缺点 + 恰好一个「推荐」置首
  + 一个「其他（我来说明）」。
