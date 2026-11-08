# Proposal

## Why

用户点开 App 扩展卡片（例如「远程桌面」）后只看到**一片纯白窗口**，扩展页面完全不渲染；宿主既没有报错也没有提示，用户和扩展作者都无法判断原因。

已定位的链路（真机复现）：

1. 卡片地址由扩展自己决定。旧构建的扩展写的是 `new URL('./ui/index.html', import.meta.url).href`，而在 2.0 起默认的宿主进程里 `import.meta.url` 是 `file://…`，于是卡片 URL 变成 `file:///…/extensions/rdp.chenzhi/ui/index.html`；
2. 外壳 `src/renderer/index.html` 的 CSP 是 `default-src 'self' app:`，`frame-src` 回落到它 ⇒ **`file://` 的 iframe 被整块拦掉**；
3. `AppWindow.vue` 的 `.app-frame` 写死 `background: #ffffff`，于是"拦掉"表现为"白色空白"；
4. 宿主对卡片 URL **不做任何校验或纠正**，失败完全静默。

结果是：扩展作者以为页面坏了，用户以为应用坏了，而仓库里其实早已有正确写法（`appPageUrl()` 生成 `app://`）。已安装副本不会自己更新，所以宿主这一侧必须有兜底与诊断。

## What Changes

- **旧式地址归一化**：把指向扩展目录内页面的 `file://` 地址映射为等价的 `app://extensions|debug/<目录名>/<相对路径>`，使已安装的旧扩展**无需重发**即可正常打开；每条只 warn 一次并写明原始与归一化地址。
- **不可用地址不再白屏**：协议不符或无法判定归属时，内容区渲染**诊断块**（应用名、原始地址、原因、修复提示），并输出可 grep 的 `[AppWindow]` 警告。
- **未加载时的底色跟随主题**：iframe 底色从固定 `#ffffff` 改为主题 token，页面未加载/被拒时不再出现刺眼白块。
- **文档同步**：`docs/extension-api/troubleshooting.md` 增加「App 卡片白屏」条目；`guides-user.md` 把"卡片 URL 必须是 `app://`"写成硬要求。

## Capabilities

### New Capabilities

- `extension-page-loading`: App 卡片与 overlay 的扩展页面地址校验、旧式 `file://` 地址归一化、加载失败诊断与日志，保证"打不开时能看出为什么"。

### Modified Capabilities

（无。扩展 API 面、manifest 契约与 `apiVersion` 均不变。）

## Impact

- **代码**：`src/renderer/src/AppWindow.vue`（iframe 地址来源、诊断态、样式）；新增一个纯函数模块承载归一化/判定逻辑（便于单测，不依赖 DOM 与 electron）。
- **行为**：App 卡片窗口与 overlay 窗口的加载失败路径；正常 `app://` 卡片行为不变。
- **文档**：`docs/extension-api/troubleshooting.md`、`docs/extension-api/guides-user.md`。
- **兼容**：已安装的旧扩展（`file://` 卡片地址）由归一化救回；不修改任何扩展 API 或清单字段。
- **不做**：不改 CSP 放行 `file://`（那会打穿同源边界）；不为扩展自动改写其源码。
