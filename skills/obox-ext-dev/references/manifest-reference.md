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
| `title` | ✅ | 显示名（hover tooltip） |
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

## 校验规则（`core/manifest.ts`）

- `name` 必填且匹配 `^[a-z0-9][a-z0-9._-]*$` → 否则 **error**，不加载
- `version` 必填且为 semver → 否则 **error**
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
