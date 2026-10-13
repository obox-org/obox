---
name: obox-ext-design
description: obox 扩展开发九步链的**第 4 步**：把 spec delta 落成 `design.md`（状态/事件/边界/错误的交互逻辑、UX 流程、UI 视觉规范），并**必须问一次 UI 风格**。当用户说"出扩展设计文档 / 定界面与交互 / 按 obox-ext-design 走"，或要在写代码前定交互与视觉规范时使用。
---

# obox-ext-design — 交互与视觉设计

## 职责

**做**：读 spec delta，产出 `design.md`：交互逻辑（状态 / 事件 / 边界 / 错误 / 空态）、UX 流程、UI 视觉规范、风险与取舍、未决问题。**UI 风格必须由用户在本步选**。

**不做**：不改 requirement（要改就回 `obox-ext-proposal`）；不拆任务（归 `obox-ext-task`）；不写实现代码；不新造主题 token 或色值。

公共约定（目录布局、双标识、门禁四选项、提问规范）见 [`docs/extension-workflow.md`](../../docs/extension-workflow.md)，冲突时以它为准。

## 输入与前置检查

| 前置                                                                                                                         | 缺了怎么办                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `openspec/changes/<change-id>/specs/<capability>/spec.md`（spec delta）                                                      | 停下报错并回 `obox-ext-proposal`                   |
| `openspec/changes/<change-id>/proposal.md`                                                                                   | 同上                                               |
| 真相文档 `docs/extension-api/themes-settings.md`（token 全量参考 §"Token 全量参考"）与 `docs/extension-api/api-reference.md` | 停下报错；**不得**凭记忆写 token 名或 API          |
| 参考实现 `extensions/rdp/src/styles.css`、`extensions/webapp/src/styles.css` 与各自 `src/theme.js`                           | 缺文件不阻塞，但要在 design 里注明"未取得参考实现" |

## 步骤

1. **读齐输入**：spec delta（每条 requirement / scenario）、proposal 的 `## Impact`、上表两个参考实现的样式与主题桥。**完成判据**：能逐条说出每个 scenario 在界面上对应什么。
2. **问 UI 风格**（本步强制，`ask_user_question` 一次，选项固定为该菜单）：
   1. **沿用现有扩展风格（推荐）** —— 照 `extensions/rdp`、`extensions/webapp` 的 `src/styles.css` + `src/theme.js` 的写法与密度。优点：与宿主既有观感一致、有现成基线与已验证的主题桥；缺点：视觉上限被既有风格锁定。
   2. **原生克制风** —— 最少装饰、接近宿主原生控件。优点：最省事、不会与宿主冲突；缺点：信息密度低，卡片列表类界面容易显平。
   3. **卡片密集风** —— 小间距多卡、适合长列表与批量操作。优点：一屏信息多；缺点：窄窗口与高 DPI 下易拥挤，需要额外的窄窗堆叠规则。
   4. **大间距仪表盘风** —— 大留白、大字重、少控件。优点：概览页清晰；缺点：操作密集的表单场景要多次滚动。
   5. **自定义（我来说明）** —— 选定后**必须再追问三项**：主色来源（用宿主哪个 token）、密度（行高 / 间距档位）、圆角（档位）。缺点：超出既有基线，需自行承担一致性与验收成本。
      **完成判据**：用户选定一项（选 5 时三项追问都已答），且该结论已写进 `design.md` 的 `## UI 视觉规范`。
3. **写 `design.md`**（路径：`openspec/changes/<change-id>/design.md`），固定七节：
   - `## Context`：现状、约束（宿主能力边界、扩展是受信代码、子窗口跨源）、参考实现。
   - `## Goals / Non-Goals`：本轮要达成 / 明确不做；与 proposal 的范围一致。
   - `## Decisions`：决策逐条写「选择 → 理由 → 被否决的备选」。每条含**交互逻辑**：状态表（状态 / 触发 / 界面表现 / 退出条件）、事件与载荷形状（消息通道名 + 字段）、边界（空列表、超长文本、极窄窗口、并发操作）、错误与空态（用户可见中文文案 + 是否可重试）；涉及子窗口消息的，载荷形状必须与 `docs/extension-api/themes-settings.md` §"App 子窗口（`url` 型）主题下发协议"、`docs/extension-api/api-reference.md` §`app.onMessage` 对齐。
   - `## UX 与交互流程`：主路径逐步、失败路径、键盘可达性（Tab 顺序、焦点落点与归还）。
   - `## UI 视觉规范`：第 2 步选定的风格 + **只用宿主 token**（数量与清单见 `docs/extension-api/themes-settings.md` §"Token 全量参考"，25 个）+ 每条硬约束的落实方式。
   - `## Risks / Trade-offs`：技术风险、UX 风险、兼容风险；每条给退场条件。
   - `## Open Questions`：仍待定的问题（谁回答、阻塞哪一步）。
     **完成判据**：七节齐全；`## Decisions` 至少覆盖"每个 scenario 的界面表现"与"错误 + 空态"两块。
4. **套硬约束（逐条自检，缺一不可）**：
   - **零自造色值**：不写 `#rrggbb` / `rgba(...)` 当实际色值，只用宿主主题 token（`var(--token, fallback)` 的 fallback 仅兜首帧，见 `docs/extension-api/themes-settings.md`）；
   - **只用宿主主题 token**：新增视觉需求先找既有 25 个 token 里能用的，找不到才提出"需要新 token"并说明去向（`theme-dark` / `theme-light` 同步）；
   - **标签列固定宽、左对齐**（表单）；
   - **窄窗口堆叠**布局；
   - **下拉选项的说明写在选项文本内**，不靠外部 tooltip 补充语义；
   - **模态框只能按钮关闭**（点遮罩、按 Esc 都不关闭）；
   - **中文文案**（界面文案一律中文，错误文案可执行）。
     **完成判据**：七条逐条在 `## UI 视觉规范` 里有对应落实句。
5. **可选官方校验**：装了 CLI 就在扩展工程根跑 `openspec validate --strict <change-id>`；不过则修到通过。未装则注明"未跑官方校验"。**完成判据**：通过或已注明跳过。

## 产物与路径

```text
<扩展工程>/openspec/changes/<change-id>/design.md   # 七节：Context / Goals-Non-Goals / Decisions / UX 与交互流程 / UI 视觉规范 / Risks-Trade-offs / Open Questions
```

## 门禁

`ask_user_question` 问「本步产出是否符合要求？」，选项恒为：

1. **通过，自动进入 `obox-ext-validation`（推荐）** —— 下一步对 spec delta + `design.md` 做质量检查并出三档结论（`notes/validation.md`）；选它时**读 `skills/obox-ext-validation/SKILL.md` 并照做**。
2. **部分修改后重跑本步** —— 用户说明要改哪节（风格、交互逻辑、错误处理）。
3. **回到上一步 `obox-ext-proposal`** —— 设计中发现 requirement 本身要改时回退。
4. **暂停** —— 用户先人工检查。

## 完成判据

- `design.md` 存在且七节齐全；
- UI 风格已由用户在固定的五项菜单里选定（选「自定义（我来说明）」时主色来源 / 密度 / 圆角三项已答），并写进 `## UI 视觉规范`；
- 七条硬约束逐条有落实句，且 `## UI 视觉规范` 里的 token 名都能在 `docs/extension-api/themes-settings.md` 的 token 表里查到；
- 每个 scenario 都能在 `## Decisions` 或 `## UX 与交互流程` 里找到界面表现；
- 提到宿主 API / 消息载荷处都给了 `docs/extension-api/**` 的章节或 `文件:行`；
- CLI 装了则 `openspec validate --strict` 通过，未装则已注明"未跑官方校验"。
