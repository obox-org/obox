# Proposal

## Why

扩展开发现有九个 `obox-ext-*` 技能，**平铺在仓库 `skills/` 根下**，彼此只靠"下一步读 `skills/obox-ext-<x>/SKILL.md`"这句路径指引串起来，**没有入口**：使用者必须自己记住"现在第几步、该点名哪个技能"，新会话更是无从下手。九个目录同时散落在 `skills/` 里，也无法一眼看出它们属于同一套流程。

收敛成一个技能集合（`skills/obox-ext/`）+ 一个入口技能（`obox-ext`）后：入口负责"现在在第几步、下一步读哪份文件、什么时候必须问用户"，九个阶段退化为入口可读的阶段文档，路径引用只在一处维护。

## What Changes

- **BREAKING（仅内部工具链）**：九个技能目录由 `skills/obox-ext-<stage>/` 移入 `skills/obox-ext/obox-ext-<stage>/`
  （`git mv` 保留历史；含 `obox-ext-init/scripts/` 三个脚手架文件）。
- **新增入口技能** `skills/obox-ext/SKILL.md`：九步索引表（阶段 / 产出 / 入口判据）+ 调度规则
  （按用户意图或当前进度决定读哪份阶段文件、"读完照做"而非另起流程、阶段间用 `ask_user_question` 交接）
  + 手动触发方式（本仓库 `skills/` 不在 DSH 扫描路径内，因此按路径手动触发）。
- **阶段文件内的互相引用路径**由 `skills/obox-ext-<x>/SKILL.md` 改为
  `skills/obox-ext/obox-ext-<x>/SKILL.md`（九份 `SKILL.md` 里的"下一步读…"与"门禁选项 1"两处）。
- **脚手架脚本**移动后仓库根推导从「上三级」改为「上四级」（`create-extension.mjs` / `create-user-extension.mjs`），
  并同步脚本内用法文案与 `scripts/README.md` 里"移动位置时必须同步这个常量"这条约定。
- **门禁** `test/extension-skills.test.ts`：路径基准改为 `skills/obox-ext/obox-ext-<stage>/SKILL.md`；
  新增"入口存在、列出九步且顺序与链一致、每份阶段文件都能被入口按名字索引到"的断言；
  既有断言（8000 字符预算、frontmatter 名称、门禁四选项措辞、三档结论、被取代流程不得复活）全部保留。
- **文档同步**：`docs/extension-workflow.md`（路径清单与"入口"说明）、`README.md`（脚手架命令两处）、
  `AGENTS.md`（受影响的技能路径）、`docs/extension-api/guides-builtin.md`（脚手架命令）。
- **ADR 修订**：ADR-0023 决策 11（"流程不设入口"）被本次取代 —— 追加"修订"段说明新入口与触发方式，
  **不改历史正文**（ADR 按惯例保留当时决策）。
- **环境侧（仓库外，需手动）**：`~/.dsh/skills/obox-ext-*` 九个链接在移动后会指向不存在的路径，
  一并删除；入口本身不依赖 DSH 识别（用户裁定：手动触发即可）。
- **不变**：九步的顺序与各步职责、`docs/extension-api/` 作为 API 唯一真相、三档结论、门禁四选项措辞、
  扩展 API / IPC / manifest 校验规则 / 组件库外观。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。本次是**工程结构与工具链**改动（技能文档布局、门禁测试、路径引用），不改变任何可观察的产品行为，
因此不产生 spec delta —— `.openspec.yaml` 设 `skip_specs: true`。

## Impact

- **文件布局**：`skills/obox-ext-{init,grill,proposal,design,validation,task,dev,check,ship}/` →
  `skills/obox-ext/obox-ext-<stage>/`；新增 `skills/obox-ext/SKILL.md`。
- **代码**：`skills/obox-ext-init/scripts/create-extension.mjs`、`create-user-extension.mjs`（仓库根推导与用法文案）。
- **测试**：`test/extension-skills.test.ts`（路径 + 新增入口断言）。
- **文档**：`docs/extension-workflow.md`、`README.md`、`AGENTS.md`、`docs/extension-api/guides-builtin.md`、
  ADR-0023（修订段）。
- **不受影响**：`src/**`（宿主代码）、扩展 API 面、`docs/extension-api/` 的四份 API 文档内容、各扩展仓库。
- **历史文档不改**：`docs/spec/**`、`docs/adr/0020`、`docs/extension-host-migration.md`、各扩展仓库的
  spec / evidence / review 里的旧路径属当时记录，保持原样。
