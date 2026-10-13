---
name: obox-ext-proposal
description: obox 扩展开发九步链的**第 3 步**：把 grill 结论写成 `proposal.md` 与官方格式的 spec delta（`## ADDED/MODIFIED/REMOVED Requirements` + `### Requirement:` + 4 个 `#` 的 `#### Scenario:`）。当用户说"写扩展提案 / 出 proposal 与 spec delta / 按 obox-ext-proposal 走"，或要在动手设计前定"改什么、算不算达标"时使用。
---

# obox-ext-proposal — 提案与规格增量

## 职责

**做**：把 `notes/grill.md` 的结论**汇总**为两份可被官方 CLI 校验的产物——`proposal.md`（为什么做、改什么、影响面）与 spec delta（每条 requirement + scenario，写明 SHALL/MUST）。

**不做**：不重新提问（缺结论就回 `obox-ext-grill`）；不写交互逻辑、UI 视觉规范、技术选型（归 `obox-ext-design`）；不写任务拆分（归 `obox-ext-task`）；不写代码。

公共约定（目录布局、双标识、门禁四选项、提问规范）见 [`docs/extension-workflow.md`](../../docs/extension-workflow.md)，冲突时以它为准。

## 输入与前置检查

| 前置                                                                                                         | 缺了怎么办                                                  |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `openspec/changes/<change-id>/notes/grill.md`，且无未决项                                                    | 停下报错："grill 未闭环"，指向具体维度并回 `obox-ext-grill` |
| `openspec/changes/<change-id>/` 目录与 `.openspec.yaml`（含 `schema: spec-driven`、`created`、`uid:`）       | 停下报错并回 `obox-ext-init`；**不要**自己换 change-id      |
| API / manifest / 主题 的真相文档：`docs/extension-api/{api-reference,manifest-reference,themes-settings}.md` | 停下报错，先修文档；**不得**凭记忆写 API                    |
| `openspec --version` 是否可用                                                                                | 不可用**不阻塞**：跳过官方校验并在产物里注明"未跑官方校验"  |

## 步骤

1. **定 capability 划分**。规则（三条一起用）：
   - 一个 **capability = 一条能力线**（用户视角的一个关注点），名字用英文 **kebab-case** 名词短语，如 `connection-management`、`profile-root`、`search-box`；
   - capability 路径 = `specs/<capability>/spec.md`，**落在 change 目录内**；一个 change 下同 capability 只出现一个文件；
   - 判据：写 requirement 时能只谈这一条能力线，不必用"以及 / 同时"夹带另一条。夹带了就拆。
     划分与 `openspec/specs/`（"当前真相"）里既有 capability 的对应关系（新增 / 修改 / 删除）要显式写在 `proposal.md` 的 `## Capabilities` 里。
     **完成判据**：每个 capability 都能用一句话说清它管什么，且没有两条重叠。
2. **写 `proposal.md`**（路径：`openspec/changes/<change-id>/proposal.md`）。**硬事实：缺 `## Why` 或 `## What Changes` 会被 `openspec validate` 直接判错**，两个标题必须**逐字**存在：

   ```markdown
   # <change-id> — <中文标题>

   ## Why

   （来自 grill 的痛点 / 现状 / 成功标准；写"为什么必须做"，不写方案）

   ## What Changes

   （改了哪些对外行为；逐条对应下面的 requirement）

   ## Capabilities

   ### New

   - `<capability>`：一句话

   ### Modified

   - `<capability>`：改哪条既有 requirement

   ## Impact

   （受影响文件 / 贡献点 / 数据与配置 / 兼容与迁移 / 分发）
   ```

   **完成判据**：两个必需标题逐字存在；`## What Changes` 的每条都能在 spec delta 里找到对应 requirement。

3. **写 spec delta**（路径：`openspec/changes/<change-id>/specs/<capability>/spec.md`）。结构必须逐字如下，**`#### Scenario:` 正好 4 个 `#`**（3 个会静默失败、6 个同样非法）：

   ```markdown
   ## ADDED Requirements

   ### Requirement: <一句话，写清必须发生什么>

   正文必须含 **SHALL** 或 **MUST**，写明约束对象与边界。

   #### Scenario: <场景名>

   - **WHEN** <触发条件>
   - **THEN** <可观察结果>

   #### Scenario: <另一个场景>

   - **WHEN** …
   - **THEN** …

   ## MODIFIED Requirements

   （同结构；正文同样须含 SHALL/MUST）

   ## REMOVED Requirements

   （只写被删的 requirement 标题与删除理由）
   ```

   三条硬事实：**每个 `### Requirement:` 至少一个 `#### Scenario:`**；ADDED / MODIFIED 的正文**必须含 SHALL 或 MUST**（否则 warning，`--strict` 下算失败）；只加 `## MODIFIED` 却改的是不存在于 `openspec/specs/**` 的 requirement 时，按 ADDED 处理并在步骤 1 的 `## Capabilities` 里对齐。
   **完成判据**：逐条核对，每个 `### Requirement:` **至少**一个 `#### Scenario:`——**不要求 scenario 总数与 requirement 条数相等**（一条 requirement 两个 scenario 是对的）。

4. **引用 API 到具体位置**。凡提到宿主 API / 贡献点 / 主题 token，必须给 `docs/extension-api/**` 的**具体章节或 `文件:行`**（例：`docs/extension-api/api-reference.md` 的 `api.app.register` 小节、`docs/extension-api/manifest-reference.md:144` 的 `contributes.settings` 形状）。**完成判据**：proposal 与 spec delta 里每个 API 名字后面都挂了锚点，无裸名字。
5. **可选官方校验**。装了 CLI 就跑 `openspec validate --strict <change-id>`（在扩展工程根执行）；不通过 → 修到通过再进门禁。未装 → 在 `proposal.md` 末尾加一行"未跑官方校验（缺 `openspec` CLI）"。**完成判据**：通过，或已留下跳过声明。

## 产物与路径

```text
<扩展工程>/openspec/changes/<change-id>/
├── proposal.md                        # ## Why / ## What Changes / ## Capabilities / ## Impact
└── specs/<capability>/spec.md         # spec delta（官方结构）
```

**不**在本步写 `openspec/specs/<capability>/spec.md`（"当前真相"）：那由归档合并或 `obox-ext-init` 的反向提炼维护。

## 门禁

`ask_user_question` 问「本步产出是否符合要求？」，选项恒为：

1. **通过，自动进入 `obox-ext-design`（推荐）** —— 下一步出 `design.md`（交互逻辑 + UI 视觉规范，含 UI 风格提问）；选它时**读 `skills/obox-ext-design/SKILL.md` 并照做**。
2. **部分修改后重跑本步** —— 用户说明要改哪条 requirement / 哪个 capability 划分。
3. **回到上一步 `obox-ext-grill`** —— 发现结论本身缺漏时回退重问。
4. **暂停** —— 用户先人工检查。

## 完成判据

- `proposal.md` 存在且含逐字的 `## Why` 与 `## What Changes`（另含 `## Capabilities`、`## Impact`）；
- 每个 capability 一个 `specs/<capability>/spec.md`，结构为 `## ADDED/MODIFIED/REMOVED Requirements` + `### Requirement:` + **4 个 `#`** 的 `#### Scenario:`；
- 每个 requirement ≥1 scenario，ADDED/MODIFIED 正文含 SHALL 或 MUST；
- `change-id` 为 lower-case kebab-case（无大写 / 下划线 / 连续连字符 / 中文）；
- 每个 API 引用带 `docs/extension-api/**` 章节或 `文件:行`；
- CLI 装了则 `openspec validate --strict` 通过；未装则已注明"未跑官方校验"。
