# spec：obox 扩展开发 skill（`skills/obox-ext-dev/`）优化

| 项       | 值                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态     | ✅ 已完成（spec 于开发前经用户确认；实现见 PR #85 文档层、#86 脚本层，验收记录见文末「验收记录」）                                                                                                                                                                                               |
| 来源     | 本会话 9 轮问答（Q1–Q9）+ 3 个只读核查子代理的事实结论                                                                                                                                                                                                                                           |
| 归档     | 需求完成后：`tmp/spec/` → `<开发目录>/docs/spec/`，`tmp/adr/` → `<开发目录>/docs/adr/`，**随后删除整个 `tmp/` 目录**。三级目标：仓库自身/宿主/skill → 仓库 `docs/`；内置扩展 → `src/renderer/src/extensions/<id>/docs/`；用户扩展 → `extensions/<id>/docs/`。本次是仓库自身开发 → 落仓库 `docs/` |
| 归档结果 | 已按 R11 执行：本文件与设计文档从 `tmp/spec/` 移入 `docs/spec/`，ADR 从 `tmp/adr/` 移入 `docs/adr/`，`tmp/` 目录已删除                                                                                                                                                                           |

---

## 1. 背景与问题（已核查的事实）

### 1.1 可发现性

`skills/obox-ext-dev/` **不是 DSH 会扫描的 skill 根**。DSH 只扫描四处（`dsh-skill-filesystem` 优先级表）：`<repo>/.dsh/skills`、`<repo>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`；本仓库只有根级 `skills/`。因此它**不出现在会话 skill 目录里**，不能按名字触发，只能靠 `AGENTS.md` 的指针被读到（`AGENTS.md:22,24,26,47` 共 4 处，均用路径）。

### 1.2 体量

| 文件                               | 字符   | 说明                                            |
| ---------------------------------- | ------ | ----------------------------------------------- |
| `SKILL.md`                         | 7,053  | 离 DSH 的 8192 字符工具结果裁剪阈值只剩约 1,100 |
| `references/api-reference.md`      | 27,659 | 最大，且含 488–555 行的碎片堆积                 |
| `references/troubleshooting.md`    | 19,080 | 按编号条目组织                                  |
| `references/guides.md`             | 16,367 | **内置扩展教程与用户扩展教程混在一起**          |
| `references/manifest-reference.md` | 14,236 |                                                 |
| `references/themes-settings.md`    | 4,188  |                                                 |
| `scripts/*`（3 文件）              | 9,687  |                                                 |

### 1.3 两类受众被混写

内置扩展（`src/renderer/src/extensions/<id>/`，TypeScript + Vite，随应用打包、不可卸载）与用户扩展（独立仓库 `extensions/<id>/`，**入口必须是纯 ESM JavaScript**、零 npm 依赖、`.oix` 分发、装到 `userData/extensions/<name>_<author>/`）开发方式完全不同，却写在同一份 `guides.md` 与同一份 `SKILL.md` 里。同一个含义在 `SKILL.md` 与 references 里各写一遍，复制即漂移。

### 1.4 会让代理写错代码的硬错误（子代理逐条核对所得）

`references/api-reference.md` / `manifest-reference.md`：

1. `api-reference:340` 与代码相反，且与紧邻的 338 段自相矛盾：`proxy.ts:4-7` 明说写 `HTTP_PROXY` / `NODE_TLS_REJECT_UNAUTHORIZED` 对两条链路都无效，正确做法是 338 段的 session 级 `setProxy` / `setCertificateVerifyProc`。
2. `api-reference:591` 教的 `api.output.append('worker', text)` 不存在：`types.ts:420` 只有 `createChannel`，`append` 在返回的 channel 上。
3. `api-reference:30`（及 `SKILL.md:39`）说"未声明命令只 console.warn"：实际 `registry.ts:193` 直接 `throw`，会让 `plugin(api)` 抛错、扩展标红（`activationError`）。
4. `api-reference:480` 说 secrets 失败"返回错误"：实际 `host.ts:505/510/514` 是 `throw new Error(...)`。
5. `api-reference:287` 说 timer 非法参数"抛错"：实际 `host.ts:606-608` 用 `void` 丢弃 invoke，只是未处理 rejection；且漏了 `≤86400` 上限（`timer.ts:28`）。
6. `api-reference:293` 说 exec/query 都返回 `{ok:false}`：只有 `exec`（`host.ts:634`）原样返回，`query` 经 `call()` 抛错。
7. `api-reference:664`（及 `SKILL.md:45`）说依赖环"跳过"：实际 `manifest.ts:165-168` 把环内扩展 push 进 `ordered`、`host.ts:909` 照常激活，只是排最后。
8. `manifest-reference:23-24` 教人写 `arch` / `python` 字段，但公开类型 `ExtensionManifest` 没有这两个字段（`api/manifest.ts:9-33`）→ 照文档写会 TS 报错。
9. 校验规则漏写 `keybindings` / `menus` / `views` / `ipcChannels` 四类数组形状 error（`manifest.ts:55-99`）。
10. `name` 正则文档写不带 `i`（`manifest-reference:14,270`），代码 `manifest.ts:9` 带 `i`（实测 `MyExt` 通过）；`test/manifest.test.ts:30` 的标题意图（大写→error）与代码冲突。

`references/guides.md` / `themes-settings.md` / `troubleshooting.md`：

11. `guides.md:131-143` 的 App 卡片示例用 `html` 内联 `<script>`，与 `troubleshooting.md:7-11`、`guides.md:166` 及示例自己的注释三处自相矛盾（srcdoc 继承 `script-src 'self' app:`，内联必被拦，照抄的按钮不会响应）。
12. `guides.md:167` 说 App 子窗口"首版仅窗口控制"：实际另有 `action:'obox-extension'` + `obox-extension-reply`（`AppWindow.vue:67-97`，对应 `api.app.onMessage`，`types.ts:155-163`），`AppRegistration.iconUrl`（`registration.ts:21-22`）也未记。
13. `troubleshooting.md:151` / `guides.md:412` 说调试扩展数据目录在 `userData/extensions/<id>/data`：不完整——`api.ipc` stdio 的 cwd 是 `extensionSourceDir(id)/data`（`ipc.ts:149-153`，调试扩展即调试目录），只有 `api.fs` / sqlite / python 走 `userData`（`fs.ts:12-14`、`python.ts:34-36`）。
14. `themes-settings.md:81` 说"通用设置仅 Windows 显示"：节点 `SettingsView.vue:236-239` 无平台判断、始终显示，只有两行控件 `v-if="isWindows"`（`:302,:311`）。
15. `themes-settings.md:3,85-88` 设置树漏 `update` / `network` / `notification` 三个分区（`SettingsView.vue:22-29`）。
16. `troubleshooting.md:25` 说"内置扩展没有静态文件通道"：`app://builtin/` 确已注册（`protocol.ts:14,47`）但无构建步骤填充该目录 → 措辞应改为"虽注册但未被构建填充"。

**代码里有、文档完全没写的**：`api.ipc.channels()`（`types.ts:400`）、`AppRegistration.iconUrl`（`registration.ts:21`）、`UpdateEvent` 的 `update-not-available` / `error`（`shared.ts:9,18`）、`TreeItem.icon`（`types.ts:90`）、`SettingField.description`（`contributions.ts:88`）、`app://builtin` 与 `app://debug`（`protocol.ts:13-15,46-58`）、ipc 每通道并发上限 64（`ipcCore.ts:27`）、入口钩子 10s 超时（`hookBridge.ts:16`）、`window.*` 实际作用于**焦点窗口**（`window.ts:97,116`）。

### 1.5 `scripts/` 的缺陷（实测）

- `validate-manifest.mjs`：漏检 `ipcChannels` / `keybindings` / `menus` / `views` 四类 error，实测对 `transport:"tcp"` 输出「✓ 通过」exit 0（**给无效 manifest 发绿灯，比没有更糟**）；`:135-143` `access(p)` 未 await → Promise 恒真、catch 是死代码（目录只有 `index.ts` 时崩栈）；缺 `package.json` 时顶层 `JSON.parse` 崩栈。
- `create-extension.mjs`：生成物可跑，但缺 `titleKey`（英文界面显示中文标题）与主题 token 模板；`ID_RE` 不带 `i`，与宿主 `NAME_RE` 不一致；**在任意裸目录都能静默生成**，不校验"是否 obox 仓库"。
- 两个脚本都没有用户扩展（纯 ESM + `.oix`）脚手架——而 `extensions/todo`、`extensions/obox-updater` 证明这类扩展真实存在。
- `eslint.config.mjs:8` 的 ignores 含 `skills/**`，这两个脚本既无 lint 也无 typecheck 门禁 → 静默腐烂的机制原因。

### 1.6 其他相关事实

- `extensions/todo`、`extensions/obox-updater` **没有** AGENTS.md / README，单独打开这些目录时无指针。
- 仓库没有 `tmp/`，`.gitignore` 也未忽略（本次已补）。
- `scripts/make-tray-icon.mts` 头部已记录坑：Node 原生跑 `.mts` **无法解析 `src/` 内部的无扩展名 import**（仓库也没装 `tsx` / `vite-node`）→ 校验脚本无法直接 import 宿主规则。
- 仓库已有防漂移先例：`node scripts/collect-python-licenses.mts --check`（退出码 1 = 需重新生成）。

---

## 2. 目标

让这份 skill 在**两类受众**手里都"读得对、走得通、不再腐烂"：

1. 受众分流：让代理一眼判定"我在做内置扩展还是用户扩展"，并只读自己那条线。
2. 事实零漂移：把上列全部硬错误修掉，并用机制（差分门禁）阻止复发。
3. 需求先澄清：调用本 skill 开发扩展时，必须先问清需求、写 spec、经用户确认、写设计文档，再开发，最后测试与审视——**不许自行扩大范围**。
4. 留痕：决策进 ADR（`tmp/adr/` → 对应扩展目录 `docs/adr/`）。

## 3. 非目标

- 不注册为 DSH 可触发 skill（Q5：维持 `AGENTS.md` 指针），不动 `.agents/skills` 与 `~/.dsh/skills`。
- 不处理与其它项目的同名 skill 冲突（Q5 答复：与 Rust obox 无关）。
- 不新增/修改宿主 API 与主进程行为（脚本除外）。
- 不修 `core/manifest.ts` 的 `name` 正则，也不改 `test/manifest.test.ts`；只在文档按代码实际行为写明，并单独开 issue 记录"代码与测试意图冲突"。
- 不把 `extensions/todo` / `obox-updater` 纳入仓库（仍由 `.gitignore` 的 `/extensions/` 排除）。
- 不做与扩展开发无关的 skill 内容。

---

## 4. 需求

| #   | 需求                                                                                                                                                                                                                                                                                                                                                 | 来源            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| R1  | 受众覆盖**内置扩展 + 用户扩展两类**                                                                                                                                                                                                                                                                                                                  | Q1              |
| R2  | 形态：**一份 `SKILL.md` + references 按受众拆**                                                                                                                                                                                                                                                                                                      | Q2              |
| R3  | 切法：**共享主题保留、教程按受众拆**。共享：`api-reference.md`、`manifest-reference.md`、`troubleshooting.md`（按症状查，不按受众猜）、`themes-settings.md`；教程：`guides-builtin.md`（脚手架 / TS+Vite / i18n `titleKey` / 质量门禁）、`guides-user.md`（纯 ESM 入口 / `.oix` 打包安装 / `--debug-extension` + `launch.json` / Python 运行时打包） | Q3              |
| R4  | 脚本：`validate-manifest.mjs` **自包含重写**（补四类 error、修死代码、容错）+ `create-extension.mjs` 改造 + **新增 `create-user-extension.mjs`** + 仓库内**差分测试门禁**（同一批 fixture 喂脚本与 `validateManifest()`，结论必须一致）                                                                                                              | Q4              |
| R5  | 触发：**维持 `AGENTS.md` 指针**，不新增 skill 根；`SKILL.md` 首行自我标识"Electron + Vue + Cordis 版 obox（本仓库）"                                                                                                                                                                                                                                 | Q5              |
| R6  | 深度：**全量重排 + 红队验收**                                                                                                                                                                                                                                                                                                                        | Q6              |
| R7  | 流程机制：**分级强制 + 三级 ADR 落位**（用户扩展 → `extensions/<id>/docs/adr/`；内置扩展 → `src/renderer/src/extensions/<id>/docs/adr/`；宿主/主进程/扩展系统自身 → 仓库 `docs/adr/`，续 `0020`）                                                                                                                                                    | Q7              |
| R8  | **必问 8 项**（每需求都问，与需求内容无关）                                                                                                                                                                                                                                                                                                          | Q8              |
| R9  | 流程分级：**按"是否改变对外行为/数据"**决定走全流程还是轻流程                                                                                                                                                                                                                                                                                        | Q9              |
| R10 | 新增前置流程：**提问 → 写 spec → 用户确认 → 写设计文档 → 开发 → 测试 + 审视 → ADR 归档**                                                                                                                                                                                                                                                             | 本轮新需求      |
| R11 | spec 与设计文档放 `tmp/spec/`，临时 ADR 放 `tmp/adr/`；整个 `tmp/` 进 `.gitignore`；需求完成后把 `tmp/spec/` 与 `tmp/adr/` 移到对应开发目录的 `docs/` 下（三级落位），并**删除 `tmp/` 目录**                                                                                                                                                         | 本轮新需求 + Q7 |
| R12 | 本次优化自身先跑一遍 R10（先 spec，确认后再设计）                                                                                                                                                                                                                                                                                                    | 本轮新需求      |

### R8 必问 8 项（定义）

| #   | 必问项                 | 要问出什么                                                                                                                     |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| M1  | 类型与落位             | 内置（改仓库源码，TS+Vite，随应用打包不可卸载）还是用户扩展（独立仓库，纯 ESM JS，零 npm 依赖，`.oix` 分发）；扩展 id 与显示名 |
| M2  | 贡献点集合             | 导航项 / 状态栏项 / 命令 / 树视图 / App 卡片 / 主题 / 设置 schema / 快捷键 / 菜单，要哪些                                      |
| M3  | UI 形态                | Vue 组件 / 自带 HTML 静态页（`app://extensions/<id>/`）/ App 子窗口 iframe / 无 UI                                             |
| M4  | 状态与数据             | Memento（`workspaceState` / `globalState`）/ sqlite / `api.fs` 文件 / `secrets` / 不持久化；**旧数据与旧配置如何兼容**         |
| M5  | 外部依赖               | 无 / `api.ipc` 子进程 / `api.python` 运行时 / `api.net` 网络 / updater                                                         |
| M6  | 目标平台               | Windows / macOS / Linux；托盘、开机自启、通知等能力**仅 Windows**                                                              |
| M7  | 是否需改宿主或新增 API | 命中即扩大到主进程/宿主范围，且 ADR 落位改判为仓库 `docs/adr/`                                                                 |
| M8  | 发布方式与验收交付     | `.oix` 打包 / 版本号 / 更新通道；怎么算做完；是否中英双语（`titleKey` + zh/en 词条）                                           |

### R8 个性化追问（命中才问）

不可信第三方代码 → 信任边界（ADR-0015）；安装/卸载/升级 → 生命周期钩子幂等与回滚；跨扩展调用 → `extensionDependencies` 与命令归属；大数据量/查询 → sqlite 与文件的选型；改造已有扩展 → 迁移路径与向后兼容；性能敏感 → 定时器/监听/进程开销；并发/多窗口 → 子窗口不跑扩展代码的约束。

### R8 三条硬边界

1. 只实现确认过的贡献点与行为，**多一个也算越界**。
2. 一旦发现要新增/修改宿主 API 或主进程能力，**停下来问**（并按 M7 改判 ADR 落位）。
3. 用户扩展不引入 npm 依赖、内置扩展不新增依赖；要加先问。

---

## 5. 交付物

| 文件                                                                        | 动作                                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `skills/obox-ext-dev/SKILL.md`                                              | 重写：首行自我标识 + 受众判定 + 两条最小路径 + 流程骨架 + 铁律；修硬错 #3 / #7；细节全部下沉 references；目标 ≤ 5,500 字符      |
| `skills/obox-ext-dev/references/workflow.md`                                | **新增**：R8 必问 8 项、个性化追问、三条硬边界、R9 分级判据、R10 九阶段流程、spec / 设计文档模板、`tmp/` 与三级 ADR 落位规则    |
| `skills/obox-ext-dev/references/guides-builtin.md`                          | 由 `guides.md` 的内置部分拆出，并按事实修错                                                                                     |
| `skills/obox-ext-dev/references/guides-user.md`                             | 由 `guides.md` 的用户扩展部分拆出（含 `--debug-extension`、`.oix`、Python 打包），修错 #11 / #12                                |
| `skills/obox-ext-dev/references/api-reference.md`                           | 修硬错 #1–#8、#10；补 1.4 节"代码有文档无"的 API；合并 488–555 碎片；outline 统一；"宿主生命周期语义"前移                       |
| `skills/obox-ext-dev/references/manifest-reference.md`                      | 删 `arch` / `python` 教学；补四类数组形状 error；`name` 正则补 `i`；补缺失内置前缀（`settings` / `theme-dark` / `theme-light`） |
| `skills/obox-ext-dev/references/troubleshooting.md`                         | 修 #13 / #16 等；删低价值条目（`#14` HMR 泛泛建议、`#12` 标题序号、`#3` Vite 常识与重复、`#16` 已修复 bug 的历史叙述压缩）      |
| `skills/obox-ext-dev/references/themes-settings.md`                         | 修 #14 / #15；标注两个"只声明未使用"的 token                                                                                    |
| `skills/obox-ext-dev/scripts/validate-manifest.mjs`                         | 自包含重写（四类 error + 容错 + 仓库布局支持 + 可读报错）                                                                       |
| `skills/obox-ext-dev/scripts/create-extension.mjs`                          | 补 `titleKey` 与主题 token 模板、修 `ID_RE`、加"必须在 obox 仓库内"断言                                                         |
| `skills/obox-ext-dev/scripts/create-user-extension.mjs`                     | **新增**：`extensions/<id>/` = manifest（`main: ./index.js`）+ 纯 ESM `index.js` + `node --test` + `pack.mjs` 产 `.oix`         |
| `skills/obox-ext-dev/scripts/README.md`                                     | 同步三个脚本的用法与退出码                                                                                                      |
| `test/manifest-script-parity.test.ts`                                       | **新增**：差分门禁                                                                                                              |
| `AGENTS.md`                                                                 | 指针更新为改名后的 references；新增"先澄清需求 + spec/设计 + 测试审视"的强制条款                                                |
| `README.md`                                                                 | 文档导航同步                                                                                                                    |
| `docs/adr/0020-extension-dev-skill-workflow.md`                             | **新增**（先写 `tmp/adr/`，完成后移入）：记录「自包含副本 + 差分门禁」「受众分层」「需求澄清与 spec/设计流程」的取舍            |
| `docs/spec/obox-ext-dev-skill.md`、`docs/spec/obox-ext-dev-skill-design.md` | **归档**：本 spec 与设计文档从 `tmp/spec/` 移入（本次是仓库自身开发，故落仓库 `docs/`）                                         |
| `.gitignore`                                                                | 加 `/tmp/`（本次已改）                                                                                                          |

---

## 6. 验收标准

1. **事实零漂移**：1.4 / 1.5 两节列出的每一条都已修（逐条对照；确认为"代码如此、文档按代码写"的，文档措辞与代码一致）。
2. **差分门禁可跑**：`test/manifest-script-parity.test.ts` 用同一批 fixture 同时喂脚本与 `validateManifest()`，结论（error 集合）一致；故意放宽脚本规则时该测试必须变红（要实测验证这一点）。
3. **脚本实测**：`node skills/obox-ext-dev/scripts/validate-manifest.mjs --all` 在仓库内通过（exit 0）；对 `transport:"tcp"` 等非法 fixture 必须 exit 1；`create-extension.mjs` / `create-user-extension.mjs` 在临时目录能生成可用产物，生成物自身通过校验。
4. **门禁绿**：`npm run typecheck`、`npm run lint`、`npm test` 全通过；两个 PR 的 CI `check` 为 success。
5. **红队验收**：两个子代理**只读 `SKILL.md`** 分别执行 ①「做一个用户扩展并打包 `.oix`」②「给内置扩展加一个状态栏项」，都走对路径（类型判定正确、读了正确的 reference），且没有踩文档的坑；发现的坑必须回填进文档。
6. **体量**：`SKILL.md` ≤ 5,500 字符；新增 `workflow.md` ≤ 6,000 字符；共享 reference 无重复含义（同一含义只在一处权威）。
7. **收尾**：合并后 `npm run security:audit` 为 0 告警、Dependabot open 告警为 0；`git status` clean；分支已删。

---

## 7. 风险与已知未决项

| 项                                                                                                           | 处置                                                                  |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `manifest.ts` 的 `name` 正则带 `i` 与 `test/manifest.test.ts:30` 的意图冲突                                  | 文档按代码实际行为写；**单独开 issue** 记录冲突，不在本需求内改代码   |
| `guides.md` 的 `launch.json` 模板未实机验证；`urlFilter` 依赖 electron-vite 默认端口（未固定 `server.port`） | 文档明确标注"未实机验证"，并写明端口可能变化的后果                    |
| python 的 `requirements` 字段（`pythonCore.ts:67`）在 `oixCore.ts:236` 未传入、实际不可达                    | 文档如实标注；是否修代码**另开 issue**                                |
| `--font-size-lg` / `--icon-size` 只声明未被 `var()` 使用                                                     | 文档标注，不改代码                                                    |
| references 全面重排后，`AGENTS.md` / `README.md` 的旧文件名引用                                              | 同 PR 同步，CI 无门禁 → 靠验收第 5 项（红队）与人工核对               |
| 一次改动 5 份 references，diff 很大                                                                          | 按 Q6 接受；两个 PR 切分（PR1 文档 / PR2 脚本），中间 commit 保持原子 |

---

## 8. 验收记录

| 验收标准（第 6 节）       | 结果                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 事实零漂移              | ✅ 两轮独立审视（references 对代码 40+ 条断言、入口/流程三方一致性）+ 两个红队验收；审视最后 9 处、红队 4 处全部改完                                                            |
| 2 差分门禁可跑 + 变异自证 | ✅ `test/manifest-script-parity.test.ts` 13 项；临时放宽 `ipcChannels` 规则 → **2 failed**，还原（SHA256 一致）→ **13 passed**（S7 与我各做一次）                               |
| 3 脚本实测                | ✅ `--all` exit 0；`bad-ipc-transport.json` exit 1；无扩展目录 exit 2；生成物 `node --test` 6/6、`pack.mjs` 出 `.oix`、adm-zip 解包字节一致、`--vue` 变体真实 `vite build` 成功 |
| 4 门禁绿                  | ✅ typecheck / lint / test（408 passed / 5 skipped）；PR #85、#86 的 CI `check` 均 success                                                                                      |
| 5 红队验收                | ✅ 两份报告：类型判定、分级、references 路径、命令序列全部走对；发现的坑已回填文档                                                                                              |
| 6 体量                    | ✅ `SKILL.md` 5,010 字符（限 5,500）；`workflow.md` 5,571 字符（限 6,000）                                                                                                      |
| 7 收尾                    | ✅ 两次合并后 `security:audit` 0 漏洞、Dependabot 0 告警；分支已删；本文件与设计文档、ADR 已归档，`tmp/` 已删除                                                                 |

**范围外代码问题**（均不在本需求内改代码，已开 issue）：#77 `name` 正则与测试措辞、#78 命令 id 重复未写 `validations`、#79 快捷键不折大小写、#80 设置页「扩展」节点无 `@click`、#81 主题 `apply()` 残留、#82 python `requirements` 不可达、#83 非数组 `extensionDependencies` 抛 `TypeError`、#84 贡献点数组形状无防御且校验缺失。
