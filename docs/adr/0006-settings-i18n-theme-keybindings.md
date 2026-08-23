# 设置系统：统一设置存储 + i18n + 主题扩展 + 快捷键

新增内置"设置"扩展（左侧树：外观/语言/快捷键/扩展），并建立四个子系统的统一模型：

1. **多语言（vue-i18n）**：宿主与内置扩展文案全部改 `$t` key；切换立即生效并持久化；语言下拉显示各语言本地化名称（中文 → "中文"、English → "English"）。扩展经 `api.i18n` 使用独立命名空间语言包（manifest `contributes.i18n` 或运行时 `registerMessages`）。
2. **主题（主题扩展）**：新增 `contributes.themes` 贡献点——主题扩展声明 CSS 变量 token 组；内置 Dark/Light 主题扩展；设置"外观"选择后套到 `:root` + 持久化。子窗口 srcdoc 自动注入当前主题 token，扩展页面用 `var(--xxx)` 跟随主题。
3. **快捷键**：内置快捷键注册表（如 Ctrl+Shift+P 命令面板）+ 修改 + 冲突检测 + 持久化；扩展快捷键后续版本。
4. **扩展设置项（双通道）**：`api.settings.register` 运行时注册 + manifest `contributes.settings` 声明 schema（对齐 VS Code configuration 简化版），统一渲染通用表单。

**统一设置存储**：`stateStore` 新增 `settings` 命名空间（userData JSON），主题/语言/快捷键/扩展设置均为其中的设置项，变更立即生效并通知订阅者。

选择 vue-i18n 而非自研：成熟（复数/插值/回退），虽增加依赖但 i18n 是横切需求，值得。主题用"扩展声明 CSS 变量"而非代码注册：保持声明式贡献点模型一致，且主题可随扩展分发/卸载。

Status: accepted
