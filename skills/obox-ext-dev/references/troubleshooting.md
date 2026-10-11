# Troubleshooting

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

**症状**：启动日志 `[host] 启动完成: 1 个扩展（1 启用 / 0 禁用），激活 0，依赖环 无`（格式见 `src/renderer/src/core/host.ts:921-927`；末尾的"依赖环"是环内扩展 id 列表，正常为 `无`）。

**原因**：入口未导出 `default` 插件函数，或入口加载/执行抛错。

**排查**：

- 入口必须有 `export default function(api) {...}`
- 扩展管理器详情页看 `activationError`（激活失败原因）
- dev 日志看 `[host] activate <id> failed <error>`

## 7. 命令面板命令不出现

- `palette: false` 的命令被过滤（设计如此，内部命令用；过滤规则 `src/renderer/src/core/registry.ts:259`）
- 命令未通过校验（缺 `command`/`title`）→ 详情页看校验信息
- 命令 id 重复 → 宿主 `console.warn('[registry] duplicate command id')`，保留第一个（`src/renderer/src/core/registry.ts:123-127`）

## 8. 导航项点击内容栏空白

- `view` 字段引用的组件未在入口具名导出 → 宿主 warning `导航项 X 声明的视图组件 Y 未在扩展入口导出`（`src/renderer/src/core/host.ts:206`）
- 组件导出名与 `view` 值不一致（大小写敏感）
- 扩展未激活（见 #6）

## 9. 注册了未声明的命令：先 warning，紧接着抛错标红

**症状**：日志先出现 `[host] <id> 注册了未声明的命令 <cmd>（manifest contributes.commands 未包含）`（`src/renderer/src/core/host.ts:265-269`），紧接着 `[host] activate <id> failed Error: command not declared: <cmd>`，扩展在管理器标红 `activationError`。

**原因**：`api.registerCommand(id, handler)` 的命令 id 不在该扩展 manifest `contributes.commands`。warning 之后 `registry.setCommandHandler` 找不到已声明项会**直接 throw**（`src/renderer/src/core/registry.ts:193`）→ `plugin(api)` 抛错、本次激活失败。**这不是"只打一条 warning"**。

**修复**：把命令加进 manifest 的 `contributes.commands`（声明式模型——命令必须先声明，再绑定实现）。

## 10. 依赖环

**症状**：启动日志末尾 `[host] 启动完成: N 个扩展（X 启用 / Y 禁用），激活 Z，依赖环 a,b`（`src/renderer/src/core/host.ts:921-927`）。

**原因**：`extensionDependencies` 成环。

**行为**：环内扩展**不会被跳过**——拓扑排序仍把它们放进激活序列（`src/renderer/src/core/manifest.ts:163-168`），宿主照常激活（`src/renderer/src/core/host.ts:909-918`），只是排到最后。所以"没激活"要先查 #6 的其它原因，别被这一行误导。

**修复**：打破环（移除其中一个依赖），让依赖顺序可确定。

## 11. 扩展管理器显示"清单无效"

- `name`/`version`/`main` 缺失或格式错（校验规则见 `references/manifest-reference.md`）
- 详情页"校验信息"列出具体错误；修复后重启应用重新扫描

## 12. 用户扩展加载失败

**症状**：`[loader] 用户扩展 <id> manifest 读取失败或缺失`。

**原因**：`userData/extensions/<id>/` 下没有 manifest.json，或 manifest 校验失败（含 error 直接跳过）。

**修复**：确认目录结构与 manifest 合法；用户扩展入口按 `manifest.main` 经 `app://extensions/<id>/<main>` 加载（`src/renderer/src/core/loader.ts:104-122`）。

## 13. App 应用里出现重复/残留卡片

**结论**（宿主侧已修复，扩展不需要为此写兼容代码）：`appStore` 从 localStorage 恢复时按 id 去重并重建索引（`src/renderer/src/core/appStore.ts:20-50`），同 id 重复注册只更新不新建（`:61-74`），停用/卸载按 `extensionId` 清空其全部卡片（`:92-102`），启动时清理"扩展已不在"的孤儿卡片（`src/renderer/src/core/host.ts:839-845`）。

**扩展侧注意事项**：`api.app.register` 的 `id` 必须是稳定的唯一值（如 `todo.main`）；热重载/覆盖安装时宿主保证不产生重复卡片。

## 14. --debug-extension 调试扩展没被加载

**排查**：

- **先看这一行**：主进程启动时会打印 `[debug] 调试扩展 N 个: id@路径`；若打印的是
  `[debug] 未提供 --debug-extension（仅加载内置/已安装扩展）`，说明**参数没传进来**（不是清单或入口的问题）。
  开发版要写成 `npm run dev -- -- --debug-extension ...`：第一个 `--` 交给 npm，第二个才是 electron-vite 的 `--`；
  electron-vite 把 `--` 之后的参数序列化成 `ELECTRON_CLI_ARGS`（`node_modules/electron-vite/dist/cli.js:58-60`），
  启动 Electron 时再读回（`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:224`）——只写一个 `--`
  （`npm run dev -- --debug-extension ...`）时参数会被 electron-vite 自己的选项解析吃掉，`options['--']` 为空、不会传给 Electron
- 参数格式：`--debug-extension <id>@<路径>`；id 须匹配 `^[a-z0-9][a-z0-9._-]*$/i`（**不区分大小写**，`src/main/debug.ts:12`）；路径**可相对**（宿主按主进程 cwd `resolve`，`src/main/debug.ts:32`），解析后必须存在，否则该条被忽略并打 warn
- manifest 必须能经 `app://debug/<id>/manifest.json` 读到（协议只服务已声明的 id，`src/main/protocol.ts:48-58`）
- 看宿主日志 `[host] 启动完成: N 个扩展（X 启用 / Y 禁用），激活 Z，依赖环 …` 的**计数**是否把调试扩展算进去（该行只给数量、不列 id；id 与路径看 `[debug] 调试扩展 N 个: …`）；激活失败看扩展管理器详情页 `activationError`（调试扩展同样受声明式贡献点校验）
- 调试扩展**不做 .oix 安装**，文件就在参数给的目录里，所以 `api.ipc` 的 stdio 对端 cwd 是**调试目录/data**（见 #25）；`api.fs` / sqlite / python 的数据目录仍按 `userData/extensions/<id>/data` 走（`src/main/fs.ts:12-14`、`src/main/python.ts:34-36`）。该目录没有 `manifest.json`，主进程会打 `[capabilities] 跳过没有 manifest.json 的目录: <id>（扩展数据目录或调试扩展）`，属正常提示（`src/main/capabilities.ts:47`）

## 15. VS Code 断点不命中（app://debug）

**排查**：

- launch.json 的 `pathMapping` 前缀必须与 `app://debug/<id>/` 完全一致（id 大小写、目录尾斜杠）；改代码后需**重载 obox 窗口**（宿主在启动时收集扩展）
- `urlFilter` 只匹配 dev 渲染进程（electron-vite 默认 `http://localhost:5173`）；本仓库未固定 `server.port`（`electron.vite.config.ts:15-20`），端口被占用时 Vite 会顺延换端口 → `urlFilter` 需同步改。`references/guides-user.md` 里的 `launch.json` 模板**未实机验证**，照抄前先确认实际端口
- 打包版（file://）去掉 urlFilter 或改匹配
- 确认 attach 的是渲染进程（chrome attach + CDP 端口），不是主进程 inspector

## 16. 调试扩展也出现在 userData / 可被卸载

**原因**：混淆了"安装态"与"数据目录"。调试扩展（`--debug-extension`）**不做安装**——不写 manifest 到 userData、无安装登记、重启即消失。

**userData 下为什么还会有同名目录**：`api.fs` / sqlite / python 的数据目录固定按 `userData/extensions/<id>/data` 建（`src/main/fs.ts:12-14`、`src/main/sqlite.ts:34-37`、`src/main/python.ts:34-36`），调试扩展也照此写盘。这类只有 `data/`、没有 `manifest.json` 的目录不会被当成扩展加载（主进程按有无 manifest 过滤，`src/main/capabilities.ts:38-51`）。

**若管理器里出现可卸载项**：那是以前用同名 id 做的 .oix 安装态——先卸载安装态，再用调试参数加载。管理器里的调试扩展本身来源是 `debug`，调卸载会直接抛"调试扩展不占用安装态，无需卸载"（`src/renderer/src/core/host.ts:1088`）。

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

**兼容**：旧的固定文件 **`.uninstall.cjs`**（`spawn(process.execPath, [hookPath])`，5 秒超时）仍作为**回退**——仅当入口未导出 `uninstall` 时执行。

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

**原因**（宿主早期实现缺陷，已修复）：代理原先靠**环境变量**（`HTTP_PROXY`/`HTTPS_PROXY`/`NODE_TLS_REJECT_UNAUTHORIZED`）应用，但 Node 的全局 `fetch`（undici）与 Electron `net.request`（Chromium）**都不读这些变量**——实测把 `HTTP_PROXY` 指向不可达代理，`fetch` 仍直连成功。`ignoreSSL` 同理无效，且 `NODE_TLS_REJECT_UNAUTHORIZED=0` 会**全局**关闭证书校验（含更新下载），风险面过大。

**修复后机制**：宿主在请求真正经过的 session 上应用配置——

- 扩展联网：专用 session `obox-net` + `setProxy` / `setCertificateVerifyProc`
- 更新下载：electron-updater 自己的 session（`electron-updater`）+ 同一套应用逻辑；代理认证经 `autoUpdater.on('login')` 回填设置里的账号密码

**扩展侧注意事项**：不要自己读写代理环境变量——用 `api.proxy.get()` 读取配置，联网统一走 `api.net.fetch`（宿主自动应用）；`ignoreSSL` 现只作用于上述 session，不再是进程级全局开关。

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

**清单声明的通道（`contributes.ipcChannels`，issue #45）**：

- `connect('<id>')` 报 `invalid-declaration 清单里没有声明通道 x` → 检查 manifest 的 `contributes.ipcChannels`（名字、拼写）；非法声明会让**清单无效**（扩展标红），先看扩展管理器详情页的 `activationError`/校验信息
- **`connect()` 成功但请求立刻报 `not-connected`** → 十有八九是**对端一启动就退出了**，最常见原因是 `args` 里的相对路径写错：stdio 对端的 **cwd 是 `<扩展源目录>/data`**，而 `program` 相对**扩展源目录**解析（`src/main/ipc.ts:149-163`）。已安装扩展的扩展源目录是 `userData/extensions/<id>`，**调试扩展则是 `--debug-extension` 给的那个目录**——两者都由 `extensionSourceDir(id)` 决定（`src/main/paths.ts:29-31`）。脚本在 `<扩展源目录>/scripts/x.py` 时应写 `args: ['../scripts/x.py']`（写成 `scripts/x.py` 会让对端找不到文件后退出）。用 `api.ipc.onStderr()` 能看到对端报错文本
- 宿主旧实例被强杀后，它拉起的对端可能成为**孤儿进程**并占着同名端点，新实例会连到"没人应答"的旧连接上 → 先清掉残留子进程再重试

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
