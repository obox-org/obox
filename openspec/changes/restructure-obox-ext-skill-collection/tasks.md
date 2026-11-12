# Tasks

## 1. 物理搬迁与入口

- [x] 1.1 用 `git mv` 把九个目录移入 `skills/obox-ext/`（`obox-ext-{init,grill,proposal,design,validation,task,dev,check,ship}`，
      含 `obox-ext-init/scripts/` 三个文件）；验证：`git status` 显示为 rename（历史连续），
      `ls skills/*/SKILL.md` 只剩 `skills/obox-ext/` 一个顶层目录、`skills/` 根下不再有 `obox-ext-*` 目录
- [x] 1.2 新建入口 `skills/obox-ext/SKILL.md`：frontmatter（`name: obox-ext` + 触发描述）+
      九步索引表（阶段 / 产出 / 何时进这一步）+ 调度规则（判断当前阶段 → 读对应阶段文件照做 →
      进入下一步前用 `ask_user_question` 交接）+ 手动触发方式 + 公共约定一律指向 `docs/extension-workflow.md`；
      验证：`[...readFileSync(入口)].length <= 8000`，且正文按顺序出现九个阶段名

## 2. 路径引用与脚手架

- [x] 2.1 改九份阶段 `SKILL.md` 内的跨阶段路径：`skills/obox-ext-<x>/SKILL.md` →
      `skills/obox-ext/obox-ext-<x>/SKILL.md`（"下一步读…"与门禁选项 1 两处）；
      验证：`grep -rn 'skills/obox-ext-[a-z]*/SKILL.md' skills/` 无匹配，且门禁的
      "反引号内 `skills/**` 路径必须真实存在" 用例通过
- [x] 2.2 修脚手架脚本的仓库根推导（`SCRIPT_DIR/../../..` → `../../../../`），同步两个脚本内的用法文案；
      验证：`node skills/obox-ext/obox-ext-init/scripts/create-user-extension.mjs <临时 id>` 生成的工程落在仓库根下的
      预期目录（跑完删掉临时产物），`create-extension.mjs --help` 打印的用法路径正确
- [x] 2.3 更新 `skills/obox-ext/obox-ext-init/scripts/README.md` 里的路径示例与"仓库根 = 上三级"这条约定；
      验证：README 里出现的每条 `node skills/...` 命令按原样执行都能找到文件（`--help` 即可）

## 3. 门禁与文档同步

- [x] 3.1 改 `test/extension-skills.test.ts` 的路径基准为 `skills/obox-ext/obox-ext-<stage>/SKILL.md`，
      新增三条断言（入口存在且 `name: obox-ext`、入口按 `CHAIN` 顺序列出九步、每份阶段文件都被入口提到），
      并把"决策 11"用例改为"AGENTS/README 允许出现入口路径、仍不得出现 `docs/extension-workflow.md` 总览指针"；
      验证：`npx vitest run test/extension-skills.test.ts` 全绿，且故意把入口里某一步删掉时该用例会红（手测一次后还原）
- [x] 3.2 同步 `docs/extension-workflow.md`：路径清单改为 `skills/obox-ext/obox-ext-{…}/SKILL.md`，
      并把"入口"一节改为"入口是 `skills/obox-ext/SKILL.md`，按路径手动触发"；
      验证：文档里每条 `skills/...` 路径都存在（用一段 node 脚本或 grep + ls 逐条核对）
- [x] 3.3 同步 `README.md`（两处脚手架命令 + 一处 `skills/obox-ext-*` 表述）、`AGENTS.md`
      （"受影响的 `skills/obox-ext-*`"改为新路径说法）、`docs/extension-api/guides-builtin.md`（脚手架命令）；
      验证：四处出现的路径均可在仓库内解析，`npm run lint` 无新增告警
- [x] 3.4 在 ADR-0023 追加"修订（2026-11-12）"段：记录入口技能的引入、手动触发方式、嵌套布局与
      "九步文件不再是独立 DSH 技能"，并注明正文的路径属历史快照；验证：ADR 里能检索到该修订段且不改动历史正文

## 4. 环境侧与集成验证

- [x] 4.1 删除仓库外的 `~/.dsh/skills/obox-ext-*` 九个链接（移动后已指向不存在的路径），
      并在提交说明里写下恢复命令（`cmd //c mklink /J`）；验证：`ls ~/.dsh/skills | grep obox-ext` 为空，
      且 DSH 会话不再因悬空链接报错
- [x] 4.2 集成验证：`npm run typecheck` + `npm run lint`（0 error）+ `npm test` 全绿；
      按入口正文走一遍"最小可用路径"（入口 → `obox-ext-init` 新建模式 → 用 `create-user-extension.mjs` 生成一个临时扩展工程 → 删除），
      确认入口的调度描述与阶段文件一致
- [x] 4.3 提交与合并：从 master 拉 `refactor/obox-ext-skill-collection` 分支，中文 commit message，
      推送后开 PR（正文附：目录前后对照、门禁输出、脚手架实跑结论），CI `check` 绿后 squash 合并并删除分支

## Workflow follow-up

- 合并后按流程归档本 change（`openspec archive restructure-obox-ext-skill-collection`）；
  本 change 声明 `skip_specs: true`，归档时不应改动 `openspec/specs/`。
- 归档后同步提醒用户：`docs/extension-workflow.md` 的"入口"说明与 `~/.dsh/skills` 的现状一致（不再有九个链接）。
