# Obox 开发者约定

本文档是给在此仓库工作的 AI 代理（及人类开发者）的约定。请遵守。

## Agent skills

### Obox 扩展开发（obox-ext-dev）

扩展开发、调试、文档遵循 `skills/obox-ext-dev/SKILL.md` 及 `references/`（manifest / api / guides / troubleshooting）。

**持续更新要求（强制）**：本项目的扩展系统是演进中的核心。以下情况发生时，**必须同步更新 `skills/obox-ext-dev/`**，不得只改代码：

- 修改/新增扩展 API（`src/renderer/src/core/types.ts` 的 `ExtensionActivationApi`、`AppRegistration`、贡献点类型）→ 更新 `references/api-reference.md`
- 修改贡献点 schema 或 manifest 校验规则（`core/manifest.ts`）→ 更新 `references/manifest-reference.md`
- 修改宿主生命周期（`core/host.ts`）或新增扩展约定 → 更新 `SKILL.md` 与相关 reference
- 修改主进程能力/IPC（`src/main/*`）→ 更新 `references/api-reference.md`
- 发现/修复新坑 → 追加 `references/troubleshooting.md`
- 新增示例扩展或脚手架能力 → 更新 `references/guides.md` 与 `scripts/`

改完代码后自检：新增 API 是否已写入 reference？新坑是否已记录？若否，补齐再收尾。

## README 更新要求（强制）

**`README.md` 是项目概览与快速上手入口，新会话依赖它了解项目并开工。项目发生以下实质变化时，必须同步更新 `README.md`**（随本次改动一起提交，不单独额外提交）：

- 目录结构变化（新增/移动/删除顶层或 `src/` 关键目录、模块、内置扩展）
- 常用命令变化（package.json scripts 增删改）
- 架构变化（三端分工、扩展系统核心模块、IPC 能力、协议）
- 技术栈/依赖变化（Electron/Vue/Cordis 版本、新增重要依赖）
- 文档导航变化（新增/移动文档文件，需更新 README 中的链接表）

**README 与各文档分工**：README 只写概览/上手/导航，不重复细节——术语查 `CONTEXT.md`，约定查 `AGENTS.md`，扩展开发查 `skills/obox-ext-dev/`，架构决策查 `docs/adr/`。

### 其他项目约定

- 扩展 API 类型定义是单包共享类型，修改时同步 `tsconfig` 无感；扩展开发经相对路径导入类型
- 质量门槛：`npm run typecheck` + `npm run lint` 必须通过（`npm run build` 含两者）
- `vendor/vscode` 是 VS Code 源码参考目录（只读参考，不修改）；eslint/prettier 已忽略该目录

## 提交约定（强制）

**每完成一项修改后必须自动提交并 push 到远程**。不得在修改完成后停留在未提交状态，也不得等到会话结束才统一提交。AI 代理须自动执行以下固定流程：

### 提交流程（五步）

1. **查看改动**：`git status` + `git diff`（看工作区与暂存区改动）
2. **判断文件是否该提交**：
   - 该提交：源码、配置、文档、skill、脚本等本次修改涉及的文件
   - 不该提交：构建产物（`out/`/`dist/`）、依赖（`node_modules/`）、临时文件、缓存（`.eslintcache`）、参考源码（`vendor/`）
   - 若出现不该提交且未被忽略的文件 → **先加入 `.gitignore`（项目根）再提交**；`.gitignore` 位置固定为项目根（仓库级），不建个人级忽略
3. **暂存**：`git add` 相关文件（明确列出，避免误加；确认无误可用 `git add -A`）
4. **自动写 commit 信息**：分析本次改动内容，用 **Conventional Commits + 中文** 自动生成：
   - 类型：`feat`（新功能）/ `fix`（修复）/ `docs`（文档）/ `refactor`（重构）/ `chore`（杂项：配置/依赖/脚本）/ `style`（格式）/ `perf`（性能）/ `test`（测试）
   - 格式：`<type>: <中文摘要>`；改动较大时加正文（`git commit -m` 多段）
   - 摘要须具体描述改动（如 `feat: 新增 App 应用扩展，支持插件卡片注册与子窗口`），不写笼统的 "update files"
5. **提交并推送**：`git commit` → `git push`（推送到 origin 当前分支）

### 提交前质量门槛

- 改动涉及 `src/` 代码时：先跑 `npm run typecheck`（必须通过），尽量跑 `npm run lint`（0 errors）
- 纯文档/配置/skill 改动：跳过检查直接按流程提交
- typecheck 失败时：先修复再提交，不得带着错误提交

### 收尾自检

- `git status` 应为 clean（无未提交改动）
- 远程与本地同步（`git status -sb` 无 ahead/behind）
- 若本约定导致误提交（如误加文件），用 `git reset` 撤销并修正后重新提交
