# 扩展宿主进程迁移计划（Extension Host Process Migration）

> 决策见 [ADR-0026](adr/0026-extension-host-process.md)。本文只写**怎么做**：阶段、任务卡、文件所有权、并行组、验收与回退。

## 目标 / 非目标

**目标**：用户扩展（`.oix`）的入口与后台任务全部在 Extension Host Process（`utilityProcess`）中执行；渲染进程只留 UI 与内置扩展；扩展在宿主里拥有完整 Node；引入 4 类激活事件；`apiVersion` 升 3；一次性交付 obox 2.0.0。

**非目标**：不改内置扩展的构建方式（仍 Vite `import.meta.glob`）；不改窗口形态（透明/置顶/拖动/位置持久化）；不改 `app://` 协议与 iframe 页面的加载方式；不把状态栏/图标改成结构化数据；不按扩展拆多个宿主进程。

## 影响面

| 类别 | 内容 |
| --- | --- |
| **新增** | `src/main/extensionHostStarter.ts`（fork/崩溃计数/重启/MessagePort 中转）、`src/shared/extensionHostProtocol.ts`（帧与消息类型）、`src/extension-host/**`（宿主入口、RPC、API 工厂、清单加载、激活事件）、`src/renderer/src/core/extensionHostBridge.ts`（渲染侧客户端） |
| **大改** | `src/renderer/src/core/host.ts`（拆成"渲染侧注册表"+"宿主侧运行时"，用户扩展的激活逻辑移出）、`core/loader.ts`（只收集内置扩展 + 把用户扩展清单转给宿主）、`core/manifest.ts`（`activationEvents` 校验 + apiVersion 3）、`src/preload/index.ts`（能力面收缩到"UI 需要的那部分"）、`docs/extension-api/**`（全量重写）、`README.md`（架构段）、5 个用户扩展 |
| **不动** | `src/main/appWindow.ts`（窗口/overlay）、`protocol.ts`、`tray.ts`、`updater.ts`、`net.ts`（保留给渲染侧内置扩展与宿主代理桥）、内置扩展 `src/renderer/src/extensions/**` |

## 阶段与任务卡

### 阶段 A · 骨架与通道（可独立验证，不改变现有行为）

| 卡 | 内容 | 文件所有权 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| **EH-A1** | 协议与类型：帧格式（JSON + 二进制旁路）、消息类型（ready/init/activate/rpc-request/rpc-response/cancel/terminate/log）、错误码表、channel 命名 | `src/shared/extensionHostProtocol.ts`、`test/extension-host-protocol.test.ts` | 帧编解码往返、超长/畸形帧拒绝、错误码穷举、`test` 绿 | — |
| **EH-A2** | 启动器：`utilityProcess.fork` + `windowLifecycleBound`、握手（ready/init/initialized/terminate）、崩溃计数（5 分钟 3 次）、重启与弹窗、3 秒 ack 判活（只观测） | `src/main/extensionHostStarter.ts`、`src/main/index.ts`（仅注册）、`test/extension-host-starter.test.ts` | 启动/退出/崩溃计数/达阈值不重启/日志可见；`npm test` 绿 | A1 |
| **EH-A3** | 宿主侧运行时（最小）：读清单 → 4 类激活事件 → `plugin(api)`；RPC 服务端与客户端骨架；`fs`/`timer` 两个能力先落地 | `src/extension-host/**` | 能在宿主里加载一个测试扩展并完成一次 `fs.readFile` 往返 | A2 |
| **EH-A4** | 渲染侧桥：`extensionHostBridge` + `core/host.ts` 拆分（注册表留渲染、激活移宿主）+ `core/loader.ts` 只收集内置 | `src/renderer/src/core/{host,loader,extensionHostBridge}.ts` | 老扩展在新宿主里跑通 pet 的 smoke 用例 | A3 |

### 阶段 B · 能力迁移（按能力线并行，每条独立可验）

| 卡 | 能力线 | 落点 | 回 main 的部分 |
| --- | --- | --- | --- |
| **EH-B1** | `fs` / `net` / `env` / `clipboard` | 宿主内直接实现（Node `fs`、`net.fetch` 保留 main 代理由宿主调用） | 代理配置读取 |
| **EH-B2** | `child_process` 族：`api.ipc` sidecar、Python 运行时 | 宿主内 spawn + 流所有权 + 崩溃清理 | 无 |
| **EH-B3** | `node:sqlite` | 宿主内打开（目录沿用 userData），与 main 的 DB 不共享句柄 | 无 |
| **EH-B4** | `secrets`（safeStorage）/ `dialog` / `notification` | 宿主经 RPC 回 main | 全部 |
| **EH-B5** | `overlay` / `window` / `app.register` / `statusBar` / `commands` / `views` / `settings` / `i18n` / `theme` / `update` | 宿主内生成数据，经桥到渲染侧/主进程 | overlay/window/update 的窗口操作 |

### 阶段 C · 清单与激活

| 卡 | 内容 | 所有权 | 验收 |
| --- | --- | --- | --- |
| **EH-C1** | `activationEvents` 校验（4 类 + 缺省 `*`）、apiVersion 3 门槛、`validate-manifest.mjs` 同步 + parity 测试 | `core/manifest.ts`、`scripts/validate-manifest.mjs`、`test/manifest-*.test.ts`、根 `package.json`（apiVersion 3） | 4 类事件合法、未知事件拒绝、缺省 = `*`、脚本与代码同规则 |
| **EH-C2** | 内置扩展不参与懒激活；用户扩展按事件激活；激活失败的错误归因与展示 | `core/host.ts`、`ext-manager` 视图（错误文案） | 内置仍首屏就位、用户扩展按事件延迟加载 |

### 阶段 D · 文档、扩展改造、验证与发版

| 卡 | 内容 |
| --- | --- |
| **EH-D1** | `docs/extension-api/**` 全量重写（api-reference / manifest-reference / themes-settings / troubleshooting / guides×2）+ `skills/obox-ext-*` 同步 |
| **EH-D2** | README 架构段（三进程 + 能力归属表）、`CONTEXT.md`（已完成核心词条） |
| **EH-D3…D7** | 5 个扩展逐个改造：obox-updater / rdp / todo / webapp / pet（各自仓库、各自 `apiVersion: 3`、各自发版） |
| **EH-D8** | 实机验证：启动时序、激活事件、崩溃重启（含达阈值弹窗）、热装卸、`--inspect` 调试、overlay 与卡片正常 |
| **EH-D9** | 发版 obox 2.0.0（版本号 + 发行记录 + tag + release 工作流回读） |

## 并行组

| 组 | 卡 | 理由 |
| --- | --- | --- |
| G1 | A1 | 协议是一切的前提 |
| G2 | A2、A3 | A2 只动 main、A3 只动 extension-host，文件不相交 |
| G3 | A4、C1 | A4 动 renderer/core，C1 动 manifest/脚本，不相交 |
| G4 | B1–B5 | 五条能力线文件不相交（各自落在 `extension-host/capabilities/*`），可并行 |
| G5 | C2、D1 | C2 动 host/ext-manager，D1 只动 docs |
| G6 | D3–D7 | 5 个扩展各自独立仓库，完全并行 |
| G7 | D8、D9 | 验证后才能发版 |

## 风险与回退

- **回退开关**：保留 `utilityProcess` 启动开关（env 或设置项），可一键退回"渲染进程执行扩展"，直到 2.0 稳定后再删。
- **序列化风险**：所有跨进程参数必须过 `plainProxyConfig` 之类的纯对象归一；测试要覆盖 reactive Proxy、类实例、循环引用三类输入被拒/降级的明确行为。
- **热装卸风险**：`pendingInstall` 的补跑时机从"渲染进程启动"改为"宿主 ready"，需要一条专门的时序测试。
- **调试风险**：宿主进程用 `--inspect` + 端口转发；文档要写清如何在 VS Code 里 attach。
