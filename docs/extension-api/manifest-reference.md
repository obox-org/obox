# Manifest Reference

> **本文件是 obox 扩展 manifest（贡献点 schema 与校验规则）的唯一真相，位置 `docs/extension-api/`**：仓库内其它文档一律引用本文件，不复制副本。

扩展清单（manifest）声明扩展的身份、入口与贡献点。宿主扫描后统一解析注册（两阶段启动：先注册贡献点、后激活）。

> 代码证据一律写 `path:line`，本文省略公共前缀：`core/xxx.ts` = `src/renderer/src/core/xxx.ts`，`api/` = `src/api/`，`main/` = `src/main/`，`shared/` = `src/shared/`，`extensions/<id>/` = `src/renderer/src/extensions/<id>/`。

## 文件位置

- **内置扩展**：`src/renderer/src/extensions/<id>/manifest.json`，与入口 `index.ts` 同目录（只按 `index.ts` 收集，缺入口则该扩展不会加载，`core/loader.ts:15,34-45`）；随应用打包，只读不可卸载
- **用户扩展**：`userData/extensions/<name>_<author>/manifest.json`（经 `app://extensions/<id>/manifest.json` 加载，可卸载；经 .oix 安装，目录名 = `<name>_<清洗后 author>`，清洗后为空则退化为纯 name，`main/oixCore.ts:56-60`）

## 字段

| 字段                    | 必填 | 类型     | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | ✅   | string   | 扩展 id。正则 `/^[a-z0-9][a-z0-9._-]*$/`（**不带 `i`，只接受小写**，`core/manifest.ts:11`）：`MyExt`、`MY-EXT` 均为 error（issue #77 的行为变更，大写 id 从此被拒）；全局唯一，约定写小写并带短前缀（如 `ext-manager`、`app`、`todo`）                                                                                                                                                                                                 |
| `version`               | ✅   | string   | semver（`1.0.0`；`core/manifest.ts:12` 的正则还接受 `-pre` / `+build` 后缀）。非法 = error，扩展不加载                                                                                                                                                                                                                                                                                                                                 |
| `apiVersion`            | ❌   | number   | 扩展要求的 obox API 版本（非负整数）。缺失视为 `0`（兼容所有）。**高于 obox 当前 API 版本时校验 error，拒绝加载**（"需要 obox API vN 或更高（当前 obox 为 vM）"，`core/manifest.ts:28-38`）。obox API 版本单源在根 `package.json` 的 `apiVersion` 字段（**当前 `2`**，`package.json:4`）；只在新版 API 不兼容旧版（破坏性签名变更）时递增。**v2 的递增理由**：新增了 `api.overlay` 命名空间（`api/types.ts:187-234`）与 `progress` 设置字段类型（`api/contributions.ts:106-107`）——v2 本身是**纯加法**（没有破坏性签名变更），递增它是为了给扩展一个**可声明的最低宿主版本门槛**：用了这两项能力的扩展声明 `apiVersion: 2`，老宿主（`apiVersion: 1`）读到 2 就**直接拒绝加载**（清单无效、扩展在管理器标红、入口根本不执行），而不是让扩展在运行期撞上 `api.overlay` 为 `undefined`、或把 `progress` 字段降级成可编辑文本框。不声明（或声明 `1`）的既有扩展在每个宿主上都照常加载 |
| `main`                  | ✅   | string   | 入口文件相对路径（`core/manifest.ts:39-41`）。**用户扩展须为纯 JS（.js ESM）**——经 `app://` 动态 import，无构建转换（`core/loader.ts:118-121`）；内置扩展可用 `.ts`（Vite 转换）                                                                                                                                                                                                                                                       |
| `displayName`           | ❌   | string   | 扩展管理器展示名（默认回退 id）                                                                                                                                                                                                                                                                                                                                                                                                        |
| `author`                | ❌   | string   | 作者（也参与 .oix 安装目录名的清洗，`main/oixCore.ts:56-60`）                                                                                                                                                                                                                                                                                                                                                                          |
| `description`           | ❌   | string   | 简介                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `contributes`           | ❌   | object   | 贡献点声明（见下）；出现时必须是对象，否则 error（`core/manifest.ts:42-44`）                                                                                                                                                                                                                                                                                                                                                           |
| `extensionDependencies` | ❌   | string[] | 依赖的其他扩展 id；宿主按拓扑序激活。缺失的依赖只打日志、不阻塞（`core/host.ts:1105-1115`）；**检测到环不跳过**——环内扩展仍会激活、只是排在最后，启动日志会列出 `依赖环 …`（`core/manifest.ts:195-200`、`core/host.ts:1013-1031`）                                                                                                                                                                                                       |
| `uninstall`             | ❌   | string   | **不读取此字段（写了静默失效）**——但它仍留在公开类型里，所以写了**不报类型错**（原因见下方注）。生命周期钩子的机制是**入口具名导出**：`export function install(ctx)` / `export function uninstall(ctx)`——`install` 在 .oix 安装完成后立刻执行一次（覆盖安装会重跑），`uninstall` 在删除目录前执行；两者都可选、可为空；旧固定文件 `.uninstall.cjs` 仍作为回退（`main/capabilities.ts:102-112`，详见 api-reference 的「生命周期钩子」） |

> **为什么 `uninstall` 字段写了不报错**：公开类型 `ExtensionManifest` 仍声明它（`api/manifest.ts:29-30`，注释还写着"卸载时先执行再删目录"），所以按类型写清单**不会有类型报错**；但宿主从不读该字段，别把它当成钩子——钩子是入口的具名导出（见上表 `uninstall` 行与 api-reference 的「生命周期钩子」）。

> **随包 Python 运行时不靠 manifest 字段**：运行时靠扩展自带目录 `<扩展>/python/python.exe`（`main/pythonCore.ts:25-27,113-116`）+ `api.python.run`（`api/types.ts:612-631`）。公开类型 `ExtensionManifest`（`api/manifest.ts:11-33`）里**没有** `arch` / `python`，按类型写清单对象会报"对象字面量只能指定已知属性"（本文档早先教学过这两个字段，已删）。安装器另有一处旁路读取 `manifest.arch` / `manifest.python`（`main/oixCore.ts:247-264`），用于安装期拒掉错架构的 `.oix`；那两个键由运行时打包工具写入（`main/pythonPackage.ts:155-159`），不是要手工声明的清单项。原 `python.requirements` 已移除（issue #82：它从未被安装器传入、实际不可达），旧清单里残留该键只被忽略、不报错。

## contributes 贡献点

> 这八类（`ipcChannels` / `keybindings` / `menus` / `views` / `navItems` / `statusBarItems` / `commands` / `themes`）的值**必须是数组**：写成 `{}` / `5` / `true` 会让清单**无效**（error，见文末「八类数组形状 error」）。数组内**逐项**缺必填字段只是 warning（该项跳过、扩展仍加载）。

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

| 字段       | 必填 | 说明                                                                                              |
| ---------- | ---- | ------------------------------------------------------------------------------------------------- |
| `id`       | ✅   | 唯一，建议含扩展前缀                                                                              |
| `title`    | ✅   | 显示名（hover tooltip / 状态栏当前视图名）                                                        |
| `titleKey` | ❌   | 语言包 key（可选）：存在时 tooltip/状态栏用 `t(titleKey)` 本地化（随语言切换），否则用 title 原文 |
| `icon`     | ✅   | SVG 字符串（当前宿主渲染方式）                                                                    |
| `group`    | ❌   | `top`（可排序业务导航，默认）/ `bottom`（固定全局区）                                             |
| `view`     | ❌   | 内容栏视图组件 id——必须是扩展入口**具名导出**的组件名                                             |
| `badge`    | ❌   | 数字徽标初值；运行时 `api.navbar.setBadge(id, n)` 更新                                            |

> **启动视图是固定的**：应用启动时内容栏固定显示**"应用"扩展**（导航项 `app.main`，`core/startupView.ts:10-11`），
> **不恢复上次选择**——扩展贡献的导航项不会成为启动视图，只有用户点击后才会显示。
> 若目标导航项不可用（被禁用/未注册），会按"第一个 top 组项 → 第一个可用项 → 空态"回退（`core/startupView.ts:31-35`；`:19-26` 是描述这段策略的注释）。

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

| 字段        | 必填 | 说明                                                                                                                                                                                  |
| ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | ✅   | **全局唯一**（不是"扩展内唯一"）：宿主按全局 id 查找状态栏项（`core/registry.ts:220`），同名会被后注册者 `Object.assign` 覆盖（`registry.ts:101-120`）→ 必须带扩展前缀                |
| `name`      | ✅   | 显示名（hover tooltip 兜底）                                                                                                                                                          |
| `text`      | ❌   | 初始文本；**按 HTML 渲染**（`components/StatusBar.vue:41,53` 用 `v-html`）→ 文本里的 `<`/`>` 必须自行转义；**`$(icon)` 语法未实现**（只在类型注释里写着，仓库无实现），写了会原样显示 |
| `alignment` | ❌   | `left` / `right`（默认 `right`）                                                                                                                                                      |
| `priority`  | ❌   | 同侧数值大者靠左（左侧）/ 靠右（右侧）；同值按扩展 id 决胜                                                                                                                            |
| `command`   | ❌   | 点击绑定的命令 id（必须在 contributes.commands 声明）                                                                                                                                 |

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

| 字段       | 必填 | 说明                                                    |
| ---------- | ---- | ------------------------------------------------------- |
| `command`  | ✅   | 全局唯一，建议 `<扩展名>.<动作>`                        |
| `title`    | ✅   | 命令面板显示标题                                        |
| `category` | ❌   | 分类（面板中前缀显示 "分类: 标题"）                     |
| `palette`  | ❌   | 是否出现在命令面板（默认 `true`；`false` 隐藏内部命令） |
| `when`     | ❌   | 显隐控制（首版仅 `'false'` 即隐藏有效，其余字符串恒真） |

> 命令实现（handler）不在 manifest 里，由扩展激活时 `api.registerCommand(id, handler)` 绑定。
> 命令 id 重复时**保留先注册者**、丢弃后者：既打 `console.warn`，也把冲突写进该扩展的 `validations`（`severity: 'warning'`，文案含命令 id 与双方扩展 id，管理器详情页可见——`core/registry.ts:122-140` 的 `messages?.push(...)`，宿主在 `core/host.ts:186` 传入 `ext.validations`）。

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

| 字段     | 必填 | 说明                                     |
| -------- | ---- | ---------------------------------------- |
| `id`     | ✅   | 全局唯一，建议 `<扩展名>.<主题名>`       |
| `label`  | ✅   | 显示名（设置下拉框展示）                 |
| `tokens` | ✅   | CSS 变量组（`--xxx` → 值），套到 `:root` |

宿主已内置 `theme-dark`（深色）与 `theme-light`（浅色）主题扩展。**完整 token 表与主题编写指南见 `themes-settings.md`**（含背景/文字/语义色/字体/字号/图标尺寸 token；SVG 用 `currentColor` 继承、尺寸用 `--nav-icon-size`/`--icon-size`）。子窗口 iframe（`srcdoc`）**自动注入**当前主题 token，扩展页面用 `var(--bg)` 等即可跟随主题；**App 卡片的 `url` 型静态页由宿主经 `obox-theme` 消息下发 token**（跨源 inject 不了，协议与最小接收代码见 `themes-settings.md`）。

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

与运行时 `api.i18n.registerMessages` 等价（`core/host.ts:203`）；`api.i18n.t(key)` 按当前语言取文案。

### settings（扩展设置 schema，manifest 声明）

对齐 VS Code contributes.configuration 简化版（`api/contributions.ts:106-160`）；与运行时 `api.settings.register` 等价（`core/host.ts:205`）。**清单声明的 settings 另有一层发布前静态校验（只在 `scripts/validate-manifest.mjs` 里，宿主不做）**，见下方「settings 字段校验」：

```json
{
  "contributes": {
    "settings": {
      "id": "my-ext.settings",
      "title": "我的扩展设置",
      "fields": [
        { "key": "my-ext.interval", "label": "刷新间隔", "type": "number", "default": 30 },
        {
          "key": "my-ext.migrationStatus",
          "label": "迁移进度",
          "type": "status",
          "modal": true,
          "default": ""
        },
        {
          "key": "my-ext.syncProgress",
          "label": "同步进度",
          "type": "progress",
          "max": 100,
          "default": 0
        }
      ]
    }
  }
}
```

字段类型：`text` / `number` / `boolean` / `select` / `directory` / `status` / `progress`（`api/contributions.ts:106-107`；**逐类型的完整契约见 `themes-settings.md`，本文件不复制副本**），另有可选属性 `max?: number`（`api/contributions.ts:123-134`，**只对 `progress` 有意义**：进度上限，缺省 100）与 `modal?: boolean`（`api/contributions.ts:135-149`，**只对 `status` 有意义**）。`directory` 渲染为**只读**文本框 + 「浏览…」按钮（**点输入框或按钮都弹**系统目录选择器，路径不支持手工粘贴），选中后把**绝对路径**写回该设置项（取消不改动）；宿主只负责选目录，**不校验**目录是否合法/可写/受管，扩展侧须自行校验。`status` 是**只读状态展示**：无输入框、无按钮，值由扩展经 `api.settings.set` 写入同一设置存储，含 `\n` 时按行渲染成列表、空值显示「（无）」。`progress` 是**只读进度条**（随 **API v2** 新增）：同样无输入框、无按钮，值由扩展经 `api.settings.set` 写入**数字**（`0..max`），宿主渲染进度条 + 右侧 `{cur}/{max}`——`{cur}` 是钳制到 `[0, max]` 后**向下取整**的值，条宽用**未取整**的真实比例，且该类型**不渲染 `description`**（`SettingsView.vue:506-541,933-949,1005-1007`）。`status` 再带 `modal: true` 时值**非空**即以**不可关闭的等待模态框**展示（没有关闭按钮、`Esc` 无效、点遮罩不关闭；`default` 请写 `''`），扩展在任务结束时写 `''` 清空该键、模态框才消失。**老宿主（≤ v1.0.8）没有未知类型兜底分支**，`directory` / `status` / `progress` 字段都不会渲染出控件，需要兼容时请自行降级为 `text`；`modal` / `max` 更是老宿主**不认识的可选属性**，老宿主忽略它们且**不报错、不崩**（只是不弹模态框 / 按缺省 100 处理）。**有未知类型兜底、但尚未实现 `status` / `progress` 分支的中间版本宿主**会把它们兜底成**可编辑文本框**（值取自同一设置存储，但可被用户误编辑覆盖）——`progress` 要在老宿主上有正确表现，正解是声明 `apiVersion: 2` 让老宿主**直接拒绝加载**（见上表 `apiVersion` 行），而不是指望降级显示。详见 `themes-settings.md` 的"`directory` 字段"、"`status` 字段"、"`progress` 字段"与"`modal` 属性"。设置"扩展"节点按扩展名展示其设置页。

#### settings 字段校验（`scripts/validate-manifest.mjs`，**脚本独有的静态收紧**）

`contributes.settings` 是**唯一一处宿主与脚本校验规则不对称**的贡献点：`scripts/validate-manifest.mjs` 有一整段 settings 校验（`:220-303`，在 `validateManifest` 里由 `:412-414` 挂上），而**宿主 `core/manifest.ts` 的 `validateManifest` 完全不校验 settings**（只在出现时注册，`core/host.ts:205`）。跑法：`node scripts/validate-manifest.mjs <manifest.json>`（`--all` 扫全部、`--json` 机器可读）。

**规则与错误文案（逐字，全部是 `error` 级）**：

| 规则                                                                                                     | 错误文案（`${name}` = 字段定位名）                                                                                                              | 证据                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `contributes.settings` 出现时必须是 `{id, title, fields}` 对象                                              | `contributes.settings 必须是 {id, title, fields} 对象`                                                                                             | `scripts/validate-manifest.mjs:296-298`      |
| `fields` 必须是数组                                                                                        | `contributes.settings.fields 必须是数组`                                                                                                           | `:299-301`                                   |
| 逐项必须是对象                                                                                             | `设置字段第 ${N} 项必须是对象`                                                                                                                     | `:243-245`                                   |
| `key` 必须是非空字符串（`trim()` 后非空）                                                                   | `设置字段 ${name} 缺少 key（必须为非空字符串）`                                                                                                     | `:248-250`                                   |
| `label` 必须是非空字符串                                                                                    | `设置字段 ${name} 缺少 label（必须为非空字符串）`                                                                                                   | `:251-253`                                   |
| `type` 必须在**字段类型白名单**内                                                                          | ``设置字段 ${name} 的 type ${JSON.stringify(type)} 非法（允许：${白名单.join(' / ')}）``                                                              | `:254-259`                                   |
| `max` **一旦出现**必须是 **> 0 的有限数字**（`number` + `Number.isFinite` + `> 0`）                          | `设置字段 ${name} 的 max 必须为大于 0 的数字`                                                                                                       | `:260-267`                                   |
| `progress` 的 `default` **一旦出现**必须是**有限数字**（**越界不报错**）                                     | `设置字段 ${name} 的 default 必须是数字（progress 越界不报错，宿主渲染时钳制到 0..max）`                                                             | `:268-280`                                   |

- **字段类型白名单**（`SETTING_FIELD_TYPES`，`scripts/validate-manifest.mjs:226-234`）：`text` / `number` / `boolean` / `select` / `directory` / `status` / `progress`——与宿主 `SettingFieldType`（`src/api/contributions.ts:106-107`）**逐字一致（含顺序**，因为报错文案直接把这个顺序列出来**）**。防漂移门禁有两道：`test/manifest-script-parity.test.ts`（同一批 fixtures 喂脚本与宿主，`{level,message}` 多重集必须逐字相同）与 `test/settings-progress-field.test.ts` 的「⑨ 脚本白名单与宿主 `SettingFieldType` 白名单逐字相等」（解析两侧源码逐项比对）。**增删/改名任何字段类型都必须两侧同步。**
- **字段定位名**：有合法 `key` 用 `"key"`（带引号），`key` 本身非法时用「第 N 项」（`settingFieldName`，`:236-239`）——保证报错可执行。
- **`max` 为什么必须 > 0 且有限**：`0` / 负数会让条宽除零或反向；`'100'` 这类字符串与 `NaN` / `Infinity`（JSON 里 `1e999` 就写得出来）都不是可渲染的上限。
- **`progress` 的 `default` 越界为什么**不**报错**：宿主渲染时会钳制到 `[0, max]`（`default: 150` 等效满格），属"合法但会被钳制"的声明，报 error 反而把它拦死（口径与 design 一致；行为见 `themes-settings.md` 的「`progress` 字段」）。
- **刻意不对称（脚本严、宿主松），不是遗漏**：宿主运行期对**未知字段类型**走的是**兜底渲染**——按 `text` 渲染成可编辑文本框 + 一条 `[settings] 未知设置字段类型 …` 的 `console.warn`（`SettingsView.vue:994-999` + `unknownTypeValue` `:552-561`），**不是清单 error**（宿主不希望类型演进时设置项"凭空消失"）。但把 `type` 写错（如 `gauge`）的 manifest 一旦发布，用户装上后**只读**字段（`status` / `progress`）就变成可编辑文本框，误编辑即覆盖扩展写的状态——**静态校验是发布前唯一的拦截点**，所以脚本比宿主严（理由逐字写在 `scripts/validate-manifest.mjs:284-294` 的注释里）。
- **差分门禁不受这段影响**：现有 parity fixtures 不含非法 settings（`test/fixtures/manifest-parity/ok-full.json` 的 settings 声明合法，脚本与宿主两侧都 0 error），所以"脚本独有"不会让差分门禁失败。
- **`core/manifest.ts` 目前不校验 settings**（宿主侧连形状都不查）。**若将来要让宿主与脚本对齐**（宿主也对非法 settings 报清单 error），**需另开卡**：那会改变坏清单在宿主侧的表现（从"兜底渲染"变成"清单无效、扩展标红不加载"），必须同时改 `core/manifest.ts`、补 parity fixtures，并重跑 `test/manifest-script-parity.test.ts`。

### updater（更新提供者，manifest 声明）

声明该扩展为"更新提供者扩展"：提供 obox 更新能力（检查/下载/安装），在**设置-更新**中选择生效（只能一个；无默认更新源，`core/updaterStore.ts:41-52`）。

```json
{
  "contributes": {
    "updater": {
      "feedUrl": "https://example.com/updates"
    }
  }
}
```

| 字段      | 必填 | 说明                                                                                                                                                                                                                |
| --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feedUrl` | ❌   | 更新源 URL（electron-updater generic provider）；**推荐用 `api.update.resolveFeed(repo)` 动态解析"最后一次编译"的 release**（见 `api-reference.md`），feedUrl 仅作兜底（无 resolveFeed 的旧宿主用 latest/download） |

选中后扩展可调用 `api.update.*`（详见 `api-reference.md`）；**只有当前生效的提供者能调用**，否则抛"当前扩展不是生效的更新提供者（需在设置-更新中选择）"（`core/host.ts:823`）。**只能有一个更新提供者生效**；未选择时不检查更新。

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

| 字段      | 必填 | 说明                                                                   |
| --------- | ---- | ---------------------------------------------------------------------- |
| `command` | ✅   | 命令 id（**必须**在 contributes.commands 声明，否则 warning 且不注册） |
| `key`     | ✅   | 组合键字符串，写法见下                                                 |

- `key` 推荐写成**事件侧规范化后**的形式：修饰键 `Ctrl`/`Alt`/`Shift`，单字符主键大写（`Ctrl+Shift+K`），`ArrowUp`→`Up`、`Escape`→`Esc`、空格→`Space`（`core/keybindings.ts:151-171`）
- **大小写与别名会归一（issue #79）**：声明侧与 keydown 侧都过 `normalizeKey`（`core/keybindings.ts:87-149`），`Ctrl+Shift+k`、`ctrl + shift + K`、`Ctrl+Shift+K` 是**同一绑定**；修饰键别名 `control`/`cmd`/`command`/`meta`→`Ctrl`、`option`→`Alt`，命名主键别名 `escape`→`Esc`、`arrowup`→`Up`、`space`→`Space`、`del`→`Delete` 等也可用
- 归一**不重排修饰键顺序**（`Shift+Ctrl+P` 仍是另一个绑定），也**不把 `Ctrl+k` 与 `Ctrl+Shift+K` 视为等价**（Shift 是独立一维）；表外的多字符主键（`F1`、`PageUp`）按 `e.key` 原样比对，请用规范写法
- 与内置/其他扩展快捷键**冲突时 warning 且不注册**（该扩展其余功能不受影响，`core/host.ts:219-231`；重名比较同样按归一后的组合键）
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

| 字段      | 必填 | 说明                                                                   |
| --------- | ---- | ---------------------------------------------------------------------- |
| `command` | ✅   | 命令 id（**必须**在 contributes.commands 声明，否则 warning 且不注册） |
| `when`    | ❌   | 显隐条件（首版仅 `'false'` 即隐藏，其余恒真）                          |

- 菜单按**注册 App 卡片的那个扩展**匹配（`core/registry.ts:146-149`）：右键该扩展的 App 卡片即弹出菜单，菜单项执行命令 handler（`extensions/app/AppView.vue:16-35`）

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

| 字段    | 必填 | 说明                                                     |
| ------- | ---- | -------------------------------------------------------- |
| `id`    | ✅   | 视图 id（全局唯一，建议含扩展前缀；数据源注册用同一 id） |
| `title` | ✅   | 显示名（导航 tooltip / 内容区标题）                      |
| `icon`  | ✅   | 图标（SVG 字符串）                                       |
| `group` | ❌   | `top`（默认）/ `bottom`                                  |

- 声明即注册为导航项，强制 `view = 'obox.tree'`（内容区渲染内置树组件，`core/host.ts:244-246,881`）；节点点击执行 `command`（TreeItem 上声明，`args` 作参数）

### ipcChannels（静态声明 IPC 通道，issue #45）

```json
{
  "contributes": {
    "ipcChannels": [
      { "id": "worker", "transport": "stdio", "program": "bin/worker.exe", "args": ["--serve"] },
      { "id": "bus", "transport": "pipe", "framing": "ndjson" }
    ]
  }
}
```

| 字段        | 必填     | 说明                                                                                                             |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`        | ✅       | 通道名（同扩展内唯一；`/^[A-Za-z0-9][A-Za-z0-9._-]*$/` 且不能含 `..`，`shared/ipcDeclaration.ts:40-47,130-132`） |
| `transport` | ✅       | `stdio`（宿主拉起）/ `pipe`（连接已在运行的进程）；**不支持 TCP/端口**（`shared/ipcDeclaration.ts:65-68`）       |
| `program`   | stdio ✅ | 相对**扩展目录**的路径：禁止绝对路径、盘符与 `..`（`shared/ipcDeclaration.ts:77-92`）                            |
| `args`      | ❌       | 仅 stdio 可声明；字符串数组，非法即 error（`shared/ipcDeclaration.ts:93-98`）                                    |
| `framing`   | ❌       | `content-length`（默认）或 `ndjson`（`shared/ipcDeclaration.ts:12,70-73`）                                       |

- 声明后代码里只写 `api.ipc.connect('<id>')`（**不自动连接**：避免启动被对端拖慢）
- `pipe` 通道**不得**声明 `program`/`args`（它是连接已在运行的进程，`shared/ipcDeclaration.ts:99-101`）
- `program` 以 `.js`/`.cjs`/`.mjs` 结尾时用**宿主自带 Node** 运行（`[program, ...args]`），扩展无需自带解释器；其它一律直接执行（Rust/Python/Go 等编译产物，`main/ipc.ts:155-160`）
- stdio 子进程 cwd = `<扩展目录>/data`（`main/ipc.ts:153`），所以 `args` 里的相对路径按该目录算
- 校验与运行时声明**同一套规则**（`src/shared/ipcDeclaration.ts`）：非法声明 → **清单无效**（扩展标红 + 明确错误），而不是等到 `connect()` 才炸
- 同名冲突以**运行时声明优先**（传字符串时按清单解析，传对象时用运行时声明，`core/host.ts:1322-1330`）；声明本身不占用"每扩展 4 条通道"的额度（只有真正 `connect()` 才占用，`main/ipc.ts:101-114`）

## 校验规则（`core/manifest.ts`）

### error（含 error 的扩展 `isValid=false`，不加载，但在管理列表标红）

| 字段                     | 约束                                                                                                                                                              | 证据                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `name`                   | 必填、字符串，匹配 `/^[a-z0-9][a-z0-9._-]*$/`（**不带 `i`**，含大写即 error）                                                                                     | `core/manifest.ts:11,22`   |
| `version`                | 必填、字符串，匹配 semver 正则                                                                                                                                    | `core/manifest.ts:12,25`   |
| `apiVersion`             | 出现时须为非负整数，且不得高于 obox 的 API 版本                                                                                                                   | `core/manifest.ts:28-38`   |
| `main`                   | 必填、字符串、去空白后非空                                                                                                                                        | `core/manifest.ts:39-41`   |
| `contributes`            | 出现时必须是对象                                                                                                                                                  | `core/manifest.ts:42-44`   |
| `extensionDependencies`  | 出现时必须是字符串数组——非数组值（`{}` / `5` / `true`）只记一条 error，**不再抛 `TypeError` 打断整轮扫描**（issue #83）；且**不能包含自身**（"扩展不能依赖自身"） | `core/manifest.ts:120-128` |
| `contributes` 的八类数组 | `ipcChannels` / `keybindings` / `menus` / `views` / `navItems` / `statusBarItems` / `commands` / `themes`，形状规则见下一节                                       | `core/manifest.ts:46-119`  |
| `contributes.settings` 的字段（**仅 `scripts/validate-manifest.mjs`**；宿主 `core/manifest.ts` **不校验**） | `settings` 出现时必须是 `{id, title, fields}` 对象、`fields` 必须是数组；逐项：`key` / `label` 非空字符串、`type` ∈ 七类白名单（含 `progress`）、`max` 出现须为 > 0 的有限数字、`progress` 的 `default` 出现须为数字（越界不报错） | `scripts/validate-manifest.mjs:242-303,412-414`（文案逐字见「settings 字段校验」） |

> **issue #77（行为变更）**：`name` 正则此前带 `i`（`MyExt`、`MY-EXT` 都会被接受），而 `test/manifest.test.ts` 的用例标题写的是「大写 → error」却没有任何大写断言。现决定**去掉 `i`**：大写 id 一律报 error，测试标题与断言一并订正，并新增 parity fixture `bad-name-uppercase.json` 让宿主与脚本逐字对齐。该变更随修复进入 master（发版说明在 1.0.6 统一记录）。
>
> **破坏性**：已安装的大写 id 用户扩展会变成「清单无效」（不加载、在扩展管理器标红）。
>
> **未同步处（同批未改）**：`.oix` 安装链路的 `main/oixCore.ts:18`、主进程 `main/debug.ts:12` 与 `main/extGuard.ts:17`，以及两个脚手架脚本 `scripts/create-extension.mjs:29` / `create-user-extension.mjs:38` 的 `ID_RE`，都仍是带 `i` 的同名正则。后果：大写 id 的 `.oix` 包仍能装进来、脚手架也能生成大写 id 的骨架，但渲染进程会把它们判为清单无效——如需彻底一致，另开 issue 处理。

### 八类数组形状 error（`contributes` 内，只在这些键**出现**时校验）

| 贡献点           | 约束                                                                    | 非法样例 → 报错文案                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ipcChannels`    | 必须是数组；逐项约束见「ipcChannels」一节（id/transport/framing/端点）  | `{"id":"worker","transport":"tcp"}` → `contributes.ipcChannels 非法：第 1 项：通道 worker 的 transport 必须是 'stdio' 或 'pipe'（不支持 TCP/端口）`（`core/manifest.ts:49-55`） |
| `keybindings`    | 必须是数组；每项的 `command`、`key` 都必须是字符串                      | `{"command":"my-ext.do"}` → `keybindings 必须是 [{command, key}] 数组`（`core/manifest.ts:57-71`）                                                                              |
| `menus`          | 必须是数组；每项的 `command` 必须是字符串（`when` 可选）                | `{"when":"false"}` → `menus 必须是 [{command, when?}] 数组`（`core/manifest.ts:72-83`）                                                                                         |
| `views`          | 必须是数组；每项的 `id`、`title`、`icon` 都必须是字符串（`group` 可选） | `{"id":"my-ext.tree","title":"我的树"}` → `views 必须是 [{id, title, icon, group?}] 数组`（`core/manifest.ts:84-101`）                                                          |
| `navItems`       | **只校验"必须是数组"**（issue #84 新增）                                | `{}` → `navItems 必须是 [{id, title, icon, view?}] 数组`（`core/manifest.ts:105-110`）                                                                                          |
| `statusBarItems` | **只校验"必须是数组"**（issue #84 新增）                                | `5` → `statusBarItems 必须是 [{id, name}] 数组`（`core/manifest.ts:111-113`）                                                                                                   |
| `commands`       | **只校验"必须是数组"**（issue #84 新增）                                | `true` → `commands 必须是 [{command, title}] 数组`（`core/manifest.ts:114-116`）                                                                                                |
| `themes`         | **只校验"必须是数组"**（issue #84 新增）                                | `{}` → `themes 必须是 [{id, label, tokens}] 数组`（`core/manifest.ts:117-119`）                                                                                                 |

- 键存在但值**不是数组**（如 `"keybindings": "x"`、`"ipcChannels": {}`）与"数组里某项缺必填字符串"报**同一条** error（前四类）
- 后四类（`navItems` / `statusBarItems` / `commands` / `themes`）**只校验数组形状**：数组里逐项缺字段仍是宿主侧 warning（见下一节），不是 error——这样既有清单行为不变（issue #84）
- **宿主侧另有运行时防御**：`core/manifest.ts:140-142` 的 `contributesArray(value)`（`Array.isArray(value) ? value : []`）被 `core/host.ts:160-168`（注册期七类）与 `core/host.ts:270-273`（激活期视图导出表）使用，因此即使坏清单绕过校验（热重载 / 旧快照）也不会在注册/激活期抛 `TypeError`，而是按空数组跳过
- `ipcChannels` 的形状与逐项错误统一包成一条：`contributes.ipcChannels 非法：…`，逐项失败带 `第 N 项：` 前缀，重复 id 报 `通道 id 重复: X`（`shared/ipcDeclaration.ts:120-137`）
- 只查形状：可选字段的**取值**不校验（`views[].group`、`when` 由运行时按字面处理）；`ipcChannels` 另有 `id` 重复检查（`shared/ipcDeclaration.ts:130-132`）
- 引用完整性（`keybindings`/`menus` 引用的命令是否已声明）**不是** error，而是 warning，见下

### warning（该项跳过，扩展仍加载）

| 情形                                       | 文案 / 证据                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 导航项缺 `id`/`title`/`icon`               | `导航项缺少 id/title/icon: …`（`core/host.ts:169-176`）                                           |
| 状态栏项缺 `id`/`name`                     | `状态栏项缺少 id/name: …`（`core/host.ts:177-184`）                                               |
| 命令缺 `command`/`title`                   | `命令缺少 command/title: …`（`core/host.ts:185-192`）                                             |
| **主题缺 `id`/`label`/`tokens`**           | `主题缺少 id/label/tokens: …`——**warning，不是 error**（`core/host.ts:193-201`）                  |
| 导航项 `view` 未在扩展入口具名导出         | `导航项 X 声明的视图组件 Y 未在扩展入口导出`（`core/host.ts:249-255`）                            |
| `keybindings` 引用的命令未在 commands 声明 | `keybindings 引用的命令 X 未在 contributes.commands 声明`（`core/host.ts:211-216`）               |
| 快捷键 `key` 已被别的命令占用              | `快捷键 X 已被 Y 占用（Z 未注册）`——重名按归一后的组合键比较（issue #79，`core/host.ts:219-229`） |
| `menus` 引用的命令未在 commands 声明       | `menus 引用的命令 X 未在 contributes.commands 声明`（`core/host.ts:235-241`）                     |

- 校验消息（error + warning）统一收集进扩展的 `validations`，在扩展管理器详情页展示；含 error 的扩展 `isValid=false`，不加载但出现在管理列表标红（`core/manifest.ts:152-162`）
- `contributes.i18n` / `settings` / `updater` 在**宿主侧**既不做形状校验、也没有"缺字段 warning"，只在出现时注册（`core/host.ts:203-207`）。**唯一例外是 `contributes.settings`**：发布前脚本 `scripts/validate-manifest.mjs:295-303,412-414` 会做静态校验（全 `error` 级，规则与文案见上文「settings 字段校验」）——那是**脚本独有的收紧**，宿主运行期对未知字段类型走兜底渲染（+ 一条 warn）而不是清单 error

## 扩展 id 与命令 id 约定

- 扩展 id：`my-ext`（小写连字符；正则**不带 `i`**，含大写即清单无效，issue #77）
- 命令 id：`<扩展名>.<动作>`（`my-ext.do`）。跨扩展同 id 命令**被拒**（保留先注册者，仅 `console.warn`，见上）
- 导航/状态栏/App 卡片 id：建议含扩展前缀（`my-ext.home`）
- 内置扩展 id 已用（`src/renderer/src/extensions/*/manifest.json`）：`app`（应用）、`ext-manager`（扩展管理器）、`settings`（设置）、`theme-dark`（深色主题）、`theme-light`（浅色主题）
