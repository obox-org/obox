# Troubleshooting

> **本文件是 obox 扩展开发排错的唯一真相，位置 `docs/extension-api/`**：仓库内其它文档一律引用本文件，不复制副本。

Obox 扩展开发中遇到的常见问题与修复。**遇到新坑后，把解法追加到这里（保持持续更新）。**

## 1. iframe 内联脚本不生效（CSP 阻止）

**症状**：App 子窗口的 iframe 里内联 `onclick="..."` 点击无反应；srcdoc 内联 `<script>` 块也不执行。dev 日志：
`Executing inline event handler violates the following Content Security Policy directive 'script-src 'self''`
或 `Refused to execute inline script ... 'script-src 'self''`。

**原因**：渲染进程 CSP 是 `script-src 'self' app:`、**没有 `'unsafe-inline'`**（`src/renderer/index.html:8-11`），所以内联事件处理器与内联 `<script>` 块都被拦截；srcdoc 继承父文档 CSP，同样受限。注意同一份 CSP 的 `style-src` **有** `'unsafe-inline'`——**内联样式是允许的**，别把样式问题误判成 CSP。

**修复**（按场景）：

- **用户扩展静态页（推荐）**：App 卡片用 `url: 'app://extensions/<id>/todo.html'`——app:// 页面无 CSP 头，脚本正常执行（CSP 已放行 app: scheme 供 iframe 加载）
- **srcdoc 场景**：脚本必须用**绝对 `app://extensions/<id>/x.js`** 引入（`script-src` 放行了 `app:`；srcdoc 里的相对路径按父文档 URL 解析，取不到扩展目录）——该写法**未实机验证**，能用 `url` 形态就别用 srcdoc
- 窗口控制一律用 `parent.postMessage({source:'obox-app', action:'close'|'minimize'|'maximize'}, '*')`

**主题下发不受 CSP 影响**：它是 `postMessage`，不是脚本/样式注入。因此**不要**为了让主题生效去放宽 CSP 或往 iframe 里注入内联 `<style>`——跨源 iframe 里根本做不到（详见第 29 条）。

## 2. App 子窗口 iframe 加载 app:// 404 或空白

**症状**：`url: 'app://extensions/<id>/todo.html'` 打不开 / 404；控制台 `Failed to load resource`。

**排查**：

- **内置扩展？**`app://builtin/<id>/<rest>` → `resources/extensions/<id>/<rest>` 这条通道**虽已注册**（`src/main/protocol.ts:14,47`）却**没有任何构建步骤填充**该目录（`electron-builder.yml` 无 `extraResources`；内置扩展由 Vite 的 `import.meta.glob` 静态收集，`src/renderer/src/core/loader.ts:15-17`）→ 打包版与开发版都取不到文件。内置扩展别指望这条通道，App 卡片走 `html`/srcdoc，并受 #1 的 CSP 限制
- **用户扩展？**确认它已装到 `userData/extensions/<id>/`——`app://extensions` 只映射 userData（`src/main/protocol.ts:46`）
- `<id>` 是**安装目录名**（`<name>_<author>`，如 `todo_chenzhi`），不是 manifest.name；`index.js` 里用 `new URL('./todo.html', import.meta.url)` 推导，勿硬编码
- 协议映射：`app://extensions/<id>/<rest>` → `userData/extensions/<id>/<rest>`（协议注册在 `src/main/protocol.ts`）

## 3. iframe 里 alert/confirm/prompt 无效

**原因**：iframe sandbox 无 `allow-modals`。
**修复**：交互全部用页面内 UI（行内确认、自定义输入），不依赖浏览器弹窗。

> **overlay 窗体（`api.overlay.create`）同款**：它复用同一份外壳 `AppWindow.vue`，sandbox 属性逐字相同，因此 overlay 页面里 `alert` / `confirm` / `prompt` 也一律无效；overlay 还额外**不渲染** `PromptHost`，宿主 `api.ui` 模态框也不会在 overlay 上出现。详见第 36 条。

## 4. oix 安装失败

**排查**（扩展管理器提示的失败信息）：

- `manifest.json` 必须在 zip **根目录**
- `name`/`version` 非法（正则 / semver）；`main` 指向的文件必须在包内
- 包内含非法条目路径（`..` / 绝对路径 / 反斜杠）→ 被 zip-slip 防护拒绝
- 安装成功但列表标红：manifest 校验失败或入口加载/激活失败（看详情页校验信息与 `activationError`）

## 5. Windows 下 Vite watcher EBUSY 崩溃

**症状**：`npm run dev` 崩溃，日志：
`Error: EBUSY: resource busy or locked, watch '...\.NavBar.vue.<pid>.<uuid>.tmpdir\...'`

**原因**：编辑器（本 DSH 环境）原子写文件时产生临时目录，Vite watcher 尝试 watch 它，Windows 报 EBUSY。

**修复**：已在 `electron.vite.config.ts` 的 `server.watch.ignored` 配置忽略 `\.<name>.<pid>.<uuid>.tmpdir` 模式。若再次出现：删残留 tmpdir 后重启 dev：

```powershell
Get-ChildItem src -Recurse -Force -Filter "*.tmpdir" -Directory | Remove-Item -Recurse -Force
```

## 6. 扩展收集到但未激活（激活 0）

**症状**：启动日志 `[host] 启动完成: 1 个扩展（1 启用 / 0 禁用），激活 0，依赖环 无`（格式见 `src/renderer/src/core/host.ts:1024-1031`；末尾的"依赖环"是环内扩展 id 列表，正常为 `无`）。

**原因**：入口未导出 `default` 插件函数，或入口加载/执行抛错。

**排查**：

- 入口必须有 `export default function(api) {...}`
- **宿主模式 + 清单写了 `onCommand` / `onView`**：启动时**本来就不会激活**（"激活 0"是正常的），要等命令被执行 / 视图被点开；见 #38
- 扩展管理器详情页看 `activationError`（激活失败原因）
- dev 日志看 `[host] activate <id> failed <error>`

## 7. 命令面板命令不出现

- `palette: false` 的命令被过滤（设计如此，内部命令用；过滤规则 `src/renderer/src/core/registry.ts:269`）
- 命令未通过校验（缺 `command`/`title`）→ 详情页看校验信息
- 命令 id 重复 → 宿主 `console.warn('[registry] duplicate command id')`，保留第一个；冲突也会写进**后注册方**扩展的 `validations`（warning，详情页可见，`src/renderer/src/core/registry.ts:129-137`）

## 8. 导航项点击内容栏空白

- `view` 字段引用的组件未在入口具名导出 → 宿主 warning `导航项 X 声明的视图组件 Y 未在扩展入口导出`（`src/renderer/src/core/host.ts:249-255`）
- 组件导出名与 `view` 值不一致（大小写敏感）
- 扩展未激活（见 #6）

## 9. 注册了未声明的命令：先 warning，紧接着抛错标红

**症状**：日志先出现 `[host] <id> 注册了未声明的命令 <cmd>（manifest contributes.commands 未包含）`（`src/renderer/src/core/host.ts:313-317`），紧接着 `[host] activate <id> failed Error: command not declared: <cmd>`，扩展在管理器标红 `activationError`。

**原因**：`api.registerCommand(id, handler)` 的命令 id 不在该扩展 manifest `contributes.commands`。warning 之后 `registry.setCommandHandler` 找不到已声明项会**直接 throw**（`src/renderer/src/core/registry.ts:203`）→ `plugin(api)` 抛错、本次激活失败。**这不是"只打一条 warning"**。

**修复**：把命令加进 manifest 的 `contributes.commands`（声明式模型——命令必须先声明，再绑定实现）。

## 10. 依赖环

**症状**：启动日志末尾 `[host] 启动完成: N 个扩展（X 启用 / Y 禁用），激活 Z，依赖环 a,b`（`src/renderer/src/core/host.ts:1024-1031`）。

**原因**：`extensionDependencies` 成环。

**行为**：环内扩展**不会被跳过**——拓扑排序仍把它们放进激活序列（`src/renderer/src/core/manifest.ts:195-200`），宿主照常激活（`src/renderer/src/core/host.ts:1013-1022`），只是排到最后。所以"没激活"要先查 #6 的其它原因，别被这一行误导。

**修复**：打破环（移除其中一个依赖），让依赖顺序可确定。

## 11. 扩展管理器显示"清单无效"

- `name`/`version`/`main` 缺失或格式错（校验规则见 [manifest-reference.md](manifest-reference.md)）
- `activationEvents` 里有认不出的事件、或 `onCommand:` / `onView:` 没写 id（见 #39）
- 详情页"校验信息"列出具体错误；修复后重启应用重新扫描

## 12. 用户扩展加载失败

**症状**：`[loader] 用户扩展 <id> manifest 读取失败或缺失`。

**原因**：`userData/extensions/<id>/` 下没有 manifest.json，或 manifest 校验失败（含 error 直接跳过）。

**修复**：确认目录结构与 manifest 合法；用户扩展入口按 `manifest.main` 经 `app://extensions/<id>/<main>` 加载（`src/renderer/src/core/loader.ts:104-122`）。

## 13. App 应用里出现重复/残留卡片

**结论**（宿主侧已修复，扩展不需要为此写兼容代码）：`appStore` 从 localStorage 恢复时按 id 去重并重建索引（`src/renderer/src/core/appStore.ts:20-50`），同 id 重复注册只更新不新建（`:61-74`），停用/卸载按 `extensionId` 清空其全部卡片（`:92-102`），启动时清理"扩展已不在"的孤儿卡片（`src/renderer/src/core/host.ts:943-949`）。

**扩展侧注意事项**：`api.app.register` 的 `id` 必须是稳定的唯一值（如 `todo.main`）；热重载/覆盖安装时宿主保证不产生重复卡片。

## 14. --debug-extension 调试扩展没被加载

**排查**：

- **先看这一行**：主进程启动时会打印 `[debug] 调试扩展 N 个: id@路径`；若打印的是
  `[debug] 未提供 --debug-extension（仅加载内置/已安装扩展）`，说明**参数没传进来**（不是清单或入口的问题）。
  开发版（`npm run dev`）**必须写两个 `--`**——第一个交给 npm，第二个才是 electron-vite 的 `--`：
  `npm run dev -- -- --debug-extension <id>@<绝对路径>`（打包版直接 `obox.exe --debug-extension <id>@<路径>`，没有 npm 这一层）。
  依据：electron-vite 只把 `--` **之后**的参数序列化成 `ELECTRON_CLI_ARGS`
  （`node_modules/electron-vite/dist/cli.js:58-60`），启动 Electron 时再读回
  （`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:224`）；只写一个 `--`
  （`npm run dev -- --debug-extension ...`）时参数会被 electron-vite 自己的选项解析吃掉，`options['--']` 为空、不会传给 Electron。
  **旧文档/网上示例里的单 `--` 写法必然失败，别照抄**（本仓库早期验收步骤里出现过，实测同样失败）
- 参数格式：`--debug-extension <id>@<路径>`；id 须匹配 `^[a-z0-9][a-z0-9._-]*$/i`（**不区分大小写**，`src/main/debug.ts:12`）；路径**可相对**（宿主按主进程 cwd `resolve`，`src/main/debug.ts:32`），解析后必须存在，否则该条被忽略并打 warn
- manifest 必须能经 `app://debug/<id>/manifest.json` 读到（协议只服务已声明的 id，`src/main/protocol.ts:48-58`）
- 看宿主日志 `[host] 启动完成: N 个扩展（X 启用 / Y 禁用），激活 Z，依赖环 …` 的**计数**是否把调试扩展算进去（该行只给数量、不列 id；id 与路径看 `[debug] 调试扩展 N 个: …`）；激活失败看扩展管理器详情页 `activationError`（调试扩展同样受声明式贡献点校验）
- 调试扩展**不做 .oix 安装**，文件就在参数给的目录里，所以 `api.ipc` 的 stdio 对端 cwd 是**调试目录/data**（见 #25）；`api.fs` / sqlite / python 的数据目录仍按 `userData/extensions/<id>/data` 走（`src/main/fs.ts:12-14`、`src/main/python.ts:34-36`）。该目录没有 `manifest.json`，主进程会打 `[capabilities] 跳过没有 manifest.json 的目录: <id>（扩展数据目录或调试扩展）`，属正常提示（`src/main/capabilities.ts:47`）

## 15. VS Code 断点不命中（app://debug）

**先按仓库自带的 `.vscode/launch.json` 核对调试链路**（这是本仓库唯一可核实的配置）：

- 用 compound **`Debug All`**：`Debug Main Process`（由 electron-vite 启动，`env` 里设 `REMOTE_DEBUGGING_PORT=9222`，`.vscode/launch.json:14-16`）+ `Debug Renderer Process`（`type: chrome` + `request: attach` + `port: 9222`，`.vscode/launch.json:18-28`）
- **CDP 端口是怎么来的**：`npm run dev` 就是 `electron-vite dev`（`package.json:19`），**它自己不开**调试端口；electron-vite 在 dev 下读环境变量 `REMOTE_DEBUGGING_PORT` 并给 Electron 追加 `--remote-debugging-port=<port>`（`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:225-226`，仅 `isDev` 生效；也可用 `electron-vite dev --remoteDebuggingPort 9222`，`node_modules/electron-vite/dist/cli.js:42,46-48`）。因此"断点完全不命中 / 附加失败"的**第一嫌疑是没有这个端口**：确认 9222 在监听（`netstat -ano | findstr 9222`），没有就补上环境变量或命令行参数
- attach 的是**渲染进程**（chrome 协议），不是主进程 inspector；`webRoot` 指 `${workspaceFolder}/src/renderer`
- 改扩展代码后需**重载 obox 窗口**：宿主只在窗口启动时收集并 import 扩展入口（`src/renderer/src/core/host.ts:986-1000`），`app://` 动态 import 的模块缓存不会自动失效
- 断点落在"无源码"位置时，先回看启动日志 `[debug] 调试扩展 N 个: id@路径`（`src/main/debug.ts`）确认加载的确实是 `--debug-extension` 给的目录；调试扩展经 `app://debug/<id>/` 加载（`src/main/protocol.ts:48-58`），打包版（`file://`）没有这条 dev 链路、也没有可 attach 的端口

> `references/guides-user.md` 里那份给**扩展自己仓库**用的 `.vscode/launch.json` 模板（`args` 写死 `--remote-debugging-port=9333`，并带 `pathMapping` / `urlFilter`，见该文 :190-215，`pathMapping` 说法在 :217）**未实机验证**——照抄前先按上面对齐本仓库自带配置。其中 `urlFilter` 依赖 electron-vite dev 端口，而仓库**未固定 `server.port`**（`electron.vite.config.ts:15-20`），端口被占用时 Vite 会顺延换端口，写死端口的 `urlFilter` 会失配。

## 16. 调试扩展也出现在 userData / 可被卸载

**原因**：混淆了"安装态"与"数据目录"。调试扩展（`--debug-extension`）**不做安装**——不写 manifest 到 userData、无安装登记、重启即消失。

**userData 下为什么还会有同名目录**：`api.fs` / sqlite / python 的数据目录固定按 `userData/extensions/<id>/data` 建（`src/main/fs.ts:12-14`、`src/main/sqlite.ts:34-37`、`src/main/python.ts:34-36`），调试扩展也照此写盘。这类只有 `data/`、没有 `manifest.json` 的目录不会被当成扩展加载（主进程按有无 manifest 过滤，`src/main/capabilities.ts:38-51`）。

**若管理器里出现可卸载项**：那是以前用同名 id 做的 .oix 安装态——先卸载安装态，再用调试参数加载。管理器里的调试扩展本身来源是 `debug`，调卸载会直接抛"调试扩展不占用安装态，无需卸载"（`src/renderer/src/core/host.ts:1199`）。

## 17. 生命周期钩子（install/uninstall）怎么写才生效

**症状**：在 manifest 里声明 `"uninstall": "./scripts/clean.js"`，卸载后脚本从未执行，也没有任何报错。

**原因**：`manifest.uninstall` **不是**钩子机制——宿主从不读取它，写了静默失效。钩子是扩展**入口的具名导出**：

```js
// 扩展入口（manifest.main 指向的文件）
export function install(ctx) {
  /* .oix 安装完成后立刻执行一次；覆盖安装会重跑，ctx.upgraded === true */
}
export function uninstall(ctx) {
  /* 删除目录之前执行 */
}
```

- `ctx` 形如 `{ extensionId, upgraded, previousVersion }`，并含 `api`（完整能力面；**钩子期 UI 注册类能力不生效**）。
- 两个函数**都可选、可为空**：不需要额外操作就不写（未导出即跳过，不报错）。

**失败语义**：`install` 抛错 → 扩展在管理器标红（`activationError`），文件层不回滚；`uninstall` 抛错 → 只告警，**仍然删除目录**（否则写错的钩子会让扩展永远删不掉）。

**兼容**：旧的固定文件 **`.uninstall.cjs`**（`spawn(process.execPath, [hookPath])`，5 秒超时）仍作为**回退**——触发条件是入口钩子"没送达到 / 被跳过"（`delivered && !deferred && !skipped` 不成立，`src/main/capabilities.ts:102-112`）：入口未导出 `uninstall`、扩展当时未加载到宿主、渲染进程不可用都会走它，不只是"入口没导出"这一种。

**仍不会执行的几种情况**：入口没导出 `uninstall` 且没有 `.uninstall.cjs`；或卸载时主窗口不可用（此时走回退路径，同样不报错）。安装时若宿主还没加载到该扩展（窗口不可用/刚装完还没扫描到），钩子会**留待下次启动、激活之前补跑一次**。

## 18. sqlite 用嵌套相对路径在 Windows 报"数据库未打开"

**症状**：`api.sqlite.open('sub/a.db')` 返回 `{ok:true}`（看似成功），随后 `query/insert` 等操作报"数据库未打开"（`requireHandle` 抛错）。仅 Windows 复现，Linux/macOS 正常。

**原因**（宿主 bug，已修复）：`sqlite:open` 曾以**规范化后的路径**（Windows 上是 `sub\a.db`）为句柄 key，而其余操作以**调用方传入的原始路径**（`sub/a.db`）查找，两者不匹配。

**扩展侧注意事项**：升级到包含该修复的版本后，`open('sub/a.db')` 与后续操作传**同一个字符串**即可正常使用；若仍异常，确认 open 与后续调用传入的 name 完全一致（不要一处写 `sub/a.db`、另一处写 `sub\a.db`）。

## 19. window.eval / window.capture 在生产构建不可用

**症状**：用 `window.api.eval(...)` 或 `window.api.capture(...)` 做 UI 验证时，开发模式正常，**打包后报"没有注册处理器"**（`No handler registered for 'window:eval'`）。

**原因**：这两个能力是**开发辅助**（渲染进程任意 JS 执行 + 截图写任意路径），只在开发构建（`is.dev`，即未打包）注册到主进程；打包构建**不注册**，属于有意的安全门控。

**建议**：不要在扩展里依赖它们；需要截图/自检请在 `npm run dev` 下做，或改用正式的 `api.output` / `api.fs` 等能力。

## 20. 代理（设置-网络）配了却"没走代理"

**症状**：设置-网络里填了代理并启用，但 `api.net.fetch` 与更新检查/下载看起来仍**直连**（代理服务器上没有请求日志；或内外网混合环境下请求照旧成功/照旧失败）。

**先看地址写法**（1.0.12 起设置-网络只有一个**代理地址 URL** 输入框，见下）：需要带协议的完整地址（`http://127.0.0.1:7890`、`https://proxy:8443`、`socks5://127.0.0.1:1080`，可含 `user:pass@`），空串 = 直连。地址非法（缺协议、协议不支持、带路径、端口越界）时宿主**回退直连**并在主进程日志写一行 `[proxy] 代理地址无法解析：…`——查日志即可确认。旧配置（≤1.0.11 的 host/port/用户名/密码）会在读取时自动迁移成 URL，不需要重填。

**原因**（宿主早期实现缺陷，已修复）：代理原先靠**环境变量**（`HTTP_PROXY`/`HTTPS_PROXY`/`NODE_TLS_REJECT_UNAUTHORIZED`）应用，但 Node 的全局 `fetch`（undici）与 Electron `net.request`（Chromium）**都不读这些变量**——实测把 `HTTP_PROXY` 指向不可达代理，`fetch` 仍直连成功。`ignoreSSL` 同理无效，且 `NODE_TLS_REJECT_UNAUTHORIZED=0` 会**全局**关闭证书校验（含更新下载），风险面过大。**注意**：宿主侧（用户扩展）的实现换成了 Node `http`/`https` 并**自己读**这些环境变量，所以它在"拿不到 main 的配置"时会作为**兜底**生效——但正常运行时设置-网络的值优先，不要靠环境变量配代理。

**修复后机制**：宿主在请求真正经过的那一层应用配置（`src/main/proxy.ts`）——

- 内置扩展联网：专用 session `obox-net` + `setProxy` / `setCertificateVerifyProc`
- 更新下载：electron-updater 自己的 session（`electron-updater`）+ 同一套应用逻辑；代理认证经 `autoUpdater.on('login')` 回填**代理 URL 里 `user:pass@` 的账号密码**（Chromium 的规则串不能携带凭据）
- **用户扩展（宿主模式）**：宿主进程没有 Chromium session，因此**在宿主内自行应用**（`src/extension-host/capabilities/io.ts`）——先向 main 要配置（内部 RPC `host.proxyConfig`），**读不到才回落环境变量**（`HTTPS_PROXY` > `HTTP_PROXY` > `ALL_PROXY`，另认 `NO_PROXY` / `NODE_TLS_REJECT_UNAUTHORIZED`，只 warn 一次）；请求经 Node `http`/`https` 发出：http 走代理的**绝对 URI**，https 走 **CONNECT 隧道** + `tls.connect({ rejectUnauthorized: !ignoreSSL })`

**扩展侧注意事项**：不要自己读写代理环境变量——用 `api.proxy.get()` 读取配置（`{ enabled, url, ignoreSSL?, noProxy? }`），联网统一走 `api.net.fetch`（**两条路径都会自动应用**）。`ignoreSSL` 现在只作用于这两条链路，不再是进程级全局开关。宿主侧的已知降级：`proxy.get()` 是 **1 秒 TTL 快照**、只支持 http/https 代理（socks 会明确报错）、`noProxy` 不支持 CIDR（详见 [api-reference.md](api-reference.md) 的 `proxy` 一节）。

## 21. 安装 .oix 失败：怎么判断是包的问题还是路径的问题

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
| `forbidden-entry`  | 包内含 `data/`（扩展运行时数据目录，升级时由宿主保留）——打包时排除它，见 #28                                       |
| `too-large`        | 条目数 > 10000 或解压总量 > 512MB——检查是否误把 `node_modules/`、`dist/` 全打进包了                                |
| `arch-mismatch`    | 声明的 `arch` 与当前设备不符（如 arm64 包在 x64 机器上装）——换对应架构的包；这是**安装期**校验，不会留下半安装目录 |
| `path-invalid`     | 传入路径为空或文件不存在（拖拽场景取到的是空路径）                                                                 |
| `write-failed`     | 暂存/替换/写盘失败（磁盘满、权限、目录被占用）——旧版本已回滚                                                       |

**扩展侧注意事项**：打包时只放分发必需文件（`manifest.json`、入口 `index.js`、图标与静态资源），不要把源码、`node_modules/`、构建缓存打进 `.oix`——既是限额要求，也能避免把 `main` 之外的路径写错。

## 22. 热安装带 extensionDependencies 的扩展后，跨扩展命令调用失败

**症状**：扩展 A 声明 `extensionDependencies: ["B"]`。冷启动（`npm run dev` 重启）一切正常；但经 .oix **热安装 A** 后，A 调用 `api.executeCommand('B.do')` 报"命令不存在"，B 看起来也没激活。

**原因**（宿主 bug，已修复）：冷启动阶段二会对全量扩展做**拓扑排序**后激活，而热安装路径直接激活目标扩展、忽略 `extensionDependencies`——依赖 B 从未被激活（若 B 此前未被任何入口激活过）。

**修复后行为**：热安装会先按 `extensionDependencies` 顺序（DFS 后序）激活依赖，再激活自身；依赖**不存在 / 已禁用 / 清单无效 / 无加载器**时只打 warn 不阻塞（与冷启动语义一致）；依赖环由已访问集合兜底，不会无限递归。

**扩展侧注意事项**：声明依赖后仍需对"依赖缺失"做兜底（宿主不阻塞），例如命令调用前 `try/catch` 或用 `api.on/emit` 做就绪通知。

## 23. 扩展激活失败后，副作用残留（事件监听还在、设置页/卡片仍在）

**症状**：扩展 `apply(api)` 中途抛错 → 扩展管理器显示激活失败（`activationError`），但它的部分注册仍生效（如状态栏项被更新、设置页仍出现、事件监听仍在响应、App 卡片仍在）。

**原因**（宿主 bug，已修复）：仅在**成功**分支保存清理函数，失败路径已收集的 disposables 未清理。

**修复后行为**：激活抛错时立即清理本次已收集的全部副作用，并把清理函数登记进宿主（后续热移除/重启时同样可用）。

**扩展侧注意事项**：仍应自己保证注册顺序合理——把"可能抛错"的初始化逻辑放在注册副作用**之前**（`apply` 内先校验配置/依赖，再注册）。

## 24. 想重装同一版本或回退到旧版本，但"检查更新"说无更新

**症状**：安装损坏想重装，或想从新版回退到旧版，但 `api.update.check()` 总是返回"无更新"；`install()` 也无从下手。

**原因**（electron-updater 的既有语义，不是 bug）：默认 `allowDowngrade = false`，且远端版本与本地**相等**时按 semver 直接判定"无更新"——`check` 与 `download`/`install` 这条链路因此**无法完成同版本重装与降级**。

**修复（宿主已提供强制通道）**：用 `api.update.install({ force: true, feedUrl })`：

- 宿主**直接**从更新源读 `latest.yml` → 按本机架构挑安装包 → 流式下载 → 校验 sha512 → 启动安装向导（NSIS 向导式，应用不退出，由用户完成安装）；
- 因此**不受版本门控限制**：同版本重装（修复损坏安装）与降级（回退到旧版）都能做；
- 进度仍经 `api.update.onEvent` 的 `download-progress` 透出；完成后会发一次 `update-downloaded`；
- `feedUrl` 省略时回落到提供者 manifest 的 `contributes.updater.feedUrl`；
- 下载失败或 sha512 不匹配时**不会启动安装器**（不匹配的文件会被删除），返回 `{ ok:false, error }`。

**扩展侧注意事项**：`force` 会真的启动安装程序，建议放在显式命令（如命令面板项）里，由用户主动触发；不要放在自动检查流程里。

## 25. `api.ipc` 连不上对端 / 请求超时 / 通道莫名关闭

**症状**：`api.ipc.connect()` 抛 `connect-failed`，或连上后 `request()` 报 `timeout`，或对端一启动就 `peer-crashed`。

**按错误码逐条排查**：

| 错误码                 | 常见原因与处理                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-declaration`  | `program` 不是**扩展目录内的相对路径**（绝对路径/盘符/`..` 都会被拒）；`pipe` 声明里不要写 `program`；传了 `tcp`/`http` 之类传输（本能力**只用 stdio 或 pipe，不含端口**）；**服务端专属**：`listen` 传了 `stdio`、server 名字下 `request`/`notify` 没给 `connectionId`、或反过来给 client 通道传了 `connectionId`（见下方「服务端专属排查」）                                                  |
| `connect-failed`       | stdio：程序不存在/不可执行（Windows 上**不能直接执行 `.cjs` 文本文件**——用 `.js/.cjs/.mjs` 由宿主 Node 运行，或编译成可执行文件）；pipe：对端没在监听，或端点名不一致（端点由宿主按 **扩展 id + 通道名** 推导：Windows `\\.\pipe\obox-<扩展id>-<通道名>`，POSIX `<userData>/ipc/obox-<扩展id>-<通道名>.sock`）；**服务端 `listen`**：端点已被占用（文案含"已被占用"，见下方「服务端专属排查」） |
| `timeout`              | 对端没回包：检查它的分帧是否与声明一致（默认 `Content-Length: <n>\r\n\r\n`，不是换行分隔——除非你声明了 `framing: 'ndjson'`）；慢任务请在 `request(..., { timeoutMs })` 里放宽                                                                                                                                                                                                                   |
| `protocol-error`       | 分帧或 JSON-RPC 形状不对（对端把日志打到 stdout 也会触发——**日志请写 stderr**）；缺 `jsonrpc: "2.0"`                                                                                                                                                                                                                                                                                            |
| `message-too-large`    | 单条消息超过 8MB：拆成多条或用通知流式发送                                                                                                                                                                                                                                                                                                                                                      |
| `too-many-connections` | **服务端专属**：该 server 已经有 **16 条**连接，第 17 条被拒（扩展侧**不触发**任何事件，只有**对端**能看到这条线上错误帧的 `[too-many-connections]` 前缀）。处理：断开不再用的对端，或让对端侧限流                                                                                                                                                                                              |
| `peer-crashed`         | 对端进程退出/连接被关闭：stdio 场景下对端崩溃即断连（**默认不自动重连**，需扩展自行 `connect()` 重建）；**pipe 通道**可声明 `autoReconnect` 让宿主自动重建（见下方「自动重连（`autoReconnect`）排查」）；先看 `api.ipc.onStderr()` 收到的对端日志                                                                                                                                               |
| `not-connected`        | 通道没打开或已关闭；`close()` 后要重新 `connect()`；**服务端专属**：`connectionId` 指向的连接**已断开或不存在**（连接 ID 永不复用，旧 ID 不会"复活"）                                                                                                                                                                                                                                           |

**平台细节**：Windows 命名管道**不留文件**（内核命名空间）；POSIX 的 `.sock` 在进程崩溃后会残留，需由**服务端**在 listen 前清理——客户端（`connect`）只负责连接，不会替你删除别人的套接字文件；而**服务端**（`listen`，issue #43）会**自己**处理：试连探测（连得上 = 有活着的服务端 → 报 `connect-failed` 且**不删**）+ 连不上才 `unlink` + `listen` 成功后 `chmod 0600`。

**服务端（`listen`）专属排查（issue #43）**：

- **`listen` 报 `connect-failed` 且文案含"已被占用"** → 端点被占着：POSIX 看 `<userData>/ipc/obox-<扩展id>-<通道名>.sock` 是否有**活着的**服务端（宿主**不会**删除活着的端点——删了会把别人的服务端打断）；Windows 看是否还有旧实例活着（命名管道随进程消失，但旧实例在就仍然占用）。
- **POSIX 的陈旧 `.sock`**：宿主在上一次被强杀后可能残留 `.sock`；宿主**下一次 `listen` 会自愈**（探测到没人应答就 unlink 后重新 listen），无需手工删文件。若手工确认过没人监听，也可以自行删除该文件。权限为 `0600`（`srw-------`），**由服务端设置**。
- **对端收到 `[too-many-connections]`**：该 server 已有 16 条连接（上限见 api-reference 的限额表）。扩展侧看不到这个错误（不触发 `onConnection`），需要自己通过 `onConnection`/`onDisconnect` 的计数判断是否长期满载。
- **`invalid-declaration` 的服务端原因**：`listen` 传了 `transport: 'stdio'`（服务端只能是 pipe）；server 名字下 `request`/`notify` **省略** `connectionId`（服务端没有"唯一对端"，宿主不会静默挑一条）；反过来给 **client 通道**传 `connectionId` 同样报错。
- **不要在清单里写 `mode`**：`contributes.ipcChannels` 的声明面没有"角色"字段，写了会被**静默忽略**（不报错也不生效）；要起服务端请显式调用 `api.ipc.listen(...)`。

**自动重连（`autoReconnect`）排查（issue #44）**：

- **怎么调试重连**：订阅 `api.ipc.onReconnect(name, ({ attempts }) => …)` 看成功次数与尝试次数；用 `await api.ipc.channels()` 判断当前状态——**仍含该通道名 = 正在重连**（此时 `request` 报 `not-connected` 且文案含"正在重连"，**这是预期，不是通道丢了**），**不含 = 已放弃**（重试用尽，之后请求报既有的 `not-connected`，且**不会**补发第二次 `onClose`）。
- **重连一直失败先查端点占用**：如果每次都只有 `connect-failed`，先确认对端**真的在监听**（端点名 = `obox-<扩展id>-<通道名>`）；POSIX 下看是否有陈旧 `.sock`（**服务端**要在 listen 前清理，见上方条目）；Windows 下看是否有旧实例残留占用同名的命名管道。次数用尽后宿主停止重试，通道从 `channels()` 消失。
- **`autoReconnect` 不生效**：先确认它写在 `connect({...})` 的**运行时对象**里，而不是 manifest 的 `contributes.ipcChannels`（清单里写**不报错也不生效**——宿主在归一化时会剥掉该键）；再确认 `transport` 是 `pipe`（`stdio` + `autoReconnect` 直接报 `invalid-declaration`，stdio 请在 `onClose` 里自行退避 `connect()`）。
- **重连后对端状态不对**：重连成功是**一条新通道**（协议层状态全部丢弃：请求 id 从 1 重新开始、挂起表为空），需要握手/订阅的扩展必须在 `onReconnect` 里重做；断线瞬间的**在途请求立即以 `peer-crashed` 失败且绝不重放**，要重发也得自己在 `onReconnect` 之后发。
- **别在重连窗口期再 `connect` 同一个名字**：窗口期表项仍在（占着 1 条通道额度），会报"通道 X 已打开"；要主动停止重连请 `close(name)`（幂等，且之后不再有 `onReconnect`）。

**调试建议**：先用 `api.ipc.onStderr()` 打印对端日志；对端可先用最简单的"回声"实现（读一行、回一行）验证分帧，再接入真实逻辑。

**清单声明的通道（`contributes.ipcChannels`，issue #45）**：

- `connect('<id>')` 报 `invalid-declaration 清单里没有声明通道 x` → 检查 manifest 的 `contributes.ipcChannels`（名字、拼写）；非法声明会让**清单无效**（扩展标红），先看扩展管理器详情页的 `activationError`/校验信息
- **`connect()` 成功但请求立刻报 `not-connected`** → 十有八九是**对端一启动就退出了**，最常见原因是 `args` 里的相对路径写错：stdio 对端的 **cwd 是 `<扩展源目录>/data`**，而 `program` 相对**扩展源目录**解析（`src/main/ipc.ts:149-163`）。已安装扩展的扩展源目录是 `userData/extensions/<id>`，**调试扩展则是 `--debug-extension` 给的那个目录**——两者都由 `extensionSourceDir(id)` 决定（`src/main/paths.ts:29-31`）。脚本在 `<扩展源目录>/scripts/x.py` 时应写 `args: ['../scripts/x.py']`（写成 `scripts/x.py` 会让对端找不到文件后退出）。用 `api.ipc.onStderr()` 能看到对端报错文本
- 宿主旧实例被强杀后，它拉起的对端可能成为**孤儿进程**并占着同名端点，新实例会连到"没人应答"的旧连接上 → 先清掉残留子进程再重试。**服务端侧**同理但会自愈：POSIX 残留的 `.sock` 在下一次 `listen` 时被探测清理（有活着的服务端则报 `connect-failed` 且不删）；Windows 命名管道随进程消失

## 26. 生命周期钩子（install / uninstall）没执行、或执行了两次

**先分清是"哪种没执行"**——宿主日志里有直接线索：

| 现象                                                             | 原因                                                                                         | 处理                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 装完没看到钩子日志，但 `.obox-meta.json` 里出现 `pendingInstall` | **正常**：刚安装时渲染进程还没有该扩展的加载器 → 记 `pendingInstall`，**下次启动激活前补跑** | 重启 obox 即可；也可直接看下次启动日志          |
| 重启后仍未执行                                                   | 扩展被禁用、清单无效，或窗口起不来（补充钩子要求扩展 enabled 且清单有效）                    | 启用扩展、修清单；看 `[host] 启动完成` 的数量   |
| 同版本重装又跑了一次                                             | 旧版本遗留问题（元数据没继承 `install` 记录）；现在已按"该版本已跑过"跳过                    | 升级到含该修复的版本；钩子仍应写成幂等          |
| 升级时 `ctx.previousVersion` 是 `null`                           | 旧版本遗留问题（覆盖安装时旧版本号未记录）；已在安装结果与 `pendingInstall` 里带上           | 同上                                            |
| 刚装完（同一个会话内）立刻卸载，入口 `uninstall` 没跑            | **正常**：该会话里渲染进程还没有它的加载器 → 回退 `.uninstall.cjs`                           | 重启后再卸载，或把清理逻辑放进 `.uninstall.cjs` |
| 卸载钩子抛错，目录还是被删了                                     | **设计如此**：失败只告警（`[capabilities] 扩展 X 的 uninstall 钩子失败：…`），不阻塞删除     | 修钩子；别指望失败能阻止卸载                    |

**其它检查点**：钩子必须是入口的**具名导出函数**（`export function install(ctx) {}`），不是 manifest 字段（`manifest.uninstall` 早已不读取）；`ctx` 里有 `extensionId`/`upgraded`/`previousVersion`/`api`，其中 `api` 与激活时同一套，但**钩子期注册类操作会在钩子结束后立即释放**（命令/视图/状态栏等请留到 `plugin(api)` 里做）。

## 27. 点了关闭窗口但应用没退出 / 托盘图标不见 / 设置里没有"通用"

**先分清是"设计如此"还是"真的没生效"**（ADR-0019，**仅 Windows** 有托盘）：

| 现象                                             | 原因                                                                                                                                             | 处理                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 点 X 后窗口消失但进程还在                        | **设计如此**：关闭行为偏好为"收进托盘"或询问后选了收进托盘                                                                                       | 从托盘图标"打开"还原；想改行为去 设置-通用，或托盘菜单"退出"真退出                               |
| 点 X 弹出"退出还是收进托盘"对话框                | 偏好为默认的"询问"（或首次）                                                                                                                     | 勾选"记住我的选择"后点击即可写入偏好                                                             |
| 托盘没有图标                                     | 非 Windows；或 `resources/tray.ico` 缺失（主进程会打 `[tray] 托盘图标读取失败`）                                                                 | 重新生成：`node scripts/make-tray-icon.mts`                                                      |
| 设置里没有"通用"分区                             | 该分区随 ADR-0019 引入；旧版本没有                                                                                                               | 升级到含该特性的版本                                                                             |
| 最小化后窗口"不见"了                             | 有托盘时最小化=收进托盘（主窗口不在任务栏，最小化会无处可寻）                                                                                    | 从托盘"打开"还原                                                                                 |
| 开了"开机自启"但开机没起 / 开关显示不准          | ① 开发版**不注册**该功能（设置页有说明）；② 你在 Windows 任务管理器"启动应用"里禁用了它——此时启动项仍在，但状态是"已禁用"，obox 会如实显示为关闭 | 用打包版测试；在任务管理器里启用，或重新打开设置页让它按系统状态刷新                             |
| 启动带了参数却"没生效"（如 `--debug-extension`） | **单实例**（ADR-0019 决策 9）：已有实例在跑时**参数被忽略**，只把已有主窗口唤到前台                                                              | 先退出托盘里的 obox 再启动；日志会打 `[single-instance] …本次启动的参数被忽略（…）`              |
| 应用退出后仍有孤儿子进程                         | 已落地：`before-quit` 遍历已知扩展统一清理（ADR-0019 决策 10）                                                                                   | 看主进程日志里是否有 `[quit] 主进程资源清理完成：N 个扩展`；没有则是退出路径没走到 `before-quit` |

**注意**：关窗不再等于退出，所以**不要**把扩展清理只挂在窗口关闭上——宿主仍会在扩展停用/卸载时调用 `extension:cleanup`。

**托盘"没反应"怎么分诊（issue #85 追加，2026-10-13 实机核对；当日按用户决策改为"左键无行为"，见 ADR-0019 决策 21–22）**：

**先记住当前契约**：**左键单击无任何行为**（不是 bug）、**双击**打开主窗口、**右键**弹菜单。
悬停提示已写明"双击打开 / 右键菜单"（`trayTooltip`，中英两份）。

先排除**平台机制**再怀疑代码（Electron 源码 `shell/browser/ui/win/notify_icon.cc` 的 `HandleClickEvent`）：

| 现象                   | 机制（不是 bug）                                                                                                                        | 处理                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 托盘图标"找不到"       | Windows 11 默认把新图标收进**隐藏图标浮出层**（点任务栏的 `^`）——obox 图标默认就在里面（与单击行为无关，仍然成立）                      | 点任务栏托盘区的 `^` 展开；或把 obox 图标拖到托盘可见区，之后双击/右键都在        |
| **左键单击什么都没有** | **设计如此**（ADR-0019 决策 21）：上一版的"单击弹菜单 + 220ms 迟滞"已按用户决策移除，`tray.ts` 里**没有** `click` 处理器了              | 取菜单用**右键**、开窗口用**双击**；这是有意行为，别当故障报                      |
| 双击打开主窗口没反应   | 两次点击被系统判成"两次独立单击"（超过 Windows 双击阈值）而非 `WM_LBUTTONDBLCLK`                                                        | 双击要快；或直接用托盘菜单的「打开」                                              |
| 右键弹不出菜单         | 没调 `setContextMenu`；或 `SetForegroundWindow` 失败（Electron 内部 `PopUpContextMenu` 会静默 return）                                  | 确认 `createTray` 走到了 `tray.setContextMenu(menu)`                              |
| 菜单"一闪就关"         | 托盘菜单是 Chromium views 菜单，`PopUpContextMenu` 内部会先 `CloseContextMenu()` 再弹；一般是同时弹了两次（例如两个实例各建了一个托盘） | 确认只有一个 obox 实例（单实例锁，ADR-0019 决策 9）；别用 `popUpContextMenu` 抢弹 |

**回归防线（防"悄悄改回单击弹菜单"）**：`test/tray-core.test.ts` 现在断言
① `trayCore` **不再导出** `DOUBLE_CLICK_GAP_MS` / `createTrayClickState` / `trayClickTransition` / `trayClickTeardown`；
② `tray.ts` 源码里**没有** `on('click'` / `popUpContextMenu` / 定时器，且**仍**接 `on('double-click'` 与 `setContextMenu`；
③ tooltip 含中英两种"双击打开 / 右键菜单"提示。要恢复单击行为必须**先改 ADR-0019 决策 21 契约**，否则这些用例会红。

**历史事实（保留）**：2026-10-13 实测（Windows 11 + Electron 44，合成点击 + 截图）当时**左键单击 5/5 次都能弹出菜单**、
右键弹同一菜单、双击开窗口，**未能复现**"左键单击不弹菜单"。本次取消单击行为是**用户产品决策**，不是修那个"缺陷"。

**扩展侧注意事项**：托盘是**宿主**能力，扩展不用（也无法）自己建托盘；要放"退出/设置"这类入口，
用 `api.statusBar` / 命令贡献点，别去抢托盘图标。

## 28. 安装 `.oix` 报 `forbidden-entry`（包内含 `data/`）

**症状**：安装 `.oix` 时扩展管理器提示安装失败，错误码 `forbidden-entry`，文案「包内不得包含 data/ 目录：它是扩展运行时数据目录，升级时由宿主保留」。

**原因**：安装器在解压前逐条校验 zip 条目，命中 `data/` 或 `data/**` 就整体拒收（不落盘，暂存目录被清理、`targetRoot` 下无残留）。`data/` 是宿主给扩展分配的**运行时数据目录**（安装态 `userData/extensions/<id>/data`，`api.fs` / `api.sqlite` / `api.python` 都写这里），**覆盖安装时宿主保留它**——若允许包内携带，升级就会用包里的旧数据覆盖用户现场数据。

**修复**：打包时**排除 `data/`**（同时排除 `out/`、`node_modules/`、`.git/`）：

- **白名单收集**（推荐，脚手架生成的 `scripts/pack.mjs` 就是这么写的）：只列要进包的条目（`manifest.json`、入口、静态资源、构建产物目录）；
- 递归收集时按**目录名**跳过 `data`（打包脚本通常已跳过 `node_modules/`/`.git/`，把 `data` 加进同一份跳过表即可）；
- 打完自检：`tar -tf out/<id>-<version>.oix` 里不应出现 `data/` 条目。

> 升级**保留数据**依赖的是宿主对 `data/` 的保留（见 [api-reference.md](api-reference.md) 的 `api.sqlite`），与包内排除 `data/` 是同一件事的两面：包负责不携带数据，宿主负责不删除数据。

## 29. App 子窗口（`url` 型）拿不到主题 token / 切主题不跟随

**症状**：App 卡片用 `url:` 加载 `app://extensions/<id>/…` 静态页，页面里 `var(--bg)` 这类引用**全部落到初始值**（无 fallback 时即"无值"⇒ 透明/黑字）；宿主切主题时子窗口外观**毫无变化**；表单配色丢失。

**原因**（三条，逐条核对）：

1. **跨源，宿主注入不了 CSS**：iframe 是 `app://extensions|debug/<id>/…`，与父文档（dev `http://localhost:5173`、打包 `file://`）**不同源** ⇒ `iframe.contentDocument` 恒为 `null`，宿主**无法**写 `<style>`；CSS 自定义属性也**不跨文档继承**（`srcdoc` 能生效是因为 token 被拼进了**同一份文档**）。所以 token 只能经消息送达。
2. **扩展没装接收桥**：宿主会推送 `{source:'obox-app', action:'obox-theme', themeId, tokens}`，但页面若没有 `message` 监听（且没把 `tokens` `setProperty` 到自己的 `documentElement`），推送就是空投。
3. **宿主没推送**：正常宿主在 iframe `load` 完成、主题变化、收到 `obox-theme-request` 三个时机都会推；三个时机全无日志才怀疑宿主。

**排查**（子窗口 DevTools / 主进程日志，子窗口 iframe 的 console 会带 `[child-renderer:<level>]` 前缀转发）：

- 子窗口控制台应出现 `[AppWindow] 下发主题 <themeId> N 个 token`（宿主侧）与 `[rdp] 主题已应用 <themeId>` 之类（扩展侧）；
- 若只有"未收到宿主主题推送"这类 warn：说明请求发了但**没收到**回包 → 检查是否装了接收桥（第 2 条的代码片段）；
- 若连"下发主题"都没有：宿主没推 → 见下面的**已知坑**；也确认卡片确实是 `url` 型（`html`/`srcdoc` 型不走这条通道，见 [themes-settings.md](themes-settings.md#app-子窗口url-型主题下发协议)）。

**修复**：装接收桥 + 首帧兜底——最小代码见 [themes-settings.md](themes-settings.md#app-子窗口url-型主题下发协议) 的 `applyTokens` / `message` 监听 / `obox-theme-request` 三件套（脚手架生成的骨架已内置 `installAppThemeBridge()`）。兜底值集中在**一处常量**（不要散在 CSS 里，否则既拿不到主题又难维护）。

**已知坑（跨窗口主题同步依赖 `storage` 事件，ADR-0022）**：子窗口是**独立 document**，主窗口切主题不会自动改子窗口的 `:root`。自 ADR-0022 起，主窗口写 `obox:state:v1` 后由 Chromium 的 `storage` 事件把快照送到子窗口（`src/renderer/src/core/state.ts` 的 `applyExternal`），子窗口据此 `applyCurrent()` 再推给 iframe。若日志里**一条 `[AppWindow] 下发主题` 都没有**而页面明明开着，按 ADR-0022 的退路排查（改用主进程 `webContents.send` 广播）；此时**不要**在扩展侧"绕过宿主自己读 localStorage"——`app://` 页面有**自己的** localStorage，与宿主**不共享**。

## 30. "配置了快捷键但按了没反应" / 改键时全局快捷键抢键（issue #85）

**症状**（两个叠加原因，分别看）：

- 设置-快捷键里点「编辑」，覆盖层出来了，但**按键完全没反应**（不记录、不报冲突）；
- 更隐蔽的一种：改键时按 `Ctrl+Shift+P`，**命令面板被打开**了，而捕获框还是"按下新的按键组合…"。

**根因**（宿主自身缺陷，已修复）：

1. **捕获框拿不到焦点**：覆盖层是 `v-if` 渲染出来的，`<div class="capture-box" tabindex="0" @keydown=...>` 若不在渲染后显式 `focus()`，键盘事件永远到不了它（`document.activeElement` 停在 `<body>`）。
2. **全局快捷键把键抢走**：`App.vue` 的 `window.addEventListener('keydown', onGlobalKeydown)` 命中已注册快捷键就 `preventDefault()` 并执行命令——捕获期间没有守卫，`Ctrl+Shift+P` 直接被命令面板吃掉。

**规避/使用**：升级到含该修复的版本即可；修复后「编辑」会自动聚焦捕获框、捕获期间全局快捷键一律不触发、`Esc` 取消、「重置」与冲突检测行为不变。

**给扩展开发者（重要）**：如果你的扩展也要做"按键捕获"类 UI，**不要**只在组件内部 `@keydown.stop` 就算完——只要宿主用 `window.addEventListener('keydown', ...)` 做全局快捷键，事件就已经被双份派发了。正确做法是**把捕获态暴露成全局可见的开关**：宿主已提供 `keybindingStore.setCapturing(true/false)`（读 `keybindingStore.isCapturing`），`matchKeydown` 在捕获态直接返回 `null`，全局处理器也显式早退。捕获结束（含 Esc / 取消 / 成功 / 组件卸载）**必须**复位，否则全局快捷键会被永久挡住。

**回归防线**：`test/keybindings.test.ts`（捕获态下 `matchKeydown` 返回 `null`、`captureCombo`/`setKey` 不受影响）与 `test/settings-view-wiring.test.ts`（`startCapture` 里 `await nextTick()` + `focus()`、捕获态经 store 暴露、`App.vue` 早退在 `matchKeydown` 之前）。

## 31. 设置页"首次进入没按持久化配置显示"怎么排查（issue #85）

**症状**：冷启动后第一次进设置页，某个控件显示的是**默认值**（不是上次退出时的值），而切走再切回来又对了——或者干脆一直不对。

**根因分类**（逐分区核对"首屏取值来源"，别只看一个控件）：

| 分区         | 首屏取值来源                                                                       | 踩坑点                                                                       |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 外观（主题） | `themeStore.currentId` getter：读 `stateStore.getSetting('theme')` + 已注册主题    | 主题**尚未注册**时 getter 会回落默认 dark——首屏读得太早就会显示默认主题      |
| 语言         | `i18n.global.locale`（**响应式**，`loadLocale()` 在模块求值时读 `obox:locale:v1`） | 只要不是"在 setup 里一次性取成普通字符串"就没问题                            |
| 快捷键       | `keybindingStore.list()` → 每项 `currentKey()` → `stateStore.getSetting(...)`      | `currentKey` 是**方法**（渲染期调用即响应式）；若在 setup 里取成数组快照就僵 |
| 网络/通用    | 见下                                                                               | 本分区最容易写成"一次性快照"                                                 |
| 扩展设置     | `fieldValue()` → `stateStore.getSetting(key)`，缺省回落 `field.default`            | 同上                                                                         |

**两条硬规则**：

1. **不要**在 `setup` 阶段把 `stateStore` 的值取成**普通 ref**（`const x = ref(stateStore.getSetting(...))`）——那是一次性快照，之后任何变更（跨窗口 `storage` 合并 / 主进程回写）都不会反映到表单上。要么在**渲染期**直读（模板里调 `fieldValue()` / `isNotifDisabled()` 这类方法），要么 `stateStore.onSettingsChanged(...)` 里同步。
2. **确有可编辑输入框时**（如代理配置）用 `reactive` 表单对象 + `onSettingsChanged` 同步，并用一个内部标志抑制"自己写 → 自己收到通知 → 再写回"的回环。

**排查手法（不用挂载组件）**：预置一份 `localStorage['obox:state:v1']`，用 `npm run dev` 冷启动，打开设置页逐分区读控件值（DevTools 里 `document.querySelector('.settings-content select').value`）。`test/settings-first-paint.test.ts` 把这条路径钉成了单测（快照里每个值都故意与代码默认值不同）。

**覆盖边界**：仓库 vitest 是 `node` 环境、没有 jsdom / `@vue/test-utils`，所以**不能挂载 `.vue`**；组件接线由 `test/settings-view-wiring.test.ts`（读源文件）覆盖，取数路径由 `test/settings-first-paint.test.ts` 覆盖。

## 32. 扩展要选文件夹，弹出的却是选文件框

**症状**：

- 扩展里写 `api.dialog.showOpenDialog({ properties: ['openDirectory'] })`，用户看到的却是**文件**选择框（Windows 上还能看到"文件类型"下拉、能被 filters 过滤）；
- 更隐蔽的一种：框**看起来**正常，用户也确实选了一个目录并确认，但 `filePaths[0]` 最终拿到的是一个**文件**路径（选了文件夹进不去、或选到某个 `xx.exe`）；
- `properties: ['openDirectory','multiSelections']` 的多选/目录语义完全无效。

**原因（两个，按顺序排查）**：

1. **obox 版本旧**：宿主旧实现把 `properties` **硬编码**成 `['openFile']`（旧 `src/main/ext.ts:22-31`），IPC 入参类型里根本没有 `properties` 字段 ⇒ 你传的 `properties` 经 **Electron IPC 结构化克隆原样到达主进程**，但主进程**不读它**，永远按"选文件"构造对话框。这就是"弹错框"的全部原因——**不是**你的调用写错了。
2. **调用写错**（少数）：`openDirectory` 与 `openFile` **互斥**。同时传两个时宿主按**目录模式**归一（只保留 `openDirectory` + 可选 `multiSelections`）；但若你只写了 `openFile` 却指望目录效果，那永远不会弹目录框。另：目录模式下 `filters` **被宿主丢弃**（Electron 不对目录应用过滤器）——别用 filters 来"约束目录"。

> **`type: 'directory'` 设置字段的额外坑（老宿主上比上面更早一步就断）**：若扩展走 manifest `contributes.settings` / `api.settings.register` 的 `type: 'directory'` 字段（而不是自己调 `api.dialog.showOpenDialog`），老宿主（≤ v1.0.8）的设置页字段渲染链到 `select` 即止且**没有兜底分支** ⇒ 该字段**连控件都不渲染**（label 仍在、下方空白），用户既没机会点输入框、也没机会点「浏览…」（新宿主上这两个入口都会弹目录选择器），更拿不到任何错误提示。需要兼容老宿主时，扩展应自行降级为 `type: 'text'`（详见 `themes-settings.md` 的"`directory` 字段"）。本仓库新版宿主对未知类型统一按 `text` 兜底渲染并 `console.warn`，不会再出现"设置项凭空消失"。

**确定性的自查方式（不要猜，看返回值）**：

```ts
const r = await api.dialog.showOpenDialog({ title: '选目录', properties: ['openDirectory'] })
// 老宿主：r.ok === true、r.canceled === false、r.filePaths[0] 是一个**文件**路径
// 新宿主：r.ok === true、r.filePaths[0] 是一个**目录**路径
```

判定只有一条凭据：**`filePaths[0]` 到底是不是目录**。扩展入口没有 `node:fs`，`api.fs` 又只覆盖扩展自己的 data 目录（外部路径读不了）⇒ 把路径交给**你自己的助手侧**（JS 助手 / Python 进程）做 `isDirectory` 判定。

**修法（两选一，建议都做）**：

1. **升级 obox** 到含该能力的版本（宿主侧是纯加法，`properties: ['openDirectory']` 会真的传到 Electron 的 `showOpenDialog`；不传 `properties` 的调用行为**逐字不变**）。
2. **在扩展里做能力探测 + 降级**（推荐，老宿主上也不报错、不崩）：
   - 调 `showOpenDialog({ properties: ['openDirectory'] })` 后按上面"自查方式"判定；
   - 拿到的是**目录** ⇒ 该宿主支持，直接用；
   - 拿到的是**文件** ⇒ 该宿主**忽略**了 `properties`，记本次会话 `supported = false`（**只探测一次、缓存进内存**，不落库、不写设置），把候选值降级为"该文件的**父目录**"，并在界面上**明说**："当前 obox 版本不支持「选择目录」；请在下方粘贴目录路径，或升级 obox 后重试"；
   - 返回 `{ ok: false }` ⇒ 同样降级为"手填路径"并显示宿主给的 `error`；
   - `canceled: true`（或 `filePaths` 为空但 `canceled !== true`）⇒ 什么都不改，**不要**当成"不支持"。
   - 结论：**降级必须说出来**，不能静默把父目录当作用户选的目录。

**别用版本号判断能力**（重要）：`await api.env.getOboxVersion()` 拿到的是字符串，无法判定"这个版本有没有 `properties` 透传"（补丁版可能只改了这一点、预发布/自编译版本号更不可靠），而且会把"能力探测"变成"版本对比表"长期维护。**唯一可信的判定就是"调用后的实际返回"**——即"选到的到底是不是目录"。

**回归防线（宿主侧）**：`test/ext-dialog.test.ts`——`normalizeDialogProperties` 的表驱动单测（不传 ⇒ `['openFile']`、`['openFile','openDirectory']` ⇒ 只 `openDirectory`、`['openDirectory','multiSelections']` ⇒ 两者都在、未知值忽略、`multiSelect` 旧字段兼容）+ 源码门禁（`src/main/ext.ts` 里**不得**再出现硬编码 `properties: ['openFile'`，且 `win`/无 `win` 两分支共用同一归一结果、目录模式丢弃 `filters`）。

## 33. `type: 'status'` 的只读状态项不显示 / 显示成了可编辑文本框

**症状**（两种，取决于宿主版本）：

- 设置页该字段**只有一个 label，下面一片空白**：没有文本、没有报错、也没有任何控件——用户以为扩展"没做这个状态"，扩展侧也不报错；
- 或者该字段**显示成一个可编辑文本框**：扩展写进去的状态值确实显示出来了（首屏正常），但用户可以直接改它并保存，把扩展写的状态覆盖掉——而 `status` 本该是**只读**的。

**原因（都是宿主版本差异，不是扩展写错了）**：

1. **obox ≤ v1.0.8**：字段渲染链到 `select` 即止、**链尾没有兜底分支**（没有 `v-else`）⇒ `type: 'status'` 属于"未知类型"，`v-if / v-else-if` 全部落空，**什么都不渲染**（label 仍在）。同一条也适用于 `type: 'directory'`（见上一条的引用块）。
2. **认识未知类型、但还没实现 `status` 的中间版本宿主**：这类宿主**有**兜底 `v-else` ⇒ `status` 被按 `text` 语义渲染成**可编辑文本框**（可编辑、可保存，值仍取自同一设置存储）。**注意：这个中间版本从未发布**——`directory` 与新兜底分支都是本仓库尚未发布的改动；已发布的最新的 v1.0.8 及更早属第 1 种。也就是说 `status` 一旦随下一次宿主发布上线，就不存在"已发布、却只会把它兜底成文本框"的版本。

**自查（不要猜，直接读宿主源码）**：字段渲染链是纯模板逻辑，用 tag 就能看清：

```powershell
# 把 v1.0.8 换成你要排查的宿主 tag / commit（例如某个自编译版本）
git show v1.0.8:src/renderer/src/extensions/settings/SettingsView.vue |
  Select-String 'field\.type|v-else'

# 只看"独立成行"的兜底 v-else（行内的 v-else class=… 不算，别被它们误导）
git show v1.0.8:src/renderer/src/extensions/settings/SettingsView.vue |
  Select-String -Pattern '^\s*v-else\s*$'
```

在 v1.0.8 上，第一条命令输出里那一堆 `v-else` **全是行内形式**（`<div v-else class="config-block">`、`<kbd v-else …>` 等，属于分区链与快捷键表格，不是字段链），第二条命令**没有任何输出** ⇒ 字段链确实没有兜底。

两问即可定性：

1. 有没有 `field.type === 'status'` 的 `v-else-if`？有 ⇒ 只读渲染，正常。
2. 没有的话，字段链**末尾**有没有独立的 `v-else`（不是 `v-else-if`、也不是行内 `v-else class=`）？**没有** ⇒ 整段什么都不渲染（第 1 种症状）；**有** ⇒ 会按 `text` 兜底成可编辑文本框（第 2 种症状）。

**修法（两选一，建议都做）**：

1. **升级 obox** 到含 `status` 的版本（宿主侧是纯加法：新类型的 `v-else-if` 分支插在 `directory` 之后、链尾兜底之前，既有类型的渲染与保存通路逐字不变）。
2. **扩展自行降级声明**（老宿主上也不报错、不崩）：
   - 需要兼容 ≤ v1.0.8 时，别把关键状态只放在 `status` 字段里（老宿主上它连控件都不渲染）——可以同时在扩展自己的设置页/卡片里展示同一份状态，或声明成 `type: 'text'` 并接受"用户可编辑"（`text` 在每个宿主版本上都有控件）；
   - 状态值本身仍写**同一把 key**（`api.settings.set`），换字段类型不需要改扩展的写入侧。

**正面结论：扩展写状态键后，设置页当帧刷新——不需要轮询、不需要重进设置页。** 因为写与读落在**同一个渲染进程里的同一个 `stateStore`**：`api.settings.set` = `stateStore.setSetting`（`src/renderer/src/core/host.ts:467`）→ `save()` 之后**同步**遍历变更订阅者（`src/renderer/src/core/state.ts:143-148`）→ 设置页订阅里 `settingsRevision++` 触发重渲染（`SettingsView.vue:565-570`）、渲染期经 `fieldValue` 重新读值（`SettingsView.vue:322-325`）。所以"状态不刷新"的排查方向是**宿主版本/渲染链**，不是"要不要加个定时器"（`status` 字段值本身没有轮询机制，也不需要）。`progress` 字段（API v2 新增的只读进度条）走的是**同一条**取值与刷新路径，同样不需要轮询（见 `themes-settings.md` 的「`progress` 字段」）。

**回归防线（宿主侧）**：`test/settings-view-wiring.test.ts` 钉住 `status` 分支**只读**（无 `input`/`button`/`select`/`@change`/`onFieldChange`、位于 `directory` 之后且兜底 `v-else` 之前）与**多行按行渲染**；`test/settings-first-paint.test.ts` 钉住值与 `text` 同源（同一份设置存储）以及"扩展写键 → 订阅者同步收到"的当帧刷新路径。

## 34. 透明 overlay 窗体看起来不透明

**症状**：`api.overlay.create({ transparent: true, … })` 出来的窗体带一块底色（深灰 `#1e1e1e` / 白 / 黑 / 灰 `#f3f3f3`），桌面透不出来；或者截图里内容外面套着一个不透明矩形。

**原因**：透明是**五处绘制点一起改**才成立的结果，任一处漏改都会得到不透明窗体（宿主侧实现见 `api-reference.md` 的 `### overlay`「透明窗体的五处绘制点」）。

**排查清单（按顺序，逐处对源码）**：

| #   | 绘制点                                        | 检查什么                                                                                                                                                    | 证据                                                            |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | **主进程窗体参数**                            | `transparent: true` 是否与 `backgroundColor: '#00000000'` **同用**；`hasShadow` / `thickFrame` / `roundedCorners` 是否都为 `false`                            | `src/main/appWindow.ts:429-441`                                 |
| 2   | **TitleBar / PromptHost**                     | overlay 模式是否**不渲染** `<TitleBar>` 与 `<PromptHost>`（标题栏与模态遮罩都是不透明像素）                                                                    | `src/renderer/src/AppWindow.vue:287-314`                        |
| 3   | **`.app-window` / `.app-window-content`**     | 根 class `.app-window--overlay` 下这两层的 `var(--bg)` 背景是否置 `transparent`                                                                               | `src/renderer/src/AppWindow.vue:336-345`                        |
| 4   | **`.app-frame` 白底**                         | iframe 的白底是否被覆盖为 `transparent`——**最容易漏的一处**：漏了就把内容糊成白色矩形                                                                         | 同上                                                            |
| 5   | **全局 `body` 背景**                          | `main.css` 的 `body { background: var(--bg) }` 对**每个窗口**都生效 ⇒ 是否有 `html.obox-overlay` 规则把 html/body 置透明，且 class 在**首帧前**挂上（模块级 script） | `src/renderer/src/assets/main.css:53-61` + `AppWindow.vue:1-17` |

**参数组合的实测结论（已实机验证）**：

- 只给 `backgroundColor:'#00000000'`、**不给** `transparent:true` ⇒ 得到**灰底 `#f3f3f3`**（maxdiff=10）——带 alpha 的背景对不透明窗没有意义；
- `transparent:false` + `backgroundColor:'#1e1e1e'` ⇒ **`#1e1e1e` 精确命中**（maxdiff=223）；
- `transparent:true` + `backgroundColor:'#00000000'` ⇒ 判据点取色 **maxdiff=0**（≤ 2/255），完全透出桌面。
  三项均见卡 01 实机证据 `extensions/pet/openspec/changes/pet-desktop-companion/notes/evidence/overlay-feasibility.md` §1（正向）与 §5（两组反向对照，证明判据有区分力）。

**平台限制（会让"代码全对但仍不透明"）**：

- **打开 DevTools 时透明窗体会变不透明**（Electron 官方限制）⇒ **验收取色必须不开 DevTools**（用外部截图/取色工具）。**未实机验证**（卡 01 证据 §6-6：探测脚本只对 `devtools-opened` 做防御性守卫并写日志，未主动开 DevTools 复现）。
- **Windows 上透明依赖 DWM 合成**：被组策略关闭时退化为不透明。**未实机验证**（§6-5：该场景未测）。
- **`transparent` 创建后不可运行时切换**（Electron 限制）⇒ 想改透明只能 `destroy` 后重新 `create`；同理透明窗**不可 resize**、Windows 下**不可最大化**，所以宿主把 overlay 尺寸做成固定（`resizable:false` / `maximizable:false`）。**未实机验证**（§6-5：仅引用官方文档，未主动复测）。
- **全屏独占应用下 `alwaysOnTop` 窗体可能被遮挡**——平台行为，**不是宿主 bug**，别按"置顶失效"排查。**未实机验证**（§6-5：全屏独占场景未测）。`alwaysOnTop` 本身**已实机验证**（§3：`isAlwaysOnTop()=true` + "压在普通窗口之上"的截图对照）；`skipTaskbar` **已实机验证，但只有截图/目检证据**（§3：任务栏条目 11 → 11，同 app 的普通窗对照 11 → 12 → 11）。

**自查（不要猜，直接读宿主源码）**：

```powershell
# 五处一次看全（在 obox 仓库根执行）
Select-String -Path src/main/appWindow.ts -Pattern "transparent|backgroundColor|hasShadow|thickFrame|roundedCorners"
Select-String -Path src/renderer/src/AppWindow.vue -Pattern "obox-overlay|isOverlay|background: transparent|TitleBar|PromptHost"
Select-String -Path src/renderer/src/assets/main.css -Pattern "obox-overlay"
```

**回归防线（宿主侧）**：`test/overlay-window.test.ts` 的「外壳 · 五处透明改动」逐处断言（含"卡片模式基础样式逐字保留"的回归项）。

## 35. overlay 窗体吞桌面点击 / 或点击不响应

两种**相反**的症状，成因不同：

- **A. 窗体覆盖区域的桌面点不动**（右键菜单弹不出来、桌面图标选不中、下层窗口收不到点击）；
- **B. 页面里的精灵/按钮点不到**（明明已经关掉穿透）。

**排查**：

1. **创建后默认就是鼠标穿透**：宿主在 `create` 成功后立刻 `setIgnoreMouseEvents(true, { forward: true })`（`src/main/appWindow.ts:459-462`）⇒ 症状 B 先确认扩展有没有在**命中时**调 `api.overlay.setMouseThrough(id, false)`。注意 `setMouseThrough` 对不存在/已销毁的 id 返回 **`ok:false`**（与 `destroy` 的幂等不同，`:552-561`），**检查返回值**别当它一定成功。
2. **穿透是"整窗"切换，没有逐像素 alpha 穿透**（Electron 无此能力）⇒ 关闭穿透期间，窗体的**空白区也一并捕获点击**（症状 A 的最常见成因：命中后忘了切回 `true`）。这是**已知取舍**，不是 bug；**已实机验证**（卡 01 证据 §2：IGNORE_OFF 下点空白区得到 `CLICK target=body`，即整窗捕获）。正确写法是"命中测试驱动"：`forward:true` 让悬停移动仍转发给页面，页面判断指针是否落在精灵/面板上，命中才临时关穿透、离开立刻切回。
3. **`forward:true` 对注入式合成输入间歇性不转发**：**已实机验证的负记录**——卡 01 用合成光标扫掠 5 组，只有 2 组收到事件（`pointermove` +9 / +39），**3 组为 0**（钩子层就没收到），根因未查明，疑与本机虚拟显示/远控（ToDesk 一类）输入栈干扰注入事件有关（证据 §2、§6-2）。**真实人工移动正常**（§2：IGNORE_ON 期间真实鼠标划过窗体，页面收到 `PM_TICK n=101`）。⇒ **在自动化/CI（注入输入）环境里 hover 命中偶发失灵时，先用真实鼠标或 `WindowFromPoint` 复核，不要先怀疑宿主实现。**
4. **命中测试的复核判据（已实机验证，双向）**：`WindowFromPoint` 在 IGNORE_ON 下应返回**桌面**（`SysListView32` / `FolderView`），IGNORE_OFF 下应返回**本窗**（`Chrome_RenderWidgetHostHWND`）——Electron 源码注明 click-through 窗体对 `WindowFromPoint` 不可见，所以它的返回值就是点击的真实接收者（证据 §2）。
5. **overlay 页面里没有 `api` 对象**：`setMouseThrough` 只能由**扩展入口**调用；页面要切穿透得经消息桥请求入口（消息收不到的排查见第 37 条）。

## 36. overlay 里 alert/confirm/prompt 无效

**原因**：与第 3 条同源——overlay 窗体复用同一份外壳 `AppWindow.vue`，iframe 的 `sandbox` 是 `allow-scripts allow-same-origin allow-forms allow-popups`，**没有 `allow-modals`**（`src/renderer/src/AppWindow.vue:298`）⇒ overlay 页面里 `alert` / `confirm` / `prompt` 全部**静默无效**（不报错、不弹）。

**overlay 特有的两点补充**：

- overlay 窗体**不渲染 `<PromptHost>`**（透明窗体里模态遮罩也是不透明像素，`:307-313`）⇒ 宿主的 `api.ui.showForm` / `showQuickPick` / `showInputBox` **不会**在 overlay 上出现。主进程 `ui.ts` 的 `isChild` 判定按 `obox-window=app` 命中，overlay **不命中** ⇒ 这类模态框回**主窗口**本地渲染（返回 `{ local: true }`）。这是**预期取舍**而不是 bug（overlay 页面本身没有 api 对象、也开不了模态框；能调 `api.ui` 的只有扩展入口，那时焦点通常也不在 overlay 上，`src/renderer/src/main.ts:18-19`）。
- **修复**：交互一律**自绘**（页面内面板/气泡/行内确认），不依赖浏览器弹窗，也不指望宿主模态框。

## 37. overlay 页面收不到消息（宿主能力全部无响应）

**症状**：overlay 页面 `parent.postMessage({source:'obox-app', action:'obox-extension', …})` 后收到 `{ ok:false, error:'扩展未注册消息处理器' }`，或干脆没有回包；或页面**整个空白**（透明窗体直接透出桌面，什么也没画）。

**排查（按顺序）**：

1. **查询串五个参数缺一不可**：`obox-window=overlay&extId=<扩展id>&overlayId=<overlay id>&appId=<overlay id>&url=<encodeURIComponent(扩展页URL)>`（`overlayQuery`，`src/main/appWindow.ts:364-381`）。**尤其 `appId` 必须填 overlayId**——消息桥按 `appId` 路由：**先查 App 卡片**、未命中**再按 `overlayId` 查 overlay 路由表**（`resolveMessageExtId`，`host.ts:89-95,619-643`）。手工构造 URL 调试时最容易漏 `appId`，漏了就正好是"扩展未注册消息处理器"。
2. **页面空白 ⇒ 先看 `url` 是否被外壳拒载**：主进程与外壳对 `url` 做**同判据的双重校验**（`isOverlayUrlInsideExtension`，`src/main/appWindow.ts:260-286`；`isOverlayUrlAllowed`，`src/renderer/src/AppWindow.vue:66-100`）——① `app:` 协议；② host ∈ {`extensions`, `builtin`, `debug`}；③ 路径首段 = 本窗口的 `extId`；④ 首段之后**必须有子路径**（`app://extensions/<id>/` 是目录，拒）；⑤ 不含 `..`。不合法 ⇒ **不加载 iframe、渲染空白**（连空态提示都不画：空态文字也是像素），并 `console.warn` 一条 `[overlay] 拒绝非法 url: …`，该日志经 `console-message` 转发进主进程终端，前缀 `[child-renderer:warning]`（`src/main/appWindow.ts:482-491`）。**看到这条日志就是 url 的问题，不是消息桥的问题。**
3. **扩展入口注册 handler 了吗**：overlay **复用** `api.app.onMessage`（没有单独的 overlay handler）；每个扩展只保留**最后一个** handler（`host.ts:426-433`）。
4. **60s 超时**：桥的单次请求超时是 **60s**（`src/main/appWindow.ts:185-193`），overlay 复用同一条逻辑 ⇒ 长轮询 hold 必须**小于** 60s（宠物扩展用 25s），否则页面收到「扩展未响应（超时）」。
5. **error 是「overlay 窗体已销毁」**：说明窗体 `destroy` 后页面还在等回复——宿主在窗体 `closed` 时把该窗的 pending 请求**立即**以此错误结算（`flushPendingReplies`，`:162-170,475-480`），不让它空挂 60s。这是正常的生命周期收尾，不是丢消息。
6. **error 是「主窗口不可用」**：只有 overlay 窗体、主窗口已关（overlay 随主窗口一并关闭，`:217-232`）⇒ 桥的对端宿主没了，消息投不出去（`mainWindow()` 会把 overlay 排除在"主窗口"之外，`:151-160,178-183`）。

**回归防线（宿主侧）**：`test/overlay-window.test.ts` 的「宿主 · 消息路由」（卡片优先 / overlay 兜底 / 都未命中回既有错误文案）、「外壳 url 二次校验」、「60s 桥超时未被缩短」与「生命周期联动」。

## 38. 扩展没激活（用户扩展按 `activationEvents` 懒激活）

**症状**：扩展在管理器里显示正常（没有标红），但命令面板里没有它的命令、App 卡片不出现、状态栏点了没反应；宿主日志里是 `启动激活完成：0/1 个扩展`，看起来"加载了却没激活"。

**先记住模型**：用户扩展跑在 **Extension Host Process**，**不再一律启动即激活**——清单的 `activationEvents` 决定何时跑 `plugin(api)`（缺省 = `*` = 立即）。内置扩展仍立即激活、不受影响。

**逐条排查**：

| 清单里写的               | 它什么时候激活                                                             | 没激活先看什么                                                                                   |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 不写 / `[]` / `null`     | **启动即激活**（缺省 `*`）                                                 | 那就是别的原因：看 #6（入口没 `default` / 入口抛错）与扩展管理器详情页的 `activationError`        |
| `*`                      | 同上                                                                       | 同上                                                                                             |
| `onStartupFinished`      | `*` 那一轮**之后**（首屏之后、空闲时）                                     | 日志要等这一行：`启动后激活完成（onStartupFinished）：x/y 个扩展`；只看到 `启动激活完成` 是正常的 |
| `onCommand:<命令id>`     | **该命令被执行时**（命令面板 / 快捷键 / 状态栏点击 / 树节点 / `api.executeCommand`） | ① `<命令id>` 与 `contributes.commands[].command` **逐字一致**吗？② 这条命令真的被触发过吗？③ 命令是否已声明（未声明会在激活时抛错，见 #9） |
| `onView:<导航项id>`      | **该导航项被点开时**（导航栏点击，或主进程 `nav:open`）                     | ① `<id>` 与 `contributes.views[].id` / `navItems[].id` 逐字一致吗？② 有没有真的点开过它？          |

- **没有触发源的扩展别写 `onCommand` / `onView`**：只注册 App 卡片或只有状态栏展示、没有任何命令/视图可点的扩展写这两类就**永远不会激活**——卡片与树数据源都是运行期注册的，扩展不激活就不存在。这类扩展请写 `*` 或 `onStartupFinished`
- **回退开关关着时 `activationEvents` 不生效**（默认配置，见 api-reference 的「运行模型」）：那时全部扩展立即激活，"没激活"只可能是 #6 那一类原因
- **激活失败 ≠ 没触发**：触发过但 `plugin(api)` 抛错会在扩展管理器详情页留 `activationError`，并在日志里留 `扩展 <id> 激活失败（plugin-threw）`
- **验证是否真的激活了**：渲染侧 console 里的宿主日志行 `激活扩展 <id>（onCommand:…）` / `扩展 <id> 激活完成（…）`（宿主日志经 `log` 信封转发到渲染侧 console）

## 39. 清单标红：`activationEvents` 不合法

**症状**：扩展在管理器里标红、显示"清单无效"、根本不加载；详情页校验信息里有 `activationEvents …` 的 error。

**原因**：`activationEvents` 的每一项都必须是 4 类事件之一，且 `onCommand:` / `onView:` 的 `<id>` 去空白后必须非空。以下全部是 **error**（不是 warning），**一处错报一行**，`合法值：…` 是固定尾巴：

| 输入                          | 逐字错误文案                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| 不是数组（`{}` / `5` / `true`） | `activationEvents 必须是字符串数组（合法值：* / onStartupFinished / onCommand:<id> / onView:<id>）`     |
| 第 N 项不是字符串             | `activationEvents 第 N 项必须是字符串（收到 <值>，合法值：…）`                                          |
| 认不出的事件名                | `activationEvents 第 N 项 "<事件>" 不受支持（合法值：…）`                                               |
| `onCommand:` / `onView:` 没写 id | `activationEvents 第 N 项 "<事件>" 的 <id> 不能为空（合法值：…）`                                    |
| id 只有空白（`onCommand:  `）  | 同上（`<id> 不能为空`）                                                                                 |

**修复**：

- 只写这 4 类：`*`、`onStartupFinished`、`onCommand:<id>`、`onView:<id>`（**前缀大小写敏感**：`oncommand:x` 不认）
- `<id>` 要么写全（与命令/视图 id 逐字一致），要么就别写这条事件
- 最省事的写法：清单里**不写** `activationEvents`（缺省就是 `*`，与老版本行为一致）
- 发布前先自查（与宿主**同一套规则**，脚本与宿主有差分门禁）：`node scripts/validate-manifest.mjs manifest.json`（`--all` 扫全部，`--json` 机器可读）。改完清单要**重启应用重新扫描**才会重新判定

## 40. 扩展在宿主里报 `EH_NOT_READY`

**症状**：扩展侧（或渲染侧）拿到 `EH_NOT_READY`；中文文案是「扩展宿主还没就绪（未收到 initialized）。请等待宿主启动完成；若反复出现，检查宿主进程是否已崩溃。」或渲染侧的「扩展宿主的端口还没到本窗口，请求没有发出去。…」。

**原因**：这不是"宿主坏了"，而是**链路还没通**——两种可能：① **host-renderer 端口还没到本窗口**（端口由 main 在宿主起来后 `webContents.postMessage` 转移，渲染侧只负责收）；② **宿主还没完成握手**（没发 `initialized` 之前，宿主对一切 `req` 都回 `EH_NOT_READY`）。

**按宿主 phase 对下一步**（渲染侧 `notReadyMessage()` 逐字给出的动作）：

| phase          | 含义                                       | 该做什么                                                                 |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `idle`         | 宿主从未启动                               | 确认 设置 → 通用 → 「在独立进程中运行扩展」是**开**的（2.0 起默认开），且没有 `OBOX_EXTENSION_HOST=0`；改完需重启 |
| `starting`     | 正在启动，握手未完成                       | 等 1–2 秒重试；一直如此就看主进程日志里的握手失败原因（10 秒握手超时）   |
| `ready`        | 宿主已就绪，但**端口没到**                 | 页面可能刚重新加载过（端口随旧页面销毁）：**重启应用**重建链路            |
| `unresponsive` | 3 秒内没应答判活                           | 检查扩展是否阻塞了事件循环                                              |
| `crashed`      | 宿主崩溃（见 #41）                         | 重启宿主或禁用出错的扩展                                                 |
| `stopped`      | 宿主已停止                                 | 重新启动宿主                                                             |

**注意（当前实现的限制）**：上面的文案里提到"在扩展管理器里点启动/重启宿主"——**扩展管理器目前还没有宿主状态面板与这些按钮**（属于未完成的那张卡）。现阶段的实际恢复手段是**重启应用**；开发时可用 `window.api.ehStop()` 再 `window.api.ehStart(exts)` 手动重建链路。宿主状态只在渲染侧 console 的 `[eh] 扩展宿主状态：<phase>` 与主进程日志里可见。

**排查顺序**：先看 phase（决定是"没起"还是"没通"），再看主进程日志里是否有宿主 fork / 握手失败的记录，最后才怀疑扩展自己的调用参数。

## 41. 宿主崩溃 / 自动重启（5 分钟 3 次）

**症状**：扩展突然集体失效（命令不响应、状态栏不动、UI 数据不再更新）；主进程日志出现 `扩展宿主崩溃（code=…），500ms 后自动重启（窗口内第 x/3 次）`，或 `5 分钟内第 3 次崩溃（code=…）：不再自动重启`。

**策略（照 VS Code，ADR-0026 决策 7）**：

| 情况                     | 行为                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| 5 分钟内崩溃 **< 3 次**  | **自动重启**（延迟 500ms）；扩展会按各自 `activationEvents` 重新激活，内存态丢失（落盘的数据还在）     |
| 5 分钟内崩溃 **达 3 次** | **不再自动重启**：`phase=crashed`，`ehStart` 回 `{ok:false}` + 中文原因（"…不再自动重启。请在上层弹窗里选择「重启宿主」或「禁用扩展」；原因：…"） |
| 卡死（3 秒未应答判活）   | **只观测，不杀不重启**（`phase=unresponsive`）——避免把"慢"误判成"死"                                   |
| 启动握手失败（10 秒）    | 记为 `crashed`，但**不计入**崩溃预算（这通常是入口写错，重启只会把 3 次烧在同一个错误上）              |

- **崩溃计数按进程算，不按扩展**：一个扩展的 bug 会烧掉**所有**扩展的重启预算——所以"扩展 A 把宿主搞崩，扩展 B 也不动了"是预期行为
- **扩展管理器当前不显示这些状态**：`phase` 与最近一次崩溃原因只进渲染侧 console（`[eh] 扩展宿主状态：crashed，最近崩溃：退出码 …`）与主进程日志；面板/按钮（重启宿主 / 禁用扩展）属于未完成的那张卡。现阶段的恢复手段是**重启应用**
- **扩展侧该做什么**：别在 `plugin(api)` 里做会崩掉整个进程的操作（原生模块崩溃、`process.exit`、无界递归）；把"能丢"的状态写进 `api.fs` / `api.sqlite` / Memento，崩溃重启后自行恢复

## 42. 扩展想用 DOM / `localStorage` 会失效

**症状**：`ReferenceError: document is not defined` / `window is not defined` / `localStorage is not defined` / `HTMLElement is not defined`；或某个 npm 包一 import 就炸；或 `apiVersion: 3` 的扩展在旧宿主上被拒绝加载（"需要 obox API v3 或更高（当前 obox 为 v2）"）。

**原因**：运行模型变了。用户扩展跑在 **Extension Host Process**（独立 Node 进程），**没有 DOM、没有 `window`、没有 `localStorage`**；内置扩展才在渲染进程里、才有 DOM。旧宿主（`apiVersion ≤ 2`，即 ≤ 1.0.17）读到 `apiVersion: 3` 会直接拒绝加载，这是**有意的**——总比运行到一半才炸好排查。

**替代方案**：

| 原来想用               | 宿主模式下怎么做                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `localStorage` 存数据  | `api.workspaceState` / `api.globalState`（Memento，落盘）、`api.fs`（自己管文件）、`api.sqlite`（结构化） |
| `document` 操作界面    | 界面只能放在 **页面**里：App 卡片静态页（`app://extensions/<id>/…`）或 overlay 页面；那些页面**有** DOM 与自己的 `localStorage`，但与扩展入口**不是同一个文档** |
| 页面 ↔ 扩展通信        | `api.app.onMessage`（页面 postMessage → 扩展 handler 回包）；主题经 `obox-theme` 消息下发             |
| 直接 `fetch` / 读文件  | 宿主有完整 Node：可以直接 `fetch`、`node:fs`；要继承设置-网络里的代理就用 `api.net.fetch`             |

**排查**：

- 确认要交付的扩展声明了 `apiVersion: 3`（用了宿主形态的能力就该声明它，旧宿主上会明确拒绝而不是半坏）
- 找"哪一行摸了 DOM"：报错栈里第一个业务文件就是它；常见是入口顶层就 `import` 了某个浏览器包——把 UI 相关代码挪进页面脚本
- 页面里能用 `localStorage`，但那是**页面自己的**（按 `app://` 源隔离），与扩展入口不共享：跨窗口/跨文档传数据一律走 `api.app.onMessage`

## 43. stdio sidecar 中文乱码 / 丢帧（`Content-Length` 按字节）

**症状**：`api.ipc` 的 stdio 对端跑起来后，**中文内容乱码**、偶发少一条消息、或时好时坏地报 `timeout` / `protocol-error`；英文内容却一直正常。

**原因**：`Content-Length` 分帧的长度是**字节数**，不是字符数（`src/main/ipcCore.ts` 的 `ContentLengthParser.encode` 用 `Buffer.length`）。UTF-8 下一个中文字符占 **3 字节**——对端若按"字符数/码点数"算长度并写进自己的帧头，宿主就会按错误的长度切帧：切短了读到半个 JSON（→ `protocol-error` 或"看起来被吞了一条"），切长了会把下一帧的头一起吞进上一条消息。

**修复（按语言）**：

```python
# Python
body = json.dumps(msg, ensure_ascii=False).encode('utf-8')
sys.stdout.buffer.write(f'Content-Length: {len(body)}\r\n\r\n'.encode('ascii') + body)
```

```go
// Go：len([]byte) 就是字节数（string 长度也是字节数，别先转 rune）
body, _ := json.Marshal(msg)
fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n%s", len(body), body)
```

- **C#**：`Encoding.UTF8.GetByteCount(body)`；**Rust**：`body.as_bytes().len()`
- **不要**用 `len(str)`（Python 3 的字符数）/ `String.length`（JS 的 UTF-16 码元数）/ `string.Length`（C# 的 char 数）来算帧长
- 日志一律写 **stderr**（stdout 只放协议数据）；单条消息上限 **8MB**
- 也可以改用 `framing: 'ndjson'`（按换行分帧），但长文本/二进制仍推荐 `content-length`

**自查**：先让对端用纯 ASCII 回显验证分帧正确，再换成含中文的 payload；若中文一加就坏，基本就是这里。排查其它错误码见 #25。
