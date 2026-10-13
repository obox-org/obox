---
name: obox-ext-ship
description: 扩展实现验收通过后的交付收尾：归档、文档同步、提交或发版。当用户要求归档扩展规格、提交扩展改动、给扩展打 tag 发版，或九步链走到第 9 步时使用。
---

# obox 扩展开发 · 第 9 步：交付与发版

## 职责

**做**：check 通过后按固定顺序收尾——交付归档 → 工具归档 → 文档同步 → 提交与发版 → 收尾自检。
**不做**：不改业务代码（发现问题回 `obox-ext-dev`）；不在用户没答"是否发版"时发版。

先读 `docs/extension-workflow.md`（§二 目录布局、§三 双标识与映射、§八 dev 与 ship 的边界、§五 门禁）与 `AGENTS.md` 的提交约定，**逐条照做**。

## 输入与前置检查

| 输入        | 路径                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| check 结论  | `openspec/changes/<change-id>/notes/check.md`（须已通过）                         |
| change 目录 | `openspec/changes/<change-id>/{proposal.md,design.md,tasks.md,specs/**,notes/**}` |
| 扩展工程    | `extensions/<扩展英文名>/`（或内置扩展 `src/renderer/src/extensions/<id>/`）      |

开工前确认，**不过就回到对应步骤**：

1. `notes/check.md` 存在且无未处置的严重问题。
2. `git status --porcelain=v1` 只有本次开发预期的改动；**确认 `dev` 留下的是未提交状态**。
3. `.openspec.yaml` 的 `uid:` 存在且形如 `UID-{14 位时间戳}-{≤10 字中文描述}`。

## 步骤

### 1. 交付归档

建 `<扩展工程>/docs/spec/UID-{YYYYMMDDHHmmss}-{≤10字中文描述}/`，复制 `proposal.md` / `design.md` / `tasks.md` / `specs/` / `notes/{grill.md,validation.md,dev.md,check.md,tasks/}`（`notes/dev.md` 是门槛原始输出的唯一留存，不能丢；`notes/ship.md` 见步骤 5，写出后补进同一 `notes/`），并写 `index.md`：`change-id:` ↔ `uid:` **双向映射** + 三档结论摘要（严重/普通/建议各计数与关键条目）+ 归档时间。

**完成判据**：`index.md` 的两个标识与 `.openspec.yaml`、目录名三方一致；源文件全部到位（逐个核对文件清单，不缺不多；`notes/ship.md` 除外——它在步骤 5 写出后补入）。

### 2. 工具归档

有 CLI（`openspec --version` 成功）→ 跑 `openspec archive <change-id>`；无 CLI → 按官方规则手工移 `openspec/changes/<change-id>/` 到 `openspec/changes/archive/YYYY-MM-DD-<change-id>/`。

**完成判据**：`openspec/changes/<change-id>/` 已不存在；归档目录落位正确；产物里注明用了哪种方式。

### 3. 文档同步

按改动性质更新，**没变化的要写明"无需更新"的理由**，不留空白：

| 改动性质                                       | 要更新                                                   |
| ---------------------------------------------- | -------------------------------------------------------- |
| 目录结构 / 常用命令 / 架构 / 技术栈 / 文档导航 | 该仓库 `README.md`                                       |
| 术语                                           | 该仓库 `CONTEXT.md`                                      |
| 宿主 / 主进程 / 扩展系统                       | 仓库 `docs/adr/`（续现有编号）                           |
| 扩展自身                                       | 扩展工程 `docs/adr/`                                     |
| 改过宿主 API / 贡献点 schema / IPC             | `docs/extension-api/` 对应文档（`AGENTS.md` 的同步义务） |

**完成判据**：上表逐行有结论且**逐行落盘到 `notes/ship.md`**（每行写"要更新哪个文件"或"无需更新 + 理由"）；被改的文件与改动性质对得上（宿主改动落仓库 `docs/adr/`，扩展改动落扩展 `docs/adr/`）。

### 4. 提交与发版

**先判断仓库类型**，两条路互不混用：

- **宿主仓库**：建分支（`feat|fix|docs/xxx`）→ `git commit`（Conventional Commits + 中文摘要）→ `git push` → 开 PR。**PR 正文用 UTF-8 文件写入后以字节体发送（`UTF8.GetBytes`），绝不把中文写进 pwsh 命令行** → 等 CI 的 `check` 变 `success` 且 `mergeable=true` → 用 API squash 合并 → `DELETE` 源分支。
- **扩展仓库**：`git commit` → `git tag v<版本>` → `git push`（含 tag）→ 用 `gh`/API 建 release 并上传 `out/<name>-<版本>.oix`；版本号与 `manifest.json` 的 `version` 一致。

**发版前必须用 `ask_user_question` 单独问一次"是否发版"**——即使本步其他工作已完成，**不得把发版混进本步的收尾门禁里一起问**，也不得默认发版。这一问的选项与用户答复**写进 `notes/ship.md`**。

**完成判据**：宿主路径下 PR 已合并且源分支已删；扩展路径下 tag 与 release 都存在并挂了 `.oix`；发版一问已问且答复已照做。

### 5. 收尾自检与 `notes/ship.md` 落盘

`git status` clean；PR 链接（或 tag 名）在手；合并/发版后跑 `npm run security:audit`（须 0 告警）并查 Dependabot 开放告警（须 0）；宿主改动涉及 `src/**` 时复跑 `npm run typecheck` / `lint` / `test`。

把步骤 3 / 4 / 5 的结论**按节写进 `openspec/changes/<change-id>/notes/ship.md`**——它落盘的位置固定为**文档同步逐行结论 + 发版一问（选项与答复）+ 收尾自检**三节。步骤 2 之后 change 目录已移到 `openspec/changes/archive/YYYY-MM-DD-<change-id>/`，就写在那里；写完把最终版**补同步进交付归档**的 `notes/`。文档同步结论与发版一问的答复在步骤 3 / 4 就写、随那一次提交落盘；只有合并/发版后才拿到的自检结果会晚于提交，作为一次**收尾提交**落盘（宿主仓库走 `docs/` 分支并入同一 PR 流程；扩展仓库把这类自检排在打 tag 之前）。

**完成判据**：自检各项有原始输出或可访问链接；任何一项不为 0 / 不为 clean 都写清原因与后续处置，不隐瞒；`notes/ship.md` 三节齐全，且已补进交付归档。

### 6. 门禁

见下（流程结束，无"下一步技能"）。

## 产物与路径

- `<扩展工程>/docs/spec/UID-…/`（交付归档：`index.md` + proposal / design / tasks / specs / notes（含 `dev.md` 门槛原始输出、`ship.md` 三节结论））
- `openspec/changes/archive/YYYY-MM-DD-<change-id>/`（工具归档，含 `notes/ship.md`）
- 更新后的 `README.md` / `CONTEXT.md` / `docs/adr/**` / `docs/extension-api/**`（按需）
- 宿主：PR（已 squash 合并）；扩展：`v<版本>` tag + release + `.oix`

## 门禁

用 `ask_user_question` 问「本步产出是否符合要求？」：

1. **通过，流程结束（推荐）** —— 九步链跑完；回报归档目录、PR 链接（或 tag / release）、安全审计与 Dependabot 结果。本步已是最后一步，**没有下一步技能**。
2. **部分修改后重跑本步** —— 用户说明要改哪一项（归档、文档、提交或发版）。
3. **回到上一步 `obox-ext-check`** —— 回退并重做验收检查。
4. **暂停** —— 用户先人工检查（含"先不发版，只留归档与提交"）。

被选 1 时流程结束，不再读取其它技能文件。

## 完成判据

- 交付归档与工具归档都落位，`change-id` ↔ `uid` 双向映射一致；
- 文档同步逐行有结论（含"无需更新"），且三节结论随 `notes/ship.md` 落盘并进交付归档；
- 宿主走分支 → PR → CI → squash 合并并删分支；扩展走 commit → tag → release 并附 `.oix`；
- **发版前单独问过一次**，且按答复执行；
- `git status` clean，`security:audit` 0 告警，Dependabot 开放告警 0，门禁问过并拿到用户选择。
