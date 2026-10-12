# spec · 扩展 IPC：pipe 服务端（宿主 listen 接受多连接）— issue #43

> 阶段二产物（`skills/obox-ext-dev/references/workflow.md:51-63`）。**未确认前不得开工**（`workflow.md:66`）。
> 落位：宿主 / 扩展系统 → ADR 写仓库 `docs/adr/`（`workflow.md:92`）；本 spec 归档到仓库 `docs/spec/`（`workflow.md:96`）。
> **状态：已定稿**。三个待决问题（Q1 服务端表面 / Q2 清单声明面 / Q3 stdio 范围）已由用户拍板，结论见 §6「决策记录」；本文所有分支写法已收敛为单一写法，全文**不含**待确认标记。
> **建议实现顺序：#43 先、#44 后（串行）**，理由三条：① 两份 spec 共同改 `src/main/ipc.ts`、`src/shared/types.ts`、`src/api/types.ts`、`src/renderer/src/core/host.ts`，串行可避免同一文件的写冲突与设计返工；② #44 的重连只作用于**客户端通道**，其"通道 vs 连接"边界、`channels()` 语义、`close(name)` 统一语义都要先由 #43 定死（见 `tmp/spec/extension-ipc-reconnect.md` §7 与本文 §6）；③ #43 不引入 `autoReconnect`，先独立落地即可验证，且对既有扩展的行为逐字节不变。
> **事实引用基准**：本文所有 `文件:行` 行号基于 master `722cebc`；#43 落地后，#44 引用到的同文件行号会平移，届时以代码为准。
> 配对的另一份：`tmp/spec/extension-ipc-reconnect.md`（issue #44）。

## 1. 背景与事实

需求来源：issue #43（标题「扩展 IPC：pipe 服务端（宿主 listen 接受多连接）」，label `follow-up`）。ADR-0016 已把本项列入「本期明确不做」（`docs/adr/0016-ipc-transport-and-protocol.md:20-25`），并预留了端点 `suffix` 参数（`docs/adr/0016-ipc-transport-and-protocol.md:11`、`src/main/ipcCore.ts:636-662`）。已实现的是 **pipe 客户端**（宿主作为拨号方）。

现状事实（每条带证据；未查证的不写）：

| #   | 事实                                                                                                                                                                                       | 证据                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| F1  | `api.ipc` 表面只有 `connect / close / channels / request / notify / onRequest / onNotification / onClose / onStderr`，全部按**通道名**寻址，没有"连接"概念                                            | `src/api/types.ts:394-418`；实现 `src/renderer/src/core/host.ts:1152-1259`                     |
| F2  | 声明形状 `{ id, transport: 'stdio' \| 'pipe', program?, args?, framing? }`；`pipe` **禁止** `program/args`                                                                                     | `src/shared/ipcDeclaration.ts:17-28`、`src/shared/ipcDeclaration.ts:99-101`                    |
| F3  | 端点命名：Windows `\\.\pipe\obox-<扩展id>-<通道名>[-<suffix>]`；POSIX `<socketDir>/obox-<扩展id>-<通道名>[-<suffix>].sock`，`socketDir = <userData>/ipc`                                          | `src/main/ipcCore.ts:652-662`、`src/main/ipc.ts:56-58`、`src/main/ipc.ts:177-182`              |
| F4  | `openPipeClientTransport` 只支持作为客户端 `net.createConnection`；**全文件无 `net.createServer` 路径**；POSIX 无 `chmod`/陈旧文件清理                                                            | `src/main/ipcTransport.ts:185-233`（全文件无 `createServer`）                                  |
| F5  | 每扩展通道上限 `MAX_CHANNELS_PER_EXTENSION = 4`，重名报 `invalid-declaration`、超限报 `too-many-channels`                                                                                     | `src/main/ipc.ts:32-33`、`src/main/ipc.ts:107-120`                                            |
| F6  | 稳定错误码共 11 个，闭集在 `IpcErrorCode`；无 `too-many-connections`                                                                                                                          | `src/main/ipcCore.ts:32-44`                                                                   |
| F7  | 主进程 → 渲染进程只有 `ipc:event` 一条事件流，事件种类 `notification / request / stderr / close`，**无** `connection` / `disconnect`                                                             | `src/shared/types.ts:471-483`、`src/main/ipc.ts:60-65`、`src/renderer/src/core/host.ts:1176-1206` |
| F8  | 对端请求经 `forwardInboundRequest` 转发到渲染进程，用 `pendingReplies` + `requestId` 关联回包，30s 上限；**已天然支持多路并发**（不同 requestId）                                                 | `src/main/ipc.ts:35`、`src/main/ipc.ts:84-105`、`src/main/ipc.ts:303-309`                       |
| F9  | 通道清理只有一个时机：扩展停用/卸载/重载/退出 → `cleanupExtensionResources` → `closeExtensionIpc(extId)`                                                                                        | `src/main/extensionCleanup.ts:13,23-29`、`src/main/ipc.ts:226-232`                             |
| F10 | 运行时声明与清单声明共用一套校验；清单里 `contributes.ipcChannels` 非法会让**清单无效**                                                                                                        | `src/shared/ipcDeclaration.ts:54-137`、`src/renderer/src/core/manifest.ts:46-56`               |
| F11 | 测试先例：`test/ipc-transport.test.ts` 用**真实**命名管道/UDS 起 `net.createServer` 扮演对端，POSIX 侧手工 `chmod 0600`；`test/ipc-core.test.ts` 覆盖分帧与状态机                                | `test/ipc-transport.test.ts:84-128,214-247`、`test/ipc-core.test.ts`                           |
| F12 | 现有 `api.ipc` 文档面：api-reference 的 `api.ipc` 小节（含限额/错误码表）；manifest-reference 的 `ipcChannels` 小节                                                                            | `skills/obox-ext-dev/references/api-reference.md:597-659`、`.../manifest-reference.md:253-279`  |
| F13 | 线上错误用整数码常量：`RPC_METHOD_NOT_FOUND = -32601` / `RPC_INTERNAL_ERROR = -32603` / `RPC_INVALID_REQUEST = -32600`，错误帧形状 `{jsonrpc:'2.0', id, error:{code, message}}`                 | `src/main/ipcCore.ts:247-249`、`src/main/ipcCore.ts:574-578`                                   |
| F14 | `apiVersion` 单源在根 `package.json`（当前 `1`），且**只在破坏性签名变更时递增**（纯新增不递增）                                                                                                  | `package.json:4`、`docs/adr/0010-api-version.md:15`                                            |

约束：

- **不使用 TCP/端口**（ADR-0016 决策 1，`docs/adr/0016-ipc-transport-and-protocol.md:9-11`）——服务端只能用 `node:net` 的命名管道 / Unix 域套接字。
- 能力而非安全边界（ADR-0015）；不宣称隔离。
- 不新增运行期 npm 依赖（`workflow.md:47`）：`node:net` 是内置模块，满足。
- **不改 `apiVersion`**：本次是纯新增（新方法 + 新事件成员 + 一个新稳定错误码），按 ADR-0010 决策 4 不递增（F14）。

## 2. 目标 / 非目标

**目标**

- G1 宿主可作为服务端 listen 一个 pipe 端点，接受**多个**对端连接。
- G2 每条连接有**单调递增、永不复用**的数字连接 ID（Q1）；扩展能按连接 ID 定向请求/通知，或向全部连接广播。
- G3 连接级限额与可诊断的失败行为（端点被占用、连接超限、陈旧 `.sock`）。
- G4 生命周期与既有通道一致：扩展停用/卸载/重载/退出即关闭 server 并断开全部连接。

**非目标（明确不做，防范围蔓延）**

- N1 不做 TCP / HTTP / WebSocket（ADR-0016 决策 1 不变）。
- N2 不做自动重连：服务端连接断开只发 `disconnect` 通知（R5/R18），客户端通道的重连属 issue #44（`tmp/spec/extension-ipc-reconnect.md`），且**不涉及**连接 ID（#44 R8/R17）。
- N3 不做对端身份鉴权 / 访问控制（ADR-0015：能力封装不是安全边界；POSIX 只做 0600 文件权限）。
- N4 不做连接级持久化（无 sqlite / memento / 落盘）。
- N5 不改 `framing` 语义：一条 server 的所有连接共用该 server 声明的 framing（同一端点的对端必须用同一种分帧）。
- N6 不加"每连接并发请求"以外的治理旋钮（不做速率限制/背压队列）。
- N7 **不暴露端点 `suffix`**（R2）：本期服务端只用不带 suffix 的稳定端点，`suffix` 留给未来多实例场景。
- N8 不改清单声明面（Q2 = 方案 A，R15）：不新增 `mode`、不动 `manifest-reference.md`、不动 `scripts/validate-manifest.mjs` 与其差分门禁。

## 3. 需求表

| id  | 需求                                                                                                                                                                                                                                                                                                                                                                      | 来源                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| R1  | 新增 `api.ipc.listen(declaration)`：宿主以**服务端**身份 listen 一个 pipe 端点；`declaration.transport` 必须为 `'pipe'`（传 `'stdio'` → `invalid-declaration`，文案方向"服务端只能是 pipe"）；`declaration.id` 在该扩展的**统一通道命名空间**内唯一（与既有 client 通道同名 → `invalid-declaration`，沿用"通道 X 已打开"文案风格）；`framing` 语义不变，该 server 的所有连接共用它 | issue #43 要点 1；`src/main/ipc.ts:108-120`               |
| R2  | 服务端端点用**不带 `suffix`** 的稳定端点：`ipcEndpoint({ socketDir, extensionId, name })`（`socketDir = <userData>/ipc`）。`ipcEndpoint` 已支持 `suffix`（`src/main/ipcCore.ts:643-645,652-662`），**本期不在扩展 API 里暴露**，留给未来"同一扩展多实例服务端"；不带 suffix 才能让对端事先知道往哪连                                                                    | issue #43 要点 1；`src/main/ipcCore.ts:636-662`、`src/main/ipc.ts:56-58,177-182` |
| R3  | 通道关闭统一为 `api.ipc.close(name)`（**Q1 = 方案 A**），语义 = **按名字关闭该名字下的一切**：该名字是 client 通道则断开该通道，是 server 则关闭监听并断开它**全部**连接；两类都不存在时**静默成功**；**必须幂等**（重复调用无副作用、不抛错）                                                                                    | issue #43 要点 5；§6 决策记录·Q1                          |
| R4  | 每条被接受的连接逐条建立独立的 `JsonRpcChannel`（复用 `ipcCore`，**零协议改动**）；该连接上的对端请求转发到渲染进程时**带上 `connectionId`**；不同连接的请求-响应互不串包（沿用 `pendingReplies` + 不同 `requestId`）                                                                                                            | issue #43 要点 3/4；`src/main/ipc.ts:84-105`              |
| R5  | 新增 `api.ipc.onConnection(name, cb)` 与 `api.ipc.onDisconnect(name, cb)`；回调签名按 Q1 定为**数字连接 ID**：`onConnection(name, cb: (connectionId: number) => void)`、`onDisconnect(name, cb: (connectionId: number, err: { code: string; message: string }) => void)`；**宿主不自动重连**该连接（本期只通知；对端要回来就重新连入 → 新连接、新 ID） | issue #43 要点 3；#44 R17                                 |
| R6  | 定向与广播（Q1 = 方案 A）：① `request(name, method, params, opts?)` 的 `opts` 增 `connectionId?: number`；② `notify(name, method, params, opts?)` 同样增 `connectionId?`；③ 新增 `broadcast(name, method, params)`。**缺省规则（必须明确、可测）**：server 名字下 `request`/`notify` **省略** `connectionId` → 立即 `invalid-declaration`（文案方向"服务端通道必须指定 connectionId，或用 broadcast"）——服务端没有"唯一对端"，静默挑一条等于误投；反之 **client 通道**传 `connectionId` → 同样 `invalid-declaration`（客户端通道没有连接 ID 命名空间）；定向到**已断开/不存在**的 `connectionId` → `not-connected` | issue #43 API 草案；§6 决策记录·Q1 与"缺省定向规则"        |
| R7  | 连接 ID 为**单调递增的 `number`**：主进程内**全局**计数器，从 `1` 起、分配即定、**永不复用**（server 关闭后 ID 不回收，重新 listen 的新连接只会拿到更大的 ID）；ID 在 `(扩展id, 通道名, connectionId)` 三元组内解释，可直接打印进日志；**不复用**因此同时覆盖"同名 server 重建"与"连接重连"两种情形                                                                                          | §6 决策记录·Q1（连接 ID 不复用）与"进程内全局"             |
| R8  | 新增 `MAX_CONNECTIONS_PER_SERVER = 16`（与 `MAX_CHANNELS_PER_EXTENSION = 4` 同处 `src/main/ipc.ts` 定义、同风格）。第 17 条连接的处理：**先向该套接字写一条 JSON-RPC 错误响应帧**（`{jsonrpc:'2.0', id:null, error:{code: -32603, message:'[too-many-connections] …'}}`，复用既有整数码常量、不新增线上码），随后关闭该套接字；**不触发** `onConnection` / `onDisconnect`（该连接从未被接受）；已建立的 16 条**不受任何影响**                                                                   | issue #43 要点 4；`src/main/ipcCore.ts:247-249,574-578`   |
| R9  | 新增稳定错误码 `too-many-connections` 到 `IpcErrorCode` 闭集（11 → 12），并同步 `src/api/types.ts` 的错误码注释、api-reference 错误码表、ADR-0016 不变量清单                                                                                                                                                                                                                    | issue #43 要点 4；`src/main/ipcCore.ts:32-44`             |
| R10 | POSIX 专属：listen 前探测并清理上次崩溃残留的 `.sock`——先 `net.createConnection` 试连：**连上**说明有活着的服务端 → 报 `connect-failed`（文案含"端点已被占用"）且**不删除**该文件；**连不上**才 `fs.unlink` 后重新 listen；listen 成功后 `fs.chmod(endpoint, 0o600)`                                                                                                                | issue #43 要点 2                                          |
| R11 | Windows 专属：命名管道在内核命名空间、无落盘文件 → **不做**陈旧文件清理、**不做** chmod；该平台差异写进 api-reference。平台分叉抽成纯函数（`platform` 注入），两平台分支都要单测（先例 `src/main/ipcCore.ts:637-639`）                                                                                                                                                            | issue #43 要点 2                                          |
| R12 | 广播语义（Q1 定为签名 `broadcast(name, method, params)`）：**通知语义**（JSON-RPC notification，**不收集回包**，返回 `Promise<void>`）——签名里没有回包收集位，要定向请求请用 `request(name, …, { connectionId })`；向**当前所有已连接**对端各发一次；对已断开连接跳过、不报错；**无连接时静默成功**（不报 `not-connected`）；单条连接写失败按该连接断开处理（触发 `onDisconnect`）而 `broadcast` 本身不抛错；名字存在但是 **client 通道** → `invalid-declaration`；名字**不存在** → `not-connected`（沿用 `requireChannel` 既有语义） | issue #43 要点 3；§6 决策记录·"broadcast 通知语义"        |
| R13 | 生命周期：`closeExtensionIpc(extId)` 关闭该扩展的**全部 server**（并释放端点）与全部连接，与既有通道走**同一函数、同一时机**（扩展停用/卸载/重载、退出清理，F9）；单名字关闭由 R3 的 `close(name)` 覆盖                                                                                                                                                                          | issue #43 要点 5；`src/main/extensionCleanup.ts:13,23-29`、`src/main/ipc.ts:226-232` |
| R14 | 主进程 → 渲染进程 `IpcEvent` 新增两种成员：`{ extId, name, type:'connection', connectionId }` 与 `{ extId, name, type:'disconnect', connectionId, code, message }`；既有 4 种成员形状**一字不改**（向后兼容）                                                                                                                                                                   | `src/shared/types.ts:471-483`、`src/main/ipc.ts:60-65`    |
| R15 | **清单声明面不改（Q2 = 方案 A）**：`contributes.ipcChannels` 的形状与校验**一字不动**，不新增 `mode`（`mode` 在此方案里**根本不存在**——`listen()` 是独立方法，不需要清单里的角色位）；`src/renderer/src/core/manifest.ts` 不改、`skills/obox-ext-dev/scripts/validate-manifest.mjs` 与其差分门禁不改、`manifest-reference.md` 不改。**静默行为必须明写并锁死**：清单里若写了 `mode` 这类未知键，按既有行为**不报错也不生效**（`validateIpcDeclaration` 逐键白名单读取、只组装已知字段），要求**加一条用例锁死**该行为，防止将来误以为"清单里写 `mode` 会起服务端" | Q2 结论；`src/shared/ipcDeclaration.ts:54-103`；`src/renderer/src/core/manifest.ts:46-56` |
| R16 | 主进程桥新增 `ipc:listen` / `ipc:broadcast`，`ipc:request` / `ipc:notify` 增 `connectionId` 参数，`ipc:close` 沿用并覆盖 server（R3）；preload 与 `window.api` 类型同步                                                                                                                                                                                                            | 实现必需（`src/preload/index.ts:33-40`、`src/shared/types.ts:354-380`） |
| R17 | 文档同步：api-reference（`api.ipc` 小节的服务端/多连接用法 + 限额表 + 错误码表 + Windows/POSIX 平台差异）、troubleshooting（端点被占用 / POSIX 陈旧 `.sock` / 权限 / 连接超限）、ADR-0016（把本项从「本期明确不做」移入「已做」并记不变量）；**manifest-reference 不改**（Q2 = A）                                                                                                    | issue #43 验收；`AGENTS.md` 持续更新要求                  |
| R18 | **连接级在途请求与断连规则（与 #44 必须一致）**：某条连接断开的瞬间，该连接上**双向**的挂起请求（宿主发起的 `request` 与转发到渲染进程等待回包的对端请求）**立即以断因码失败**（`peer-crashed` / `protocol-error` 等），**绝不重放、绝不挂到后续新连接上**；该连接的 `onDisconnect(connectionId, err)` **恰好触发一次**；**同一 server 的其它连接完全不受影响**；新连入的连接拿到**新 `connectionId`**、其挂起表为空（旧 ID 已按 R7 永久退役）；宿主**不自动重连**服务端连接 | Q1（连接 ID 不复用）；#44 R5/R8 的服务端对应项              |
| R19 | 命名空间与额度：一条 server **占 1 条通道额度**（与 client 通道共用 `MAX_CHANNELS_PER_EXTENSION = 4` 与同一名字空间，R1/R3）；它的**连接不计入** 4 条上限，只计入 `MAX_CONNECTIONS_PER_SERVER = 16`；`api.ipc.channels()` 仍返回该扩展当前的**通道名集合**（含服务端名），语义与今天一致（只多不少；#44 R9 的"放弃后移除"只针对 client 通道）                                              | 本 spec 自定（消除"server 是否占额度""`channels()` 是否含 server"的歧义）；`src/main/ipc.ts:32-33,235-237` |

编号连续性：R1–R19，连续、无重号。

## 4. 交付物（逐文件）

| 文件                                                            | 动作                  | 内容                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ipcServer.ts`                                         | 新增                  | electron-free 服务端核心：`openPipeServerTransport({ endpoint, framing, maxConnections })` → 连接注册表（连接 ID 分配，R7）+ 逐连接 `JsonRpcChannel` + `broadcast` + `dispose`；POSIX 陈旧文件探测/清理 + `chmod 0600`（R10）；Windows 分支不清理不 chmod（R11）；超限拒绝帧（R8）；断连清理（R18） |
| `src/main/ipcTransport.ts`                                      | 修改                  | 新增 `openPipeServerTransport`（`net.createServer` + `'connection'`）；`IpcTransportHandles` 形状**不变**（server 内部对每条连接生成一份），或新增 `IpcServerHandles` 类型——二者都能满足 R4/R18，**设计阶段定**                                  |
| `src/main/ipcCore.ts`                                           | 修改                  | `IpcErrorCode` 增 `too-many-connections`（R9）；`ipcEndpoint` **不动**（`suffix` 已支持、本期不暴露，R2）                                                                                                                                    |
| `src/main/ipc.ts`                                               | 修改                  | `servers` 注册表 + `MAX_CONNECTIONS_PER_SERVER`（R8）；统一名字空间与 1 条额度（R19）；`listenExtensionServer` / `closeExtensionServer` / `broadcastExtensionChannel` / `requestChannel(…, connectionId)`；`ipc:listen` / `ipc:broadcast` / `ipc:close`（统一）/ `ipc:request`、`ipc:notify` 增参；`closeExtensionIpc` 一并关 server（R13）；`connection` / `disconnect` 广播（R14）；连接级断连清理（R18） |
| `src/shared/types.ts`                                           | 修改                  | `window.api` 增 `ipcListen` / `ipcBroadcast`（`ipcRequest` / `ipcNotify` 增 `connectionId`）；`IpcEvent` 增 `connection` / `disconnect` 两种成员（R14）；`IpcChannelDeclaration` **不改**（Q2 = A：不加 `mode`）                                  |
| `src/preload/index.ts`                                          | 修改                  | 增 `ipcListen` / `ipcBroadcast`，`ipcRequest` / `ipcNotify` 透传 `connectionId`                                                                                                                                                            |
| `src/api/types.ts`                                              | 修改                  | `ipc` 表面增 `listen` / `onConnection` / `onDisconnect` / `broadcast`；`request` / `notify` 的 `opts` 增 `connectionId`；错误码注释补 `too-many-connections`                                                                                 |
| `src/renderer/src/core/host.ts`                                 | 修改                  | `buildIpcApi`：统一名字空间（server 与 client 同表）；`connection` / `disconnect` 事件分发（按 `name` + `connectionId`）；`request` / `notify` 透传 `connectionId`；`close(name)` 统一语义（R3）                                                |
| `src/shared/ipcDeclaration.ts`                                  | **不改**              | Q2 = A：清单与运行时声明的形状都不新增键（`mode` 不存在）（R15）                                                                                                                                                                          |
| `src/renderer/src/core/manifest.ts`                             | **不改**              | 同上（清单校验面一字不动）（R15）                                                                                                                                                                                                        |
| `test/ipc-server.test.ts`                                       | 新增                  | 真实 socket 的服务端测试（V1–V9、V13、V14、V16、V17）                                                                                                                                                                                    |
| `test/ipc-declaration.test.ts`                                  | 修改                  | **只加**静默忽略的锁死用例：清单形状带 `mode` 不报错、且 `validateIpcDeclaration` 返回的声明里不含 `mode`（V15）                                                                                                                            |
| `test/manifest.test.ts`                                         | 修改                  | 静默忽略锁死用例的清单侧：`contributes.ipcChannels` 项带 `mode` 时清单**仍然有效**（V15）。**不新增/不改动** `test/manifest-script-parity.test.ts` 的 fixture（不动脚本差分门禁）                                                             |
| `skills/obox-ext-dev/references/api-reference.md`               | 修改                  | 新增「服务端 / 多连接」用法与限额、错误码、平台差异（R17）                                                                                                                                                                                |
| `skills/obox-ext-dev/references/troubleshooting.md`             | 修改                  | 新增条目：端点被占用 / POSIX 陈旧 `.sock` / 权限 / 连接超限                                                                                                                                                                                |
| `skills/obox-ext-dev/references/manifest-reference.md`          | **不改**              | Q2 = A（清单有效形状无变化）（R15/R17）                                                                                                                                                                                                   |
| `docs/adr/0016-ipc-transport-and-protocol.md`                   | 修改（**不新开 ADR**） | 把「本期明确不做」里的"pipe 服务端 / 多客户端"移入「已做」；补服务端决策点与不变量（新错误码、连接 ID 单调不复用、在途请求不重放、平台差异）。**修订既有 ADR 而非新开**：本项是 0016 自己预留的后续项（`:20-25`），不属于"难以逆转 / 无背景者会觉得奇怪 / 存在真实取舍"的新决策                                                                                                    |
| `README.md`                                                     | 修改                  | `src/main/` 目录树补一行 `ipcServer.ts`（`AGENTS.md` README 更新要求：目录结构变化）；概览级能力描述默认只改一行                                                                                                                                     |
| `tmp/spec/extension-ipc-pipe-server-design.md`                  | 新增（**本 spec 确认后**） | 阶段四设计文档；本阶段不写（`workflow.md:66`：确认前不许写设计文档）                                                                                                                                                                        |

**明确不改**：`apiVersion`（保持 `1`，`package.json:4`；ADR-0010 决策 4：纯新增不递增）、`scripts/validate-manifest.mjs` 与其差分门禁、`manifest-reference.md`、清单校验面。

## 5. 验收标准（可执行）

先决：`npm ci` 已完成，仓库在 feature 分支。所有 `npx vitest` 命令的**期望退出码均为 0**（除明确标注的失败断言外，失败路径都在用例内部断言）。

| #   | 场景                                                              | 命令 / 操作                                                                              | 期望                                                                                                                                                     |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | 正常路径：服务端 listen + 多客户端连入 + **定向**请求               | `npx vitest run test/ipc-server.test.ts -t "多客户端"`                                     | 退出码 0；两个真实客户端各自 `request(name, …, { connectionId })` 拿到各自结果（连接级隔离、不串包）；每个连接触发一次 `onConnection`                        |
| V2  | 广播                                                              | `npx vitest run test/ipc-server.test.ts -t "广播"`                                         | 退出码 0；两个客户端都收到同一条**通知**（method/params 一致）、`broadcast` 正常 resolve；无连接时 `broadcast` **静默成功**（不抛 `not-connected`）            |
| V3  | 并发多连接（≥4 个客户端同时连）                                     | `npx vitest run test/ipc-server.test.ts -t "并发"`                                         | 退出码 0；各连接请求互不干扰；`onConnection` 回调次数 = 连接数                                                                                            |
| V4  | 单连接断开不影响其它连接                                            | `npx vitest run test/ipc-server.test.ts -t "单连接断开"`                                   | 退出码 0；被断开那条触发**恰好一次** `onDisconnect(connectionId, …)`，其余连接后续 `request` 仍成功                                                        |
| V5  | 失败：端点被占用（POSIX 与 Windows 各一条）                          | `npx vitest run test/ipc-server.test.ts -t "端点被占用"`                                   | 退出码 0；第二次 `listen` 抛 `connect-failed`，文案含"已被占用"；**且不删除活着的 `.sock`**（POSIX）；Windows 侧为同名命名管道占用 → 同样 `connect-failed`  |
| V6  | POSIX 陈旧 `.sock` 清理 + 权限                                      | `npx vitest run test/ipc-server.test.ts -t "陈旧"`                                         | 退出码 0；先 `fs.writeFile('…sock')` 造残留 → `listen` 成功；`fs.stat` 的 mode 为 `0o600`（`process.platform === 'win32'` 时该用例 skip）                    |
| V7  | 超限：第 17 个连接被拒                                              | `npx vitest run test/ipc-server.test.ts -t "连接数上限"`                                   | 退出码 0；第 17 条收到 JSON-RPC 错误帧（`error.message` 含 `[too-many-connections]`）、随后套接字关闭、**不触发** `onConnection`；已存在的 16 条不受影响        |
| V8  | 扩展停用即断开全部连接                                              | `npx vitest run test/ipc-server.test.ts -t "closeExtensionIpc"`                            | 退出码 0；调用 `closeExtensionIpc(extId)` 后所有客户端 socket 收到 `close`；端点不再可连                                                                  |
| V9  | 对端崩溃/非法帧不污染服务端                                          | `npx vitest run test/ipc-server.test.ts -t "对端崩溃\|非法帧"`                              | 退出码 0；该连接以 `peer-crashed` / `protocol-error` 关闭并触发一次 `onDisconnect`；server 仍可接受新连接（listen 不退出）、其它连接不受影响                  |
| V10 | 回归：既有单客户端行为不变（含清单声明路径）                          | `npm run typecheck` + `npm run lint` + `npm test`                                          | 三条全通过（退出码 0）；`test/ipc-*.test.ts` 既有用例无改动通过；`test/manifest*.test.ts` 通过                                                            |
| V11 | 回归：真实扩展的 pipe 客户端仍可用                                   | `npm run dev` → 装/启一个用 `api.ipc.connect({transport:'pipe'})` 的扩展（对端脚本可复用 `test/ipc-transport.test.ts:84-128` 的 `createServer`/`endpointFor`/`listen` 工具） | 请求往返成功，`channels()` 仍返回该通道名；无新增告警                                                                                                     |
| V12 | 文档可核对                                                          | 人工：api-reference / troubleshooting / `docs/adr/0016-*.md` 三处均含本次改动               | 文档描述了 `listen`、连接 ID、`too-many-connections`、平台差异；ADR-0016 不再把"pipe 服务端/多客户端"列为"不做"；**manifest-reference 不含本次改动**（Q2 = A）  |
| V13 | 超时                                                                | `npx vitest run test/ipc-server.test.ts -t "超时"`                                         | 退出码 0；服务端连接上 `request` 在对端不回包时以 `timeout` 失败（默认 30s 口径不变）；该连接与其它连接此后仍可用                                              |
| V14 | 失败：`invalid-declaration` 三例                                    | `npx vitest run test/ipc-server.test.ts -t "invalid-declaration"`                          | 退出码 0；① `listen({transport:'stdio'})` 抛 `invalid-declaration`；② server 名字下 `request(name, m, p)` 省略 `connectionId` → `invalid-declaration`；③ client 通道上带 `connectionId` → `invalid-declaration` |
| V15 | 清单静默行为锁死（Q2 = A）                                           | `npx vitest run test/ipc-declaration.test.ts test/manifest.test.ts -t "未知键\|mode"`      | 退出码 0；含 `"mode": "server"` 的清单项**清单仍然有效**（无 error），且 `validateIpcDeclaration` 返回的声明里**不含** `mode`；不产生任何服务端行为（无监听、无 `onConnection`） |
| V16 | 服务端连接在途请求不重放（R18 锁死，对应 #44 R5）                     | `npx vitest run test/ipc-server.test.ts -t "在途请求"`                                     | 退出码 0；断开瞬间挂起请求以断因码 reject；对端重连后**没有**收到重复请求（对端按 method 计数 = 1）；新连接是**新** `connectionId`、其挂起表为空                |
| V17 | 连接 ID 单调且不复用（R7 锁死）                                      | `npx vitest run test/ipc-server.test.ts -t "连接 ID"`                                      | 退出码 0；关闭 server 后重新 `listen` 同名端点，新连入连接拿到的 ID **严格大于**此前分配过的所有 ID；旧 ID 不再出现在任何 `onConnection` / 定向调用中            |

真机验证（`npm run dev`）与 V11 属**必须**项：`workflow.md:78` 要求真机运行，未做实机验证的结论必须标注「未验证」。

## 6. 决策记录

决策日期：**2026-10-12**。依据：用户拍板（阶段三关卡，`workflow.md:66`）；本文其余"spec 自定"项均在条目标注，属实现前可复核的推断，不属用户决策。

### Q1（#43 服务端表面）＝ 方案 A：连接 ID 化

- **结论**：`listen(declaration)` / `onConnection(name, cb)` / `onDisconnect(name, cb)` / `broadcast(name, method, params)`；`request`/`notify` 增 `opts.connectionId` 定向；连接 ID 为**单调递增 `number`（从 1 起、不复用）**；`MAX_CONNECTIONS_PER_SERVER = 16`；新增错误码 `too-many-connections`；端点 `suffix` **本期不暴露**（服务端用不带 suffix 的稳定端点，`ipcEndpoint()` 的 `suffix` 留给未来多实例场景）；`api.ipc.close(name)` 语义 = **按名字关闭该名字下的一切**（server 与 client 通道统一）。落点：R1–R9、R12、R19；事件面 R14。
- **被否决方案 B（连接对象句柄）**：`onConnection` 交一个带 `request/notify/close` 的 `Connection` 对象、`api.ipc.request` 只对单连接通道有效。**不选的理由（一句）**：把连接做成有方法的长生命周期对象，就必须同时回答对象失效、跨重连身份、监听清理三类问题，而本期只需要"能区分、能定向、能广播"，用一个不可变数字 ID 就能满足，代价最小。

### Q2（清单声明面）＝ 方案 A：不改清单

- **结论**：`mode` / `autoReconnect` 只出现在**运行时**声明对象里；`contributes.ipcChannels` 里若写了这两个键，按既有行为**不报错也不生效**（`validateIpcDeclaration` 逐键白名单读取、未知键静默忽略，`src/shared/ipcDeclaration.ts:54-103`），spec **明写这一静默行为**并要求**加一条用例锁死**（防将来误以为清单生效）；**不得**改 `manifest.ts` 的校验面、**不得**动 `manifest-reference.md`、**不得**动脚本差分门禁。落点：R15、V15；`mode` 在本方案里根本不存在（`listen()` 独立成方法）。
- **被否决方案 B（清单加 `mode: 'client' | 'server'`）**：**不选的理由（一句）**：它把"角色"塞进清单校验面，还让新扩展在旧宿主上被静默降级（旧宿主把 `mode:'server'` 当未知键忽略，于是去拨号而不是 listen），而收益只是"少写一次 `listen()`"。
- **交叉引用**：#44 的 `autoReconnect` 适用同一结论，但**理由不同且更强**——该键在第 #44 期会成为校验器的**已知键**，所以"清单里写它不生效"必须靠 R18 的白名单归一化**构造保证**，不能靠"没人读它"的巧合（#44 F12/R18）。

### Q3（stdio 范围）＝ 方案 A：仅 pipe

- **结论**：#43 的服务端抽象**只覆盖 pipe**（`listen` 只接受 `'pipe'`，传 `'stdio'` → `invalid-declaration`，R1）；与 #44 对齐，`transport: 'stdio'` + `autoReconnect` 也直接 `invalid-declaration`（#44 R12，文案方向"stdio 场景请自行 `connect()` 或改用 pipe"）；stdio 仍可在 `onClose` 里自行退避重连（文档一句话点到即可）。落点：R1、N1/N2；#44 R3/R12。
- **被否决方案 B（stdio 纳入多连接/reconnect 抽象）**：**不选的理由（一句）**：stdio 是"宿主拉起一个子进程"的 1:1 关系，重连等于重新 spawn，需要额外定义 spawn 幂等、旧进程残留与 Windows 文件占用重试，属独立设计（ADR-0016:23 未覆盖），塞进本次会把范围撑成两个 issue。

### Q1–Q3 之外的收敛（本 spec 自定，非用户决策；实现前可复核）

| #   | 收敛点                                                                                                    | 理由一句                                                                                                       | 落点            |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------- |
| S1  | server 名字下省略 `connectionId` 的 `request`/`notify` → `invalid-declaration`；client 通道传 `connectionId` → 同样报错 | 不留"隐式挑一条连接"的模糊语义，误投比报错危险得多                                                              | R6              |
| S2  | 连接 ID 用**进程内全局**计数器（而非每 server 一个）                                                       | 彻底消除"旧 ID 撞上新连接"的误投；同名 server 重建后 ID 也不复用                                                | R7              |
| S3  | `broadcast` 定为**通知语义**、返回 `Promise<void>`                                                        | 用户拍板的签名 `broadcast(name, method, params)` 没有回包收集位，硬做请求-响应就得再发明一套结果聚合结构        | R12             |
| S4  | 连接断连时双向挂起请求立即失败、不重放（服务端侧）                                                          | 与 #44 R5 的"在途请求不重放"同一规则，避免服务端侧留下"重连后补发"的暗坑                                        | R18             |
| S5  | server 占 1 条通道额度、连接只计入连接上限；`channels()` 含服务端名                                       | 统一命名空间是 `close(name)` 统一语义的前提；不写清就会被误读成"server 是否吃 4 条额度"                          | R19             |
| S6  | 交付面：**不改 `apiVersion`**；**修订 ADR-0016 而非新开 ADR**；README 补一行目录树                          | ADR-0010 决策 4（纯新增不递增）；本项是 0016 自己预留的后续项、不构成新决策；`AGENTS.md` 要求目录结构变化同步 README | §4 交付物       |
| S7  | 超限拒绝用既有整数码 `-32603`（`RPC_INTERNAL_ERROR`）+ `message` 带稳定码                                  | 不新增线上整数码，扩展按字符串稳定码分支即可                                                                    | R8、`src/main/ipcCore.ts:247-249` |

## 7. 风险与未决项

| #   | 风险 / 未决项                                                                                                            | 处置                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| K1  | 统一命名空间后，既有扩展若已把某名字用作 client 通道，再 `listen` 同名会 `invalid-declaration`（运行时才暴露）                | 属可诊断的显式失败；api-reference 写明"名字在扩展内唯一（server 与 client 共用）"，与 R19 一致                                  |
| K2  | 清单静默行为是"看起来生效、实际不生效"（写了 `mode:'server'` 既不报错也不起服务端）                                          | 文档明写 + 用例锁死（R15/V15）；#44 的 `autoReconnect` 更危险（届时它是校验器已知键），由 #44 R18 的归一化堵住                  |
| K3  | POSIX 陈旧 `.sock` 的"试连探测"有竞态（探测与 unlink 之间可能有他人 listen）                                                | 探测→unlink→listen 失败时把 `EADDRINUSE` 映射为 `connect-failed`（重试一次，仍失败即报错），并在测试里覆盖该分支（V5/V6）        |
| K4  | 广播给大量连接时的写背压（`socket.write` 返回 false）                                                                       | 本期不做背压队列（N6）；单条消息上限 8MB 与 `message-too-large` 仍生效，写失败按该连接断开处理（R12）并记日志                    |
| K5  | Windows 无法用 `fs.chmod`、也无法用"文件存在"判断陈旧端点，导致探测逻辑分叉                                                  | 平台分叉写进 `ipcServer.ts` 的纯函数（`platform` 参数注入），并像 `ipcEndpoint` 一样单测覆盖两平台（R11）                       |
| K6  | 新错误码 `too-many-connections` 属**对外契约新增**，扩展若按错误码白名单分支会漏判                                            | 错误码属**新增**而非修改，遵循 ADR-0016 不变量（`docs/adr/0016-ipc-transport-and-protocol.md:31`）；文档同步列出（R17）          |
| K7  | 服务端监听相当于"任何同机进程都能连上"（POSIX 0600 只能挡其它用户）                                                          | 在 ADR-0016 与 api-reference 明写：能力封装不是安全边界（ADR-0015），不做对端身份校验（N3）                                     |
