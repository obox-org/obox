# 扩展开发流程：文档分层、需求澄清与防漂移

## 背景

`skills/obox-ext-dev/` 是 obox 扩展开发的权威文档，长期存在四个结构性问题：

1. **受众混写**：内置扩展（`src/renderer/src/extensions/<id>/`，TypeScript + Vite，随应用打包）与用户扩展（独立仓库，入口必须是**纯 ESM JavaScript**、`.oix` 分发）开发方式完全不同，却写在同一份 `guides.md` 与同一份 `SKILL.md` 里；同一含义在两处各写一遍，复制即漂移。
2. **事实漂移**：逐条核对发现 16 处会让代理写出错代码的硬错误。典型：文档说"未声明命令只 warning"，实际 `registry.ts` **直接 throw**（扩展会标红 `activationError`）；文档说依赖环"跳过"，实际环内扩展**仍会激活**、只是排最后；`api.output.append(...)` 这个 API 根本不存在；`manifest-reference` 教人写公开类型里没有的 `arch`/`python` 字段（照写会 TS 报错）。
3. **工具腐烂**：`scripts/validate-manifest.mjs` 漏检 `ipcChannels`/`keybindings`/`menus`/`views` 四类 error，对非法 manifest 输出"✓ 通过"——**比没有这个脚本更糟**；`access()` 未 await 导致死代码与崩栈路径；`create-extension.mjs` 能在任意裸目录静默生成，且模板缺 `titleKey`（英文界面显示中文标题）。
4. **可发现性**：DSH 只扫描 `<repo>/.dsh/skills`、`<repo>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`；本仓库只有根级 `skills/`，因此它**不是**一个可触发的 skill，只能靠 `AGENTS.md` 的指针被读到。

同时，扩展开发长期缺少"先问清需求、再动手"的约束：代理容易按自己的理解扩大范围，返工成本高且决策没有留痕。

## 决策

1. **受众分层**：`SKILL.md` 只做「受众判定 + 两条最小路径 + 流程骨架 + 铁律」；references **按主题保留共享、按受众拆教程**——共享 `api-reference` / `manifest-reference` / `themes-settings` / `troubleshooting`（坑按症状查，不按受众猜）/ `workflow`，教程拆 `guides-builtin` / `guides-user`。
2. **不注册为 DSH skill**：维持 `AGENTS.md` 作为唯一 always-loaded 指针（多处引用本 skill 路径），不新增 `.agents/skills` 符号链接或 `~/.dsh/skills` 副本。理由：仓库内工作的指针已经可靠；注册会把 `SKILL.md` 压进 8192 字符的工具结果裁剪阈值，并引入第二份真源或 Windows 符号链接权限问题。
3. **校验脚本自包含副本 + 差分门禁**：`validate-manifest.mjs` 必须能在**没有 obox 源码**的用户扩展仓库里跑（`--all` 扫的就是 `extensions/*/manifest.json`），且 Node 原生跑 `.mjs` 解析不了 `src/` 内部的无扩展名 import（`scripts/make-tray-icon.mts` 头部已记录该坑），所以规则只能是副本。防漂移靠 `test/manifest-script-parity.test.ts`：同一批 fixture 同时喂脚本与 `validateManifest()`，`{level,message}` 必须逐字一致。
4. **开发流程（强制）**：扩展需求先走 `references/workflow.md`——提问（M1–M8 八项必问 + 命中才问的个性化项 + 三条硬边界）→ spec 写入 `tmp/spec/` → **用户确认（唯一关卡）**→ 设计文档 → 开发 → 测试 + 独立子代理审视（问题必须逐条处置）→ ADR 写入 `tmp/adr/`。改变对外行为/贡献点/数据结构的需求走全流程；只改文案/样式/单点 bug 走轻流程。
5. **临时产物与归档**：`tmp/` 整体进 `.gitignore`（spec / 设计文档 / 临时 ADR 都是本地工作产物）；需求完成后 `tmp/spec/` → `<开发目录>/docs/spec/`、`tmp/adr/` → `<开发目录>/docs/adr/`，随后**删除整个 `tmp/`**。三级落点：用户扩展 → `extensions/<id>/docs/`；内置扩展 → `src/renderer/src/extensions/<id>/docs/`；宿主 / 扩展系统 / 仓库自身 → 仓库 `docs/`（ADR 续现有编号，本仓库自身开发的归档先例是 `docs/spec/`）。
6. **文档只写代码实际行为**：描述与代码不符时改文档；没实机验证的（如 VS Code `launch.json` 模板、`urlFilter` 依赖 electron-vite 默认端口）必须显式标注"未实机验证"。代码与测试意图冲突（`manifest.ts` 的 `name` 正则带 `i` vs `test/manifest.test.ts` 的标题意图）不在文档需求内改代码，另立 issue。

## 修订（2026-10-13）：流程拆为九步链，产物改用 OpenSpec 范式

**已由 [ADR-0023](./0023-extension-dev-openspec-workflow.md) 取代本文的：**

- **决策 1 的前半**（references 按主题保留在 `skills/obox-ext-dev/` 内）⇒ 共享文档迁至仓库级公共目录 `docs/extension-api/`（唯一真相），`SKILL.md` 不再是"受众判定 + 流程骨架"的单入口。
- **决策 4**（M1–M8 提问 + `tmp/spec/` → 用户确认 → 设计 → 开发 → 测试与独立审视 → `tmp/adr/` 的强制流程）⇒ 拆为九个顺序技能，产物落 `openspec/changes/<change-id>/`。
- **决策 5**（`tmp/` 两段归档）⇒ 改为 `openspec/changes/archive/` 与 `<开发目录>/docs/spec/UID-…/` 分工归档。

**仍然沿用：** 决策 2（**不注册为 DSH skill**，且进一步不在 `AGENTS.md` 放流程入口，只由用户点名触发）、决策 3（校验脚本自包含副本 + `manifest-script-parity` 差分门禁）、决策 6（文档只写代码实际行为、未实机验证必须标注）。

下文"后果"与"落地与验证"两节记录的是**原始决策**的实施情况，保留为历史。`AGENTS.md` 中与扩展开发相关的**流程描述整段删除**，仅保留"改宿主 API/manifest/IPC 必须同步文档"的同步义务一句（指向 `docs/extension-api/` 与受影响的 `skills/obox-ext-*`）。

## 后果

- **好处**：两类受众各读一条线，context 减半；16 处硬错误归零且新增一道 CI 可见的差分门禁；需求先澄清再动手，决策留痕在 `docs/`（ADR 长期保留、spec 可追溯），代理不再自行扩大范围。
- **代价**：references 从 5 份变 7 份，`SKILL.md` 与 references 的交叉引用需要人工维护；校验规则是副本，改宿主校验时必须同步改脚本并让差分测试通过（已写入 `AGENTS.md` 的持续更新条款）；每个扩展需求多出 spec 与设计两道文档工序。
- **风险与退场条件**：若将来把校验内置到宿主 CLI（`obox --validate-manifest`），可删掉脚本副本与差分门禁，回到单一真源；若将来把 `skills/obox-ext-dev/` 注册为真正的 DSH skill，需重新评估 `SKILL.md` 的 8192 字符预算与触发词冲突。

## 落地与验证

| 项                 | 结果                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档层             | PR #85：`SKILL.md` 7,053 → 5,010 字符、新增 `workflow.md` 5,571 字符、`guides.md` 拆成 `guides-builtin.md` / `guides-user.md`、四份共享 reference 逐条纠偏                                                                                                                                          |
| 脚本层             | PR #86：`validate-manifest.mjs` 重写、`create-extension.mjs` 改造、`create-user-extension.mjs` 新增、`test/manifest-script-parity.test.ts` + 9 个 fixture                                                                                                                                           |
| 门禁               | `npm run typecheck` / `lint` / `test` 全绿（408 passed / 5 skipped，其中差分门禁 13 项）；变异自证：临时放宽 `ipcChannels` 规则 → 2 failed，还原 → 13 passed                                                                                                                                        |
| 生成物实测         | 临时目录里 `node --test` 6/6、`pack.mjs` 产出 `.oix`、宿主同款 `adm-zip` 解包字节一致、`--vue` 变体真实 `vite build` 成功                                                                                                                                                                           |
| 独立审视（阶段七） | 两轮只读子代理：references 对代码逐条核对（40+ 条断言，最后修 9 处含 1 条高危「子窗口不执行任何扩展代码」）；入口/流程三方一致性与死链、体量核对                                                                                                                                                    |
| 红队验收           | 两个只读 `SKILL.md` 的子代理分别模拟「做用户扩展并打包」与「给内置扩展加状态栏项」：类型判定、分级、references 路径、命令序列全部走对；抓出并已修 3 处「照做即错」（`pack.mjs` 归属、缺 `--vue`/`--dir`、用户扩展不能贡献 `navItems[].view`）与 1 条硬约束缺失（内置扩展无磁盘目录/无系统信息能力） |
| 范围外代码问题     | 开 issue #77–#84（`name` 正则、命令 id 重复未入 validations、快捷键大小写、设置页「扩展」分区不可达、主题 `apply()` 残留、python `requirements` 不可达、非数组 `extensionDependencies` 抛错、贡献点数组形状无防御），均不在本需求内改代码                                                           |
| 依赖安全           | 两次合并后 `npm run security:audit` 0 漏洞、Dependabot 开放告警 0                                                                                                                                                                                                                                   |
