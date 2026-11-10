# Design

## Context

见 `proposal.md - Why`。设计相关现状（均为读码事实）：

- **外壳已有可信 extId**：overlay 窗口的查询串由主进程写入
  `?obox-window=overlay&extId=…&overlayId=…&appId=<overlayId>&url=…`（`src/main/appWindow.ts`），
  外壳 `AppWindow.vue` 用 `isOverlayUrlAllowed(raw, extId)` 做过二次校验（协议 + 三个 host + 首段 = extId + 拒 `..`）。
  也就是说：**归属信息已经在手上，只是转发时没用它**。
- 转发路径：`AppWindow.vue` → `window.api.extensionMessage(isOverlay ? appId : data.appId, channel, payload)`
  → main → 主窗口 `host.handleExtensionMessage(appId, channel, payload)`
  → `resolveMessageExtId(appId, findCardExtension, overlayOwners)`。
- `overlayOwners` 只在渲染侧 `api.overlay.create` 里写入；宿主模式下创建发生在 Extension Host 进程，
  渲染侧不会执行那段代码 ⇒ 表为空。仓库已有 EH-D8b 的回填事件（宿主 `notifyOverlayOwner` →
  `overlay-owner` → 消费者 `applyOverlayOwner`），但**真机未生效**（日志显示未命中）。
- 卡片的 `appId` 语义必须保持：卡片窗口没有 overlayId，`appId` 就是卡片 id。

## Goals / Non-Goals

**Goals:**

- 宿主模式与渲染模式下，浮层消息都能寻址到正确扩展（pet 面板恢复）。
- 归属来源收敛为"**主进程写入、外壳校验**"这一条可信通道，去掉对回填事件的强依赖。
- 查不到时的日志能直接看出走过哪几条路。

**Non-Goals:**

- 不排查/修复 EH-D8b 事件链本身（它降为兜底；若实现时顺带找到断点，只记录不扩范围）。
- 不改 overlay 的创建/销毁/拖拽语义，不改 `PROTOCOL_VERSION`，不改扩展 API 形状。
- 不做"多扩展共享一个 overlay"这类新能力。

## Decisions

### D1. 用查询串 `extId` 作为浮层消息的归属，而不是补表

- **选择**：外壳在转发浮层消息时把 `extId` 一起带给 main/宿主；宿主优先按它寻址。
- **理由**：这个值由主进程写、由外壳校验，**不需要任何回填与同步**，天然免疫"事件丢失/端口未就绪"。
  把归属建立在"一张需要跨进程回填的表"上，本质上是在给易失状态做冗余，成本高且仍会哑。
- **替代方案**：① 修好 EH-D8b 事件链（否决为主路径：仍需跨进程同步，端口时序问题会再犯；保留作兜底）；
  ② 让 main 在转发时自己查 extId（可行，但 main 需维护 overlayId→extId 表，多一份状态；而窗口 query 里本来就有，
  外壳是唯一知道"这条消息来自哪个窗口"的地方，由它带上最直接）。

### D2. 优先级：可信 extId → 卡片表 → 归属表

- **选择**：`extId` 存在时直接寻址；否则走既有两条。
- **理由**：可信 extId 只在浮层窗口出现（卡片窗口没有该参数），顺序既不会改变卡片行为，也能让旧形状继续工作。
- **替代方案**：卡片优先（否决：卡片窗口根本没有 extId，顺序调换没有收益，反而让浮层的越权校验更绕）。

### D3. 页面自带的 `appId` 不参与归属判定

- **选择**：浮层分支只认外壳注入的 `extId`；页面消息里的 `appId` 字段保留（协议兼容）但不用于归属。
- **理由**：页面是扩展自己的代码，但**归属是宿主资产**；让页面决定归属等于把越权开口交给扩展。
  这与现有 `isOverlayUrlAllowed` 的"只信主进程写的查询串"一致。
- **替代方案**：允许页面指定（否决：与既有安全模型冲突，且没有任何真实需求）。

### D4. 诊断日志带三条尝试路径

- **选择**：查不到时输出 `归属=(卡片: 未命中, 查询串 extId: 无, 归属表: 未命中)` 形态的一条 warn。
- **理由**：这次的排查成本几乎全部花在"不知道它试了什么"上。
- **替代方案**：保持现状（否决：同类问题会再耗一次）。

### D5. 门禁用纯函数 + 源码断言两层

- **选择**：`resolveMessageExtId` 增加 `overlayExtId` 入参并单测（三条路 + 优先级 + 越权场景）；
  再用源码门禁钉住"外壳转发时带 extId、宿主侧存在该分支"。
- **理由**：设备级验证（真机浮层）依赖 pet 安装与 host 模式，不适合当唯一门禁；纯函数能钉住优先级。
- **替代方案**：只做真机验证（否决：不可回归，改坏了没人知道）。

## Risks / Trade-offs

- [main 的 `extensionMessage` IPC 目前只有 `appId` 参数] → 需要扩参（纯加法、老调用方不传即保持原行为）；
  若 IPC 契约有版本校验，则加字段不改语义。
- [浮层 extId 与窗口实际归属不一致（历史脏 query）] → 外壳已校验路径首段 = extId；仍不一致时由宿主
  在投递前比对"该扩展是否真的注册了处理器"，查不到则回落归属表并记录。
- [卡片窗口可能被误传 extId] → 外壳只在 `isOverlay` 分支填该字段，卡片分支恒为 undefined；门禁覆盖。
- [兜底路径长期无真实用例] → 保留但标注"仅向后兼容"，若两个 minor 内无触发即在后续 change 删除。

## Migration Plan

1. 纯加法：新增"可信 extId"通道，原有两条路径不变 ⇒ 无灰度风险。
2. pet 面板在宿主模式下应立刻恢复（无需扩展升级，因为它本来就把 overlayId 当 appId 发）。
3. 回滚：移除外壳传参与宿主分支即可；无数据迁移、无持久化字段。

## Open Questions

- EH-D8b 事件链为何在真机未生效（是端口时序，还是 `registerHostedOverlayOwner` 未被装配）——**不影响本方案**，
  实现时顺手记录结论到技术债清单，不扩本 change 范围。
