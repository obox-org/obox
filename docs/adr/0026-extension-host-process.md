# 扩展宿主进程（Extension Host Process）

用户扩展（`.oix`）的业务逻辑搬进**独立的 Node 进程**执行，该进程由主进程用 Electron `utilityProcess.fork()` 拉起、随主窗口同生共死；渲染进程只保留 UI 与**内置扩展**（app / settings / ext-manager / theme×2）。本 ADR **supersedes 0001（渲染进程扩展宿主）与 0004（两阶段启动/全量激活）**。

## 决策

1. **进程拓扑**：main（外壳）+ renderer（UI + 内置扩展 + 渲染侧运行时）+ **Extension Host Process**（用户扩展）。单宿主承载全部用户扩展，不按扩展拆进程（可选分组留作将来的清单字段）。
2. **载体**：Electron `utilityProcess`（Node 环境、官方 MessagePort、崩溃有 exit 事件）。与 VS Code 的桌面实现同路径（`vendor/vscode` 的 `extensionHostStarter.ts` → `utilityProcess.ts`）。**"随窗口同生共死"由主进程手工绑定**（监听主窗口 `closed` → `stop()`、`before-quit` → `dispose()`）：Electron 44 的 `ForkOptions` **没有** `windowLifecycleBound` 这个选项（VS Code 用的是它自己的 UtilityProcess 包装层），实现时不要照抄。
3. **能力**：扩展在宿主进程里拥有**完整 Node**（`require('fs')`、`child_process`、`node:sqlite`、任意 npm 包）。宿主自带 `fs` / 子进程 / sqlite / timer / net；**只有这些仍回 main**：`safeStorage` 密钥、系统对话框、通知、窗口与托盘、菜单、`app://` 协议、自动更新、单实例、关闭行为。
4. **API 交付**：保持 `plugin(api)` 传参（不改成 `require('obox')` 拦截），扩展入口写法不变；`api` 由宿主进程按 `extId` 现场构造，与今天的 `buildApi()` 同构。
5. **与 UI 的边界**：扩展给 UI 的 HTML/SVG **字符串**保留（状态栏文本、卡片图标、iframe `srcdoc`），只是生成地搬到宿主进程后经消息桥送到渲染侧渲染；页面仍由渲染进程的 iframe 加载，`app://` 协议仍只在 main 注册。
6. **激活**：引入 `activationEvents`，只实现 4 类 —— `*`、`onStartupFinished`、`onCommand:<id>`、`onView:<id>`；缺省 `*`（现有扩展行为不变）；内置扩展仍立即激活、不参与。
7. **崩溃**：照 VS Code —— 5 分钟窗口内 3 次为阈值；<3 次自动重启并提示；达 3 次弹窗（禁用扩展 / 重启宿主 / 查看日志），不无限重启；卡死（3 秒未 ack）**只观测不杀**。
8. **版本**：`apiVersion` 由 2 升到 **3**（运行时环境变了：无 DOM/localStorage、能力来自宿主进程）；obox 一次交付 **2.0.0**，5 个用户扩展各自升 manifest 后重新发版。

## 理由

原 ADR-0001 的判断（"一个本地桌面壳应用，多进程 RPC 成本远超收益"）在当时成立：扩展贡献点全是 UI，渲染进程是唯一自然位置。但它同时留下了两个代价——**没有崩溃隔离**，以及**扩展与 UI 共享同一份 JS 堆**（一个扩展死循环会冻结界面）。ADR-0015 已经记下这条路："真隔离的方向 = 把宿主移入独立进程（`utilityProcess`/子进程）+ 能力走消息桥"，并注明代价是重做加载器、消息桥、热装卸与调试链路。

用户明确要求仿照 VS Code 做这件事，并且要"所有进程都放在 Extension Host 进程里"。搬走之后还额外拿到两个红利：扩展**拥有完整 Node**（不再需要为每个新能力改宿主、升 apiVersion），以及**全量激活不再阻塞首屏**（宿主与 UI 并行启动，这也是 ADR-0004 可以退场的原因）。

## 被否决的备选

| 备选 | 否决理由 |
| --- | --- |
| 双轨（新扩展进宿主、旧扩展留渲染） | `window.api` 与 RPC 两套能力并存，维护与文档成本翻倍，最终还要再搬一次 |
| 只搬"后台型"扩展（pet / obox-updater） | 等于承认这套架构只服务一半扩展，达不到"所有进程都在宿主里" |
| `child_process.fork` | 没有 MessagePort（要自己分帧与背压），生命周期要自己管；VS Code 已用 `utilityProcess` 验证 |
| 隐藏 BrowserWindow（开 `nodeIntegration`） | 安全面最差，且每扩展一个窗口成本高 |
| 独立可执行文件（自带 Node） | 两套产物与签名，现阶段收益很小 |
| 每扩展一宿主进程 | 每个 Node 进程 50–80MB 起，5 个扩展就 300MB+；VS Code 默认也不这么做 |
| 能力全部仍经 main 转发 | RPC 面还是 40+ 条、多一跳，等于没搬 |
| 拦截 `require('obox')` 交付 API | 所有扩展入口写法要改，且 ESM 下实现成本高；`plugin(api)` 已能满足 |
| 状态栏/图标改成结构化数据 | 破坏至少 3 个现有扩展（自定义 SVG/HTML），表达力也下降 |
| 崩溃即无限重启 | 必然崩溃的扩展会造成重启风暴 |
| 不升 apiVersion（保 2） | 用了 DOM/localStorage 的扩展会**静默失效**，排查成本极高 |
| 保持全量激活（ADR-0004 不变） | 用户选择懒激活；宿主进程让懒激活的收益（启动更快）第一次成立 |

## 代价与风险

- **能力面 40+ 方法要逐条跨进程**：`buildApi()` 现在全是"闭包绑 `extId` + 直调 `window.api.*`"，且语义依赖同进程细节（`{ok:false}`→`throw`、reactive Proxy 过不了 IPC、`window.events.on` 分发）。必须重造成 RPC，并造取消/超时/错误码。
- **序列化约束**：RPC 只能过 JSON 值（+ 二进制旁路）；类实例、函数、循环引用都过不去（VS Code 的做法是降级/丢函数/循环变 null）。现有能力里有几处传 reactive 对象，必须统一经 `plainProxyConfig` 之类的归一。
- **热装卸要重新表达**：`removeExtension`、`canHotRemove`、`location.reload()`、`pendingInstall` 的三态补跑都建立在"同进程可重载"之上。
- **调试链路**：宿主进程需要 `--inspect` + 端口转发，`--remote-debugging-port`（CDP）对渲染进程的那一套不能直接用。
- **双写期**：`docs/extension-api/**` 需要全量重写，5 个扩展各自改能力调用。
- **退路**：若进程化后出现无法定位的稳定性问题，可临时把 `utilityProcess` 启动开关关掉、退回渲染进程执行（保留一个 feature flag 直到 2.0 稳定）——这是本次唯一保留的回退手段。

## 迁移

5 个用户扩展（obox-updater / rdp / todo / webapp / pet）需要在 `apiVersion: 3` 下重新发版；其中 rdp 与 webapp 的 stdio sidecar 改由宿主进程拉起（宿主有 `child_process`），`safeStorage` 等仍经 main。分阶段实施与文件所有权见 `docs/extension-host-migration.md`。

Status: accepted
Supersedes: 0001, 0004
