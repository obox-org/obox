# 设置系统：统一设置存储 + i18n + 主题扩展 + 快捷键

新增内置"设置"扩展（左侧树：外观/语言/快捷键/扩展），并建立四个子系统的统一模型：

1. **多语言（vue-i18n）**：宿主与内置扩展文案全部改 `$t` key；切换立即生效并持久化；语言下拉显示各语言本地化名称（中文 → "中文"、English → "English"）。扩展经 `api.i18n` 使用独立命名空间语言包（manifest `contributes.i18n` 或运行时 `registerMessages`）。
2. **主题（主题扩展）**：新增 `contributes.themes` 贡献点——主题扩展声明 CSS 变量 token 组；内置 Dark/Light 主题扩展；设置"外观"选择后套到 `:root` + 持久化。子窗口 srcdoc 自动注入当前主题 token，扩展页面用 `var(--xxx)` 跟随主题。
3. **快捷键**：内置快捷键注册表（如 Ctrl+Shift+P 命令面板）+ 修改 + 冲突检测 + 持久化；扩展快捷键后续版本。
4. **扩展设置项（双通道）**：`api.settings.register` 运行时注册 + manifest `contributes.settings` 声明 schema（对齐 VS Code configuration 简化版），统一渲染通用表单。

**统一设置存储**：`stateStore` 新增 `settings` 命名空间（userData JSON），主题/语言/快捷键/扩展设置均为其中的设置项，变更立即生效并通知订阅者。

选择 vue-i18n 而非自研：成熟（复数/插值/回退），虽增加依赖但 i18n 是横切需求，值得。主题用"扩展声明 CSS 变量"而非代码注册：保持声明式贡献点模型一致，且主题可随扩展分发/卸载。

Status: accepted

## 修订：快捷键"捕获态"是全局状态（2026-10-13 落地，issue #85）

决策 3（快捷键：注册表 + 修改 + 冲突检测 + 持久化）**契约不变**，本次补齐"改键时按键归谁"的缺失设计：

1. **捕获态放在 `keybindingStore` 上**（`setCapturing` / `isCapturing`），**不是**设置页组件的局部状态。
   原因：全局快捷键的匹配发生在 `App.vue` 的 `window.addEventListener('keydown')`，组件内部 `@keydown.stop`
   挡不住同一个按键的**双份派发**。约定：捕获期间 `keybindingStore.matchKeydown(e)` **一律返回 `null`**，
   全局处理器另加一层显式早退（双保险）。
2. **捕获框必须真的获焦**：覆盖层由 `v-if` 渲染，`startCapture()` 里 `await nextTick()` 后 `captureBox.focus()`；
   否则 `@keydown` 永远不触发（`document.activeElement` 停在 `<body>`）——这是"快捷键不支持配置"的直接原因。
3. **捕获必须能退出且不泄漏**：`Esc` / 取消按钮 / 覆盖层点击 / 改键成功 / 组件 `onUnmounted` 都走同一个
   `cancelCapture()`；漏掉卸载路径会把全局快捷键**永久挡住**。
4. **设置页首屏取值统一为"持久化优先 + 响应式后续"**（同一次修订）：设置页各区分的首屏值一律来自
   `stateStore` 的持久化快照（`localStorage['obox:state:v1'].settings`），且**不得**在 `setup` 阶段取成普通
   `ref` 快照；确有可编辑输入的（代理配置）用 `reactive` + `stateStore.onSettingsChanged` 同步，并用内部标志
   抑制写回回环。`test/settings-first-paint.test.ts` 与 `test/settings-view-wiring.test.ts` 分别钉住取数路径与接线。

**明确不做**：把捕获态做成"暂停全局快捷键"的通用总线（只为改键一个场景引入额外抽象不划算）；捕获期间
仍然允许 `Esc` 由捕获框自己消费（不再是全局快捷键）。

