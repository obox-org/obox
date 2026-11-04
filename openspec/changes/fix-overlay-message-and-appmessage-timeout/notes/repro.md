# 复现与根因证据

采集环境：Windows 11，2560×1440；安装版 **obox 2.0.2**（`C:\Program Files\obox`，asar 含
`overlay-owner` / `theme:push-tokens` / `pendingRestart`，说明 D8b 与 2.0.1 的主题广播都在包里）。

## 一、基线（安装版 2.0.2 复现）

| 证据 | 文件 | 结论 |
| --- | --- | --- |
| 整屏 | `repro/screen-baseline.png` | 桌面整体 |
| 宠物窗口 | `repro/pet-topmost-before.png` | 宠物浮层真实存在：窗口 **220×460 @(640,332)**（Win32 枚举），精灵在渲染 |
| 悬停面板（修复前） | `repro/pet-hover-before.png` | 面板出现但**只有文字、背景/边框全透明**；文字为「正在连接宠物状态…」 |
| 运行日志 | `repro/obox-run.log` / `obox-run.copy.log` | 关键行见下 |
| 宿主真实回包（CDP） | `repro/webapp-error.txt` | `ui.appMessage` 在 3000ms 内没有响应 |

### 日志里的三段决定性证据

1. 宿主事件到达渲染侧，但**桥没有订阅者**（属桥的噪音，非故障）：
   `[eh] 收到未订阅的宿主事件 channel=overlay-owner，已丢弃`
2. 主题 token **广播成功**（2.0.1 的链路在工作）：
   `[overlay] 主题 token 已更新：themeId=theme-dark.dark tokens=25 个，已下发给 1 个浮层窗口`
3. 宠物页面侧超时：
   `[pet] 首帧状态未取到，等长轮询补：扩展未响应（页面侧超时）`

## 二、根因（前两层都在宿主侧）

### R-1【致命】宿主从未收到渲染侧的 `req`：`MessagePortMain` 不支持 `onmessage` 赋值

`ui-plane.attachRendererPort()` 原本用 `port.onmessage = handler` 订阅宿主侧的 `host-renderer`
端口（`MessageChannelMain.port1`）。该对象在 Electron 里是 **EventEmitter（`MessagePortMain`）**：
赋值只是创建一个没人调用的普通属性，**不报错**。
后果：宿主 → 渲染侧（`postMessage`）正常，渲染侧 → 宿主（`req`）**永远收不到** ⇒
`ui.appMessage` / `ui.executeCommand` / `ui.treeChildren` / `host.activate` 在渲染侧全部超时。

**修复前后对比（同一构建流程）**：
- 修复前：日志里**没有任何** `渲染侧入站` 行，宿主侧 `ui.appMessage 进入` 从未出现；
- 修复后（`subscribeHostRendererPort`：`.on('message')` 优先，退回 `onmessage`）：
  `[host] 渲染侧入站：t=req method=ui.appMessage` → `ui.appMessage 进入：ext=pet_chenzhi channel=pet.hit`
  → `ui.appMessage 完成：… 0ms`。

这一层同时解释 **webapp 的超时报错** 与 **pet 面板"正在连接"**（同一根因）。

### R-2 超时预算不匹配（放大器，不是唯一原因）

`ACK_TIMEOUT_MS = 3000` 曾是全部请求的默认预算，而 `api.app.onMessage` 的契约允许 handler 做
IO / 长轮询（pet 的 `pet.subscribe` hold 25s、webapp 的 `open()` spawn 子进程）。即使 R-1 修好，
3 秒也会把正常的慢操作报成故障。已改为按方法族预算（`src/shared/rpcBudget.ts`：
`ui.appMessage` 30s / `ui.executeCommand` 30s / `ui.treeChildren` 15s / `update.*` 沿用 R72）。

### R-3 面板透明：主题 token 到不了 pet 页（第三个独立问题）

2.0.1 把 token 写进**浮层窗口自己的** `documentElement`，但浮层是"外壳页 + iframe"，扩展页在
iframe 里，**CSS 自定义属性不跨文档**。已在 `AppWindow.vue` 的 `pushThemeTokens()` 里改为对
overlay 也用查询串 `url` 作为目标（日志确认 `[AppWindow] 下发主题 theme-dark.dark 25 个 token`）。
**但 pet 页面侧没有监听 `obox-theme`**（按 v1 设计"不接主题桥"），token 到了 iframe 也没人用
⇒ 面板底色仍透明。**这一层必须改扩展（pet）才能闭环**，见 `notes/verify/verdicts.md`。

## 三、修复后实测（本地构建，同一 userData）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 双向消息 | ✅ | `[host] 渲染侧入站：t=req method=ui.appMessage`、`ui.appMessage 完成 … 0–1ms` |
| 点击 / 摸头 | ✅ | 截图出现互动气泡「咕嘟咕嘟～被摸摸好舒服！」（`verify/pet-drag-after.png`） |
| 拖动 | ✅ | 同上截图：宠物位置随拖拽改变（按下 → 移动 → 松开可用） |
| 鼠标穿透 | ✅ 已解除 | 拖拽与点击都被页面收到（穿透时不可能收到） |
| webapp 超时 | ✅ 不再出现 | 宿主入站后 `ui.appMessage` 毫秒级回包 |
| 面板背景 | ❌ 仍透明 | `verify/pet-hover-after.png`：面板框在、底色无（R-3 的扩展侧缺口） |
