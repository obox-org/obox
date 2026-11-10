# Proposal

## Why

桌面宠物（`pet`）的浮层在**宿主模式**（2.0 起默认：用户扩展跑在 Extension Host 进程）下**收不到任何状态**：
面板永远是空的，点击也无效，控制台每 2 秒刷一条

```
[host] 扩展消息未投递：appId=pet.overlay channel=pet.subscribe
       归属=(未命中：卡片与 overlay 归属表都查不到) 处理器=(无从查找)
[pet] 订阅失败，2000ms 后重试：扩展未注册消息处理器
```

链路是：浮层页面把 `overlayId`（`pet.overlay`）当 `appId` 发消息 → 外壳 `AppWindow` 转发 →
主窗口 `host.handleExtensionMessage` 按 `appId` 找归属（先查 App 卡片，再查 `overlayOwners`）→ 都查不到 ⇒ 丢弃。

`overlayOwners` 只在**渲染进程自己的** `api.overlay.create` 里回填；宿主模式下创建动作发生在
Extension Host 进程（经 main 建窗），所以这张表是空的。仓库里已经有补这条缝的设计
（EH-D8b：宿主发 `overlay-owner` 事件让渲染侧回填，见 `ui-plane.ts` / `extensionHostConsumer.ts`），
但**实测仍然未命中**——说明该事件链路在生产装配里没生效（或从未在真机验证过），于是技术债 #13 事实上仍在。

## What Changes

- **按可信来源直接寻址**：浮层窗口的 `extId` 是**主进程写进查询串**并已由外壳二次校验的
  （`AppWindow.vue` 的 `isOverlayUrlAllowed`），因此浮层页面消息可以**直接带 extId 转发**，
  不再依赖"渲染侧回填一张表"。这与现有安全模型一致：扩展与页面都无法伪造别人的 extId。
- **保留 `overlayOwners` 作为兜底**：EH-D8b 的事件回填路径继续存在（用于历史卡片/异常形状），
  但不再是浮层消息送达的**唯一**通路；查不到 extId 时才回落到它。
- **诊断可见**：归属仍查不到时，日志必须写明"已尝试的三条路"（卡片 / 查询串 extId / overlay 归属表），
  不再只给一个"未命中"。
- **回归门禁**：新增断言钉住"浮层页面消息能寻址到扩展"，并覆盖宿主模式（`OBOX_EXTENSION_HOST` 开）。

## Capabilities

### New Capabilities

- `overlay-message-routing`: 浮层（overlay）窗口与宿主之间的消息寻址——可信 extId 的来源与优先级、
  兜底路径、查不到时的诊断输出，以及宿主模式下的等价行为。

### Modified Capabilities

（无。`extension-ui-components` / `extension-page-loading` 等既有规格不涉及消息路由。）

## Impact

- **代码**：`src/renderer/src/AppWindow.vue`（浮层转发时带上 `extId`）、
  `src/renderer/src/core/host.ts`（`handleExtensionMessage` 增加"按调用方 extId 寻址"分支与诊断）、
  可能涉及 `src/preload` / `src/main` 的转发签名（若现有 IPC 只带 `appId`）。
- **行为**：宿主模式下 pet 面板恢复（状态、点击、长轮询）；卡片窗口与既有扩展不受影响。
- **文档**：`docs/extension-api/api-reference.md` 的 overlay 一节补"消息寻址"说明；
  `troubleshooting.md` 增加"浮层面板空白 / 点击无效"条目；技术债 #13 在迁移文档里结项。
- **不做**：不改 `PROTOCOL_VERSION`、不改扩展 API 形状、不要求扩展重写。
