# Design

## Context

见 `proposal.md` 的 Why。实现相关的事实（本次读码核实）：

- 内置扩展走 `import.meta.glob('../extensions/*/index.ts')` 编译进渲染进程 bundle；`/extensions/` 在
  `.gitignore` 里且必须锚定根目录 ⇒ **CI 构建里该 glob 匹配 0 个**，发布包不含任何扩展。
- `app://builtin/<id>` 已映射到 `resources/extensions`（`protocol.ts`），但该目录从未存在。
- 扩展 id 目前 = 安装目录名；数据目录 `<userData>/extensions/<id>/data` 由 main 按 id 拼，
  而宿主按 `extensionDataDirOf(ext.path)`（= `<扩展目录>/data`）拼 —— 今天只是**碰巧**相等。
- 三个宿主界面是 `src/renderer/src/extensions/{settings,app,ext-manager}` 的 Vue SFC（约 2400 行），
  import 内部单例（`host`/`stateStore`/`themeStore`/`keybindingStore`/`appStore`/`registry`）。
- 扩展在宿主模式下拥有完整 Node 权限（ADR-0015：能力封装不是安全边界）。

## Goals / Non-Goals

**Goals:** 两个根（系统 `<installDir>\extensions\<name>`、用户 `<userData>\extensions\<name>.<author>`）、
id 即目录名、系统优先并遮蔽、数据根统一在 userData、三个界面成为系统扩展且只用公共 API。

**Non-Goals:** 不迁移旧数据/旧目录名；不引入签名或权限声明；不做扩展市场；不改宿主/渲染的执行分工。

## Decisions

### D-1 主进程是唯一扫描器，产出「来源 + 目录」

`listExtensions()` 依次扫系统根、用户根，按 id（= 目录名）去重，返回
`{ id, source: 'system' | 'user', dir, shadowed?: boolean }[]`。同根内重复 id 取首个并 warn；
跨根重复时用户那份标 `shadowed` 且不参与激活。渲染进程不再 glob 内置扩展。

### D-2 id = 目录名，命名规则按来源校验

- 系统扩展：目录名 `<name>`，清单 `author` 必须为 `obox`，`id = name`；
- 用户扩展：目录名必须为 `<name>.<author>`，且与清单的 name/author 拼接结果逐字一致，`id = 目录名`；
- 不一致 ⇒ 清单无效（给可读原因），不激活。

### D-3 协议按「id → 根」解析

`app://extensions/<id>/<rest>` 用 D-1 的表定位到系统根或用户根；`app://builtin/<id>` 保留并指向系统根
（既有 overlay URL 允许范围不动）。越界校验仍是"规范化后必须在该根之下 + realpath 校验"。

### D-4 数据根与代码根解耦

`extensionDataDirOf(id)` 改为 `<userData>/extensions/<id>/data`（**按 id，不按 ext.path**），
main 的 `fs`/`sqlite`/`python` 与宿主的 memento/stateDir 全部改用它。系统扩展在 Program Files 只读，
任何写入都落在 userData。宿主的 `init.extensions[].path` 仍传代码目录（加载入口用）。

### D-5 系统扩展不可卸载/不可禁用（底层拒绝）

在 IPC（`extensions:uninstall`）与宿主/渲染的 `setEnabled` 入口按 `source === 'system'` 拒绝，
错误文案「系统扩展不可卸载 / 不可禁用」；UI 只是不渲染按钮，不作为唯一防线。

### D-6 打包：extraFiles + 独立构建产物

三个系统扩展各自有 `vite build` 配置，产物进 `.build/extensions/<name>/`（**不入库**）；
`electron-builder.yml` 用 `extraFiles`（落在安装根目录）把 `.build/extensions/*` 拷到
`<installDir>\extensions\`。`npm run build` 先构建扩展再打包应用。

### D-7 页面形态与主题

系统扩展页面是普通 HTML+JS（与用户扩展一致），经 `app://extensions/<id>/index.html` 加载；
主题沿用现有 `obox-theme` 下发（外壳 → iframe / overlay），系统扩展页面按同一协议消费。

### D-8 外壳只做壳

`App.vue` 保留标题栏、导航区与错误页；默认视图由系统 `app` 扩展提供。系统 `app` 扩展缺失或加载失败时
渲染错误页（可读文案 + 重试按钮），不留白屏；导航项来自三个扩展的 `contributes`。

### D-9 公共 API 增量（不给特权）

| API | 用途 | 承载 |
| --- | --- | --- |
| `api.settings.host.get/set/onChanged` | 宿主级设置（代理/语言/通知/扩展宿主开关） | 经既有 `settings` 快照通道 + main |
| `api.theme.list/current/set` | 主题枚举与切换 | 渲染侧 themeStore 桥 |
| `api.keybindings.list/set/reset` | 快捷键 | 渲染侧 keybindingStore 桥 |
| `api.extensions.list/setEnabled/uninstall/restartHost` | 扩展管理 | main IPC + host 控制 |
| `api.apps.list` / `api.commands.list` / `api.commands.menus` | 卡片与命令表 | 渲染侧 appStore/registry 桥 |
| `api.pages.open(pageId)` | 打开宿主页面 | 渲染侧路由 |

所有能力对所有扩展开放（D-9 与 ADR-0015 一致）。新增能力面 ⇒ `apiVersion` +1。

### D-10 旧命名不识别

扫描时只认 `<name>`（系统）与 `<name>.<author>`（用户）；下划线目录跳过并记录一次日志。
不做迁移、不做别名。

## Risks / Trade-offs

- **[三个页面重写体量大]** → 分两次提交（先机制与协议，再页面迁移），每步可运行；页面迁移前保留旧视图。
- **[app 页成为扩展后的引导风险]** → D-8 的错误页兜底 + 启动自检（缺系统扩展时直接提示）。
- **[管理能力对第三方开放]** → 与 ADR-0015 的信任模型一致；文档写明"扩展即可信"。
- **[apiVersion +1 影响存量扩展]** → 只增不改；旧清单（apiVersion ≤3）继续可用。
- **[打包链新增一步]** → CI 增加"构建系统扩展"步骤；缺失时构建失败而非静默少文件。

## Migration Plan

不迁移数据。发布说明写明：旧下划线目录不再识别，需重新安装为用户扩展（`<name>.<author>`）；
外部 HTTP 指令名改为 `<id>:<cmd>`（如 `pet.chenzhi:state`）。回退：整体回退到上一个版本 tag 即可
（无数据结构变更）。

## Open Questions

- 系统扩展是否允许"仅调试时禁用"（例如 `--enable-system-ext-debug`）——不阻塞实现，可后补。
