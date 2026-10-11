# 用户扩展开发指南（独立仓库 + `.oix` 分发）

**用户扩展**：源码在**自己的仓库**（与 obox 仓库只有扩展 API 依赖），打成 `.oix`（zip）分发，安装到 `userData/extensions/<name>_<清洗后 author>/`（`main/oixCore.ts:51-54`）——**目录名就是宿主看到的扩展 id**，也是 `app://extensions/<id>/` 的那段 id。
若你的扩展要随 obox 打包、改仓库源码 —— 那是内置扩展，读 [guides-builtin.md](guides-builtin.md)。

前置：贡献点字段查 [manifest-reference.md](manifest-reference.md)；运行时 API 查 [api-reference.md](api-reference.md)；踩坑查 [troubleshooting.md](troubleshooting.md)。

> 代码位置写法：`src/…` 是仓库路径，`main/…` 即 `src/main/…`；其余短路径相对 `src/renderer/src/`（如 `core/loader.ts`）。

**运行时零依赖**：宿主激活时把 `api` 对象注入给入口，`.oix` 里只有你自己的文件（无 `node_modules`）。入口**必须是纯 ESM JavaScript**——宿主经 `import('app://extensions/<id>/' + manifest.main)` 动态加载（`core/loader.ts:118-121`），没有 Vite 转换，TypeScript 不能直接用。

## 1. 最小项目结构

```
my-hello/
├── manifest.json          # 宿主唯一读取的清单（必须在根目录，名字固定）
├── index.js               # 入口：纯 ESM JavaScript（manifest.main 指向它）
├── page.html              # 可选：App 卡片静态页
├── page.js                # 可选：静态页的外部脚本（不要内联 <script>）
├── test/extension.test.js # 可选：node --test
└── scripts/pack.mjs       # 打包 .oix（脚手架生成的零依赖脚本）
```

`package.json`（`"type": "module"` + 你自己的 `test` / `pack` 脚本）只为**你的工具链**存在，宿主不读它；宿主只认 `manifest.json`（`core/loader.ts:52-59`、`main/oixCore.ts:56-67`）。

## 2. 入口：纯 ESM JavaScript

```js
// index.js —— default 导出插件函数；宿主激活时调用，返回的清理函数在停用/重载时执行
export default function myHello(api) {
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

- **不许 `import 'vue'` 或任何裸模块**：`app://` 下没有模块解析器，运行时只有注入的 `api`、标准 JS 与 `fetch` 等。
- 生命周期钩子（可选具名导出 `install` / `uninstall`）见 [api-reference.md](api-reference.md) 的「生命周期钩子」。
- **界面怎么来**：`navItems[].view` 需要 Vue 组件对象（宿主按入口具名导出取组件，`core/host.ts:222-226`），而你的入口没有 Vue —— 用户扩展的界面用 **App 卡片静态页**（下一节）或 **`contributes.views` 树**（宿主内置树视图渲染，数据源 `api.views.registerTreeProvider(viewId, provider)`，`api/types.ts:449-451`）；纯命令 / 状态栏 / 通知类扩展不需要界面。
- 贡献点声明与内置扩展同构（`contributes` 里写 `commands` / `statusBarItems` / `views` / `keybindings` / `menus` / `settings` / `themes` / `ipcChannels` / `i18n` / `updater` 等），但 **`titleKey` 对你无效**——它由宿主语言包解析（`components/NavBar.vue:14`、`components/TreeView.vue:65`），而用户扩展改不了 `src/renderer/src/i18n/locales/`，写了只会显示原始 key；要双语用 `api.i18n` 自己的命名空间。**命令必须先声明**：未声明的 `registerCommand` 会被 `registry.setCommandHandler` 抛错（`core/registry.ts:193`），扩展标红 `activationError`。

## 3. 两种形态

| 形态                      | 运行时依赖 | 构建期依赖                            | 适用                                                 |
| ------------------------- | ---------- | ------------------------------------- | ---------------------------------------------------- |
| **零构建纯 JS**           | 无         | 无（打包用 Node 脚本或系统 zip 工具） | 命令 / 状态栏 / 树视图 / App 卡片 + 手写静态 HTML 页 |
| **Vite + Vue 静态子应用** | 无         | `vue`、`vite`、`@vitejs/plugin-vue`   | App 子窗口里的富界面（侧边栏 + 内容区级别）          |

第二种形态只是**构建期**用 Vue 把界面编译成静态资源，产物仍是普通 `.html` / `.js` / `.css`，运行时入口依旧零依赖：

```ts
// vite.config.ts 要点（子应用源码放 app/，产物放 dist/）
export default defineConfig({
  root: resolve(__dirname, 'app'),
  base: './', // 必须相对路径：产物从 app://extensions/<id>/ 的任意子路径加载
  plugins: [vue()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    rollupOptions: {
      input: resolve(__dirname, 'app/page.html'),
      output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'page.js' }
    }
  }
})
```

`base: './'` 不能改：绝对路径 `/page.js` 会解析到 `app://extensions/page.js`（丢了扩展目录）。

## 4. 静态资源 URL：用 `import.meta.url` 推导，别硬编码

```js
const base = new URL('.', import.meta.url).href // 安装态 app://extensions/<安装目录名>/；调试态 app://debug/<id>/
const pageUrl = new URL('./page.html', base).href
```

- **不要硬编码 `app://extensions/<manifest.name>/`**：安装目录名是 `<name>_<清洗后 author>`（`main/oixCore.ts:51-54`），带作者时与 `manifest.name` 不同。
- `app://extensions/<id>/<rest>` → `userData/extensions/<id>/<rest>`（`main/protocol.ts:12-16,46`）；同一份代码在 `--debug-extension` 下自动指向调试目录。

## 5. App 卡片与子窗口

```js
export default function myHello(api) {
  const base = new URL('.', import.meta.url).href
  const card = api.app.register({
    id: 'my-hello.demo',
    name: '你好演示',
    version: '1.0.0',
    author: 'Obox',
    description: '点击弹出独立窗口',
    icon: "<svg viewBox='0 0 24 24'><circle cx='12' cy='12' r='9'/></svg>",
    iconUrl: new URL('./icon.png', base).href, // 子窗口任务栏图标（见下）
    url: new URL('./page.html', base).href, // 子窗口内容：静态页（优先）
    multiOpen: true,
    width: 800,
    height: 600
  })

  // 子窗口 iframe 经 postMessage 发来的请求（见下方消息桥）
  const offMsg = api.app.onMessage((channel, payload) => {
    if (channel === 'ping') return { pong: payload }
    return undefined
  })

  return () => {
    card.dispose()
    offMsg.dispose()
  }
}
```

卡片字段见 `src/api/registration.ts`（`icon` 是卡片图标 SVG 字符串；`multiOpen: false` 时重复点击聚焦已有窗口，`main/appWindow.ts:52-59`）。

- **内容一律用 `url`，不要用 `html` 内联 `<script>`**：`html` 走 iframe `srcdoc`，而 srcdoc 继承主文档 CSP `script-src 'self' app:`（`src/renderer/index.html:9-10`），内联脚本**必被拦**（按钮点了没反应）。静态页里写**外部脚本** `<script src="./page.js"></script>`：`app://` 文档由协议直出、没有 CSP 头（`main/protocol.ts:33-82`），脚本正常执行。
- `iconUrl`（可选）：**只接受 `app://extensions/…`**，主进程据此转磁盘路径设任务栏图标（`main/appWindow.ts:33-43,82-85`）；其它协议/主机名（含调试态的 `app://debug/…`）会被忽略，回退应用默认图标。
- iframe sandbox 为 `allow-scripts allow-same-origin allow-forms allow-popups`（`AppWindow.vue:150-157`）：**没有 `allow-modals` → 页内 `alert` / `confirm` / `prompt` 全部无效**，交互一律自绘 UI。
- 主题：宿主只给 `html`/`srcdoc` 那条路注入主题 token（`AppWindow.vue:38-52`），`url` 静态页拿不到宿主 token —— 自备样式，或写 `var(--token, fallback)` 兜底。
- 数据持久化用该页面自己的 `localStorage`（按 `app://` 源隔离，跨窗口/重启保留）。
- 子窗口**不跑扩展代码**（`core/host.ts:907` 只注册贡献点不激活）：页面里没有 `api`，一切能力都靠下面这座消息桥。
- 子窗口日志转发到主进程终端，前缀 `[child-renderer:<level>]`（`main/appWindow.ts:107-112`）。

### 子窗口 ↔ 扩展消息桥

| 方向        | 消息                                                                                   | 说明                                                                        |
| ----------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 页面 → 宿主 | `{ source: 'obox-app', action: 'close' \| 'minimize' \| 'maximize' }`                  | 窗口控制（`AppWindow.vue:57-66`）                                           |
| 页面 → 扩展 | `{ source: 'obox-app', action: 'obox-extension', appId, channel, payload, requestId }` | 转给注册该卡片的扩展的 `api.app.onMessage` handler（`AppWindow.vue:67-97`） |
| 扩展 → 页面 | `{ source: 'obox-app', action: 'obox-extension-reply', requestId, result }`            | `result` = `{ ok: true, data }` 或 `{ ok: false, error }`                   |

> 关联链路：子窗口 iframe → `AppWindow` → 主进程 → 主窗口宿主 → 卡片所属扩展的 handler → 回传（`main/appWindow.ts:131-188`、`core/host.ts:765-781`）。

- `appId` 必须是**卡片 id**：宿主按它找卡片、再找所属扩展的 handler（`core/host.ts:766-772`）；没注册 handler 时 reply 为 `{ ok: false, error: '扩展未注册消息处理器' }`。
- `requestId` 由**页面自己生成**并在 reply 里比对（`AppWindow.vue:77,89` 原样回传）；主进程另有一层内部 requestId 做关联，别混用。
- 单次请求 **60s 超时**（`main/appWindow.ts:162-168`，给模态框留时间），超时 reply `{ ok: false, error: '扩展未响应（超时）' }`。
- 主窗口关闭时子窗口全部关闭（`main/appWindow.ts:191-199`）。
- 卡片注册是持久化的：宿主写入 localStorage、扩展停用时清理、同 id 重复注册只更新（`core/appStore.ts:5-6,61-74,92-102`）。

## 6. 打包 `.oix`

`.oix` 就是 zip（扁平布局，`main/oix.ts:6`），三条硬性要求：

1. **`manifest.json` 必须是 zip 根条目**（不能套一层目录、不能带 `./` 前缀，否则 `invalid-manifest`；`main/oixCore.ts:56-67,206-208`）。
2. zip 内路径用正斜杠：含反斜杠、绝对路径、`..`、空段的条目整体拒绝（zip-slip 防护，`main/oixCore.ts:73-86`）。
3. `manifest.main` 指向的入口必须在包内（`./index.js` 与 `index.js` 等价，`main/oixCore.ts:219-222`）。

打包用脚手架生成的零依赖脚本：

```bash
node scripts/pack.mjs   # 产出 out/<name>-<version>.oix
```

限额：条目数 ≤ 10000、解压总量 ≤ 512MB（`main/oixCore.ts:249-252` 的默认值）—— 别把中间产物打进去。安装失败的错误码与成因查 [troubleshooting.md](troubleshooting.md)。

## 7. 安装与热生效

- 扩展管理器工具栏「安装扩展」选 `.oix`，或把 `.oix` **拖进**扩展管理器视图（`extensions/ext-manager/ExtensionManagerView.vue:166-212,250-256`）。
- 安装（含同名覆盖升级）成功后**立即热生效**：宿主清理旧实例 → 注册贡献点 → 激活，列表即时出现、导航 / 状态栏 / 命令立即可用，**无需重启**（`core/host.ts:934-972`、`ExtensionManagerView.vue:114-164`）。manifest 无效或激活失败 → 扩展在列表里标红，详情页给 `activationError`。
- **禁用 / 卸载**才可能要求重启：未激活的扩展可立即热移除，**已激活的扩展禁用或卸载会标记需重启**并在 UI 出现「立即重启」（`core/host.ts:1057-1098`）。所以"升级 = 直接覆盖安装"是热路径，"先卸载再装"要走重启。
- 内置扩展不可卸载；调试扩展不占安装态（`core/host.ts:1087-1088`）。

## 8. 在 VS Code 里调试（不安装、不依赖 obox 源码）

`--debug-extension` 把本地目录直接当扩展源加载，配合 CDP 端口即可对源码打断点：

```bash
# 打包版（已安装 obox）
obox.exe --remote-debugging-port=9333 --debug-extension my-hello@C:\绝对\或\相对\路径\my-hello

# 开发版（electron-vite dev：参数要经两个 -- 才能传到 electron）
npm run dev -- -- --remote-debugging-port=9333 --debug-extension my-hello@<路径>
```

- `--debug-extension` 可重复传多个；`<id>` 须与 `manifest.name` 一致（id 正则大小写不敏感，`main/debug.ts:12`），路径**可相对**（`main/debug.ts:24-32` 用 `resolve()`）；id 非法或路径不存在会被静默跳过。
- 调试扩展经 `app://debug/<id>/` 加载（`core/loader.ts:73-97`）：不写 userData、无安装时间戳、管理器显示「调试中」、不可卸载，重启消失。
- **调试扩展可自带运行时 / 二进制**：宿主找"扩展自己的文件"时调试目录优先（`main/paths.ts:22-31`），所以 `<扩展>/python/`、`bin/x.exe` 与安装态行为一致；**数据目录**仍在 `userData/extensions/<id>/data`（`main/fs.ts:12-14`）。
- 启动日志 `[debug] 调试扩展 N 个: id@路径` 证明参数进来了（`main/debug.ts:47-53`）；没有这行就是没传进 electron。
- 改代码后重载窗口生效：入口是 `app://` 动态 import，模块缓存不会自动失效。

扩展自己仓库里的 `.vscode/launch.json`（**未实机验证**，`urlFilter` 依赖 electron-vite dev 端口 —— 仓库没固定 `server.port`，`electron.vite.config.ts:15-20`，端口一变就要同步改；打包版渲染进程是 `file://`，可删掉 `urlFilter`）：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "启动 obox（调试扩展）",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "${config:obox.path}",
      "args": ["--remote-debugging-port=9333", "--debug-extension", "my-hello@${workspaceFolder}"],
      "cwd": "${workspaceFolder}"
    },
    {
      "name": "Attach obox 渲染进程",
      "type": "chrome",
      "request": "attach",
      "port": 9333,
      "pathMapping": { "app://debug/my-hello/": "${workspaceFolder}/" },
      "urlFilter": "http://localhost:5173/*"
    }
  ],
  "compounds": [
    { "name": "调试扩展", "configurations": ["启动 obox（调试扩展）", "Attach obox 渲染进程"] }
  ]
}
```

`.vscode/settings.json` 里配 obox 路径：`{ "obox.path": "C:/path/to/obox.exe" }`。断点不命中先查 `pathMapping`：前缀必须是 `app://debug/<id>/`，`<id>` 与 `manifest.name` 一致、结尾斜杠不能少。

## 9. 把 Python 运行时打进扩展包

运行时**随扩展包分发**（每架构一个包），宿主的 `api.python.run` 固定找 `<扩展>/python/python.exe`（`main/pythonCore.ts:24-27,121-125`）。运行期语义（不超时、非零 `code`、通道、进程树清理、代理不注入）见 [api-reference.md](api-reference.md) 的 `api.python`，这里只说怎么打包。

作者侧三步（**在 obox 仓库里**跑，任务由环境变量门控，默认跳过）：

```powershell
# 1) 下载对应架构的 install_only_stripped 归档（与 runtimeDownloadUrl() 同源，见 src/main/pythonPackage.ts）
#    地址 = https://github.com/astral-sh/python-build-standalone/releases/download/<release>/
#           cpython-<版本>+<release>-<x86_64|aarch64>-pc-windows-msvc-install_only_stripped.tar.gz
$env:OBOX_PACK_RUNTIME_OUT = "extensions/my-py-ext"     # 产物目录
$env:OBOX_PYTHON_ARCHIVE   = "$env:TEMP\cpython-3.13.16-x64.tar.gz"
npx vitest run test/python-runtime-task.test.ts          # 2) 解压 → 裁剪 → 写 python-package.json

# 3) 打包 .oix：manifest.json + 入口 + python/ 按扁平布局压进 zip 根
```

- 需要预置第三方包（如 matplotlib）：`$env:OBOX_PACK_REQUIREMENTS = "matplotlib==3.11.2"`（要求 PATH 上有 `uv`，它按 `--python-platform` 交叉取对应架构的 wheel）；arm64 包再设 `$env:OBOX_PACK_ARCH = "arm64"` + arm64 归档跑一次。
- **为什么是 vitest 任务而不是 CLI**：Node 原生跑 `.mts` 解析不了 `src/` 内部的无扩展名 import，vitest 走 Vite 解析、能直接复用 `src/main/pythonPackage.ts` 里已有单测的规划函数（`scripts/make-tray-icon.mts` 头部记录了同一坑）。
- **manifest 声明**：`arch` + `python` **成对**写才会在安装期校验架构 —— 只写一个或写非法值 → `invalid-manifest`；架构不符 → `arch-mismatch`（`main/oixCore.ts:230-247`）。这两个字段**不在公开类型 `ExtensionManifest` 里**（`src/api/manifest.ts:9-33`），只被安装器读；`python.requirements` 虽在校验函数里有分支（`main/pythonCore.ts:108-117`），但安装器不传它（`main/oixCore.ts:236`）→ 实际不可达，别依赖。
- **第三方许可（必做）**：PSF License v2 要求保留许可证与版权声明、并附"对 Python 的修改摘要"（我们裁剪过运行时）：

  ```powershell
  node scripts/collect-python-licenses.mts --ext extensions/my-py-ext          # 生成 THIRD-PARTY-NOTICES.txt
  node scripts/collect-python-licenses.mts --ext extensions/my-py-ext --check   # 防漂移（退出码 1 = 需重新生成）
  ```

- **真机自检（建议做一次）**：`$env:OBOX_PYTHON_EXE = "<运行时>\python\python.exe"; npm test` → `test/python-real.test.ts` 用真实解释器验证退出码/输出、不可删清单、含空格与元字符的参数、双向通道与 `kill()` 进程树（未设置该变量时这些用例自动跳过）。

**体积档位**（CPython 3.13.16 + release 20261003 的**一次性实测，换版本即变**）：

| 形态                                                 | 体积 / 条目         |
| ---------------------------------------------------- | ------------------- |
| `install_only`（未裁剪）                             | 145.0 MB / 3350     |
| `install_only_stripped`（打包任务基线，已去 `.pdb`） | 59.7 MB / 3309      |
| 再按任务裁剪 `include`/`libs`/`idlelib`/`turtledemo` | **56.3 MB / 2931**  |
| 再预置 matplotlib（+numpy/Pillow/fontTools…）        | **+119 MB / +3385** |

**不要**手工再删这些（逐项实测过的不可删清单，见 `docs/adr/0018-python-runtime-in-extensions.md`）：`tkinter`/`tcl`（交互式绘图）、`Lib/ensurepip`/`Lib/venv`/`Lib/tomllib`（pip 与 venv）、`python3.dll`（abi3 轮子）、`_ssl`/`libssl`/`libcrypto`（HTTPS 与 hashlib）、`unicodedata`、`sqlite3` 三件套；也**不要**删 `Lib/__pycache__` —— 省下的体积会在可写目录里被运行时重新生成。

## 10. 单元测试：`node --test` + mock `api`

入口只与注入的 `api` 交互，不依赖 Electron/网络，可以用 Node 内置测试器做**零依赖**单测（`node --test` 自动发现 `test/*.test.js`；`package.json` 写 `"type": "module"` 才能直接 import ESM 入口）：

```js
// test/extension.test.js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import activate from '../index.js'

/** 最小 mock api：只实现入口用到的成员，并捕获注册结果供断言 */
function makeApi() {
  const handlers = new Map()
  const statusText = new Map()
  return {
    api: {
      registerCommand: (id, handler) => {
        handlers.set(id, handler)
        return { dispose: () => handlers.delete(id) }
      },
      statusBar: { setText: (id, text) => statusText.set(id, text) },
      app: { register: () => ({ dispose: () => {} }), onMessage: () => ({ dispose: () => {} }) },
      on: () => ({ dispose: () => {} })
    },
    handlers,
    statusText
  }
}

test('命令已绑定并写入状态栏', async () => {
  const { api, handlers, statusText } = makeApi()
  const dispose = activate(api)

  assert.equal(await handlers.get('my-hello.say')(), 'hello')
  assert.equal(statusText.get('my-hello.status'), '已打招呼')
  dispose()
})
```

覆盖点建议：每个命令分支的返回值与状态栏文案、事件监听在 `dispose()` 后不再触发、`api.app.onMessage` 各 `channel` 分支、以及**硬编码 URL / id 与 manifest 声明一致**（把 manifest 读进来断言，防改名漏改代码）。

## 11. 更新提供者扩展（可选形态）

obox 没有内置默认更新源：用户扩展在 manifest 声明 `contributes.updater` 后成为"更新提供者扩展"，在**设置-更新**里选中（只能一个生效）才可调用 `api.update.*`，未选中时调用会抛错。`resolveFeed` / `check` / `download` / `install` / `onEvent` 的语义与推荐用法见 [api-reference.md](api-reference.md) 的 `api.update`；obox 自身的发版流程看仓库 `.github/workflows/release.yml`（打 tag → 产物上传为 Release 资源）。
