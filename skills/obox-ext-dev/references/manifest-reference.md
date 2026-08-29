# Manifest Reference

扩展清单（manifest）声明扩展的身份、入口与贡献点。宿主扫描后统一解析注册（两阶段启动：先注册贡献点、后激活）。

## 文件位置

- **内置扩展**：`src/renderer/src/extensions/<id>/manifest.json`（随应用打包，只读不可卸载）
- **用户扩展**：`userData/extensions/<name>_<author>/manifest.json`（经 `app://extensions/<id>/manifest.json` 加载，可卸载；经 .oix 安装，目录名 = `<name>_<清洗后 author>`，清洗后为空则退化为纯 name）

## 字段

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | ✅ | string | 扩展 id。`^[a-z0-9][a-z0-9._-]*$`，全局唯一。建议短前缀（如 `ext-manager`、`app`、`todo`） |
| `version` | ✅ | string | semver（`1.0.0`）。非法版本=校验错误，扩展不加载 |
| `apiVersion` | ❌ | number | 扩展要求的 obox API 版本（非负整数）。缺失视为 `0`（兼容所有）。**高于 obox 当前 API 版本时校验 error，拒绝加载**。obox API 版本单源在根 `package.json` 的 `apiVersion` 字段（当前 `1`）；只在新版 API 不兼容旧版（破坏性签名变更）时递增 |
| `main` | ✅ | string | 入口文件相对路径。**用户扩展须为纯 JS（.js ESM）**——经 app:// 动态 import，无构建转换；内置扩展可用 `.ts`（Vite 转换） |
| `displayName` | ❌ | string | 扩展管理器展示名（默认回退 id） |
| `author` | ❌ | string | 作者 |
| `description` | ❌ | string | 简介 |
| `contributes` | ❌ | object | 贡献点声明（见下） |
| `extensionDependencies` | ❌ | string[] | 依赖的其他扩展 id；宿主按拓扑序激活，检测环并跳过 |
| `uninstall` | ❌ | string | 卸载钩子脚本（相对路径）；卸载时先执行再删目录（5 秒超时） |

## contributes 贡献点

### navItems（导航项）

```json
{
  "id": "my-ext.home",
  "title": "首页",
  "icon": "<svg viewBox='0 0 24 24' ...>...</svg>",
  "group": "top",
  "view": "HomeView",
  "badge": 0
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一，建议含扩展前缀 |
| `title` | ✅ | 显示名（hover tooltip / 状态栏当前视图名） |
| `titleKey` | ❌ | 语言包 key（可选）：存在时 tooltip/状态栏用 `t(titleKey)` 本地化（随语言切换），否则用 title 原文 |
| `icon` | ✅ | SVG 字符串（当前宿主渲染方式） |
| `group` | ❌ | `top`（可排序业务导航，默认）/ `bottom`（固定全局区） |
| `view` | ❌ | 内容栏视图组件 id——必须是扩展入口**具名导出**的组件名 |
| `badge` | ❌ | 数字徽标初值；运行时 `api.navbar.setBadge(id, n)` 更新 |

### statusBarItems（状态栏项）

```json
{
  "id": "my-ext.status",
  "name": "状态",
  "text": "就绪",
  "alignment": "right",
  "priority": 10,
  "command": "my-ext.do"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 扩展内唯一 |
| `name` | ✅ | 显示名（hover tooltip 兜底） |
| `text` | ❌ | 初始文本（支持 `$(icon)` 语法）；运行时 `api.statusBar.setText` 更新 |
| `alignment` | ❌ | `left` / `right`（默认 `right`） |
| `priority` | ❌ | 同侧数值大者靠左（左侧）/ 靠右（右侧）；同值按扩展 id 决胜 |
| `command` | ❌ | 点击绑定的命令 id（必须在 contributes.commands 声明） |

### commands（命令）

```json
{
  "command": "my-ext.do",
  "title": "执行",
  "category": "我的扩展",
  "palette": true,
  "when": ""
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `command` | ✅ | 全局唯一，建议 `<扩展名>.<动作>` |
| `title` | ✅ | 命令面板显示标题 |
| `category` | ❌ | 分类（面板中前缀显示 "分类: 标题"） |
| `palette` | ❌ | 是否出现在命令面板（默认 `true`；`false` 隐藏内部命令） |
| `when` | ❌ | 显隐控制（首版仅 `'false'` 即隐藏有效，其余字符串恒真） |

> 命令实现（handler）不在 manifest 里，由扩展激活时 `api.registerCommand(id, handler)` 绑定。

### themes（主题贡献点）

主题扩展声明一组 CSS 变量 token，设置"外观"节点可选择套用：

```json
{
  "contributes": {
    "themes": [
      {
        "id": "my-theme.dark",
        "label": "深色",
        "tokens": { "--bg": "#1e1e1e", "--fg": "#cccccc", "--accent": "#007acc" }
      }
    ]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 全局唯一，建议 `<扩展名>.<主题名>` |
| `label` | ✅ | 显示名（设置下拉框展示） |
| `tokens` | ✅ | CSS 变量组（`--xxx` → 值），套到 `:root` |

宿主已内置 `theme-dark`（深色）与 `theme-light`（浅色）主题扩展。**完整 token 表与主题编写指南见 `themes-settings.md`**（含背景/文字/语义色/字体/字号/图标尺寸 token；SVG 用 `currentColor` 继承、尺寸用 `--nav-icon-size`/`--icon-size`）。子窗口 iframe（srcdoc）自动注入当前主题 token，扩展页面用 `var(--bg)` 等即可跟随主题。

### i18n（扩展语言包，manifest 声明）

```json
{
  "contributes": {
    "i18n": {
      "zh": { "hello": "你好" },
      "en": { "hello": "Hello" }
    }
  }
}
```

与运行时 `api.i18n.registerMessages` 等价；`api.i18n.t(key)` 按当前语言取文案。

### settings（扩展设置 schema，manifest 声明）

对齐 VS Code contributes.configuration 简化版；与运行时 `api.settings.register` 等价：

```json
{
  "contributes": {
    "settings": {
      "id": "my-ext.settings",
      "title": "我的扩展设置",
      "fields": [
        { "key": "my-ext.interval", "label": "刷新间隔", "type": "number", "default": 30 }
      ]
    }
  }
}
```

设置"扩展"节点按扩展名展示其设置页。

### updater（更新提供者，manifest 声明）

声明该扩展为"更新提供者扩展"：提供 obox 更新能力（检查/下载/安装），在**设置-更新**中选择生效（只能一个；无默认更新源）。

```json
{
  "contributes": {
    "updater": {
      "feedUrl": "https://example.com/updates"
    }
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `feedUrl` | ❌ | 更新源 URL（electron-updater generic provider）；**推荐用 `api.update.resolveFeed(repo)` 动态解析"最后一次编译"的 release**（见 `api-reference.md`），feedUrl 仅作兜底（无 resolveFeed 的旧宿主用 latest/download） |

选中后扩展可调用 `api.update.*`（详见 `api-reference.md`）。**只能有一个更新提供者生效**；未选择时不检查更新。

### keybindings（快捷键，manifest 声明）

把已声明命令绑定默认组合键，复用宿主快捷键体系（**冲突检测 / 用户可在设置-快捷键修改 / 持久化 / 设置页展示**）：

```json
{
  "contributes": {
    "commands": [{ "command": "my-ext.sync", "title": "同步", "category": "我的扩展" }],
    "keybindings": [{ "command": "my-ext.sync", "key": "Ctrl+Shift+K" }]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `command` | ✅ | 命令 id（**必须**在 contributes.commands 声明，否则 warning 且不注册） |
| `key` | ✅ | 组合键字符串（`Ctrl+Alt+Shift` 修饰 + 主键，如 `Ctrl+Shift+K`；主键单字符自动大写） |

- 与内置/其他扩展快捷键**冲突时 warning 且不注册**（该扩展其余功能不受影响）
- 默认键冲突时用户仍可在设置-快捷键里改（改后以用户值为准）

### menus（上下文菜单，manifest 声明）

把已声明命令挂到该扩展 **App 卡片**的右键菜单：

```json
{
  "contributes": {
    "commands": [{ "command": "my-ext.sync", "title": "同步", "category": "我的扩展" }],
    "menus": [{ "command": "my-ext.sync" }]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `command` | ✅ | 命令 id（**必须**在 contributes.commands 声明，否则 warning 且不注册） |
| `when` | ❌ | 显隐条件（首版仅 `'false'` 即隐藏，其余恒真） |

- 右键该扩展注册的 App 卡片即弹出菜单；菜单项执行命令 handler

### views（树视图，manifest 声明）

在导航区贡献树形视图（数据源由扩展激活时 `api.views.registerTreeProvider(viewId, provider)` 提供）：

```json
{
  "contributes": {
    "views": [
      { "id": "my-ext.tree", "title": "我的树", "icon": "<svg viewBox='0 0 24 24'>...</svg>" }
    ]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 视图 id（全局唯一，建议含扩展前缀；数据源注册用同一 id） |
| `title` | ✅ | 显示名（导航 tooltip / 内容区标题） |
| `icon` | ✅ | 图标（SVG 字符串） |
| `group` | ❌ | `top`（默认）/ `bottom` |

- 声明即注册为导航项（内容区渲染内置树组件）；节点点击执行 `command`（TreeItem 上声明，`args` 作参数）

## 校验规则（`core/manifest.ts`）

- `name` 必填且匹配 `^[a-z0-9][a-z0-9._-]*$` → 否则 **error**，不加载
- `version` 必填且为 semver → 否则 **error**
- `apiVersion`（可选）：非负整数，否则 **error**；`apiVersion > obox 的 API 版本` → **error**（"需要 obox API vN 或更高"），扩展不加载
- `main` 必填 → 否则 **error**
- `contributes` 必须是对象；`extensionDependencies` 必须是字符串数组；不能依赖自身 → error
- 导航项缺 `id`/`title`/`icon`、状态栏项缺 `id`/`name`、命令缺 `command`/`title` → **warning**（该项跳过，扩展仍加载）
- 导航项 `view` 未在扩展入口具名导出 → **warning**
- 校验消息收集进扩展的 `validations`，在扩展管理器详情页展示；含 error 的扩展 `isValid=false`，不加载但出现在管理列表标红

## 扩展 id 与命令 id 约定

- 扩展 id：`my-ext`（连字符小写）
- 命令 id：`<扩展名>.<动作>`（`my-ext.do`）
- 导航/状态栏/App 卡片 id：建议含扩展前缀（`my-ext.home`）
- 内置扩展前缀已用：`ext-manager`（扩展管理器）、`app`（应用）
