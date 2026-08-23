# 主题与设置参考

Obox 的主题与设置系统：主题由**主题扩展**提供（CSS 变量 token），设置由内置"设置"扩展管理（左侧树：外观/语言/快捷键/扩展）。

## 主题系统

### 机制

- 主题 = 主题扩展 `contributes.themes` 声明的 CSS 变量 token 组
- 宿主收集所有主题扩展的贡献，设置"外观"节点下拉选择；选中后把 token 套到 `document.documentElement`（`:root`）并持久化
- 宿主 UI 组件用 `var(--token, fallback)` 引用 token，主题切换即时生效
- 用户扩展的 App 子窗口 iframe（srcdoc）**自动注入当前主题 token**，扩展页面用 `var(--token)` 即可跟随主题；`url` 场景由扩展自行处理

### Token 全量参考

| Token | 默认值（Dark） | 说明 |
|---|---|---|
| `--bg` | `#1e1e1e` | 全局背景（内容区） |
| `--bg-panel` | `#252526` | 面板背景（卡片/弹窗/命令面板） |
| `--bg-sidebar` | `#333333` | 侧栏/导航栏背景 |
| `--bg-titlebar` | `#323233` | 标题栏背景 |
| `--bg-input` | `#3c3c3c` | 输入框/下拉/按钮背景 |
| `--border` | `#3c3c3c` | 边框 |
| `--fg` | `#cccccc` | 主文字色 |
| `--fg-dim` | `#6e6e6e` | 次要文字/图标色 |
| `--fg-bright` | `#ffffff` | 高亮文字（标题/激活项） |
| `--fg-link` | `#75beff` | 链接/信息色 |
| `--fg-error` | `#f48771` | 错误文字/边框 |
| `--fg-warning` | `#cca700` | 警告文字 |
| `--fg-success` | `#4ec9b0` | 成功文字 |
| `--accent` | `#007acc` | 强调色（激活项背景/徽标/选中） |
| `--hover-bg` | `rgba(255,255,255,.1)` | 悬停背景 |
| `--selection-bg` | `#094771` | 选中背景（命令面板条目） |
| `--nav-icon` | `#858585` | 导航栏图标默认色 |
| `--statusbar-bg` | `#007acc` | 状态栏背景 |
| `--statusbar-fg` | `#ffffff` | 状态栏文字 |
| `--font-family` | 系统字体栈 | 全局字体族 |
| `--font-size` | `13px` | 全局基准字号 |
| `--font-size-sm` | `12px` | 小字号（提示/版本号） |
| `--font-size-lg` | `16px` | 大字号（标题/命令面板输入） |
| `--nav-icon-size` | `24px` | 导航栏图标尺寸 |
| `--icon-size` | `24px` | 通用图标尺寸 |

### SVG 颜色与尺寸

- SVG 图标用 `currentColor` 继承父元素颜色（导航栏继承 `--nav-icon`，正文继承 `--fg`），**不单独设颜色 token**
- 尺寸：导航栏图标用 `var(--nav-icon-size)`，通用图标用 `var(--icon-size)`

### 编写主题扩展

```json
{
  "name": "my-theme",
  "version": "1.0.0",
  "displayName": "我的主题",
  "main": "./index.ts",
  "contributes": {
    "themes": [
      {
        "id": "my-theme.blue",
        "label": "蓝色",
        "tokens": {
          "--bg": "#0d1117",
          "--fg": "#c9d1d9",
          "--accent": "#58a6ff"
        }
      }
    ]
  }
}
```

- 只需声明想覆盖的 token，未声明的沿用默认值（`main.css` 的 `:root` 回退）
- 主题扩展入口保持最小：`export default function() { return () => undefined }`
- 宿主已内置 `theme-dark` / `theme-light`；设置"外观"下拉列出所有主题扩展

## 设置系统

### 左侧树节点

- **外观**：主题下拉（主题扩展贡献）
- **语言**：语言下拉（本地化名称：中文 → "中文"、English → "English"）
- **快捷键**：内置快捷键修改 + 冲突检测
- **扩展**：非内置扩展的设置页（按扩展名展开）

### 扩展设置页（双通道）

1. **运行时**：`api.settings.register({ id, title, fields })`
2. **manifest 声明**：`contributes.settings`（对齐 VS Code configuration 简化版）

字段类型 `SettingField`：`text` / `number` / `boolean` / `select`。设置值存统一设置存储（`stateStore.settings`，userData JSON），`api.settings.set` 立即持久化并通知。

### 快捷键

- 内置快捷键：`app.showCommands`（默认 `Ctrl+Shift+P` 命令面板）
- 修改：设置"快捷键"页点击编辑，按下新组合（Esc 取消）
- 冲突检测：同键被其他命令占用时提示，不覆盖
- 持久化：设置存储 `keybinding.<command>`；重置恢复默认

### 语言（i18n）

- 宿主与内置扩展文案全部 `$t` key（vue-i18n）
- 扩展语言包：`api.i18n.registerMessages` 或 manifest `contributes.i18n`，独立命名空间
- 切换立即生效并持久化（`i18n` 模块，`setLocale`）
