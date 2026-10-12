# spec · 扩展 IPC：断线自动重连（含在途请求语义）— issue #44

> 阶段二产物（`skills/obox-ext-dev/references/workflow.md:51-63`）。**未确认前不得开工**（`workflow.md:66`）。
> 落位：宿主 / 扩展系统 → ADR 写仓库 `docs/adr/`（`workflow.md:92`）；本 spec 归档到仓库 `docs/spec/`（`workflow.md:96`）。
> **状态：已定稿**。三个待决问题（Q1 连接 ID 对本 spec 的约束 / Q2 清单声明面 / Q3 stdio 范围）已由用户拍板，结论见 §6「决策记录」；本文所有分支写法已收敛为单一写法，全文**不含**待确认标记。
> **建议实现顺序：#43 先、#44 后（串行）**，理由三条：① 两份 spec 共同改 `src/main/ipc.ts`、`src/shared/types.ts`、`src/api/types.ts`、`src/renderer/src/core/host.ts`，串行可避免同一文件的写冲突与设计返工；② 本 spec 的"不是服务端连接"这一前提（客户端通道**没有连接 ID**、服务端连接**不自动重连**）必须由 #43 先定死，否则两边对"连接"的理解会打架（§7、R17/R18）；③ #43 落地后本 spec 才能引用到稳定的 `IpcEvent` 形状与统一 `close(name)` 语义。
> **事实引用基准**：本文 `文件:行` 行号基于 master `722cebc`（即 #43 **未落地**时的代码）。#43 先落地后，`src/main/ipc.ts`、`src/shared/types.ts`、`src/api/types.ts`、`src/renderer/src/core/host.ts` 的行号会平移，届时**以代码为准**并在设计阶段更新引用。
> 配对的另一份：`tmp/spec/extension-ipc-pipe-server.md`（issue #43）。

## 1. 背景与事实

需求来源：issue #44（「扩展 IPC：断线自动重连（含在途请求语义）」，label `follow-up`）。ADR-0016 把自动重连列入「本期明确不做」，并给出理由：*"真正的自动重连需要先定义'重连期间在途请求如何处理、状态是否保留'，属独立设计"*（`docs/adr/0016-ipc-transport-and-protocol.md:23`）。issue #44 正文自己已给出**倾向性答案**（在途请求立即失败、不在重连期排队、`onClose` 表示每次断连、协议层状态不保留、指数退避 + 次数上限），本 spec 以正文为准，只在正文**未定**处收敛（收敛点见 §6）。

现状事实（每条带证据）：

| #   | 事实                                                                                                                                                                       | 证据                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| F1  | 当前策略是**手动重连**：断线即 `channel.close(err)`，全部挂起请求以该错误 reject，并向渲染进程广播 `close` 事件；扩展自行重新 `connect()`                                          | `src/main/ipcCore.ts:432-448`、`src/main/ipcTransport.ts:216-219`、`src/main/ipc.ts:128-140`                   |
| F2  | 两类断因文案：stdio 对端退出 → `peer-crashed`（`对端进程退出（code=…, signal=…）`）；pipe 套接字关闭 → `peer-crashed`（`对端连接已关闭`）；扩展主动 `close()` → `channel-closed`     | `src/main/ipcTransport.ts:99-107`、`src/main/ipcTransport.ts:216-219`、`src/main/ipcCore.ts:433-436`            |
| F3  | **没有任何睡眠/定时重试基础设施**：`ipcTransport.ts` 与 `ipcCore.ts` 均无 timer/backoff 重试代码；`unref()` 的用法先例在 `ipcCore.ts` 的请求超时定时器                                                    | `src/main/ipcCore.ts:340-347`（全文件无重试逻辑）                                                             |
| F4  | 请求入口在**薄壳**：渲染进程 `api.ipc.request` → 主进程 `ipc:request` → `requireChannel(extId, name)` → `channel.request(...)`；通道不在注册表即 `not-connected`                 | `src/renderer/src/core/host.ts:1229-1233`、`src/main/ipc.ts:262-282`、`src/main/ipc.ts:76-82`                  |
| F5  | 通道关闭时主进程**立即从注册表移除**并广播 `close`；`onClose` 已被定义为"每次连接断开"（不止一次可触发）                                                                              | `src/main/ipc.ts:128-140`、`src/shared/types.ts:483`                                                          |
| F6  | 声明形状 `{ id, transport, program?, args?, framing? }`，运行时与清单共用一套校验；非法即 `invalid-declaration`（清单里非法会让**清单无效**）                                        | `src/shared/ipcDeclaration.ts:17-28,54-103`、`src/renderer/src/core/manifest.ts:46-56`                        |
| F7  | 通道声明**不做持久化**：通道是运行期注册表（`Map<extId, Map<name, OpenChannel>>`），扩展停用即清空；无任何落盘                                                        | `src/main/ipc.ts:41`、`src/main/ipc.ts:226-232`                                                               |
| F8  | 限额：每扩展 4 条通道、每通道并发 64、单条消息 8MB、默认超时 30s；错误码闭集 11 个（含 `not-connected`、`channel-closed`、`peer-crashed`）                                            | `src/main/ipc.ts:32-33`、`src/main/ipcCore.ts:22-27`、`src/main/ipcCore.ts:32-44`                              |
| F9  | 测试先例：`test/ipc-transport.test.ts` 用真实 socket / 真实子进程；该文件已有可复用的真实服务端工具（`createServer` / `endpointFor` / `listen`，`:84-128`）与"服务端不在时端点不可连"的用例（`:236-240`，`connect-failed`） | `test/ipc-transport.test.ts:84-128,214-247,236-240`、`test/ipc-stream.test.ts`                                 |
| F10 | 现有 `api.ipc` 表面与文档面（无 `autoReconnect` / `onReconnect`）                                                                                                              | `src/api/types.ts:394-418`、`skills/obox-ext-dev/references/api-reference.md:597-659`                          |
| F11 | troubleshooting 现明确写"宿主不自动重连，需扩展自行 `connect()` 重建"                                                                                                            | `skills/obox-ext-dev/references/troubleshooting.md:281`                                                       |
| F12 | **清单里静态声明的通道对象是"原样"送进主进程校验器的**：`api.ipc.connect('<id>')` 经 `resolveIpcChannelDeclaration` 取出清单里的**原始对象**（不做白名单归一化），再由渲染进程经 `ipcConnect` 交给主进程 `openExtensionChannel` → `validateIpcDeclaration`。因此**任何成为校验器已知键的键，清单里写它就会真的生效**，而不只是被忽略 | `src/shared/ipcDeclaration.ts:139-151`、`src/renderer/src/core/host.ts:1210-1222`、`src/main/ipc.ts:148-152`、`src/main/ipcCore.ts:680-686` |
| F13 | `IpcEvent` 是主进程 → 渲染进程的**内部**事件（非扩展契约面）；扩展只看到 `onXxx(name, cb)` 回调                                                                                    | `src/shared/types.ts:471-483,518-519`、`src/renderer/src/core/host.ts:1176-1206`                               |
| F14 | `apiVersion` 单源在根 `package.json`（当前 `1`），且**只在破坏性签名变更时递增**（纯新增不递增）                                                                                            | `package.json:4`、`docs/adr/0010-api-version.md:15`                                                           |

约束：

- 不新增运行期 npm 依赖（`workflow.md:47`）；退避用 `setTimeout` + 可注入时钟即可。
- 不得静默重放请求（issue #44 的核心诉求）；不破坏既有单客户端行为（既有扩展不传 `autoReconnect` 时**一字不变**）。
- 重连控制器必须 **electron-free**、时钟与 sleep 可注入，以便确定性测试（issue #44「测试缝隙」）。
- **不改 `apiVersion`**（纯新增能力 + 一个新可选声明键；ADR-0010 决策 4 / F14）。

## 2. 目标 / 非目标

**目标**

- G1 扩展可选择让一条 `pipe` 通道在**意外断线**后自动重连，成功率与尝试次数可观测。
- G2 把"在途请求 / 重连期新请求 / 状态保留"三条语义**写死并测到**，不留模糊地带。
- G3 不启用时不改变任何既有行为；`close()` / 扩展停用后立刻停止重试。
- G4 重连逻辑落在独立 electron-free 模块，可注入时钟与 sleep 做确定性测试。

**非目标（明确不做）**

- N1 **不自动重放任何请求**（也不做幂等方法白名单重放）——issue #44 已判定"成本高于收益"；服务端连接侧同一规则见 #43 R18。
- N2 不排队重连期间的新请求（不缓冲、不延迟 resolve）。
- N3 不做协议层会话恢复 / 握手重放（对端会话状态由对端负责）。
- N4 不做无限重连、不做 jitter、不做网络质量探测、不做熔断（只在次数上限后停）。
- N5 不改 `framing`、限额、消息上限、超时口径（30s 默认不变）。
- N6 **不把 stdio 纳入自动重连（Q3 = 方案 A）**：`transport:'stdio'` + `autoReconnect` → `invalid-declaration`（R12）；服务端 / 多连接属 #43 范围（#43 R1 的 `listen`、#43 R5 的 `onConnection`/`onDisconnect`、#43 R18 的连接级断连规则），本 spec 只覆盖**客户端通道**。
- N7 不做跨进程重启的通道持久化（通道与声明仍是运行期对象，F7）。
- N8 **不改清单声明面（Q2 = 方案 A）**：`contributes.ipcChannels` 的形状与校验一字不动，`autoReconnect` 只在运行时声明对象里生效（R13/R18）。

## 3. 需求表

| id  | 需求                                                                                                                                                                                                                                                                                                                                                                     | 来源                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| R1  | `IpcChannelDeclaration` 增可选 `autoReconnect?: { retries?: number; backoffMs?: number }`；**只在运行时声明对象（`connect({...})` 传的对象）上生效**；清单里写它不生效（R13/R18）；缺省（不传）= **关闭**，行为与今天逐字节一致                                                                                                                                                  | issue #44 API 草案；`src/shared/ipcDeclaration.ts:17-28` |
| R2  | 缺省值：`retries = 3`、`backoffMs = 250`；退避序列 `250, 500, 1000`（倍数 2，单次等待**封顶 `MAX_BACKOFF_MS = 30_000`**）；`retries = 0` 等价于关闭；非法（负数 / 非整数 / 非对象 / 未知字段类型错）→ `invalid-declaration`                                                                                                                                                       | issue #44 API 草案（`{ retries: 3, backoffMs: 250 }`）；§6 决策记录·S1 |
| R3  | **生效范围**：只对 `transport === 'pipe'` 的通道生效；stdio 的处理见 R12                                                                                                                                                                                                                                          | issue #44 第 5 点                        |
| R4  | **触发时机与"可重连断因"封闭清单**：触发＝**首次连接成功后**发生意外断开（`peer-crashed`，含对端退出与套接字关闭）；**重连尝试期间**新产生的 `connect-failed` 只用于继续退避（不算"放弃"）。**不触发**：`channel-closed`（扩展主动 `close()`）、宿主清理（`closeExtensionIpc`）、**`protocol-error`（对端发非法帧 → 立即放弃并移除，避免与坏对端无限拉锯）**、首次 `connect()` 失败（首连失败由 `connect()` 抛错给扩展）                                  | issue #44 第 3/5 点；`src/main/ipcTransport.ts:200-219`；§6 决策记录·S2 |
| R5  | **在途请求**：断开瞬间该通道所有挂起请求**立即**以断因码（`peer-crashed`）reject，**绝不重放、绝不挂到重连后**（现状已如此，本项要求**回归锁死**）；与 #43 R18 的服务端侧规则同源                                                                                                                                   | issue #44 第 1 点（推荐项）；#43 R18      |
| R6  | **重连期新请求**：`api.ipc.request` 立即以 `not-connected` 失败（不排队、不等待重连）；`api.ipc.notify` 同样立即失败（不缓冲）                                                                                                                                                                                            | issue #44 第 2 点（推荐项）               |
| R7  | **事件语义**：`onClose(name, cb)` 每个断连周期**恰好触发一次**（在第一次重试尝试之前），语义不变；新增 `onReconnect(name, cb)`，每次**重连成功后**触发一次，回调参数见 R9；**不自动握手**（扩展在 `onReconnect` 里自行握手）                                                                                                     | issue #44 第 3/4 点                       |
| R8  | **状态保留与连接 ID 的关系（Q1）**：通道名、声明（含 framing、autoReconnect 配置）保留并沿用；协议层状态**全部丢弃**（新 `JsonRpcChannel`，请求 id 从 1 重新开始，挂起表为空）。**客户端通道没有 `connectionId`**——`connectionId` 是 #43 里"服务端接受的连接"的标识（#43 R7）；客户端通道的身份就是**通道名**，重连既不申请也不保留任何 `connectionId`（Q1 的"连接 ID 不复用"因此在客户端侧天然成立） | issue #44 第 4 点；§6 决策记录·Q1         |
| R9  | **可观测**：`api.ipc.channels()` 语义不变（返回当前通道名；含 #43 的服务端名，#43 R19）；重连状态经新事件暴露——`onReconnect(name, cb: (info: { attempts: number }) => void)`（`attempts` = 本次重连共尝试了几次）；达到上限仍失败时触发 `onClose`（带 `peer-crashed`）并**从注册表移除**该通道（`channels()` 不再包含它），不再重试                                                                 | issue #44 第 5 点；§6 决策记录·S3         |
| R10 | `api.ipc.close(name)` 在重连窗口内调用 → **立即**取消剩余重试、关闭底层、清理定时器（幂等，且之后不再有任何 `onReconnect`）；与 #43 R3 的统一 `close(name)` 语义一致（同一名字下的 server 与 client 通道一并关闭）                                                                                                             | issue #44 第 5 点；#43 R3                 |
| R11 | 重连控制器为独立 electron-free 模块，时钟与 sleep 通过参数注入（默认 `setTimeout`）；定时器 `unref()`（沿用 `src/main/ipcCore.ts:347` 的先例），不得拖住进程退出或测试                                                                                                                                                       | issue #44「测试缝隙」；`src/main/ipcCore.ts:340-347` |
| R12 | **stdio 不纳入（Q3 = 方案 A）**：`transport === 'stdio'` + `autoReconnect` → **`invalid-declaration`**（文案方向："stdio 场景请自行 `connect()` 重连，或改用 pipe"）；stdio 仍可在 `onClose` 里自行退避重连——**宿主不提供任何支持**，只需文档一句话点到；**不做**"重新 spawn 同一 `program`/`args`"的自动重连                                                                         | issue #44 第 5 点；§6 决策记录·Q3         |
| R13 | **清单声明面不改（Q2 = 方案 A）**：`contributes.ipcChannels` 的形状与校验面**一字不动**；清单里写 `autoReconnect` **既不报错也不生效**。但**"不生效"不能靠巧合**：`autoReconnect` 在运行时声明上必须被校验（R1/R2），因此它会成为校验器的**已知键**，而清单静态声明是**原样**送进主进程校验器的（F12）——若不额外处理，清单里写的 `autoReconnect` 会**真的生效**。故 R18 强制"清单来源的声明先做白名单归一化"。文档须明写该静默行为并加用例锁死                                                                                   | §6 决策记录·Q2；`src/shared/ipcDeclaration.ts:54-103`；F12 |
| R14 | 主进程桥与 preload **无需新增方法**（重连发生在主进程内部）；`IpcEvent` 增 `{ extId, name, type:'reconnect', attempts }` 成员（既有 4 种 + #43 的 2 种形状不变）；`ipc:request` 在重连窗口期靠既有 `not-connected` 返回（F4 已就位）                                                                                          | 实现必需；`src/shared/types.ts:471-483,518-519` |
| R15 | 文档同步：api-reference（`autoReconnect` / `onReconnect` / 重连期错误语义 / 三条语义表 / "声明只能写在运行时对象里"）、troubleshooting（把 `:281` 的"宿主不自动重连"改成"默认不重连，可对 pipe 开 `autoReconnect`"并补"如何调试重连"）、ADR-0016（把自动重连从「本期明确不做」移入「已做」，并**记录"在途请求不重放"的理由**与三条语义）；**manifest-reference 不改**（Q2 = A）                    | issue #44 验收；`skills/obox-ext-dev/references/troubleshooting.md:281` |
| R16 | 既有回归：不传 `autoReconnect` 的扩展在断线时行为与今天**完全一致**（`onClose` 一次、`channels()` 立即不含该通道、请求报 `peer-crashed`）                                                                                                                                                                                  | 仓库约定（不破坏既有行为）；F1/F5          |
| R17 | **与 #43 的一致性（两边说法必须一致，逐条对齐 #43 的需求编号）**：① 客户端通道重连**不涉及连接 ID**（R8；#43 R7 的 ID 命名空间只属于服务端接受的连接）；② **服务端连接不自动重连**，本 spec 的重连能力不适用于服务端连接（#43 R5 只通知、#43 R18 只规定断连清理与"不重放"）；③ `close(name)` 沿用 #43 R3 的统一语义（R10）；④ `channels()` 语义沿用 #43 R19（含服务端名；R9 的"放弃后移除"只针对 client 通道）                                                | §6 决策记录·Q1；#43 R3/R5/R7/R18/R19      |
| R18 | **清单来源声明的白名单归一化**：`resolveIpcChannelDeclaration`（`src/shared/ipcDeclaration.ts:139-151`）改为返回**白名单归一化后**的声明（只含 `id` / `transport` / `program` / `args` / `framing`，**剥掉** `autoReconnect` 与任何未知键），使"清单里写 `autoReconnect` 不生效"**由构造保证**；同时 **不得**让清单校验路径开始校验 `autoReconnect`（否则清单会因该键的值形状（如 `{retries:-1}`）变为无效，违反"不报错"）——运行时 `autoReconnect` 的校验只能发生在**只服务运行时声明**的入口（设计阶段定名，如 `validateRuntimeIpcDeclaration`），`checkIpcDeclaration` / `checkIpcChannelList` / `validateIpcDeclaration` 的接受面保持今天的"未知键静默忽略"                                                                                    | §6 决策记录·Q2/R18 理由；F12              |

编号连续性：R1–R18，连续、无重号。

## 4. 交付物（逐文件）

| 文件                                                       | 动作                  | 内容                                                                                                                                                                                                 |
| ---------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ipcReconnect.ts`                                 | 新增                  | electron-free 重连控制器：`createReconnectController({ attempt, backoffMs, retries, maxBackoffMs, sleep, onGiveUp })`；纯逻辑，注入时钟/sleep；覆盖 R2/R4/R5/R6/R7/R9/R10/R11                                  |
| `src/main/ipcTransport.ts`                                 | 修改                  | `openPipeClientTransport` 增 `autoReconnect` 参数或返回可重建句柄；断因到"是否可重连"的分类（主动 `dispose` vs 意外关闭；`protocol-error` 不可重连，R4）。**stdio 侧不改**（Q3 = A）                          |
| `src/main/ipc.ts`                                          | 修改                  | `OpenChannel` 增重连状态；`registerChannel` / `closeExtensionChannel` / `closeExtensionIpc` 接入控制器；重连成功重新登记并广播 `reconnect` 事件；`requireChannel` 在窗口期仍以 `not-connected` 失败（保持现状语义，R6） |
| `src/main/ipcCore.ts`                                      | 修改                  | 仅按需调整错误码注释；**本 spec 不新增错误码**（重连期复用 `not-connected`、放弃复用 `peer-crashed`），故预计只在"运行时声明校验入口"处落 R18 的调用点。若设计阶段发现需要新错误码（如 `reconnect-exhausted`），**须回到本 spec 改判**                                                        |
| `src/shared/ipcDeclaration.ts`                             | 修改                  | `IpcChannelDeclaration` 增 `autoReconnect?` 并**在运行时校验入口**校验（R1/R2/R12）；`resolveIpcChannelDeclaration` 做白名单归一化（R18）；**清单路径（`validateIpcDeclaration` / `checkIpcDeclaration` / `checkIpcChannelList`）的接受面一字不变** |
| `src/shared/types.ts`                                      | 修改                  | `window.api` 侧无新方法（R14）；`IpcEvent` 增 `{extId, name, type:'reconnect', attempts:number}`；`IpcChannelDeclaration` 同步 `autoReconnect`                                                            |
| `src/api/types.ts`                                         | 修改                  | `ipc` 表面增 `onReconnect`；`connect` 的声明类型含 `autoReconnect`；doc 注释写明"在途请求不重放 / 重连期报 `not-connected` / 只在运行时声明里写 `autoReconnect`（清单里写不生效）"                          |
| `src/renderer/src/core/host.ts`                            | 修改                  | `buildIpcApi`：`ChannelListeners` 增 `reconnects` 集合；`ipc:event` 分发新增 `reconnect` 分支；`close()` 清掉该通道的全部监听（现状已 `listeners.delete(name)`，需保留）                                        |
| `test/ipc-reconnect.test.ts`                               | 新增                  | 确定性重连测试（注入假 sleep → 不依赖真实等待），见 V1、V3–V8、V13–V17                                                                                                                                    |
| `test/ipc-transport.test.ts`                               | 修改                  | 真实 socket"kill 后重启"端到端重连用例（V2），复用该文件既有的 `createServer` / `endpointFor` / `listen` 工具（F9）                                                                                       |
| `test/ipc-declaration.test.ts`                             | 修改                  | `autoReconnect` 校验用例（合法 / 负数 / 非整数 / `stdio` + 配置 → `invalid-declaration` / `retries: 0` 等价关闭）＋ **静默与归一化锁死用例**（清单项带 `autoReconnect` 不报错、归一化后不含该键，V10/V13） |
| `test/manifest.test.ts`                                    | 修改                  | 清单侧锁死用例：含 `autoReconnect`（含非法值）的 `contributes.ipcChannels` 项**仍然清单有效**（V10）。**不新增/不改动** `test/manifest-script-parity.test.ts` 的 fixture（不动脚本差分门禁）                  |
| `skills/obox-ext-dev/references/api-reference.md`          | 修改                  | `api.ipc` 小节增"自动重连"用法与语义表（在途请求 / 重连期请求 / 事件 / 状态 / 仅 pipe / 仅运行时声明）                                                                                                       |
| `skills/obox-ext-dev/references/troubleshooting.md`        | 修改                  | 把 `:281` 的"宿主不自动重连"改为"默认不重连，可对 pipe 开 `autoReconnect`"；补"如何调试重连"（看 `onReconnect`；`channels()` 仍在＝正在重连、`channels()` 不含＝已放弃）                                          |
| `skills/obox-ext-dev/references/manifest-reference.md`     | **不改**              | Q2 = A（清单有效形状无变化）（R13/R15）                                                                                                                                                                |
| `docs/adr/0016-ipc-transport-and-protocol.md`              | 修改（**不新开 ADR**） | 把「本期明确不做」的"自动重连"移入「已做」；**记录"在途请求不重放"的理由**（成本高于收益、重放会破坏 at-most-once 心智）与三条语义（在途立即失败 / 重连期 `not-connected` / 协议状态不保留）。**修订既有 ADR 而非新开**：本项是 0016 自己写明的后续项（`:23`），不构成新决策                                                            |
| `README.md`                                                | 修改                  | `src/main/` 目录树补一行 `ipcReconnect.ts`（`AGENTS.md` README 更新要求：目录结构变化）；概览级能力描述默认只改一行                                                                                        |
| `tmp/spec/extension-ipc-reconnect-design.md`               | 新增（**本 spec 确认后**） | 阶段四设计文档；本阶段不写（`workflow.md:66`）                                                                                                                                                          |

**明确不改**：`apiVersion`（保持 `1`，`package.json:4`；ADR-0010 决策 4）、`src/main/ipcCore.ts` 的错误码闭集（本 spec 不新增码）、`scripts/validate-manifest.mjs` 与其差分门禁、`manifest-reference.md`、清单校验面。

## 5. 验收标准（可执行）

先决：`npm ci` 已完成；仓库在 feature 分支。所有 `npx vitest` 命令的**期望退出码均为 0**（失败路径都在用例内部断言）。

| #   | 场景                                                                 | 命令 / 操作                                                                                          | 期望                                                                                                                                                       |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | 正常路径：对端断开后自动重连成功 + `onReconnect` 触发                    | `npx vitest run test/ipc-reconnect.test.ts -t "重连成功"`                                              | 退出码 0；重连成功后一次 `request` 成功；`onClose` 恰好 1 次、`onReconnect` 恰好 1 次、`attempts === 1`                                                        |
| V2  | 端到端（真实 socket）：kill 对端 → 重启 → 自动连上                        | `npx vitest run test/ipc-transport.test.ts -t "重连"`                                                  | 退出码 0；重启对端后下一次 `request` 成功，无需扩展调用 `connect()`                                                                                            |
| V3  | 在途请求：断开瞬间的挂起请求立即失败且**不重放**                          | `npx vitest run test/ipc-reconnect.test.ts -t "在途请求"`                                              | 退出码 0；挂起请求 reject 且 `code === 'peer-crashed'`；对端重启后**没有**收到任何重复请求（用对端收到的 method 计数断言 = 1）                                    |
| V4  | 重连期新请求：立即 `not-connected`，不排队                                | `npx vitest run test/ipc-reconnect.test.ts -t "重连窗口"`                                              | 退出码 0；重连窗口内 `request` 立刻 reject `code === 'not-connected'`；等待时长远小于一次退避间隔（假时钟断言 0 次 sleep）                                       |
| V5  | 退避与上限：连续失败 `retries` 次后停止                                    | `npx vitest run test/ipc-reconnect.test.ts -t "上限"`                                                  | 退出码 0；注入假 sleep 记录到的等待序列为 `[250, 500, 1000]`；尝试次数 = 3；之后再无定时器（假时钟推进 10× 无新调用）                                             |
| V6  | `close()` 期间不重试                                                     | `npx vitest run test/ipc-reconnect.test.ts -t "close 期间"`                                            | 退出码 0；`close()` 后假时钟推进无任何重连尝试、无 `onReconnect`、无遗留定时器（`vi.getTimerCount() === 0`）                                                     |
| V7  | 放弃后从注册表移除                                                        | `npx vitest run test/ipc-reconnect.test.ts -t "放弃"`                                                  | 退出码 0；达到上限后 `await api.ipc.channels()` 不含该通道；再次 `request` 报 `not-connected`                                                                  |
| V8  | 扩展停用/卸载（`closeExtensionIpc`）在重连窗口内立即停止                    | `npx vitest run test/ipc-reconnect.test.ts -t "closeExtensionIpc"`                                     | 退出码 0；无遗留定时器、无 `onReconnect`、端点/进程被清理                                                                                                       |
| V9  | 回归：**不传** `autoReconnect` 的既有行为不变                             | `npx vitest run test/ipc-transport.test.ts test/ipc-stream.test.ts test/ipc-core.test.ts`               | 退出码 0；`onClose` 一次、`channels()` 立即不含该通道、请求报 `peer-crashed`（与今天一致）                                                                      |
| V10 | 回归：清单声明路径不变 + 静默与归一化锁死（Q2 = A）                        | `npx vitest run test/ipc-declaration.test.ts test/manifest.test.ts test/manifest-script-parity.test.ts` | 退出码 0；含 `autoReconnect`（**含非法值 `{retries: -1}`**）的清单项**仍然清单有效**（不报错）；经 `resolveIpcChannelDeclaration` 归一化后的声明**不含** `autoReconnect`（不生效、无重连行为）；脚本差分门禁用例通过且其 fixture 未改动 |
| V11 | 仓库门禁                                                                 | `npm run typecheck` + `npm run lint` + `npm test`                                                      | 三条全通过（退出码 0）                                                                                                                                        |
| V12 | 真机：`npm run dev`，跑一个 pipe 扩展 → 重启对端进程                        | 人工操作 + 观察输出面板日志                                                                             | 扩展未 `connect()` 即恢复请求；日志/事件里能看到 `onClose` 一次 + `onReconnect` 一次；**不做则该结论标注「未验证」**                                               |
| V13 | 失败：`stdio` + `autoReconnect` → `invalid-declaration`（Q3 = A）         | `npx vitest run test/ipc-declaration.test.ts test/ipc-reconnect.test.ts -t "stdio"`                     | 退出码 0；`connect({ transport:'stdio', program:…, autoReconnect:{…} })` 抛 `invalid-declaration`，文案含"自行 `connect()`"或"改用 pipe"；**不产生任何重连尝试**（假时钟 0 次 sleep）；文档一句话说明 stdio 可自行在 `onClose` 里退避重连（V12/api-reference 核对） |
| V14 | 超时口径与退避封顶不变                                                     | `npx vitest run test/ipc-reconnect.test.ts -t "封顶\|超时"`                                             | 退出码 0；`backoffMs` 取很大值时等待序列封顶 `30_000`（R2）；请求超时仍以 `timeout` 失败、默认 30s 口径不变（N5）                                                |
| V15 | 重连后协议状态归零（R8 锁死）                                              | `npx vitest run test/ipc-reconnect.test.ts -t "协议状态"`                                               | 退出码 0；重连后第一条 `request` 在对端看到的 `id === 1`（新 `JsonRpcChannel`）；旧挂起表为空（旧 id 的回包不会唤醒任何请求）；该通道全程**没有** `connectionId`   |
| V16 | 非法帧不触发重连（R4 锁死）                                                | `npx vitest run test/ipc-reconnect.test.ts -t "非法帧"`                                                 | 退出码 0；对端发非法帧 → 通道以 `protocol-error` 关闭、**无** `onReconnect`、无遗留定时器、通道从注册表移除（不再重试）                                            |
| V17 | 重连尝试期间端点被旧实例占用 → 次数用尽后放弃（K6 锁死）                     | `npx vitest run test/ipc-reconnect.test.ts -t "端点被占用"`                                             | 退出码 0；重连尝试连续以 `connect-failed` 失败至次数上限后放弃（`onClose` 一次、从注册表移除）；无遗留定时器；troubleshooting 有"重连一直失败先查端点占用"条目        |

真机验证（`npm run dev`，V12）属**必须**项：`workflow.md:78` 要求真机运行，未做实机验证的结论必须标注「未验证」。

## 6. 决策记录

决策日期：**2026-10-12**。依据：用户拍板（阶段三关卡，`workflow.md:66`）；标注"spec 自定"的条目属实现前可复核的推断，不属用户决策。

### Q1（连接 ID 对重连的约束）＝ #43 方案 A 下的定论

- **结论**：`connectionId` 是 **#43 里"服务端接受的连接"的标识**（#43 R7：单调递增 `number`、从 1 起、**永不复用**）。因此：① **客户端通道没有 `connectionId`**——它的身份就是**通道名**，重连既不申请也不保留任何 `connectionId`（R8/V15）；② **服务端连接不自动重连**——对端回来就是一次新连入、拿一个新 ID，旧 ID 永久退役（#43 R5/R18、R17）；③ 两侧的"在途请求不重放"是同一条规则（R5 与 #43 R18）。
- **被否决方案（把连接 ID 也发给客户端通道、重连后沿用同一 ID）**：**不选的理由（一句）**：那会让"重连后 ID 不变"与"ID 永不复用"直接冲突——要么破坏 Q1 的不复用规则，要么让扩展误以为重连前后是同一个可寻址对象，而协议层状态其实已经全丢（R8）。
- **日期/依据**：2026-10-12，用户拍板 Q1（连接 ID 化 + 不复用）。

### Q2（清单声明面）＝ 方案 A：不改清单

- **结论**：`autoReconnect` **只在运行时声明对象里生效**；清单 `contributes.ipcChannels` 里写它**既不报错也不生效**；`manifest.ts` 校验面、`manifest-reference.md`、脚本差分门禁**都不动**；并要求**加用例锁死**该静默行为（V10）。此外，本 spec 额外强制 R18：清单来源的声明先做**白名单归一化**，否则第 #44 期它成为已知键后会真的生效（F12）。
- **被否决方案 B（清单也能声明 `autoReconnect`）**：**不选的理由（一句）**：它把"重连策略"塞进清单校验面，且两个方向都会静默降级（新扩展 + 旧宿主＝配了不生效；清单声明默认开启还可能在启动期就反复重连），而运行时声明已经足够表达。
- **日期/依据**：2026-10-12，用户拍板 Q2。**交叉引用**：#43 Q2 的同一结论，但本条更硬（见 R18 的理由）。

### Q3（stdio 范围）＝ 方案 A：仅 pipe

- **结论**：`transport: 'stdio'` + `autoReconnect` → 直接返回 **`invalid-declaration`**（文案方向："stdio 场景请自行 `connect()` 或改用 pipe"）；stdio 仍可用 `onClose` 自行退避重连（文档一句话点到即可，宿主不提供支持）。
- **被否决方案 B（stdio 也自动重连＝重新 spawn 同一 `program`/`args`）**：**不选的理由（一句）**：重连等于重新拉起进程，必须额外定义 spawn 幂等、旧进程残留检测与 Windows 文件占用重试，属独立设计（ADR-0016:23 未覆盖），会把本 issue 撑成第二个 #43。
- **日期/依据**：2026-10-12，用户拍板 Q3。

### Q1–Q3 之外的收敛（本 spec 自定，非用户决策；实现前可复核）

| #   | 收敛点                                                                                          | 理由一句                                                                                                | 落点   |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| S1  | `backoffMs` 单次等待**封顶 `MAX_BACKOFF_MS = 30_000`**；非法值（负数/非整数/非对象）→ `invalid-declaration` | 与"默认请求超时 30s"同量级，避免单次等待超过一次请求超时导致扩展难以推理                                    | R2     |
| S2  | **可重连断因封闭清单**：`peer-crashed` 可重连；`channel-closed` / 宿主清理 / **`protocol-error`** / 首连失败都不可重连；重连期的 `connect-failed` 只用于继续退避 | 否则"对端一直发非法帧"会变成无限拉锯；封闭清单才能写出确定性用例（V16）                                     | R4     |
| S3  | `onReconnect` 的第二参数定为对象 `{ attempts }`                                                   | `IpcEvent` 是内部事件（F13），扩展只看回调参数；对象参数便于将来加字段而不破坏签名                          | R7/R9  |
| S4  | 重连**不新增错误码**（复用 `not-connected` / `peer-crashed`），因此错误码闭集不变                    | 新增码属对外契约变更且无必要——现有两个码已能表达"窗口期"与"放弃"两种状态                                    | §4     |
| S5  | 交付面：**不改 `apiVersion`**；**修订 ADR-0016 而非新开 ADR**；README 补一行目录树                    | ADR-0010 决策 4（纯新增不递增）；本项是 0016 自己写明的后续项、不构成新决策；`AGENTS.md` 要求目录结构变化同步 README | §4     |

## 7. 与 issue #43 的关系与实现顺序

- **串行建议：#43 先、#44 后**（理由见文首）。若用户坚持并行，须先把"重连控制器接口"与"连接注册表接口"在设计阶段冻结，并按文件所有权切分：`ipcServer.ts` / 服务端相关改动归 #43，`ipcReconnect.ts` 归 #44，`ipc.ts` **只允许串行改动**。
- 共享文件与各自动作（`D` = 本 issue 改，`-` = 不改）：

| 文件                                              |  #43  |  #44  | 说明                                                                                     |
| ------------------------------------------------- | :---: | :---: | ---------------------------------------------------------------------------------------- |
| `src/main/ipc.ts`                                 |   D   |   D   | 两边都改，必须串行；#43 先定统一名字空间与 `close(name)`（#43 R3/R19）                       |
| `src/main/ipcCore.ts`                             |   D   |  D\*  | #43 加 `too-many-connections`；#44 原则上不加码，只可能在运行时声明校验入口处落 R18 的调用点   |
| `src/main/ipcTransport.ts`                        |   D   |   D   | #43 加 server 传输；#44 改 pipe 客户端（stdio 侧不动）                                      |
| `src/shared/types.ts`                              |   D   |   D   | 两边都扩 `IpcEvent`（#43 两种 + #44 一种）                                                  |
| `src/api/types.ts`                                 |   D   |   D   | 两边都扩 `api.ipc` 表面                                                                   |
| `src/renderer/src/core/host.ts`                    |   D   |   D   | 两边都改 `buildIpcApi` 的事件分发                                                          |
| `src/shared/ipcDeclaration.ts`                     | **-** |   D   | Q2 = A 下 #43 **不改**；#44 加 `autoReconnect`（仅运行时校验入口）+ `resolveIpcChannelDeclaration` 归一化（R18） |
| `src/renderer/src/core/manifest.ts`                | **-** | **-** | 两边都不改清单校验面（Q2 = A）                                                              |
| `skills/obox-ext-dev/references/api-reference.md`  |   D   |   D   | 两边各增一节                                                                              |
| `skills/obox-ext-dev/references/troubleshooting.md` |   D   |   D   | 两边各增条目；#44 另改 `:281` 的表述                                                        |
| `skills/obox-ext-dev/references/manifest-reference.md` | **-** | **-** | 两边都不改（Q2 = A）                                                                      |
| `docs/adr/0016-ipc-transport-and-protocol.md`      |   D   |   D   | 两边都把各自项从「本期明确不做」移入「已做」（#43 先改，串行无冲突）                          |
| `README.md`                                        |   D   |   D   | 各补一行目录树                                                                            |

\* #44 对 `ipcCore.ts` 的动作仅在"运行时声明校验入口"落点需要时发生，且**不新增错误码**。

## 8. 风险与未决项

| #   | 风险 / 未决项                                                                                                                    | 处置                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| K1  | 清单静默降级的**观感**：扩展作者在清单里写了 `autoReconnect`，看起来配上了，实际永远不生效（连非法值都不报错）                          | 这是 Q2 = A 的刻意取舍：api-reference / troubleshooting **明写"`autoReconnect` 只能写在运行时声明对象里"**；R18 归一化 + V10 用例锁死 |
| K2  | stdio 用户期待"开了 `autoReconnect` 就能自动重连"，却拿到 `invalid-declaration`（Q3 = A）                                            | 报错文案直接给出替代路径（自行 `connect()` 退避 / 改用 pipe），api-reference 一句话说明；stdio 的 `onClose` 自行重连路径写进文档   |
| K3  | 重连窗口内 `requireChannel` 仍返回 `not-connected`——但**通道仍在注册表**（否则重连无处挂），容易被误读成"通道已消失"                    | 在 api-reference 明写两种"不见了"的区别：`channels()` 仍含该通道＝正在重连；`channels()` 不含＝已放弃；测试 V7 锁死                    |
| K4  | 退避定时器忘记 `unref()` 会拖住进程退出/测试（`vitest` 挂住不退出）                                                                  | 复用 `src/main/ipcCore.ts:347` 先例；V6 用 `vi.getTimerCount()` 断言无遗留定时器                                                |
| K5  | 每次重连新建 `JsonRpcChannel` 会丢协议层状态——若有扩展依赖"请求 id 连续"或"对端会话"会静默出错                                        | 属 issue #44 明确定下的语义（第 4 点 / R8）；在 api-reference 明写"必须用 `onReconnect` 重新握手"；V15 锁死首条请求 `id === 1`；不做兼容垫片 |
| K6  | 对端重启后端点被旧实例占用（Windows 命名管道残留 / POSIX 陈旧 `.sock`）→ 重连一直 `connect-failed` 直到次数用尽                        | 与 #43 R10 的陈旧文件处置共用结论；troubleshooting 增"重连一直失败先查端点占用"；V17 锁死"次数用尽即放弃且无遗留定时器"                |
| K7  | 服务端连接（#43）**不**自动重连，与"能自动重连"的宣传可能被混淆                                                                       | R17 明写：#44 的能力只覆盖客户端通道；服务端连接断连只通知（#43 R5）。若将来要服务端连接重连，**须回到阶段一追加需求**                   |
| K8  | `attempts` 字段属新增事件形状，未来若要加 `nextDelayMs` 等会再改事件契约                                                              | `IpcEvent` 是主进程→渲染进程内部事件（F13），扩展只看 `onReconnect(cb)` 的参数；参数已定义成对象而非位置参数，后续扩展不需破坏性改动      |
