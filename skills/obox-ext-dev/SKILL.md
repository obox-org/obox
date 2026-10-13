---
name: obox-ext-dev
description: 按任务卡实现 obox 扩展代码并跑通质量门槛（不提交）。当用户要求按任务卡开发扩展、并行实现任务、修复 check 报错后回到开发、或九步链走到第 7 步时使用。
---

# obox 扩展开发 · 第 7 步：正式开发

## 职责

**做**：按任务卡派子代理实现代码与测试，跑通门槛，汇总每卡的"改动清单 + 门槛原始输出"。
**不做**：**不提交、不推送**；不改任务卡与 spec / design；不碰任务卡文件所有权之外的文件（本步自己的 `notes/dev.md` 除外）。

**边界**：本步只写代码，工作区保持未提交，交付归档 / 文档同步 / 提交 / 发版全在 `obox-ext-ship`。

公共约定见 `docs/extension-workflow.md`（§七 任务卡与并行、§八 dev 与 ship 的边界、§五 门禁）。扩展的 API、贡献点与主题用法查 `docs/extension-api/`（`api-reference.md` / `manifest-reference.md` / `themes-settings.md` / `troubleshooting.md`），**引用时给出具体章节或 `文件:行`，不凭记忆写 API**。

## 输入与前置检查

| 输入              | 路径                                                      |
| ----------------- | --------------------------------------------------------- |
| 任务卡            | `openspec/changes/<change-id>/notes/tasks/<nn>-<slug>.md` |
| 任务清单          | `openspec/changes/<change-id>/tasks.md`                   |
| spec delta / 设计 | `openspec/changes/<change-id>/specs/**`、`design.md`      |

开工前逐项确认，**任一项不过就回到对应步骤，不得继续**：

1. 任务卡齐备且每张六字段完整，文件所有权两两无交集。
2. 每张卡的"验收命令"在本机能跑（命令存在、依赖已装）。
3. `git status --porcelain=v1` 记录开工前的脏文件，收尾时对比，避免把既有改动当成本次成果。
4. 按扩展类型读了对应教程：用户扩展 `docs/extension-api/guides-user.md`，内置扩展 `docs/extension-api/guides-builtin.md`（入口语言、构建链、分发方式三者不同，读错必返工）。

## 步骤

### 1. 定并行批次

同组并行、跨组串行；有依赖的卡等其前置卡完成。

**完成判据**：列出批次表（批次 → 卡号），每批内的卡文件所有权不重叠且无依赖。

### 2. 按卡派子代理

一卡一个子代理，任务书里**逐字带上卡的目标、输入锚点、文件所有权、验收命令**，并明确一句："**只改所有权内的文件；要改宿主 API 或新增 API 就停下报回**"。

**完成判据**：每张卡都被派发过一次；派发记录里能看到卡号与批次。

### 3. 收每卡回执

回执**必须**含：**改动清单**（新增/修改/删除的文件路径）＋ **门槛原始输出**（命令与完整 stdout/stderr，不摘写、不概括）。缺任一项就退回重跑。

**完成判据**：每张卡都有回执，且回执里的文件清单与其文件所有权自洽——所有权外出现文件即越界，当场处理。

### 4. 跑门槛

- **宿主动作涉及 `src/**`**：`npm run typecheck`、`npm run lint`、`npm test`。三者都过才算过。
- **扩展工程（条件门槛）**：**仅当该扩展 `package.json` 有 `build` 脚本时**才跑 `npm run build`；清理对象以该扩展构建配置的 `outDir` 为准（脚手架带 `--vue` 是 `dist/`，`extensions/rdp` / `extensions/webapp` 是 `ui/`），先清旧产物再构建，避免把旧界面打进包。**没有 `build` 脚本就不跑、也不去动任何产物目录**，改用该扩展自带测试（`npm test` / `node --test`）＋清单校验（`node scripts/validate-manifest.mjs <manifest.json>`）。
- **打包**：该扩展 `package.json` 有 `pack` 脚本就跑 `node scripts/pack.mjs` 产出 `out/<name>-<版本>.oix`（带 `--vue` 的 `pack` 自带 `build`，跑它即可）。

保留**原始输出**；失败就修到过，修的仍是本步范围。**没跑 build 的，必须在回执与 `notes/dev.md` 里写明原因**（该扩展无 `build` 脚本，改以测试 + 清单校验为准）。

**中文输出编码**：门槛输出要原文粘贴，含中文的 stdout/stderr 在 Windows PowerShell 5.1 下经 `Get-Content` 会显示成乱码——用 `Get-Content -Encoding utf8` 读取，或直接读文件、或让命令把输出写进 UTF-8 文件再读；**粘贴前先确认中文没坏**。

**完成判据**：该跑的门槛逐条有原始输出且全绿，不适用的门槛已写明原因；`.oix` 产出路径可查、manifest 校验通过。

### 5. 越界即停

**发现要改宿主 API、贡献点 schema、主进程 IPC，或要新增 API 时，停下来用 `ask_user_question` 问用户一次**（选项含"改规格走 `proposal` / 扩范围 / 不做"），拿到答复再动；ADR 落位随之改判。

**完成判据**：本步改动的每个文件都能追溯到某张卡的所有权；越界项已由用户裁定并留痕。

### 6. 汇总并核工作区

把回执与门槛输出汇总写入 `openspec/changes/<change-id>/notes/dev.md`，末尾列出**本次全部改动文件**；`git status --porcelain=v1` 里不应出现你未预期的条目，**确认没有任何提交**（`git log` 未新增）。

**完成判据**：`notes/dev.md` 存在；改动文件清单与 `git status` 一致；`git log -1` 仍是开工前的那条提交。

### 7. 门禁

见下。

## 产物与路径

- 代码 + 测试（按任务卡的文件所有权）
- `openspec/changes/<change-id>/notes/dev.md`（回执汇总 + 改动文件清单 + 门槛原始输出）
- 扩展工程的 `.oix`（在 `out/`，未提交）

## 门禁

用 `ask_user_question` 问「本步产出是否符合要求？」：

1. **通过，自动进入 `obox-ext-check`（推荐）** —— 下一步读 `skills/obox-ext-check/SKILL.md` 并照做，对 spec delta / design / 任务卡逐条纯检查并复跑门槛。
2. **部分修改后重跑本步** —— 用户说明要改哪张卡的哪部分。
3. **回到上一步 `obox-ext-task`** —— 回退并重做任务卡拆分。
4. **暂停** —— 用户先人工检查。

被选 1 时**读取 `skills/obox-ext-check/SKILL.md` 并照做**，不依赖 Skill 工具。

## 完成判据

- 每张任务卡都有"改动清单 + 门槛原始输出"回执，且无越界改动；
- 该跑的门槛全绿并留有原始输出（扩展工程另含 `outDir` 清空后重建的 `build` 与 `.oix`；无 `build` 脚本的扩展以自带测试 + 清单校验为准，且已写明没跑 build 的原因）；
- 工作区**未提交**，改动文件清单已写入 `notes/dev.md`；
- 门禁问过并拿到用户选择。
