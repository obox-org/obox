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
7. **限额与治理**（与 `timer` / `fs.watch` 同一风格）：每扩展最多 4 条通道、每通道并发请求上限、单条消息上限 8MB（与 `api.net.fetch` 一致）、请求默认 30s 超时；扩展停用/卸载/重载时统一断开并终止由宿主拉起的进程。
8. **便利约定**：`.js/.cjs/.mjs` 形式的 `program` 由宿主自带的 Node 运行（扩展无需自带解释器）；其它一律直接执行（编译产物或系统可执行文件）。

## 本期明确不做（留待后续，避免半成品语义）

- **pipe 服务端 / 多客户端**：宿主作为服务端 listen 并接受多个连接（`ipcEndpoint` 已预留 `suffix` 参数）。
- **自动重连**：当前是"断开即报 `peer-crashed`/`channel-closed`，扩展自行重新 `connect()`"。真正的自动重连需要先定义"重连期间在途请求如何处理、状态是否保留"，属独立设计。
- **manifest 声明通道**：当前由扩展在运行时调用 `connect()` 并传声明（同一套校验函数）；manifest 贡献点属人机工程优化。
- **沙箱化**：通道是能力封装，不宣称隔离（ADR-0015）。

## 后果

- 扩展获得了与任意语言进程双向通信的通道，且**不占用任何端口**，不需要用户做任何网络配置。
- 代价：stdio 场景下对端必须由宿主拉起（崩溃即断连）；pipe 场景需要扩展自己约定端点命名（宿主按扩展 id + 通道名推导，避免跨扩展冲突）与陈旧文件处理（POSIX）。
- 不变量：所有失败都以**稳定错误码**返回（`invalid-declaration` / `connect-failed` / `not-connected` / `protocol-error` / `timeout` / `cancelled` / `message-too-large` / `too-many-requests` / `too-many-channels` / `peer-crashed` / `channel-closed`），不静默挂起。

Status: accepted
