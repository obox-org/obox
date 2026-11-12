# Design

## Context

见 [proposal.md](proposal.md) - Why。实现前必须知道的既有事实：

- **任务栏**：`src/main/window.ts:35` 的 `skipTaskbar: process.platform === 'win32'`；隐藏走
  `win.hide()`（`src/main/windowBehavior.ts:96`），Electron 对隐藏窗口本来就不显示任务栏按钮 ⇒
  去掉 `skipTaskbar` 不会让"收进托盘"多出一个任务栏图标。
- **扩展页**：列表全量渲染 `exts.map(row)`（`system-extensions/ext-manager/page.js:175-180`），
  状态行 `statusEl` 同时被"安装成功/失败/读取失败"复用 ⇒ 不能整行删掉，只能删掉统计**文案**。
  扩展条目已带 `source`（`user` / `system` / `debug`）与 `manifest`（含 `displayName` / `author` / `description`）。
- **间距**：设置页有 `.panel .obox-form-item--inline { margin-bottom: 0; padding: 12px 2px; border-bottom: 1px dashed }`
  （`system-extensions/settings/page.css:73-79`），特异性 0,2,0 **高于**库的 0,1,0 ⇒ 只改库看不到效果；
  `.obox-list { margin: 0; padding: 0 }`（库）与 `.obox-list { gap: 8px }`（page.css）也分处两地。
- **树**：`extTreeOpen` 是一个布尔量，父行点击目前只做 `active='extension'` + `activeExt=null`（`settings/page.js:841-847`），
  箭头按钮自己 `stopPropagation` 后翻转 `extTreeOpen`。

## Goals / Non-Goals

**Goals:**

- 五条行为都按用户确认的口径落地；扩展页在十几个扩展时仍可快速定位。
- 间距改动对所有消费者**一致**生效（不出现"设置页松、rdp 紧"两套观感）。

**Non-Goals:**

- 不改关闭行为三态、托盘菜单、单实例逻辑（ADR-0019 其余决策保持有效）。
- 不给扩展页加"按来源分组""排序""持久化筛选"等超出本次要求的能力。
- 不动扩展 API / manifest / IPC。

## Decisions

### D1：任务栏 —— 只删 `skipTaskbar`，不动关闭链路

`skipTaskbar: false` 即可，`win.hide()` 已有行为保证"收进托盘 = 任务栏无按钮"。
**替代方案**："只在窗口可见时动态 `setSkipTaskbar(false)`"——多余，Electron 隐藏窗口本就不显示任务栏项。

ADR-0019 决策 2 与它的验收记录（"任务栏不显示 obox 图标"）被这条推翻，按仓库惯例**追加修订段**，不改历史正文。
同时检查是否有测试断言 `skipTaskbar: true`（`test/` 里若命中就改成期望 false，并注明 ADR 修订）。

### D2：扩展页 —— 统计行删文案不删元素，搜索与过滤放在 `render()` 一处

- `render()` 里不再写 `ext.status.count`；`statusEl` 只在操作后写反馈，初始为空（`hidden` 或空字符串）。
- 过滤逻辑抽成一个纯函数，便于单测：

  ```
  visible(exts, { query, showSystem }) =
      exts.filter(e => showSystem || e.source !== 'system')
          .filter(e => !query || haystack(e).includes(query.toLowerCase()))

  haystack(e) = [e.id, e.manifest.displayName, e.manifest.author, e.manifest.description]
                  .filter(Boolean).join(' ').toLowerCase()
  ```

- 搜索框用库的 `obox-input`（已有），开关用 `obox-checkbox`（已有），**都不新造组件**。
- 空结果要给出空态（复用 `obox-empty` 或 `obox-text` 一行提示），不能只是一片空白——
  否则用户会以为"搜坏了"。
- 开关状态放模块级变量，**不写 localStorage**（用户明确要求每次进页面默认隐藏）。

### D3：间距 —— 改库，并把设置页那条覆盖"降级"成只保留分隔线

- 库：`.obox-form-item--inline` 补 `padding-block: var(--obox-space-3)`；`.obox-list` 补 `margin-block: var(--obox-space-2)` 与 `display: flex; flex-direction: column; gap: var(--obox-space-2)`。
- 设置页：把 `.panel .obox-form-item--inline` 收缩为"只保留虚线分隔与左右内边距"，**去掉 `padding` 的上下值**，
  让库的垂直节奏生效（否则被覆盖，等于没改）。
- **风险已知**：这是库级改动，rdp / webapp / app 页的表单与列表会一起变松 —— 必须逐页截图回归（tasks 4.2）。
- 替代方案："只给更新分区加 margin"——用户已否决（选了库级），且会留下"设置页内部两种节奏"。

### D4：树 —— 行点击同时做两件事，箭头保留

父行点击 = `extTreeOpen = !extTreeOpen` **且** `active='extension'` / `activeExt=null`；
箭头仍只做开合（`stopPropagation` 已有）。这样"点行开合并回到列表"符合直觉，箭头作为可见提示保留。

## Risks / Trade-offs

- **[任务栏行为与 ADR 冲突]** 若不加修订段，后来者会看到"代码与 ADR 相反"。
  缓解：ADR-0019 追加修订段 + 在 `window.ts` 注释里指向该修订。
- **[库级间距波及面]** 改 `.obox-form-item--inline` / `.obox-list` 会影响设置页全部 9 个分区与 rdp/webapp 表单。
  缓解：任务里单列"逐页截图回归"，任何一页错位就回退到"只改设置页"的局部方案。
- **[搜索与安装反馈冲突]** `render()` 重绘会重写 `statusEl`（原来写统计文案）→ 改成"只在操作后写"，
  重绘时不清空，否则用户刚看到的"安装失败"会被下一次渲染抹掉。
- **[系统扩展隐藏后"看不见自己"]** 用户装了很多系统扩展又搜不到时会困惑 → 空态提示里明确写出
  "系统扩展默认隐藏，可用上方开关显示"。
- **[过滤与计数]** 删掉统计行后，列表里 "N 条" 信息消失 → 在搜索框旁给一个极小的结果计数（如 `3/12`），
  既保留定位感又不占独立一行。

## Migration Plan

1. 主进程：删 `skipTaskbar`，更新 ADR-0019 修订段。
2. 扩展页：删统计文案、加搜索框与系统扩展开关、加空态与结果计数、i18n（zh/en 各若干条）。
3. 库 + 设置页：间距改动 + 收掉页面覆盖。
4. 设置页：树行点击开合。
5. 门禁：扩展页源码/i18n、库间距断言、（若有）`skipTaskbar` 断言。
6. 真机：深色主题截图 `扩展管理`（搜索、开关、无统计行）、`设置-更新`（变松）、`设置-扩展`（点行开合）。
7. 回滚：单次 `git revert`；库间距若观感不佳，回退到"只改设置页局部"。

## Open Questions

无。
