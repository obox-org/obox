# 宿主「AI 选项」：OpenAI 兼容参数 + 页内掩码控件 + 主进程测试连接

## 背景

1. **用户要求**：「obox 增加 AI 选项，可以配置 openai 的接口参数，包括 baseUrl、apikey、model、contextLen 和每日限额，每日限额可以为空」。范围裁定（Q19=A）：**配置页 + 掩码 + 测试连接**；`dailyLimit` 本期**只存储 + 展示**（无消费者、不做用量记账）；**不新增扩展 API 面**。
2. **落点现状**：设置页是**内置扩展**（`src/renderer/src/extensions/settings/manifest.json` → `view: "SettingsView"`），左侧树是**硬编码页键**（`SettingsView.vue` 的 `TreeKey`：`appearance` / `general` / `language` / `keyboard` / `update` / `network` / `notification` / `extension`），右侧按 `v-else-if="active === '…'"` 分块渲染；设置值统一走 `stateStore`（localStorage 持久化，`src/renderer/src/core/state.ts`），**读设置不被追踪**（state 是普通对象）⇒ 页面必须依赖 `settingsRevision` 计数重算。
3. **卡 20 刚落地的代理链路**：新增宿主内部 IPC `proxy:apply`（`src/main/net.ts` 的 `registerProxyIpc` / preload `applyProxy`），渲染进程在启动与改设置时把当前代理推给主进程，`applyProxy()` 把它应用到扩展联网（`obox-net`）与更新（`electron-updater`）两个 session。因此"在 `netSession()` 上发请求"这件事**现在真的会走用户配置的代理**——本卡的测试连接必须复用这条链路。
4. **为什么不顺手加一个公开字段类型**：给 `SettingFieldType` 加 `'password'`（或给 number 字段加"可空/上限"语义）属**扩展可见能力**。按本仓库惯例（`progress` 随 `apiVersion 2` 引入，见 ADR-0024 决策 5/6），新增可见面必须 bump 根 `package.json` 的 `apiVersion` 到 3，并联动 `src/api/contributions.ts` 文档、`scripts/validate-manifest.mjs` 白名单、`test/manifest-script-parity.test.ts` 差分门禁、`docs/extension-api/manifest-reference.md`、`docs/extension-api/themes-settings.md`。那是**另一个 change**，与本卡的"只做宿主自己的设置页"混在一起会把门槛改动藏进 UI 需求里。⇒ 掩码做成 **AI 页内的专用控件**。

## 备选与否决理由

| 备选                                                                     | 做法                               | 否决理由                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B：新增公开字段类型 `password`（并给 number 加可空/上限语义）**        | 掩码复用扩展字段体系，宿主统一渲染 | 属扩展可见能力 ⇒ 必须 bump `apiVersion 3` 并联动五处文档/门禁（见背景 4）。且"每日限额可为空"这种语义现有 schema 表达不了，一起改会把这个 change 拖成"API 版本升级 + 设置页 UI"两件事。**延期到独立 change**（届时连掩码一起做成扩展可见能力）。                       |
| **C：渲染进程直接 `fetch` 测试连接**                                     | 少一条 IPC                         | 渲染进程 CSP 禁外网（`net.ts` 文件头已写明），且渲染进程 `fetch` 走**默认 session、不经宿主代理** ⇒ 用户配了代理反而失败（或静默直连）。与卡 20 的结论直接冲突。                                                                                                       |
| **D：主进程用 Node 全局 `fetch`**                                        | 主进程发请求，看起来"也走主进程"   | undici 不读代理 env、无法应用 per-session 代理与证书策略（ADR-0007 修订段的同一条教训：`HTTP_PROXY` 对两条链路都无效）。                                                                                                                                               |
| **E：密钥用 Electron `safeStorage` 加密（或给宿主开专用 secrets 通道）** | 不明文落盘                         | 本期**没有消费者**（不拿这些参数调模型），为一份"只存不读"的配置引入密文存储/读回/迁移/跨机器不可解密的完整故事，收益低而退面大；且 `src/main/secrets.ts` 现有通道是**按扩展 id** 命名空间的，宿主自身密钥需要另设命名空间或另开文件。记入退场条件（见"风险与退路"）。 |
| **F：`dailyLimit` 不落库（只画个输入框）**                               | 免得"存了没用"                     | 用户明确要求"配置"它；不落库等于重启即丢，是更坏的体验。改为**存储 + 展示 + 页内说明**。                                                                                                                                                                               |

## 决策

1. **左树新增「AI」页**（`TreeKey` 加 `'ai'`，i18n `settings.tree.ai` 中英都是「AI」）。节点位置：**「网络」之后、「通知」之前**。理由：AI 配置是"对外连接"类设置，它的「测试连接」直接吃「网络」里的代理——相邻最符合排查路径（连不上时第一反应是查代理）；也避免插在末尾那两个与本地扩展管理相关的节点（通知/扩展）之间。
2. **五个设置键**，一律走统一设置存储（`stateStore`，前缀 `ai.`），页内**只存储 + 展示**：
   - `ai.baseUrl`（text，占位 `https://api.openai.com/v1`）；
   - `ai.apiKey`（**页内掩码专用控件**，见决策 3）；
   - `ai.model`（text，占位 `gpt-4o-mini`）；
   - `ai.contextLen`（number，**默认 8192**）。归一策略：空/全空白/非数字/NaN/±Infinity/**0/负数** → 默认 `8192`（"1 token 上下文"没有意义，回落到可用默认比钳到 1 更可预期）；小数**向下取整**；`> 1048576` → **钳到上限**（荒谬大值不原样存，也不"拒绝保存却无反馈"）。
   - `ai.dailyLimit`（number，**允许为空 ⇒ 表示"不限"**）。归一策略：空/全空白/null → **`null`（不限）**；非有限/非数字/**负数** → `null`（负数限额没有意义；归一为"不限"而不是 0——归一为 0 等于把一次误填变成"禁止使用"）；其余向下取整；**`0` 保留为 `0`（额度 0）**。**"空"与"0"是两个语义**，有测试钉住（存储层断言 `null !== 0`，且键存在、不报错）。
3. **掩码做成页内专用控件**（不新增公开字段类型）：默认**掩码态**只渲染**固定 8 个圆点**（与密钥长度无关，不泄漏长度；未配置时显示「未配置」）；点「显示」才挂载明文输入框，点「隐藏」回到掩码态。切换只改组件内的 `showApiKey` ref——**不写设置、不落盘、不触发保存**。密钥保存走 `@input`（**不是** `@change`）逐键落库：掩码切换会重建输入框，若等失焦才保存，"输入到一半点隐藏"就会丢输入；逐键落库让"切换/失焦丢输入"不可能发生。如此掩码态**DOM 里根本没有明文**（比 `type="password"` 更硬的保证），且密钥永不作文本插值、不进任何提示或日志。
4. **「测试连接」在主进程用 `netSession()` 发**（新增 `src/main/ai.ts`，宿主内部 IPC `ai:test-connection`；`MainApi.aiTestConnection` + preload 暴露，**不属扩展 API 面**——与卡 20 的 `proxy:apply` 同形，扩展那侧没有对应方法）：
   - 请求：`GET {baseUrl}/models` + `Authorization: Bearer <apiKey>`（key 为空则**不带**该头——不少本地端点不要密钥），`Accept: application/json`，**10 秒超时**（`AbortController`）；
   - `baseUrl` 拼接**容忍有/无（含连续多个）尾斜杠**并 trim，保留路径（`/v1`）；
   - 请求前再 `applyProxyToSession(netSession(), currentProxy())` 兜一次（`net.ts` 的 `proxy ?? currentProxy()` 同一理由）：按钮是否走代理**不依赖** `proxy:apply` 的推送时序；
   - 结果**不抛错**，返回中文结论 + 稳定 `reason` 码（`missing-base-url` / `invalid-base-url` / `unauthorized` / `forbidden` / `not-found` / `http-error` / `bad-response` / `network` / `timeout`）；成功形如「连接成功（N 个模型可用），如：a、b、c」；失败给可执行原因（401「密钥无效」/ 无 key 的 401 说"端点要求密钥" / 404 带上试过的 URL 并给出 baseUrl 该长什么样 / 网络与代理错误带原始 Chromium 错误名（如 `net::ERR_PROXY_CONNECTION_FAILED`）并指向「设置 → 网络」/ 超时写「请求超时（10 秒）」）；
   - 结果里**绝不回传 apiKey**（`AiConnectionResult` 无该字段，测试断言 `JSON.stringify(result)` 不含密钥），`[ai]` 日志只记结论与中文原因。
   - 渲染进程侧先做**本地快速失败**：`baseUrl` 空 ⇒ 提示「请先填写 baseUrl」并直接 return（**不发任何 IPC/网络请求**）；非 `http(s)://` ⇒ 本地拒绝。主进程同口径再校验一次（防绕过，也覆盖其它调用方）。
5. **`dailyLimit` 只存储 + 展示**：本期无消费者、不做用量记账（`0` 与空的差异只是数据语义，等真消费者落地时以它为准）；页内 `intro` 明写"本期只存储与展示，尚无功能会拿这些参数去调用模型"，避免用户误以为配了就生效。
6. **安全口径**：`apiKey` 与其它设置一样**明文**存在 localStorage（`obox:state:v1`）⇒ 页内明写一行「密钥以明文保存在本机配置中（与其他设置一样，经 localStorage 持久化）」，并在本 ADR 记录取舍与退场条件（见下）。

## 后果

- **好处**：AI 页可用且自洽——五项可填可存、空值语义明确（`dailyLimit` 空=不限 / 0=额度 0）、密钥默认不出现在 DOM 里、有一个真的能验证配置的动作；「测试连接」与 `api.net.fetch`/更新链路**共用同一条 session 代理链路**，用户配的代理与忽略 SSL 立刻对它生效，排查时"按钮失败"与"扩展请求失败"的结论一致。
- **代价**：宿主多了 1 个内置页、1 个主进程模块（`src/main/ai.ts`）与 1 条**宿主内部** IPC；`ai.*` 五项在当前版本**没有功能效果**（无消费者）。设置页多了一处"页内实现"的掩码控件（不是通用能力），将来要做成扩展可见字段时需要重做一遍并 bump `apiVersion`。
- **风险与退路**：
  - **密钥明文**：退场条件是改用 Electron `safeStorage`（宿主自身密钥要么走 safeStorage + 独立文件，要么给宿主开一个专属 secrets 命名空间，`src/main/secrets.ts` 已有加密先例但按扩展 id 命名空间），并做**一次性迁移**（首次读取时把明文迁进密文并清空明文）。属**独立改动**，与本 ADR 的其它决策无关。
  - **测试连接的结果文案由主进程给且固定中文**：一手信息（HTTP 状态码、Chromium 错误名）只在主进程拿得到，且现有主进程错误文案（`net.ts` / `proxy.ts`）本就是中文。英文界面下这段是中文——**有意如此**，要本地化需把 `reason` 映射回 i18n（渲染层已有 `reason` 码，改动很小），留给后续。
  - **掩码控件不可复用**：扩展作者暂时拿不到"掩码字段"。将来需要时，应把 `password` 与"可空 number（`dailyLimit` 那种）"一并设计成扩展可见能力，并 bump `apiVersion 3` + 同步 `docs/extension-api/**`、脚本白名单与 parity 门禁。
  - **`ai:test-connection` 属宿主内部面**：扩展理论上能直接访问 `window.api`（ADR-0015：扩展是受信代码，这不是安全边界），该 IPC 只是"不进扩展 API 声明面"。要真正收口得等"扩展隔离到独立进程"。
  - **`contextLen` 上限 1048576 是拍的**：它只用于自保（防荒谬值入库），不是任何端点的真实约束；真消费者落地时若需要按模型能力校验，应以消费者的口径为准并调整这里。

Status: accepted
