# 扩展开发流程：九步链与 OpenSpec 产物范式

## 背景

1. **原流程把多个阶段压在一个技能里**（ADR-0020 决策 4：M1–M8 提问 → `tmp/spec/` → 用户确认 → 设计文档 → 开发 → 测试 + 独立子代理审视 → `tmp/adr/`）。阶段耦合导致三个问题：需求澄清的质量取决于代理当次自觉；产物无固定结构（`tmp/spec/*.md` 是临时文件，归档前的形态全凭习惯）；**没有独立的质量检查环节**（"审视"写在开发步骤内部，容易走过场）。
2. **共享文档的位置与"公共位置"的要求不符**：`api-reference.md`（693 行）、`manifest-reference.md`（295 行）、`themes-settings.md`、`troubleshooting.md` 都躺在 `skills/obox-ext-dev/references/` 里，只有读技能的人看得到；而新流程要求 **spec / design / validation / dev 四个阶段都能看到 API 信息**。
3. **OpenSpec 是现成的产物范式**（`@fission-ai/openspec` v1.14.1，仓库 `Fission-AI/OpenSpec`）。2026-10-13 实测（把 CLI 装到临时目录真跑 `init` / `new change` / `validate` / `archive`）确认以下事实，它们直接约束本次设计：
   - `init --tools none` **只**创建 `openspec/config.yaml`、`openspec/specs/.gitkeep`、`openspec/changes/archive/.gitkeep`；**没有** `project.md`，也**不在** `openspec/` 下生成 `AGENTS.md`（流传的这两个路径是过时文档，v1.14.1 dist 全量 grep 零命中）。
   - `change-id` **强制 lower-case kebab-case**：只允许小写字母/数字/单个连字符，**禁大写、禁下划线、禁连续连字符、禁中文**；数字开头合法（`20260101-120000-x` 实测可用）。
   - `archive` **把 change 移动**到 `openspec/changes/archive/YYYY-MM-DD-<name>/`，路径与命名**硬编码、无任何配置开关**；目录名不以 `YYYY-MM-DD-` 开头时会再前缀当天日期。
   - **CLI 从不生成任何 artifact**（唯一例外是 `new change` 写 `.openspec.yaml`）：proposal / design / tasks / spec 全由代理按模板写 ⇒ "约定优于工具"成立。
   - `validate` **真校验**：proposal 缺 `## Why` 或 `## What Changes` 即报错；spec delta 的 `#### Scenario:` 必须**正好 4 个 `#`**（3 个会静默失败）、每个 requirement ≥1 个 scenario、正文须含 SHALL/MUST（否则 warning，`--strict` 变失败）。
   - **每个扩展工程各有一个 `openspec/` 是合法的**：根解析是"向上找最近的 `openspec/`"，嵌套实测成功；但要求该目录有规划形状（`specs/` 或 `changes/`）或 `config.yaml`，否则命令会继续向上落。

## 决策

1. **流程拆为九个顺序技能**（各占 `skills/obox-ext-<stage>/SKILL.md`，**不注册为 DSH skill**，沿用 ADR-0020 决策 2）：
   `obox-ext-init → obox-ext-grill → obox-ext-proposal → obox-ext-design → obox-ext-validation → obox-ext-task → obox-ext-dev → obox-ext-check → obox-ext-ship`
   每个阶段的产物是下一阶段的输入；每阶段结尾**必须**用 `AskUserQuestion` 过一次门禁（见决策 7）。
2. **每个扩展工程自带一个 `openspec/` 根**（官方布局：`config.yaml` + `specs/` + `changes/`），一次需求一个 change：`openspec/changes/<change-id>/{.openspec.yaml, proposal.md, design.md, tasks.md, specs/<capability>/spec.md}`，自研产物放 **`notes/`** 子目录（`grill.md`、`validation.md`、`check.md`）——官方 `validate` 只校验必需文件，额外文件不干扰。
3. **双标识**：`change-id` 用**英文 kebab-case**（满足官方硬约束、命令行友好）；`UID-{YYYYMMDDHHmmss}-{≤10字中文描述}` 作为**人读标识**与交付归档目录名。两者**双向映射**：change 的 `.openspec.yaml` 记 `uid:`，归档目录的 `index.md` 记 `change-id:`，并由门禁脚本校验一致。
4. **归档分工**：`openspec/changes/archive/YYYY-MM-DD-<id>/` 是**工具归档**（有 CLI 时由 `openspec archive` 产生，无 CLI 时按等价规则手工移动）；`<扩展工程>/docs/spec/UID-…/` 是**交付归档**，由 `obox-ext-ship` 写入（proposal / design / tasks / spec delta / validation / check 报告 + 映射 `index.md`）。两者语义不同，不允许只留其一。
5. **API 文档的唯一真相迁到仓库级公共目录 `docs/extension-api/`**：`api-reference.md`、`manifest-reference.md`、`themes-settings.md`、`troubleshooting.md` 从 `skills/obox-ext-dev/references/` 迁入；九步链各阶段与扩展工程文档一律引用该目录（不复制副本，避免漂移）。九步链总览移到同一公共位置（`docs/extension-api/workflow.md` 或 `docs/extension-workflow.md`）。
6. **OpenSpec CLI 是可选增强，不是依赖**：装了（`openspec --version` 成功）就在 proposal / design / tasks / validation 后**额外**跑 `openspec validate --strict` 作为质量门禁，未装则跳过并在报告里注明"未跑官方校验"。**不写进本仓库 `dependencies`。**
7. **门禁固定四选项 + 自动进入下一步**：每阶段结尾用 `AskUserQuestion` 问「本步产出是否符合要求？」，选项恒为 **① 通过，自动进入 <下一步>（推荐）② 部分修改后重跑本步 ③ 回到上一步 ④ 暂停**；选 ① 时代理**读下一个技能文件并照做**（不依赖 Skill 工具）。个别阶段需要第二问时再补（例如 validation 的结论若不通过，追问"回 proposal 还是 design"）。
8. **`validation` / `check` 的结论分三档**——**一般建议 / 普通问题 / 严重问题**，每条附**修复意见**，随后按档提问：**严重问题逐条问**（立即修复 / 改规格或设计 / 接受风险并登记 / 暂缓到下轮）、**普通问题合并为一次多选**、**一般建议默认只登记**并在门禁统一问一次。不自动修复、不自动阻断。
9. **`task` 出任务卡、`dev` 并行实现**：每张任务卡含 目标 / 输入（spec 与 design 的相关小节）/ **允许改动的文件清单（文件所有权）** / 验收命令 / 依赖与阻塞 / **并行组**；同一文件只能归一张卡。`dev` 按卡派子代理并行（同组并行、跨组串行），每卡回执"改动清单 + 门槛原始输出"。
10. **`dev` 不提交，`ship` 收尾**：`dev` 只写代码并跑门槛（typecheck / lint / test / 构建 / 打包），保持工作区未提交；`ship` 在 `check` 通过后执行归档、文档同步（README / CONTEXT / ADR）、提交与发版（宿主仓库走 分支 → PR → CI → squash 合并；扩展仓库走 commit → tag → release，**发版前必须问用户一次**）。
11. **入口：不放进 `AGENTS.md`，也不在 `README.md` 建指针**——九个技能**只由用户在会话里点名触发**（人类即索引）。`AGENTS.md` 中"Obox 扩展开发"整段（含 M1–M8 强制流程）删除，**仅保留"改宿主 API / 贡献点 schema / 主进程 IPC 必须同步 `docs/extension-api/` 与受影响的 `skills/obox-ext-*`"这一句同步义务**。
12. **`obox-ext-init` 先分模式**：先问**新建 / 修复**；新建 → 问 中文名 / 英文名 / 简要功能 / 作者 + 扩展形态 → 复用现有脚手架脚本在 `extensions/<英文名>/` 建工程（`git init` 但不建远端）；修复 → 列出 `extensions/` 下的工程（标注有无 `openspec/`）或由用户手输路径 → 缺 `openspec/` 则按官方最小布局补建 → 为本次修复开新 change → 默认从既有 `docs/spec/**` 反向提炼"当前真相"到 `openspec/specs/<capability>/spec.md`（能力划分需用户确认）。
13. **`obox-ext-design` 必须问 UI 风格**：给出固定风格菜单（沿用现有扩展风格（推荐）/ 原生克制风 / 卡片密集风 / 大间距仪表盘风 / 自定义），并强制既有硬约束（零自造色值、只用宿主 25 个主题 token、标签列固定宽左对齐、窄窗堆叠、下拉说明写在选项内、模态框只能按钮关闭）。

## 备选与否决理由

| 备选                                              | 做法                                                        | 否决理由                                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **单一 `UID-…` 作 change-id**                     | 用 `UID-{YYYYMMDDHHmmss}-{中文描述}` 直接当 change 目录名   | 与官方硬约束冲突（大写 `UID`、中文描述），`openspec validate` 必失败；只能退化为"约定自守、放弃官方工具链"                 |
| **严格只用 `docs/spec/UID-…/`，不建 `openspec/`** | 沿用旧习惯，产物只放 `docs/spec`                            | 失去官方 `validate` 的确定性检查与 `archive` 的规格合并；外部生态与 `rb-*` 系列流程也无法互通                              |
| **强制依赖 OpenSpec CLI**                         | 写进 `dependencies`，所有阶段必须过 `validate --strict`     | 引入 Node ≥20.19 与一批依赖、离线与 CI 需额外准备；官方自己也是"约定优于工具"（CLI 不生成 artifact）                       |
| **注册为 DSH skill（可 `/obox-ext-*` 触发）**     | 在 `~/.agents/skills/` 或仓库 `.agents/skills/` 放副本/链接 | ADR-0020 已记录两个坑：`SKILL.md` 超 8192 字符会被工具结果裁剪；Windows 符号链接权限与"第二份真源"。且九个描述会常驻上下文 |
| **在 `AGENTS.md` 放流程入口**                     | 由 always-loaded 文件指向九步链                             | 用户明确要求不放；且九个阶段的指针会把 always-loaded 文件撑长，而流程本身**只在做扩展时才需要**                            |
| **每个技能自带文档副本**                          | 各技能目录内各放一份 API/manifest 文档                      | 多份副本必然漂移（正是把文档迁到 `docs/extension-api/` 要消除的问题）                                                      |
| **`dev` 阶段直接提交/发版**                       | 开发完即 commit 并 release                                  | 与"`master` 只经 PR"和"发版由用户决定"两条既有约定冲突；且 `check` 发现问题时已经提交                                      |

## 后果

- **好处**：需求澄清与产物结构固定（proposal / design / tasks / spec delta 有官方模板可依），带病推进被门禁与三档结论挡在阶段边界上；API 文档第一次有了公共位置，四个阶段看同一份真相；任务卡的文件所有权让并行开发不再互相踩文件；`validation`、`check`、`ship` 三个环节把"检查"与"交付"从开发里拆出来，不再靠自觉。
- **代价**：一次需求从"1 个技能"变成"9 个技能 + 门禁 9 次"，交互次数明显增加；`change-id` 与 `UID` 两套标识需要门禁脚本维护一致；`docs/extension-api/` 搬迁会让既有引用（`AGENTS.md`、`docs/spec/obox-ext-dev-skill*.md`、`extensions/*/docs/**`、本 ADR 系列）需要一轮修正；不设入口意味着**新会话不会自己知道九步链存在**，必须由人点名。
- **风险与退场条件**：① 若九个技能的一致性靠人工维护而开始漂移，退场方案是加一道"九技能内容一致性"门禁脚本（本决策的验收里已含）；② 若将来官方 `openspec` 的 `config.yaml` 支持自定义归档目标，可把 `docs/spec/UID-…` 的写入交给 `archive`，消掉双归档；③ 若 `AGENTS.md` 不放指针在实践中导致流程被遗忘，退场方案是在 `README.md` 文档导航加一行（改动量 1 行）。

## 落地与验证

| 项                                       | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 结构自检                                 | 九个 `skills/obox-ext-*/SKILL.md`（每个 ≤8000 字符，实测 2736–7769）、`docs/extension-workflow.md`、`docs/extension-api/`（4 份文档 + 2 份指南）、`scripts/validate-manifest.mjs` 全部到位；旧 `skills/obox-ext-dev/references/` 与 `scripts/` 已迁空，`references/workflow.md` 删除                                                                                                                                                                                                                                                                                                                                                                                                    |
| 一致性门禁                               | 新增 `test/extension-skills.test.ts`（**14 项全绿**）：九步顺序（按门禁"下一步"真的串得通）、门禁四选项措辞、三档结论与 `文件:行`、API 公共路径、`frontmatter` 名称与 `description` 唯一、单文件 ≤8000 字符、**dangling reference**（解析技能里反引号包裹的仓库路径是否存在）、**"流程不设入口"**（`AGENTS.md`/`README.md` 不得出现总览指针）、**"旧流程不得复活"**（`tmp/spec`、`M1–M8`、技能内 `references/*`）                                                                                                                                                                                                                                                                       |
| 干跑（一次性示例扩展真跑 `init → ship`） | 目录与产物按规范生成（`openspec/changes/<id>/{.openspec.yaml,proposal.md,design.md,tasks.md,specs/,notes/}` + `docs/spec/UID-…/`）；硬约束逐条通过（`## Why`/`## What Changes`、`^#### Scenario:` 恰好 5 条而 3 个/5 个 `#` 均为 0、requirement 全含 SHALL/MUST、三档齐且带 `文件:行`、任务卡六字段齐且**文件所有权两两交集为空**、双标识三方逐字一致、工具归档按 `YYYY-MM-DD-<id>` 移动后原目录消失）；`openspec` CLI 本机不可用 ⇒ 走"未跑官方校验"降级路径。**干跑抓出 15 条技能缺陷（其中 3 条会卡住流程：新建模式无人创建 `.openspec.yaml`、脚手架 `ID_RE` 带 `i` 导致大写 id 生成宿主判 error 的 manifest、`dev` 的构建产物目录与"有无 `build` 脚本"三处矛盾），全部修复后才提交** |
| 门槛                                     | `npm run typecheck` / `lint`（0 error 0 warning）/ `test` 全绿：**604 passed \| 5 skipped (609)**、48 个测试文件；`test/manifest-script-parity.test.ts` 20 项（含新增"脚本只 import `node:` 内建模块"的自包含断言）                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 范围外发现                               | 主进程三处 `ID_RE` 仍带 `i`、`NAME_RE` 与 `extGuard.ts` 对 `..` 的规则不一致 ⇒ 开 **issue #114** 收口（不在本决策范围）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 提交                                     | **PR #115**（技能与文档）、**PR #116**（版本 → 1.0.8）、**PR #117**（回填发布产物数据）；tag `v1.0.8`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 修订（2026-10-13）：九个技能**安装为 DSH 技能**

决策 11 的"不注册为 DSH skill"（以及 ADR-0020 决策 2 的同一句）**已被用户后续决定取代**：九个技能以 **junction**（`cmd /c mklink /J`）从 `~/.dsh/skills/obox-ext-*` 指向仓库 `skills/obox-ext-*` —— 单一真源、不产生第二份副本；同时把与当前扩展模型不符的 `obox-extension-dev`（WASM/wasip1 模型）移出扫描路径到 `~/.dsh/skills-disabled/`（可逆），避免模型选错。ADR-0020 决策 2 记录的两条顾虑在此不成立：**8192 字符工具结果裁剪**（九份 `SKILL.md` 实测 2736–7769 字符）与**符号链接权限**（目录 junction 不需要管理员权限）。

**"不设入口"仍然成立**：`AGENTS.md` 与 `README.md` 都不放指针，安装只是让它们可被点名触发。安装命令与恢复方式写在 `docs/extension-workflow.md` 第十一节。
