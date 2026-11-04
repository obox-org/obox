## 第 3 轮（用户反馈的三条：关闭按钮 / 悬停自动关闭 / 跨显示器拖动）

| # | 需求 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | 面板不要关闭按钮 | ✅ 通过 | `panel-open.png`：面板只有「初次见面」+ 喂食/洗澡两枚图标；页内断言 `closeButtons: 0`、`.close` 样式已整条删除 |
| 2 | 鼠标离开即自动关闭面板 | ✅ 通过 | 派发 `pointerleave` 后断言 `{ panel: false }`；源码：`onPointerGone()` → `if (panelOpen.value) closePanel(false)` |
| 3 | 拖动可跨显示器 | ✅ 通过 | 合成拖动后窗口从 `@617,707` → **`@3040,572`**（第二块屏 2560..4480 内）；日志 `setPosition: 请求(3040,707) 钳制后(3040,572)` |

### 第 3 轮的根因与改法

- **关闭按钮**：按用户要求整块删除（模板 / `.close` 样式 / `close` 事件 / `closeBtn` 兜底），
  Tab 序回到「精灵 → 喂食 → 洗澡」，关闭路径剩「离开窗体 / Esc / 失焦」三条。
- **不自动关闭**：`onPointerGone()` 原来只清 `hovered` 与穿透，**没关面板**；补 `closePanel(false)`
  （指针已不在窗体内，不抢焦点）。
- **跨屏拖动**：宿主 `setOverlayPosition` 原来一律按 `screen.getPrimaryDisplay().workArea` 钳位，
  拖到第二块屏就被钳回主屏。新增纯函数 `nearestWorkArea()`（先取包含该点的屏，否则按矩形距离取最近），
  钳位基准改为"指针所在/最近的显示器"。

### 回归防线

- `test/overlay-window.test.ts` 新增 `nearestWorkArea` 纯函数用例（含负坐标布局、缝隙、空列表）
  与 `setPosition 跨屏` 端到端用例（假 `screen.getAllDisplays` 两块屏，断言窗体落在 2500）。
- 宠物侧 4 个断言旧行为的用例按新决策更新（关闭按钮存在 / Tab 第三站 / `.close` 焦点环 /
  `.tip` 贴按钮上方），并新增「离开文档即关面板」回归测试。
