# Design

## Context

见 [proposal.md](proposal.md) - Why。这里只记影响方案的事实（均已核对）：

- **DSH 的技能发现是一层深度**：`dsh-skill-filesystem` 里 `isPotentialSkillPath()` 只接受
  `<root>/<name>.md` 或 `<root>/<name>/SKILL.md`（相对路径最多两段），
  `skills/obox-ext/obox-ext-init/SKILL.md`（三段）**不会被当成技能**。
- **本仓库的 `skills/` 本来就不在 DSH 扫描路径内**（ADR-0020 已记录）；现在九个技能之所以能被触发，
  是因为 `~/.dsh/skills/obox-ext-*` 有九个链接指向仓库 `skills/obox-ext-*`。
  用户裁定：**不需要 DSH 识别，手动触发即可**。
- **九步链本来就是"读文件照做"**：每份 `SKILL.md` 的末步写的是"读 `skills/obox-ext-<下一步>/SKILL.md` 并照做，
  不依赖 Skill 工具"。所以"入口 → 读阶段文件"与现状同一机制，只是少了一层 DSH 注册。
- **门禁已把结构钉死**：`test/extension-skills.test.ts` 断言九个目录存在、顺序与"下一步指向"一致、
  每份 ≤8000 字符、frontmatter 名称、门禁四选项措辞、三档结论、以及 **ADR-0023 决策 11：AGENTS/README 不得出现流程指针**。
- **脚手架脚本用相对深度推导仓库根**：`SCRIPT_DIR/../../..`，且 `scripts/README.md:16` 明写
  "脚本移动位置时必须同步这个常量"。

## Goals / Non-Goals

**Goals:**

- 一套流程 = 一个目录：`skills/obox-ext/`，九个阶段与入口都在其中，跨阶段路径引用只维护一层。
- 入口 `obox-ext` 能**独立可用**：只读它 + 它指到的阶段文件就能走完整条链，不依赖任何 DSH 技能注册。
- 门禁继续有效：结构、顺序、体积、门禁措辞、三档结论、被取代流程不得复活这些约束一条不少。

**Non-Goals:**

- 不让嵌套的后九步变成 DSH 可触发技能（用户明确不需要；要的话是改 `~/.dsh/skills` 链接，属环境操作）。
- 不改九步的职责划分、顺序、门禁四选项与三档结论的措辞。
- 不改 `docs/extension-api/` 的四份 API 文档内容（唯一真相不动）。
- 不重写历史记录（`docs/spec/**`、ADR-0020/0023 正文、各扩展仓库的 spec/evidence）。

## Decisions

### D1：物理嵌套 `skills/obox-ext/obox-ext-<stage>/`，入口在 `skills/obox-ext/SKILL.md`

保留每个阶段自己的目录（而不是压成 `references/<stage>.md`），理由：

- 每个阶段是**可独立照做的操作手册**，且 `obox-ext-init` 还带 `scripts/`（三个脚手架文件）；
  保留目录 = 移动最小、`git mv` 历史连续、将来若要重新注册为技能只需加一条链接。
- 入口与阶段文件**同构**：都是 `SKILL.md` + frontmatter，读法一致，不必在入口里解释两种文件形态。

alternatives considered：

- **压成 `skills/obox-ext/references/obox-ext-<stage>.md`**：目录更"文档化"，但脚手架脚本要另找位置，
  且阶段文件失去独立目录后，将来要单独触发某一步就得再拆一次，弃。
- **平铺不动，只新增入口路由表**：改动最小，但用户要的"都放进去"没做到，`skills/` 根仍散着九个目录，弃。

### D2：入口靠「索引表 + 读文件」调度，不做成"自动串完九步"

入口的职责边界：

1. 判断**现在该进哪一步**（用户明说第 N 步 / 从既有 `openspec/` 与 `docs/spec/UID-*` 的进度推断 / 全新的从 init 开始）；
2. 读对应阶段文件并**照做**（连同该阶段自己的门禁与三档结论）；
3. 阶段结束时按该文件的"下一步"继续 —— 但**进入下一步前必须用 `ask_user_question` 交接**。

为什么不让入口"一口气跑完"：九步里每一步都有用户决策点（模式、需求边界、UI 风格、任务拆分粒度、
发版时机），自动串起来会把这些决策吞掉。入口只做"导航"，决策仍在各阶段的门禁里。

### D3：手动触发，不提供 DSH 注册

入口 `frontmatter.name: obox-ext`，但**不加** `~/.dsh/skills` 链接（用户裁定）。

- 触发方式写进入口正文与 `docs/extension-workflow.md`：会话里说"读 `skills/obox-ext/SKILL.md`，
  从第 N 步开始"（或直接说"按 obox-ext 走扩展开发流程"）。
- 顺带的好处：**上下文成本从 9 条描述降为 0**（`skills/` 不在扫描路径内），流程文档只在真的要开发扩展时才进上下文。
- 代价：模型不会"自动想起"有这么套流程，需要人点名 —— 与现状（靠人点名）一致，不倒退。

### D4：`~/.dsh/skills` 的九个链接删除，而不是改指嵌套目录

改指（`~/.dsh/skills/obox-ext-init → repo/skills/obox-ext/obox-ext-init`）技术上可行（链接目标深度不限），
但那等于"九个阶段仍各自常驻 catalog"，与"一个入口"的初衷相反，也不符合用户"不需要 DSH 识别"的裁定。
故删除，并在 tasks 里记下恢复方法（一行 `mklink /J`），需要时随时能加回来。

### D5：门禁改造方式 —— 换基准路径 + 加"入口一致性"，其余断言原样保留

`test/extension-skills.test.ts` 的 `skillDir()` 改为 `skills/obox-ext/obox-ext-<stage>`；
新增三条断言：

1. 入口文件存在且 frontmatter `name` 为 `obox-ext`；
2. 入口正文**按顺序**列出九个阶段名（`obox-ext-init` … `obox-ext-ship`），顺序与 `CHAIN` 常量逐项一致；
3. 每份阶段文件都被入口提到（不出现"入口漏了某一步"）。

**决策 11 的处理**：原断言"AGENTS.md / README.md 不得出现 `docs/extension-workflow.md`"改为
"允许出现入口路径 `skills/obox-ext/SKILL.md`，但仍不得出现 `docs/extension-workflow.md` 总览指针"——
保留"不要在 AGENTS/README 里塞流程正文"的原意，同时承认入口是合法的一行指针。ADR-0023 追加修订段说明。

## Risks / Trade-offs

- **[路径引用漏改]** 九份 `SKILL.md` + 2 个脚本 + 4 份文档 + 门禁都含 `skills/obox-ext-*` 路径 →
  gates 覆盖不全就会留下 dangling 路径。缓解：门禁里已有"反引号内 `skills/**` 路径必须真实存在"的用例，
  移动后跑它就能抓出漏改（该用例的基准也要跟着改），再加一条入口引用一致性断言。
- **[脚手架脚本仓库根推错]** 移动后仍按"上三级"会算到 `skills/`，生成到错误位置 →
  任务里单列脚本常量修改，并在验证步骤里**实际跑一次 `create-user-extension.mjs` 到临时目录**确认落点。
- **[8KB 预算]** 入口是新增文件，需自己守住 8000 字符；九份阶段文件体积不变（只是路径变长几个字符）。
  入口若超预算，就只保索引表 + 调度规则，把阶段细节留在阶段文件里。
- **[入口与阶段文件职责漂移]** 入口写多了会变成"第十三份总览"，与 `docs/extension-workflow.md` 重复。
  缓解：入口只允许写"索引 + 调度 + 交接方式"，公共约定一律指 `docs/extension-workflow.md`（门禁可加一条：
  入口不得复制门禁四选项措辞）。
- **[历史文档里的旧路径看似失效]** `docs/spec/**`、ADR 正文、扩展仓库里的旧路径不再存在 →
  这是记录性质，保持原样；在 ADR 修订段里点明"这些是历史快照"。

## Migration Plan

1. `git mv` 九个目录（保留历史）→ 新建入口 `SKILL.md`。
2. 批量改九份 `SKILL.md` 内的跨阶段路径（`skills/obox-ext-<x>/SKILL.md` → `skills/obox-ext/obox-ext-<x>/SKILL.md`）。
3. 改两个脚手架脚本的常量与用法文案、`scripts/README.md` 的路径示例。
4. 改门禁 `test/extension-skills.test.ts`（基准路径 + 三条入口断言 + 决策 11 改写）。
5. 同步 `docs/extension-workflow.md`、`README.md`、`AGENTS.md`、`docs/extension-api/guides-builtin.md`；
   ADR-0023 追加修订段。
6. 跑 `npm test`（重点 `test/extension-skills.test.ts`）+ 实跑两个脚手架脚本到临时目录。
7. 删除 `~/.dsh/skills/obox-ext-*` 九个链接（仓库外，记恢复命令）。
8. 回滚：整个改动是一次 `git revert`；`~/.dsh/skills` 的链接用记录的命令重建即可。

## Open Questions

无。
