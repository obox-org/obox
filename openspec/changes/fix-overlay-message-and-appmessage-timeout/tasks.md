# Tasks

## 1. 复现与基线证据

- [x] 1.1 记录当前安装版本与构建指纹（`package.json` 版本、`app.asar` 中是否含 `overlay-owner` 字样、进程启动时间），写入 `notes/repro.md`；验证方式：`notes/repro.md` 含版本号与三条指纹的原始输出
- [x] 1.2 复现 pet 三个症状并截图存证（面板"正在连接宠物"、面板透明、鼠标穿透/不可拖动）→ `notes/repro/pet-before.png`；验证方式：截图存在且能读出上述三处症状
- [x] 1.3 复现 webapp 超时报错并截图 + 抓取完整错误文案（含 `ui.appMessage` id 与毫秒数）→ `notes/repro/webapp-before.png`、`notes/repro/webapp-error.txt`；验证方式：文件存在，文案含 `3000ms` 与"仍在执行"
- [x] 1.4 打开渲染进程日志（主窗口 DevTools 或 `[host]`/`[child-renderer]` 前缀行），保存 pet 悬停前后的原始日志段 → `notes/repro/pet-log-before.txt`；验证方式：日志段里能看到（或看不到）`appId` 相关行，作为 D-1 诊断缺口的证据

## 2. 消息路由诊断（D-1）

- [x] 2.1 在 `src/renderer/src/core/host.ts` 的消息入口实现单条结构化追踪（`msgId/appId/cardExtId/ownerExtId/resolvedExtId/handlerRegistered/verdict`），仅当 `verdict !== delivered` 时记录；验证方式：新增单测断言 delivered 不打印、未命中打印一次且含 appId
- [x] 2.2 未命中诊断接入扩展管理器可复制状态文本（与崩溃原因同一展示位）；验证方式：单测断言状态文本包含 `appId` 与`card|overlay|unowned|no-handler` 之一
- [x] 2.3 在 `docs/extension-api/troubleshooting.md` 新增条目「面板一直显示正在连接 / 宠物拖不动（overlay 消息路由）」：说明如何用上述日志定位失败跳；验证方式：文档条目含日志样例与三步自查
- [ ] 2.4 用 1.4 的基线日志对拍：在同一次复现中确认新诊断能指出 pet 的失败跳，并把结论写入 `notes/repro.md`；验证方式：`notes/repro.md` 明确写出"失败跳 = transport|ownership|handler"及对应日志行

## 3. overlay 归属与处理器（D-2 / D-3）

- [ ] 3.1 钉住 `overlay.create` 的强契约：`notifyOverlayOwner(bind)` 失败 ⇒ 回收窗口 + 明确报错（补测试，不改既有实现语义）；验证方式：单测断言 create 返回失败、窗口已被销毁、屏幕无残留窗口
- [ ] 3.2 补齐"归属未到时页面早发消息"的行为：渲染侧记录待归属 appId、不重放迟到消息、回一条可读错误让页面重试；验证方式：接缝测试断言页面收到错误而不是永久等待，且扩展处理器零调用
- [ ] 3.3 处理器公告生命周期：`app.register` 的 `messageHandler` 公告 MUST 早于对应 `overlay-owner` bind；注销时同步撤销公告；验证方式：单测断言事件顺序（先用假端口记录 channel 序列）与注销后诊断显示"注册后已注销"
- [ ] 3.4 新增只读 RPC `host.overlay.list` 返回 `{overlayId, extId}[]`，consumer 启动完成后拉取并重登记（主窗口重载场景）；验证方式：接缝测试模拟"已有窗口 + 新 consumer"⇒ `overlayOwners` 被填充；协议无新信封、`PROTOCOL_VERSION` 不变
- [ ] 3.5 在 `docs/extension-host-migration.md` 技术债表更新 #13 的追加记录（重放与列表 RPC），并新增一条说明"主窗口重载后的重登记"；验证方式：文档中可见对应两行

## 4. 反向 RPC 预算分级（D-4）

- [x] 4.1 新增纯函数 `rpcBudgetMs(method)`（放 `src/shared/`），实现 design 中的预算表；验证方式：单测覆盖 6 个方法族的默认值、未知方法回落 3 秒、per-call 覆盖优先
- [x] 4.2 `ExtensionHostBridge.request()` 改用该函数（保留 per-call 覆盖）；验证方式：单测断言 `ui.appMessage` 默认 30000、`host.ping` 默认 3000、显式 `timeoutMs` 生效
- [x] 4.3 宿主侧 `RpcClient` 调用点（`ui.appMessage` / `ui.executeCommand` / `ui.treeChildren` / `host.ipc.connect`）使用同一预算表；验证方式：单测断言宿主向渲染侧发起的三条请求使用 30s/30s/15s
- [ ] 4.4 `api.ipc.connect` 冷启动覆盖：确认渲染→宿主侧 connect 的预算为 60 秒，且超时报文标注"正在启动子进程"；验证方式：单测断言超时文案与预算
- [x] 4.5 更新 `docs/extension-api/api-reference.md` 的 `app.onMessage` 一节：写明预算、`appAsync` 语义与"超时≠失败"；验证方式：文档含预算表与一句"超时后宿主可能仍在执行"

## 5. 超时语义与迟到结果（D-5）

- [ ] 5.1 超时错误文案改为「在 Ns 内未回包；宿主侧可能仍在执行…」并记录 `{method,id,budgetMs,elapsedMs}`；验证方式：单测断言文案与日志字段
- [ ] 5.2 迟到结果丢弃且记录 `late result dropped`，不触发重启/停用；验证方式：单测断言宿主仍 ready、扩展仍 active、页面未收到该结果
- [x] 5.3 在 `docs/extension-api/troubleshooting.md` 新增「ui.appMessage 超时」条目：区分"仍在执行/子进程启动中/宿主卡死"三种情形与处置；验证方式：条目含三种情形与对应动作

## 6. 真机验收：截图 + 视觉模型判定（D-6）

- [x] 6.1 构建并安装本轮修复包，按 `design.md` D-6 的 3 个场景截图：`notes/verify/pet-hover.png`、`notes/verify/pet-drag.png`、`notes/verify/webapp-open.png`；验证方式：三张截图存在且时间戳晚于安装时间
- [x] 6.2 用视觉模型（按用户指定 Nemotron 3.5 Super VL）逐条判定并记录"通过/不通过 + 理由"到 `notes/verify/verdicts.md`；若模型不可调用，按 D-6 降级为助手读图 + 人工确认，并在文件里写明本轮用的是哪种判定；验证方式：`notes/verify/verdicts.md` 对 3 个场景各有判定结论与依据
- [x] 6.3 任一场景不通过 ⇒ 修复后重新截图与判定（回到 2–5 的对应组），直到三项全通过；验证方式：`notes/verify/verdicts.md` 的最终一轮三项均"通过"，且保留此前各轮的判定记录

## 7. 集成检查与发版准备

- [ ] 7.1 全量门槛：`npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 全绿；验证方式：四条命令 exit 0 且贴原始输出
- [ ] 7.2 回归确认：`test/extension-host-real-extensions.test.ts`（真实扩展集成测试）仍全绿，判定无回归；验证方式：该文件全绿输出
- [ ] 7.3 版本与发布说明：`package.json` 升补丁版本、`CHANGELOG`/release notes 写清两个用户可见修复；验证方式：版本号变更 + notes 含"宠物面板/拖动"与"webapp 超时"两条

## Workflow follow-up

- 归档本 change 前，确认 `notes/repro.md`、`notes/verify/verdicts.md` 与本 change 的 specs 一致。
- 归档后把 `overlay-message-routing` 与 `host-rpc-timeouts` 同步进主 specs。
