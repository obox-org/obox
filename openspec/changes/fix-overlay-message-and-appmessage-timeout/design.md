# Design

## Context

见 `proposal.md` 的 Why。这里只记实现相关的事实与约束——**均为本次读码得到，不是推测**：

- **overlay 页面消息链路已在源码里闭环**：
  `extensions/pet/lib/bridge.ts:136` `window.parent.postMessage` → 外壳
  `src/renderer/src/AppWindow.vue:245` 监听 `message`、`:210` 调
  `extensionMessage(isOverlay ? appId : data.appId, channel, payload)` →
  `src/main/appWindow.ts` 的 `ipcMain.on(...)`（转 `main.webContents.send('extension:message')`
  并挂 60 秒回包超时）→ 渲染进程 `core/host.ts` 的 `resolveMessageExtId(appId)`（`:116`：
  `findCardExtension(appId) ?? overlayOwners.get(appId)`）→ `appMessageHandlers` 查找处理器。
  链路上**每一跳都有实现**，因此 pet 失效点必须靠证据定位。
- **归属登记链路也已闭环**：`extension-host/apiFactory.ts:353` 注入 `notifyOverlayOwner` →
  `capabilities/host-main.ts:845`（create 成功后 bind）→ `capabilities/ui-plane.ts:833`
  （`overlay-owner` 事件，端口未到抛 `EH_NOT_READY`）→
  `renderer/src/core/extensionHostConsumer.ts:1293` 分派 → `host.ts:810`
  `registerHostedOverlayOwner` 写 `overlayOwners`。
- **超时来源**：`shared/extensionHostProtocol.ts:57` `ACK_TIMEOUT_MS = 3000`，由
  `extensionHostBridge.request()` 默认使用，超时文案在 `extensionHostBridge.ts:685`。
- **webapp 的 handler 会做 IO**：`extensions/webapp/index.js:2349` 的 `api.app.onMessage`
  里 `case 'open'` → `open()` → `callHelper()` → `ensureHelper()` → `api.ipc.connect()`
  （spawn 子进程），Windows 冷启动常超过 3 秒。
- **约束**：`extension:message` 的 **main→渲染侧** 回包超时是 60 秒（`appWindow.ts` 注释明确
  不能缩短，否则 pet 的 `pet.subscribe` 长轮询会先被宿主判超时）。也就是说**同一业务链路上
  存在两个数量级不同的超时**（渲染→宿主 3 秒 vs 宿主→页面 60 秒），这本身就是缺陷来源。

## Goals / Non-Goals

**Goals:**

- 让"overlay 页面消息在哪一跳丢失"成为**一次日志即可定位**的事实，而不是靠猜。
- 修掉实际断点，并使 `overlay.create` 的成功语义与"消息可达"绑定（不建哑窗口）。
- 把反向 RPC 的预算按方法分级，且超时语义不再把"仍在执行"报成"没有响应"。
- 验收必须可复现：**真机截图 + 视觉模型判定**，每轮修复后重跑。

**Non-Goals:**

- 不改扩展侧代码（`extensions/pet`、`extensions/webapp` 只读参考）——本次只修宿主侧。
- 不改 `api` 形状（不新增扩展可见方法、不升 `apiVersion`）。
- 不引入新的消息协议/信封类型；只在既有 `event`/`req` 语义内做预算与可观测性。
- 不做"任意长任务"的通用流式协议（属后续 change）。

## Decisions

### D-1｜先建诊断，再修断点（诊断是交付物，不是调试残留）

在 `core/host.ts` 的消息入口加一份**单条**结构化追踪：`{ msgId, appId, extIdByCard?, extIdByOwner?,
resolvedExtId?, handlerRegistered?, verdict }`，`verdict ∈ card | overlay | unowned | no-handler | delivered`。

- 未命中时：`console.warn` 一行 + 通过既有 `ExtensionHost` 状态输出到扩展管理器可复制的文本
  （与崩溃原因同一个展示位），文案含 `appId` 与判定结果。
- 命中时：**不输出**（避免 pet 长轮询把日志刷爆）：仅当 `verdict !== delivered` 才记录。
- 被否方案：每次都打印完整追踪——pet 的 `pet.subscribe` 是长轮询，日志量不可接受。

### D-2｜`overlay.create` 与"归属已投递"绑定，并支持重建后重放

保留 D8b 的 `overlay-owner` bind（`event` 信封、`PROTOCOL_VERSION` 不变），但：

1. `host-main.overlayCreate` **只有**在 `notifyOverlayOwner(bind)` 成功返回后才把结果交回扩展
   （现状已是"失败则回收窗口并抛错"——本次补**测试钉住**，并补"回收失败也要报告"的日志）。
2. 新增**重放**：渲染侧收到 `overlay-owner` 之前若已有页面消息（窗口比链路先活），渲染侧 MUST
   记住该 `appId` 的"待归属"状态；归属到达后，**迟到消息不重放**（消息带 requestId，重放会双回包），
   但**必须**让页面收到一条明确错误让客户端重试。理由：宁可让页面重试一次，也不制造重复回包。
3. 主窗口重载后：`overlayOwners` 随渲染进程重建而清空，宿主侧已有窗口不会自动重登记。
   本次补一条"渲染侧 consumer 启动完成 → 通知宿主 re-announce 现存 overlay 归属"的握手
   （复用既有 `host.overlay.*` RPC：新增 `host.overlay.list` 只读方法，返回 `{overlayId, extId}[]`）。

### D-3｜处理器代理的注册必须早于任何页面消息

宿主扩展的 `api.app.onMessage` 注册后，宿主向渲染侧发 `app.register` 的 `messageHandler` 公告
（B3b-1 已有）。本次要求：**公告必须在对应 overlay 的 `overlay-owner` bind 之前发出**，
且在 `appMessageHandler` 注销时同步撤销公告（否则渲染侧会保留指向已注销处理器的代理，
表现为"归属命中但处理器未注册"却查不出原因）。渲染侧未命中处理器时，诊断 MUST 区分
"该扩展从未注册"与"注册后又注销"。

### D-4｜反向 RPC 预算分级（可解释、可按次覆盖）

| 方法族 | 预算 | 理由 |
| --- | --- | --- |
| 普通往返（`host.ping`、`host.proxy.get`、`host.secrets.*`…） | 3 s（不变） | 纯内存/短 IO |
| `ui.appMessage` | **30 s** | 扩展 handler 契约允许 await；webapp spawn 子进程是常态 |
| `ui.executeCommand` | **30 s** | 命令体可含 IO |
| `ui.treeChildren` | **15 s** | 树 provider 可能查网络/磁盘 |
| `host.ipc.connect`（经 `api.ipc.connect`） | **60 s** | 冷启动 spawn sidecar；与 main→renderer 的 60 s 对齐 |
| `update.*` | 15 min / check 60 s（R72 已有） | 整段下载 |

实现：把"方法 → 预算"收口为**单一纯函数** `rpcBudgetMs(method)`（`shared/` 内，可在 node 单测），
由 `ExtensionHostBridge.request()` 与宿主侧 `RpcClient` 共用；调用方可按次覆盖（已支持
`options.timeoutMs`）。被否方案：在各调用点散写魔数（已经踩过一次——`update` 的 3 秒 vs 下载）。

### D-5｜超时语义：`EH_TIMEOUT` + 明确的"仍可能执行"

- 超时仍回既有 `EH_TIMEOUT` 码（不新增错误码），但 `message` 改为：
  「方法 X 在 Ns 内未回包；宿主侧**可能仍在执行**。可等待后重试；若持续如此，在扩展管理器重启宿主。」
- 日志侧记录 `{ method, id, budgetMs, elapsedMs }`，便于用户把日志贴回来定位。
- 迟到结果：**丢弃并记录**（`late result dropped`），不重试、不重启宿主——与既有"只观测不杀"一致。

### D-6｜验收：真机截图 + 视觉模型判定，逐轮迭代

用户要求"运行截图并用 Nemotron 3.5 Super VL 识别问题是否解决，迭代直到完全解决"。落地方式：

1. **场景脚本**（人工可复现）：① 打开 obox（宿主模式默认开）→ 宠物出现 → 鼠标悬停 →
   截图 A（判据：面板**不透明**、显示等级名/数值、**不是**"正在连接宠物"）；
   ② 按住宠物拖动 → 截图 B（判据：窗口位置变化、鼠标穿透已关闭）；
   ③ 打开网页应用卡片 → 执行一次会 spawn 助手的操作 → 截图 C（判据：无"超时时间内没有响应"报错）。
2. **判定**：把截图交给视觉模型（按用户指定：Nemotron 3.5 Super VL）逐条给"通过/不通过 + 理由"；
   任一不通过 ⇒ 回到实现，修完再截图，直到三项全通过。
3. **可用性降级（必须如实记录）**：若该模型在本机/本会话不可调用（无端点、无凭据），
   则退化为"助手读图 + 人工确认"，并在 `notes/` 里写明哪一轮用了哪种判定，不假装用过。

### D-7｜主题 token 必须下发到 overlay 的 **iframe**（推翻 2.0.1 的做法）

- **事实**：overlay 窗口加载的是**外壳页**（`index.html?obox-window=overlay&url=…`），扩展页在
  **iframe** 里；CSS 自定义属性**不跨文档继承**。2.0.1 的修法是"渲染侧上报 → main 缓存 →
  preload 写到本窗口 `documentElement`"，对 iframe 里的宠物页**毫无作用**——实测截图里面板文字在、
  背景全透明（`notes/repro/pet-hover-before.png`），且 main 日志显示 token 已"下发"给该窗口。
- **决策**：沿用**既有** `obox-theme` postMessage 协议（App 卡片一直在用），把 `pushThemeTokens()`
  的目标 URL 从"清单里的 `registration.url`"改为 `isOverlay ? overlayUrl : registration.url`；
  触发点不变（iframe `load` / 主题变化 / 页面主动 `obox-theme-request`）。扩展侧零改动。
- **被否**：① 继续用 2.0.1 的 preload 写 documentElement（对 iframe 无效）；
  ② 新增"扩展页自己读主题"的 API（要扩 API 面、且与既有 25 token 协议重复）。
- **回归防线**：`test/app-window-wiring.test.ts` 与 `test/overlay-window.test.ts` 各钉一条源级断言
  （overlay 用 `overlayUrl`、且不得回退到"registration 缺省即跳过"）。

## Risks / Trade-offs

- **[放宽预算 → 慢故障更难被发现]** → 保留 3 秒档给纯查询；超时日志含真实耗时，慢在哪个方法一目了然。
- **[归属重放可能与页面重试叠加，产生重复动作]** → 页面消息带 `requestId`，渲染侧**不重放**迟到消息，
  只回错让页面自行重试；扩展侧的重试已是幂等（pet 的 `load/save` 语义）。
- **[新增 `host.overlay.list` 抬高协议面]** → 只读、无副作用、不改变现有方法语义；`PROTOCOL_VERSION` 不变
  （方法名不是信封字段）。
- **[诊断日志量]** → 只在 `verdict !== delivered` 时记录；pet 长轮询命中的路径不产生日志。
- **[真机验收不可自动化]** → 场景脚本固定为 3 个动作，截图命名与判据写进 `tasks.md`，便于多轮对比。

## Migration Plan

1. 先合"诊断 + 预算分级"（无行为破坏），发补丁版观察用户侧日志；
2. 再合"归属重放 / `host.overlay.list`"（新增只读 RPC），随下一补丁版发出；
3. 回退：预算表集中在 `rpcBudgetMs()` 单点，回退即恢复 3 秒默认；归属重放失败只影响重载后的旧窗口，
   新建窗口路径不受影响。

## Open Questions

- 视觉模型（Nemotron 3.5 Super VL）在本机是否可调用、端点与凭据如何配置——不影响规格与任务拆分，
  实施时若不可用则按 D-6 的降级方案执行并记录。
