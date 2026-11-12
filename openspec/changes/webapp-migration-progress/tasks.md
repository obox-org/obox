# Tasks

## 1. 宿主：接上 settings 事件

- [ ] 1.1 `src/renderer/src/core/extensionHostConsumer.ts` 增加 `case EH_EVENT_CHANNELS.settings`：
      校验载荷 `{ extId, key, value }` 形状，非法载荷记一条 warn 后丢弃（不抛错）；
      验证：`test/extension-host-consumer`（或新增用例）喂一条合法与一条非法载荷，前者更新 store、后者被丢弃
- [ ] 1.2 让 `extensionSettings` store 接受外部更新（新增 `applyRemote(extId, key, value)` 或等价方法），
      与页面读到的快照同源；验证：单测断言 store 的值变化后快照读取到新值

## 2. 宿主：增量推送给设置页

- [ ] 2.1 在 `src/renderer/src/components/ContentArea.vue` 增加推送到页面的新消息
      `{ type: 'obox:settings-changed', extId, key, value }`；**仅当**当前活动分区属于该扩展时发送，
      否则静默丢弃；验证：单测/真机构造"当前在别的分区"时不发送
- [ ] 2.2 消息类型补齐到页面运行时的类型定义（`src/api/` 或页面上下文相关的 shared 类型），
      并在 `docs/extension-api/themes-settings.md`（或 page-context 相关章节）登记这条消息；
      验证：文档里能检索到 `obox:settings-changed`，字段与该实现一致

## 3. 设置页：字段级刷新

- [ ] 3.1 `system-extensions/settings/page.js` 监听 `obox:settings-changed`：若 `extId` 属于当前分区且
      该键在字段表里，只调用该字段的更新函数（`fieldNodes: Map<key, (value) => void>`），**不整分区 render()**；
      验证：真机在「网页应用」分区迁移时，进度条前进而其他输入框不失焦、不清空
- [ ] 3.2 `progress` 字段渲染核对：`value/max` 变化时只更新 `<progress>` 与文本，不重建节点；
      验证：`test/settings-*` 增加用例（旧值→新值只更新文本/属性）
- [ ] 3.3 `system-extensions/settings/page.css` 补进度条行的紧凑样式（与短标签同一行，不换行）；
      验证：真机截图，迁移中与结束后两种形态都不跳版

## 4. webapp 扩展（独立仓库）

- [ ] 4.1 `extensions/webapp/manifest.json`：`webapp.migrationStatus` 的 `description` 删除、标签保留；
      `webapp.migrationProgress` 由 `status + modal` 改为 `type: 'progress'`（并删除 `modal`）；zh/en 文案同步；
      验证：`node scripts/validate-manifest.mjs extensions/webapp/manifest.json` 通过，`manifest-settings` 单测通过
- [ ] 4.2 `extensions/webapp/lib/profileRoot.mjs`：`migrationStatusText()` 收敛为四个短词
      （`已迁移` / `迁移中` / `已完成` / `失败`），路径、条目数、覆盖数等不再拼进状态值；
      `migrationProgressText()` 改为返回数值进度（或由调用方直接写 `done/total`）；
      验证：`node --test`（webapp 仓）里状态文案相关用例按新词表断言
- [ ] 4.3 迁移过程中按节流（≥200ms 或每 5%）写 `migrationProgress`，结束时写空串并把 `migrationStatus` 写成 `已完成`；
      验证：webapp 仓单测覆盖"迁移中写入进度 / 结束清空进度"两条
- [ ] 4.4 webapp 版本号 +1（patch），跑 `npm test` 与 `npm run release` 出 `.oix`；
      验证：产物里 `manifest.version` 与 package 一致、包含新字段形态

## 5. 集成验证与交付

- [ ] 5.1 obox 门槛全绿：`npm run typecheck` + `npm run lint` + `npm test`
- [ ] 5.2 真机端到端：装新版 webapp → 设置-扩展-网页应用 → 把「浏览器数据根目录」改到新目录 →
      观察进度条 0/N → N/N，结束后该行显示「已完成」；长描述与「正在迁移浏览器数据」那行均不存在
- [ ] 5.3 宿主侧 PR：`feat/settings-live-push` 分支，中文 commit message，CI 绿后 squash 合并；PR 正文写明
      "需配套 webapp ≥ 新版本"，并附真机截图
- [ ] 5.4 webapp 仓库：分支 → PR → 合并 → tag `vX.Y.Z` → release 附 `.oix`；把新版本号回填到宿主侧文档或 PR 描述
- [ ] 5.5 合并后复核 `npm run security:audit --registry=https://registry.npmjs.org` = 0 与 Dependabot = 0

## Workflow follow-up

- 合并后归档本 change（`openspec archive webapp-migration-progress`），确认 `extension-page-context` 已吸收新增要求。
