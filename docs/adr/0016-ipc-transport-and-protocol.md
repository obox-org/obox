# 扩展与外部进程的 IPC：传输与协议选型

## 背景

扩展此前只能写 JavaScript：宿主在渲染进程里动态 `import` 扩展入口，能力面全是 JS；唯一的"外部进程"先例是卸载钩子（`spawn(process.execPath, [hook], { stdio: 'ignore' })`，单向、无协议、5 秒强杀）。要与**常驻的、可能是别的语言写的**进程双向通信时既没有通道，也不想为此开本地 TCP 端口（端口冲突、防火墙、鉴权、端口分配与回收）。相关决策：ADR-0015（扩展受信、能力不是安全边界）、ADR-0004（两阶段启动）。

## 决策

1. **不使用 TCP/HTTP/WebSocket**。传输只有两种，都不占端口：
   - **stdio**（默认）：宿主 `spawn` 子进程，用其 stdin/stdout 承载协议、stderr 作日志。任何语言只要会读写标准输入输出即可接入。
   - **pipe**：`node:net` 的 IPC 支持，用于连接**已在运行**的进程。Windows：`\\.\pipe\obox-<扩展id>-<通道名>`（内核命名空间，无落盘文件）；POSIX：`<userData>/ipc/obox-<扩展id>-<通道名>.sock`（需清理陈旧文件、权限 0600）。
2. **协议统一 JSON-RPC 2.0**（请求/响应/错误/通知四种形状），**双向**：对端也能向宿主发请求，宿主转发到渲染进程里的扩展处理器并回包。
3. **分帧两种**：`Content-Length: <n>\r\n\r\n<payload>`（默认，LSP 同款、二进制安全）与换行分隔 JSON（脚本友好）。分帧是最易错的部分，因此**单测覆盖半包/粘包/超长帧头/非法帧头/CRLF/空行/两种模式**。
4. **不引入框架（本期）**：传输用 Node 内置（`child_process` / `node:net`），协议自研薄实现。理由：项目运行时依赖只有 6 个且以零依赖为先；ZeroMQ 需原生二进制、Windows `ipc://` 另有坑，gRPC 需 protobuf 与代码生成，`node-ipc` 历史上有回退 TCP 的行为——都与"简单、无端口"相悖。
5. **升级路径（明确记录）**：若后续需要请求取消的完整语义、进度流、大消息流式，则引入 **`vscode-jsonrpc`**（基于流、无端口、LSP 同款）替换自研分帧与关联层，传输层不变。
6. **薄壳 vs 核心**：协议/分帧/通道状态机（`ipcCore.ts`）与字节搬运（`ipcTransport.ts`）**都不依赖 electron**，因此可用真实子进程与真实命名管道单测；`ipc.ts` 只是注册表、限额、生命周期与 Electron 接线。
7. **限额与治理**（与 `timer` / `fs.watch` 同一风格）：每扩展最多 4 条通道（**server 与 client 共用**同一个名字空间，一条 server 只占 1 条）、每个 pipe 服务端最多 16 条连接（连接**不计入** 4 条通道上限）、每通道并发请求上限、单条消息上限 8MB（与 `api.net.fetch` 一致）、请求默认 30s 超时；扩展停用/卸载/重载时统一断开并终止由宿主拉起的进程。
8. **便利约定**：`.js/.cjs/.mjs` 形式的 `program` 由宿主自带的 Node 运行（扩展无需自带解释器）；其它一律直接执行（编译产物或系统可执行文件）。
9. **pipe 服务端（多连接）**（issue #43，修订本 ADR，不新开）：
   - 宿主可作为**服务端** `listen` 一个 pipe 端点（`api.ipc.listen(declaration)`，只接受 `transport: 'pipe'`），接受**多条**对端连接；
   - 每条连接一个**独立的 `JsonRpcChannel`**（协议零改动），连接的请求-响应互不串包；
   - 每条被接受的连接有一个**进程内单调递增、永不复用**的数字 `connectionId`（模块级计数器，从 1 起；同名 server 关闭后重建也不复用）；被超限拒绝的连接**不分配** ID、不触发任何事件；
   - 上限 16 条连接；第 17 条由宿主先写一条 `{jsonrpc:'2.0', id:null, error:{code:-32603, message:'[too-many-connections] …'}}`（用该 server 声明的 framing 编码，**不新增线上整数码**）再关闭套接字；
   - **定向**：`request` / `notify` 的 `opts.connectionId` 指向某条连接；**广播**：`broadcast(name, method, params)` 向当前全部连接各发一条**通知**（不收集回包）；
   - `close(name)` 统一为"按名字关闭该名字下的**一切**"（client 通道或 server），不存在时静默成功、幂等；
   - 端点**不暴露** `suffix`（服务端用不带 suffix 的稳定端点；`ipcEndpoint()` 的 `suffix` 留给未来多实例场景）。

## 本期明确不做（留待后续，避免半成品语义）

- **自动重连**：当前是"断开即报 `peer-crashed`/`channel-closed`，扩展自行重新 `connect()`"。真正的自动重连需要先定义"重连期间在途请求如何处理、状态是否保留"，属独立设计（issue #44）。
- **manifest 声明通道**：当前由扩展在运行时调用 `connect()` 并传声明（同一套校验函数）；manifest 贡献点属人机工程优化。
- **沙箱化**：通道是能力封装，不宣称隔离（ADR-0015）。

> 修订记录（issue #43）：本节原有第 1 条"**pipe 服务端 / 多客户端**：宿主作为服务端 listen 并接受多个连接"已实现并移入上方「决策」第 9 条。**修订既有 ADR 而非新开**：该条是本 ADR 自己预留的后续项（`ipcEndpoint` 早已预留 `suffix`），不构成"难以逆转 / 无背景者会觉得奇怪 / 存在真实取舍"的新决策。

## 后果

- 扩展获得了与任意语言进程双向通信的通道（含**作为服务端接受多条连接**），且**不占用任何端口**，不需要用户做任何网络配置。
- 代价：stdio 场景下对端必须由宿主拉起（崩溃即断连）；pipe 场景需要扩展自己约定端点命名（宿主按扩展 id + 通道名推导，避免跨扩展冲突）与陈旧文件处理（POSIX）；服务端场景下"任何同机进程都能连上"（0600 只能挡其它用户），对端身份校验不做（ADR-0015）。
- **平台差异（issue #43）**：Windows 命名管道在内核命名空间、无落盘文件 → 服务端**不探测陈旧端点、不 chmod**；POSIX 域套接字有落盘文件 → `listen` 前**试连探测**（连上=有活着的服务端 → `connect-failed` 且**不删除**该文件；连不上=陈旧 → `unlink` 后重新 listen，`EADDRINUSE` 竞态重试一次），`listen` 成功后 `chmod 0600`，`dispose()` 时 `unlink`。分支由 `ipcServer.endpointPrepPlan(platform)` 这个纯函数决定并两平台单测。
- **清理时机无新增**：服务端与既有通道走**同一函数、同一时机**（扩展停用/卸载/重载与退出 → `cleanupExtensionResources` → `closeExtensionIpc`），`extensionCleanup.ts` 未改动。宿主被强杀时 POSIX 会残留 `.sock`，下次 `listen` 的探测步骤自愈；Windows 命名管道随进程消失。
- 不变量：
  - 所有失败都以**稳定错误码**返回（`invalid-declaration` / `connect-failed` / `not-connected` / `protocol-error` / `timeout` / `cancelled` / `message-too-large` / `too-many-requests` / `too-many-channels` / **`too-many-connections`** / `peer-crashed` / `channel-closed`，共 **12** 个），不静默挂起；
  - **在途请求不重放**：某条服务端连接断开的瞬间，该连接上**双向**的挂起请求（宿主发起的 `request` 与转发到渲染进程等待回包的对端请求）**立即以断因码失败**，绝不重放、绝不挂到后续新连接上；
  - **连接 ID 单调且永不复用**：新连入的连接只会拿到严格更大的 ID，旧 ID 永久退役（同名 server 重建亦然）。

## 服务端连接的生命周期（issue #43）

- **accept**：分配 `connectionId` → 建该连接独立的 `JsonRpcChannel` → 入连接表 → 广播 `{type:'connection', connectionId}`（渲染进程分发到 `api.ipc.onConnection`）。
- **超限拒绝**：第 17 条不回事件、不分配 ID，只写一条错误帧后关闭。
- **断开**：对端崩溃 / 非法帧（`protocol-error`）/ 宿主 `close(name)`、停用、退出（`channel-closed`）→ 每条连接**恰好触发一次** `{type:'disconnect', connectionId, code, message}`，并结算该连接的在途转发请求；同一 server 的其它连接完全不受影响。
- **不自动重连**：宿主**不**为服务端连接重连；对端要回来就是一次新连入、拿一个新 ID（与 issue #44 的"客户端通道可重连"是两回事，且 #44 的连接 ID 命名空间只属于服务端连接）。
- **广播是通知语义**：`broadcast` 不收集回包（返回 `Promise<void>`），已断开的连接跳过，无连接时静默成功；要定向请求用 `request(..., { connectionId })`。

Status: accepted
