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

## 进度（随阶段推进更新）

| 阶段 | 卡 | 状态 | 对照表（已实现 / 桩） |
| --- | --- | --- | --- |
| A | A1 协议 / A2 启动器与通道 / A3 宿主运行时 / A4 渲染侧桥 + 回退开关 | ✅ 已合并 | 17 / 82 |
| B | B1 IO 族（fs.watch、net.fetch、env、clipboard） | ✅ 已合并 | 22 / 77 |
| B | B2 进程与存储族（ipc、python、sqlite） | ✅ 已合并 | 38 / 61 |
| B | B3a 主进程类（window/overlay/dialog/shell/notification/secrets/update/proxy） | ✅ 已合并 | 61 / 38 |
| B | B3b-1 注册面数据面（statusBar/commands/views/settings/theme/i18n/app/memento/on·emit）+ **修端口接缝缺陷** | ✅ 已合并 | 89 / 10 |
| B | B3b-2 状态与 UI 面（`ui`×5、`output`、`update` 门控×4）+ **修桥接缝缺陷** + R69 env 注入 + R70 update 主进程注册 | ✅ 已合并 | **99 / 0** |
| C | C1 清单：`activationEvents`（4 类 + 缺省 `*`，宿主与 `validate-manifest.mjs` 同规则 + parity 差分）+ **`apiVersion` 2→3** | ✅ 已合并 | — |
| C | C2 激活触发接线：启动（`*` → `onStartupFinished` 顺序各一次）、`onCommand:<id>`（执行前先激活并重查 handler）、`onView:<id>`（`nav:open` 与导航栏点击各接一路）+ 并发合并与 10s 超时 | ✅ 已合并 | — |
| D | D1 文档全量重写 / D2 README / D3–D7 五个扩展 / D8 实机验证 / D9 obox 2.0.0 | ⏳ 待做 | — |

> **阶段 A + B 已全部完成：`api` 的 99 项能力全部在宿主进程落地（0 桩）。**
> **D2a 起用户扩展默认就在宿主进程执行**（设置 → 通用可关，环境变量 `OBOX_EXTENSION_HOST` 为开发者兜底；宿主启动失败会自动回退到渲染进程并提示）。剩下的 D 阶段工作：README、5 个扩展改造发版、实机验证、obox 2.0.0。

## 技术债登记（显式记录，避免"降级实现"悄悄变成长期方案）

| # | 债 | 来源 | 退场条件 |
| --- | --- | --- | --- |
| 1 | **main→宿主用轮询代替推送**（`host.event.poll`，250ms 游标轮询） | R65 / B3a：协议没有 main→host 的信封，`runtime.ts` 会丢弃 `event` | 给协议加 `mainEvent` 信封（`PROTOCOL_VERSION` 1→2）后换成真推送；宿主侧已隔离在 `HostEventSource` 窄接口后，换实现只动一处 |
| 2 | ~~**`update` 的 4 条能力仍是桩**~~ **已退场（B3b-2）**：由渲染侧 `updaterStore.isActive` 权威判定（`ui.updateGate`），放行后宿主真调 main 的 `host.update.*`（R70 把 `updater.ts` 的内联 handler 抽成具名导出，渲染侧与宿主共用一份逻辑） | R64 / B3a → B3b-2 退场 | —（已关闭） |
| 3 | ~~**`ui`(5) + `output.createChannel`(1) 是桩**~~ **已退场（B3b-2）**：渲染侧 `RpcServer` + 宿主 `RpcClient`（同一 host-renderer 端口），`output` 走事件落 `outputStore` | R67 / B3a → B3b-2 退场 | —（已关闭） |
| 4 | **`ext.ts`/`secrets.ts`/`notification.ts` 的 handler 内联未导出** ⇒ B3a 在 `index.ts` 逐字重写四段（含 `safeStorage` 判定） | B3a 越界约束 | 做一次"main 能力函数导出化"重构，两处共用一份（现有门禁只防"明文回归"，防不了逻辑漂移） |
| 5 | **`proxy.get` 改为 1 秒 TTL 缓存**（v1 是每次读最新） | B3a：该 API 是同步签名 × 异步 RPC | 协议支持同步快照或把 `proxy.get` 改成异步（属扩展 API 面变更，需升 apiVersion） |
| 6 | **宿主发起的通知不遵循「设置-通知」的逐扩展开关** | B3a：`stateStore.isNotificationDisabled` 在渲染侧 | B3b/settings 卡把开关状态交给宿主（或由渲染侧代发） |
| 7 | **overlay 的 `overlayOwners` 消息路由表未迁移**（`app.onMessage` 的 overlay→扩展寻址） | B3a 只做 `extId` 绑死与 main 越权校验 | B3b（app 注册与消息面） |
| 8 | **`pipe + autoReconnect` 有实现无自动化用例** | B2 | 单开一条测试卡（确定性构造断线/重连） |
| 9 | **sidecar 分帧按字节计 `Content-Length`**（不是字符数） | B2（测试脚本踩过） | 写进扩展作者文档的注意事项（D1） |
| 10 | **`ExtensionApiOptions.extensionDataDir` 已成纯未读字段** | B2 / R63 | 下次动 `runtime.ts` 时连同实参一起删（各 1 行） |
| 11 | **`api-reference.md:576/:667` 的代理表述过时**（"环境变量无效"、"代理是 session 级"） | B1（宿主侧改为 main 优先 + env 兜底 + 宿主内自应用） | D1 文档重写时改 |
| 12 | ~~**宿主 fork 时没传 `OBOX_LOCALE`/`OBOX_APP_NAME`/`OBOX_APP_VERSION`**~~ **已退场（B3b-2 / R69）**：main fork 时注入三项 env（覆盖宿主机器同名 env），宿主 `api.appInfo`/`api.env.language` 一开始就正确，不再依赖 settings 快照校准 | B3b-1 → B3b-2 退场 | —（已关闭） |
| 13 | **宿主扩展创建的 overlay 收不到 `app.onMessage`**（`overlayOwners` 由渲染侧 `api.overlay.create` 回填，宿主模式创建走 `capabilities/host-main.ts`） | B3a + B3b-1（原 #7 的具体化） | B3b-2 或 D：`host.overlay.create` 成功后把 `(overlayId → extId)` 同步给渲染侧 |
| 14 | **`api.executeCommand` 无法执行内置扩展的命令**（内置扩展仍在渲染侧，宿主命令表只有用户扩展） | B3b-1 残留（双运行时后的必然结果） | 若要支持，命令表需双向（渲染侧命令注册也同步给宿主一份） |
| 15 | **`on`/`emit` 不再跨运行时**：内置扩展（渲染侧）与用户扩展（宿主）之间不再互通 | B3b-1 | 若确有跨运行时事件需求，做一条 host-renderer 事件桥 |
| 16 | **`workspaceState` 与 `globalState` 现在是真隔离**（v1 两者指向同一 store） | B3b-1（**有意修正**的语义差异） | 无需退场，但要写进 D1 迁移说明：依赖"两者其实同一份"的扩展会感知到差异 |
| 17 | **接缝缺陷的教训（已修，防复发）**：A2 把 `port1` 放进 `init` 的 transfer 列表、A3 的端口适配器只读 `event.data` ⇒ **真机上 host-renderer 端口从未到达宿主**，而两侧单测各自用假件全绿 | B3b-1 发现（R68 修复） | 已补 7 条接缝测试（含"端口为空 ⇒ `EH_NOT_READY`"与真实 runtime 端到端）。**后续每张跨侧卡都必须带接缝测试** |
| 18 | **桥接缝（已修，防复发）**：A4 的 `extensionHostBridge` 对宿主发来的 `req` **一律回 `EH_INTERNAL`**（"A4 不支持宿主发起的 RPC"）⇒ 宿主的每条 `ui.*`/`updateGate` 在真机上都会拿到 `EH_INTERNAL` 或与正确 `res` 竞速 | B3b-2 发现（R71 修复：`setHostRequestHandler()` 接管，未注册时行为不变；只挂一条路径防同 id 双回包，附 3 条测试） | 同 #17：**双向 RPC 必须各有一条"真回环"用例**，不能只测单向 |
| 19 | `output` channel 尚未并入 `EH_EVENT_CHANNELS` 常量（协议不设白名单，故不影响运行） | B3b-2 | D1 顺手补齐一行 |
| 20 | **宿主模式下 `.oix` 热装卸未与宿主对齐**：清单只在 `ehStart` 的 `init` 交给宿主一次 ⇒ 新装/覆盖安装要重启应用 | D1 发现 | 宿主 ready 后补一次增量清单同步 |
| 21 | **扩展管理器没有宿主状态面板/按钮**（A5 未做）：宿主崩溃/重启/启动的 UI 入口不存在，实际恢复手段是重启应用 | D1 发现 | 做 A5：管理器显示 phase、崩溃次数与「重启宿主 / 禁用扩展」按钮 |
| 22 | **宿主进程没有 `--inspect` 接线**：CDP 断点只能打在渲染进程侧，宿主侧调试只能靠日志 | D1 发现 | `extensionHostStarter` 支持 inspect 端口透传 + 文档写 attach 步骤 |
| 23 | **脚手架不写 `apiVersion`**（`skills/obox-ext-init/scripts/create-*.mjs`） | D1 发现 | 已裁定：**保持不声明**（更兼容旧宿主），在 skill 文档注明「用到宿主专有能力时才改 3」 |


## 阶段 D 记录（2.0.0-rc.1 → 正式版之间）

### 五个用户扩展的宿主适配（D3–D7，均已在各自仓库发版）

| 扩展 | 新版本 | 关键修复 | apiVersion / activationEvents |
| --- | --- | --- | --- |
| obox-updater | **1.1.2** | 3 秒 ack 超时不再被当成失败；`getVersion` 补 catch | 1 / 缺省 `*` |
| rdp | **1.0.5** | 卡片页面 URL 由 `file://` 改为 `app://extensions/<目录名>/…`（否则白窗）；补 sidecar/cwd/分帧审计用例 | 1 / 缺省 `*` |
| todo | **1.1.0** | 数据迁到宿主 `api.globalState`（页面 localStorage 降级为兜底）+ 卡片 URL 修复；**并入远端同期新功能**（截止时间、循环任务、提前完成确认、到期提醒） | 3 / ["*"] |
| webapp | **1.0.7** | 卡片页面 URL 修复；冷缓存下两处不可逆动作（清空进度改强制写、默认根回填加闸门防覆盖用户外部根） | 1 / 缺省 `*` |
| pet | **2.0.1** | 浮层页面 URL 修复（否则宠物整窗不出现）；README 补宿主模式已知不可用项 | 2 / 缺省 `*` |

判据统一是"**不改会怎样**"：`apiVersion` 只在真依赖宿主专有能力时升（本批只有 todo 升 3）；
`activationEvents` 只在有明确懒激活入口时才写（本批全部保持缺省 `*`——它们都需要启动即注册
卡片/状态栏/消息处理器，写 `onCommand:` 会导致卡片永不出现）。

### 宿主侧修的两个真缺陷（D8b / R72）

1. **技术债 #13 收口**：宿主创建的 overlay 现在能被 `app.onMessage` 寻址（见上表 #13 退场）。
   pet 的 6 条页面→入口通道因此恢复，宿主模式下宠物可交互。
2. **长操作 ack 超时**：`update.download` / `update.install` 单独放宽到 15 分钟，`check` 60 秒
   （见技术债 #25：这是给预算，不是根治）。

### 验证现状

- **`test/extension-host-real-extensions.test.ts`（D8a，14 条）**：用**磁盘上的真实清单与真实入口文件**
  驱动**真实宿主运行时**（loader 真 import、apiFactory 全生产能力），5 个扩展全部 active、
  plugin(api) 全部执行、零抛错。这是本轮最有价值的一条证据——此前所有测试都用 ESM 夹具，
  从未加载过真扩展。
- **仍未做的**：GUI 层面实机验证（宠物浮层是否真的画出来、卡片子窗口是否真的打开、sidecar 真实
  spawn 后的行为）。`docs/update-and-release-verification.md` 第 12 节列了 R1–R6 六项。