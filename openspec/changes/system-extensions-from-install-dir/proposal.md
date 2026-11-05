# Proposal

## Why

obox 现在有两条互不相干的扩展来源，且都不成体系：

1. **随包的"内置"扩展其实不存在**：`/extensions/` 在 `.gitignore` 里，CI 构建没有该目录，
   `import.meta.glob('../extensions/*/index.ts')` 匹配 0 个 ⇒ **发出去的安装包里没有任何扩展**。
   所谓"内置扩展"只是开发者本地的偶然产物。
2. **设置页 / 应用页 / 扩展管理器不是扩展**，而是编译进渲染进程的 Vue 视图（约 2400 行），
   直接 `import` 内部单例（`host`、`stateStore`、`themeStore`、`keybindingStore`、`appStore`、`registry`）。
   它们既不能被独立演进，也拿不到扩展机制的任何好处（热修、按需加载、统一校验）。

用户扩展则只有一个根（`%APPDATA%\obox\extensions\<name>_<author>`），命名规则不统一、
也没有"系统提供 vs 用户安装"的区分。

本 change 建立一套**两条根**的扩展来源模型：系统扩展随安装包分发、用户扩展在用户目录；
并把这三个内置视图改造成**系统扩展**，只使用公共 API，从而让"扩展"成为应用界面的唯一组织方式。

## What Changes

- **系统扩展根**：`<安装目录>\extensions\<name>\`（electron-builder `extraFiles`，随 NSIS 安装）。
  作者必须是 `obox`；**不可禁用、不可卸载**。
- **用户扩展根**：`<userData>\extensions\<name>.<author>`（即 `%APPDATA%\obox\extensions`）。
- **id 规则**：**目录名即 id**，两种来源各自成规则——系统扩展 `id = <name>`、用户扩展 `id = <name>.<author>`。
  因此系统扩展目录是 `<name>`、用户扩展目录是 `<name>.<author>`，**目录名与 id 始终逐字一致**（不需要 id→目录 映射表）。
- **扫描顺序**：先系统根、后用户根；同 id 时**系统优先**，用户那份在管理器里标注「已遮蔽」。
- **数据根**：统一放在 `<userData>\extensions\<id>\data`（系统扩展代码在 Program Files 只读，
  数据必须在可写的 userData）；`api.fs` / `api.sqlite` / `api.python` / memento 全部按 id 定位。
- **三个视图改为系统扩展**：`settings`、`app`、`ext-manager`（author=`obox`），各自独立页面构建
  （HTML + JS，走与用户扩展相同的 `app://` 加载与主题下发），代码从 `src/renderer/src/extensions/`
  迁出到仓库的 `extensions/<name>/`。
- **公共 API 增量**（不给特权）：`api.settings.host.*`、`api.theme.*`、`api.keybindings.*`、
  `api.extensions.*`、`api.apps.list`、`api.commands.*`、`api.pages.open`。
- **壳子兜底**：渲染进程外壳只保留标题栏/导航；系统 `app` 扩展加载失败时显示可读错误页，不留白屏。
- **不做数据迁移**：视为全新开始。现有 `<userData>\extensions\<name>_<author>`（下划线）不再被识别，需重装为用户扩展（文档写明）。

## Capabilities

### New Capabilities

- `extension-sources`: 扩展的**来源与解析**——两个根、目录命名、id 规则、扫描顺序与遮蔽、
  数据根、打包位置与不可卸载语义。
- `host-ui-extensions`: 三个**宿主界面系统扩展**——它们的页面形态、所需的公共 API 增量、
  壳子兜底与不可禁用规则。

### Modified Capabilities

<!-- 无：项目此前没有 specs（`openspec list --specs` 为空），两个能力都是新建。 -->

## Impact

- **主进程**：`paths.ts`（两个根）、`capabilities.ts`（扫描/安装/卸载按根）、`protocol.ts`
  （`app://extensions|builtin` 的根解析）、`extensionDirs.ts`、`oix*.ts`（安装目录名与 id）、
  `appWindow.ts`（overlay URL 允许范围按 id）、`electron-builder.yml`（`extraFiles`）。
- **渲染进程**：`loader.ts`（去掉内置 glob，改双根扫描）、`host.ts`（id 与启用/禁用键、壳子兜底）、
  `App.vue`（首页来自系统 `app` 扩展）、三个视图迁出 `src/renderer/src/extensions/`。
- **扩展 API**：`src/api/types.ts` + `runtime`/`host-main`/`ui-plane` 新增上述公共 API；
  `apiVersion` 需要 +1（新增能力面）。
- **打包链**：为 `extensions/{settings,app,ext-manager}` 增加独立 Vite 构建产物（`.build/extensions/`，
  不入库），由 electron-builder `extraFiles` 打进安装目录。
- **文档**：`docs/extension-api/`（manifest 命名与来源、id 规则、公共 API 增量）、
  `docs/extension-host-migration.md`、`README.md`（目录结构变化）。
- **兼容性**：`%APPDATA%\obox\extensions` 与旧 id（下划线）不再被识别；外部 HTTP 指令名由
  `pet_chenzhi:state` 变为 `pet.chenzhi:state`。
