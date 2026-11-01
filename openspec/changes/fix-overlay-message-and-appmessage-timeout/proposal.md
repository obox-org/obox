# Proposal

## Why

obox 2.0.0 把用户扩展搬进 Extension Host 进程后，有两条**跨进程消息链路**在真机上不可用或不可用得当：

1. **宿主进程创建的 overlay 浮层，页面消息送不到扩展入口**。宠物（pet 2.0.0/2.0.1）实测：
   窗体出现、idle 动画在播，但面板一直显示"正在连接宠物"，且永不解除鼠标穿透（入口收不到
   `pet.hit`）⇒ **点不动、拖不动**、面板永远空。
   链路上每一跳在源码里都存在（`pet/lib/bridge.ts:136` → `AppWindow.vue:210/245` →
   `main/appWindow.ts` → `main.webContents.send('extension:message')` → `core/host.ts:116`
   `resolveMessageExtId` → `appMessageHandlers`），**但没有一处能把"消息在哪一跳丢了"说出来**，
   所以只能靠猜。技术债 #13（overlay 归属）在 2.0.0 已修（D8b），真实失效点尚未被证据定位。

2. **反向 RPC 的 3 秒预算对"会做 IO 的 handler"不成立**。webapp 实测报错：
   「对端在超时时间内没有响应…（方法 ui.appMessage（id=3）在 3000ms 内没有响应；渲染侧已放弃等待，
   宿主侧可能仍在执行）」。`api.app.onMessage` 的契约是"扩展可以 await 任意工作"，而
   webapp 的 handler 里 `open()` → `callHelper()` → `ensureHelper()` → `api.ipc.connect()`
   会 **spawn 子进程**（Windows 上首次连接常超过 3 秒）⇒ 用户看到一条与事实相反的失败。

两个问题都**只在真机上出现**（2.0.0/2.0.1/2.0.2 的单测全绿），且都会让用户直接判定"扩展坏了"。

## What Changes

- **新增诊断能力（先于修复）**：为 `overlay 页面消息 → 入口` 这条链路加一份**单点可查的追踪**——
  在渲染侧记录每个 `appId` 的解析结果（命中卡片 / 命中 overlay 归属 / 未命中）与处理器查找结果，
  并在未命中时把**具体一跳**写进既有日志与扩展管理器的可复制状态文本。目的：让"哪个 appId、
  在哪一跳被丢弃"成为可观测事实，而不是猜测。
- **修 overlay 消息路由的实际断点**：依据上一步得到的证据，修掉命中的那一跳（候选：归属表未登记、
  处理器代理未注册、`appId` 与 `overlayId` 不一致、消息在 shell→main 的转发被 overlay 分支漏掉），
  并补齐**未命中时的可执行错误**（不再静默丢弃）。
- **反向 RPC 按方法分级预算**：`ui.appMessage`（以及同族的 `ui.executeCommand` / `ui.treeChildren`）
  不再共用 3 秒；显式给出可解释的预算（如 `appMessage` 30 秒），且**超时不等于失败**的语义要落到
  用户可见文案与日志（"仍在执行/已超过预算"而不是"对端没有响应"）。
- **`api.ipc.connect` 的冷启动不被 3 秒吞掉**：webapp 首次 `connect`（spawn 子进程）走的也是
  反向 RPC；在同一套分级预算里覆盖 `ipc.connect`，避免"首次打开必报超时、第二次就好了"。
- **验收方式固定**：本 change 的验收必须包含**真机截图 + 视觉模型判定**（用户要求），
  每轮修复后重新截图，直到两个场景都判定通过（详见 design 的验收章节与 tasks）。

**BREAKING**：无。超时预算调整对扩展是纯放宽；诊断日志为新增输出。

## Capabilities

### New Capabilities

- `overlay-message-routing`: 宿主进程创建的 overlay 浮层，其页面消息必须能被路由到**创建它的扩展**
  的 `api.app.onMessage` 处理器；路由失败时必须给出可诊断原因（哪一跳、哪个 id），不得静默丢弃。
- `host-rpc-timeouts`: 渲染进程 → 扩展宿主 → 主进程的反向 RPC，必须按方法给出**可解释的预算**；
  超时的用户可见语义必须区分"仍在执行"与"真的没有响应"。

### Modified Capabilities

<!-- 无：本 change 新建上述两个 capability，不改动已有 spec 的 requirement。 -->

## Impact

- **宿主仓**：`src/shared/extensionHostProtocol.ts`（超时常量）、
  `src/renderer/src/core/extensionHostBridge.ts`（按方法预算与超时文案）、
  `src/renderer/src/core/extensionHostConsumer.ts`（overlay 归属/处理器登记、诊断追踪）、
  `src/renderer/src/core/host.ts`（`resolveMessageExtId` 与 `handleExtensionMessage` 的诊断输出）、
  `src/renderer/src/AppWindow.vue`（overlay 分支的消息转发若有漏）、
  `src/main/appWindow.ts`（`extension:message` 转发与 60 秒回包超时的一致性）、
  `src/extension-host/capabilities/ui-plane.ts`（`ui.appMessage` 等服务端的预算与错误语义）。
- **扩展仓**（只读参考，不在本 change 改代码）：`extensions/pet`（overlay 消息客户端）、
  `extensions/webapp`（`open()` → `ensureHelper()` 的冷启动路径）。
- **文档**：`docs/extension-api/api-reference.md`（`app.onMessage` 的预算与"超时≠失败"语义）、
  `docs/extension-api/troubleshooting.md`（新增"面板一直在连接/拖不动"与"ui.appMessage 超时"两条）、
  `docs/extension-host-migration.md`（技术债 #13 的追加记录与新债）。
- **验证**：真机（Windows）截图 + 视觉模型判定；自动化侧补"三跳追踪"的单元/接缝测试。
