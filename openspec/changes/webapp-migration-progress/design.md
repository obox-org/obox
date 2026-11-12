# Design

## Context

见 [proposal.md](proposal.md) - Why。三条关键事实：

1. **宿主已经在发 `settings` 事件**：`src/extension-host/capabilities/ui-plane.ts:1380` 起，扩展写设置时
   `emit(EH_EVENT_CHANNELS.settings, { extId, key, value })`；`EH_EVENT_CHANNELS.settings = 'settings'`
   （`src/shared/extensionHostProtocol.ts:93`）。
2. **渲染侧没订阅它**：`extensionHostConsumer` 只处理 statusBar / commands / views / app.register / cardIcon 等，
   `settings` 落进"收到未订阅的宿主事件…已丢弃"的默认分支。
3. **设置页没有推送通道**：它只在动作后 `reload()` 一次（`settings/page.js`），`modal: true` 是死属性。

## Goals / Non-Goals

**Goals:**

- 用户在设置页停留期间，webapp 的迁移进度能实时前进；结束后自动回到短标签。
- 推送是增量的：只更新受影响的那一行，不整页重绘（避免输入框中途被清空）。

**Non-Goals:**

- 不做通用"扩展设置订阅 API"（不给扩展 new API，只是把已有事件接上）。
- 不做设置页轮询（用户明确要求"webapp 发消息"）。
- 不改迁移算法本身（`lib/profileRoot.mjs` 的迁移逻辑只改**文案出口**与**进度字段**）。

## Decisions

### D1：接上已有的 `settings` 事件，而不是新造推送协议

事件已经在发、协议里已有常量，渲染侧只差一个 `case`。新造一条 IPC/事件等于重复造轮子。
**替代方案**：让设置页轮询 `settings.snapshot`——被用户否决（要求 webapp 主动推）。

### D2：宿主 → 页面用新消息 `obox:settings-changed`，只带 `{ extId, key, value }`

- 与 `obox:context`（整份上下文）分开：上下文是"主题/语言变了"，频率低、字段多；
  设置值是高频小载荷，混进上下文会让每次进度前进都重发 26 个 token。
- 只在**当前显示的分区属于该扩展**时推送（proposal 场景三）：页面不在该分区时静默丢弃，
  用户切回来时以 `settings.snapshot` 为准 —— 避免"看不见的页面也在算"。

### D3：设置页只重绘受影响的字段

`render()` 是整分区重建；迁移进度每 200–500ms 一次，整重建会让用户正在填的输入框失焦。
做法：为每个字段建一个"值节点"登记表 `fieldNodes: Map<settingKey, (value) => void>`，
收到推送时只调用对应更新函数；找不到（字段不在当前分区）就忽略。

### D4：webapp 侧字段形态

- `migrationStatus`（`type: 'status'`）：值域收敛为 `已迁移` / `迁移中` / `已完成` / `失败` 四个短词（不换行、不带路径）；
  删除 `description`（用户明确"不需要"）。
- `migrationProgress`（`type: 'progress'`，**替换**原来的 `status + modal`）：`max` = 条目总数、
  `value` = 已搬数，**仅迁移中非空**；迁移结束写成空串（字段不显示）。
- 页面若从未迁移过：`已迁移`（沿用用户原话"右边正常显示已迁移"）。

> 注：宿主 `progress` 渲染目前显示"x/y"文本 + `<progress>`。迁移属于"分母即总数"的场景，直接复用即可。

### D5：webapp 需要发版

`contributes.settings` 在扩展 manifest 里，取值由 webapp 的 `lib/profileRoot.mjs` 产生 ⇒
宿主侧改动对**已安装的旧 webapp** 无效（只是不实时）。故本次交付包含 webapp 的版本升级与 release。

## Risks / Trade-offs

- **[高频推送]** 迁移逐条写进度，若每搬一条写一次设置，推送频率 = 条目数（几十次）→
  可接受；若条目数很大（上千），webapp 侧应节流（每 200ms 或每 5% 一次）。设计上要求 webapp 节流，
  宿主不额外合并。
- **[整页重建风险]** 若实现时图省事在收到消息后直接 `render()`，输入框会失焦 →
  任务里明确要求"字段级更新"，并加一条"输入框内容在推送期间不丢失"的验收。
- **[跨仓库回归]** 宿主与 webapp 两侧必须**同时**升级才能看到实时进度；只升一侧时表现为"进度不刷新/文案仍旧长"，
  需要在 PR 里写清依赖关系与最低 webapp 版本。
- **[状态词表语义]** `已迁移` 与 `已完成` 是两个状态（idle 已生效 vs 本次刚迁完），
  若用户觉得容易混，可在后续合并成一个词——本次按用户原话保留两个。

## Migration Plan

1. 宿主：订阅 `settings` 事件 → 更新 `extensionSettings` store → 转成 `obox:settings-changed` 推给设置页。
2. 设置页：监听该消息 + 字段级登记表 + `progress` 类型渲染核对。
3. webapp：改两个字段的形态与文案出口、迁移过程中写进度（节流）。
4. 门禁：宿主侧推送单测、设置页字段级更新单测、webapp 的 manifest/状态单测。
5. 真机：在设置页把 webapp 的「浏览器数据根目录」改到一个新目录 → 观察进度条从 0/N 前进到 N/N，随后变「已完成」。
6. 发布：webapp 打 tag 发 release（`.oix`）；宿主侧随下一次版本发布。

## Open Questions

无。
