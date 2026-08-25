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

