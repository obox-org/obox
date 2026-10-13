# obox 扩展开发：九步链总览

> **本文是九个技能的公共总览与唯一共用约定来源**，被 `skills/obox-ext-{init,grill,proposal,design,validation,task,dev,check,ship}/SKILL.md` 共同引用。设计依据见 [ADR-0023](../adr/0023-extension-dev-openspec-workflow.md)（与 [ADR-0020 修订段](../adr/0020-extension-dev-skill-workflow.md)）。
>
> **入口**：本流程**不在 `AGENTS.md` 或 `README.md` 设指针**，由使用者点名触发（例如"按 `obox-ext-init` 走扩展开发流程"）。九个技能不注册为 DSH skill。

## 一、九步链

| #   | 技能                  | 输入                                       | 产出                                                                                                | 完成后自动进入        |
| --- | --------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------- |
| 1   | `obox-ext-init`       | 用户点名的需求方向                         | 选定/新建的扩展工程 + `openspec/` + `<ext>/docs/spec/UID-…/`（新建时）                              | `obox-ext-grill`      |
| 2   | `obox-ext-grill`      | 简要功能 / 需求描述                        | `openspec/changes/<change-id>/notes/grill.md`（穷尽的问答记录）                                     | `obox-ext-proposal`   |
| 3   | `obox-ext-proposal`   | `notes/grill.md`                           | `proposal.md` + `specs/<capability>/spec.md`（spec delta）                                          | `obox-ext-design`     |
| 4   | `obox-ext-design`     | proposal + spec delta                      | `design.md`（交互逻辑 + UI 视觉规范，**含 UI 风格提问**）                                           | `obox-ext-validation` |
| 5   | `obox-ext-validation` | spec delta + `design.md`                   | `notes/validation.md`（三档结论 + 修复意见）                                                        | `obox-ext-task`       |
| 6   | `obox-ext-task`       | spec delta + `design.md` + validation 结论 | `tasks.md`（任务编号）与 `notes/tasks/<nn>-<slug>.md`（任务卡：文件所有权 / 并行组 / 验收命令）     | `obox-ext-dev`        |
| 7   | `obox-ext-dev`        | 任务卡                                     | 代码 + 测试 + `notes/dev.md`（回执汇总 + 门槛原始输出，**不提交**）                                 | `obox-ext-check`      |
| 8   | `obox-ext-check`      | 代码 + spec delta + `design.md`            | `notes/check.md`（三档结论 + 修复意见，**纯检查，不修代码**）                                       | `obox-ext-ship`       |
| 9   | `obox-ext-ship`       | check 通过的产物                           | 交付归档 `docs/spec/UID-…/`（含 `notes/dev.md`）+ `notes/ship.md` + 工具归档 + 文档同步 + 提交/发版 | 流程结束              |

补充规则：

- `validation` 的结论若不通过，**回到 `proposal` 或 `design`**（由用户在门禁里选）；`check` 的严重问题回到 `dev` 修正后再 `check`（自动链，最多 3 轮，之后交用户裁定）。
- 任何技能都**不得跳过门禁**自行推进；也不得越过当前阶段去改后续阶段的产物。

## 二、目录布局（严格 OpenSpec）

```text
extensions/<扩展英文名>/
├── manifest.json / index.js / lib/ / src/ / test/ / scripts/   # 扩展工程本体
├── openspec/
│   ├── config.yaml                       # OpenSpec 根标记（必须有，否则根解析会向上漂）
│   ├── specs/<capability>/spec.md        # "当前真相"规格（归档时由 delta 合并）
│   └── changes/
│       ├── archive/YYYY-MM-DD-<change-id>/   # 工具归档（openspec archive 的产物）
│       └── <change-id>/
│           ├── .openspec.yaml            # 含 schema: spec-driven、created: YYYY-MM-DD、uid: UID-…
│           ├── proposal.md               # 必须含 ## Why 与 ## What Changes
│           ├── design.md                 # 交互逻辑 + UI 视觉规范
│           ├── tasks.md                  # # Tasks + ## N. 组 + - [ ] N.M 任务
│           ├── specs/<capability>/spec.md # spec delta（## ADDED/MODIFIED/REMOVED Requirements）
│           └── notes/                    # 自研产物（官方不校验）
│               ├── grill.md
│               ├── validation.md
│               ├── tasks/<nn>-<slug>.md   # 任务卡
│               ├── dev.md                # dev 的回执汇总 + 门槛原始输出 + 改动文件清单
│               ├── check.md
│               └── ship.md               # ship 的文档同步逐行结论 + 收尾自检 + 发版一问结论
└── docs/
    └── spec/UID-{YYYYMMDDHHmmss}-{≤10字中文描述}/   # 交付归档（由 obox-ext-ship 写入）
        ├── index.md                     # 映射：change-id ↔ UID + 检查结论摘要
        ├── proposal.md / design.md / tasks.md / specs/
        └── notes/{grill.md,validation.md,dev.md,check.md,ship.md,tasks/}
```

`openspec/config.yaml` 的**最小内容**就是一行根标记注释（不编造官方字段）：

```yaml
# OpenSpec 根标记：仅让根解析停在 <扩展工程>/openspec/，别向上漂到宿主仓库。
```

官方 CLI v1.14.1 的 `openspec init --tools none` 生成的也是这一形状（外加 `specs/`、`changes/archive/` 的 `.gitkeep`）；本流程不往 `config.yaml` 里加任何自定义键。

## 三、双标识与映射

| 标识          | 形态                                      | 用途                                    | 约束                                                                                                                    |
| ------------- | ----------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **change-id** | 英文 kebab-case，如 `webapp-profile-root` | `openspec/changes/<id>/` 目录名、命令行 | OpenSpec **强制**：只允许小写字母/数字/单个连字符；**禁大写、下划线、连续连字符、首尾连字符、中文、空格**；数字开头合法 |
| **UID**       | `UID-{YYYYMMDDHHmmss}-{≤10字中文描述}`    | `docs/spec/` 归档目录名、人读标识       | 描述 ≤10 个汉字；时间戳 14 位数字                                                                                       |

**双向映射**（两侧都填，不存在"待填"状态）：`obox-ext-init` 生成 `change-id` 的**当步**就同时写下 `.openspec.yaml`（三个字段：`schema: spec-driven`、`created: YYYY-MM-DD`、`uid: UID-…`）与归档目录 `index.md` 的 `change-id: …`，两者互指。`created` 一律 `YYYY-MM-DD`（如 `2026-02-14`）。

## 四、API 公共位置（唯一真相）

以下文档**只存在一份**，位于仓库公共目录，九个阶段与扩展工程文档一律引用、**不复制副本**：

| 文档       | 位置                                       | 内容                                                                                                   |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 扩展 API   | `docs/extension-api/api-reference.md`      | `ExtensionActivationApi`、贡献点注册、dialog/shell/clipboard、settings、sqlite、timer、notification 等 |
| manifest   | `docs/extension-api/manifest-reference.md` | 贡献点 schema 与校验规则                                                                               |
| 主题与设置 | `docs/extension-api/themes-settings.md`    | 主题 token、设置页字段、子窗口主题下发                                                                 |
| 排错       | `docs/extension-api/troubleshooting.md`    | 按症状查的坑表                                                                                         |

- `proposal` / `design` / `validation` / `dev` **引用时必须给出具体章节或 `文件:行`**，不得凭记忆写 API。
- 宿主 API / 贡献点 schema / 主进程 IPC 变更时，**必须同步这些文档**（该义务保留在 `AGENTS.md` 一句话里）。

## 五、门禁与阶段内提问（两套规则，别混用）

### 1. 门禁四选项（每阶段结尾，恒为一次）

每个技能结尾**必须**用 `ask_user_question` 提问，选项恒为：

1. **通过，自动进入 `<下一步>`（推荐）** —— 附一句下一步要做什么；选它时代理**读取下一个技能的 `SKILL.md` 并照做**（不依赖 Skill 工具）。
2. **部分修改后重跑本步** —— 用户说明要改什么。
3. **回到上一步 `<名>`** —— 回退并重做上一阶段产物。
4. **暂停** —— 用户先人工检查。

`init` 是链条第 1 步、**没有上一步**：它的第 3 项**直接写「回到第 0 步重选模式」**（语义是重选新建 / 修复）。

阶段特异性补充（仍走同一门禁）：`validation` 不通过时追问"回 `proposal` 还是 `design`"；`check` 严重问题时追问"立即修复（回 `dev`）/ 改规格或设计 / 接受风险并登记 / 暂缓"；`ship` 在发版前单独问一次"是否发版"。

### 2. 阶段内提问（步骤里的业务问题）

步骤内部的业务问题（`init` 的扩展形态、`design` 的 UI 风格菜单等）走**另一套规则**：一趟可以有多次提问，选项为 **2–4 个具体方案 + 每个写明优缺点 + 恰好一个「推荐」置首 + 一个「其他（我来说明）」逃生项**（细则见 §十）。两套**互不替代**：阶段内提问再多，阶段结尾的门禁仍是上面那一次四选项，措辞不改。

## 六、问题三档（`validation` 与 `check` 共用）

| 档           | 判定                                                   | 提问方式                                                            |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------- |
| **严重问题** | 会导致实现错误、数据丢失、安全问题、或与 spec 直接冲突 | **逐条一问**：立即修复 / 改规格或设计 / 接受风险并登记 / 暂缓到下轮 |
| **普通问题** | 影响质量或可维护性，但不阻断（**含"证据不足"**，见下） | **合并为一次多选**（勾选本轮要修的，其余登记）                      |
| **一般建议** | 风格、可读性、可选的改进                               | 默认只登记，在门禁里统一问一次是否顺手处理                          |

**"证据不足"归普通问题**：某项只有实现、没有自动测试，或声称"已按 spec 实现"却**未实机验证**（含"按代码读出来的结论"），一律记普通问题并注明缺的是哪一类证据；既不升级为严重问题，也不降级为一般建议。

**带未验证项继续要单独问一次**：`validation` / `check` 的结论里只要有这类"证据不足"项，门禁除四选项外**必须单独追问一次**"是否接受带着未验证项继续？"——把「接受风险并登记」从「暂停」里**显式提出来**（选项：接受风险并登记（推荐）/ 回上一步补验证 / 暂停 / 其他（我来说明））。

每条结论必须给 **`文件:行` 或章节锚点** + **修复意见**。不自动修复、不自动阻断（阻断由用户在门禁里决定）。

## 七、任务卡与并行

`obox-ext-task` 为每个任务产出一张卡（`notes/tasks/<nn>-<slug>.md`），字段固定：

- **目标**：一句话可验收的结果
- **输入**：spec delta / `design.md` 的相关小节（给锚点）
- **文件所有权**：允许改动的文件清单（**同一文件只能归一张卡**）
- **验收命令**：该卡对应的门槛命令与期望
- **依赖与阻塞**：必须在其之前完成的卡
- **并行组**：同组可同时开工，跨组串行

`obox-ext-dev` 按卡**派子代理并行**（同组并行、跨组串行），每卡回执"改动清单 + 门槛原始输出"。

## 八、`dev` 与 `ship` 的边界

- **`dev` 不提交**：只写代码、补测试、跑门槛（`npm run typecheck` / `lint` / `test`；扩展工程**仅当自身 `package.json` 有 `build` 脚本时**才跑 `npm run build`，清理目录以该扩展构建配置的 `outDir` 为准——脚手架带 `--vue` 是 `dist/`，`extensions/rdp` / `extensions/webapp` 是 `ui/`；有 `pack` 就再跑 `node scripts/pack.mjs` 出 `.oix`），工作区保持未提交并列出改动文件。
- **`ship` 负责收尾**：交付归档（`docs/spec/UID-…/`，复制清单含 `notes/dev.md`）→ 工具归档（`openspec archive` 或按 `YYYY-MM-DD-<id>` 手工移动）→ 文档同步（README / `CONTEXT.md` / ADR）→ 提交与发版，并把**文档同步逐行结论 + 收尾自检 + 发版一问结论**写进 `openspec/changes/<change-id>/notes/ship.md`（随交付归档一起复制）。宿主仓库走 分支 → PR → CI → squash 合并并删分支；扩展仓库走 commit → tag → release（附 `.oix`）。**发版前必须问用户一次。**

## 九、OpenSpec CLI（可选增强）

- 装了 CLI（`openspec --version` 成功）时，`proposal` / `design` / `tasks` / `validation` 后**额外**跑 `openspec validate --strict` 作为质量门禁；不过则回到当步修正。
- 未装时**跳过并在产物里注明"未跑官方校验"**，其余流程不变。
- **不得**把 `@fission-ai/openspec` 写进本仓库依赖。

## 十、提问与文档规范

- **阶段内提问**（门禁那一次见 §五）一律遵守 `AGENTS.md` 的提问约定：**中文**、**`ask_user_question` 工具**、**单次一个问题**、**每个问题 2–4 个具体选项 + 每个选项写明优缺点 + 恰好一个「推荐」置于首位 + 一个「其他（我来说明）」逃生选项**。
- 事实自己查（读代码、跑命令、派子代理），**不要把可查的事实当问题问用户**。
- 文档只写代码的实际行为；未实机验证的必须显式标注"未实机验证"。

## 十一、把九个技能装进 DSH（可选；本机已装）

九个技能**不在** `AGENTS.md` / `README.md` 留指针（§一入口决策），但可以装成 DSH 技能以便直接点名触发。推荐用 **junction**（Windows 目录联接，**不需要管理员权限**）指向仓库 —— **单一真源、不产生第二份副本**：

```powershell
# 在仓库根执行
foreach ($d in Get-ChildItem skills -Directory) {
  cmd /c mklink /J "$env:USERPROFILE\.dsh\skills\$($d.Name)" "$($d.FullName)"
}
```

- DSH 扫描 `~/.dsh/skills`、`~/.agents/skills`、`<repo>/.dsh/skills`、`<repo>/.agents/skills`；装到 `~/.dsh/skills` 即与 `rb-*` 家族同层。
- 装了 junction 后，**仓库里改技能内容立即生效**（无需重装）。
- **禁用某个技能**：把它的目录**移出**扫描路径（例：移到 `~/.dsh/skills-disabled/`），比加后缀改名更可靠。
- 与本仓库扩展模型不符的 `obox-extension-dev`（WASM/wasip1 模型）已移到 `~/.dsh/skills-disabled/`，避免模型在两套扩展模型间选错。
