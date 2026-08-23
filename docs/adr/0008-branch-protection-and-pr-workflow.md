# master 分支保护 + PR-only 提交流程

1. **分支保护**：obox 仓库 `master` 开启分支保护（`enforce_admins` 开启，管理员同样受限）：必须经 PR 合并、需 1 个 approve（用户主账号）、要求 status check 通过（PR 触发的 typecheck + lint，见 `.github/workflows/pr-check.yml`）、禁止 force push / 删除分支。
2. **提交流程**：每个任务一个 feature 分支（`feat/xxx`、`fix/xxx`、`docs/xxx` 按提交类型命名），AI 代理随改随 commit + push 到分支；任务完成后用 `.gitoken` 调 GitHub API 自动开 PR（标题 = Conventional Commits 摘要）；用户 approve 后手动 **squash merge**（master 上每个合并只有 1 条 commit），合并后删除分支。AGENTS.md 提交流程相应改写。
3. **否决的备选——tmp 整合分支**："其他分支 → 合并到 tmp → 推送远端 → 合并 master（只有一个 commit）" 方案被否决：squash merge 本身已保证 master 单 commit，tmp 多一跳无收益，反而增加分支管理与冲突成本；"只想要一个 commit 信息"由 Squash and merge 直接满足。
4. **其他仓库**：`obox-updater` / `todo` 暂不设保护，维持现状（后续需要再加）。
5. **例外**：release 工作流由 tag 触发（`on.push.tags: v*`），tag 推送不受分支保护限制，发版流程不变；approve 由用户主账号完成（GitHub 平台规则：PR 作者不能 approve 自己的 PR，故 PR 由 token 账号 `chenzhi-9019` 代开）。

Status: accepted
