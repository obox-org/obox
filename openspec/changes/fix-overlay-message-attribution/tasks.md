# Tasks

## 1. 先复现并留下证据

- [ ] 1.1 真机复现：`npm run dev` 开宿主模式，确认 pet 浮层日志出现 `归属=(未命中…)`；把日志片段落到
      `openspec/changes/fix-overlay-message-attribution/notes/repro.md`（含 `OBOX_EXTENSION_HOST` 状态、扩展数、
      首条/末条时间戳）
- [ ] 1.2 顺带记录 EH-D8b 事件链的现场结论（宿主是否发出 `overlay-owner`、渲染侧是否收到），**只记录不修**

## 2. 寻址：纯函数与优先级

- [ ] 2.1 `src/renderer/src/core/host.ts`：`resolveMessageExtId(appId, findCardExtension, overlayOwners, overlayExtId?)`
      改为四参；优先级 = 可信 `overlayExtId` → 卡片表 → 归属表
- [ ] 2.2 查不到时的诊断信息改成结构化三段（卡片 / 查询串 extId / 归属表），由调用方拼进日志
- [ ] 2.3 单测 `test/overlay-message-routing.test.ts`：三条路各自命中、优先级顺序、页面伪造 appId 不生效、
      卡片行为逐字不变、extId 缺失时回落

## 3. 传参：外壳 → main → 宿主

- [ ] 3.1 `src/renderer/src/AppWindow.vue`：浮层分支调用 `window.api.extensionMessage(..., { extId })`
      （卡片分支不传，保持 undefined）
- [ ] 3.2 `src/preload/index.ts` + `src/shared/types.ts`：`extensionMessage` 增可选第三/四参
      `{ extId?: string }`（纯加法，老调用方不传即原行为）；main 侧 IPC 转发同字段
- [ ] 3.3 `src/main/*`：把 `extId` 原样转发到主窗口渲染侧（不解释、不校验，校验在外壳与既有
      `isOverlayUrlAllowed` 已完成）
- [ ] 3.4 `src/renderer/src/core/host.ts`：`handleExtensionMessage` 接受并透传 `extId`
- [ ] 3.5 宿主侧（若 `ui.appMessage` 的寻址也经过渲染侧统一入口，则无需改；否则在宿主消费处同样优先 extId）

## 4. 文档与债

- [ ] 4.1 `docs/extension-api/api-reference.md` 的 overlay 一节补「消息寻址」：归属由宿主决定，页面
      `appId` 只作兼容字段
- [ ] 4.2 `docs/extension-api/troubleshooting.md` 增加条目「浮层面板空白 / 点击无效」：症状、三条归属路径、
      自查方法（看日志 `归属=(…)`）
- [ ] 4.3 `docs/extension-host-migration.md`：技术债 #13 结项（写明"已由可信 extId 解决，事件回填降为兜底"）

## 5. 验收

- [ ] 5.1 `npm run typecheck` + `npm run lint`（0 error）+ `npm test` 全绿；新增单测与源码门禁通过
- [ ] 5.2 真机（宿主模式）：pet 面板拿到状态、点击有效、日志无 `归属=未命中`；连续开关浮层 3 次仍正常
- [ ] 5.3 真机（渲染模式，`OBOX_EXTENSION_HOST=0`）：同样可用，证明两条模式等价
- [ ] 5.4 回归：卡片窗口（rdp / webapp）消息仍正常，找不到卡片时的错误文案不变
