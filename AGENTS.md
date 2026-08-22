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

### 其他项目约定

- 扩展 API 类型定义是单包共享类型，修改时同步 `tsconfig` 无感；扩展开发经相对路径导入类型
- 质量门槛：`npm run typecheck` + `npm run lint` 必须通过（`npm run build` 含两者）
- `vendor/vscode` 是 VS Code 源码参考目录（只读参考，不修改）；eslint/prettier 已忽略该目录
