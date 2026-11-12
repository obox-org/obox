# Proposal

## Why

设置 → 扩展 → 网页应用里的「迁移状态」现在是**一大段多行文本 + 一段长描述**，用户真正想知道的只有一件事：**迁没迁完**。

现状（已核对）：

- `webapp.migrationStatus`（`type: status`）的值由 `migrationStatusText()` 拼出 4–6 行：
  `当前无未完成的迁移` + 生效根 + 数据根 + 各设置行；迁移中/完成/失败时还要再加"已搬 N/M""已覆盖 X 项（不可恢复）"等。
- `webapp.migrationProgress`（`type: status`, `modal: true`）标着"正在迁移浏览器数据"——但 **`modal` 这个属性
  在宿主设置页里根本没有实现**（`settings/page.js` 里零命中），所以它只是一行普通文本，既不阻塞也不显示进度。
- 更根本的是：设置页只在用户动作后 `reload()` 一次，**没有轮询、也没有订阅**；
  而 webapp 在迁移过程中写设置时，宿主**已经在发** `settings` 事件（`src/extension-host/capabilities/ui-plane.ts:1380`），
  渲染侧却没订阅——日志里那条 `收到未订阅的宿主事件 channel=settings，已丢弃` 就是它。
  ⇒ 即便 webapp 把进度写进去，设置页也永远不会自己更新。

## What Changes

- **宿主（obox）**：渲染侧订阅扩展宿主的 `settings` 事件，更新设置值真相，并把"某扩展的某个设置键变了"
  推给正在显示该扩展设置的系统扩展页面（新消息 `obox:settings-changed`）；设置页收到后**只重绘受影响的字段**，
  迁移中的进度条因此实时前进，结束后自动停。
- **webapp 扩展**：`migrationStatus` 的值压成短标签（`已迁移` / `迁移中` / `已完成` / `失败`），
  **删除** `migrationProgress` 那个 `modal: true` 的文本字段，改为一个 `type: progress` 的进度字段
  （`max` = 总条目数、`value` = 已搬数，仅迁移中非空）；两条字段的 `description` 一并删除（用户明确不需要）。
- **设置页**：`progress` 字段渲染成进度条 + 简短数值（宿主已有该类型，只需在值变化时增量更新）；
  迁移结束（进度清空）后，同一行回到短标签。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `extension-page-context`：新增一条要求——宿主 MUST 把扩展设置值的变化实时推送给正在显示该扩展设置项的
  系统扩展页面（消息不重发整份上下文，只带变化的键值），页面据此增量刷新。

## Impact

- **宿主渲染侧**：`src/renderer/src/core/extensionHostConsumer.ts`（订阅 `settings` 事件）、
  `src/renderer/src/core/extensionSettings.ts`（接受外部更新）、
  `src/renderer/src/components/ContentArea.vue`（向设置页推送）+ 消息类型定义。
- **设置页**：`system-extensions/settings/page.js`（监听 `obox:settings-changed` 并只重绘相关字段）、
  `page.css`（进度条行样式）。
- **网页应用扩展（`extensions/webapp`，独立仓库）**：`manifest.json` 的 `contributes.settings.fields`
  与 `lib/profileRoot.mjs` 的 `migrationStatusText` / `migrationProgressText`；**需要发一版 webapp 才生效**。
- **门禁**：`test/extension-page-context*` / `test/settings-*`（新增推送断言）、webapp 仓库的
  `manifest-settings` 与迁移状态单测。
- **兼容性**：新消息是纯加法——不认识它的设置在页照旧；webapp 未升级时仍显示长文本（只是不实时）。
