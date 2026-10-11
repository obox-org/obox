---
name: obox-ext-dev
description: 在 obox 桌面应用（Electron + Vue + Cordis 版，扩展宿主运行在渲染进程）中开发、调试扩展的完整指南。当用户要新建/修改/调试 obox 扩展，声明贡献点（导航项 / 状态栏项 / 命令 / 树视图 / App 卡片 / 主题 / 快捷键 / 菜单 / 设置），或对接扩展 API、`.oix` 分发与扩展调试时使用。
---

# obox 扩展开发

**本仓库的 obox 是 Electron + Vue 3 + TypeScript 版**：扩展宿主运行在渲染进程，扩展系统基于 Cordis，仿 VS Code 模型——清单（manifest）声明贡献点、宿主解析注册、两阶段启动。

## 一、先判定：你在做哪一类扩展

| 判据                     | 类型         | 扩展放哪                                                                                  | 入口                                                      | 分发             | 教程                           |
| ------------------------ | ------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------- | ------------------------------ |
| 随应用打包、要改仓库源码 | **内置扩展** | `src/renderer/src/extensions/<id>/`                                                       | `index.ts`（TypeScript，经 Vite 转换）                    | 随应用，不可卸载 | `references/guides-builtin.md` |
| 独立仓库、给别人安装     | **用户扩展** | 独立仓库（本地 `extensions/<id>/`，已 gitignore）→ `userData/extensions/<name>_<author>/` | `index.js`（**纯 ESM JavaScript**，无转换、零运行时依赖） | `.oix`（zip 包） | `references/guides-user.md`    |

两者的入口语言、构建链、分发方式全不同，**猜错必返工**——分不清就问用户（`references/workflow.md` 的 M1）。

## 二、必做流程（不许跳过、不许自行扩大范围）

```
提问（M1–M8）→ spec 写入 tmp/spec/ → 用户确认 → 设计文档 → 开发
  → 测试 + 独立审视（审视报的问题必须逐条处置）→ ADR 写入 tmp/adr/
  → 归档到 <开发目录>/docs/{spec,adr}/ → 删除整个 tmp/
```

改变「对外行为 / 贡献点 / 数据结构」的需求走全流程；只改文案/样式/单点 bug 走轻流程（提问 + 开发 + 测试）。**必问清单、个性化追问、三条硬边界、spec 与设计文档模板见 `references/workflow.md`。**

## 三、最小路径

**内置扩展**：① 读 `src/api/` 与已有扩展（`ext-manager`、`app`）→ ② `node skills/obox-ext-dev/scripts/create-extension.mjs <id>`（脚手架会生成导航项 + 示例命令 + 视图，需求用不到就删掉——多一个也算越界）→ ③ 写 `manifest.json` 的 `contributes` → ④ 写 `index.ts`（`export default (api) => cleanup` + 具名导出视图组件）→ ⑤ `npm run typecheck && npm run lint && npm test && npm run dev` 验证。

**用户扩展**：① `node skills/obox-ext-dev/scripts/create-user-extension.mjs <id>`（默认生成零构建纯 JS；要 Vue 富界面加 `--vue` 生成 Vite+Vue 子应用骨架；`--dir <父目录>` 改生成位置，默认落在本地 `extensions/`）→ ② 写 `manifest.json`（`main: "./index.js"`）→ ③ 写纯 ESM `index.js`（只用注入的 `api`）→ ④ 富界面用 `app://extensions/<id>/page.html` 装进 App 卡片子窗口 → ⑤ 在**生成的扩展项目内**跑 `node --test` 与 `node scripts/pack.mjs` 出 `.oix`（这两个 `scripts/` 指扩展项目自己的目录），再用 `node skills/obox-ext-dev/scripts/validate-manifest.mjs <manifest.json>` 校验清单。

## 四、铁律

1. **声明式贡献点**：导航项/状态栏项/命令等的元数据必须写进 manifest `contributes`，宿主只认 manifest，不用 `ctx.register*` 命令式注册。
2. **命令必须先声明**：`api.registerCommand(id, handler)` 的 id 未在本扩展 manifest 声明时，宿主**直接抛错**（`registry.ts`）→ `plugin(api)` 抛错 → 扩展标红 `activationError`。这不是 warning。
3. **视图必须具名导出**：navItem 的 `view` 引用的组件要在入口具名 `export`，否则内容栏空白。
4. **依赖环不跳过**：`extensionDependencies` 成环时环内扩展**仍会激活**，只是排在最后；缺失依赖不阻塞激活。
5. **Disposable**：`registerCommand` / `on` / `app.register` / `statusBar.createItem` 都返回 `{ dispose() }`；插件函数返回的 cleanup 与它们一起被宿主在停用时统一释放，不返回会在热重载时泄漏。
6. **只在主窗口调用插件函数**：App 子窗口（`?obox-window=app`）**同样会 import 每个扩展入口并注册贡献点——模块顶层代码会执行**，只是不调用 `default` 插件函数。所以定时器 / DB 连接 / 文件监听一律放进插件函数，别写模块顶层，否则每个子窗口都会重跑；子窗口交互走 `api.app.onMessage` 消息桥。
7. **命令 id 全局唯一**：跨扩展同名会被拒绝并记日志；扩展热移除/覆盖安装时其命令从注册表物理移除，同 id 可重新声明。
8. **生命周期钩子**：入口具名导出 `install(ctx)` / `uninstall(ctx)`，两者都可选。`install` 在 `.oix` 安装完成后立刻执行（覆盖安装会重跑，`ctx.upgraded === true`），失败按激活失败处理；`uninstall` 在删除目录**之前**执行（禁用态扩展也会临时加载入口来跑），失败只告警但仍继续删目录。两者都要自行保证幂等。
9. **i18n**：只有**导航项与树视图**支持 `titleKey`（词条加在 `src/renderer/src/i18n/locales/{zh,en}.ts`，**用户扩展改不了宿主语言包，所以对它无效**）；命令与状态栏项**没有**这个字段，要双语得自己接 `api.i18n` 并随语言变更刷新文本。
10. **平台**：托盘、开机自启、系统通知**仅 Windows**；其余平台按缺失处理，不要假设存在。
11. **扩展是受信代码（无沙箱）**：入口被动态 `import` 进宿主渲染进程，与宿主同进程同上下文；`ExtensionActivationApi` 是能力封装、**不是安全边界**（扩展可直接摸到 `window.api`）。不要用它承载不可信第三方代码，需要强隔离时改用独立进程/子窗口（`docs/adr/0015`）。
12. **用户扩展零运行时依赖，且没有主窗口 Vue 视图**：入口只依赖注入的 `api`；带 Vue 的富界面属于**构建期**（编译成静态页，只能落在 App 卡片子窗口里），**不能**给主窗口贡献 `navItems[].view` 组件——用户扩展没有宿主的 Vue 构建管线。
13. **内置扩展没有磁盘目录、也没有系统信息能力**：它跑在渲染进程且 `nodeIntegration:false` + `contextIsolation:true`，没有 `child_process` / `fs`；`app://builtin` 通道虽注册但无人填充，所以它也**取不到自己的文件目录**。要执行命令、读系统信息（例如 git 分支）**只能新增主进程 API**——命中 M7，停下来问用户。

## 五、references 索引

| 何时读                                       | 文件                               |
| -------------------------------------------- | ---------------------------------- |
| 开工前走流程、必问清单                       | `references/workflow.md`           |
| 做内置扩展                                   | `references/guides-builtin.md`     |
| 做用户扩展、打包调试                         | `references/guides-user.md`        |
| manifest 字段与校验规则                      | `references/manifest-reference.md` |
| 扩展 API 方法签名与限额                      | `references/api-reference.md`      |
| 主题 token、设置系统、App 子窗口主题下发协议 | `references/themes-settings.md`    |
| 出问题了（按症状查）                         | `references/troubleshooting.md`    |

## 六、持续更新（强制）

改扩展 API → 更新 `references/api-reference.md`；改 manifest 校验 → `references/manifest-reference.md`；改宿主生命周期或扩展约定 → 本文件 + 对应 reference；发现新坑 → `references/troubleshooting.md`；新增示例或脚手架 → `references/guides-*.md` 与 `scripts/`。完整条款与提交/PR 约定见 `AGENTS.md`。
