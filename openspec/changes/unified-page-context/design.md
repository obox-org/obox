# Design

## Context

现状与约束（动机见 `proposal.md`，需求见 `specs/`）：

- 主体 UI 已是**磁盘系统扩展的 HTML 页面**（`system-extensions/{app,settings,ext-manager}`），壳子只负责导航/标题栏/命令面板等 chrome；扩展页面拿不到 Vue 运行时，只能通过 `postMessage` 与 `hostQuery`（`obox:page-call` / `obox:page-reply`）与壳子通信。
- 主题 token 的唯一真相是渲染进程 `:root`（`src/renderer/src/core/theme.ts` 的 `apply()` 写 25 个 token）；`src/renderer/src/core/appTheme.ts` 的 `HOST_THEME_TOKEN_NAMES` 与 `main.css` 有差分测试锁死。
- 已有两条主题投递链路，形状不同：App 卡片/overlay 用 `{ source:'obox-app', action:'obox-theme', themeId, tokens }`（25 个生效值）；系统页用 `{ type:'obox-theme', tokens }`（主题声明值，且页面多拼了一层 `--`，实际写入 `----bg`）。
- 扩展词条已有唯一来源：manifest `contributes.i18n` → 渲染侧 `core/extensionI18n.ts` 注册表（按扩展 id 命名空间），`api.i18n` 与宿主侧 `ui-plane.ts` 都消费它；壳子标签目前只认 `titleKey`（宿主语言包）。
- `app://` 协议处理器只认 `extensions` / `builtin` / `debug` 三个 host（`src/main/protocol.ts`），MIME 由 `net.fetch(file://)` 推断。
- 语言现在是两套：渲染侧 localStorage `obox:locale:v1` + vue-i18n；主进程 `app.getLocale()`。
- 扩展宿主已通过 `ui-plane` 的 snapshot 拿到 `locale`（`onLocaleChanged` 可用），不需要新通道。

## Goals / Non-Goals

**Goals:**

- 一条 `obox:context` 消息同时承载主题（25 个生效 token + `colorScheme`）与语言（`locale` + 本扩展 `messages`），系统页 / App `url` 卡片 / overlay 三种容器行为一致。
- 提供可选页面运行时 `app://obox/page.js`，把"写 `:root`、设 `colorScheme`、`t()`、请求重试"收进一处，页面一行接入。
- 扩展标签（manifest 中壳子渲染的字段）用 `%key%` 解析，词条留在 `contributes.i18n`，不再依赖宿主语言包。
- 语言成为单一设置源，并同步到主进程（托盘/对话框）。
- 老页面（已发布扩展）在新宿主上零改动继续工作；新页面在老宿主上安全降级。

**Non-Goals:**

- 不扩 token 集合（仍 25 个），不做组件级设计系统。
- 不做 `srcdoc` 卡片的实时语言切换（它在宿主文档内、由扩展代码生成；生成期用 `api.i18n`）。
- 不改 overlay 的 artwork 配色取舍（宠物扩展的"零自造色值"豁免继续有效）。
- 不做 Windows 原生标题栏/系统控件的深色化（`nativeTheme` 与 token 无关）。
- 不新增支持语言（仍 `zh` / `en`）。

## Decisions

### D1. 一条消息、一个版本字段，取代两套主题协议

`obox:context` 字段：`type`、`version: 1`、`themeId`、`colorScheme`、`tokens`、`locale`、`messages`。

- 为什么合并：页面只需要"我该长什么样、该说什么话"这一份状态；分成两条消息会让"主题到了、语言没到"成为合法中间态，页面要么写两套监听、要么处理半更新状态。
- 为什么带 `version`：页面运行时可以按版本降级（未来加字段不破坏老页面）；`version` 是整数，页面只做 `>=` 判断。
- 为什么 `tokens` 固定 25 个生效值：主题可以只声明部分 token，页面必须能拿到完整快照才能和宿主一致；"生效值"由 `collectThemeTokens(getComputedStyle)` 产出，和 App 卡片现有快照同源。
- 备选：继续用两套协议、只修 bug —— 被否，这是本次要消除的根因之一；把语言塞进 `obox-theme` 消息 —— 被否，名字与语义不符，且系统页/卡片两套形状仍要维护。

### D2. 页面运行时是"可选便利层"，不是协议本身

`app://obox/page.js` 暴露 `startPageContext({ onChange })`，内部：监听 `obox:context`（校验形状）→ 写 `:root` → 设 `colorScheme` → 暴露 `t(key, params)`（缺失回退 key 并 warn）→ 0/300/1000ms 三次 `obox:context-request`（收到即停）→ 去重（同一份 tokens 不重复写 DOM）。

- 为什么不强制：协议本身是 `postMessage`，页面可以自己实现（既有 webapp 就有一份手写实现）；强制引入会让"更新一个页面"变成"必须改构建"。
- 为什么运行时放 `app://obox/` 而非扩展目录：它是宿主能力、随 obox 版本升级；放在扩展目录会让每个页面各自抄一份。
- 运行时不读 Node/Electron API，只碰 DOM 与 `postMessage`，因此可以在浏览器里单测（注入假的 `window`/`parent`）。

### D3. `colorScheme` 由主题声明，id 推断只作回退

主题贡献点加可选 `colorScheme`；`themeStore` 组装上下文时 `theme.colorScheme ?? (/light/i.test(theme.id) ? 'light' : 'dark')`。

- 为什么不让页面自己猜：页面拿不到主题 id 的语义（`solarized` 是浅色但 id 不含 light）；而且原生控件/滚动条只认 `color-scheme`，猜错就是白底黑字的控件配深色页面。
- 备选：只按 id 推断 —— 被否，已有反例；要求主题必须声明 —— 被否，会破坏已发布主题。

### D4. 标签用 `%key%`，解析在壳子、命名空间按贡献所属扩展

- 解析点：`registry` 里的每条贡献都带 `extensionId`，渲染/序列化时用它查 `extensionI18n` 的该扩展词条；扩展管理器与设置页快照在 `hostQueryDeps` 里先解析，页面拿到的已是成品文本。
- 为什么不用内联 `{zh,en}` 对象：词条会与 `contributes.i18n` 形成两套源，页面与标签各存一份，改文案要改两处；`%key%` 复用现有词条与注册表。
- 为什么不用 VS Code 的 `package.nls.<locale>.json` + `%key%`：多一套文件约定与加载逻辑，而 `contributes.i18n` 已存在且已被 `api.i18n` 使用。
- 缺 key：显示占位符原文 + 每扩展每 key 一次 warn。备选"回退到 key 名"会让界面出现 `nav.home` 这种半截文本，更难排查。

### D5. 语言收敛到设置项，主进程经 IPC 跟随

- 设置键 `locale`（与 `theme` 同级，进 `stateStore`），`i18n.setLocale` 改为写设置 + 切 vue-i18n；旧 localStorage 键在启动时读一次并迁移，然后删除。
- 主进程：渲染进程在启动与语言变化时经 IPC 推 `locale` 给 main（与 `proxy:apply` 同款"推配置"模式）；main 缓存并重建托盘菜单/关窗提示文案，`app.getLocale()` 只在没有设置值（首启、迁移前）时兜底。
- 为什么不让 main 自己读设置：设置持久化在渲染侧（localStorage），main 读不到；"渲染侧推"是仓库既有模式（`proxy:apply`、`theme:push-tokens`）。
- 备选：把设置搬到 main 存储 —— 被否，超出本 change 范围，且会牵动所有设置读写。

### D6. 兼容策略：新宿主双发、新页面降级

- 新宿主继续发旧的 `obox-theme`（App 卡片）与 `{type:'obox-theme'}`（系统页），**一个 minor 版本**；页面运行时初始化时若在 1.5s 内没收到 `obox:context`，只打印一条 warn 并使用内置默认值。
- 系统扩展页随宿主同版本发布，直接切到新协议，不需要双发。
- 老协议删除放在后续 change，并在本文档与 `troubleshooting` 记一条"何时删"。

### D7. `app://obox/` 命名空间

`protocol.ts` 增加 `hostname === 'obox'` 分支，映射到构建产物里的页面运行时代码目录（`out/page-runtime/`，随 `files` 打进 asar 或 `asarUnpack` 视加载方式而定）。安全：只读、无用户输入拼接、`..` 与百分号转义沿用现有校验。

- 备选：把运行时作为 `data:`/内联脚本塞进页面 —— 被否，无法缓存、无法在页面之外复用、CSP 也不友好。

## Risks / Trade-offs

- **[首帧闪一下]** 上下文是异步消息，页面首屏可能先渲染 key 或默认色 → 页面运行时同步写一份内置默认 token（暗色）+ 骨架；文档明确"首帧可先渲染中性内容"。
- **[settings 页 manifest 变胖]** 约 250 key × 2 语言（预计 +20~30KB）→ 可接受；用 `scripts/validate-manifest.mjs` 加"zh/en key 集合一致"的校验，防漏翻。
- **[token 白名单漂移]** `main.css` / 主题 manifest / `HOST_THEME_TOKEN_NAMES` 三处已有差分测试 → 扩协议时保留该测试，上下文组装层复用同一常量，禁止另抄一份名单。
- **[老页面被"新协议优先"打断]** 新宿主若先发 `obox:context` 再发旧消息，老页面可能先收到未知消息 → 旧消息发射顺序保持不变（旧协议先、新协议后），页面侧对未知 `type` 必须静默忽略（写进文档）。
- **[主进程语言与渲染侧竞态]** 启动瞬间 main 可能先用 `app.getLocale()` 建托盘，随后收到推送重建 → 托盘重建是幂等的（`trayMenuItems` 纯函数），允许一次重建；文档不承诺"零重建"。
- **[系统页清空重写风险]** 三个 page.js 要删掉主题收包、换文案为 `t()` → 分两步提交（先协议与运行时、再页面迁移），每步都有可运行的中间态。

## Migration Plan

1. 先落协议与运行时（新消息、`app://obox`、双发旧协议），此时系统页仍走旧通道、行为不变。
2. 迁系统页：改 manifest 标签为 `%key%` + 补 `contributes.i18n`，page.js 换 `t()`、删自建收包；每页可独立验证。
3. 迁语言源：设置项 + 迁移 + main 推送，最后删旧 localStorage 键的读取。
4. 回滚：协议层保留旧消息，页面回滚到上一版即可；语言源回滚需保留旧键读取一个版本（本 change 内不删读代码，只标记废弃）。

## Open Questions

- 无（首帧策略、词条位置、标签语法、支持语言集合均已在讨论中定案）。
