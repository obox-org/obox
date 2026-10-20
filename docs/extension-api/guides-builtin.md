# 内置扩展开发指南（改 obox 仓库源码）

**内置扩展**：源码在 `src/renderer/src/extensions/<id>/`，TypeScript + Vue SFC，随应用打包、开机即加载、**不可卸载**（`core/host.ts:1198`）。
若你的扩展要独立仓库、`.oix` 分发、纯 JS 入口 —— 那是用户扩展，读 [guides-user.md](guides-user.md)。

前置：贡献点字段查 [manifest-reference.md](manifest-reference.md)；运行时 API 查 [api-reference.md](api-reference.md)；踩坑查 [troubleshooting.md](troubleshooting.md)。流程（提问 → spec → 确认 → 设计 → 开发 → 测试审视）见 [workflow.md](workflow.md)。

> 代码位置写法：`src/…` 是仓库路径；其余短路径相对 `src/renderer/src/`（如 `core/host.ts`）。

## 0. 运行位置：内置扩展在渲染进程（与用户扩展不同）

obox 有两个扩展运行时。**内置扩展跑在渲染进程**（Renderer Runtime），用户扩展跑在 **Extension Host Process**（独立 Node 进程）：

|              | **内置扩展**（本文，改 obox 仓库源码）                            | **用户扩展**（[guides-user.md](guides-user.md)，`.oix`）                    |
| ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 跑在哪       | **渲染进程**（与 UI 同一个进程）                                  | **Extension Host Process**（独立 Node 进程）                                |
| Node         | **没有**（能力全部经注入的 `api` 走主进程）                       | **完整 Node**（`node:fs` / `node:child_process` / `node:sqlite` 都可用）    |
| DOM          | **有**（可以直接写 Vue 组件 / 摸 `document`、`localStorage`）      | **没有**（`document` / `window` / `localStorage` 都不存在）                  |
| 界面         | Vue SFC + `navItems[].view` 具名导出组件（本文 §5）                | `app://` 静态页（App 卡片 / overlay）+ 树视图数据源                         |
| 激活         | **立即激活**，不参与懒激活（见下）                                | 按 `activationEvents` 懒激活（缺省 `*` = 立即）                             |

- **`api` 交付方式相同**：入口 `export default function (api) {...}`，`api` 由宿主构造后传入。内置扩展跑在**渲染侧运行时**（Renderer Runtime，与 UI 同进程），所以跨进程序列化约束（函数/类实例过不去）**只对用户扩展生效**。
- **内置扩展不能懒激活**：`core/host.ts` 在阶段二把它**立即激活**，清单里写 `activationEvents` 对内置扩展**无效**（ADR-0026 决策 6：只有用户扩展参与懒激活）。所以内置扩展的 `plugin(api)` 里别做重活——那会直接拖慢首屏。要"延后"请自己在 `plugin` 里用 `api.timer` / 空闲回调，而不是指望清单字段。
- **内置扩展之间的事件是通的**（同一运行时）；但**收不到用户扩展的 `emit`**（用户扩展在另一个进程，`on`/`emit` 不跨运行时）。跨运行时的数据请走贡献点/`appStore` 与 `api.app.onMessage` 消息桥。
- **`api.executeCommand` 执行不到内置扩展的命令**（命令表在宿主进程里，只有用户扩展的命令）——内置扩展之间请直接调函数或走贡献点。

## 1. 先读现状

- 入口文件名**固定** `index.ts`：宿主用 Vite 的 `import.meta.glob('../extensions/*/index.ts')` 收集内置扩展（`core/loader.ts:15,34-39`），改名即不被收集。
- 打开 `src/renderer/src/extensions/` 挑一个形态最接近的现有扩展照抄结构：`ext-manager/`（命令 + 状态栏 + 视图）、`app/`（App 卡片 + 子窗口）、`settings/`（设置页）。
- 需要新增/修改宿主 API 或主进程能力 → **停下来问**，别顺手改宿主（见 `workflow.md` 的三条硬边界）。

## 2. 建目录 / 脚手架

```bash
node skills/obox-ext-init/scripts/create-extension.mjs my-hello --title "你好" --desc "示例扩展"
```

生成 `src/renderer/src/extensions/my-hello/{manifest.json,index.ts,HelloView.vue}`；目录已存在则中止（不覆盖）。手工建目录等价，最少需要 `manifest.json` + `index.ts` 两个文件。

## 3. manifest：贡献点全部声明式

```json
{
  "name": "my-hello",
  "version": "1.0.0",
  "displayName": "你好",
  "author": "Obox",
  "description": "示例扩展",
  "main": "./index.ts",
  "contributes": {
    "navItems": [
      {
        "id": "my-hello.main",
        "title": "你好",
        "titleKey": "navbar.myHello",
        "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'><circle cx='12' cy='12' r='9'/></svg>",
        "group": "top",
        "view": "HelloView"
      }
    ],
    "statusBarItems": [
      {
        "id": "my-hello.status",
        "name": "你好状态",
        "text": "就绪",
        "alignment": "right",
        "priority": 5
      }
    ],
    "commands": [
      { "command": "my-hello.say", "title": "打个招呼", "category": "你好", "palette": true }
    ]
  }
}
```

三条硬规则：

- **元数据只写在 manifest**，代码里不做注册（`core/host.ts:157` 按声明注册贡献点），代码只 `api.registerCommand` 绑实现。
- **命令必须先声明**：未声明的命令由 `registry.setCommandHandler` **直接抛错**（`core/registry.ts:203`），会让 `plugin(api)` 抛错、扩展标红 `activationError`（`core/host.ts:290-305`）——不是 warning。
- **状态栏项 id 必须与声明一致**：`api.statusBar.setText` 找不到条目时静默无效（`core/host.ts:323-326`）。

命名与数组形状（`ipcChannels` / `keybindings` / `menus` / `views` 等）见 [manifest-reference.md](manifest-reference.md)。

### 中英双语：`titleKey` + 宿主词条

`titleKey` 由**宿主** vue-i18n 解析，而且**只有导航项与树视图支持它**（`components/NavBar.vue:13-16`、`components/TreeView.vue:65`；`components/StatusBar.vue:15-19` 解析的是**当前导航项**的 key，不是状态栏项），所以词条要加进宿主语言包，而不是扩展自己的语言包：

| 文件                                  | key              | 值      |
| ------------------------------------- | ---------------- | ------- |
| `src/renderer/src/i18n/locales/zh.ts` | `navbar.myHello` | `你好`  |
| `src/renderer/src/i18n/locales/en.ts` | `navbar.myHello` | `Hello` |

现有 `navbar.extensions` / `navbar.apps` / `navbar.settings` 就是这类词条（`i18n/locales/zh.ts:33-37`）。**`contributes.i18n` 与 `api.i18n.*` 是扩展自己的命名空间**（`core/extensionI18n.ts:29-34`，`core/host.ts:436`），只服务 `api.i18n.t()`，**不会被 `titleKey` 命中**；不写 `titleKey` 则回退 `title` 原文（英文界面会显示中文）。

**命令（`contributes.commands`）与状态栏项（`contributes.statusBarItems`）没有 `titleKey` 字段**（`api/contributions.ts:33-60`）——给它们加词条是静默无效的。要双语只能自己接 `api.i18n`，并在语言变更时重新刷新文本（命令面板标题直接取 `title` 原文，状态栏文本用 `setText` 覆盖）。

## 4. 入口 `index.ts`

```ts
import type { ExtensionActivationApi } from '../../../../api'
import HelloView from './HelloView.vue'

// 具名导出：manifest 的 navItems[].view 按名字取组件（core/host.ts:271-275）
export { HelloView }

export default function myHello(api: ExtensionActivationApi): () => void {
  // 绑定命令实现（manifest 已声明 my-hello.say）
  const say = api.registerCommand('my-hello.say', async () => {
    api.statusBar.setText('my-hello.status', '已打招呼')
    return 'hello'
  })

  const off = api.on('my-hello:greeted', (payload) => {
    console.log('[my-hello] greeted', payload)
  })

  return () => {
    say.dispose()
    off.dispose()
  }
}
```

- 类型从 `../../../../api` 导入（单包共享类型，`src/api/index.ts:1-12`）。
- `default` 插件函数在激活时调用，返回的清理函数被收集；激活抛错时宿主**立即释放本次已注册的副作用**（`core/host.ts:297-305`）。
- **视图必须具名导出**：`navItems[].view` 只在入口模块里按名字取（`core/host.ts:249-255`），缺失只有 warning，表现为点开导航项是空白占位（`components/ContentArea.vue:19-21`）。
- 命令 / 导航 id **全局唯一**：命令同名时只允许声明它的扩展绑定实现，别的扩展绑会被静默忽略（`core/registry.ts:206-211`）；**命令 id 跨扩展重复**时保留先注册者，冲突写进后注册方扩展的 `validations`（warning，`core/registry.ts:122-140`）。

## 5. 视图组件

```vue
<script setup lang="ts">
// 普通 Vue 3 组件；内容栏用 KeepAlive 保留状态（components/ContentArea.vue:34-41）
</script>

<template>
  <div class="hello">
    <h1>你好，Obox</h1>
  </div>
</template>

<style scoped>
.hello {
  padding: 16px;
  color: var(--fg, #cccccc);
  background: var(--bg-panel, #252526);
}
</style>
```

- 样式用 `<style scoped>`；颜色/尺寸一律 `var(--token, fallback)`，别写死颜色（token 清单见 [themes-settings.md](themes-settings.md)；真实用例 `extensions/ext-manager/ExtensionManagerView.vue:422`）。
- 宿主给导航视图传 `active-nav-id` prop（`components/ContentArea.vue:39`）。
- 需要弹出独立窗口的富界面 → 注册 App 卡片（写法见 [guides-user.md](guides-user.md) 的「App 卡片与子窗口」，两类扩展共用同一套 `api.app`）。

## 6. 验证

```bash
npm run dev
```

- 左栏出现导航项（`group: 'top'`），点击渲染视图；状态栏项与 `Ctrl+Shift+P` 命令面板出现对应条目（`palette: false` 不出现）。
- 扩展管理器**默认隐藏内置扩展**，勾选工具栏「显示内置」才看到（`extensions/ext-manager/ExtensionManagerView.vue:30-37,261-263`）。
- 启动日志 `[host] 启动完成: N 个扩展（X 启用 / Y 禁用），激活 Z，依赖环 …`（`core/host.ts:1024-1031`）：`Z < X` 说明有扩展未激活，去扩展管理器详情页看 `activationError`。

改 `src/` 必须过质量门槛：`npm run typecheck`、`npm run lint`、`npm test`（只查渲染进程可用 `npm run typecheck:web`）。

## 7. 提交

分支命名、提交信息、PR、CI 门禁、依赖审计一律按仓库根的 `AGENTS.md` 执行，本文件不重复。
