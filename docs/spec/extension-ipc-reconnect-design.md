# 设计文档：扩展 IPC · 断线自动重连（含在途请求语义）— issue #44

| 项 | 值 |
| --- | --- |
| 状态 | **待实现**（spec 已定稿：`tmp/spec/extension-ipc-reconnect.md`，R1–R18 / V1–V17 / Q1=A、Q2=A、Q3=A） |
| 前置 | **`#43` 必须先合并**（`tmp/spec/extension-ipc-pipe-server-design.md`）。本文档行号锚点分两类：标 **【43前】** 的是 master `722cebc` 的行号；标 **【43后】** 的是 #43 设计落地后的落点（以代码为准） |
| 范围 | ① 宿主（`src/main/ipcReconnect.ts` 新增、`src/main/ipc.ts`、`src/shared/ipcDeclaration.ts`、`src/shared/types.ts`、`src/api/shared.ts`、`src/api/types.ts`、`src/renderer/src/core/host.ts`）；② 测试（`test/ipc-reconnect.test.ts` 新增、`test/ipc-transport.test.ts` 加真实 socket 用例、`test/ipc-declaration.test.ts`/`test/manifest.test.ts` 加锁死用例）；③ 文档（api-reference / troubleshooting / ADR-0016 / README） |
| 事实基准 | master `722cebc` + #43 设计（本文所有 `文件:行` 均已读码核对，见 §2） |
| 配对文档 | `tmp/spec/extension-ipc-pipe-server-design.md`（issue #43） |
| 交付面 | **不改** `apiVersion`（`package.json:4`）、`IpcErrorCode` 闭集（S4：不新增码）、`src/main/ipcTransport.ts`（设计决定，见 §3.4）、`scripts/validate-manifest.mjs` 与其差分门禁、`manifest-reference.md`、`src/renderer/src/core/manifest.ts` |
| 归档 | 完成后 spec 与本设计 → 仓库 `docs/spec/`；ADR 修订 → `docs/adr/0016-ipc-transport-and-protocol.md`（**修订，不新开**） |

---

## 0. 建议实现顺序与理由（文首）

**顺序：#43 全部落地并合并 → 从新 master 拉分支做 #44。串行。**

| # | 理由 | 性质 |
| --- | --- | --- |
| 1 | 两份 spec 共改 `src/main/ipc.ts`、`src/shared/types.ts`、`src/api/types.ts`、`src/renderer/src/core/host.ts`；`ipc.ts` **只允许串行改动**（#43 设计 §9.2） | spec 文首 / §7 |
| 2 | 本文的"客户端通道**没有** `connectionId`"（R8）与"服务端连接**不**自动重连"（R17②）都以 #43 R7/R5/R18 为前提；先定后写才不会两边打架 | spec 文首 / Q1 |
| 3 | #44 的 R18 归一化点（`resolveIpcChannelDeclaration`）与运行时校验入口（`ipc.ts` 的 `validateIpcDeclaration` 调用行）只有在 #43 落地后才有稳定形状 | #43 设计 §9.2 |
| 4 | 测试基建（真实对端工具 `test/helpers/ipcPeers.ts` + electron mock 写法）由 #43 建立，#44 直接复用 | #43 设计 §7/§8.1 |
| 5 | ADR-0016 的「本期明确不做」列表 #43 删第 1 条、#44 删第 2 条（自动重连）；同一份文件串行改，避免两人重写同一段 | #43 设计 §10 |
| 6 | **#44 的改动面比 #43 小得多**（一个新增 electron-free 模块 + 三处签名 + 一个归一化函数），适合在 #43 的稳定结构上做一次小 PR；但它的语义（在途请求不重放、协议状态归零）**风险最高**，需要独立审视与真机验证 | 设计补充 |

**#44 内部实现顺序**见 §15：先纯逻辑（`ipcReconnect.ts` + 假 sleep 用例）→ 再声明与归一化（R18 的三把锁）→ 最后接线（`ipc.ts` + `host.ts`）。

---

## 1. 决策摘要（spec R1–R18 → 设计落点）

| spec 需求 | 落点（本文档章节） | 主要改动文件 |
| --- | --- | --- |
| R1 `IpcChannelDeclaration` 增可选 `autoReconnect?`；只在**运行时**声明生效；缺省 = 关闭 | §3.1、§3.4、§7 | `src/api/shared.ts`、`src/shared/types.ts`、`src/shared/ipcDeclaration.ts` |
| R2 缺省 `retries=3`/`backoffMs=250`；退避倍数 2、单次封顶 `MAX_BACKOFF_MS=30_000`；`retries=0` = 关闭；非法 → `invalid-declaration` | §3.4、§5.3①、§6.1 | `src/shared/ipcDeclaration.ts`、`src/main/ipcReconnect.ts` |
| R3 只对 `transport === 'pipe'` 生效 | §5.3①、§6.1 | 同上 |
| R4 触发时机与**可重连断因封闭清单** | §6.2、§6.3 | `src/main/ipcReconnect.ts`、`src/main/ipc.ts` |
| R5 在途请求立即以断因码 reject、**绝不重放** | §4.5、§9（V3/V15） | `src/main/ipc.ts`（复用 #43 的失败传播顺序） |
| R6 重连期新请求立即 `not-connected`（不排队） | §4.4、§4.6 | `src/main/ipc.ts` |
| R7 事件语义：`onClose` 每周期恰好一次（首次重试**之前**）；新增 `onReconnect`；不自动握手 | §3.2、§4.4、§4.5 | `src/main/ipc.ts`、`src/renderer/src/core/host.ts` |
| R8 状态保留与连接 ID 的关系（协议状态全丢、客户端无 `connectionId`） | §4.4、§4.7 | `src/main/ipc.ts` |
| R9 可观测：`channels()` 语义不变；`onReconnect({attempts})`；达到上限后移除并停止 | §3.1、§3.2、§4.4 | `src/api/types.ts`、`src/main/ipc.ts` |
| R10 `close(name)` 在重连窗口期立即取消剩余重试（幂等） | §4.4、§4.6 | `src/main/ipc.ts` |
| R11 独立 electron-free 模块；时钟/sleep 注入；定时器 `unref()` | §3.3、§6.1 | `src/main/ipcReconnect.ts` |
| R12 stdio + `autoReconnect` → `invalid-declaration` | §5.3① | `src/shared/ipcDeclaration.ts` |
| R13 清单声明面不改（不报错不生效）+ 加用例锁死 | §7、§9（V10） | 无生产代码改动；两个测试文件 |
| R14 主进程桥/preload 无新方法；`IpcEvent` 增 `reconnect` | §3.2 | `src/shared/types.ts`、`src/renderer/src/core/host.ts` |
| R15 文档同步（api-reference / troubleshooting `:281` / ADR-0016；manifest-reference 不改） | §11、§12 | 三个文档 |
| R16 既有回归：不传 `autoReconnect` 行为**完全一致** | §3.4（E5 保守处置）、§9（V9） | `src/main/ipc.ts` |
| R17 与 #43 的一致性四条（无连接 ID / 服务端不重连 / `close(name)` / `channels()`） | §1.1、§4.7 | 跨两份设计 |
| R18 清单来源声明的**白名单归一化** + 不得让清单校验路径开始校验 `autoReconnect` | **§7（专章）** | `src/shared/ipcDeclaration.ts`、`src/main/ipc.ts` |
| V1–V17 | §9 逐条映射 | `test/ipc-reconnect.test.ts` 等 |
| 真机 V12 | §14 | — |
| 风险 | §13 | — |

### 1.1 R17（与 #43 的一致性）逐条落地

| R17 | 内容 | 本文档的实现保证 |
| --- | --- | --- |
| ① | 客户端通道重连**不涉及连接 ID** | 客户端通道的记录里**没有** `connectionId` 字段（§4.1）；重连既不申请也不保留 ID；V15 断言"该通道全程没有 `connectionId`" |
| ② | **服务端连接不自动重连** | 重连控制器只挂在 client 分支；`server` 分支的 `onDisconnect` 只广播事件（#43 §4.5） |
| ③ | `close(name)` 沿用 #43 R3 的统一语义 | §4.6 的 `closeExtensionChannel` 在 #43 的统一实现上加"先 `cancel()` 再 `dispose()`" |
| ④ | `channels()` 语义沿用 #43 R19（含 server 名）；"放弃后移除"只针对 client 通道 | §4.4：窗口期**仍在表内**（`channels()` 含它）；放弃后 `delete`（`channels()` 不含）；server 不受任何影响 |

---

## 2. 事实核对（以代码为准）

### 2.1 spec 事实表逐条核对

| spec 事实 | 引用 | 核对结论 |
| --- | --- | --- |
| F1 手动重连：断线即 `channel.close(err)`、挂起全 reject、广播 `close` | `ipcCore.ts:432-448`、`ipcTransport.ts:216-219`、`ipc.ts:128-140` | ✅ 一致 |
| F2 三类断因文案（`peer-crashed` ×2、`channel-closed`） | `ipcTransport.ts:99-107`、`:216-219`、`ipcCore.ts:433-436` | ✅ 一致 |
| F3 无重试基础设施；`unref()` 先例 | `ipcCore.ts:340-347` | ✅ 一致（`:341-345` 定时器、`:347` `unref?.()`） |
| F4 请求入口在薄壳；通道不在注册表即 `not-connected` | `host.ts:1229-1233`、`ipc.ts:262-282`、`:76-82` | ✅ 一致 |
| F5 关闭时立即从注册表移除并广播 `close`；`onClose` 可多次 | `ipc.ts:128-140`、`shared/types.ts:483` | ✅ 一致。**补充**：扩展**主动** `close()` 也会广播一次 `close{channel-closed}`（`transport.dispose()` → `channel.close()`（无参）→ 注册的 `onClose` 在 `map.delete` **之前**跑，`ipc.ts:221-223`） |
| F6 声明形状与共用校验 | `ipcDeclaration.ts:17-28,54-103`、`manifest.ts:46-56` | ✅ 一致 |
| F7 通道不持久化 | `ipc.ts:41`、`:226-232` | ✅ 一致 |
| F8 限额与错误码（4 / 64 / 8MB / 30s / 11 码） | `ipc.ts:32-33`、`ipcCore.ts:22-27`、`:32-44` | ✅ 一致 |
| F9 测试先例与可复用工具 | `test/ipc-transport.test.ts:84-128,214-247,236-240` | ✅ 一致（`:236-240` 是"端点不存在 → `connect-failed`"的**断言**，不可当工具） |
| F10 无 `autoReconnect` / `onReconnect` | `api/types.ts:394-418`、`api-reference.md:597-659` | ✅ 一致 |
| F11 troubleshooting 现写"宿主不自动重连" | `troubleshooting.md:281` | ✅ 一致（`:281` 是 `peer-crashed` 行，原文"（宿主不自动重连，需扩展自行 `connect()` 重建）"） |
| F12 清单静态声明**原样**送进主进程校验器 | `ipcDeclaration.ts:139-151`、`host.ts:1210-1222`、`ipc.ts:148-152`、`ipcCore.ts:680-686` | ✅ 一致，**并已独立复核**：`manifest.ts:49` 的 `checkIpcChannelList` 结果**被丢弃**（只用来产生 error 消息），`host.ts:1214` 传的是 `ext.manifest.contributes?.ipcChannels`（原始 JSON 对象）→ 归一化确实必要 |
| F13 `IpcEvent` 是内部事件 | `shared/types.ts:471-483,518-519`、`host.ts:1176-1206` | ✅ 一致 |
| F14 `apiVersion` 单源、纯新增不递增 | `package.json:4`、`adr/0010:15` | ✅ 一致（同 #43 设计 §2.1） |

### 2.2 核对中发现的偏差与 spec 未列出的事实

| # | 发现 | 落点 | 处置 |
| --- | --- | --- | --- |
| C1 | **扩展可见的 `IpcChannelDeclaration` 有三份副本**，spec §4 只列了两份 | `src/api/shared.ts:45-55`（扩展作者面）、`src/shared/types.ts:454-462`（渲染↔主契约）、`src/shared/ipcDeclaration.ts:17-28`（校验器） | #44 需**三份同步**加 `autoReconnect?: IpcAutoReconnect`（§3.4 给完整定义与同步表）。`src/api/shared.ts` **未在 spec §4 交付物里出现**，本文档补上（否则扩展侧类型上没有 `autoReconnect`，示例代码无法通过扩展自身的类型检查） |
| C2 | `test/**` **没有任何**导入依赖 electron 的模块；`npm run typecheck` **不含** `test/**`；CI 只在 **windows-latest** 跑 | `tsconfig.node.json`、`tsconfig.web.json`、`.github/workflows/pr-check.yml:20` | 与 #43 一致：测试缝隙用 **electron mock**（#43 设计 §7.2），#44 复用；POSIX-only 分支只能靠开发者在 POSIX 本地跑 |
| C3 | `RPC_INVALID_REQUEST = -32600` 声明但从未使用（`ipcCore.ts:249` 是唯一出现处） | `src/main/ipcCore.ts:249` | #44 **不新增**任何线上码（S4），也不启用该常量 |
| C4 | `MAX_BACKOFF_MS` 等常量必须落在 **`src/shared/`** 而不能落在 `src/main/` | 方向约束：`src/renderer/src/core/manifest.ts` 与 `src/main/ipcCore.ts:15-20` 都从 `../shared/ipcDeclaration` 导入；`shared/ipcDeclaration.ts` 目前**零 import** | §3.4：常量与 `autoReconnect` 校验放 `src/shared/ipcDeclaration.ts`，`src/main/ipcReconnect.ts` **从 shared 导入**（main → shared 是既有方向，见 #43 设计 §2.4 A5） |
| C5 | spec §4 把"断因到'是否可重连'的分类"列在 `src/main/ipcTransport.ts`，但 §4 又把 R4（含该封闭清单）列在 `src/main/ipcReconnect.ts` | spec 内部重叠 | 由设计收敛：**封闭清单 `isReconnectableCloseReason` 落在 `src/main/ipcReconnect.ts`，`ipcTransport.ts` 本次不改**（§3.4 给理由） |
| C6 | 行号基准：#43 落地后 `ipc.ts`/`shared/types.ts`/`api/types.ts`/`host.ts` 的行号会平移 | spec 文首已声明 | 本文档所有 #44 的落点同时给"函数锚点"与 **【43前】** 行号；实现时以代码为准 |

### 2.3 既有行为的两处关键细节（决定设计正确性）

| # | 细节 | 证据 | 设计后果 |
| --- | --- | --- | --- |
| B1 | `openPipeClientTransport` 的 `dispose()` 先置 `disposed = true` 再 `channel.close()`（无 reason）→ `onClose` 收到 **`null`**；而套接字意外 'close' 走 `channel.close(peer-crashed)`（非 null） | `ipcTransport.ts:216-219, 227-231` | **"主动 vs 意外"可靠可判**：`err === null` ⇔ 宿主主动关闭 → 封闭清单只需 `err?.code === 'peer-crashed'`（§6.2） |
| B2 | `channel.close()` 内先 reject 全部挂起、后触发 `closeListeners` | `ipcCore.ts:433-448` | 断连时"挂起先失败、事件后到"固有顺序正确；控制器**不能**在 `closeListeners` 里同步重试（会重入），必须走 `queueMicrotask`/`setTimeout` 异步启动（§4.5 步 5） |

---

## 3. 接口定义（可直接照写代码）

### 3.1 扩展可见面：`src/api/types.ts` 的 `ipc` 增量（在 #43 的 `ipc` 对象上追加/修改）

```ts
  /** 打开 client 通道；`declaration.autoReconnect` 只在此处（**运行时声明对象**）生效，清单里写不生效 */
  connect(declaration: IpcChannelDeclaration | string): Promise<void>

  /**
   * 订阅**重连成功**（issue #44 R7/R9）：每次重连成功后触发一次。
   * - `info.attempts` = 本次重连一共尝试了几次（含成功的那次；首次即成功则为 1）；
   * - **不自动握手**：协议层状态已全部丢弃（新通道、请求 id 从 1 重新开始、挂起表为空），
   *   需要握手的扩展必须在这里自己做（例如重新 `request('hello')`）；
   * - 达到 `retries` 上限仍失败时**不会**触发本事件，通道会从 `channels()` 消失（见 `close` / `onClose`）。
   */
  onReconnect(name: string, cb: (info: { attempts: number }) => void): Disposable
```

`close` / `request` / `notify` / `channels` / `onClose` 的签名**不变**；语义补三条文档（都写进 `ipc` 的 doc 注释，R15）：

| # | 补充语义（文档） |
| --- | --- |
| 1 | **在途请求不重放**：断线瞬间该通道所有挂起请求立即以断因码（`peer-crashed`）失败，**不会**在重连后补发；重连后请自行重发（这正是 `onReconnect` 的用途） |
| 2 | **重连期新请求**：窗口期内 `request`/`notify` 立即以 `not-connected` 失败（不排队、不延迟 resolve）；`channels()` **仍含**该通道名 |
| 3 | **`autoReconnect` 只能写在运行时声明对象里**（`connect({...})` 传的那个对象）；写进清单 `contributes.ipcChannels` **既不报错也不生效**；只对 `transport:'pipe'` 有效，`stdio` + `autoReconnect` 直接 `invalid-declaration` |

### 3.2 渲染进程 ↔ 主进程契约

**`src/shared/types.ts`**（`IpcEvent`，在 #43 的 6 种成员后**追加**第 7 种；既有形状不改）：

```ts
  | {
      extId: string
      name: string
      type: 'reconnect'
      /** 本次重连共尝试次数（含成功那次） */
      attempts: number
    }
```

**`window.api` / preload：无新方法**（R14）。`ipc:request` 在重连窗口期靠既有 `not-connected` 返回（`ipc.ts:76-82`/`host.ts` 既有链路，F4），不做任何桥层改动。**`src/preload/index.ts` 本次不改。**

**`src/renderer/src/core/host.ts`**（`buildIpcApi`；在 #43 的 `ChannelListeners` 上再加一个集合）：

```ts
    type ChannelListeners = {
      requests: Set<(method: string, params: unknown) => unknown>
      notifications: Set<(method: string, params: unknown) => void>
      closes: Set<(err: { code: string; message: string }) => void>
      stderrs: Set<(text: string) => void>
      connections: Set<(connectionId: number) => void>          // #43
      disconnects: Set<(connectionId: number, err: {...}) => void> // #43
      reconnects: Set<(info: { attempts: number }) => void>      // #44 新增
    }

    // ipc:event 分发里再加一支（放在 request 兜底分支之前）
      if (e.type === 'reconnect') {
        for (const cb of [...target.reconnects]) cb({ attempts: e.attempts })
        return
      }

    // 新成员
    onReconnect: (name, cb): Disposable => {
      const target = forChannel(name)
      target.reconnects.add(cb)
      return { dispose: (): void => void target.reconnects.delete(cb) }
    },
```

`close(name)`（【43前】`host.ts:1224-1227`）**保持不变**：`listeners.delete(name)` 已经清掉包括 `reconnects` 在内的全部监听（spec §4"需保留"即此项）。

### 3.3 `src/main/ipcReconnect.ts`（新增，electron-free，**纯逻辑 + 注入 sleep**）

风格先例：`src/main/hookBridge.ts:51-68,77-129`（工厂函数 + 可注入 `setTimer`/`clearTimer` + `pendingCount()` 诊断出口）；其测试先例 `test/hook-bridge.test.ts:1-70`。

```ts
/**
 * 断线自动重连的**纯逻辑控制器**（**不依赖 electron**，可独立单测）。
 *
 * 语义（issue #44）：
 * - 只在"首次连接成功后发生**可重连**断因"时启动（首连失败由 `connect()` 抛错给扩展，R4）；
 * - 退避序列 `backoffMs × 2^(i-1)`，单次等待封顶 `maxBackoffMs`（默认 `MAX_BACKOFF_MS`，S1）；
 * - **不排队、不重放**任何请求（N1/N2）：控制器只负责"重建传输"，请求语义由 `ipc.ts` 负责；
 * - 定时器 `unref()`（R11），不拖住进程退出或测试。
 */
import type { IpcCoreError } from './ipcCore'
import { MAX_BACKOFF_MS } from '../shared/ipcDeclaration'

/** 可重连断因的**封闭清单**（R4/S2）：只有 peer-crashed 可重连；其余一律不可 */
export function isReconnectableCloseReason(err: IpcCoreError | null): boolean

/** 单次等待时长（纯函数，便于单测；i 从 1 起） */
export function backoffDelayFor(input: {
  attempt: number
  backoffMs: number
  maxBackoffMs?: number
}): number

export interface ReconnectControllerOptions {
  /** 重试次数上限（> 0；`0` 由调用方在声明层判为"关闭"，不会走到这里） */
  retries: number
  /** 首次等待（毫秒，≥ 0） */
  backoffMs: number
  /** 单次等待封顶（默认 `MAX_BACKOFF_MS`） */
  maxBackoffMs?: number
  /**
   * 一次重连尝试：成功 resolve（此后控制器停止，不再有等待/尝试）；
   * 失败 reject（含 `connect-failed`）→ 按退避继续；**不区分错误码**（R4：重连期的 connect-failed 只用于继续退避）
   */
  attempt: () => Promise<void>
  /** 每次尝试**开始前**（等待结束后）回调，`attempt` 从 1 起 */
  onAttempt?: (attempt: number) => void
  /** 重连成功（`attempts` = 本次共尝试次数，含成功那次） */
  onSuccess?: (info: { attempts: number }) => void
  /** 用尽 `retries` 次仍失败（**不**触发 `onSuccess`） */
  onGiveUp?: (lastError: unknown) => void
  /** 注入 sleep（默认 `setTimeout` + `unref()`；测试注入假实现以获得确定性序列） */
  sleep?: (ms: number) => Promise<void>
}

export interface ReconnectController {
  /** 启动（幂等：已在跑则忽略）。**异步**：首次尝试在第一次退避等待之后（V5 的序列要求） */
  start(): void
  /** 取消剩余重试并清理定时器（幂等；已 resolve 的尝试不受影响，`onSuccess` 不再触发） */
  cancel(): void
  readonly running: boolean
  /** 已进行的尝试次数 */
  readonly attempts: number
}

export function createReconnectController(options: ReconnectControllerOptions): ReconnectController
```

**默认 `sleep`（唯一涉及定时器的实现，必须抄这条）**：

```ts
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.() // 先例：src/main/ipcCore.ts:347（不要因为一次退避拖住进程退出/测试）
  })
```

### 3.4 声明面：三份副本同步 + 运行时校验入口 + 归一化（R1/R2/R12/R18）

**① 类型（三份，逐字一致）**——`src/api/shared.ts`（扩展作者面，**spec §4 未列，本文档补**）：

```ts
/**
 * 断线自动重连策略（issue #44）。**只在运行时声明对象里生效**：
 * `api.ipc.connect({ id, transport: 'pipe', autoReconnect: { retries: 5 } })`。
 * 写进 manifest 的 `contributes.ipcChannels` **既不报错也不生效**（R13/R18）。
 * 仅对 `transport: 'pipe'` 有效；`stdio` + `autoReconnect` → `invalid-declaration`。
 */
export interface IpcAutoReconnect {
  /** 重试次数上限（缺省 3；`0` 等价于关闭；必须是非负整数） */
  retries?: number
  /** 首次退避毫秒（缺省 250；按 ×2 递增，单次封顶 30000；`0` = 不等待；必须是非负有限数） */
  backoffMs?: number
}

export interface IpcChannelDeclaration {
  id: string
  transport: 'stdio' | 'pipe'
  program?: string
  args?: string[]
  framing?: 'content-length' | 'ndjson'
  /** 断线自动重连（仅运行时声明；见 `IpcAutoReconnect`） */
  autoReconnect?: IpcAutoReconnect
}
```

同步落点：`src/api/shared.ts:45-55`、`src/shared/types.ts:454-462`、`src/shared/ipcDeclaration.ts:17-28`（三处都要加同一个字段）。`IpcAutoReconnect` 的导出**无需再改别的文件**：`src/api/index.ts:11` 已有 `export * from './shared'`（已核对），新接口自动进入扩展 API 的导出面。

**② `src/shared/ipcDeclaration.ts` 的常量与两个入口**：

```ts
/** 重连缺省值（R2）与单次等待封顶（S1）——定义在 shared：main 与 renderer 都要能 import，且 shared 必须保持零 node 依赖 */
export const DEFAULT_RECONNECT_RETRIES = 3
export const DEFAULT_RECONNECT_BACKOFF_MS = 250
/** 单次退避等待的上限（与"默认请求超时 30s"同量级，S1） */
export const MAX_BACKOFF_MS = 30_000

/** 归一化后的重连策略（缺省已填） */
export interface ResolvedAutoReconnect { retries: number; backoffMs: number }

/**
 * 把 `autoReconnect` 原始值校验并归一化；非法抛 `IpcDeclarationError`（→ `invalid-declaration`）。
 * **未知键静默忽略**（与顶层逐键白名单读取同风格，见 E3）。
 */
export function normalizeAutoReconnect(raw: unknown): ResolvedAutoReconnect

/**
 * **只服务运行时声明**的校验入口（R18 的"设计阶段定名"）：在 `validateIpcDeclaration` 的
 * 白名单归一化之上，**额外**校验并保留 `autoReconnect`。
 *
 * **清单校验路径（validateIpcDeclaration / checkIpcDeclaration / checkIpcChannelList）绝不可调用本函数。**
 */
export function validateRuntimeIpcDeclaration(raw: unknown): IpcChannelDeclaration

/**
 * 按 id 取清单里声明的通道（issue #45）。**R18：返回白名单归一化后的声明**——
 * 只含 `id/transport/program/args/framing`，`autoReconnect` 与任何未知键在此被**剥掉**，
 * 使"清单里写 autoReconnect 不生效"由**构造**保证，而不是靠"没人读它"。
 */
export function resolveIpcChannelDeclaration(
  declarations: readonly IpcChannelDeclaration[] | undefined,
  id: string
): IpcChannelDeclaration | undefined
```

**③ `validateRuntimeIpcDeclaration` 的精确语义**（照写）：

```ts
export function validateRuntimeIpcDeclaration(raw: unknown): IpcChannelDeclaration {
  // 第一步：白名单归一化 + 既有全部规则（未知键被丢弃；autoReconnect 此时**不在**结果里）
  const declaration = validateIpcDeclaration(raw)
  const reconnectRaw = isRecord(raw) ? raw.autoReconnect : undefined
  if (reconnectRaw === undefined) return declaration
  // 第二步：只对运行时声明生效的重连校验（R2/R3/R12）
  const policy = normalizeAutoReconnect(reconnectRaw)          // 非法 → IpcDeclarationError
  if (declaration.transport !== 'pipe') {
    throw new IpcDeclarationError(
      `通道 ${declaration.id} 的 autoReconnect 只支持 pipe（stdio 场景请自行 connect() 重连，或改用 pipe）`
    )
  }
  if (policy.retries === 0) return declaration                  // `retries: 0` = 关闭（R2）：不写回该键
  declaration.autoReconnect = { retries: policy.retries, backoffMs: policy.backoffMs }
  return declaration
}
```

`normalizeAutoReconnect` 的接受面（逐条可测）：

| 输入 | 结果 |
| --- | --- |
| `undefined` | 走不到（调用方已判）；如直接调用 → 返回缺省 `{retries:3, backoffMs:250}`（实现时统一：非对象 → 抛错，见下） |
| `{}` | `{retries: 3, backoffMs: 250}`（缺省填充，R2） |
| 非对象（`5` / `'x'` / `true` / `null`） | 抛 `IpcDeclarationError`（R2"非对象"） |
| `{retries: -1}` / `{retries: 1.5}` / `{retries: NaN}` / `{retries: '3'}` | 抛错（R2"负数 / 非整数"） |
| `{retries: 0}` | `{retries: 0, backoffMs: <缺省或给定>}`（= 关闭） |
| `{backoffMs: -1}` / `{backoffMs: Infinity}` / `{backoffMs: 'x'}` | 抛错 |
| `{backoffMs: 0}` | 合法 = 不等待（E4） |
| `{retries: 5, unknownKey: 1}` | `{retries: 5, backoffMs: 250}`，未知键**静默忽略**（E3） |

**④ `resolveIpcChannelDeclaration` 的归一化实现（R18 必做项）**：

```ts
export function resolveIpcChannelDeclaration(
  declarations: readonly IpcChannelDeclaration[] | undefined,
  id: string
): IpcChannelDeclaration | undefined {
  if (!declarations || declarations.length === 0) return undefined
  const wanted = id.trim()
  const found = declarations.find((declaration) => declaration.id === wanted)
  if (!found) return undefined
  // R18：**白名单归一化**（复用同一个校验器 = 清单里写 autoReconnect/未知键一律被剥掉）。
  // 注：清单在加载期已过 checkIpcChannelList，这里抛错属"不可能路径"；仍显式抛出以便
  // 一旦有人绕过清单校验能在日志里看见，而不是静默降级。
  try {
    return validateIpcDeclaration(found)
  } catch (err) {
    throw new IpcDeclarationError(
      `清单里的通道 ${wanted} 非法: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
```

**为什么这样改就"由构造保证"**：`validateIpcDeclaration` 只**逐键读取** `id/transport/framing/program/args` 并**新建**一个对象返回（`ipcDeclaration.ts:74-102`）——它天然就是白名单归一化器。让它既做清单校验、又做归一化，`autoReconnect` **不可能**穿过 `resolveIpcChannelDeclaration`。这比手写 `pick()` 更硬：将来给运行时声明再加键（如 `onReconnectHandshake`），归一化会自动跟上，不需要再改一处白名单。

**⑤ 调用点（`ipc.ts`，一行一处）**：

| 场景 | 现在（【43前】） | #44 后（【43后】） |
| --- | --- | --- |
| 运行时声明（`connect` 对象）与 `listen` 的校验 | `validateIpcDeclaration(rawDeclaration)` @ `ipc.ts:152`（#43 保持"单独一行"） | **改为** `validateRuntimeIpcDeclaration(rawDeclaration)`（同一行；`openExtensionChannel`） |
| `listen` 的校验（#43 新增） | —— | 保持 `validateIpcDeclaration`（服务端不涉及重连；若扩展给 listen 传了 `autoReconnect` → 被白名单剥掉，静默不生效；**这条也在 §9 V13 里锁一条**） |
| 清单声明路径 | `checkIpcChannelList` @ `manifest.ts:49` | **一字不改** |
| 清单 → 运行时解析 | `resolveIpcChannelDeclaration` @ `host.ts:1214` | 函数内部改（调用点不改） |

### 3.5 `src/main/ipcTransport.ts`：**本次不改**（C5 的收敛）

| 需求 | 为什么不需要改它 |
| --- | --- |
| 断因分类（R4 的封闭清单） | 分类是**重连策略**，放 `ipcReconnect.ts` 的 `isReconnectableCloseReason`（R4 在 spec §4 里本来就归 `ipcReconnect.ts`）；`ipcTransport.ts` 只负责"如实地把断因交给 `channel.close(reason)`"，它已经做到了（`ipcTransport.ts:205-219`） |
| 重建句柄（R8） | 直接用既有 `openPipeClientTransport({endpoint, framing})`（`ipcTransport.ts:185-233`）重建一个新传输即可，"重建"不需要句柄特化 |
| 主动 vs 意外（B1） | `err === null` vs `err.code === 'peer-crashed'` 已足够；不需要新参数 |
| 收尾（销毁半死套接字） | 由 `ipc.ts` 在"不可重连"分支调 `transport.dispose()`（幂等）完成，不动传输层 |

结论：**`src/main/ipcTransport.ts` 的 233 行一行不改**（回归面最小；也把 spec §4 里的重复项按 C5 收敛掉）。

---

## 4. 数据流与状态机

### 4.1 表一：通道表（`src/main/ipc.ts`，在 #43 的判别联合上扩 client 分支）

| 分支 | 形状 | 字段说明 |
| --- | --- | --- |
| `server` | `{ kind: 'server'; server: IpcServerHandles }` | #43，本 issue 不动 |
| `client`（**#44 扩**） | `{ kind: 'client'; state: 'open' \| 'reconnecting'; transport: IpcTransportHandles \| null; reconnect?: ClientReconnectBinding }` | 见下表 |

```ts
/** client 通道上的重连绑定（只有 `autoReconnect` 生效的通道才有） */
interface ClientReconnectBinding {
  /** 生效策略（缺省已填；`retries: 0` 的通道不会带这个绑定） */
  policy: ResolvedAutoReconnect
  /** 用**首次连接时算出的端点与 framing** 重建传输（R8：通道名/声明/framing 保留） */
  rebuild: () => Promise<IpcTransportHandles>
  /** 当前控制器（窗口期有；成功/放弃后为 null） */
  controller: ReconnectController | null
}
```

| 字段 | `state === 'open'` | `state === 'reconnecting'` |
| --- | --- | --- |
| `transport` | 可用句柄 | **`null`**（旧句柄已 dispose；协议层状态全丢，R8） |
| `reconnect.controller` | `null`（或上次的已结束控制器） | 正在跑的控制器 |
| `channels()` 是否含该名字 | 含 | **含**（K3：区分"正在重连"与"已放弃"的唯一手段） |
| `requireClientTransport` 的行为 | 返回句柄 | **抛 `not-connected`**（R6/K3） |
| `onDisconnect` 语义 | 不适用（客户端通道没有连接 ID，R8） | 不适用 |

**客户端通道的记录里没有 `connectionId` 字段** —— 这是 R17① 在类型层面的落实（V15 断言"该通道全程没有 `connectionId`"）。

### 4.2 表二：连接表

**不适用**：#44 只覆盖客户端通道；连接表（`src/main/ipcServer.ts`）属 #43，本 issue 不触碰。唯一关系是 R17②：服务端连接的断开只广播 `disconnect` 事件，**不挂**任何重连控制器（#43 设计 §4.5）。

### 4.3 表三：挂起请求表（客户端侧的两张）

| 子表 | 位置 | 键 | #44 的行为 |
| --- | --- | --- | --- |
| **3a' 出站挂起** | `JsonRpcChannel.pending`（`ipcCore.ts:293`） | 请求 id（每通道从 `1` 起，`:299`） | 断线时由 `channel.close(peer-crashed)` **一次性全部 reject**（`:433-448`）→ 扩展侧 `api.ipc.request` 拿到 `peer-crashed`（R5）。**重连后是新的 `JsonRpcChannel`**：`pending` 空、`nextId` 回到 `1`（R8/V15） |
| **3b' 转发挂起** | `ipc.ts` 的 `pendingReplies`（#43 已加 `connectionId` 字段） | `requestId` | 客户端通道上的对端请求其 `connectionId` 为 `null`；客户端通道**不会**在重连时产生"连接断开"事件（没有连接概念），而是整条通道关闭 → 由 `channel.close` 抛错结算；#43 的 `failForwardedForConnection` **不适用**（那是 server 连接专用） |

**"绝不重放"的三条保证（可测）**：

| # | 保证 | 实现 | 测试 |
| --- | --- | --- | --- |
| 1 | 挂起项在断开时**立即**失败 | `ipcCore.ts:433-448`（既有） | V3：`api.ipc.request` reject 码 `peer-crashed` |
| 2 | 没有任何"重发队列" | 控制器只有 `attempt`（重建传输），**没有**请求参数、没有 pending 快照（§3.3 的接口里不存在这样的参数） | V3：对端重启后按 method 计数 = 1 |
| 3 | 新通道的挂起表为空、id 从 1 起 | 重建 = `new JsonRpcChannel`（`openPipeClientTransport` 内部） | V15：对端看到的第一条请求 `id === 1`；旧 id 的回包不唤醒任何请求 |

### 4.4 客户端通道的状态机（含事件时序）

```
                       connect(decl)
                            │
                    ┌───────▼────────┐   首连失败（ready reject / connect-failed）
                    │  不在表内       │──────────────► connect() 抛错给扩展（不挂控制器，R4）
                    └───────┬────────┘
                            │ 首连成功 → 表内 state='open'
                            │
        ┌───────────────────▼────────────────────┐
        │ state='open'（transport 可用）          │◄──────────────┐
        │  request/notify 正常；channels() 含它    │               │ 重建成功：
        └───────────────────┬────────────────────┘               │ attach 新 transport、
                            │ 意外断开（peer-crashed）             │ state='open'、attempts=N
                            │ 且 policy.retries > 0               │ 广播 reconnect{attempts}
                ┌───────────▼─────────────┐                       │
                │ 1) 广播 close{peer-crashed}（恰好一次，R7）       │
                │ 2) transport=null, state='reconnecting'          │
                │ 3) controller.start()  → 退避等待 → attempt()    │
                └───────────┬─────────────┘                       │
                            │ 每次 attempt 失败（connect-failed 等）──┘（回到等待，attempt+1）
                            │
                            │ 尝试次数用尽
                            ▼
                  ┌──────────────────────┐
                  │ 从表内删除（channels() 不再含）│  不再重试；**不**再广播第二次 close（E1）
                  │ 之后 request → not-connected  │
                  └──────────────────────┘
```

| 时刻 | 主进程动作（精确顺序） | 渲染进程观察 |
| --- | --- | --- |
| 1 | **首连**：`openExtensionChannel` → `validateRuntimeIpcDeclaration`（含 `autoReconnect`）→ `assertChannelSlot` → `openPipeClientTransport` → `await ready` → `attachClientChannel`（含 `reconnect` 绑定） | `connect()` resolve |
| 2 | **意外断开**：`channel.onClose(err)`：`err.code === 'peer-crashed'` 且 `policy.retries > 0` → ①`transport.dispose()`（幂等收尾）②`transport=null`、`state='reconnecting'`③`broadcast(close{peer-crashed})`④`controller.start()` | `onClose` **一次**（R7，**在第一次重试之前**） |
| 3 | **窗口期**：`requireClientTransport` 命中 `state==='reconnecting'` → 抛 `not-connected` | `request`/`notify` 立即 reject `not-connected`；`channels()` **仍含**该通道 |
| 4 | **等待/尝试**：`sleep(backoffDelayFor({attempt,backoffMs}))` → `onAttempt(attempt)` → `attempt()`（内部 `rebuild()` → `await ready` → `attachClientChannel`） | 无事件（attempt 失败对扩展不可见，R4） |
| 5 | **成功**：`attachClientChannel`（新 `JsonRpcChannel`，`state='open'`，`controller=null`）→ `onSuccess` → `broadcast(reconnect{attempts})` | `onReconnect({attempts})` 一次；此后 `request` 正常（协议层状态已归零，需自行握手） |
| 6 | **用尽**：`onGiveUp` → `channels.delete(name)` | **无新事件**（E1）；`channels()` 不再含该名字；后续 `request` → `not-connected` |
| 7 | **`close(name)`（窗口期或任何时候）**：①`controller.cancel()`②`transport?.dispose()`③`channels.delete(name)` | 一次 `close{channel-closed}`（由 dispose 触发的既有广播路径）；之后**不再**有任何 `onReconnect`；无遗留定时器 |
| 8 | **扩展停用/退出**：`closeExtensionIpc` 对每个 client 通道走与第 7 步相同的顺序；对 server 走 #43 的收尾 | 同上（每通道一次 `close`） |
| 9 | **不可重连断因**（`err === null` / `protocol-error` / 其它）：**不**进窗口：删表 + 广播 close（既有行为）；若该通道带过 `reconnect` 绑定，额外 `transport.dispose()` 收尾（E5：只对启用过重连的通道生效，R16 不受影响） | `onClose` 一次，`code` 为断因码；`channels()` 立即不含它（与今天一致） |

### 4.5 断开瞬间的失败传播顺序（R5；与 #43 R18 同源）

| 步 | 动作 | 语义 | 依据 |
| --- | --- | --- | --- |
| 1 | 套接字层察觉断开（`error`/`close`） | `channel.close(new IpcCoreError('peer-crashed', '对端连接已关闭'))` | `ipcTransport.ts:216-219`（既有） |
| 2 | **挂起先失败** | 3a' 表全部 `reject(peer-crashed)`（清 timer、移除 abort 监听） | `ipcCore.ts:438-442`（既有，先于 closeListeners） |
| 3 | 触发 `closeListeners` | 注册表处理器拿到断因 `err`（非 null） | `ipcCore.ts:443` |
| 4 | 分类与分支 | `isReconnectableCloseReason(err)` → 可重连则走 §4.4 第 2 步；否则走第 9 步 | §6.2/§6.3 |
| 5 | **异步启动控制器**（B2） | `start()` 内部第一件事就是 `await sleep(...)`，**不**在 `closeListeners` 的同步栈里做任何 I/O；因此不存在"在 `channel.close` 中重入"的风险 | `ipcCore.ts:433-448` 的同步栈 + §3.3 的 `start()` 实现 |
| 6 | 广播 `close`（一次） | `code:'peer-crashed'`、`message` 取断因 message | R7 |
| 7 | **不重放** | 无重发队列（§4.3）；新通道挂起表为空 | R5 / N1 |

### 4.6 额度、`channels()` 与本地错误码判定点

| 项 | 语义 | 实现 |
| --- | --- | --- |
| 额度 | 窗口期**仍占** 1 条通道额度（表项还在）→ 扩展不能在重连期间再 `connect` 同名通道（会 `invalid-declaration 通道 X 已打开`）；这是刻意的：窗口期重连的"位子"必须留住 | `assertChannelSlot`（#43 未改） |
| `channels()` | 窗口期含、放弃后不含 | `listExtensionChannels`（#43 未改，`[...map.keys()]`） |
| `not-connected` 判定 | `requireClientTransport` 里 `state === 'reconnecting'` → `new IpcCoreError('not-connected', \`通道 ${name} 正在重连（请求不排队，请在 onReconnect 后重发）\`)` | 【43前】`ipc.ts:76-82` 的函数体；#43 已把该函数拆出（#43 设计 §3.4） |
| `close(name)` | 统一语义（#43 R3）+ 先 `cancel()` | 【43前】`ipc.ts:217-224`；#44 在 `transport.dispose()` **之前**插 `reconnect?.controller?.cancel()` |
| `closeExtensionIpc` | 逐通道同上 | 【43前】`ipc.ts:227-232`；#44 在循环体里加同样的 cancel |

### 4.7 与 #43 的边界（R17 的落地细节）

| 问题 | 结论 |
| --- | --- |
| 客户端重连会产生 `connectionId` 吗？ | **不会**（§4.1 类型里没有该字段）。"旧连接 ID 永久退役"在 #44 里表现为**否定式**：既然不申请 ID，就不存在复用，也不会让扩展误以为重连前后是同一个可寻址对象（这正是 Q1 否决"重连后沿用同一 ID"的理由） |
| 若重连的对端恰好是**另一个 obox 宿主**（对方跑 #43 的服务端），它看到什么？ | 对方看到一次**全新连入**、拿一个**新 ID**，旧 ID 在对方侧按 #43 §4.4 永久退役（客户端侧无需知情、也拿不到该 ID） |
| 服务端连接会走这套控制器吗？ | **不会**：控制器只挂在 client 分支；服务端只有 #43 的 `onConnection`/`onDisconnect` |
| `close(name)` 关一个 server 会不会顺带取消某条 client 通道的重连？ | 不会：同一个名字不可能既是 server 又是 client（#43 的统一命名空间 + 重名报错） |

---

## 5. 错误码与线上码

### 5.1 结论：**不新增任何错误码**（S4）

| 项 | 值 | 依据 |
| --- | --- | --- |
| `IpcErrorCode` 闭集 | 保持 #43 后的 **12** 个；#44 **不加** | S4 |
| 重连窗口期的失败码 | 复用 `not-connected` | R6 |
| 放弃后的失败码 | 复用 `peer-crashed`（已由断连那次 `onClose` 表达）+ `not-connected`（后续请求） | R9/S4 |
| 线上整数码 | #44 **完全不产生**线上帧：重连是宿主↔渲染进程内部行为，对端只看到"旧连接关闭 + 新连接连入" | N3/R14 |
| 为什么不用 `reconnect-exhausted` | spec §4 已明写"若设计阶段发现需要新错误码，**须回到本 spec 改判**" → 本设计判定**不需要**：`channels()` 的包含关系（K3）已能区分"正在重连"与"已放弃" | spec #44 §4 |

### 5.2 本地错误码与判定位置（全表）

| 场景 | 扩展看到的码 | 判定位置（函数 / 落点） |
| --- | --- | --- |
| `connect({transport:'stdio', program, autoReconnect})` | `invalid-declaration` | `src/shared/ipcDeclaration.ts` 的 `validateRuntimeIpcDeclaration`（第二步的 transport 检查）→ 经 `ipcCore.ts:680-686` 包装 → `ipc.ts` 的 `failure()` → `host.ts` 抛 `[invalid-declaration] …`（§5.3①） |
| `connect({transport:'pipe', autoReconnect:{retries:-1}})` | `invalid-declaration` | 同函数的 `normalizeAutoReconnect` |
| `listen({... autoReconnect:{...}})`（#43 的方法） | **无错**：`autoReconnect` 被白名单剥掉（静默不生效） | `listen` 走 `validateIpcDeclaration`（#43）；本设计 §9 V13 加一条锁死用例 |
| 首连失败（对端没起） | `connect-failed`（**不**进重连） | `ipcTransport.ts:205-212` + `ipc.ts:184` 的 `await transport.ready`（R4） |
| 窗口期 `request` / `notify` | `not-connected` | `requireClientTransport` 的窗口期分支（§4.6） |
| 窗口期 `channels()` | 正常返回（**含**该名字） | `listExtensionChannels` |
| 断连瞬间在途 `request` | `peer-crashed` | `ipcCore.ts:433-448` |
| 对端发非法帧 | `protocol-error` + 通道从表内移除（**不重连**，R4/S2） | `isReconnectableCloseReason` 返回 false → §4.4 第 9 步 |
| 用尽重试后 `request` | `not-connected` | 表内已无该名字（§4.4 第 6 步） |
| `close(name)` 期间 | 无（不触发任何新错误） | §4.4 第 7 步 |
| 端点被旧实例占用（重连一直 `connect-failed`） | `connect-failed` 只在内部用于继续退避；用尽后与"放弃"同路径 | R4/K6 + §9 V17 |

### 5.3 `invalid-declaration` 的三例（#43 两例 + #44 一例）

| # | 触发 | 判定位置（**函数锚点** / 【43前】行号 → 【43后】落点） | 判定顺序 |
| --- | --- | --- | --- |
| ① | **（本 issue）** `transport:'stdio'` + `autoReconnect` | `src/shared/ipcDeclaration.ts` 的 **`validateRuntimeIpcDeclaration`**（新增函数，插在 `checkIpcChannelList`（【43前】`:120-137`）之前、`checkIpcDeclaration`（【43前】`:106-114`）之后）；调用点 **`src/main/ipc.ts:152`**（【43前】；#43 明确保持它"单独一行"） | **在** `validateIpcDeclaration` 之后（先享受白名单归一化与既有规则），**再**判 `transport !== 'pipe'` |
| ② | `listen({transport:'stdio'})` | `src/main/ipc.ts` 的 `openExtensionServer`（#43 新增，插在【43前】`:186` 与 `:195` 之间） | #43 设计 §5.3① |
| ③ | server 名省略 `connectionId` / client 通道传 `connectionId` | `src/main/ipc.ts` 的 `resolveTarget`（#43 新增） | #43 设计 §5.3②③ |

**①的文案（推荐值，只锁前缀）**：`[invalid-declaration] 通道 svc 的 autoReconnect 只支持 pipe（stdio 场景请自行 connect() 重连，或改用 pipe）` —— 方向来自 R12（"自行 `connect()`"或"改用 pipe"），措辞照 #43 §5.4 D6 的原则（测试只断言 `/^\[invalid-declaration\]/`）。

### 5.4 待定项（spec 未定；给推荐值 + 理由）

**【设计待定：需在实现前确认】E1**：达到重试上限"放弃"时是否**再**触发一次 `onClose`？
- 背景冲突：R7 写"`onClose` 每个断连周期**恰好触发一次**（在第一次重试尝试之前）"；R9 写"达到上限仍失败时**触发 `onClose`**（带 `peer-crashed`）并从注册表移除"；V17 的断言写"`onClose` **一次**"。
- **推荐：不再触发**（一个断连周期只有一次 `onClose`；"已放弃"由 `channels()` 不含该名字表达，K3 已把这个判据写进 spec）。
- 理由：① 验收标准 V17 的"`onClose` 一次"是**可执行**的口径，散文（R9）与之冲突时以验收为准；② K3（风险表）已经把"`channels()` 仍含＝正在重连、不含＝已放弃"定为对外可观测的区分手段；③ 若真需要"放弃"的直接信号，正确做法是**回 spec 加一个事件**（如 `onReconnectFailed(name, cb)`）而不是复用 `onClose` 的第二次触发（后者会破坏 R7 的强不变量，且让"`close` 事件恰好一次"的既有消费方产生误判）。
- 代价（须在 api-reference 明写）：扩展无法被动得知"已放弃"，必须轮询 `channels()` 或在 `onReconnect` 迟迟不来时自行超时判断。

**【设计待定：需在实现前确认】E2**：`retries` 是否需要上限封顶（例如禁止 `retries: 100000`）？
- **推荐：不额外封顶**，只校验"存在时必须是有限非负整数"；只有 `backoffMs` 按 S1 封顶**单次等待**（`MAX_BACKOFF_MS`）。
- 理由：① spec 只对"单次等待"给了封顶（S1 的理由是"避免单次等待超过一次请求超时"），没有对次数给封顶；② 隐式上限会与"`retries` 是扩展声明的意图"冲突（扩展说 100 次却被静默截断到 10 次，比拒绝更糟）；③ 无 DoS 面：扩展与宿主同上下文、属受信代码（ADR-0015），且每次尝试之间至少等 `backoffMs`。

**【设计待定：需在实现前确认】E3**：`autoReconnect` 对象里的**未知键**（如 `{retries:3, jitterMs:50}`）如何处理？
- **推荐：静默忽略**（逐键白名单读取，与 `validateIpcDeclaration` 顶层同风格：`src/shared/ipcDeclaration.ts:54-103` 只读取已知键、忽略其它键；#43 的 V15 已把这一风格用用例锁死）。
- 理由：spec R2 的措辞是"非法（负数 / 非整数 / **非对象** / 未知字段**类型**错）"——"未知字段类型错"最自然的读法是"**已知键的值类型**错"（如 `retries:'3'`），不是"出现了未知键"。若判为非法，`autoReconnect` 的接受面会与顶层声明面**不一致**（顶层忽略未知键、内层报错），这对扩展作者是更难预期的行为。

**【设计待定：需在实现前确认】E4**：`backoffMs: 0` 是否合法（= 立即重试）？
- **推荐：合法**（等价于"不等待"，实现上仍是异步的 `setTimeout(0)`）；负数 / `Infinity` / `NaN` / 非数字 → `invalid-declaration`。
- 理由：① R2 只把"负数 / 非整数"判为非法，`0` 既不是负数也不是非整数；② `0` 的语义清晰（"尽快重连"，用于对端会立刻回来的场景）；③ 与 `retries: 0`（= 关闭）不同键、不冲突，不会产生歧义。

**【设计待定：需在实现前确认】E5**：**未启用** `autoReconnect` 的通道在**意外断连**后，是否也调 `transport.dispose()` 收尾（销毁可能已半死的套接字）？
- **推荐：不调**（只在"该通道曾带 `reconnect` 绑定"时才收尾）；未启用的通道走**与今天完全一致**的代码路径。
- 理由：R16 要求"不传 `autoReconnect` 的扩展在断线时行为与今天**完全一致**"。多一次 `dispose()` 虽然几乎不可观测（通道已 close、`close` 事件已广播），但会把 R16 从"逐字节一致"降级为"看起来一致"，而这是可以零成本避免的（一个 `if`）。
- 代价：未启用重连的通道在 `protocol-error` 后套接字可能留到进程退出（今天的既有行为，非本次引入）。若将来要统一收尾，属独立改动（会触碰 R16，须回 spec）。

---

## 6. 重连控制器：退避、封闭清单、窗口期判定、事件形状、ID 退役

### 6.1 退避算法（精确公式与边界）

| 项 | 值 | 依据 |
| --- | --- | --- |
| 等待序列 | `wait(i) = min(backoffMs × 2^(i−1), maxBackoffMs)`，`i = 1..retries` | R2/S1 |
| 默认 `retries` | `3` | R2 |
| 默认 `backoffMs` | `250` | R2 |
| 默认 `maxBackoffMs` | `MAX_BACKOFF_MS = 30_000`（定义在 `src/shared/ipcDeclaration.ts`，C4） | S1 |
| `retries = 3, backoffMs = 250` | 等待 `[250, 500, 1000]`，共 **3** 次尝试；第 3 次失败即放弃（**不**再等第 4 次） | V5 |
| `retries = 3, backoffMs = 20000` | 等待 `[20000, 30000, 30000]` | V14（封顶） |
| `backoffMs = 0` | 三次等待都是 `0`（仍然异步：`setTimeout(0)`） | E6 |
| `retries = 0` | **不启动控制器**（声明层即等价关闭，`validateRuntimeIpcDeclaration` 连 `autoReconnect` 都不写回） | R2 |
| 溢出保护 | `2^(i−1)` 用循环累乘并在超过 `maxBackoffMs` 后**停止累乘**（`delay = Math.min(delay * 2, maxBackoffMs)`），避免 `Infinity` | 实现约束（`backoffDelayFor` 纯函数可测） |
| jitter / 熔断 / 无限重试 | **不做** | N4 |
| 定时器 | `unref()`（`defaultSleep`，§3.3） | R11/K4 |
| 时钟注入 | 只注入 `sleep`（不注入 `Date.now`）：退避是"等待时长"序列，不是"绝对时刻"序列，够用且测试更简单 | R11（"时钟与 sleep 可通过参数注入"的最小实现） |

### 6.2 可重连断因的**封闭清单**（实现位置 = `src/main/ipcReconnect.ts`）

```ts
/**
 * 可重连断因**封闭清单**（R4/S2）——只有列在这里的断因才重连。
 * 依据 `JsonRpcChannel.onClose` 的 `err` 语义（`ipcCore.ts:408-416,433-448`）：
 * - `err === null`  ⇒ 调用方主动 `close()`（含 `transport.dispose()`）→ **不可重连**（`channel-closed`）
 * - `peer-crashed` ⇒ 对端退出 / 套接字关闭（`ipcTransport.ts:99-107,216-219`）→ **可重连**
 * - `protocol-error` ⇒ 对端发非法帧（`ipcCore.ts:493-499`）→ **不可重连**（避免与坏对端无限拉锯）
 * - 其余（`message-too-large` / `not-connected` / …）⇒ 都不可能作为 close 原因出现，一律视为不可重连
 * - **首连失败不在此清单的判定范围**：它由 `connect()` 抛错，控制器根本不启动
 */
export function isReconnectableCloseReason(err: IpcCoreError | null): boolean {
  return err?.code === 'peer-crashed'
}
```

| 断因 | 可重连？ | 为什么 |
| --- | --- | --- |
| `peer-crashed`（对端进程退出 / 套接字关闭） | ✅ | R4 的唯一触发源 |
| `err === null`（宿主主动 `close()` / 扩展停用 / `closeExtensionIpc`） | ❌ | R4（`channel-closed` 不触发）；否则 `close()` 后还会自己连回来 |
| `protocol-error`（非法帧） | ❌ | R4/S2：避免与坏对端无限拉锯；V16 锁死 |
| 首次 `connect()` 失败（`connect-failed`） | ❌ | R4：由 `connect()` 抛错给扩展 |
| 重连尝试期间的 `connect-failed` | 不算"放弃"，只用于**继续退避** | R4（由 `attempt()` 的 reject 表达，控制器不区分错误码） |
| `channel-closed`（作为 close 原因由主动关闭产生） | ❌ | 同 `err === null` 行 |

### 6.3 触发时机（首连成功之后）与"何时不启动"

| 条件 | 结果 | 证据 |
| --- | --- | --- |
| 声明带 `autoReconnect` 且 `retries > 0`，且 `transport === 'pipe'`，且**首连成功** | 挂 `ClientReconnectBinding`；此后 `peer-crashed` 断开即启动控制器 | R1/R3/R4 |
| 首连失败 | `openExtensionChannel` 在 `await transport.ready` 抛 `connect-failed` → 通道**不入表** → 无控制器 | `ipc.ts:184`（【43前】） |
| 断因是 `err === null` / `protocol-error` | 走 §4.4 第 9 步：删表 + 广播 close +（带过绑定的）`dispose()` 收尾 | R4 |
| `retries: 0` | 等价关闭（声明层不写回 `autoReconnect`） | R2 |
| 对端一直发非法帧 | 不重连（§6.2） | S2/V16 |
| 重连成功后立刻又断 | **会**再开一个新的重连周期（每个周期独立计数 `attempts`）；本期不做熔断 | N4（写进 §13 风险） |

### 6.4 重连期间 `not-connected` 的判定（与 K3 的字面一致）

| 观察点 | 窗口期（`state === 'reconnecting'`） | 放弃后（表项已删） |
| --- | --- | --- |
| `api.ipc.channels()` | **含**该通道名 | **不含** |
| `api.ipc.request/notify` | `[not-connected] 通道 X 正在重连（请求不排队，请在 onReconnect 后重发）` | `[not-connected] 通道不存在或未连接: X`（既有文案） |
| 依据 | K3（`channels()` 仍在＝正在重连；不含＝已放弃）、R6/R9 | `requireClientTransport` 的既有分支（【43前】`ipc.ts:76-82`） |
| 测试 | V4（假时钟断言 0 次 sleep）、V7（放弃后 `channels()` 不含 + `request` 报 `not-connected`） | 同左 |

### 6.5 `onReconnect` 的事件形状（三层一致）

| 层 | 形状 |
| --- | --- |
| 主进程内部事件 | `{ extId: string; name: string; type: 'reconnect'; attempts: number }`（`IpcEvent` 第 7 种成员） |
| `window.events` | 与上面同一对象（`MainEvents['ipc:event']`，`src/shared/types.ts:518-519`，签名不变） |
| 扩展回调 | `api.ipc.onReconnect(name, cb: (info: { attempts: number }) => void)`；`attempts` = 本次重连**共尝试次数（含成功那次）** → 首次即成功 = `1`（V1） |

**为什么是对象而不是位置参数**（S3，写进 doc 注释）：`IpcEvent` 是内部事件（F13），扩展只看回调参数；对象参数将来加字段（如 `nextDelayMs`、`lastError`）不破坏签名。

### 6.6 "旧连接 ID 永久退役"在服务端侧的表现（与 #43 对齐）

| 场景 | 服务端（#43 的 server 一侧）看到什么 | 依据 |
| --- | --- | --- |
| 本 issue 的客户端通道重连 | **与 ID 无关**：客户端通道没有 ID；宿主侧不申请、不保留、不复用任何 `connectionId` | R8/R17① |
| 对端（若也是 obox 宿主）跑着 #43 的 server | 旧连接按 #43 §4.5 收尾（`onDisconnect` 一次、旧 ID 永久退役）；重连是**一次全新连入**、拿**新** ID（严格更大，永不复用） | #43 R7/R18 |
| 扩展能否假设"重连前后是同一条连接"？ | **不能**：协议层状态全丢（R8），对端侧 ID 也变了；需要状态的扩展必须用 `onReconnect` 重新握手 | R7/R8 |

---

## 7. R18 专章：清单来源声明的白名单归一化（**必做项**）

### 7.1 问题链（为什么"不报错也不生效"不能靠巧合）

| 步 | 事实 | 证据 |
| --- | --- | --- |
| 1 | `autoReconnect` 必须被**运行时**校验（R1/R2）→ 它成为校验器**已知键** | §3.4 |
| 2 | 清单里的通道对象是**原样**送进主进程校验器的：`manifest.ts:49` 的 `checkIpcChannelList` 结果被丢弃，`host.ts:1214` 传的是原始 JSON 对象 | `manifest.ts:46-56`、`host.ts:1210-1222` |
| 3 | 主进程的校验入口（`ipc.ts:152`）在 #44 后是 `validateRuntimeIpcDeclaration` → **会**接受并启用 `autoReconnect` | §3.4⑤ |
| 4 | 于是：**若不做额外处理，清单里写的 `autoReconnect` 会真的生效** —— 违反 Q2=A 与 R13 | 本节的动机 |
| 5 | 归一化把第 4 步堵死：清单来源的声明在进入主进程**之前**（`resolveIpcChannelDeclaration`）就已被剥掉该键 | §3.4④ |

### 7.2 三次判定（逐条列出"谁改、谁不改"）

| # | 函数 | 路径 | #44 的动作 | 接受面 |
| --- | --- | --- | --- | --- |
| 1 | `validateIpcDeclaration` | 清单 **与** 运行时（被 #2 复用） | **一字不改**（不加 `autoReconnect` 处理） | 保持"未知键静默忽略"（`ipcDeclaration.ts:54-103` 逐键读取） |
| 2 | `checkIpcDeclaration` / `checkIpcChannelList` | **清单**（`manifest.ts:49`） | **一字不改** | 同上：带 `autoReconnect`（哪怕值非法 `{retries:-1}`）**不报错** |
| 3 | `resolveIpcChannelDeclaration` | 清单 → 运行时 | **改**：返回 `validateIpcDeclaration(found)`（白名单归一化） | 输出**只含** `id/transport/program/args/framing` |
| 4 | `validateRuntimeIpcDeclaration` | **只服务运行时** | **新增**：`validateIpcDeclaration` + `normalizeAutoReconnect` + transport 检查 | 唯一接受 `autoReconnect` 的入口 |
| 5 | `manifest.ts` / `validate-manifest.mjs` / `manifest-reference.md` | 清单校验面 | **都不改** | 保持现状 |

### 7.3 不变量怎么被测试钉死（V10 的"双锁死"）

`test/ipc-declaration.test.ts` 与 `test/manifest.test.ts` 各加用例（**锁 1 = 接受面；锁 2 = 归一化构造**）：

| 锁 | 用例名（含 `-t` 关键字） | 断言（逐条） | 钉住的不变量 |
| --- | --- | --- | --- |
| **锁 1a** | `autoReconnect：清单路径的校验器不校验它（未知键静默忽略）` | ① `validateIpcDeclaration({id:'bus',transport:'pipe',autoReconnect:{retries:-1}})` **不抛错**；② 返回值 deep-equal `{id:'bus',transport:'pipe'}`（**不含** `autoReconnect`）；③ `checkIpcDeclaration(同上).ok === true`；④ `checkIpcChannelList([同上]).ok === true` | `validateIpcDeclaration` / `checkIpcDeclaration` / `checkIpcChannelList` 的**接受面一字不变**（R18 的后半句） |
| **锁 1b** | `autoReconnect：清单项带非法值仍然清单有效（含 {retries:-1}）`（`test/manifest.test.ts`） | `errors({...valid, contributes:{ipcChannels:[{id:'bus',transport:'pipe',autoReconnect:{retries:-1}}]}})` deep-equal `[]` | 清单**不因该键变为无效**（R13"不报错"） |
| **锁 2** | `autoReconnect：resolveIpcChannelDeclaration 归一化后不含该键（不生效）` | `resolveIpcChannelDeclaration([{id:'bus',transport:'pipe',autoReconnect:{retries:5,backoffMs:1}}],'bus')` deep-equal `{id:'bus',transport:'pipe'}`；且 `'autoReconnect' in result === false`；再对**未知键**（`{id:'bus',transport:'pipe',mode:'server'}`）重复一次 | 归一化**由构造保证**（R18 的前半句）；顺带把 #43 R15 的"未知键静默"一并钉住 |
| **锁 3（运行时对照，证明能力本身没坏）** | `autoReconnect：运行时入口校验并归一化（缺省填充 / 非法拒绝 / stdio 拒绝）` | ① `validateRuntimeIpcDeclaration({id:'bus',transport:'pipe',autoReconnect:{}})` → `{id:'bus',transport:'pipe',autoReconnect:{retries:3,backoffMs:250}}`；② `{retries:5}` → `retries:5,backoffMs:250`；③ `{retries:-1}` / `{retries:1.5}` / `{retries:0}`（→ 不写回）/ `{backoffMs:-1}` 各自断言抛/不抛；④ `{transport:'stdio',program:'x.js',autoReconnect:{}}` → 抛 `/只支持 pipe/`；⑤ `MAX_BACKOFF_MS === 30_000`、`DEFAULT_RECONNECT_RETRIES === 3`、`DEFAULT_RECONNECT_BACKOFF_MS === 250` | 运行时能力存在且边界清楚（否则"锁 1/2"可能被"其实没人实现"蒙混过关） |

**CLI 验收**：`npx vitest run test/ipc-declaration.test.ts test/manifest.test.ts test/manifest-script-parity.test.ts`（**期望 0**；差分门禁的 fixture **未改动**，锁定"清单校验面没被改动"）。

---

## 8. 测试缝隙（复用 #43）

| 项 | 结论 |
| --- | --- |
| electron mock | **复用 #43 设计 §7.2 的写法**（`vi.hoisted` + `vi.mock('electron', …)`，自包含、不抽 helper），放在 `test/ipc-reconnect.test.ts` 顶部。V4/V7/V8 需要"壳层"（`requireClientTransport` 的窗口期、`channels()`、`closeExtensionIpc`），只能这样触达 |
| 真实 socket | `test/ipc-transport.test.ts`（**electron-free，保持**）只加 V2：用 `test/helpers/ipcPeers.ts`（#43 新增）起真实对端 + `openPipeClientTransport` + `createReconnectController` 组一个**最小本地壳**（约 20 行），验证"kill 对端 → 重启 → 自动连上"的**机制**；生产壳的链路由 `test/ipc-reconnect.test.ts` 覆盖 |
| 假时钟 | V5/V6/V14 用**注入的假 sleep**（记录等待序列、`vi.getTimerCount()` 只在 `vi.useFakeTimers()` 下有值 → 见 §9 的用例说明） |
| 为什么 V2 不放进 `ipc-reconnect.test.ts` | 该文件带 electron mock，`test/ipc-transport.test.ts` 保持 electron-free（#43 设计 §2.4 A3 的约定）——两处覆盖不同层，互补 |

---

## 9. 测试计划（V1–V17 → 文件 + 用例名 + 真实 socket + 平台）

### 9.1 `test/ipc-reconnect.test.ts`（新增；顶部带 electron mock）

| # | 用例名（含 spec 的 `-t` 关键字） | 断言要点 | 真实 socket？ | 时钟 |
| --- | --- | --- | --- | --- |
| 1 | `重连成功：对端断开后自动连上，onClose 一次 + onReconnect 一次（attempts===1）`（V1） | 用真对端 A（helper）→ 建通道（`autoReconnect:{retries:3,backoffMs:250}`）→ 关 A → 用**同一端点**起 B → 注入假 sleep 立即 resolve → `await` 重连完成：`events` 里 `close` 1 次、`reconnect` 1 次且 `attempts === 1`；随后 `ipc:request` 成功 | 是 | 假 sleep（立即） |
| 2 | `重连窗口：窗口内 request 立即 not-connected（不排队），channels() 仍含该通道`（V4） | 关 A 后**不**让 attempt 成功（`rebuild` 指向一个不存在的端点或让假 sleep 挂起）→ `ipc:request` 立刻 reject（码 `not-connected`，只锁前缀）；`ipc:list` 仍含该名字；断言"假 sleep 被调用 0 次时请求已失败"（立即性） | 是 | 假 sleep（手动 resolve） |
| 3 | `在途请求：断开瞬间挂起请求以 peer-crashed 失败，且重连后对端没有收到重复请求`（V3） | 对端收到 `slow` 后**不回包** → 关 A → `ipc:request` reject 码 `peer-crashed`；起 B（记录它收到的 method 列表）→ 重连成功 → 断言 B 收到的 method 列表**不含** `slow`（计数 0/1，绝无补发） | 是 | 假 sleep |
| 4 | `上限：连续失败 3 次后停止，等待序列为 [250,500,1000]，之后无新调用`（V5） | 注入假 sleep 记录 `ms` 序列 → 断言深等于 `[250,500,1000]`；`onAttempt` 调用 3 次；推进假时钟 10× 无新 sleep 调用（`sleep.mock.calls.length` 不变） | 是（attempt 一直失败） | 假 sleep（记录） |
| 5 | `close 期间：close() 后无任何重连尝试、无 onReconnect、无遗留定时器`（V6） | 窗口期调 `ipc:close` → 推进假时钟 → `onAttempt`/`onReconnect` 均 0 次；`vi.getTimerCount() === 0` | 是 | **`vi.useFakeTimers()`** + 真实 `setTimeout`（这样 `getTimerCount` 才有意义；`defaultSleep` 的 `unref?.()` 在 sinon 假定时器上是 no-op，不影响计数） |
| 6 | `放弃：达到上限后从注册表移除（channels() 不含），再次 request 报 not-connected`（V7） | attempt 一直失败 → 上限后 `ipc:list` 不含该名字；`ipc:request` reject `not-connected`；`getTimerCount() === 0` | 是 | 假 sleep |
| 7 | `closeExtensionIpc：重连窗口内立即停止（无遗留定时器、无 onReconnect、端点被清理）`（V8） | 窗口期调 `closeExtensionIpc(extId)` → `getTimerCount() === 0`、`reconnect` 事件 0 次、`ipc:list` 为空；POSIX 断言 `.sock` 已 unlink | 是 | `vi.useFakeTimers()` |
| 8 | `协议状态：重连后第一条 request 在对端看到 id===1，旧挂起表为空，该通道没有 connectionId`（V15） | 重连后发一条请求 → 对端解析出的 `id === 1`；用**旧通道**的请求 id 造一条迟到回包（对端在重连后回一个 `id` 为旧值的响应）→ 不唤醒任何 promise（无未处理 rejection、无 resolve）；断言该通道的全部事件里**没有** `connectionId` 字段 | 是 | 假 sleep |
| 9 | `非法帧：对端发非法帧 → protocol-error 关闭、无 onReconnect、无遗留定时器、从注册表移除`（V16） | 对端发坏帧 → `close` 事件 `code === 'protocol-error'`；`reconnect` 事件 0 次；`ipc:list` 不含；`getTimerCount() === 0` | 是 | `vi.useFakeTimers()` |
| 10 | `端点被占用：重连尝试连续 connect-failed 至次数用尽后放弃（onClose 一次、从注册表移除、无遗留定时器）`（V17） | 关 A 后**占住端点**（另一个 `net.createServer` 监听同端点，或让端点指向一个只 accept 不回话的 server）→ 3 次 attempt 全 `connect-failed` → 放弃：`ipc:list` 不含；`close` 事件**恰好 1 次**（E1）；`getTimerCount() === 0` | 是 | 假 sleep |
| 11 | `封顶与超时：backoffMs 很大时等待封顶 30000；请求超时仍为 timeout、默认 30s`（V14） | ① `backoffDelayFor({attempt:1..4, backoffMs:20000, maxBackoffMs:30000})` → `[20000,30000,30000,30000]`；② `backoffDelayFor` 与 `MAX_BACKOFF_MS` 的纯函数断言；③ 真连接上 `ipc:request` 传 `timeoutMs:80` 不回的 method → reject 码 `timeout`；④ `DEFAULT_TIMEOUT_MS === 30_000` 与 `DEFAULT_RECONNECT_*` 的常量断言 | 部分是 | 混合 |
| 12 | `禁用：retries:0 等价关闭（断开即移除，无重连尝试）`（R2） | `autoReconnect:{retries:0}` 的通道断开后：表内立即无该名字、`sleep` 0 次 | 是 | 假 sleep |
| 13 | `stdio 拒绝：connect({transport:'stdio',program:…,autoReconnect:{…}}) 抛 invalid-declaration，不产生任何重连尝试`（V13） | 只锁 `/^\[invalid-declaration\]/`；`sleep` 0 次；同时断言 `listen({transport:'pipe',autoReconnect:{…}})` **不报错**且不产生重连（服务端不适用，R3/R17②） | 否 | 假 sleep |
| 14 | `控制器纯逻辑：isReconnectableCloseReason 的封闭清单（peer-crashed=true；null/protocol-error/channel-closed/其它=false）`（R4/S2） | 逐码断言（含 `null`） | 否 | 无 |
| 15 | `attempts 语义：连续失败 2 次后成功 → attempts===3`（R9） | 假 sleep + 前两次 attempt reject、第三次 resolve | 是 | 假 sleep |
| 16 | `cancel 幂等：cancel() 两次不抛错；成功后再 cancel 不影响`（R10/R11） | 纯控制器用例 | 否 | 假 sleep |

### 9.2 `test/ipc-transport.test.ts`（修改：只加一组）

| 用例名（含 `-t "重连"`） | 断言 | 平台 |
| --- | --- | --- |
| `重连：真实管道/UDS 上 kill 对端 → 重启 → 自动连上（无需重新 connect）`（V2） | 起真对端 A（`test/helpers/ipcPeers.ts`）→ `openPipeClientTransport` → `ping` 成功 → 关 A（模拟 kill）→ 用最小本地壳把 `onClose(peer-crashed)` 接到 `createReconnectController`（`attempt` = 重建传输 + 重挂 handler，假 sleep 立即 resolve）→ 起 B → 再 `ping` 成功 | 两平台（POSIX 侧需 `chmod`，helper 内做） |

### 9.3 既有两个测试文件（V10）

| 文件 | 用例 | 见 §7.3 的"锁 1a / 1b / 2 / 3" |
| --- | --- | --- |
| `test/ipc-declaration.test.ts` | 锁 1a + 锁 2 + 锁 3 | §7.3 |
| `test/manifest.test.ts` | 锁 1b | §7.3 |
| `test/manifest-script-parity.test.ts` | **不改**（fixture 与门禁一字不动） | V10 |

### 9.4 V9/V11 的落点

| V | 命令 | 说明 |
| --- | --- | --- |
| V9（既有回归） | `npx vitest run test/ipc-transport.test.ts test/ipc-stream.test.ts test/ipc-core.test.ts` | **期望 0**；断言口径："不传 `autoReconnect` → `onClose` 一次、`channels()` 立即不含、请求报 `peer-crashed`"（与今天一致；既有用例本身不新增断言，#44 只加 V2 的那一组） |
| V11（门禁） | `npm run typecheck` && `npm run lint` && `npm test` | 三条全绿 |

### 9.5 Windows / POSIX 说明

| 类别 | 说明 |
| --- | --- |
| 需要真实 socket | §9.1 的 #1–#10、#15；§9.2 的 V2 |
| Windows 上可跑 | 全部（命名管道） |
| POSIX 专属断言 | §9.1 #7 的 `.sock` unlink、#6/#10 的端点占用细节 → 写成**条件断言**（`if (process.platform === 'win32') { 断言 win 分支 } else { 断言 posix 分支 }`），**不用 `it.skip`**（避免 `-t` 在 Windows CI 上匹配不到用例） |
| CI 覆盖缺口 | CI 只跑 windows-latest（`.github/workflows/pr-check.yml:20`）→ POSIX 真机分支由开发者在 macOS/Linux 本地跑并在 PR 描述贴结果；`.sock` 的 `0600` 与 `<userData>/ipc` 路径在两平台都由条件断言覆盖各自的真机分支 |

---

## 10. 文件与所有权（含与 #43 的依赖）

### 10.1 逐文件改动点

| 文件 | 动作 | 改动点（【43前】行号 → 内容） |
| --- | --- | --- |
| `src/main/ipcReconnect.ts` | **新增** | `isReconnectableCloseReason`、`backoffDelayFor`、`createReconnectController`、`defaultSleep`（`unref`）、`ReconnectControllerOptions/Controller`；从 `../shared/ipcDeclaration` 导入 `MAX_BACKOFF_MS` |
| `src/main/ipc.ts` | 修改 | `:37-39` 的 client 分支加 `state`/`reconnect`（形状 §4.1）；`:126-145` `registerChannel` → 拆出 `attachClientChannel`（可重复调用，重连成功后再走一次）；关闭处理器加"分类 + 窗口态 + 控制器启动"（§4.4 第 2/9 步）；`:152` 的校验改为 `validateRuntimeIpcDeclaration`（**唯一一行**）；`:76-82` 的 `requireClientTransport` 加窗口期 `not-connected`；`:217-224` `closeExtensionChannel` 加 `cancel()`（在 `dispose()` 之前）；`:227-232` `closeExtensionIpc` 同法；新增 `pendingForwardCount` 等 #43 已有物不改 |
| `src/shared/ipcDeclaration.ts` | 修改 | `:17-28` 加 `autoReconnect?`；新增 `IpcAutoReconnect`/`ResolvedAutoReconnect`/三个常量/`normalizeAutoReconnect`/`validateRuntimeIpcDeclaration`（插在 `checkIpcDeclaration`（`:106-114`）与 `checkIpcChannelList`（`:120-137`）之间）；`:144-151` `resolveIpcChannelDeclaration` 改为返回归一化结果 |
| `src/shared/types.ts` | 修改 | `:454-462` 声明加 `autoReconnect?`；`:471-483` `IpcEvent` 追加第 7 种成员 `reconnect` |
| `src/api/shared.ts` | 修改（**spec §4 未列，本文档补**） | `:45-55` 加 `IpcAutoReconnect` 接口 + `autoReconnect?` 字段；核对 `src/api/index.ts` 的导出面 |
| `src/api/types.ts` | 修改 | `ipc` 增 `onReconnect`（§3.1）；`connect` 的 doc 注释补三条语义（在途不重放 / 窗口期 `not-connected` / 只在运行时声明里写） |
| `src/renderer/src/core/host.ts` | 修改 | `ChannelListeners` 加 `reconnects`（#43 后为 8 个集合）；`ipc:event` 加 `reconnect` 分支；新增 `onReconnect`；`close()` 不变（已 `listeners.delete`） |
| `src/preload/index.ts` | **不改** | R14（无新方法） |
| `src/main/ipcTransport.ts` | **不改** | §3.5（C5 收敛） |
| `src/main/ipcCore.ts` | **不改** | S4（错误码闭集不变；`RPC_INVALID_REQUEST` 仍不使用） |
| `src/renderer/src/core/manifest.ts`、`scripts/validate-manifest.mjs`、`manifest-reference.md`、`test/manifest-script-parity.test.ts` | **不改** | R13/Q2=A |
| `test/ipc-reconnect.test.ts` | **新增** | §9.1 |
| `test/ipc-transport.test.ts` | 修改（**只加** V2 一组） | §9.2 |
| `test/ipc-declaration.test.ts` | 修改（**只加**） | §7.3 锁 1a/2/3 |
| `test/manifest.test.ts` | 修改（**只加**） | §7.3 锁 1b |
| `skills/obox-ext-dev/references/api-reference.md` | 修改 | §11.1 |
| `skills/obox-ext-dev/references/troubleshooting.md` | 修改 | §11.2（含 `:281` 改写） |
| `docs/adr/0016-ipc-transport-and-protocol.md` | 修改 | §12 |
| `README.md` | 修改 | `src/main/` 目录树补一行 `ipcReconnect.ts`（放在 `ipcTransport.ts` 行之后） |

### 10.2 #44 对 #43 的依赖（逐条）

| #44 需求 | 建立在 #43 的 | 说明 |
| --- | --- | --- |
| R8（客户端无连接 ID） | #43 R7 | 无 #43 的"ID 属于服务端连接"就没有这个否定式结论 |
| R10（统一 `close(name)`） | #43 R3 | 在 #43 的统一实现上加 `cancel()` |
| R9/R17④（`channels()` 含 server 名） | #43 R19 | 记账口径 |
| R6（窗口期 `not-connected`） | #43 R6 | 复用 #43 拆出的 `requireClientTransport` 分流 |
| R5（不重放） | #43 R18 | 服务端侧的失败传播顺序即此处的同源规则 |
| R14（`reconnect` 事件） | #43 R14 | 在已有 6 种成员的联合上追加第 7 种 |
| R18（归一化） | #43 R15 + #43 R1 | ①#43 未动清单面；②#43 把 `ipc.ts` 的运行时校验保持在单独一行；③#43 落地前 F12 的缺陷仍在（#44 才修） |
| R2/R12/R3（校验与 stdio 拒绝） | #43 R1/R2 | 与 `listen` 的"先判 transport"同风格、同一层 |
| 测试基建 | #43 的新增物 | `test/helpers/ipcPeers.ts` + electron mock 写法 + V15 的"未知键锁死"先例 |

**若用户坚持并行**（spec §7 允许但需冻结接口）：`ipcReconnect.ts`（本 issue）与 `ipcServer.ts`（#43）互不重叠，可并行；`ipc.ts` **必须串行**（#43 先改）。冻结物清单：① `OpenChannel` 的 client 分支形状（§4.1）；② `resolveTarget`/`requireClientTransport` 的签名（#43 设计 §3.4）；③ `ipc.ts:152` 的校验行位置。

---

## 11. skill 文档同步要点（逐条）

### 11.1 `skills/obox-ext-dev/references/api-reference.md`

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `:597-642` 的 `api.ipc` 代码块 | 加一段 pipe 重连示例：`await api.ipc.connect({id:'svc',transport:'pipe',autoReconnect:{retries:5,backoffMs:250}})` → `api.ipc.onReconnect('svc', ({attempts}) => await handshake())` → `api.ipc.onClose('svc', e => …)` |
| 2 | 新小节 `### api.ipc 自动重连（issue #44）` | **三条语义表**（在途请求立即 `peer-crashed` 失败 + **不重放**；重连期新请求立即 `not-connected` 不排队；协议层状态全部丢弃、请求 id 从 1、必须用 `onReconnect` 重新握手）；退避与默认值（`retries=3`、`backoffMs=250`、×2、单次封顶 30000、`retries:0` = 关闭）；**只对 pipe**（stdio 自行 `onClose` 退避 + `connect()`，宿不支持）；**只写在运行时声明对象里**（清单里写不报错也不生效）；"两种不见了"的区别（`channels()` 仍含＝正在重连；不含＝已放弃） |
| 3 | 错误码行（`:654`） | **不变**（不新增码，S4）；补一句"窗口期复用 `not-connected`，放弃后复用 `peer-crashed`/`not-connected`" |
| 4 | 服务端小节（#43 新增的那一节） | 补一句：**服务端连接不自动重连**；`autoReconnect` 只作用于 client 通道（R17②） |

### 11.2 `skills/obox-ext-dev/references/troubleshooting.md`

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `:281`（`peer-crashed` 行，**改写**） | 原文"（宿主不自动重连，需扩展自行 `connect()` 重建）"→ "（**默认不自动重连**：pipe 通道可声明 `autoReconnect` 让宿主自动重建；stdio 场景仍需扩展自行 `connect()`）" |
| 2 | `:268-292` 一节末尾 | 新增"**如何调试重连**"条目：看 `api.ipc.onReconnect`（成功次数与 `attempts`）；用 `await api.ipc.channels()` 判断状态——**仍含该通道名＝正在重连，不含＝已放弃**；窗口期请求报 `not-connected` 属**预期**（不是通道丢了） |
| 3 | 同上 | 新增"**重连一直失败先查端点占用**"：每次重连都是 `connect-failed` 时，先确认对端是否真的在监听、POSIX 是否有陈旧 `.sock`（服务端要在 listen 前清理，见 #43 条目）、Windows 是否旧实例残留（K6/V17） |
| 4 | 同上 | 新增"**`autoReconnect` 不生效**"：先确认它写在 `connect({...})` 的**运行时对象**里而不是 manifest 的 `contributes.ipcChannels`（清单里写**不报错也不生效**）；再确认 `transport` 是 `pipe`（stdio 会直接 `invalid-declaration`） |

**`manifest-reference.md` 与 `scripts/validate-manifest.mjs` 一行都不改**（Q2=A；`:253-279` 保持原样）。

---

## 12. ADR 修订计划（`docs/adr/0016-ipc-transport-and-protocol.md`，**修订不新开**；#43 已先改过一轮）

| # | 位置 | 动作 | 要点 |
| --- | --- | --- | --- |
| B1 | 「本期明确不做」（#43 已删掉"pipe 服务端"一条） | **删除**剩下的"**自动重连**"条（原文在【43前】`:23`） | 保留该列表其余条目（manifest 声明通道 / 沙箱化） |
| B2 | 决策区（#43 已加"决策 9 pipe 服务端"） | **新增决策 10「客户端通道的断线自动重连」** | ① 逐通道可选的 `autoReconnect`（**只在运行时声明**）；② 触发＝首连成功后的 `peer-crashed`；③ 退避 `250/500/1000…` 封顶 30000，默认 `retries=3`；④ **在途请求不重放**；⑤ 重连期新请求 `not-connected`；⑥ 协议层状态不保留（新 `JsonRpcChannel`，id 从 1）；⑦ 用 `onReconnect` 重新握手；⑧ 只覆盖 pipe，stdio 由扩展自理；⑨ **服务端连接不重连**（与决策 9 的边界） |
| B3 | 决策 9（#43 加的） | 增补一句 | 重连控制器只作用于 client 通道：服务端连接断开只通知（`onDisconnect`），对端回来是新连接、新 ID |
| B4 | 后果·不变量 | 增补 | 补两条不变量：① 重连**不重放**任何请求（"在途请求立即失败"是 at-most-once 的全部含义）；② `channels()` 的包含关系是"正在重连 / 已放弃"的唯一判据 |
| B5 | 新小节「自动重连的三条语义」（建议放在 #43 新增的"服务端连接的生命周期"之后） | **新增** | 逐条表：在途请求（立即 `peer-crashed`，绝不重放，也不做幂等方法白名单）/ 重连期新请求（立即 `not-connected`，不排队）/ 状态保留（通道名、声明、framing、策略保留；协议层状态丢弃）＋**理由**："重放会破坏 at-most-once 心智；正确做法是让扩展在 `onReconnect` 里重新握手" |
| B6 | `Status: accepted` | 保留 | 修订不新开、不改编号 |

---

## 13. 风险与回退

| # | 风险 | 影响 | 处置（本次） | 回退方式（能否独立回滚） |
| --- | --- | --- | --- | --- |
| R-1 | **新扩展 + 旧宿主**：旧宿主不认识 `autoReconnect`（它走 `validateIpcDeclaration`，未知键静默忽略）→ 通道**照常打开**，只是**不重连**（静默降级）；`api.ipc.onReconnect` 也会 `TypeError` | 静默降级 + 一处响亮 `TypeError` | api-reference 明写"需要宿主版本支持；用 `typeof api.ipc.onReconnect === 'function'` 特性检测"；不在清单里加键（Q2=A 的代价，spec K1） | 独立回滚：是（纯文档） |
| R-2 | **旧扩展 + 新宿主**：不传 `autoReconnect` → 期望"逐字节一致"（R16） | 若在断连路径上多调一次 `transport.dispose()`，就**不再**逐字节一致 | **E5**：只在"该通道曾带 `reconnect` 绑定"时才 `dispose()`；不传该键的通道走既有分支（代码路径与今天完全一致） | 独立回滚：是（一行 `if`） |
| R-3 | **重连风暴**：无 jitter、无熔断（N4）；对端反复起停时扩展会一直重连（每周期 `retries` 次）；多个扩展同时重连会同步打端点 | 端点忙、日志噪声 | 本期接受（N4 明写不做）；troubleshooting 加"重连一直失败先查端点占用"；退避从 250ms 起、封顶 30s，不会形成忙循环 | 独立回滚：是（改常量/加 jitter 属新需求，须回 spec） |
| R-4 | **协议状态静默丢失**（K5）：扩展若依赖"请求 id 连续"或"对端会话"，重连后行为会变 | 静默错误 | api-reference 明写"必须用 `onReconnect` 重新握手"；V15 锁死"首条请求 `id === 1`"；**不做**兼容垫片（N3） | 独立回滚：是（文档） |
| R-5 | **窗口期 `not-connected` 被误读为"通道没了"**（K3） | 扩展写错恢复逻辑（例如错误地重新 `connect()` → 撞 `通道 X 已打开`） | 文档写清两种"不见了"的区别（troubleshooting 第 2 条）；V4/V7 双向锁死 | 独立回滚：是 |
| R-6 | **放弃后扩展拿不到直接信号**（E1 选择"不二次 `onClose`"） | 扩展只能靠轮询 `channels()` 判断"已放弃" | K3 已把 `channels()` 定为判据；文档明写；若将来要直接信号，须回 spec 新增事件（不在本期） | 独立回滚：是（若改判为二次 `onClose`，则要同时改 V17 的断言口径 → 需用户确认） |
| R-7 | **定时器泄漏**（K4）：`sleep` 忘记 `unref()` 或 `cancel()` 未清定时器 | `vitest` 挂住 / 进程退不出 | `defaultSleep` 抄 `ipcCore.ts:347` 的 `unref?.()`；V6/V8/V16/V17 都断言 `vi.getTimerCount() === 0` | 独立回滚：是 |
| R-8 | **声明面被无意扩大**：有人把 `autoReconnect` 校验写进 `checkIpcDeclaration`，导致清单里写非法值就变无效 | 违反 Q2=A/R13 | §7 的"锁 1a/1b/2/3"四条用例；`manifest-script-parity` fixture 不动（等价于） | 独立回滚：是（用例会先红） |
| R-9 | **归一化破坏既有清单用法**：`resolveIpcChannelDeclaration` 现在会**重建**对象（不再是原对象引用） | 调用方若依赖"返回同一引用"会受影响 | 已核对唯一调用点 `host.ts:1214` 只把返回值当数据传给 `ipcConnect`（不比较引用）；`test/ipc-declaration.test.ts:161-164` 的既有断言用 `toEqual`（深比较）→ **不会**因为换引用而红 | 独立回滚：是 |
| R-10 | **不可重连断因分支的收尾**：`protocol-error` 后套接字可能半死（`ipcCore` 的 `close` 不销毁套接字） | 资源残留到进程退出 | 带过 `reconnect` 绑定的通道在此分支 `transport.dispose()`（销毁套接字）；不带绑定的通道保持今日行为（R16 优先） | 独立回滚：是 |
| R-11 | **测试缝隙**：`ipc-reconnect.test.ts` 依赖 #43 的 electron mock（#43 设计 §7.4） | 若 #43 改用方案 B（提取 `ipcRegistry.ts`），本文件的 import 需跟着改 | 本文件的壳层 import 集中在头部 3 行；改道成本 ≈ 3 行 | 独立回滚：是 |

---

## 14. 真机验证步骤（V12 必须项）

| 步 | 命令 / 操作 | 可观察现象 |
| --- | --- | --- |
| 1 | 准备一个 pipe 对端脚本（把 `test/helpers/ipcPeers.ts` 的 `createServer` 抄进 `.cjs`），端点为宿主推导的 `\\.\pipe\obox-<扩展id>-svc`（Windows）/ `<userData>/ipc/obox-<扩展id>-svc.sock`（POSIX）；收到 `ping` 回 `pong`，收到 `handshake` 记录一次 | 脚本打印 listening |
| 2 | 造一个最小调试扩展（`--debug-extension <id>@<dir>`），入口里：`await api.ipc.connect({id:'svc',transport:'pipe',autoReconnect:{retries:5,backoffMs:250}})`；`api.ipc.onClose('svc', e => console.log('[onClose]', e.code))`；`api.ipc.onReconnect('svc', ({attempts}) => console.log('[onReconnect]', attempts))`；`api.ipc.onReconnect('svc', () => api.ipc.request('svc','handshake'))`；每隔 2s 发一次 `api.ipc.request('svc','ping')` 并打印结果 | `npm run dev` 后：`ping` 每 2s 成功；`onClose`/`onReconnect` 均未触发 |
| 3 | **kill 对端进程**（`taskkill /F /PID` / `kill -9`） | 输出面板：`[onClose] peer-crashed` **一次**；随后 2s 内的 `ping` 打印 `[not-connected] …正在重连…`（**预期**，不是错误） |
| 4 | **重启对端脚本**（同一端点，**不**触碰扩展、**不**调 `connect()`） | 输出面板：`（§2 的退避等待后）[onReconnect] 1` 一次；下一条 `ping` 成功；对端日志里 `handshake` **恰好**出现一次（证明扩展侧的握手逻辑生效） |
| 5 | 保持对端**不启动**，重启宿主扩展（或首次连不上） | `connect()` 直接抛 `connect-failed`（**不**进重连窗口，R4）；对端起来后再手动 `connect()` 才成功 |
| 6 | 对端一直不启动，让重连跑满 | 依次出现 `[onClose] peer-crashed` 一次；**没有** `[onReconnect]`；随后 `await api.ipc.channels()` **不含** `svc`；`ping` 报 `not-connected`（无"正在重连"字样）→ 与"正在重连"可区分（K3） |
| 7 | 对端发出一个**非法帧**（例如 `Content-Length` 与实际不符、或非 JSON） | `[onClose] protocol-error` 一次；**没有** `[onReconnect]`；`channels()` 不含 `svc`（不重试，R4/S2） |
| 8 | 判据（`workflow.md:78`） | 以上现象全部观察到才算通过；**未做**则结论必须标注「未验证」 |

---

## 15. 实施顺序（每步一个可提交状态）

| 步 | 内容 | 验收命令 | 为什么这个顺序 |
| --- | --- | --- | --- |
| 0 | **确认 #43 已合并**；确认 `ipc.ts:152` 是单独一行的校验调用、`OpenChannel` 已是判别联合 | `git log --oneline -5`、读码 | 三个"冻结接口"（§10.2）就位才开工 |
| 1 | `src/shared/ipcDeclaration.ts`：常量 + `IpcAutoReconnect` + `normalizeAutoReconnect` + `validateRuntimeIpcDeclaration` + `resolveIpcChannelDeclaration` 归一化（**不碰 `validateIpcDeclaration`**） | `npx vitest run test/ipc-declaration.test.ts test/manifest.test.ts -t "autoReconnect\|未知键\|mode"`（先写用例再实现） | R18 是最高风险的必做项，先做、先锁 |
| 2 | `src/main/ipcReconnect.ts`（纯逻辑） | `npx vitest run test/ipc-reconnect.test.ts -t "控制器\|上限\|封顶\|close 期间"` | 无 electron、无 socket，最快拿到确定性证据 |
| 3 | 三份声明副本同步（`api/shared.ts`、`shared/types.ts`、`shared/ipcDeclaration.ts`）+ `api/types.ts` 的 `onReconnect` + `shared/types.ts` 的 `IpcEvent` 第 7 种成员 + `host.ts` 分发 | `npm run typecheck` | 三端面向一次改齐 |
| 4 | `src/main/ipc.ts` 接线：`OpenChannel` 扩字段、`attachClientChannel`、关闭分类、窗口期 `not-connected`、`cancel()` 两处 | `npx vitest run test/ipc-reconnect.test.ts -t "重连成功\|重连窗口\|放弃\|closeExtensionIpc"` | 主路径 + V4/V7/V8 |
| 5 | 真实 socket 组（V1/V2/V3/V15/V16/V17）+ `test/ipc-transport.test.ts` 的 V2 一组 | `npx vitest run test/ipc-reconnect.test.ts test/ipc-transport.test.ts -t "重连\|在途请求\|协议状态\|非法帧\|端点被占用"` | 端到端与封闭清单 |
| 6 | 既有回归（V9） | `npx vitest run test/ipc-transport.test.ts test/ipc-stream.test.ts test/ipc-core.test.ts test/ipc-server.test.ts` | R16 的"逐字节一致"靠这里守 |
| 7 | 文档：api-reference / troubleshooting（含 `:281` 改写）/ ADR-0016 / README | 人工核对（`workflow.md` 的 R15 清单） | V12/R15 |
| 8 | 三道门禁 + 真机 V12 | `npm run typecheck` && `npm run lint` && `npm test`；§14 | V11 + 真机 |
| 9 | PR + 独立子代理审视（`workflow.md:82`）+ ADR 归档 + 清空 `tmp/` | CI `check` | 收尾 |

---

## 16. 待定项汇总（本文档标注的 5 处 `【设计待定：需在实现前确认】`）

| # | 待定项 | 推荐值 | 一句话理由 |
| --- | --- | --- | --- |
| E1 | 达到重试上限"放弃"时是否**再**触发一次 `onClose`（R9 的措辞 vs R7"恰好一次"、V17"`onClose` 一次"） | **不再触发**（一个断连周期只有一次 `onClose`；"已放弃"由 `channels()` 不含该名字表达） | 验收 V17 明确写"`onClose` 一次"，且 K3 已把 `channels()` 定为"正在重连 / 已放弃"的判据 → 以验收为准；若用户要求直接信号，须回 spec 新增事件（不在本期） |
| E2 | `retries` 是否需要上限封顶（如禁止 `retries: 100000`） | **不额外封顶**，只校验"非负整数"（`retries` 越大＝重连越久，由扩展自己负责）；只有 `backoffMs` 按 S1 封顶单次等待 | spec 只对"单次等待"给了封顶（S1）；给 `retries` 加隐式上限会与"`retries` 是扩展声明的意图"冲突，且无 DoS 面（扩展是受信代码，ADR-0015） |
| E3 | `autoReconnect` 对象里的**未知键** | **静默忽略**（逐键白名单读取，与 `validateIpcDeclaration` 顶层同风格，`ipcDeclaration.ts:54-103`） | spec R2 的"未知字段类型错"指的应是**已知键的值类型**错（`retries:'3'`），不是"出现了未知键"；与 Q2=A 的"未知键静默"保持同一套风格 |
| E4 | `backoffMs: 0` 是否合法（立即重试） | **合法**（= 不等待，仍异步 `setTimeout(0)`）；负数/`Infinity`/非数字 → `invalid-declaration` | R2 只把"负数 / 非整数"判为非法；`0` 语义清晰（"尽快"），且与 `retries: 0`（关闭）不同键、不冲突 |
| E5 | 未启用 `autoReconnect` 的通道在**意外断连**后是否也 `transport.dispose()` 收尾 | **不**（只在曾带 `reconnect` 绑定的通道上收尾）；未启用的通道代码路径与今天**完全一致** | R16 要求"不传 `autoReconnect` 的扩展在断线时行为与今天完全一致"；多一次 `dispose()` 虽几乎不可观测，但会让 R16 从"逐字节一致"降级为"看起来一致" |
