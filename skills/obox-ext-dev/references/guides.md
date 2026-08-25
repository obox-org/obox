# Guides

从零写一个 Obox 内置扩展，并注册到 App（应用）弹出独立子窗口。

## 前置

- 理解 manifest/贡献点：读 `references/manifest-reference.md`
- 理解扩展 API：读 `references/api-reference.md`
- 可参考已有示例：`src/renderer/src/extensions/ext-manager/`（命令+状态栏+视图）、`src/renderer/src/extensions/app/`（App 注册视图+子窗口）

## 教程：从零写一个扩展

### 1. 脚手架

推荐用脚本生成骨架（见 `scripts/README.md`）：

```bash
node skills/obox-ext-dev/scripts/create-extension.mjs my-hello
```

或在 `src/renderer/src/extensions/` 手工创建 `my-hello/`：

```
src/renderer/src/extensions/my-hello/
├── manifest.json
└── index.ts
```

### 2. manifest.json

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
        "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'><path d='M12 3l9 5-9 5-9-5 9-5z'/></svg>",
        "group": "top",
        "view": "HelloView"
      }
    ],
    "statusBarItems": [
      { "id": "my-hello.status", "name": "你好状态", "text": "就绪", "alignment": "right", "priority": 5 }
    ],
    "commands": [
      { "command": "my-hello.say", "title": "打个招呼", "category": "你好", "palette": true }
    ]
  }
}
```

### 3. 入口 index.ts

```ts
import type { ExtensionActivationApi } from '../../core/types'
import HelloView from './HelloView.vue'

export { HelloView }  // 具名导出：导航项 view 字段引用

export default function myHello(api: ExtensionActivationApi): () => void {
  // 绑定命令实现（manifest 已声明）
  const say = api.registerCommand('my-hello.say', async () => {
    api.statusBar.setText('my-hello.status', '已打招呼')
    api.emit('my-hello:greeted', { at: Date.now() })
    return 'hello'
  })
  // 事件订阅
  const off = api.on('my-hello:greeted', (payload) => {
    console.log('[my-hello] greeted', payload)
  })

  return () => {
    say.dispose()
    off.dispose()
  }
}
```

### 4. 视图组件 HelloView.vue

```vue
<script setup lang="ts">
// 普通 Vue 3 组件；内容栏 keep-alive 保留状态
</script>

<template>
  <div style="padding: 16px">
    <h1>你好，Obox</h1>
    <p>这是一个扩展视图</p>
  </div>
</template>
```

### 5. 验证

```bash
npm run dev
```

- 左侧导航栏出现"你好"图标（顶部组），点击内容栏渲染 HelloView
- 状态栏右侧出现"就绪"，点击无命令不响应（未绑 command）
- Ctrl+Shift+P 命令面板出现"你好: 打个招呼"
- 扩展管理器默认**只显示用户扩展**（内置扩展隐藏）；勾选工具栏"显示内置"后出现 my-hello（内置徽标）。内置扩展（含本示例）经"显示内置"开关查看

## 教程：注册到 App（应用）弹出子窗口

### 1. 在入口注册插件卡片

```ts
export default function myHello(api: ExtensionActivationApi): () => void {
  const appCard = api.app.register({
    id: 'my-hello.demo',
    name: '你好演示',
    version: '1.0.0',
    author: 'Obox',
    description: '点击弹出独立窗口',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/></svg>',
    html: `<!doctype html>
<html><body style="margin:0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
  <div style="text-align:center">
    <h1>独立窗口内容</h1>
    <button id="close">关闭</button>
  </div>
  <script>
    // 注意：不能用内联 onclick（CSP 阻止），用外部脚本 + postMessage
    document.getElementById('close').addEventListener('click', () => {
      parent.postMessage({ source: 'obox-app', action: 'close' }, '*')
    })
  <\/script>
</body></html>`,
    multiOpen: true,
    width: 800,
    height: 600
  })

  return () => { appCard.dispose() }
}
```

### 2. 验证

- 左侧导航"应用"（App 扩展）→ Grid 出现"你好演示"卡片（icon/名称/版本/作者/简介）
- 点击卡片 → 独立子窗口弹出，标题栏显示"你好演示"，内容栏 iframe 渲染 HTML
- `multiOpen: true`：再点新建"你好演示 2"
- 窗口内"关闭"按钮 → postMessage → 子窗口关闭
- 主窗口关闭 → 所有子窗口一并关闭

### 3. 子窗口内容形态

- **URL 优先**：`url: 'app://extensions/<id>/page.html'`（用户扩展静态页，CSP 已放行 app:）或 `https://...`
- **HTML 兜底**：无 url 时 `html` 字段用 iframe `srcdoc` 渲染（注意：srcdoc 内联 `<script>` 会被 `script-src 'self'` 拦截，见 troubleshooting）
- **postMessage 窗口控制**：`{source:'obox-app', action:'close'|'minimize'|'maximize'}` ——首版仅窗口控制，其他能力后续版本加

## 教程：开发用户扩展并打包 .oix

用户扩展（非内置）以 .oix（zip）分发，与 obox 仓库只有扩展 API 依赖关系——建议建独立项目目录 `extensions/<id>/`（自带 package.json / tsconfig / 构建，不进 obox 打包）。

**源码托管**：每个用户扩展在 **`github.com/obox-org/<扩展id>` 独立仓库**维护（如 [obox-org/todo](https://github.com/obox-org/todo)）。obox 仓库不持有扩展源码（`extensions/` 已 gitignore，本地保留副本供开发/打包）；扩展代码的提交/推送发生在自己的仓库，不在 obox 仓库。

### 1. 项目结构（参考 `extensions/todo/`）

```
extensions/todo/
├── package.json      # 独立依赖（vue、vite、@vitejs/plugin-vue、adm-zip）
├── tsconfig.json     # 子应用 TS 源码（vue-tsc typecheck）
├── vite.config.ts    # 子应用构建（base: './'，iife 经典脚本）
├── manifest.json     # name/version/displayName/author/main
├── index.js          # 入口：纯 ESM JavaScript（用户扩展无构建转换）
├── app/              # Vue 子应用源码（可选，App 富界面用）
├── dist/             # 子应用构建产物（todo.html/todo.js/todo.css）
├── out/              # .oix 打包产物
└── scripts/pack.mjs  # 打包脚本（adm-zip）
```

### 2. manifest 要点

- `name`：扩展 id（如 `todo`）；`main`：入口**须为 .js**（用户扩展经 app:// 动态 import，无 Vite 转换，TS 不可直接用）
- 安装目录 = `userData/extensions/<name>_<清洗后 author>/`（如 `todo_chenzhi`），目录名即宿主看到的扩展 id；`app://extensions/<id>/` 访问其文件
- 卸载钩子、contributes 等与内置扩展一致

### 3. 安装与验证

- `npm run release`（typecheck → build → pack）产出 `out/<name>-<version>.oix`
- obox 扩展管理器 → 工具栏「安装扩展」选 .oix，或直接把 .oix 拖进扩展管理器视图
- 安装成功**立即热生效**：列表即时出现、贡献项立即可用（无需重启）；若 manifest 无效或激活失败，扩展出现在列表但标红（详情见校验信息）

### 4. 安全与校验（宿主侧已实现）

- 校验 manifest（name 正则 / version semver / main 存在且入口文件在包内）
- zip-slip 防护：拒绝绝对路径、`..`、反斜杠、重复条目
- 同名覆盖安装（升级语义）；`.obox-meta.json` 记录安装时间戳（Last Updated 展示）

## 教程：更新提供者扩展（参考 `extensions/obox-updater/`）

obox 没有内置默认更新源——更新由**用户扩展**提供（声明 `contributes.updater` 后成为"更新提供者扩展"，在**设置-更新**中只能选一个生效，选中后才可调用 `api.update.*`）。参考实例：`extensions/obox-updater/`（独立仓库 [obox-org/obox-updater](https://github.com/obox-org/obox-updater)）。

### 1. 结构与要点

```
extensions/obox-updater/
├── manifest.json     # contributes.updater.feedUrl + 命令 + 状态栏项
├── index.js          # 入口：纯 ESM，检查/下载/订阅更新事件
├── icon.svg
└── scripts/pack.mjs  # .oix 打包（无子应用构建，pack 即 release）
```

- `feedUrl` 指向 electron-updater generic provider 目录（`latest.yml` + 安装包所在处）；GitHub Release 场景用 `https://github.com/<owner>/<repo>/releases/latest/download/`（release 资源 `latest.yml` + `setup.exe` 发布后可直接下载）
- 入口里调用 `api.update.check(feedUrl)` / `download()` / `install()`；`api.update.onEvent` 订阅进度/完成事件更新状态栏文本
- 未在设置-更新选中的扩展调用 `check/download/install` 会抛错；入口应捕获并提示"未选择为更新提供者"

### 2. 与宿主配合的约束

- 更新执行（下载/校验/安装）由宿主 electron-updater 完成，扩展只提供更新源与触发时机
- 代理配置（设置-网络）由宿主自动应用到更新下载；`api.proxy.get()` 可读取供扩展自查
- 发布新版本流程：在 obox 仓库打 tag 触发 release 工作流（`.github/workflows/release.yml`）→ 产物（`setup.exe` + `latest.yml`）上传为 GitHub Release 资源 → 本扩展检查更新即命中新版本

### 3. 单元测试（node:test + mock api）

用户扩展入口只与注入的 `api` 对象交互，不依赖 Electron/网络，可直接用 Node 内置测试器做零依赖单测（参考 `extensions/obox-updater/test/update.test.js`）：

- 构造 mock `api`：`statusBar.setText` 捕获状态栏文本、`registerCommand` 捕获命令处理器、`update.onEvent` 捕获事件监听器、`update.check/download` 注入各分支返回值/抛错
- 激活扩展后直接调用捕获的命令处理器，断言各分支状态栏文案（检查失败/已是最新/发现新版+下载成功/下载失败/未选中提供者抛错/其他异常）
- 通过捕获的事件监听器逐一触发 `download-progress`/`update-downloaded`/`update-available`/`error`，断言进度与文案
- 断言 `check` 调用参数与 `manifest.contributes.updater.feedUrl` 一致（硬编码 URL 一致性）
- 脚本：`"test": "node --test"`（自动发现 `test/*.test.js`）；真实更新源冒烟检查另用 `scripts/check-feed.mjs`（`npm run check:feed`，需已发布 release）

## 教程：App 富界面——内嵌 Vue 子应用

App 子窗口内容是 iframe。要做"左侧边栏 + 内容栏"级别的富界面，不需要改宿主：把界面写成 Vue 子应用，编译为静态资源，用 `url` 加载（见 `extensions/todo/` 实例）。

### 1. 构建管线

```ts
// vite.config.ts 要点
export default defineConfig({
  root: resolve(__dirname, 'app'),
  base: './',                       // 必须相对路径：产物从 app://extensions/<id>/ 任意子路径加载
  plugins: [vue()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    rollupOptions: {
      input: resolve(__dirname, 'app/todo.html'),
      output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'todo.js', assetFileNames: 'todo.[ext]' }
    }
  }
})
```

### 2. 卡片注册

```js
// index.js
export default function todoExt(api) {
  const base = new URL('.', import.meta.url).href   // 推导安装目录，不硬编码目录名
  const card = api.app.register({
    id: 'todo.main',
    name: '待办',
    icon: '<svg .../>',
    url: new URL('./todo.html', base).href,          // app://extensions/<id>/todo.html
    multiOpen: false,
    width: 1024,
    height: 700
  })
  return () => card.dispose()
}
```

### 3. iframe 内约束

- `app://` 页面无 CSP 头，可执行脚本（sandbox allow-scripts + allow-same-origin 保持真实源）；但**无 allow-modals——禁 alert/confirm/prompt**，交互一律用页面内 UI
- 数据持久化用 `localStorage`（按 app:// 源持久化，跨窗口/重启保留）；写入失败会降级内存态（store 已 try/catch）
- 相对路径资源（`./todo.js` / `./todo.css`）同源加载；构建必须 `base: './'`（绝对 `/todo.js` 会解析到 `app://extensions/todo.js`，错）

## 教程：在 VS Code 中调试扩展（不安装、不依赖 obox 源码）

扩展代码运行在 obox 渲染进程（宿主内）。obox 提供 `--debug-extension` 调试加载：把扩展本地目录直接当扩展源加载（**不做 .oix 安装**），配合 CDP 端口，VS Code 内置调试器可对扩展源码打断点。

### 1. 启动 obox（调试模式）

```bash
# 打包版（已安装 obox）
obox.exe --remote-debugging-port=9333 --debug-extension <id>@C:\绝对\路径\扩展目录

# 开发版（electron-vite dev，参数经 -- 传给 electron）
npm run dev -- -- --remote-debugging-port=9333 --debug-extension <id>@<路径>
```

- `--debug-extension <id>@<路径>` 可重复传多个；id 即扩展 id（须与 manifest.name 一致），路径为扩展仓库目录（含 manifest.json）
- 调试扩展经 `app://debug/<id>/` 加载：不写 userData、无安装时间戳、扩展管理器显示「调试中」、不可卸载，重启消失
- 改代码后手动重载窗口生效（v1 无自动 watch）

### 2. 扩展仓库的 .vscode/launch.json

在**扩展自己的仓库**里建 `.vscode/launch.json`（模板，把 `<id>` 换成你的扩展 id，`obox.path` 指向 obox 可执行文件）：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "启动 obox（调试扩展）",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "${config:obox.path}",
      "args": [
        "--remote-debugging-port=9333",
        "--debug-extension", "<id>@${workspaceFolder}"
      ],
      "cwd": "${workspaceFolder}",
      "windows": { "runtimeExecutable": "${config:obox.path}" }
    },
    {
      "name": "Attach obox 渲染进程",
      "type": "chrome",
      "request": "attach",
      "port": 9333,
      // 关键：把 app://debug/<id>/ 脚本 URL 映射回本地仓库文件，断点才生效
      "pathMapping": { "app://debug/<id>/": "${workspaceFolder}/" },
      // dev 渲染进程是 http://localhost:5173；打包版为 file:// 时可去掉 urlFilter
      "urlFilter": "http://localhost:5173/*"
    }
  ],
  "compounds": [
    { "name": "调试扩展", "configurations": ["启动 obox（调试扩展）", "Attach obox 渲染进程"] }
  ]
}
```

在 `.vscode/settings.json` 里配 obox 路径：

```json
{ "obox.path": "C:/path/to/obox.exe" }
```

F5 选「调试扩展」→ 启动 obox（带调试参数）→ attach 渲染进程 → 在 `index.js` 等源码打断点即可命中。

### 3. 原理与排查

- 扩展脚本以 `app://debug/<id>/index.js` 加载，VS Code 调试器据此 URL 匹配本地文件（pathMapping）；断点不命中先检查 pathMapping 前缀是否与 id 一致、目录尾斜杠
- `--remote-debugging-port` 是 Chromium 的 CDP 端口（主进程 inspector 另用 `--inspect`，调试扩展代码无需它）
- 调试扩展同样受宿主校验（manifest 声明式贡献点等），激活失败看扩展管理器详情页的 `activationError`

## 调试技巧

- **看宿主日志**：dev 下渲染进程 console 转发到终端，前缀 `[renderer:info]`；子窗口前缀 `[child-renderer:...]`
- **看激活状态**：`[host] 启动完成: N 个扩展（X 启用 / Y 禁用），激活 Z` ——Z < X 说明有扩展未激活，查扩展管理器详情页的 `activationError`
- **看贡献点注册**：导航/状态栏/命令在扩展管理器详情页的"校验信息"看 warning（如视图未导出、命令未声明）
- **命令面板**：Ctrl+Shift+P 检查命令是否出现（palette:false 不出现）
- **typecheck**：`npm run typecheck:web` 只查渲染进程（扩展都在渲染进程）
