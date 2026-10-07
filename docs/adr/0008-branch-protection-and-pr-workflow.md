# master 分支保护 + PR-only 提交流程

1. **分支保护**：obox 仓库 `master` 开启分支保护（`enforce_admins` 开启，管理员同样受限）：必须经 PR 合并、要求 status check 通过（PR 触发的 typecheck + lint + test，见 `.github/workflows/pr-check.yml`）、禁止 force push / 删除分支。
2. **提交流程**：每个任务一个 feature 分支（`feat/xxx`、`fix/xxx`、`docs/xxx` 按提交类型命名），AI 代理随改随 commit + push 到分支；任务完成后用 `.gitoken` 调 GitHub API 自动开 PR（标题 = Conventional Commits 摘要）；**squash merge**（master 上每个合并只有 1 条 commit），合并后删除分支。AGENTS.md 提交流程相应改写。
3. **否决的备选——tmp 整合分支**："其他分支 → 合并到 tmp → 推送远端 → 合并 master（只有一个 commit）" 方案被否决：squash merge 本身已保证 master 单 commit，tmp 多一跳无收益，反而增加分支管理与冲突成本；"只想要一个 commit 信息"由 Squash and merge 直接满足。
4. **其他仓库**：`obox-updater` 暂不设保护，维持现状（后续需要再加）。
5. **例外**：release 工作流由 tag 触发（`on.push.tags: v*`），tag 推送不受分支保护限制，发版流程不变。

## 修订

- **approve 门槛改为 0，允许自动化账号自行合并**（需求方明确指示）：GitHub 平台规则下 **PR 作者不能 approve 自己的 PR**，而 PR 由 token 账号 `chenzhi-9019` 代开——因此"需 1 个 approve"在单人场景里退化为**每个 PR 都必须人为点一次**的仪式，14 个 PR 的批次里我先临时降门槛、合完再恢复，既繁琐又容易遗忘恢复（真实发生过）。现改为 `required_approving_review_count: 0`：
  - **保留**硬门槛：必须经 PR、必须 `check`（typecheck + lint + test）通过、`enforce_admins` 仍开启（管理员不能绕过）、禁 force push / 禁删除分支；
  - **改为可选**：人可随时在 PR 上 review/评论/要求改动（approve 不再是合并的必要条件）；
  - **代价（如实记录）**：这批合并**没有人做过代码评审**，只有 AI 自审 + CI；当需要真正的独立评审时，应临时把门槛调回 1（或引入第二个人/账号）。
  - 依据：需求方指示"approve 允许自己进行批准"，本修订即该决策的落地与留痕。

Status: accepted
