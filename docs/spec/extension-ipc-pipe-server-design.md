# 设计文档：扩展 IPC · pipe 服务端（宿主 listen 接受多连接）— issue #43

| 项 | 值 |
| --- | --- |
| 状态 | **待实现**（spec 已定稿：`tmp/spec/extension-ipc-pipe-server.md`，R1–R19 / V1–V17 / Q1=A、Q2=A、Q3=A） |
| 前置 | 本设计逐条覆盖 spec 的 R1–R19 与 V1–V17；覆盖情况见 §1 决策摘要与 §8 测试计划 |
| 范围 | ① 宿主（`src/main/**`、`src/shared/**`、`src/preload/**`、`src/api/**`、`src/renderer/src/core/host.ts`）；② 测试（`test/ipc-server.test.ts` 新增、`test/helpers/ipcPeers.ts` 新增、两个既有测试文件各加锁死用例）；③ 文档（api-reference / troubleshooting / ADR-0016 / README） |
| 事实基准 | master `722cebc`（本文所有 `文件:行` 均已逐条读码核对，见 §2；spec 的 5 处引用修正已一并核对） |
| 配对文档 | `tmp/spec/extension-ipc-reconnect-design.md`（issue #44，**串行在其后**） |
| 交付面 | **不改** `apiVersion`（`package.json:4`；ADR-0010 决策 4）、`scripts/validate-manifest.mjs` 与其差分门禁、`manifest-reference.md`、`src/renderer/src/core/manifest.ts`、`src/shared/ipcDeclaration.ts` |
| 归档 | 完成后 spec 与本设计 → 仓库 `docs/spec/`；ADR 修订 → `docs/adr/0016-ipc-transport-and-protocol.md`（**修订，不新开**） |

---

## 0. 建议实现顺序与理由（文首）

**顺序：#43 单独一个 PR 先落地；#44 从 #43 合并后的 master 再拉分支。串行，不并行。**

理由（spec 已给三条，此处补设计层面的四条，共七条）：

| # | 理由 | 性质 |
| --- | --- | --- |
| 1 | 两份 spec 共同改 `src/main/ipc.ts`、`src/shared/types.ts`、`src/api/types.ts`、`src/renderer/src/core/host.ts`，串行避免同文件写冲突与设计返工 | spec 文首 |
| 2 | #44 的"通道 vs 连接"边界、`channels()` 语义、`close(name)` 统一语义必须由 #43 先定死 | spec 文首 |
| 3 | #43 不引入 `autoReconnect`，可独立验证；对既有扩展行为逐字节不变 | spec 文首 |
| 4 | **#44 R18 的归一化点（`resolveIpcChannelDeclaration`）与运行时校验入口，在 #43 落地后才有稳定形状**：#43 必须先把 `src/main/ipc.ts:152` 的校验调用保持为**单独一行**（本设计 §3.4 明写），#44 才只需改这一行 | 设计补充 |
| 5 | **测试基建先由 #43 建**：`test/helpers/ipcPeers.ts`（真实命名管道/UDS 对端工具）与"electron mock + `ipcMain.handle` 捕获"两个缝隙都在 #43 落地；#44 直接复用，避免同一套 40 行脚手架写两遍 | 设计补充 |
| 6 | **ADR-0016 同一份文件被两次修订**，串行可让 #44 在 #43 已改好的「已做 / 不变量」小节上追加，避免两边都重写同一段 | 设计补充 |
| 7 | `src/main/ipc.ts` 的 `OpenChannel` 类型是**跨两份改动的共享结构**：#43 定 `{kind:'client'|'server'}` 判别联合，#44 只在 client 分支上加 `state` 与 `reconnect` 字段（形状见两份 §4.1），先定后扩不会返工 | 设计补充 |

**#43 内部实现顺序**（每步一个可提交状态，步骤表见 §14）。

---

## 1. 决策摘要（spec R1–R19 → 设计落点）

| spec 需求 | 落点（本文档章节） | 主要改动文件 |
| --- | --- | --- |
| R1 `listen(declaration)`，只接受 `pipe`，名字在统一命名空间内唯一 | §3.1、§3.3、§4.1、§5.3① | `src/api/types.ts`、`src/main/ipc.ts`、`src/renderer/src/core/host.ts` |
| R2 端点不带 `suffix`（`ipcEndpoint({socketDir,extensionId,name})`） | §6.1 | `src/main/ipc.ts`（调用处）、`src/main/ipcServer.ts` |
| R3 `close(name)` = 按名字关闭该名字下的一切；幂等；不存在静默成功 | §3.3、§4.1、§4.5 | `src/main/ipc.ts`、`src/renderer/src/core/host.ts` |
| R4 每条连接独立 `JsonRpcChannel`；转发带 `connectionId`；互不串包 | §3.4、§4.2、§4.3、§4.7 | `src/main/ipc.ts`、`src/main/ipcServer.ts`、`src/shared/types.ts` |
| R5 `onConnection` / `onDisconnect`（数字连接 ID；宿主不自动重连） | §3.1、§3.2、§4.7 | `src/api/types.ts`、`src/shared/types.ts`、`src/renderer/src/core/host.ts` |
| R6 定向与广播的缺省规则；`invalid-declaration` / `not-connected` | §3.1、§4.3、§5.3②③ | `src/main/ipc.ts`、`src/api/types.ts` |
| R7 连接 ID 单调递增、进程内全局、永不复用 | §4.4 | `src/main/ipcServer.ts` |
| R8 `MAX_CONNECTIONS_PER_SERVER = 16`；第 17 条回错误帧后关闭；不发事件 | §3.3、§4.2、§5.1、§5.2 | `src/main/ipc.ts`、`src/main/ipcServer.ts` |
| R9 `too-many-connections` 进 `IpcErrorCode` 闭集并同步文档 | §5.1、§10、§11 | `src/main/ipcCore.ts`、`src/api/types.ts`、api-reference、ADR-0016 |
| R10 POSIX 陈旧 `.sock` 探测/清理 + `chmod 0600` | §6.2 | `src/main/ipcServer.ts` |
| R11 Windows 不探测不 chmod；平台分叉为纯函数（`platform` 注入）+ 两侧单测 | §6.1、§6.2、§8 | `src/main/ipcServer.ts`、`test/ipc-server.test.ts` |
| R12 `broadcast(name, method, params)` 通知语义；无连接静默成功；client 名字 → `invalid-declaration`；不存在 → `not-connected` | §3.1、§3.3、§4.3 | `src/main/ipc.ts`、`src/main/ipcServer.ts`、`src/api/types.ts` |
| R13 `closeExtensionIpc` 一并关 server，同一函数同一时机 | §4.1、§6.4 | `src/main/ipc.ts`（`extensionCleanup.ts` **不改**） |
| R14 `IpcEvent` 增 `connection` / `disconnect`（既有 4 种不变） | §3.2、§4.7 | `src/shared/types.ts`、`src/main/ipc.ts`、`src/renderer/src/core/host.ts` |
| R15 清单声明面一字不动 + 静默行为锁死用例 | §2.4、§8（V15）、§9 | 无生产代码改动；`test/ipc-declaration.test.ts`、`test/manifest.test.ts` |
| R16 主进程桥新增 `ipc:listen` / `ipc:broadcast`；`ipc:request`/`ipc:notify` 增 `connectionId`；preload 同步 | §3.2 | `src/main/ipc.ts`、`src/shared/types.ts`、`src/preload/index.ts` |
| R17 文档同步（api-reference / troubleshooting / ADR-0016；manifest-reference 不改） | §10、§11 | 三个文档 |
| R18 断连瞬间双向挂起请求以断因码失败、绝不重放；`onDisconnect` 恰好一次；其它连接不受影响 | §4.3、§4.5、§8（V16） | `src/main/ipc.ts`、`src/main/ipcServer.ts` |
| R19 server 占 1 条通道额度、连接只计 16；`channels()` 含服务端名 | §4.6 | `src/main/ipc.ts`（**`channels()` 无需改代码**，天然成立） |
| V1–V17 | §8 逐条映射到测试文件与用例名 | `test/ipc-server.test.ts` 等 |
| 真机 V11/V12 | §13 | — |
| 风险 | §12 | — |

**未被第 1 节直接覆盖、但 spec 明确要求的落点**：N1–N8（明确不做）在设计中表现为"不存在的东西"——本文档 **不引入** TCP、不引入服务端连接自动重连（§12 R-5 明写）、不做对端鉴权、不做连接持久化、不改 `framing` 语义、不加治理旋钮、不暴露 `suffix`、不动清单面。§9 的"明确不改"清单逐条列出。

---

## 2. 事实核对（以代码为准；含 spec 未列出的事实与发现的偏差）

### 2.1 spec 事实表逐条核对结果

| spec 事实 | 引用 | 核对结论 |
| --- | --- | --- |
| F1 `api.ipc` 只有按通道名寻址的 9 个成员 | `src/api/types.ts:394-418`；实现 `src/renderer/src/core/host.ts:1152-1259` | ✅ 一致（`connect/close/channels/request/notify/onRequest/onNotification/onClose/onStderr`，共 9 个） |
| F2 声明形状 `{id,transport,program?,args?,framing?}`；`pipe` 禁 `program/args` | `src/shared/ipcDeclaration.ts:17-28`、`:99-101` | ✅ 一致 |
| F3 端点命名 | `src/main/ipcCore.ts:652-662`、`src/main/ipc.ts:56-58`、`:177-182` | ✅ 一致（`ipcSocketDir()` 在 `:56-58`；pipe 分支 `:177-182`） |
| F4 只有 `net.createConnection`，无 `createServer`，POSIX 无 chmod/清理 | `src/main/ipcTransport.ts:185-233` | ✅ 一致（全文件无 `createServer`） |
| F5 每扩展 4 条通道；重名/超限错误码 | `src/main/ipc.ts:32-33`、`:107-120` | ✅ 一致（常量在 `:33`，`assertChannelSlot` 在 `:108-120`） |
| F6 错误码闭集 11 个，无 `too-many-connections` | `src/main/ipcCore.ts:32-44` | ✅ 一致（逐个数过：11 个） |
| F7 `ipc:event` 4 种事件、无 `connection`/`disconnect` | `src/shared/types.ts:471-483`、`src/main/ipc.ts:60-65`、`host.ts:1176-1206` | ✅ 一致 |
| F8 `forwardInboundRequest` + `pendingReplies` + `requestId`，30s，天然支持多路并发 | `src/main/ipc.ts:35`、`:84-105`、`:303-309` | ✅ 一致 |
| F9 唯一清理时机 `cleanupExtensionResources → closeExtensionIpc` | `src/main/extensionCleanup.ts:13,23-29`、`src/main/ipc.ts:226-232` | ✅ 一致（`:13` 是 import，`:28` 是调用） |
| F10 运行时与清单共用一套校验；清单里非法则清单无效 | `src/shared/ipcDeclaration.ts:54-137`、`src/renderer/src/core/manifest.ts:46-56` | ✅ 一致 |
| F11 测试先例：真实管道/UDS + 手工 `chmod 0600` | `test/ipc-transport.test.ts:84-128,214-247` | ✅ 一致（`createServer :85-115`、`endpointFor :117-121`、`listen :123-128`；`:226` 是 `chmod`） |
| F12 文档面位置 | `api-reference.md:597-659`、`manifest-reference.md:253-279` | ✅ 一致（api.ipc 小节 597–659；ipcChannels 小节 253–279） |
| F13 线上整数码与错误帧形状 | `src/main/ipcCore.ts:247-249`、`:574-578` | ✅ 一致。**补充事实**：`RPC_INVALID_REQUEST = -32600`（`:249`）全仓**声明但从未使用**（仅此一处出现），实际用到的只有 `-32601`（`:554`）与 `-32603`（`:561`） |
| F14 `apiVersion` 单源 `package.json:4`，纯新增不递增 | `package.json:4`、`docs/adr/0010-api-version.md:15` | ✅ 一致（`package.json:4` 即 `"apiVersion": 1`；`0010:15` 即决策 4） |

### 2.2 核对中发现的偏差（本文档予以改正）

| # | 偏差 | 落点 | 处置 |
| --- | --- | --- | --- |
| C1 | `api-reference.md:653` 写每扩展 4 条通道的常量在 `src/main/ipc.ts:27`，实际在 **`:33`** | `skills/obox-ext-dev/references/api-reference.md:653` | 本次文档同步（R17）时**顺手改正为 `src/main/ipc.ts:33`**；同一行的 `src/main/ipcCore.ts:27`（并发 64）、`:23`（8MB）、`:25`（30s）核对无误。**顺带发现的相邻漂移（本次不改，只记录）**：`api-reference.md:657` 与 `manifest-reference.md:277` 把 stdio 的 cwd 写成 `src/main/ipc.ts:153`／`main/ipc.ts:153-161`，实际的 cwd 赋值在 `src/main/ipc.ts:159`（`:153` 是 `assertChannelSlot` 的签名行）；`manifest-reference.md` 属"明确不改"（Q2=A），`api-reference.md:657` 属本次会碰的文件，可在同一行顺手对齐到 `:159`（**可选，不影响验收**） |
| C2 | spec §4 交付物把 `openPipeServerTransport` **同时**列在 `src/main/ipcServer.ts` 与 `src/main/ipcTransport.ts` 两行（spec:90-91） | spec 内部矛盾 | 由设计收敛：**函数落在 `src/main/ipcServer.ts`，`src/main/ipcTransport.ts` 本次不改**（§3.4、§9 给理由） |
| C3 | R14 要求"既有 4 种事件形状**一字不改**"与 R4 要求"转发时**带上 `connectionId`**"字面冲突 | spec R4 × R14 | 见 §2.3 与 §5.4 的【设计待定 D1】，给出推荐解法 |
| C4 | 扩展可见的声明类型有**三份副本**，spec 只提到两份 | `src/api/shared.ts:45-55`、`src/shared/types.ts:454-462`、`src/shared/ipcDeclaration.ts:17-28` | #43 三份**都不改**（Q2=A）；#44 需三份同步 `autoReconnect`，见 #44 设计 §3.4（该发现写入 #44 文档） |
| C5 | 仓库既有约定：**没有任何测试导入依赖 electron 的模块**（`test/**` 的 35 处 `src/` 导入全部指向 electron-free 模块） | 见 §2.4 | 决定 #43 的测试缝隙，见 §7 |

### 2.3 spec 的两处内部矛盾与处理原则

| # | 矛盾 | 处理原则 |
| --- | --- | --- |
| M1 | R4（转发带 `connectionId`）与 R14（既有 4 种成员"一字不改"） | **以"向后兼容"为意图**（R14 的括注就是"向后兼容"）：`request` 成员增**可选** `connectionId?: number`，client 通道产生的 `request` 事件与今天**逐字段一致**（该字段不出现）。判据：可选的**新增**字段不破坏任何既有消费者（`host.ts:1193-1198` 只读 `method/params/requestId`）。见 §5.4 D1 |
| M2 | spec §4 同一函数落在两个文件 | **以"状态内聚"为准**：`openPipeServerTransport` 必须持有连接注册表、连接 ID 计数器、超限计数与断连清理，这些状态不能被拆到两个文件；`ipcTransport.ts` 的职责是"一通道一传输"（`IpcTransportHandles`），服务端是"一传输多连接"，形状不同（§3.4 给出完整对比） |

### 2.4 仓库既有约定（决定测试缝隙与模块切分）

| # | 事实 | 证据 | 设计后果 |
| --- | --- | --- | --- |
| A1 | `npm run typecheck` **不包含 `test/**`**：`tsconfig.node.json` 只 include `electron.vite.config.* / src/main / src/preload / src/shared`，`tsconfig.web.json` 不含 `test` | `tsconfig.node.json`、`tsconfig.web.json` | 测试文件的类型错误只靠 `vitest` 运行期与 `eslint`（`eslint.config.mjs` 未忽略 `test/`）暴露 → 测试里的 `vi.mock` 工厂不需要满足 electron 的完整类型 |
| A2 | CI 只在 **windows-latest** 跑 `check`（typecheck / lint / test） | `.github/workflows/pr-check.yml:20,42-49` | POSIX 专属分支在 CI **不会被执行** → 平台差异必须靠"`platform` 注入的纯函数"覆盖（R11 的用意），真实 `.sock` 用例在两平台各自本地跑 |
| A3 | 所有 `test/**` 导入的 `src/main/*` 模块都是 electron-free 的（`ipcCore` / `ipcTransport` / `oixCore` / `pythonCore` / `pythonRun` / `sqliteCore` / `singleInstanceCore` / `hookBridge`） | 35 处导入逐条核对 | 新测试若直接 `import '../src/main/ipc'` 会打破该约定（`ipc.ts:10` 导入 electron）→ §7 的缝隙决策 |
| A4 | 定时器可注入的工厂式 electron-free 模块先例：`createHookBridge({send, setTimer, clearTimer, newRequestId})`，并把 `pendingCount()` 明确标为"诊断与测试用" | `src/main/hookBridge.ts:51-68,125-127` | 本设计的 `ipcServer.ts`（`log` 注入）、`ipc.ts` 的 `pendingForwardCount()`（诊断/测试）与 #44 的 `createReconnectController`（`sleep` 注入）都照此风格 |
| A5 | 主进程 → 共享的方向是既有约定（`ipcCore.ts:15-20` 从 `../shared/ipcDeclaration` 导入）；`shared/ipcDeclaration.ts` 目前**零 import**，必须保持可在渲染进程打包 | `src/main/ipcCore.ts:15-20`、`src/shared/ipcDeclaration.ts` 全文 | #44 的重连常量若被 `shared` 的校验器需要，必须定义在 `shared`（不能让 shared 反向 import `src/main/**`） |

---

## 3. 接口定义（可直接照写代码）

### 3.1 扩展可见面：`src/api/types.ts` 的 `ipc` 成员（替换现 `:394-418`）

```ts
/**
 * 与外部进程的**端口无关**双向 IPC（stdio / 命名管道 / Unix 域套接字，不使用 TCP 端口）。
 * 规格见 issue #40；pipe 服务端（多连接）见 issue #43。
 *
 * 通道分两类，**共用同一命名空间**（同一扩展内名字唯一）：
 * - **client 通道**（`connect`）：宿主作为拨号方，一对一；没有连接 ID。
 * - **server 通道**（`listen`）：宿主作为服务端接受**多条**连接；每条连接有一个
 *   进程内单调递增、**永不复用**的 `connectionId`。
 *
 * 稳定错误码：`invalid-declaration` / `connect-failed` / `not-connected` / `protocol-error` /
 * `timeout` / `cancelled` / `message-too-large` / `too-many-requests` / `too-many-channels` /
 * `too-many-connections` / `peer-crashed` / `channel-closed`。
 * 注意：本能力是**能力封装而非安全边界**（扩展与宿主同上下文，见 ADR-0015）。
 */
ipc: {
  /** 打开 client 通道（见 `IpcChannelDeclaration`） */
  connect(declaration: IpcChannelDeclaration | string): Promise<void>

  /**
   * 以**服务端**身份 listen 一个 pipe 端点（issue #43）：
   * - `declaration.transport` 必须是 `'pipe'`（传 `'stdio'` → `invalid-declaration`）；
   * - `declaration.id` 与既有 client 通道**共用命名空间**（重名 → `invalid-declaration`）；
   * - 端点**不带 suffix**：Windows `\\.\pipe\obox-<扩展id>-<通道名>`；
   *   POSIX `<userData>/ipc/obox-<扩展id>-<通道名>.sock`；
   * - 该 server 的**所有连接共用** `declaration.framing`；
   * - 最多接受 16 条连接，第 17 条由宿主回一条 JSON-RPC 错误帧后关闭（不触发任何事件）。
   */
  listen(declaration: IpcChannelDeclaration): Promise<void>

  /**
   * 关闭该名字下的**一切**（issue #43 R3）：
   * - 该名字是 client 通道 → 断开该通道；
   * - 该名字是 server → 停止监听并断开它**全部**连接；
   * - 两类都不存在 → **静默成功**；
   * - **幂等**（重复调用无副作用、不抛错）。
   */
  close(name: string): Promise<void>

  /** 当前通道名集合（**含** server 名；server 与 client 都在其中） */
  channels(): Promise<string[]>

  /**
   * 发请求并等响应；超时默认 30s，可逐请求覆盖。
   * - `name` 是 **server**：必须给 `opts.connectionId`，否则 `invalid-declaration`；
   *   指向已断开/不存在的连接 → `not-connected`；
   * - `name` 是 **client 通道**：不得给 `connectionId`（客户端通道没有连接 ID 命名空间）→ `invalid-declaration`。
   */
  request(
    name: string,
    method: string,
    params?: unknown,
    opts?: {
      /** 逐请求超时（毫秒；缺省 30s） */
      timeoutMs?: number
      /** 定向到 server 通道的某条连接（server 名字下必填） */
      connectionId?: number
    }
  ): Promise<unknown>

  /** 发通知（无应答）；`opts.connectionId` 的规则与 `request` 完全一致 */
  notify(
    name: string,
    method: string,
    params?: unknown,
    opts?: { connectionId?: number }
  ): Promise<void>

  /**
   * 向该 **server** 当前**全部已连接**对端各发**一条通知**（JSON-RPC notification，
   * **不收集回包**，因此返回 `Promise<void>`）：
   * - 要"定向请求"请用 `request(name, method, params, { connectionId })`；
   * - 已断开的连接**跳过**（不报错）；**无连接时静默成功**（不报 `not-connected`）；
   * - 单条连接写失败按**该连接断开**处理（触发 `onDisconnect`），`broadcast` 本身不抛错；
   * - `name` 存在但是 **client 通道** → `invalid-declaration`；`name` **不存在** → `not-connected`。
   */
  broadcast(name: string, method: string, params?: unknown): Promise<void>

  /** 处理**对端发来的请求**（双向）：返回值作为 JSON-RPC result 回给对端（client / server 通道都可用） */
  onRequest(name: string, handler: (method: string, params: unknown) => unknown): Disposable
  /** 订阅对端通知 */
  onNotification(name: string, cb: (method: string, params: unknown) => void): Disposable
  /** 订阅通道关闭（含对端崩溃）；每扩展主动 `close()` 与每次断连各触发一次 */
  onClose(name: string, cb: (err: { code: string; message: string }) => void): Disposable
  /** 订阅对端日志（stdio 的 stderr；pipe 传输没有独立日志流） */
  onStderr(name: string, cb: (text: string) => void): Disposable

  /**
   * 订阅 server 通道**接受了一条新连接**（issue #43 R5）：
   * `connectionId` = 进程内单调递增、**永不复用**的正整数；被超限拒绝的连接**不触发**。
   * 宿主**不自动重连**服务端连接：对端回来就是一次新连入、拿一个新 ID。
   */
  onConnection(name: string, cb: (connectionId: number) => void): Disposable

  /**
   * 订阅 server 通道上一条**已被接受的连接断开**（issue #43 R5/R18）：
   * - 每条连接**恰好触发一次**；`err.code` 为断因（`peer-crashed` / `protocol-error` /
   *   宿主关闭 server 或 `close()` 时为 `channel-closed`）；
   * - 断开瞬间该连接上的**双向**挂起请求立即以断因码失败，**绝不重放**；
   * - 同一 server 的其它连接不受影响。
   */
  onDisconnect(
    name: string,
    cb: (connectionId: number, err: { code: string; message: string }) => void
  ): Disposable
}
```

**类型一致性**：`IpcChannelDeclaration`（`src/api/shared.ts:45-55`）**本期不改**（Q2=A：不加 `mode`）；`Disposable` 形状照 `src/api/runtime.ts:58-60`。

### 3.2 渲染进程 ↔ 主进程契约

**`src/shared/types.ts`**（`MainApi`，现 `:354-380`）：

```ts
  /** listen 一个 pipe 端点（服务端；issue #43） */
  ipcListen(
    extId: string,
    declaration: IpcChannelDeclaration
  ): Promise<{ ok: boolean; code?: string; error?: string }>
  /** 关闭该名字下的 client 通道与 server（统一语义，幂等；不存在静默成功） */
  ipcClose(extId: string, name: string): Promise<void>
  /** 列出已打开的通道名（含 server 名） */
  ipcList(extId: string): Promise<string[]>
  /** 发请求并等响应；`connectionId` 仅对 server 名字有意义（见 api 层语义） */
  ipcRequest(
    extId: string,
    name: string,
    method: string,
    params?: unknown,
    timeoutMs?: number,
    connectionId?: number
  ): Promise<{ ok: boolean; result?: unknown; code?: string; error?: string }>
  /** 发通知（无应答） */
  ipcNotify(
    extId: string,
    name: string,
    method: string,
    params?: unknown,
    connectionId?: number
  ): Promise<{ ok: boolean; code?: string; error?: string }>
  /** 向 server 的全部连接各发一条**通知**（无回包） */
  ipcBroadcast(
    extId: string,
    name: string,
    method: string,
    params?: unknown
  ): Promise<{ ok: boolean; code?: string; error?: string }>
  /** 渲染进程里扩展处理器对"对端请求"的回包（不变） */
  ipcReply(requestId: string, outcome: IpcReplyOutcome): Promise<void>
```

位置选择（**设计决定**）：`connectionId` 作为**末位位置参数**而非 `opts` 对象——既有桥（`ipc:request` 5 个位置参数，`src/main/ipc.ts:262-282`）就是位置协议，追加末位参数的文件改动最小，也与 R16"`ipc:request`/`ipc:notify` **增** `connectionId` 参数"的措辞一致。

**`IpcEvent` 联合（现 `src/shared/types.ts:471-483`）**：

```ts
/** 主进程 → 渲染进程的 IPC 通道事件 */
export type IpcEvent =
  | { extId: string; name: string; type: 'notification'; method: string; params?: unknown }
  | {
      extId: string
      name: string
      type: 'request'
      requestId: string
      method: string
      params?: unknown
      /**
       * 仅 **server 通道**上的对端请求出现（issue #43 R4）：发出该请求的连接。
       * client 通道 / stdio 路径**不出现该字段**（与今天逐字段一致）。见 §5.4 D1。
       */
      connectionId?: number
    }
  | { extId: string; name: string; type: 'stderr'; text: string }
  | { extId: string; name: string; type: 'close'; code: string; message: string }
  | { extId: string; name: string; type: 'connection'; connectionId: number }
  | {
      extId: string
      name: string
      type: 'disconnect'
      connectionId: number
      code: string
      message: string
    }
```

**`src/preload/index.ts`**（现 `:32-40`）：

```ts
  ipcListen: (extId, declaration) => ipcRenderer.invoke('ipc:listen', extId, declaration),
  ipcClose: (extId, name) => ipcRenderer.invoke('ipc:close', extId, name),
  ipcList: (extId) => ipcRenderer.invoke('ipc:list', extId),
  ipcRequest: (extId, name, method, params, timeoutMs, connectionId) =>
    ipcRenderer.invoke('ipc:request', extId, name, method, params, timeoutMs, connectionId),
  ipcNotify: (extId, name, method, params, connectionId) =>
    ipcRenderer.invoke('ipc:notify', extId, name, method, params, connectionId),
  ipcBroadcast: (extId, name, method, params) =>
    ipcRenderer.invoke('ipc:broadcast', extId, name, method, params),
```

**`src/renderer/src/core/host.ts`**（`buildIpcApi`，现 `:1152-1259`）：

```ts
    type ChannelListeners = {
      requests: Set<(method: string, params: unknown) => unknown>
      notifications: Set<(method: string, params: unknown) => void>
      closes: Set<(err: { code: string; message: string }) => void>
      stderrs: Set<(text: string) => void>
      /** issue #43：server 连接事件（按通道名聚合，回调参数与 IpcEvent 一一对应） */
      connections: Set<(connectionId: number) => void>
      disconnects: Set<(connectionId: number, err: { code: string; message: string }) => void>
    }

    // 新增的 listen / broadcast
    listen: async (declaration): Promise<void> => {
      const r = await window.api.ipcListen(ext.id, declaration)
      if (!r.ok) throw new Error(`[${r.code ?? 'invalid-declaration'}] ${r.error ?? 'listen 失败'}`)
    },
    broadcast: async (name, method, params): Promise<void> => {
      const r = await window.api.ipcBroadcast(ext.id, name, method, params)
      if (!r.ok) throw new Error(`[${r.code ?? 'protocol-error'}] ${r.error ?? '广播失败'}`)
    },

    // 既有成员的两处改法
    request: async (name, method, params, opts): Promise<unknown> => {
      const r = await window.api.ipcRequest(
        ext.id, name, method, params, opts?.timeoutMs, opts?.connectionId
      )
      if (!r.ok) throw new Error(`[${r.code ?? 'protocol-error'}] ${r.error ?? '请求失败'}`)
      return r.result
    },
    notify: async (name, method, params, opts): Promise<void> => {
      const r = await window.api.ipcNotify(ext.id, name, method, params, opts?.connectionId)
      if (!r.ok) throw new Error(`[${r.code ?? 'protocol-error'}] ${r.error ?? '发送通知失败'}`)
    },

    onConnection: (name, cb): Disposable => {
      const target = forChannel(name)
      target.connections.add(cb)
      return { dispose: (): void => void target.connections.delete(cb) }
    },
    onDisconnect: (name, cb): Disposable => {
      const target = forChannel(name)
      target.disconnects.add(cb)
      return { dispose: (): void => void target.disconnects.delete(cb) }
    },
```

`ipc:event` 分发（现 `:1176-1206`）在 `if (e.type === 'close')` 之后插入两个分支（**顺序无关**，但放在 `request` 兜底分支之前是必须的，因为现分支结构是"逐个 `if` + 末尾兜底当 request"）：

```ts
      if (e.type === 'connection') {
        for (const cb of [...target.connections]) cb(e.connectionId)
        return
      }
      if (e.type === 'disconnect') {
        for (const cb of [...target.disconnects]) cb(e.connectionId, { code: e.code, message: e.message })
        return
      }
```

`close()`（现 `:1224-1227`）**不改**：`listeners.delete(name)` 已经清掉该名字的全部监听（含新增的两个集合），随后 `ipcClose` 交给主进程执行统一 `close(name)` 语义。

### 3.3 主进程内部：`src/main/ipcServer.ts`（新增，electron-free）

```ts
/**
 * IPC **服务端**传输（electron-free，可独立单测）：宿主 listen 一个命名管道 / Unix 域套接字，
 * 接受**多条**对端连接，每条连接一条独立的 `JsonRpcChannel`（协议零改动）。
 *
 * 与 `ipcTransport.ts` 的分工：
 * - `ipcTransport.ts`：**一条通道一条传输**（客户端拨号 / stdio / 已有流），形状 `IpcTransportHandles`；
 * - 本模块：**一条传输多条连接**，形状 `IpcServerHandles`；连接注册表、连接 ID 分配（R7）、
 *   超限拒绝（R8）、陈旧端点处置（R10/R11）、断连清理（R18）都在这里。
 */
import net from 'node:net'
import { promises as fs } from 'node:fs'
import { JsonRpcChannel, IpcCoreError, createFrameParser, RPC_INTERNAL_ERROR, type Framing } from './ipcCore'

/** 连接 ID：模块级 = **进程内全局**、单调递增、永不复用（R7/S2） */
let nextConnectionId = 1

/** 仅供测试：把连接 ID 计数器复位（**不导出给生产使用**；测试文件直接 import） */
export function resetConnectionIdCounterForTest(): void {
  nextConnectionId = 1
}

export interface IpcServerConnection {
  readonly connectionId: number
  readonly channel: JsonRpcChannel
  /** 对端地址（诊断；Unix 域套接字为空串） */
  readonly remote: string
  /** 从注册表移除 + 关闭通道 + 销毁套接字（幂等；reason 为 null 表示宿主主动关闭） */
  dispose(reason?: IpcCoreError | null): void
}

export interface IpcServerHandles {
  /** listen 成功（含 POSIX 陈旧文件处置与 chmod）；失败即 reject（`connect-failed`） */
  readonly ready: Promise<void>
  /** 实际使用的端点（不带 suffix，R2） */
  readonly endpoint: string
  readonly connectionCount: number
  getConnection(connectionId: number): IpcServerConnection | undefined
  /** 当前连接 ID 列表（升序快照；定向投递与测试用） */
  listConnections(): number[]
  /** 向当前全部连接各发一条通知；无连接静默；单条写失败按该连接断开处理（R12） */
  broadcast(method: string, params?: unknown): void
  /** 停止监听、断开全部连接、释放端点（幂等） */
  dispose(): void
}

export interface PipeServerOptions {
  /** 端点（调用方用 `ipcEndpoint()` 算出，不带 suffix） */
  endpoint: string
  framing?: Framing
  maxMessageBytes?: number
  defaultTimeoutMs?: number
  /** 连接上限（`ipc.ts` 传 `MAX_CONNECTIONS_PER_SERVER`） */
  maxConnections: number
  /** 平台（默认 `process.platform`；显式注入以便两平台分支都单测，R11） */
  platform?: NodeJS.Platform | string
  /** 一条连接**被接受后**回调（被超限拒绝的连接不触发，R8） */
  onConnection?: (connectionId: number) => void
  /** 一条**已接受**的连接断开（恰好一次） */
  onDisconnect?: (connectionId: number, reason: IpcCoreError | null) => void
  /** 对端请求处理器（由 `ipc.ts` 注入：转发到渲染进程） */
  onRequest?: (connectionId: number, method: string, params: unknown) => unknown
  /** 诊断日志（默认 `console.warn`） */
  log?: (message: string, detail?: unknown) => void
}

export function openPipeServerTransport(options: PipeServerOptions): IpcServerHandles

/** 平台分叉的**纯函数**（R11）：Windows 无落盘文件 → 不探测、不 chmod */
export function endpointPrepPlan(platform: NodeJS.Platform | string): {
  /** 是否执行"试连旧端点以判断是否被活着的服务端占用"（POSIX） */
  probeStale: boolean
  /** listen 成功后是否 `chmod 0600`（POSIX） */
  chmod: boolean
}

/** POSIX：试连端点；连上 = 活着（不删除）；连不上 = 陈旧（可 unlink）（R10） */
export function probeEndpointAlive(endpoint: string, timeoutMs?: number): Promise<boolean>
```

### 3.4 主进程内部：`src/main/ipc.ts`（修改）

```ts
export const MAX_CHANNELS_PER_EXTENSION = 4
/** 单个 server 允许的并发连接上限（R8；与上面同处、同风格） */
export const MAX_CONNECTIONS_PER_SERVER = 16
/** 把对端请求转发给渲染进程后的等待上限 */
const FORWARD_TIMEOUT_MS = 30_000

/** 一条已打开的通道：client（拨号/stdio/已有流）或 server（listen 多连接）（R19：同一命名空间） */
type OpenChannel =
  | { kind: 'client'; transport: IpcTransportHandles }
  | { kind: 'server'; server: IpcServerHandles }

const channels = new Map<string, Map<string, OpenChannel>>()

/** 在途转发请求表（3a）：requestId → 等待回包者 + **归属连接**（用于断连定向失败，R18） */
const pendingReplies = new Map<
  string,
  {
    connectionId: number | null
    resolve: (outcome: IpcReplyOutcome) => void
    timer: NodeJS.Timeout
  }
>()
let replySeq = 1

// ---- 内部函数（逐个给出签名与职责） ----
function ipcSocketDir(): string                                   // 不变（:56-58）
function broadcast(event: IpcEvent): void                         // 不变（:60-65）
function failure(err: unknown): { ok: false; code: string; error: string }   // 不变（:67-74）

/** client 通道（R6：重连窗口期由 #44 追加 not-connected 判定，见 #44 设计 §3.4） */
function requireClientTransport(extId: string, name: string): IpcTransportHandles
/** server 通道；名字不存在 → not-connected；存在但是 client → invalid-declaration */
function requireServer(extId: string, name: string): IpcServerHandles
/** 定向投递的统一判定（R6/S1；三种失败见 §5.3） */
function resolveTarget(
  extId: string,
  name: string,
  connectionId: number | undefined,
  what: 'request' | 'notify'
): { kind: 'client'; transport: IpcTransportHandles } | { kind: 'server'; connection: IpcServerConnection }

/** 对端请求 → 渲染进程：**带上归属连接**（R4）；回包前若连接已断则丢弃 */
async function forwardInboundRequest(
  extId: string,
  name: string,
  connectionId: number | null,
  method: string,
  params: unknown
): Promise<unknown>

/** 连接断开时的定向失败传播（R18）：把该连接所有的在途转发条目以断因码结算 */
function failForwardedForConnection(connectionId: number, reason: IpcCoreError): void

/** 通道槽位（重名 / 4 条额度；client 与 server 共用，R19） */
function assertChannelSlot(extId: string, name: string): Map<string, OpenChannel>

/** 把一条 client 传输登记为通道（不变，现 :126-145） */
function registerChannel(extId: string, name: string, transport: IpcTransportHandles): void

/** 把一条 server 登记为通道：挂连接/断开回调、断连清理、对端请求转发（新增） */
function registerServer(extId: string, name: string, server: IpcServerHandles): void

// ---- 对外函数 ----
export async function openExtensionChannel(extId: string, rawDeclaration: IpcChannelDeclaration): Promise<void>
  // 不变（现 :148-186）。**保持 `validateIpcDeclaration(rawDeclaration)` 单独占一行**（现 :152），
  // 供 #44 R18 换成 `validateRuntimeIpcDeclaration`（不合并进别的表达式）

/** listen 一个 pipe 端点（R1/R2/R8） */
export async function openExtensionServer(
  extId: string,
  rawDeclaration: IpcChannelDeclaration
): Promise<void>

export function registerStreamChannel(extId: string, name: string, streams: {...}): IpcTransportHandles
  // 不变（现 :195-214）

/** 统一 close(name)：按名字关闭该名字下的**一切**；不存在静默成功；幂等（R3） */
export function closeExtensionChannel(extId: string, name: string): void

/** 扩展停用/卸载/重载：关闭全部 client 通道与全部 server（R13） */
export function closeExtensionIpc(extId: string): void

/** 通道名集合（含 server 名；R19 无需改代码） */
export function listExtensionChannels(extId: string): string[]

/** 广播通知（R12；不收集回包） */
export function broadcastExtensionChannel(
  extId: string,
  name: string,
  method: string,
  params?: unknown
): void

/** 定向请求（R4/R6） */
export async function requestExtensionChannel(
  extId: string,
  name: string,
  method: string,
  params: unknown,
  opts: { timeoutMs?: number; connectionId?: number }
): Promise<unknown>

/** 定向通知（R6） */
export function notifyExtensionChannel(
  extId: string,
  name: string,
  method: string,
  params: unknown,
  opts: { connectionId?: number }
): void

/** 在途转发请求数（**诊断与测试用**；先例 `hookBridge.pendingCount()`，`src/main/hookBridge.ts:66-67,125-127`） */
export function pendingForwardCount(): number

export function registerIpcBridge(): void   // 增加 ipc:listen / ipc:broadcast，改 ipc:close / ipc:request / ipc:notify
```

**为什么 `openPipeServerTransport` 在 `ipcServer.ts` 而不在 `ipcTransport.ts`（M2 的收敛）**：

| 判据 | `ipcTransport.ts`（`IpcTransportHandles`） | `ipcServer.ts`（`IpcServerHandles`） |
| --- | --- | --- |
| 基数 | 1 通道 = 1 传输（`channel` 单数） | 1 传输 = N 连接（`getConnection/listConnections/broadcast`） |
| 生命周期 | `dispose()` 关一条 | `dispose()` 关监听 + N 条 + 释放端点文件 |
| 需要的状态 | 无（只有闭包） | 连接表、连接 ID 计数器、超限计数、`accepted/closed` 幂等标志 |
| 端点预处理 | 无 | POSIX 探测/unlink/chmod（`fs` 依赖） |
| 结论 | 不动它 → `openPipeClientTransport` 的 233 行保持不变，回归面最小 | 新文件承载全部新状态 |

**`ipc:request` 桥的改法**（现 `:262-282`）：签名加末位 `connectionId?: number`，体内改为

```ts
const result = await requestExtensionChannel(String(extId), String(name), String(method), params, {
  timeoutMs,
  connectionId
})
```
`ipc:notify` 同法调用 `notifyExtensionChannel`；`ipc:listen` → `openExtensionServer`；`ipc:broadcast` → `broadcastExtensionChannel`；`ipc:close` → `closeExtensionChannel`（**统一语义**，`ipc:close` 的既有调用点无需改）；`ipc:list` 不变。

### 3.5 `src/main/ipcCore.ts`（修改：只加一个码）

```ts
export type IpcErrorCode =
  | 'invalid-declaration'
  | 'not-connected'
  | 'connect-failed'
  | 'protocol-error'
  | 'timeout'
  | 'cancelled'
  | 'message-too-large'
  | 'too-many-requests'
  | 'too-many-channels'
  | 'too-many-connections' // ← 新增（R9）：单 server 连接数超限（线上以 message 前缀 [too-many-connections] 暴露）
  | 'peer-crashed'
  | 'channel-closed'
```
`ipcEndpoint`（`:652-662`）**不动**（`suffix` 已支持、本期不暴露，R2）；`RPC_*` 常量**不动**（S7 复用 `-32603`，见 §5.2）。

---

## 4. 数据流与状态机

### 4.1 表一：通道表（`src/main/ipc.ts:41`，结构改，键不变）

| 层 | 键 | 值 | #43 的变化 |
| --- | --- | --- | --- |
| 外层 | `extId: string` | `Map<name, OpenChannel>` | 不变（`channelMap(extId)` 惰性建表，`:48-54`） |
| 内层 | `name: string`（client 与 server **共用命名空间**） | `OpenChannel` | 值由 `{transport}` 变为判别联合 |
| 值·client | — | `{ kind: 'client'; transport: IpcTransportHandles }` | 原 `{transport}` 加判别键（#44 会在此分支加 `state` 与 `reconnect`） |
| 值·server | — | `{ kind: 'server'; server: IpcServerHandles }` | **新增** |
| 额度 | `map.size` | 最大 4（`MAX_CHANNELS_PER_EXTENSION`） | server 占 **1** 条（R19）；连接**不**进这张表 |
| 展示 | `[...map.keys()]` | `listExtensionChannels(extId)`（`:235-237`） | **无需改代码**：server 名天然出现在 `channels()` 里（R19） |

### 4.2 表二：连接表（`src/main/ipcServer.ts` 内部，**不导出**，经 `getConnection/listConnections/broadcast` 观察）

| 字段 | 类型 | 语义 | 何时写 | 何时删 |
| --- | --- | --- | --- | --- |
| `connectionId` | `number` | 进程内全局单调递增、永不复用（R7/S2）；在 `(extId, name, connectionId)` 三元组内解释 | accept 时由 `nextConnectionId++` 分配（**先判超限，超限不分配**，见 §5.4 D4） | 永不回收（连接断开只删表项，ID 退役） |
| `channel` | `JsonRpcChannel` | 该连接独立的协议状态机（分帧/请求关联/超时/并发上限） | accept 时 `new JsonRpcChannel({framing, sendFrame: socket.write})` | 断开时 `channel.close(reason)` |
| `socket` | `net.Socket` | 字节通道；`setNoDelay(true)`（与客户端 `net.createConnection` 默认一致） | accept 时 | 断开/拒绝后 `socket.destroy()` |
| `remote` | `string` | 诊断（`socket.remoteAddress ?? ''`） | accept 时 | 随表项 |
| `closed` | `boolean`（闭包内） | `dispose`/断连清理的幂等标志（保证 `onDisconnect` 恰好一次） | 首次断开 | 随表项 |
| `acceptedAt` | `number` | `Date.now()`，仅诊断日志用 | accept 时 | 随表项 |
| 上限 | `maxConnections`（=16） | 表 `size` 达到上限后新连接**先回错误帧再关**（R8） | — | — |

**两个计数器互不影响**：连接表 `size` 只受 `maxConnections` 约束；它**不**进入通道表（R19）。

### 4.3 表三：挂起请求表（两张物理表；`requestId` 归属写清）

| 子表 | 位置 | 键 | 值 | 谁写入 | 断开时如何失败 |
| --- | --- | --- | --- | --- | --- |
| **3a 转发等待表** | `src/main/ipc.ts:42-45` | `requestId: string`（`ipc-${replySeq++}`，**全局**编号，不按连接分段） | `{ connectionId: number \| null; resolve; timer }` | `forwardInboundRequest`（`:84-105`）；`connectionId` **新增**，client/stdio 路径为 `null` | 遍历表，`connectionId === 断开的 ID` 的条目 `clearTimeout` + `resolve({ok:false,error})` + 删表（`failForwardedForConnection`） |
| **3b 单连接出站表** | `src/main/ipcCore.ts:293`（`JsonRpcChannel.pending`，键 `JsonRpcId`） | 请求 id（每通道从 `1` 起，`:299`） | `PendingCall`（`resolve/reject/timer/onAbort`） | `JsonRpcChannel.request`（`:324-370`） | 既有行为：`channel.close(reason)`（`:433-448`）一次性 `reject(reason)` 全部挂起项 |
| （3c 回调集合，**非挂起表**） | `src/renderer/src/core/host.ts:1156-1174` | `name` | `ChannelListeners` 各 `Set` | `onXxx` 注册 | **不参与失败传播**（只是回调集合；`close(name)` 时随 `listeners.delete(name)` 清空，`:1225`） |

**`requestId` 归属规则（写清以便 R18/V16 可测）**：

| 规则 | 内容 |
| --- | --- |
| 编号空间 | `requestId` 由主进程 `replySeq` **全局递增**生成（`:46,91`），**不**按连接分段，也**不**与 `connectionId` 互相推导 |
| 归属 | 每个在途转发条目**显式记录** `connectionId`（server 上的对端请求）或 `null`（client/stdio 对端请求） |
| 回包匹配 | `ipc:reply`（`:303-309`）只按 `requestId` 匹配；命中即可回，**不校验**请求者连接是否还活着 |
| 断连后 | 条目已在 §4.5 步骤 3 被删除 → 迟到的 `ipc:reply` 走既有 `if (!pending) return` 丢弃（`:305`）；对端已断，`replyResult` 的 `socket.write` 也不会发生（通道已 `closed`，`ipcCore.ts:566` 直接 return） |
| 不重放 | 没有任何代码路径把 3a/3b 的条目**重新投递**给新连接：新连接是新的 `JsonRpcChannel`，其 `pending` 从空开始（`:293,299`）；3a 的条目在建表时绑定旧 `connectionId`，不参与任何批量重发 |

### 4.4 连接 ID 分配与退役规则

| 规则 | 实现 | 依据 |
| --- | --- | --- |
| 起点 | `1` | R7 |
| 计数器位置 | `src/main/ipcServer.ts` 模块级 `let nextConnectionId = 1` | S2"进程内全局"：模块级即全局，跨 server、跨 server 重建都不复用 |
| 单调 | 只做 `nextConnectionId++`，无任何回退路径 | R7 |
| 分配时机 | `'connection'` 事件里**先判 `maxConnections`**：未超限才分配 ID 并建通道；超限**不分配**（否则会白白消耗 ID 且与"该连接从未被接受"矛盾） | R8 + §5.4 D4 |
| 退役 | 连接断开 → 只从连接表删除；ID **永久不再出现**（没有任何"回收池"） | R7 |
| 跨 server 重建 | 同名 server 关闭后重新 `listen`，新连接拿到**严格更大**的 ID | R7/V17 |
| 可打印 | `number`，直接进日志/事件 | R7 |
| 解释域 | `(extId, name, connectionId)` 三元组；不同 server 的 ID 天然不撞（全局递增） | R7 |
| 测试复位 | 仅导出 `resetConnectionIdCounterForTest()`（供 V17 与其它用例确定起点的**测试专用**出口，不进生产调用路径） | 设计补充（无需 `vi.resetModules`） |

### 4.5 断开瞬间的失败传播顺序（R18；**绝不重放**）

触发源：`socket` 的 `'close'` / `'error'`（对端断开、被强杀）、`channel` 的 `protocol-error`（非法帧）、宿主主动 `dispose`（R3/R13）。统一走"单条连接收尾"函数（`IpcServerConnection.dispose(reason)`，幂等）：

| 步 | 动作 | 精确语义 | 证据/理由 |
| --- | --- | --- | --- |
| 1 | **从连接表移除** | `connections.delete(connectionId)` | 此后定向投递立即 `not-connected`（R6）；新连入不会看到旧 ID |
| 2 | **关该连接的协议状态机** | `channel.close(reason)`：3b 表全部挂起项 `reject(reason)`；`closeListeners` 触发 | 既有 `ipcCore.ts:433-448` |
| 3 | **清该连接的在途转发** | `failForwardedForConnection(connectionId, reason)`：3a 表里 `connectionId` 命中的条目 `clearTimeout` + `resolve({ok:false,error:reason.message})` + 删表 | **新增**（R18）；不这样做要等 30s 超时才结算（`:93-96`） |
| 4 | **广播 `disconnect` 事件** | `broadcast({extId, name, type:'disconnect', connectionId, code: reason?.code ?? 'channel-closed', message})` → 渲染进程按 `name` 分发到 `onDisconnect` | R14/R5；`broadcast` 走同一 webContents，FIFO 保证同一 ID 的 `connection` 在前 |
| 5 | **幂等闸门** | 步骤 1–4 只在 `closed === false` 时执行一次，随后置 `true` | R18"`onDisconnect` **恰好一次**" |
| 6 | **销毁套接字** | `socket.destroy()`（`protocol-error` 场景必须先于对端再发字节；正常断开时是幂等收尾） | R9 的"以 `protocol-error` 关闭"要真的断开，否则半死连接占额度 |
| 7 | **其它连接不动** | 每条连接自有 `JsonRpcChannel`/`socket`，无共享挂起表（3b 是每通道一份） | R18"其它连接完全不受影响" |
| 8 | **不重放** | 无批量重发路径（§4.3 末两行）；新连接拿到**新 ID**、挂起表为空 | R18 + Q1 |

**宿主主动关闭（`close(name)` / `closeExtensionIpc`）走同一条链**，只是 `reason = null` → 步骤 4 的 `code` 落 `channel-closed`（与既有 client 通道主动 `close()` 广播 `channel-closed` 的行为一致：`ipc.ts:130-139` 的 `err?.code ?? 'channel-closed'`）。见 §5.4 D3。

### 4.6 记账：额度与 `channels()`（R19）

| 对象 | 记在哪 | 上限 | 计数时机 | 释放时机 |
| --- | --- | --- | --- | --- |
| client 通道 | 通道表（4.1）一项 | 4（与 server 共用） | `registerChannel` 时 `channelMap(extId).set(name, …)`（`:144`） | `closeExtensionChannel` / 对端断开时 `onClose` 里的 `delete`（`:130-132`） |
| **server** | 通道表（4.1）**一项**（不是每连接一项） | 4（与 client 共用） | `registerServer` 时 `set(name, {kind:'server',…})` | `close(name)` / `closeExtensionIpc` |
| **连接** | 连接表（4.2） | **16**（`MAX_CONNECTIONS_PER_SERVER`） | accept 且未超限 | 该连接断开 |
| `channels()` | `listExtensionChannels`（`:235-237`）＝通道表键集合 | — | — | — |
| 判定函数 | `assertChannelSlot`（`:108-120`，connect 与 listen **共用**） | — | — | — |

**结论：R19 在实现上是"零额外代码"** —— 只要 server 复用通道表，`channels()` 自动含 server 名、额度自动算 1 条、连接自动不进 4 条上限。唯一要**明写并测**的是"重名（client 名字被 server 占用或反之）→ `invalid-declaration`"（沿用 `通道 X 已打开`，`:111`）。

### 4.7 事件时序（端到端）

| # | 时刻 | 主进程动作 | 渲染进程观察 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 扩展调 `api.ipc.listen({id:'svc',transport:'pipe'})` | 校验 → `assertChannelSlot` → `ipcEndpoint` → `openPipeServerTransport` → `await ready` → `registerServer` | `listen` resolve（无事件） | R1/R19 |
| 2 | 对端连入（第 k ≤ 16 条） | 分配新 ID → 建 `JsonRpcChannel` → 入表 → `broadcast({type:'connection', connectionId})` | `onConnection(svc, id)` 一次 | R5/V1/V3 |
| 3 | 对端发请求 | `setDefaultHandler` → `forwardInboundRequest(extId,name,connectionId,…)` → `broadcast({type:'request', requestId, method, params, connectionId})` | `onRequest` handler 被调用；回包经 `api.ipcReply(requestId, …)` | R4 |
| 4 | 宿主定向请求 | `resolveTarget` → `connection.channel.request(method, params, {timeoutMs})` | `request` promise settle（`timeout` 默认 30s） | R6/V13 |
| 5 | 宿主广播 | `server.broadcast(method, params)` → 每条连接 `channel.notify` | 各对端收到**通知**（不是请求） | R12/V2 |
| 6 | 对端断开 | §4.5 步骤 1–6 | `onDisconnect(svc, id, {code:'peer-crashed'|'channel-closed',…})` 一次 | R18/V4/V9 |
| 7 | 第 17 条连入 | 写 `{jsonrpc:'2.0',id:null,error:{code:-32603,message:'[too-many-connections] …'}}` → `socket.end()`/`destroy()` | **无** `connection` / `disconnect` 事件 | R8/V7 |
| 8 | 扩展 `close('svc')` | 关监听 → 逐连接 §4.5（reason=null） → 删通道表项 → POSIX unlink 端点 | 每条连接一次 `disconnect`（`channel-closed`）+ 端点不可连 | R3/V8 |

---

## 5. 错误码与线上码

### 5.1 `too-many-connections` 的落点与文案

| 项 | 值 | 依据 |
| --- | --- | --- |
| 类型闭集落点 | `src/main/ipcCore.ts:41` 之后（`too-many-channels` 与 `peer-crashed` 之间） | R9（11 → 12） |
| 常量落点 | `src/main/ipc.ts:34`（`MAX_CHANNELS_PER_EXTENSION` 下一行，同风格） | R8 |
| 谁观测到 | **只有对端**（第 17 条连接方），经线上错误帧的 `message` 前缀 `[too-many-connections]`；扩展**不**直接收到该码 | R8（"不触发 `onConnection`/`onDisconnect`"） |
| 线上整数码 | `RPC_INTERNAL_ERROR = -32603`（`src/main/ipcCore.ts:248`） | S7（不新增线上整数码） |
| 线上帧形状 | `{ jsonrpc: '2.0', id: null, error: { code: -32603, message: '[too-many-connections] …' } }` | R8（`id: null` 由 spec 固定） |
| 分帧 | 用**该 server 声明的 `framing`**（`createFrameParser(framing).encode(payload)`）；不这样做对端解不出来 | N5（一条 server 所有连接共用 framing） |
| 文案（推荐值） | `[too-many-connections] 连接数已达上限 16（该 server 的既有连接不受影响）` | 方向来自 R8；措辞照 `too-many-channels` 的风格（`src/main/ipc.ts:113-118`） |
| 同步面 | `src/api/types.ts` 的 `ipc` doc 注释错误码列表、`api-reference.md:654`、`docs/adr/0016:31` 的不变量清单 | R9/R17 |
| 测试断言口径 | **只锁 `[too-many-connections]` 前缀与 `code === -32603`**，不锁全文（见 §5.4 D6） | 设计补充 |

### 5.2 线上整数码 vs 本地稳定码（全表）

| 场景 | 线上（对端看到） | 本地（扩展看到） | 落点 |
| --- | --- | --- | --- |
| 第 17 条连接被拒 | `-32603` + `message` 前缀 `[too-many-connections]` | **无**（不触发任何事件） | `ipcServer.ts` 拒绝分支 |
| 对端请求未注册处理器（渲染进程未注册 handler） | `-32601`（`RPC_METHOD_NOT_FOUND`） | — | `ipcCore.ts:554`（不变） |
| 对端请求的处理抛错 / 转发超时 / 渲染回包 `ok:false` | `-32603`（`RPC_INTERNAL_ERROR`） | — | `ipcCore.ts:561`（不变） |
| 对端发非法帧（帧头/JSON 形状） | **不发码**（直接关连接） | `disconnect{code:'protocol-error'}` | `ipcCore.ts:493-499, 419-430` |
| 宿主定向 `request` 超时 | **不发码**（宿主单方超时，对端可能仍回） | `timeout` | `ipcCore.ts:341-345` |
| `listen({transport:'stdio'})` | — | `invalid-declaration` | `ipc.ts` 新增（§5.3①） |
| server 名字下省略 `connectionId` | — | `invalid-declaration` | `ipc.ts` `resolveTarget`（§5.3②） |
| client 通道传 `connectionId` | — | `invalid-declaration` | 同上（§5.3③） |
| 定向到已断开/不存在连接 | — | `not-connected` | `ipcServer.getConnection` 未命中 → `resolveTarget` |
| 名字不存在（`request`/`notify`/`broadcast`） | — | `not-connected` | 沿用 `requireChannel`（`:76-82`） |
| `broadcast` 名字存在但是 client 通道 | — | `invalid-declaration` | `broadcastExtensionChannel` |
| 5 条通道（client+server 合计） | — | `too-many-channels` | `assertChannelSlot:113-118`（不变） |
| 重名（client ↔ server 任一方向） | — | `invalid-declaration`（`通道 X 已打开`） | `assertChannelSlot:110-112`（不变） |
| 对端写失败 / 对端连接已关闭 | — | `not-connected` / `peer-crashed` / `channel-closed` | `ipcCore.ts` 既有 |
| `-32600`（`RPC_INVALID_REQUEST`） | **本期不使用**（声明未使用，`ipcCore.ts:249` 是唯一出现处） | — | §2.1 F13 补充事实 |

### 5.3 `invalid-declaration` 的三种触发与**判定位置**

| # | 触发 | 判定位置（函数 / 现状行 → 落地行） | 判定顺序（必须在前置判定之后） |
| --- | --- | --- | --- |
| ① | `listen({transport:'stdio'})` | `src/main/ipc.ts` **新增函数 `openExtensionServer`**，函数体第 1 步：`if (declaration.transport !== 'pipe') throw new IpcCoreError('invalid-declaration', 'listen 只支持 pipe（服务端不能拉起子进程；stdio 请用 connect）')`。**位置锚点**：现状无此函数；应插在 `openExtensionChannel`（`:148`）与 `registerStreamChannel`（`:195`）之间 | 在 `assertChannelSlot`（`:153` 对应位置）**之前**：先判角色，再判名字/额度（否则 `listen({transport:'stdio'})` 且名字已占用时会先报重名，语义更差） |
| ② | server 名字下 `request`/`notify` 省略 `connectionId` | `src/main/ipc.ts` **新增函数 `resolveTarget`**：`name` 命中且 `kind==='server'` 且 `connectionId === undefined` → `throw new IpcCoreError('invalid-declaration', \`服务端通道 ${name} 必须指定 connectionId，或用 broadcast\`)` | 在"名字存在性"判定**之后**（名字不存在仍是 `not-connected`，`ipc:request` 的既有文案 `通道不存在或未连接` 不变） |
| ③ | client 通道传 `connectionId` | 同一个 `resolveTarget`：`kind==='client'` 且 `connectionId !== undefined` → `throw new IpcCoreError('invalid-declaration', \`通道 ${name} 是客户端通道，没有连接 ID 命名空间\`)` | 同上 |
| ④ | （#44 的第三例，**不在本 issue 落地**）`transport:'stdio'` + `autoReconnect` | #44 的运行时校验入口（`src/shared/ipcDeclaration.ts` 的 `validateRuntimeIpcDeclaration`），调用点 `src/main/ipc.ts:152`。见 `tmp/spec/extension-ipc-reconnect-design.md` §5.3 | #44 落地后此处行号平移，以代码为准 |

链路（三例都走同一条）：主进程 `IpcCoreError('invalid-declaration')` → `failure()`（`:67-74`）→ `{ok:false, code:'invalid-declaration', error:'[invalid-declaration] …'}` → `host.ts:1219/1222/1231/1236` 抛 `Error('[invalid-declaration] …')` → 扩展 catch 到的 `message` 以 `[invalid-declaration]` 开头（测试断言用这个前缀，不用全文）。

### 5.4 待定项（spec 未定；给推荐值 + 理由）

**【设计待定：需在实现前确认】D1（R4 × R14 字面冲突）**：`IpcEvent` 的 `request` 成员是否增可选 `connectionId?: number`？
- **推荐：增可选字段**（§3.2 的形状）。理由：① R4 要求"转发时带上 `connectionId`"，不增字段就无法实现；② R14 的括注写明意图是"向后兼容"，可选字段**不改变** client/stdio 路径产生的事件（该键不出现），`host.ts:1193-1198` 只读 `method/params/requestId`，消费者零感知；③ 若严格照字面"一字不改"，唯一替代是新增第 5 种事件类型（如 `type:'server-request'`），那会让渲染进程多一条分发分支、且与 R5 的"`onRequest` 不分 client/server"相矛盾，反而更乱。

**【设计待定：需在实现前确认】D2**：扩展侧的 `onRequest(name, handler)` 是否把 `connectionId` 传给扩展？
- **推荐（本期实现）：不扩签名**，`connectionId` 只出现在主进程→渲染进程的事件里（可由宿主日志使用），扩展侧本期**拿不到**"这个请求来自哪条连接"。
  - 理由：spec 只定了 R4（转发带 ID）与 R5（`onConnection/onDisconnect` 的参数），**没有**定义 `onRequest` 的第三参；扩对外 API 属"多一个也算越界"（`workflow.md:45`）。且回包按 `requestId` 路由，扩展在**响应**方向上不需要 ID。
  - 代价（须在 api-reference 明写）：服务端扩展若要做到"每连接独立会话"，只能自己在 `onConnection/onDisconnect` 里维护计数/顺序，或对每个请求用 `notify` 之外的方式区分——本期不支持。
- 若用户要在本期就支持，推荐签名（**待确认后**再写进 spec 再改 API）：`onRequest(name, handler: (method: string, params: unknown, ctx: { connectionId?: number }) => unknown)`；`ctx.connectionId` 仅在 server 通道的对端请求上出现。属**纯新增可选参数**，按 ADR-0010 决策 4 不递增 `apiVersion`。

**【设计待定：需在实现前确认】D3**：宿主主动 `close(name)` / `closeExtensionIpc` 关闭 server 时，已接受的连接是否触发 `onDisconnect`？
- **推荐：触发，`code = 'channel-closed'`**。理由：① 与既有 client 通道一致——扩展主动 `close()` 时 `transport.dispose()` → `channel.close()`（无参）→ 注册的 `onClose` 仍会跑并广播 `close{code:'channel-closed'}`（`ipc.ts:128-139` + `:217-224`，已在本文档核对过顺序：`dispose()` 先于 `map.delete`）；② R18 要求"每连接的 `onDisconnect` 恰好触发一次"，把宿主关闭排除在外会让"恰好一次"出现例外；③ 扩展可据此清理每连接的 UI/会话状态，否则会泄漏。
- 代价：扩展被停用时也会收到一批 `disconnect`（无害：扩展正在卸载，host 的 `onDisconnect` 监听随后被 `listeners.delete` 清掉）。

**【设计待定：需在实现前确认】D4**：第 17 条（超限被拒）连接是否**分配** `connectionId`？
- **推荐：不分配**（先判 `maxConnections`，超限直接走拒绝帧）。理由：① R8 明写"该连接**从未被接受**"，给它一个 ID 会让"ID = 被接受的连接"这一不变量出现例外，也会污染 V17 的"旧 ID 不再出现"直觉；② 浪费 ID 无任何收益（ID 只用于已接受连接的定向投递）。
- 测试影响：V17 只能断言"严格更大"，**不得**断言 ID 连续（本设计已按此写用例，§8）。

**【设计待定：需在实现前确认】D5**：`broadcast` 遇到 `message-too-large` 时是否按 R12 断开该连接？
- **推荐：不断开**。只在 `JsonRpcChannel.write`（`ipcCore.ts:452-463`）抛出且 `code === 'message-too-large'` 时**跳过该连接并记日志**；只有 `sendFrame`（`socket.write` 不可写）失败才按"该连接断开"处理。
- 理由：R12 的"写失败"指的是**套接字层**写失败；`message-too-large` 是**消息校验**失败（在 `sendFrame` 之前就抛出，且与连接健康无关）。为一条过大的广播消息断开健康连接会造成连锁误伤（V2/V7 都不覆盖该分支，但真机上扩展会看到"广播后连接全掉"的诡异现象）。**此条偏离 R12 字面，需确认**；若坚持字面，则改为对所有 `notify` 抛错一律 `dispose` 该连接（实现上只差一个 `if`）。

**【设计待定：需在实现前确认】D6**：新增/变更文案的逐字值（超限帧 `message`、三例 `invalid-declaration` 的 `message`、"连接不存在或已断开"等）。
- **推荐值**见 §5.1 与 §5.3；判据：稳定码用 `[]` 前缀（既有 `IpcCoreError` 构造函数 `ipcCore.ts:46-53` 就在 `message` 前加 `[code] `），其余措辞照既有同族文案的风格（`ipc.ts:111`、`:113-118`、`ipcCore.ts:79`、`:326`）。
- **配套原则（本设计强制）**：所有测试**只断言 `[稳定码]` 前缀**（`expect(err.message).toMatch(/^\[invalid-declaration\]/)`），不断言全文 → 文案后续微调不会引起测试红。

**【设计待定：需在实现前确认】D7（测试缝隙，§7 的决策）**：新测试如何触达 `src/main/ipc.ts`（该文件 `import ... from 'electron'`，仓库既有约定是"依赖 electron 的模块不单测"）？
- **推荐：在新建的两个测试文件里 `vi.mock('electron', …)`**（`vi.hoisted` 自包含写法，§7.2），**不改生产代码结构**；备选方案 B 见 §7.3（提取 electron-free 的 `ipcRegistry.ts`），**触发条件**写在 §7.4。
- 理由：V8（`closeExtensionIpc`）、V14（三例 `invalid-declaration`）、V16（在途请求）、V17（连接 ID）的验收命令**指名**要测这些函数，而它们都在 `ipc.ts`；mock 只覆盖 3 个符号（`app.getPath` / `BrowserWindow.getAllWindows` / `ipcMain.handle`），且额外换来"能断言 `connection`/`disconnect` 事件载荷（R14）"与"能直接调用 `ipc:request`/`ipc:reply` 处理器"两处收益。

---

## 6. 平台差异（Windows 命名管道 vs POSIX unix socket）

### 6.1 端点构造（沿用 `ipcEndpoint()`，`suffix` 不暴露）

| 平台 | 端点 | `suffix` | 目录 | 证据 |
| --- | --- | --- | --- | --- |
| win32 | `\\.\pipe\obox-<扩展id>-<通道名>` | **不传** | 不涉及（内核命名空间） | `ipcCore.ts:658` |
| 其它 | `<userData>/ipc/obox-<扩展id>-<通道名>.sock` | **不传** | `ipcSocketDir()` = `join(app.getPath('userData'),'ipc')` | `ipcCore.ts:659-661`、`ipc.ts:56-58` |
| 两平台共有 | `sanitizeIpcName` 先校验 id/name（只允许字母数字与 `._-`、禁 `..`） | `suffix ? '-<suffix>' : ''`（`:655-656`） | 先 `fs.mkdir(socketDir, {recursive:true})`（`ipc.ts:179` 既有做法，server 侧照抄） | R2 |

**`suffix` 不暴露的具体含义**：`api.ipc.listen(declaration)` 的声明类型**没有** `suffix` 字段（`IpcChannelDeclaration` 不含），`openExtensionServer` 也不读任何 `suffix`（直接 `ipcEndpoint({socketDir, extensionId: extId, name: declaration.id})`）。`ipcEndpoint` 的 `suffix` 参数保持原样供未来多实例场景（N7/R2）。

### 6.2 POSIX 陈旧 `.sock` 处置（R10）与 Windows 分支（R11）

| 步 | POSIX | Windows |
| --- | --- | --- |
| 1 | `fs.stat(endpoint)`（或用 `fs.access`）判存在 | **不做**（命名管道无落盘文件） |
| 2 | 存在 → `probeEndpointAlive(endpoint)`：`net.createConnection(endpoint)` | **不做** |
| 3a | 探测**连上** → 说明有活着的服务端 → `throw IpcCoreError('connect-failed', '端点已被占用：<endpoint>')`，**不 unlink** | — |
| 3b | 探测**连不上**（`ECONNREFUSED`/`ENOENT`/其它 error）→ `fs.unlink(endpoint)`（吞 `ENOENT`）→ `server.listen(endpoint)` | `server.listen(endpoint)` |
| 4 | `listen` 若仍 `EADDRINUSE`（K3 竞态）→ **重试一次**（unlink + listen）；再失败 → `connect-failed` + 文案含"已被占用" | `EADDRINUSE` → `connect-failed` + 文案含"已被占用"（V5 Windows 分支） |
| 5 | `listen` 成功后 `fs.chmod(endpoint, 0o600)` | **不做** |
| 6 | `dispose()` 时 `fs.unlink(endpoint)`（吞 `ENOENT`），再 `server.close()` | 只 `server.close()` |
| 平台分叉实现 | `endpointPrepPlan(platform)`（**纯函数**，`src/main/ipcServer.ts` 导出）：win32 → `{probeStale:false, chmod:false}`；其它 → `{probeStale:true, chmod:true}` | 同左 |
| 单测 | `endpointPrepPlan('win32'|'darwin'|'linux')` 三分支断言 + POSIX 真实用例（`process.platform !== 'win32'` 才跑） | 同左 |

参考先例：客户端测试手工 `chmod 0600`（`test/ipc-transport.test.ts:226`）；`probeEndpointAlive` 的"连不上"语义可直接对照 `test/ipc-transport.test.ts:236-240`（端点不存在 → `connect-failed` 的**客户端**侧版本；**不要**把该用例当工具复用，它是断言不是工具）。

### 6.3 `protocol-error` 与套接字收尾（跨平台一致）

`JsonRpcChannel.accept` 遇非法帧 → `channel.close(protocol-error)`（`ipcCore.ts:419-430`），**不会**自动销毁套接字。服务端侧必须在 `channel.onClose` 回调里 `socket.destroy()`（§4.5 步 6），否则该对端仍占一条连接额度且 `disconnect` 与"连接真的断了"不一致。Windows 命名管道与 POSIX 域套接字在此**行为一致**，无平台差异。

### 6.4 进程退出清理路径（`extensionCleanup.ts`）

| 时机 | 调用链 | server 的行为 | 证据 |
| --- | --- | --- | --- |
| 扩展停用/卸载/重载（渲染进程热移除） | `ipcMain.handle('extension:cleanup')` → `cleanupExtensionResources(extId)` → `closeExtensionIpc(extId)` | 关监听 + 断开全部连接（每个连接一次 `disconnect`）+ POSIX unlink 端点 | `src/main/index.ts:113`、`extensionCleanup.ts:23-30`、`ipc.ts:227-232` |
| 应用退出 | `app.on('before-quit')` → `cleanupAllExtensionResources()` → 逐扩展 `cleanupExtensionResources` | 同上（同步路径，`QUIT_CLEANUP_TIMEOUT_MS = 3000` 是兜底） | `src/main/index.ts:168-176`、`extensionCleanup.ts:46-74` |
| 宿主被**强杀**（无清理机会） | 无 | POSIX 会留 `.sock`（下次 `listen` 由 §6.2 步骤 3b 自愈）；Windows 命名管道随进程消失 | 既有先例与实测记录见 `troubleshooting.md:292`（孤儿进程占端点） |

**R13 的实现结论**：`extensionCleanup.ts` **一行都不用改** —— 它已经在唯一正确的时机调用 `closeExtensionIpc`（`extensionCleanup.ts:28`），而 `closeExtensionIpc` 在本次改动中扩展为"也关 server"（§3.4）。

---

## 7. 测试缝隙决策（决定 §8 的可执行性）

### 7.1 约束

| # | 约束 | 证据 |
| --- | --- | --- |
| T1 | 新逻辑中 `openPipeServerTransport` 等（`ipcServer.ts`）**天然 electron-free**，可直接 import | §3.3 设计 |
| T2 | V8/V14/V16/V17 的验收命令指名要测 `closeExtensionIpc`、`invalid-declaration` 三例、在途转发、连接 ID —— 全在 `src/main/ipc.ts`，而它是唯一 import electron 的层（`ipc.ts:10`） | §5.3、§8 |
| T3 | 仓库既有约定：`test/**` 不导入依赖 electron 的模块（35 处导入全部 electron-free） | §2.4 A3 |
| T4 | `npm run typecheck` 不含 `test/**`；`eslint` 覆盖 `test/**`（无类型感知规则） | §2.4 A1 |

### 7.2 推荐方案 A：在测试文件里 mock electron（单文件、自包含）

两个新测试文件各自写（**不抽 helper**，理由见下）：

```ts
// test/ipc-server.test.ts（#44 的 test/ipc-reconnect.test.ts 写同一段）顶部
import { beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** electron mock：只覆盖 ipc.ts 用到的 3 个符号（ipc.ts:10） */
const electronState = vi.hoisted(() => ({
  userData: '',
  /** 主进程 → 渲染进程的事件（断言 R14 的事件载荷） */
  events: [] as Array<{ extId: string; name: string; type: string; [k: string]: unknown }>,
  /** ipcMain.handle 注册的处理器（直接调用 = 扮演渲染进程/扩展） */
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: { getPath: (): string => electronState.userData },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (_channel: string, event: unknown) => electronState.events.push(event as never) }
      }
    ]
  },
  ipcMain: { handle: (channel: string, fn: (...a: unknown[]) => unknown) => electronState.handlers.set(channel, fn) }
}))

// 必须在 mock 之后再 import（vi.mock 会被提升；此 import 才能拿到被 mock 的 electron）
import {
  MAX_CONNECTIONS_PER_SERVER,
  broadcastExtensionChannel,
  closeExtensionChannel,
  closeExtensionIpc,
  listExtensionChannels,
  openExtensionServer,
  pendingForwardCount,
  registerIpcBridge,
  requestExtensionChannel
} from '../src/main/ipc'
```

调用方式（"扩展"由测试扮演）：

```ts
registerIpcBridge()                                        // 一次：把 ipc:* 处理器装进 electronState.handlers
const listen = electronState.handlers.get('ipc:listen')!   // (event, extId, declaration) => Promise<{ok,code?,error?}>
const request = electronState.handlers.get('ipc:request')! // (event, extId, name, method, params, timeoutMs, connectionId)
const reply = electronState.handlers.get('ipc:reply')!     // (event, requestId, outcome)
```

**不抽 helper 的理由**：`vi.mock` 的工厂与 `vi.hoisted` 的生命周期绑定在**当前文件**上；抽到 helper 后工厂的求值时机依赖 vitest 的提升与 ESM 求值顺序的耦合（工厂在第一次 import `electron` 时执行，那时 helper 的绑定必须已初始化）。这段 ~20 行的重复换来**零时序风险**，两个文件各自独立可读，值得。

### 7.3 备选方案 B（仅在 §7.4 触发时启用）：提取 electron-free 的 `ipcRegistry.ts`

把 `ipc.ts` 里的注册表（通道表、限额、`pendingReplies`、转发、统一 close、server 管理）整体搬进新文件 `src/main/ipcRegistry.ts`，依赖注入 `{ socketDir, emit, extensionDir, maxChannels, maxConnections }`；`ipc.ts` 只剩 `registerIpcBridge()` + 注入实现 + 再导出旧符号（`extensionCleanup.ts:13` 与 `python.ts:20` 的导入保持不变）。代价：约 200 行搬迁 + 一次回归面较大的重构，超出 spec §4 的文件清单（属范围扩张，需用户确认）。

### 7.4 触发条件（先做 15 分钟预检，不得推迟）

实现第 1 步就写"最小骨架"：mock electron + `registerIpcBridge()` + 调 `ipc:list` 断言 `[]`，并跑 `npx vitest run test/ipc-server.test.ts`。判定：

| 观察 | 结论 |
| --- | --- |
| 骨架通过 | 走方案 A，继续实现 |
| 报 `Cannot find module 'electron'` / mock 未生效（`app.getPath is not a function`）/ `vi.hoisted` 不可用 | **立即停下**，把 §7.3 的方案 B 作为**范围变更**报给用户（附失败原文），批准后再继续 |

---

## 8. 测试计划（V1–V17 → 文件 + 用例名 + 是否真实 socket + 平台 skip）

### 8.1 新增文件与工具

| 文件 | 内容 |
| --- | --- |
| `test/helpers/ipcPeers.ts`（新增，**非** `*.test.ts`，`vitest.config.ts:6` 的 `include` 不会把它当用例运行） | 从 `test/ipc-transport.test.ts:84-128` **复制**（不 import 测试文件——导入会连带注册它的 describe）：`createServer(onMessage)`（content-length 极简服务端）、`endpointFor(name, workDir)`（Windows `\\.\pipe\obox-<name>` / POSIX `<workDir>/obox-<name>.sock`）、`listen(server, endpoint)`、`waitFor(predicate, timeoutMs)`（`:38-45`）。`workDir` 参数化（不依赖文件级变量） |
| `test/ipc-server.test.ts`（新增） | §8.2 的全部用例；顶部含 §7.2 的 electron mock |
| `test/ipc-declaration.test.ts`（修改，**只加**） | V15 的声明侧两条 |
| `test/manifest.test.ts`（修改，**只加**） | V15 的清单侧一条 |
| `test/ipc-transport.test.ts` | **不改**（#43 不动它；其三个工具已复制到 helper） |
| `test/manifest-script-parity.test.ts` | **不改**（fixture 与门禁一字不动） |

### 8.2 `test/ipc-server.test.ts` 用例清单（逐条对应 V1–V9/V13/V14/V16/V17）

| # | 用例名（含 spec 的 `-t` 关键字） | 断言要点 | 真实 socket？ | 平台 |
| --- | --- | --- | --- | --- |
| 1 | `多客户端：两条真实连接各自定向 request 互不串包，各触发一次 onConnection`（V1） | 两个对端各自收到自己的 `request`；`events` 里 `connection` 事件 2 次且两个 ID 不同；`request` 事件带 `connectionId` 且与发起连接对应（D1）；经 `ipc:reply` 回包后对端拿到各自结果 | 是（helper） | 两平台 |
| 2 | `广播：全部连接收到同一条通知；无连接时静默成功`（V2） | 两个对端都收到 `{jsonrpc:'2.0',method,params}`（**无 `id`** = 通知）；`broadcast` resolve；关掉两个对端后再广播 → resolve、无异常、无 `not-connected` | 是 | 两平台 |
| 3 | `广播：client 通道名 → invalid-declaration；不存在的名字 → not-connected`（R12） | `broadcastExtensionChannel` 抛错码断言（只锁前缀） | 否（可用 `ipc:listen` + 一个 client 通道） | 两平台 |
| 4 | `并发：4 条连接同时连入并各自 request，onConnection 次数 = 连接数`（V3） | 4 个 socket 并发；`connection` 事件 4 次；4 个请求各自成功 | 是 | 两平台 |
| 5 | `单连接断开：被断开那条恰好一次 onDisconnect，其余连接后续 request 仍成功`（V4） | `disconnect` 事件恰好 1 次、code `peer-crashed`；其它连接的 `requestExtensionChannel` 仍 resolve | 是 | 两平台 |
| 6 | `端点被占用：第二次 listen 抛 connect-failed（含"已被占用"），不删除活着的端点`（V5） | 第一条 server 正常；第二次 `openExtensionServer` 抛 `connect-failed`；断言第一台 server 的连接仍可用；POSIX 额外断言 `.sock` **仍存在**（`fs.stat` 成功） | 是 | 两平台（POSIX 分支断言文件，Windows 只断言错误码与文案） |
| 7 | `陈旧端点：POSIX 清理残留 .sock 并 chmod 0600；Windows 不清理不 chmod`（V6） | POSIX：先 `fs.writeFile('<workDir>/obox-stale.sock','')` → `listen` 成功 → `(await fs.stat(ep)).mode & 0o777 === 0o600`；Windows：`endpointPrepPlan('win32')` 断言 `{probeStale:false,chmod:false}` 且**不**触碰任何文件 | 是（POSIX 分支） | 用例名**同时**在 Windows 命中（Windows 只跑后半段断言），避免 `-t "陈旧"` 在 CI（windows-latest）匹配不到任何用例 |
| 8 | `连接数上限：第 17 条收到错误帧后断开，不触发 onConnection`（V7） | 建 16 条；第 17 条对端读到 `{id:null,error:{code:-32603,message:/\[too-many-connections\]/}}` 后 `close`；`connection` 事件恰好 16 次、`disconnect` 事件 0 次；前 16 条各发一次 request 仍成功；断言 `MAX_CONNECTIONS_PER_SERVER === 16` | 是 | 两平台 |
| 9 | `连接数上限（注入小上限）：maxConnections=2 时第 3 条被拒、第 1/2 条不受影响`（补充 R8 边界） | 直接 `openPipeServerTransport({maxConnections:2})`（不经 `ipc.ts`） | 是 | 两平台 |
| 10 | `closeExtensionIpc：关闭该扩展的全部 server 与连接，端点不再可连`（V8） | `closeExtensionIpc(extId)` 后：所有对端 socket 收到 `close`；`channels()`（`listExtensionChannels`）为空；新连接被拒（`connect-failed`）；POSIX 端点文件被 unlink（`fs.stat` 抛 `ENOENT`） | 是 | 两平台 |
| 11 | `close(name)：幂等、不存在静默成功、server 与 client 都按名字关闭`（R3） | 连续两次 `closeExtensionChannel` 不抛错；不存在的名字不抛错；server 名 → 连接全断 | 是 | 两平台 |
| 12 | `对端崩溃与非法帧：该连接以 peer-crashed / protocol-error 关闭并触发一次 onDisconnect，server 仍可接受新连接`（V9） | ①对端 `socket.destroy()` → `disconnect{peer-crashed}`；②新对端发一个坏帧（`Content-Length: 5\r\n\r\nxx` 后跟非法 JSON）→ `disconnect{protocol-error}` 且该 socket 被销毁；③之后新连接仍能连上并 request 成功 | 是 | 两平台 |
| 13 | `超时：server 连接上的 request 在对端不回包时以 timeout 失败（默认口径不变），该连接与其它连接此后仍可用`（V13） | `requestExtensionChannel(..., {timeoutMs: 80})` reject 码 `timeout`；随后同一连接再发一个会回包的 method 成功；`DEFAULT_TIMEOUT_MS === 30_000` 断言 | 是 | 两平台 |
| 14 | `invalid-declaration 三例：listen 传 stdio / server 名省略 connectionId / client 通道传 connectionId`（V14） | 三例都只锁 `/^\[invalid-declaration\]/`；① 在 `assertChannelSlot` 之前就抛（用一个**已占用**的名字 + `transport:'stdio'` 断言仍报 `invalid-declaration` 而非"已打开"，钉死判定顺序）；② ③ 用真 server + 一个 client 通道 | 部分是（②③需 server） | 两平台 |
| 15 | `在途请求：连接断开瞬间转发条目立即结算（不重放），新连接拿新 ID 且不再收到该请求`（V16） | 对端 A 发请求 → `events` 拿到 `requestId` 与 `connectionId`；**不回包**；销毁 A 的 socket → `pendingForwardCount() === 0`（不等 30s）；A 重连（新 socket）→ 新 `connection` 事件的 `connectionId` 严格大于旧值；新 socket 此后**没有**收到任何重复请求（读超时 100ms 无数据 = 通过） | 是 | 两平台 |
| 16 | `连接 ID：单调递增且不复用（关闭 server 后重新 listen，新 ID 严格大于此前全部 ID）`（V17） | `resetConnectionIdCounterForTest()` → 连 1 条（ID=1） → `closeExtensionChannel` → 重新 `openExtensionServer` 同名端点 → 新连接 ID **> 1**（不断言"=2"：给 D4 留余地）；旧 ID 不再出现在任何 `connection`/`disconnect` 事件里 | 是 | 两平台 |
| 17 | `平台分叉：endpointPrepPlan 三分支 + ipcEndpoint 不含 suffix（两平台）`（R2/R11） | `endpointPrepPlan('win32'|'linux'|'darwin')`；`ipcEndpoint({socketDir,extensionId,name,'suffix':undefined})` 与带 suffix 的值不同、且不带 suffix 的形态与 `endpointFor` 的工具一致 | 否（纯函数） | 两平台 |
| 18 | `pendingForwardCount：转发超时后归零（既有 30s 口径）`（诊断出口自检） | 用 `vi.useFakeTimers()` 推进 30s → 计数归零、对端收到 `-32603` 回包 | 是 | 两平台 |

### 8.3 既有两个测试文件的**新增**用例（V15 的锁死）

| 文件 | 用例名（含 `-t "未知键|mode"` 的关键字） | 断言 |
| --- | --- | --- |
| `test/ipc-declaration.test.ts` | `未知键：清单形状带 mode 不报错，且归一化后的声明不含 mode（Q2=A 锁死）` | ① `validateIpcDeclaration({id:'bus',transport:'pipe',mode:'server'})` **不抛错** 且 deep-equal `{id:'bus',transport:'pipe'}`（证明"逐键白名单读取、未知键静默忽略"）；② `checkIpcChannelList([{id:'bus',transport:'pipe',mode:'server'}]).ok === true`；③ 再断言 `'mode' in checkIpcChannelList(...).declarations[0] === false` |
| `test/manifest.test.ts` | `未知键：contributes.ipcChannels 项带 mode 时清单仍然有效` | `errors({...valid, contributes:{ipcChannels:[{id:'bus',transport:'pipe',mode:'server'}]}})` deep-equal `[]`（无 error） |

**这两条用例是 R15 的"锁死"**：将来若有人给声明加 `mode` 语义，必须先让这两条红，从而被迫回到 spec。

### 8.4 哪些用例需要真实 socket、哪些在 Windows 会 skip

| 类别 | 用例 | 说明 |
| --- | --- | --- |
| **必须真实命名管道 / UDS** | 8.2 的 #1–#6、#8–#16、#18 | 用 `test/helpers/ipcPeers.ts` 的真 `net.createServer` + `openPipeServerTransport`；Windows 走 `\\.\pipe\obox-*`，POSIX 走临时目录 `.sock` |
| **纯函数（无 socket）** | #3（可用 mock 层）、#17 | 可在 CI（windows-latest）稳定覆盖两平台分支 |
| **Windows 上 skip 的部分** | #7 的 POSIX 段 | 同一用例内用 `if (process.platform === 'win32') { /* 断言 win 分支 */ return }` **而不是** `it.skip`：`it.skip` 会让 `-t "陈旧"` 在 Windows CI 上匹配不到用例（验收命令的退出码风险） |
| **POSIX 才跑** | #6、#10 的"端点文件存在/unlink"断言段 | 同上写作条件断言，不用 `it.skip` |
| **CI 覆盖缺口（明写）** | 所有 POSIX-only 分支 | CI 只在 windows-latest 跑（`.github/workflows/pr-check.yml:20`），POSIX 真机分支由开发者在 macOS/Linux 本地跑并在 PR 描述里贴结果 |

---

## 9. 文件与所有权（含 #43 → #44 的串行依赖）

### 9.1 逐文件改动点

| 文件 | 动作 | 改动点（现状行 → 内容） |
| --- | --- | --- |
| `src/main/ipcServer.ts` | **新增** | `nextConnectionId`（模块级）、`resetConnectionIdCounterForTest`、`endpointPrepPlan`、`probeEndpointAlive`、`openPipeServerTransport`、`IpcServerHandles`/`IpcServerConnection`/`PipeServerOptions`、超限拒绝帧、§4.5 的单连接收尾 |
| `src/main/ipc.ts` | 修改 | `:33` 后加 `MAX_CONNECTIONS_PER_SERVER = 16`；`:37-39` `OpenChannel` 判别联合；`:42-45` `pendingReplies` 加 `connectionId`；`:76-82` `requireChannel` → `requireClientTransport`/`requireServer`/`resolveTarget`（**保留 `requireChannel` 的既有文案**：`通道不存在或未连接: …`）；`:84-105` `forwardInboundRequest` 加 `connectionId` 参数与事件字段 + 新增 `failForwardedForConnection`；`:108-120` `assertChannelSlot` 不变；`:126-145` `registerChannel` 不变；`:148-186` `openExtensionChannel` 仅**保持 `:152` 单独一行**（不合并）；新增 `openExtensionServer`/`registerServer`（插在 `:186` 与 `:195` 之间）；`:216-224` `closeExtensionChannel` 改统一语义；`:226-232` `closeExtensionIpc` 一并关 server；`:234-237` `listExtensionChannels` 不变；新增 `broadcastExtensionChannel`/`requestExtensionChannel`/`notifyExtensionChannel`/`pendingForwardCount`；`:239-309` `registerIpcBridge` 加两个 `handle` 并改三个的签名/体 |
| `src/main/ipcCore.ts` | 修改 | `:41` 后加 `'too-many-connections'`（含注释）；其余**不动** |
| `src/main/ipcTransport.ts` | **不改** | §3.4 表（M2 收敛） |
| `src/shared/types.ts` | 修改 | `:354-380` 加 `ipcListen`/`ipcBroadcast`、`ipcRequest`/`ipcNotify` 加末位 `connectionId`；`:471-483` `IpcEvent` 加两种成员（+`request` 加可选 `connectionId`，D1）；`:453-462` `IpcChannelDeclaration` **不改** |
| `src/preload/index.ts` | 修改 | `:32-40` 加 `ipcListen`/`ipcBroadcast`，`ipcRequest`/`ipcNotify` 透传末位 `connectionId` |
| `src/api/types.ts` | 修改 | `:394-418` 整块替换为 §3.1；doc 注释错误码列表加 `too-many-connections` |
| `src/renderer/src/core/host.ts` | 修改 | `:1156-1161` `ChannelListeners` 加两个集合；`:1162-1174` 建表处加两个 `Set`；`:1176-1206` 分发加两个分支；`listen`/`broadcast` 两个新成员；`request`/`notify` 透传 `connectionId`；`onConnection`/`onDisconnect` |
| `src/shared/ipcDeclaration.ts` | **不改** | Q2=A（R15） |
| `src/renderer/src/core/manifest.ts` | **不改** | Q2=A（R15） |
| `test/helpers/ipcPeers.ts` | **新增** | §8.1 |
| `test/ipc-server.test.ts` | **新增** | §8.2 |
| `test/ipc-declaration.test.ts` | 修改（**只加**） | §8.3 第 1 条 |
| `test/manifest.test.ts` | 修改（**只加**） | §8.3 第 2 条 |
| `test/ipc-transport.test.ts`、`test/manifest-script-parity.test.ts`、`scripts/validate-manifest.mjs` | **不改** | R15/V10 |
| `skills/obox-ext-dev/references/api-reference.md` | 修改 | §11.1 |
| `skills/obox-ext-dev/references/troubleshooting.md` | 修改 | §11.2 |
| `skills/obox-ext-dev/references/manifest-reference.md` | **不改** | Q2=A |
| `docs/adr/0016-ipc-transport-and-protocol.md` | 修改 | §10 |
| `README.md` | 修改 | `:43` 后加一行 `ipcServer.ts`（目录结构变化，`AGENTS.md` README 要求） |

### 9.2 #43 → #44 的串行依赖（#44 的哪条需求建立在 #43 的哪条之上）

| #44 需求 | 依赖 #43 的 | 依赖内容 |
| --- | --- | --- |
| R8（客户端通道**没有** `connectionId`） | **#43 R7** | 连接 ID 的命名空间只属于"服务端接受的连接" |
| R10（`close(name)` 在重连窗口期的统一语义） | **#43 R3** | 统一 `close(name)` 已定型；#44 只在其中加"取消重连" |
| R9 / R17④（`channels()` 语义包含 server 名） | **#43 R19** | `channels()` 的记账口径 |
| R6（重连期 `not-connected`） | **#43 R6** | `resolveTarget`/`requireClientTransport` 的分流结构（#44 在 client 分支加"窗口期"判定） |
| R5（在途请求不重放） | **#43 R18** | 服务端侧的失败传播顺序（§4.5）即客户端侧要照搬的同一顺序 |
| R14（`IpcEvent` 加第 7 种成员 `reconnect`） | **#43 R14** | 两种新成员已在同一联合里（追加不冲突） |
| R18（清单来源声明的白名单归一化） | **#43 R15 + #43 R1** | ① #43 已把 `listen` 的校验调用与 `connect` 的校验调用放在**同一函数族的独立行**；② #43 未动 `resolveIpcChannelDeclaration`，其"原样透传"缺陷（F12）在 #43 落地后仍然存在，#44 才修 |
| R2/R12（`autoReconnect` 校验、stdio 拒绝） | **#43 R1/R2** | 运行时校验入口（`ipc.ts:152`）与 `listen` 的"传输角色"校验在同一层，风格一致（先判 transport 再判其余） |
| R3（只对 pipe 生效） | #43 N7/N2 | 端点推导（无 suffix）与"服务端连接不自动重连"的边界 |
| 测试基建 | #43 新增物 | `test/helpers/ipcPeers.ts`（真实对端工具）+ §7.2 的 electron mock 写法 |

---

## 10. ADR 修订计划（`docs/adr/0016-ipc-transport-and-protocol.md`，**修订不新开**）

| # | 位置（现状行） | 动作 | 要点（逐条写进 ADR） |
| --- | --- | --- | --- |
| A1 | `:20-25`「本期明确不做」 | **删除**该列表里的第 1 条（"**pipe 服务端 / 多客户端**…"），把"自动重连"条保留（#44 再删） | 只删这一条，其余三条（自动重连 / manifest 声明通道 / 沙箱化）留在原位，供 #44 接着删 |
| A2 | 决策区（`:9-11`）之后 | **新增**决策 9「pipe 服务端（多连接）」 | ① 宿主可作为服务端 listen 一个 pipe 端点，接受多条连接；② 每条连接一个独立 `JsonRpcChannel`（协议零改动）；③ 连接 ID 进程内单调递增、**永不复用**（Q1）；④ 单 server 连接上限 16，第 17 条回 `-32603` + `[too-many-connections]` 后关闭，不触发事件；⑤ 定向（`opts.connectionId`）与广播（`broadcast`，**通知语义**）；⑥ `close(name)` = 按名字关闭该名字下的一切；⑦ 统一命名空间：server 占 1 条通道额度，连接只计 16；⑧ 端点**不暴露** `suffix`（R2/N7） |
| A3 | 决策 7（`:17`「限额与治理」） | **改写** | 补：每扩展 4 条通道 **含 server（一条 server 只占 1 条）**；每 server 最多 16 条连接（连接不计入 4 条上限） |
| A4 | 后果（`:27-31`） | 增补 | ① 平台差异：Windows 命名管道无落盘文件（不清理、不 chmod）；POSIX 在 listen 前试连探测陈旧 `.sock`（活的→`connect-failed` 且不删；死的→unlink），listen 成功 `chmod 0600`；② 退出/停用清理沿用 `cleanupExtensionResources`（`extensionCleanup.ts:23-30`），无新的清理时机 |
| A5 | 后果·不变量（`:31`） | **改写** | 错误码闭集 11 → **12**，插入 `too-many-connections`；并补两条不变量：**在途请求不重放**（连接断开瞬间双向挂起请求以断因码失败）、**连接 ID 单调且永不复用** |
| A6 | 新小节「服务端连接的生命周期」（建议插在「后果」之后、`Status` 之前） | **新增** | 逐条：accept → `connection` 事件；超限拒绝不发事件；断开 → `disconnect` 事件恰好一次；宿主 `close`/停用/退出 → `channel-closed`；**宿主不自动重连服务端连接**（对端回来 = 新连接、新 ID，与 #44 的客户端重连是两回事） |
| A7 | `Status: accepted`（`:33`） | 保留 | 修订既有 ADR，不新增文件、不改编号 |

**不新开 ADR 的理由**（与 spec §4 一致，写进 ADR 的修订说明）：本项是 0016 自己预留的后续项（`:22`），不构成"难以逆转 / 无背景者会觉得奇怪 / 存在真实取舍"的新决策（`workflow.md:86`）。

---

## 11. skill 文档同步要点（逐条）

### 11.1 `skills/obox-ext-dev/references/api-reference.md`

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `:597-642` 的 `api.ipc` 代码块 | 在"3) 请求 / 通知"之后插一段**服务端示例**：`await api.ipc.listen({id:'svc',transport:'pipe'})` → `api.ipc.onConnection('svc', id => …)` → `api.ipc.request('svc','ping',{},{connectionId:id})` → `api.ipc.broadcast('svc','tick',{n:1})` → `api.ipc.onDisconnect('svc',(id,err)=>…)` → `await api.ipc.close('svc')` |
| 2 | `:653` 限额行 | 追加："每扩展最多 4 条通道（**server 与 client 共用**，一条 server 只占 1 条）；单个 server 最多 **16 条连接**（连接不计入 4 条上限，第 17 条被拒）；**顺手改正**该行原有的 `src/main/ipc.ts:27` → `:33`"（§2.2 C1） |
| 3 | `:654` 错误码行 | 加入 `too-many-connections`（列表 11 → 12 个） |
| 4 | 新小节 `### api.ipc 服务端（多连接）` | 内容：`listen` 的约束（只 pipe、名字唯一、framing 共用、无 suffix）；`connectionId` 的语义（递增、不复用、三元组内解释）与"宿主不自动重连"；定向 vs 广播（**广播是通知、不收集回包**，要定向请求用 `request(...,{connectionId})`）；`close(name)` 的统一语义与幂等；**平台差异**（Windows 命名管道不落盘/不 chmod；POSIX `.sock` 0600 + 陈旧文件由服务端清理）；**限额与"任何同机进程可连"的能力边界**（ADR-0015，不做对端鉴权） |
| 5 | 同小节 | **特性检测建议一句话**（§12 R-1）：`typeof api.ipc.listen === 'function'` 才调用，否则提示"宿主版本不支持 pipe 服务端" |

### 11.2 `skills/obox-ext-dev/references/troubleshooting.md`

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `:268-292`（#25 `api.ipc` 一节） | 在错误码表后新增 4 条**服务端**条目：① `connect-failed` + "已被占用" → 上一次残留的服务端/另一个进程占着端点（POSIX 看 `<userData>/ipc/obox-<扩展id>-<通道名>.sock`；Windows 看是否有旧实例仍活着）；② POSIX 陈旧 `.sock` 与权限（`0600`，属于**服务端**清理职责，客户端不删别人的文件）；③ **连接超限**：对端收到 `[too-many-connections]`（说明该 server 已有 16 条连接），先断开不用的对端或让扩展侧限流；④ `invalid-declaration` 的两条**服务端专属**原因：`listen` 传了 `stdio`、server 名字下 `request/notify` 没给 `connectionId`（或反过来给 client 通道传了 `connectionId`） |
| 2 | `:283-284` 平台细节 | 补一句：服务端 `listen` 会**自己**处理陈旧 `.sock`（探测→清理→`chmod 0600`），因此"客户端不删别人的套接字文件"这条不变，但**服务端**要负责清理 |
| 3 | `:292` 孤儿进程条目 | 补一句：宿主被强杀时，POSIX 的 `.sock` 会残留但**下次 `listen` 会自愈**（探测到没人应答就 unlink）；Windows 命名管道随进程消失 |

**`manifest-reference.md` 与 `scripts/validate-manifest.mjs` 一行都不改**（Q2=A；`:253-279` 保持原样）。

---

## 12. 风险与回退

| # | 风险 | 影响 | 处置（本次） | 回退方式（能否独立回滚） |
| --- | --- | --- | --- | --- |
| R-1 | **新扩展 + 旧宿主**：旧宿主没有 `api.ipc.listen` → 扩展调它得到 `TypeError: api.ipc.listen is not a function`（因为 Q2=A 不改清单、`apiVersion` 仍为 1，无法用版本号门槛） | 响亮失败（不静默降级） | api-reference 明写**特性检测**（§11.1 第 5 条）；不递增 `apiVersion`（ADR-0010 决策 4） | 独立回滚：无（属"旧宿主不支持"的固有限制）；文档层面可改文案 |
| R-2 | **旧扩展 + 新宿主**：`close(name)` 语义由"关 client 通道"扩为"关该名字下的一切" | 对只开 client 通道的扩展**行为完全相同**（`ipc.ts:217-224` 的 dispose 路径未变）；`IpcEvent` 新增成员不会被旧扩展的宿主侧代码消费（渲染进程与主进程同一次构建，不存在跨版本混用） | 无需兼容垫片；lock-down 由 V10（既有 `test/ipc-*` 全绿）保证 | 独立回滚：是（revert 单个 commit 即回到 `722cebc` 行为；无持久化状态、无迁移） |
| R-3 | **并发上限**：第 17 条被拒只对**对端**可见，扩展侧看不到"有人在敲门" | 扩展可能不知道为什么某个对端连不上 | 拒绝帧文案带 `[too-many-connections]`（对端可自诊断）；api-reference 写明 16 上限 | 独立回滚：是（改常量 + 删用例） |
| R-4 | **孤儿进程 / 端点残留**：宿主被强杀后 POSIX 留 `.sock`；对端进程仍活着并重试连接 | 下次 `listen` 若误判"活着"会报"已被占用"而无法启动 | §6.2 的探测语义：**连不上才删**（活着的绝不删）；`EADDRINUSE` 重试一次；troubleshooting 条目（§11.2 第 3 条） | 独立回滚：是（探测逻辑集中在 `ipcServer.ts` 的 3 个函数） |
| R-5 | **语义混淆**："服务端连接不重连" vs #44 的"客户端通道可重连" | 用户/扩展作者可能以为给 server 开个开关也能重连 | ADR-0016 新小节（§10 A6）明写；api-reference 的 `onDisconnect` 注释明写（§3.1）；**不提供**任何服务端重连开关 | 独立回滚：是（文档） |
| R-6 | **不重放语义对既有扩展的影响**：R18 只对**新增的** server 连接生效；client 通道既有行为（断开即 reject 挂起）不变 | 无行为变更 | V10 全量回归 + V16 锁死 | 独立回滚：是 |
| R-7 | **广播写背压**（K4）：16 条连接 × 8MB 上限，`socket.write` 返回 false 时本期不排队 | 极大消息可能丢/延迟 | 本期不做背压队列（N6）；`message-too-large` 按 D5 只跳过该连接并记日志；写失败（套接字层）按该连接断开处理 | 独立回滚：是 |
| R-8 | **测试缝隙风险**：electron mock 万一不可用，V8/V14/V16/V17 无法在 vitest 里测 | 验收命令 `-t closeExtensionIpc` 等会失守 | §7.4 的 15 分钟预检 + 备选方案 B（提取 `ipcRegistry.ts`） | 回退 = 方案 B（范围扩张，需用户批准；不影响已落地的 `ipcServer.ts`） |
| R-9 | **`pendingForwardCount` 是为测试新增的导出**（生产无用） | 轻微 API 面污染（主进程内部，非扩展契约） | 照既有先例（`hookBridge.pendingCount`，`src/main/hookBridge.ts:66-67` 明确标"诊断与测试用"） | 独立回滚：是（删导出 + 改用例断言方式） |
| R-10 | **`disconnect` 在宿主主动关闭时也触发**（D3） | 扩展卸载瞬间收到一批回调 | host 侧 `listeners.delete(name)` 在 `close()` 时清空（`:1225`），实际到达扩展的回调取决于时序；文档明写语义 | 独立回滚：是 |

---

## 13. 真机验证步骤（V11、V12 必须项）

### V11 回归：真实扩展的 pipe **客户端**仍可用

| 步 | 命令 / 操作 | 可观察现象 |
| --- | --- | --- |
| 1 | 取一个用 `api.ipc.connect({transport:'pipe'})` 的扩展（或临时造一个：`connect({id:'svc',transport:'pipe'})`） | — |
| 2 | 在**另一个**终端起对端服务端：把 `test/ipc-transport.test.ts:84-128` 的 `createServer`/`endpointFor`/`listen` 三个工具抄进一个 `.cjs` 脚本，端点为 `\\.\pipe\obox-<扩展id>-svc`（Windows）或 `<userData>/ipc/obox-<扩展id>-svc.sock`（POSIX），收到 `ping` 回 `pong` | 脚本打印"listening" |
| 3 | `npm run dev`，启用该扩展，触发一次 `api.ipc.request('svc','ping')` | 请求成功返回 `pong`；输出面板无新增告警；`await api.ipc.channels()` 仍返回 `['svc']` |
| 4 | 关闭对端脚本 | `onClose` 回调触发一次（`peer-crashed`），与改动前一致 |
| 5 | 判据 | 以上四步的现象与 `722cebc` 上**完全一致**；`git diff` 里没有 `ipcTransport.ts`（本次不改它） |

### V12 端到端：服务端 listen + 多客户端 + 广播 + 断开

| 步 | 命令 / 操作 | 可观察现象 |
| --- | --- | --- |
| 1 | 造一个最小用户扩展（`<debugDir>/manifest.json` + `index.js`），`index.js` 里：`await api.ipc.listen({id:'svc',transport:'pipe'})`；`api.ipc.onConnection('svc', id => api.output.append?.(...))`（或 `console.log`）；`api.ipc.onDisconnect('svc',(id,err)=>console.log(id,err.code))`；`api.ipc.onRequest('svc',(m,p)=>({echo:p,conn:...}))` | — |
| 2 | `npm run dev -- -- --debug-extension <id>@<debugDir>` 启用该扩展（**两个 `--`**：第一个交给 npm，第二个才是 electron-vite 的 `--`；单 `--` 实测传不进去） | 扩展激活无错；`await api.ipc.channels()` 含 `'svc'` |
| 3 | 起**两个**对端脚本分别连 `\\.\pipe\obox-<扩展id>-svc`（Windows）/ `<userData>/ipc/obox-<扩展id>-svc.sock`（POSIX）；各自发一次 `request` | 两个对端**各自**拿到自己的回包（不串包）；扩展日志里出现两次 `onConnection`，ID 分别为 `1`、`2`（**不复用**） |
| 4 | 扩展触发 `api.ipc.broadcast('svc','tick',{n:1})` | 两个对端都收到 `{jsonrpc:'2.0',method:'tick',params:{n:1}}`（**无 `id`**）；扩展侧无异常；无对端连接时再广播一次也**不抛错** |
| 5 | POSIX：`ls -l "<userData>/ipc/obox-<扩展id>-svc.sock"` | 权限为 `srw-------`（`0600`） |
| 6 | 强杀其中一个对端（`taskkill /F` / `kill -9`） | 扩展收到**一次** `onDisconnect(id, {code:'peer-crashed'})`；另一个对端**仍能**继续 `request` 成功 |
| 7 | 停用该扩展 | 另一个对端 socket 收到关闭；POSIX 的 `.sock` 文件消失；再次 `listen` 能成功 |
| 8 | 第 17 条连接（可选，用脚本连开 17 条） | 第 17 条收到 `{code:-32603,message:"[too-many-connections] …"}` 后断开；扩展侧**没有**第 17 次 `onConnection` |
| 9 | 判据（`workflow.md:78`） | 以上现象全部观察到才算通过；**未做**则设计/实现结论必须标注「未验证」 |

---

## 14. 实施顺序（每步一个可提交状态）

| 步 | 内容 | 验收命令 | 为什么这个顺序 |
| --- | --- | --- | --- |
| 0 | **预检**：写 `test/ipc-server.test.ts` 骨架（§7.2 mock + `registerIpcBridge` + `ipc:list` 断言） | `npx vitest run test/ipc-server.test.ts` | 先验 §7 的缝隙（R-8），失败立刻改道方案 B，避免写完 600 行才发现测不了 |
| 1 | `ipcCore.ts` 加错误码；`ipcServer.ts` 骨架（`endpointPrepPlan` + `probeEndpointAlive` + `openPipeServerTransport` 的 listen/accept/超限拒绝/dispose，无 `ipc.ts` 接线） | `npx vitest run test/ipc-core.test.ts test/ipc-server.test.ts -t "平台分叉\|连接数上限"` | 先把 electron-free 的核心与平台分支测绿，再接壳 |
| 2 | `ipc.ts`：`OpenChannel` 联合 + `registerServer` + `openExtensionServer` + 统一 `closeExtensionChannel`/`closeExtensionIpc` + 事件广播 | `npx vitest run test/ipc-server.test.ts -t "多客户端\|并发\|单连接断开\|closeExtensionIpc\|close(name)"` | V1/V3/V4/V8/V11 是主路径 |
| 3 | `resolveTarget` + `request/notify/broadcast`（含三例 `invalid-declaration`） | `npx vitest run test/ipc-server.test.ts -t "invalid-declaration\|广播\|超时"` | V14/V2/V13 |
| 4 | `forwardInboundRequest` 带 `connectionId` + `failForwardedForConnection` + `pendingForwardCount` | `npx vitest run test/ipc-server.test.ts -t "在途请求"` | V16 是 R18 的核心锁 |
| 5 | V5/V6/V7/V9/V17 的真实 socket 用例补齐（含 POSIX 条件断言） | `npx vitest run test/ipc-server.test.ts` | 全文件绿 |
| 6 | V15 的锁死用例（两个既有测试文件**只加**） | `npx vitest run test/ipc-declaration.test.ts test/manifest.test.ts -t "未知键\|mode"` | 清单静默行为锁死 |
| 7 | `src/api/types.ts` / `src/shared/types.ts` / `src/preload/index.ts` / `host.ts` 的 API 面 | `npm run typecheck` + `npm run lint` | 类型/桥面一次改齐（三端同一次构建） |
| 8 | 文档：api-reference / troubleshooting / ADR-0016 / README（含 §2.2 C1 的行号改正） | 人工核对 + `npm run lint`（markdown 不参与 lint，靠人读） | R17/V12 |
| 9 | 三道门禁 + 真机 V11/V12 | `npm run typecheck` && `npm run lint` && `npm test`；§13 | V10 + 真机（`workflow.md:78`） |
| 10 | 提交/PR（`docs/xxx` 或 `feat/xxx` 分支）、独立子代理审视（`workflow.md:82`）、ADR 归档、清空 `tmp/` | `.github/workflows/pr-check.yml` 的 `check` | 收尾 |

---

## 15. 待定项汇总（本文档标注的 7 处 `【设计待定：需在实现前确认】`）

| # | 待定项 | 推荐值 | 一句话理由 |
| --- | --- | --- | --- |
| D1 | `IpcEvent.request` 是否增 `connectionId?` | **增可选字段** | R4 要求带上、R14 的意图是向后兼容，可选字段同时满足 |
| D2 | 扩展侧 `onRequest` 是否收到 `connectionId` | **本期不扩签名**（若要扩：第三参 `ctx:{connectionId?:number}`） | spec 未定义 → 不越界；本期只有出站方向需要 ID |
| D3 | 宿主主动关闭 server 时是否触发 `onDisconnect` | **触发，`code='channel-closed'`** | 与既有 client 通道主动 `close()` 的行为一致，且 R18"恰好一次"无例外 |
| D4 | 第 17 条连接是否分配 `connectionId` | **不分配** | R8 说"从未被接受"；浪费 ID 无收益 |
| D5 | `broadcast` 遇 `message-too-large` 是否断开该连接 | **不断开**（只跳过 + 记日志），只有套接字层写失败才断 | 消息校验失败与连接健康无关，断开会造成连锁误伤 |
| D6 | 新文案的逐字值 | 见 §5.1/§5.3 的推荐值 | 稳定码前缀由 `IpcCoreError` 保证；测试只锁前缀 |
| D7 | 测试缝隙（electron mock vs 提取 `ipcRegistry.ts`） | **mock（方案 A）**，预检失败才切方案 B | 不动生产结构即可测到 V8/V14/V16/V17；备选与触发条件见 §7.3/§7.4 |
