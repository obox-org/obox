# Troubleshooting

Obox 扩展开发中遇到的常见问题与修复。**遇到新坑后，把解法追加到这里（保持持续更新）。**

## 1. iframe 内联 onclick 不生效（CSP 阻止）

**症状**：App 子窗口的 iframe（srcdoc 或 app:// 页面）里 `<button onclick="...">` 点击无反应；dev 日志出现：
`Executing inline event handler violates the following Content Security Policy directive 'script-src 'self''`

**原因**：渲染进程的 CSP `script-src 'self'` 禁止内联事件处理器。

**修复**：用外部 `<script>` 块 + `addEventListener`，或 postMessage 模式：

```html
<script>
  document.getElementById('close').addEventListener('click', () => {
    parent.postMessage({ source: 'obox-app', action: 'close' }, '*')
  })
</script>
```

## 2. Windows 下 Vite watcher EBUSY 崩溃

**症状**：`npm run dev` 崩溃，日志：
`Error: EBUSY: resource busy or locked, watch '...\.NavBar.vue.<pid>.<uuid>.tmpdir\...'`

**原因**：编辑器（本 DSH 环境）原子写文件时产生临时目录，Vite watcher 尝试 watch 它，Windows 报 EBUSY。

**修复**：已在 `electron.vite.config.ts` 的 `server.watch.ignored` 配置忽略 `\.<name>.<pid>.<uuid>.tmpdir` 模式。若再次出现：删残留 tmpdir 后重启 dev：

```powershell
Get-ChildItem src -Recurse -Force -Filter "*.tmpdir" -Directory | Remove-Item -Recurse -Force
```

## 3. 扩展收集到但未激活（激活 0）

**症状**：日志 `[host] 启动完成: 1 个扩展（1 启用 / 0 禁用），激活 0`。

**原因**：入口未导出 `default` 插件函数，或入口加载/执行抛错。

**排查**：
- 入口必须有 `export default function(api) {...}`
- 扩展管理器详情页看 `activationError`（激活失败原因）
- dev 日志看 `[host] activate <id> failed <error>`

## 4. 命令面板命令不出现

- `palette: false` 的命令被过滤（设计如此，内部命令用）
- 命令未通过校验（缺 `command`/`title`）→ 详情页看校验信息
- 命令 id 重复 → 宿主 `console.warn('[registry] duplicate command id')`，保留第一个

## 5. 导航项点击内容栏空白

- `view` 字段引用的组件未在入口具名导出 → 宿主 warning `导航项 X 声明的视图组件 Y 未在扩展入口导出`
- 组件导出名与 `view` 值不一致（大小写敏感）
- 扩展未激活（见 #3）

## 6. 注册了未声明命令的 warning

**症状**：`[host] <id> 注册了未声明的命令 <cmd>（manifest contributes.commands 未包含）`

**原因**：`api.registerCommand(id, handler)` 的命令 id 不在该扩展 manifest `contributes.commands`。

**修复**：把命令加进 manifest 的 `commands` 数组（声明式模型——命令必须先声明，再绑定实现）。

## 7. 依赖环

**症状**：`[host] 启动完成: ... 依赖环 a,b`（host 日志标注）。

**原因**：`extensionDependencies` 成环。

**修复**：打破环（移除其中一个依赖），环内扩展会被跳过激活。

## 8. App 子窗口标题序号不对

`multiOpen: true` 时标题应为 `name 2`、`name 3`…。若序号重复，说明主进程 `appWindows` 跟踪残留——重启应用（跟踪随主进程重置）。

## 9. 扩展管理器显示"清单无效"

- `name`/`version`/`main` 缺失或格式错（校验规则见 `references/manifest-reference.md`）
- 详情页"校验信息"列出具体错误；修复后重启应用重新扫描

## 10. HMR 后重复注册/状态残留

**原因**：热重载时扩展模块重新激活，旧注册未清理。

**修复**：确保插件函数返回 cleanup（dispose 全部注册），或所有注册的 Disposable 有效。必要时候选重启应用（dev 下 F5/重开窗口）。

## 11. 用户扩展加载失败

**症状**：`[loader] 用户扩展 <id> manifest 读取失败或缺失`。

**原因**：`userData/extensions/<id>/` 下没有 manifest.json，或 manifest 校验失败（含 error 直接跳过）。

**修复**：确认目录结构与 manifest 合法；用户扩展入口按 `manifest.main` 经 `app://extensions/<id>/<main>` 加载。
