# Troubleshooting

Obox 扩展开发中遇到的常见问题与修复。**遇到新坑后，把解法追加到这里（保持持续更新）。**

## 1. iframe 内联脚本不生效（CSP 阻止）

**症状**：App 子窗口的 iframe 里内联 `onclick="..."` 点击无反应；srcdoc 内联 `<script>` 块也不执行。dev 日志：
`Executing inline event handler violates the following Content Security Policy directive 'script-src 'self''`
或 `Refused to execute inline script ... 'script-src 'self''`。

**原因**：渲染进程 CSP `script-src 'self'` 无 `'unsafe-inline'`，**内联事件处理器与内联 `<script>` 块都会被拦截**（srcdoc 继承父文档 CSP）。旧文"用外部 `<script>` 块"的说法不成立。

**修复**（按场景）：

- **用户扩展静态页（推荐）**：App 卡片用 `url: 'app://extensions/<id>/todo.html'`——app:// 页面无 CSP 头，脚本正常执行（CSP 已放行 app: scheme 供 iframe 加载）
- **srcdoc 场景**：把脚本放到同源外部文件（如 public/ 下的静态资源）用 `<script src>` 引用；或改用 `url` 形态
- 窗口控制一律用 `parent.postMessage({source:'obox-app', action:'close'|'minimize'|'maximize'}, '*')`

## 2. App 子窗口 iframe 加载 app:// 404 或空白

**症状**：`url: 'app://extensions/<id>/todo.html'` 打不开 / 404；控制台 `Failed to load resource`。

**排查**：

- 该扩展是**用户扩展**（已安装到 `userData/extensions/<id>/`）——app://extensions 只映射 userData；内置扩展没有静态文件通道
- `<id>` 是**安装目录名**（`<name>_<author>`，如 `todo_chenzhi`），不是 manifest.name；`index.js` 里用 `new URL('./todo.html', import.meta.url)` 推导，勿硬编码
- 协议映射：`app://extensions/<id>/<rest>` → `userData/extensions/<id>/<rest>`（协议注册在 `src/main/protocol.ts`）

## 3. 子应用构建产物资源路径错（base 非相对）

**症状**：构建出的 todo.html 里是 `<script src="/todo.js">`，iframe 里 404——绝对路径解析到 `app://extensions/todo.js`（丢目录段）。

**修复**：`vite.config.ts` 设 `base: './'`，产物引用变为 `./todo.js` / `./todo.css`。

## 4. iframe 里 alert/confirm/prompt 无效

**原因**：iframe sandbox 无 `allow-modals`。
**修复**：交互全部用页面内 UI（行内确认、自定义输入），不依赖浏览器弹窗。

## 5. oix 安装失败

**排查**（扩展管理器提示的失败信息）：

- `manifest.json` 必须在 zip **根目录**
- `name`/`version` 非法（正则 / semver）；`main` 指向的文件必须在包内
- 包内含非法条目路径（`..` / 绝对路径 / 反斜杠）→ 被 zip-slip 防护拒绝
- 安装成功但列表标红：manifest 校验失败或入口加载/激活失败（看详情页校验信息与 `activationError`）

## 6. Windows 下 Vite watcher EBUSY 崩溃

**症状**：`npm run dev` 崩溃，日志：
`Error: EBUSY: resource busy or locked, watch '...\.NavBar.vue.<pid>.<uuid>.tmpdir\...'`

**原因**：编辑器（本 DSH 环境）原子写文件时产生临时目录，Vite watcher 尝试 watch 它，Windows 报 EBUSY。

**修复**：已在 `electron.vite.config.ts` 的 `server.watch.ignored` 配置忽略 `\.<name>.<pid>.<uuid>.tmpdir` 模式。若再次出现：删残留 tmpdir 后重启 dev：

```powershell
Get-ChildItem src -Recurse -Force -Filter "*.tmpdir" -Directory | Remove-Item -Recurse -Force
```

## 7. 扩展收集到但未激活（激活 0）

**症状**：日志 `[host] 启动完成: 1 个扩展（1 启用 / 0 禁用），激活 0`。

**原因**：入口未导出 `default` 插件函数，或入口加载/执行抛错。

**排查**：

- 入口必须有 `export default function(api) {...}`
- 扩展管理器详情页看 `activationError`（激活失败原因）
- dev 日志看 `[host] activate <id> failed <error>`

## 8. 命令面板命令不出现

- `palette: false` 的命令被过滤（设计如此，内部命令用）
- 命令未通过校验（缺 `command`/`title`）→ 详情页看校验信息
- 命令 id 重复 → 宿主 `console.warn('[registry] duplicate command id')`，保留第一个

## 9. 导航项点击内容栏空白

- `view` 字段引用的组件未在入口具名导出 → 宿主 warning `导航项 X 声明的视图组件 Y 未在扩展入口导出`
- 组件导出名与 `view` 值不一致（大小写敏感）
- 扩展未激活（见 #7）

## 10. 注册了未声明命令的 warning

**症状**：`[host] <id> 注册了未声明的命令 <cmd>（manifest contributes.commands 未包含）`

**原因**：`api.registerCommand(id, handler)` 的命令 id 不在该扩展 manifest `contributes.commands`。

**修复**：把命令加进 manifest 的 `commands` 数组（声明式模型——命令必须先声明，再绑定实现）。

## 11. 依赖环

**症状**：`[host] 启动完成: ... 依赖环 a,b`（host 日志标注）。

**原因**：`extensionDependencies` 成环。

**修复**：打破环（移除其中一个依赖），环内扩展会被跳过激活。

## 12. App 子窗口标题序号不对

`multiOpen: true` 时标题应为 `name 2`、`name 3`…。若序号重复，说明主进程 `appWindows` 跟踪残留——重启应用（跟踪随主进程重置）。

## 13. 扩展管理器显示"清单无效"

- `name`/`version`/`main` 缺失或格式错（校验规则见 `references/manifest-reference.md`）
- 详情页"校验信息"列出具体错误；修复后重启应用重新扫描

## 14. HMR 后重复注册/状态残留

**原因**：热重载时扩展模块重新激活，旧注册未清理。

**修复**：确保插件函数返回 cleanup（dispose 全部注册），或所有注册的 Disposable 有效。必要时候选重启应用（dev 下 F5/重开窗口）。

## 15. 用户扩展加载失败

**症状**：`[loader] 用户扩展 <id> manifest 读取失败或缺失`。

**原因**：`userData/extensions/<id>/` 下没有 manifest.json，或 manifest 校验失败（含 error 直接跳过）。

**修复**：确认目录结构与 manifest 合法；用户扩展入口按 `manifest.main` 经 `app://extensions/<id>/<main>` 加载。

## 16. App 应用里出现重复/残留卡片

**症状**：App 视图里同一插件出现多张卡片，或卸载扩展后卡片仍在。

**原因**（历史 bug，已修复）：`appStore` 的 index Map 未从 localStorage 持久化重建，导致同 id 重复注册不更新而 push 新条目；已卸载扩展的卡片（孤儿）在持久化中残留。

**修复（宿主侧已实现）**：

- `appStore` 构造函数从持久化重建 index，同 id 重复注册只更新不新建
- `loadPersisted` 去重（同 id 只保留一条）
- 宿主启动时清理孤儿卡片：`appStore.items` 中 `extensionId` 不在当前扩展列表的卡片被删除
- 卸载/停用路径调用 `appStore.deactivateExtension(id)` 清理全部匹配卡片

**扩展侧注意事项**：`api.app.register` 的 `id` 必须是稳定的唯一值（如 `todo.main`）；热重载/覆盖安装时宿主保证不产生重复卡片。

## 17. --debug-extension 调试扩展没被加载

**排查**：

- 参数格式：`--debug-extension <id>@<绝对路径>`，路径必须存在、id 须匹配 `^[a-z0-9][a-z0-9._-]*$`（非法/路径缺失会被主进程静默忽略并打 warn）
- manifest 必须能经 `app://debug/<id>/manifest.json` 读到（协议只服务已声明的 id）
- 看宿主日志 `[host] 启动完成: N 个扩展...` 是否包含调试扩展；激活失败看扩展管理器详情页 `activationError`（调试扩展同样受声明式贡献点校验）

## 18. VS Code 断点不命中（app://debug）

**排查**：

- launch.json 的 `pathMapping` 前缀必须与 `app://debug/<id>/` 完全一致（id 大小写、目录尾斜杠）；改代码后需**重载 obox 窗口**（宿主在启动时收集扩展）
- `urlFilter` 只匹配 dev 渲染进程（http://localhost:5173）；打包版（file://）去掉 urlFilter 或改匹配
- 确认 attach 的是渲染进程（chrome attach + CDP 端口），不是主进程 inspector

## 19. 调试扩展也出现在 userData / 可被卸载

**原因**：混淆了安装态。调试扩展（`--debug-extension`）**不会**写 userData/extensions；若扩展管理器里出现可卸载项，那是以前 .oix 安装的同名扩展——先卸载安装态，再用调试参数加载。

## 20. manifest 里写 uninstall 卸载钩子不生效

**症状**：manifest 声明 `"uninstall": "./scripts/clean.js"` 后卸载扩展，脚本从未执行，也没有任何报错。

**原因**：`uninstall` 字段是**保留字段，当前未实现**——主进程卸载流程只找扩展目录下的**固定文件 `.uninstall.cjs`**（`src/main/capabilities.ts`），全仓库没有代码读取 `manifest.uninstall`。写了不会报错，只是静默失效。

**修复（扩展侧）**：把钩子命名为扩展根目录下的 **`.uninstall.cjs`**（CommonJS，由 `spawn(process.execPath, [hookPath])` 直接执行，5 秒超时后强杀；失败不影响删除目录）。钩子内可用 `process.env` 等，但**拿不到**扩展目录参数，需要路径时用 `__dirname`。

## 21. sqlite 用嵌套相对路径在 Windows 报"数据库未打开"

**症状**：`api.sqlite.open('sub/a.db')` 返回 `{ok:true}`（看似成功），随后 `query/insert` 等操作报"数据库未打开"（`requireHandle` 抛错）。仅 Windows 复现，Linux/macOS 正常。

**原因**（宿主 bug，已修复）：`sqlite:open` 曾以**规范化后的路径**（Windows 上是 `sub\a.db`）为句柄 key，而其余操作以**调用方传入的原始路径**（`sub/a.db`）查找，两者不匹配。

**扩展侧注意事项**：升级到包含该修复的版本后，`open('sub/a.db')` 与后续操作传**同一个字符串**即可正常使用；若仍异常，确认 open 与后续调用传入的 name 完全一致（不要一处写 `sub/a.db`、另一处写 `sub\a.db`）。

## 22. window.eval / window.capture 在生产构建不可用

**症状**：用 `window.api.eval(...)` 或 `window.api.capture(...)` 做 UI 验证时，开发模式正常，**打包后报"没有注册处理器"**（`No handler registered for 'window:eval'`）。

**原因**：这两个能力是**开发辅助**（渲染进程任意 JS 执行 + 截图写任意路径），只在开发构建（`is.dev`，即未打包）注册到主进程；打包构建**不注册**，属于有意的安全门控。

**建议**：不要在扩展里依赖它们；需要截图/自检请在 `npm run dev` 下做，或改用正式的 `api.output` / `api.fs` 等能力。

## 23. 代理（设置-网络）配了却"没走代理"

**症状**：设置-网络里填了代理并启用，但 `api.net.fetch` 与更新检查/下载看起来仍**直连**（代理服务器上没有请求日志；或内外网混合环境下请求照旧成功/照旧失败）。

**原因**（宿主早期实现缺陷，已修复）：代理原先靠**环境变量**（`HTTP_PROXY`/`HTTPS_PROXY`/`NODE_TLS_REJECT_UNAUTHORIZED`）应用，但 Node 的全局 `fetch`（undici）与 Electron `net.request`（Chromium）**都不读这些变量**——实测把 `HTTP_PROXY` 指向不可达代理，`fetch` 仍直连成功。`ignoreSSL` 同理无效，且 `NODE_TLS_REJECT_UNAUTHORIZED=0` 会**全局**关闭证书校验（含更新下载），风险面过大。

**修复后机制**：宿主在请求真正经过的 session 上应用配置——

- 扩展联网：专用 session `obox-net` + `setProxy` / `setCertificateVerifyProc`
- 更新下载：electron-updater 自己的 session（`electron-updater`）+ 同一套应用逻辑；代理认证经 `autoUpdater.on('login')` 回填设置里的账号密码

**扩展侧注意事项**：不要自己读写代理环境变量——用 `api.proxy.get()` 读取配置，联网统一走 `api.net.fetch`（宿主自动应用）；`ignoreSSL` 现只作用于上述 session，不再是进程级全局开关。

## 24. 安装 .oix 失败：怎么判断是包的问题还是路径的问题

**症状**：扩展管理器提示"安装失败：…"，但看不到具体原因分类；或覆盖安装失败后担心旧版本被删。

**先明确两点**（宿主侧已实现）：

- **失败不会丢旧版本**：安装先解到暂存目录（`userData/extensions/.tmp`），全部校验通过后才整体替换目标目录；覆盖安装时旧目录先改名备份，替换失败会改回。
- **失败以返回值 + 错误码表达**（不再靠 IPC 抛错传消息），可按错误码排查：

| code               | 含义与排查方向                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `invalid-package`  | 文件不是有效 zip / 读取失败——确认打包产物没被截断，`.oix` 就是 zip（可用 `tar -tf x.oix` 或解压工具验证）          |
| `invalid-manifest` | 缺**根目录** `manifest.json`，或 `name`/`version`/`main` 非法——常见是打包时把文件放进了子目录（必须扁平在 zip 根） |
| `entry-missing`    | `manifest.main` 写的路径在包内不存在——注意 `./index.js` 与 `index.js` 的差别，以及是否漏打包入口                   |
| `entry-invalid`    | 包内含非法条目路径（`../`、绝对路径、反斜杠、空段）——属 zip-slip 防护，换工具重新打包                              |
| `too-large`        | 条目数 > 2000 或解压总量 > 64MB——检查是否误把 `node_modules/`、`dist/` 全打进包了                                  |
| `path-invalid`     | 传入路径为空或文件不存在（拖拽场景取到的是空路径）                                                                 |
| `write-failed`     | 暂存/替换/写盘失败（磁盘满、权限、目录被占用）——旧版本已回滚                                                       |

**扩展侧注意事项**：打包时只放分发必需文件（`manifest.json`、入口 `index.js`、图标与静态资源），不要把源码、`node_modules/`、构建缓存打进 `.oix`——既是限额要求，也能避免把 `main` 之外的路径写错。

## 25. 热安装带 extensionDependencies 的扩展后，跨扩展命令调用失败

**症状**：扩展 A 声明 `extensionDependencies: ["B"]`。冷启动（`npm run dev` 重启）一切正常；但经 .oix **热安装 A** 后，A 调用 `api.executeCommand('B.do')` 报"命令不存在"，B 看起来也没激活。

**原因**（宿主 bug，已修复）：冷启动阶段二会对全量扩展做**拓扑排序**后激活，而热安装路径直接激活目标扩展、忽略 `extensionDependencies`——依赖 B 从未被激活（若 B 此前未被任何入口激活过）。

**修复后行为**：热安装会先按 `extensionDependencies` 顺序（DFS 后序）激活依赖，再激活自身；依赖**不存在 / 已禁用 / 清单无效 / 无加载器**时只打 warn 不阻塞（与冷启动语义一致）；依赖环由已访问集合兜底，不会无限递归。

**扩展侧注意事项**：声明依赖后仍需对"依赖缺失"做兜底（宿主不阻塞），例如命令调用前 `try/catch` 或用 `api.on/emit` 做就绪通知。

## 26. 扩展激活失败后，副作用残留（事件监听还在、设置页/卡片仍在）

**症状**：扩展 `apply(api)` 中途抛错 → 扩展管理器显示激活失败（`activationError`），但它的部分注册仍生效（如状态栏项被更新、设置页仍出现、事件监听仍在响应、App 卡片仍在）。

**原因**（宿主 bug，已修复）：仅在**成功**分支保存清理函数，失败路径已收集的 disposables 未清理。

**修复后行为**：激活抛错时立即清理本次已收集的全部副作用，并把清理函数登记进宿主（后续热移除/重启时同样可用）。

**扩展侧注意事项**：仍应自己保证注册顺序合理——把"可能抛错"的初始化逻辑放在注册副作用**之前**（`apply` 内先校验配置/依赖，再注册）。

## 27. 想重装同一版本或回退到旧版本，但"检查更新"说无更新

**症状**：安装损坏想重装，或想从新版回退到旧版，但 `api.update.check()` 总是返回"无更新"；`install()` 也无从下手。

**原因**（electron-updater 的既有语义，不是 bug）：默认 `allowDowngrade = false`，且远端版本与本地**相等**时按 semver 直接判定"无更新"——`check` 与 `download`/`install` 这条链路因此**无法完成同版本重装与降级**。

**修复（宿主已提供强制通道）**：用 `api.update.install({ force: true, feedUrl })`：

- 宿主**直接**从更新源读 `latest.yml` → 按本机架构挑安装包 → 流式下载 → 校验 sha512 → 启动安装向导（NSIS 向导式，应用不退出，由用户完成安装）；
- 因此**不受版本门控限制**：同版本重装（修复损坏安装）与降级（回退到旧版）都能做；
- 进度仍经 `api.update.onEvent` 的 `download-progress` 透出；完成后会发一次 `update-downloaded`；
- `feedUrl` 省略时回落到提供者 manifest 的 `contributes.updater.feedUrl`；
- 下载失败或 sha512 不匹配时**不会启动安装器**（不匹配的文件会被删除），返回 `{ ok:false, error }`。

**扩展侧注意事项**：`force` 会真的启动安装程序，建议放在显式命令（如命令面板项）里，由用户主动触发；不要放在自动检查流程里。

## 28. `api.ipc` 连不上对端 / 请求超时 / 通道莫名关闭

**症状**：`api.ipc.connect()` 抛 `connect-failed`，或连上后 `request()` 报 `timeout`，或对端一启动就 `peer-crashed`。

**按错误码逐条排查**：

| 错误码                | 常见原因与处理                                                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-declaration` | `program` 不是**扩展目录内的相对路径**（绝对路径/盘符/`..` 都会被拒）；`pipe` 声明里不要写 `program`；传了 `tcp`/`http` 之类传输（本能力**只用 stdio 或 pipe，不含端口**）                                                                                                                                     |
| `connect-failed`      | stdio：程序不存在/不可执行（Windows 上**不能直接执行 `.cjs` 文本文件**——用 `.js/.cjs/.mjs` 由宿主 Node 运行，或编译成可执行文件）；pipe：对端没在监听，或端点名不一致（端点由宿主按 **扩展 id + 通道名** 推导：Windows `\\.\pipe\obox-<扩展id>-<通道名>`，POSIX `<userData>/ipc/obox-<扩展id>-<通道名>.sock`） |
| `timeout`             | 对端没回包：检查它的分帧是否与声明一致（默认 `Content-Length: <n>\r\n\r\n`，不是换行分隔——除非你声明了 `framing: 'ndjson'`）；慢任务请在 `request(..., { timeoutMs })` 里放宽                                                                                                                                  |
| `protocol-error`      | 分帧或 JSON-RPC 形状不对（对端把日志打到 stdout 也会触发——**日志请写 stderr**）；缺 `jsonrpc: "2.0"`                                                                                                                                                                                                           |
| `message-too-large`   | 单条消息超过 8MB：拆成多条或用通知流式发送                                                                                                                                                                                                                                                                     |
| `peer-crashed`        | 对端进程退出/连接被关闭：stdio 场景下对端崩溃即断连（宿主不自动重连，需扩展自行 `connect()` 重建）；先看 `api.ipc.onStderr()` 收到的对端日志                                                                                                                                                                   |
| `not-connected`       | 通道没打开或已关闭；`close()` 后要重新 `connect()`                                                                                                                                                                                                                                                             |

**平台细节**：Windows 命名管道**不留文件**（内核命名空间）；POSIX 的 `.sock` 在进程崩溃后会残留，需由**服务端**在 listen 前清理——客户端（本能力）只负责连接，不会替你删除别人的套接字文件。

**调试建议**：先用 `api.ipc.onStderr()` 打印对端日志；对端可先用最简单的"回声"实现（读一行、回一行）验证分帧，再接入真实逻辑。
