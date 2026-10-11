# 设计文档：obox 扩展开发 skill（`skills/obox-ext-dev/`）优化

| 项       | 值                                                                                 |
| -------- | ---------------------------------------------------------------------------------- |
| 状态     | ✅ 已完成（按 spec 定稿并经用户确认，一道关卡；实现见 PR #85、#86，归档见 PR #87） |
| 前置     | spec 的 R1–R12 与验收标准第 6 节（原件 `docs/spec/obox-ext-dev-skill.md`）         |
| 归档结果 | 已从 `tmp/` 移入 `docs/spec/`（`tmp/` 目录已删除）                                 |

---

## 1. 决策摘要（spec → 设计）

| spec               | 设计落点                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 双受众          | `SKILL.md` 首屏一张判定表；教程拆 `guides-builtin.md` / `guides-user.md`                                                                                 |
| R2/R3 共享 + 拆分  | references 七份：共享 `api-reference` / `manifest-reference` / `troubleshooting` / `themes-settings` / `workflow`；教程 `guides-builtin` / `guides-user` |
| R4 脚本            | 三个脚本 + 一个差分测试，CLI 契约见 §6；脚本**不 import `src/`**（Node 解析不了无扩展名 import，`scripts/make-tray-icon.mts` 已记录该坑）                |
| R5 触发            | 不新增 skill 根；`SKILL.md` 首行自我标识"Electron + Vue + Cordis 版 obox（本仓库）"                                                                      |
| R6 全量重排 + 红队 | §5 逐文件编辑设计 + §10 验收执行清单（含红队）                                                                                                           |
| R7/R11 流程与落位  | `workflow.md` §4 的九阶段与三级 ADR 落位表                                                                                                               |
| R8/R9 必问与分级   | `workflow.md` 的 M1–M8 表 + 个性化触发表 + 三条硬边界 + 分级判据                                                                                         |
| R12 本次先跑流程   | 已完成：spec → 用户确认 → 本设计文档 → 开发                                                                                                              |

## 2. 文件布局（前 → 后）

```
skills/obox-ext-dev/
  SKILL.md                      （1.2 万字节 → 目标 ≤ 5,500 字符）
  references/
    api-reference.md            共享 · 修错 + 补缺 + 合并碎片
    manifest-reference.md       共享 · 修错 + 补校验规则
    themes-settings.md          共享 · 修错 + 补树节点
    troubleshooting.md          共享 · 修错 + 删低价值 + 条目重编号
    workflow.md                 ★新增 · 需求澄清 → spec → 设计 → 开发 → 测试审视 → ADR 归档
    guides-builtin.md           ★新增（由 guides.md 拆出）
    guides-user.md              ★新增（由 guides.md 拆出）
    guides.md                   ✗删除（内容全部并入上面两份）
  scripts/
    validate-manifest.mjs       重写（自包含）
    create-extension.mjs        改造（内置扩展）
    create-user-extension.mjs   ★新增（用户扩展 + .oix 打包）
    README.md                   同步三个脚本
test/
  manifest-script-parity.test.ts ★新增（差分门禁）
  fixtures/manifest-parity/*.json ★新增（同一批 fixture 喂两边）
```

外围同步：`AGENTS.md`、`README.md`、`docs/adr/0020-extension-dev-skill-workflow.md`、`.gitignore`（已改）。

## 3. `SKILL.md` 设计（≤ 5,500 字符）

**frontmatter**：`name: obox-ext-dev`；`description` 收紧为"开发/调试 **obox（Electron + Vue + Cordis 版，本仓库）** 扩展"，保留触发词（新建/修改/调试扩展、贡献点、App 卡片、manifest）。

章节顺序（信息层级：先判定，再最小路径，再流程骨架，最后铁律；细节全在 references）：

1. **首行自我标识**：一句话说明是哪个 obox（Electron + Vue + TS + Cordis，扩展宿主在渲染进程），避免与同名产品混淆。
2. **判定：你在做哪一类扩展？** 一张表：
   | 判据                                | 类型     | 放哪                                                                 | 入口                        | 分发          | 读哪份              |
   | ----------------------------------- | -------- | -------------------------------------------------------------------- | --------------------------- | ------------- | ------------------- |
   | 随应用打包、改 obox 源码、TS + Vite | 内置扩展 | `src/renderer/src/extensions/<id>/`                                  | `index.ts`（TS）            | 随应用        | `guides-builtin.md` |
   | 独立仓库、给别人装、`.oix`          | 用户扩展 | 独立仓库 `extensions/<id>/` → `userData/extensions/<name>_<author>/` | `index.js`（**纯 ESM JS**） | `.oix`（zip） | `guides-user.md`    |
3. **必做流程骨架**（六行）：提问（M1–M8）→ spec 到 `tmp/spec/` → **用户确认** → 设计文档 → 开发 → 测试 + 独立审视 → ADR 从 `tmp/adr/` 归档。一行"完整规则见 `workflow.md`"，并写明"**不许跳过、不许自行扩大范围**"。
4. **两条最小路径**（各 5 步、只给动作与命令，细节链 references）。
5. **铁律**（≤ 12 条）。必须包含修正后的语义：
   - 声明式贡献点（元数据在 manifest，不用 `ctx.register*`）；
   - **命令必须声明**：未声明的 `registerCommand` 会被 `registry.ts` **抛错**（不是 warning），扩展直接标红 `activationError`；
   - 视图必须具名导出；
   - **依赖环不跳过**：环内扩展仍会激活，只是排到最后（要判环请看宿主日志）；
   - Disposable / cleanup 统一释放；
   - 内置只读、用户扩展可卸载；
   - 子窗口不跑扩展代码（`?obox-window=app`）；
   - 命令 id 全局唯一、跨扩展同名被拒；
   - 扩展是受信代码（无沙箱，ADR-0015）；
   - i18n：内置扩展的 navItem 用 `titleKey` + `zh`/`en` 词条；
   - 平台：托盘 / 开机自启 / 通知**仅 Windows**；
   - 用户扩展零运行时依赖（入口只依赖注入的 `api`；Vue 子应用属构建期，见 `guides-user.md`）。
6. **references 索引表**（七行，一行一份 + 何时读它）。
7. **持续更新要求**（精简 5 行，指向 `AGENTS.md` 的同名条款，避免两处重复展开）。

**预算控制**：现有"核心概念"里属于 API/manifest 细节的句子全部下沉；CSP / app:// / oix / 托盘 / 单实例等各只留一句判据式表述并链到 references。

## 4. `references/workflow.md` 设计（≤ 6,000 字符）

```
# 扩展开发流程（workflow）
## 0. 何时走全流程（分级判据）
   改变「对外行为 / 贡献点 / 数据结构」→ 全流程；只改文案/样式/单点 bug → 轻流程（提问 + 开发 + 测试）
## 1. 阶段一：提问（M1–M8 必问表 + 个性化触发表 + 三条硬边界 + 提问规范）
## 2. 阶段二：spec（模板 + 落位 tmp/spec/<扩展id>-<短名>.md）
## 3. 阶段三：用户确认（唯一关卡：确认后才写设计文档）
## 4. 阶段四：设计文档（模板 + 落位 tmp/spec/<扩展id>-<短名>-design.md）
## 5. 阶段五：开发（分支/提交/质量门禁 → 指向 AGENTS.md，不重复抄）
## 6. 阶段六：测试（门禁 + 扩展自带测试 + 真机验证；写明"未验证不许声称完成"）
## 7. 阶段七：审视（独立子代理对照 spec 与设计文档 review；问题必须逐条处置：改掉或写明不改的理由）
## 8. 阶段八：ADR（三条件判定 → tmp/adr/ → 三级落位表）
## 9. 阶段九：归档并清空 tmp/（tmp/spec → <开发目录>/docs/spec，tmp/adr → …/docs/adr，然后删除整个 tmp/）
```

要点：

- **提问规范**：用 `ask_user_question`；**一次一问**；每题给 ≥2 个具体方案，每案写优缺点，恰好一个标「推荐」且置首位，另有「其他（我来说明）」；事实自己查，决策交用户（与 `AGENTS.md` / ADR-0017 一致，此处只写"照 `AGENTS.md` 的提问约定"，不重复展开）。
- **M1–M8**：照 spec 第 4 节的表，逐项写"要问出什么"+ 一句"为什么它决定实现"。
- **个性化触发表**：不可信代码 → ADR-0015 边界；安装/卸载/升级 → 钩子幂等与回滚；跨扩展 → `extensionDependencies`/命令归属；大数据量 → sqlite vs 文件；改造已有扩展 → 迁移与兼容；性能敏感 → 定时器/监听/子进程开销；多窗口。
- **三条硬边界**：照 spec 原文。
- **ADR 三条件**：难以逆转 / 无背景会觉得奇怪 / 真实取舍——命中任一才写，否则不写（避免 ADR 噪声）。
- **三级落位表**：用户扩展 → `extensions/<id>/docs/adr/`；内置扩展 → `src/renderer/src/extensions/<id>/docs/adr/`；宿主/主进程/扩展系统自身 → 仓库 `docs/adr/`（续现有编号）。
- **spec 模板**：背景与事实 / 目标 / 非目标 / 需求表（每条标来源）/ 交付物 / 验收标准（可执行）/ 风险与未决项。
- **设计文档模板**：决策摘要 / 文件布局 / 逐文件设计 / 接口与数据 / 迁移 / 测试计划 / 执行顺序与并行切分 / 验收执行清单 / 风格约定。

## 5. 各 references 的编辑设计

通用：中文；一条含义只留一处权威；交叉引用一律 `文件.md` + `path:line` 形式的代码证据；**不得**指向 `extensions/todo`、`extensions/obox-updater` 这类**不在仓库里**的路径（它们在 `.gitignore` 的 `/extensions/` 下，全新克隆读不到）——需要示例时把最小可用示例**内联**进文档。

### 5.1 `api-reference.md`（27,659 字符）

- 修 spec 1.4 的 #1–#8、#10：`proxy` 段落整段重写（删 340 的错误结论，保留 session 级做法）；`output.append` 改为"`createChannel(id, name)` 返回的 channel 上调用 `append`（并给 channel 的方法清单）"；命令未声明 → **throw**；secrets 失败 → `throw`；timer 非法参数 → 未处理 rejection + `≤86400` 上限；`query` 抛错而 `exec` 返回 `{ok:false}`；依赖环**不跳过**；`name` 正则带 `i`（写实际行为）。
- 补缺：`api.ipc.channels()`、`AppRegistration.iconUrl`（且只接受 `app://extensions/…`）、`UpdateEvent` 的 `update-not-available`/`error`、`TreeItem.icon`、`SettingField.description`、`app://builtin` 与 `app://debug`、ipc 每通道并发上限 64、入口钩子 10s 超时、`window.*` 作用于**焦点窗口**。
- 结构：合并 488–555 的碎片回各自章节（`fs.watch` → `fs`；`settings.onChanged` → `settings`；`env.language` → `env`；`statusBar.createItem` → `statusBar`；`setProgressBar`/`isFocused` → `window`）；`api.ipc`/`api.python` 的标题层级统一；「宿主生命周期语义」前移到「入口契约」之后。
- 删/弱化：结尾「类型文件位置」压成 3 行（并补 `IpcChannelDeclaration`）。

### 5.2 `manifest-reference.md`（14,236 字符）

- 删 `arch` / `python` 字段教学（公开类型没有，照写会 TS 报错），改为"随包 Python 运行时靠扩展自带目录 + `api.python`，不靠 manifest 字段"。
- 补 `ipcChannels` / `keybindings` / `menus` / `views` 四类**数组形状 error** 的规则与非法样例；`themes` 缺字段是 **warning**。
- `name` 正则写实际（带 `i`）并加一句提示"文档与 `test/manifest.test.ts` 的意图冲突已开 issue"。
- 内置扩展前缀清单补 `settings` / `theme-dark` / `theme-light`。

### 5.3 `troubleshooting.md`（19,080 字符）

- 修 #13（调试扩展 stdio cwd = 调试目录/data，只有 `api.fs`/sqlite/python 走 `userData`）、#16（`app://builtin` 已注册但未被构建填充）、`--debug-extension` 的 id 正则带 `i` 且路径可相对、宿主启动日志补尾部（`激活 Z，依赖环 …`）、"两个 `--`"补依据（`electron-vite/dist/cli.js` 的 `options['--']`）。
- 删低价值：`#14`（HMR 泛泛建议）、`#12`（标题序号，一句"重启应用"）、`#3`（Vite `base` 常识且与 guides 重复）、`#16` 里已修复 bug 的历史叙述压缩成一句。
- 删条目后**重编号并保持连续**；文内引用编号的地方同步（含 `SKILL.md` 旧引用——由我改）。
- 全篇凡指向 `references/guides.md` 的交叉引用，改判为 `guides-builtin.md` 或 `guides-user.md`。

### 5.4 `themes-settings.md`（4,188 字符）

- 修 #14：通用节点**始终显示**，只有关闭行为/开机自启两行控件 `v-if="isWindows"`，非 Windows 显示 `windowsOnly` 说明。
- 补 `update` / `network` / `notification` 三个树节点（`SettingsView.vue` 的 `TreeKey`）。
- 标注 `--font-size-lg` / `--icon-size` 只声明未被 `var()` 使用；token 表与 `assets/main.css` 逐项一致这件事写明是"当前一致"。

### 5.5 `guides-builtin.md` / `guides-user.md`（由 16,367 字符的 `guides.md` 拆出）

- **内置**：读现状 → 建目录/脚手架（`create-extension.mjs`）→ manifest（含 `titleKey` 与 `zh`/`en` 词条）→ 入口（`index.ts` + 具名导出视图）→ 视图（`<style scoped>` + `var(--token, fallback)`）→ 验证（`typecheck`/`lint`/`test` + `npm run dev`）→ 提交约定（指向 `AGENTS.md`）。
- **用户扩展**：
  - 项目结构（内联最小示例，**不再指向 gitignored 的 `extensions/todo`**）；入口纯 ESM；`new URL('.', import.meta.url)` 推 `app://extensions/<id>/`；
  - 两种形态：**零构建纯 JS**（如 `commands` + `statusBarItems` + App 卡片 + 自带静态 HTML）与**带 Vue 子应用**（Vite 编译静态页，构建期依赖，运行时入口仍无依赖）；
  - `.oix` 打包（zip 根 = manifest + 入口 + 静态资源）；安装（管理器按钮 / 拖拽 / 热生效）；`--debug-extension` 与 `.vscode/launch.json`（标注**未实机验证**与端口未固定的后果）；Python 运行时打包（压缩档位表标注"某版本一次性实测、升级即变"）。
- 两份都把"验证方式"写清；`guides.md` 里的 App 子窗口教程（含修 #11 的内联脚本错误、#12 的 `obox-extension` 消息桥）按受众分别落到对应文件（App 注册对两类都适用 → 放 `guides-user.md`，内置侧只留一句指针）。

## 6. `scripts/` 设计

**共同约束**：`scripts/**` 被 eslint 忽略，脚本必须自包含（零 npm 依赖，只用 `node:*`）、跨平台、中文可读报错、**不 import `src/` 下的模块**。

### 6.1 CLI 契约（三个脚本共用风格）

```
node skills/obox-ext-dev/scripts/validate-manifest.mjs <manifest.json ...>
node skills/obox-ext-dev/scripts/validate-manifest.mjs --all [--root <dir>]
node skills/obox-ext-dev/scripts/validate-manifest.mjs --json [...]          # 机器可读
退出码：0 = 无 error（warning 允许）｜1 = 存在 error｜2 = 用法错误
```

- 默认 root：脚本自身位置向上 3 层（`skills/obox-ext-dev/scripts` → 仓库根）；`--root` 可指向任意目录。
- `--all` 扫描 `<root>/src/renderer/src/extensions/*/manifest.json` 与 `<root>/extensions/*/manifest.json`（后者即用户扩展仓库布局），两处都缺时给**中文可读提示**并 exit 2（不再 `scandir ENOENT` 崩栈）。
- `--json` 输出：`{"root":…,"files":[{"path":…,"messages":[{"level":"error"|"warning","message":…}]}],"errorCount":n,"warningCount":m}`。
- 读 `--root/package.json` 取 `apiVersion` 时若缺失/损坏 → 视为 0 并继续（不崩栈）；BOM 要吃掉。

### 6.2 `validate-manifest.mjs` 的规则表（自包含副本，必须与宿主逐条一致）

镜像三处：`core/manifest.ts:20-108`（error）、`shared/ipcDeclaration.ts`（`ipcChannels` 的形状与 transport/端点约束）、`core/host.ts:125-207`（warning）。**报错文案与宿主逐字一致**（差分测试会比对文案，文案漂移即红）。

### 6.3 `create-extension.mjs`（内置扩展）

- 修 `ID_RE`（与宿主 `NAME_RE` 对齐，带 `i`）。
- 新增"必须在 obox 仓库内"断言：`<root>/package.json` 的 `name === 'obox'` 且存在 `src/renderer/src/extensions/`，否则中文报错 exit 1（现在是任意裸目录静默生成）。
- 模板补齐：navItem 用 `titleKey`（并生成 `zh`/`en` 词条占位说明）、视图用 `<style scoped>` + `var(--token, fallback)`。

### 6.4 `create-user-extension.mjs`（用户扩展，新增）

```
node skills/obox-ext-dev/scripts/create-user-extension.mjs <id> --title "…" [--author …] [--desc …] [--dir <父目录>] [--vue]
默认父目录 = <root>/extensions/
生成：<id>/manifest.json（main: "./index.js"，含 navItems/commands 示例 + titleKey 说明）
      <id>/index.js（纯 ESM，default 插件函数 + 具名导出视图/命令实现 + cleanup）
      <id>/page.html（可选静态页，App 卡片用；--vue 时改为 Vite + Vue 子应用骨架）
      <id>/test/extension.test.js（node --test，mock api）
      <id>/scripts/pack.mjs（zip → <id>-<version>.oix，根目录放 manifest.json + 入口 + 静态资源）
      <id>/package.json（type: module；scripts: test/pack/release）
      <id>/README.md（安装与调试步骤）
```

生成物要求：`node --test` 能跑通、`pack.mjs` 产出的 `.oix` 根目录结构正确、把产物喂给 `validate-manifest.mjs` 通过。

### 6.5 `scripts/README.md`

三个脚本的用法、参数表、退出码、以及"为什么规则是副本 + 差分门禁在哪"的一段说明。

## 7. 差分门禁设计

- fixtures：`test/fixtures/manifest-parity/*.json`，每个文件一个 manifest，文件名编码用例（如 `ok-full.json`、`bad-ipc-transport.json`、`bad-views-shape.json`、`bad-keybindings.json`、`bad-menus.json`、`bad-name-space.json`、`self-dep.json`、`high-api-version.json`、`missing-main.json`）。
- `test/manifest-script-parity.test.ts`：
  1. 对每个 fixture：宿主侧 `validateManifest(JSON.parse(text))`；脚本侧 `execFileSync(process.execPath, [scriptPath, fixture, '--json'])`；
  2. 比较两边**规范化后的 `{level, message}` 多重集**（必须逐字相同）与 error 数；
  3. 断言脚本退出码与 `errorCount` 一致（0/1）；
  4. 另加一例：`--all` 指向仓库根必须 exit 0（内置扩展全部合法）。
- **门禁有效性自证**（我在验收时执行，不写进测试）：临时删掉脚本里的 `ipcChannels` 规则 → 该测试必须变红 → 再还原。

## 8. 外围同步

- `AGENTS.md`：① 第 24 行的 references 清单改为新文件名（`manifest / api / guides-builtin / guides-user / workflow / troubleshooting / themes-settings`）；② 新增强制条款："开发扩展前必须先按 `references/workflow.md` 走提问 → spec → 用户确认 → 设计 → 开发 → 测试与独立审视 → ADR 归档；不许自行扩大范围"；③ 保持 `AGENTS.md` 作为唯一 always-loaded 指针。
- `README.md`：文档导航表的 skill 行同步新文件名。
- `docs/adr/0020-extension-dev-skill-workflow.md`：记录三条真实取舍——① 校验脚本**自包含副本 + 差分门禁**（而非单一真源，因 Node 解析不了 `src/` 的无扩展名 import）；② **受众分层**（共享主题 + 教程按受众拆）；③ **需求澄清与 spec/设计/审视流程 + `tmp/` 临时产物 + 三级落位归档（含完成后删除 `tmp/`）**。先写 `tmp/adr/`，完成后移入。
- `docs/spec/`（新增目录）：本次的 spec 与设计文档从 `tmp/spec/` 归档到这里，成为"仓库自身开发"的归档落点先例。
- `.gitignore`：`/tmp/`（已完成）。

## 9. 执行与并行切分（文件所有权互不重叠）

| 执行者    | 独占文件                                                                                 |
| --------- | ---------------------------------------------------------------------------------------- |
| 子代理 S1 | `references/workflow.md`                                                                 |
| 子代理 S2 | `references/guides-builtin.md`、`references/guides-user.md`、删除 `references/guides.md` |
| 子代理 S3 | `references/api-reference.md`                                                            |
| 子代理 S4 | `references/manifest-reference.md`                                                       |
| 子代理 S5 | `references/troubleshooting.md`                                                          |
| 子代理 S6 | `references/themes-settings.md`                                                          |
| 子代理 S7 | `scripts/**`、`test/manifest-script-parity.test.ts`、`test/fixtures/manifest-parity/**`  |
| 我        | `SKILL.md`、`AGENTS.md`、`README.md`、`docs/adr/0020-*.md`                               |

顺序：S1–S7 并行 → 我串联（改 `SKILL.md` 的引用、交叉引用核对）→ `prettier --write` → `typecheck` / `lint` / `test` → 红队验收 → PR1（文档）/ PR2（脚本）。

**PR 切分**：PR1 = 六份 references 修改/新增 + `SKILL.md` + `AGENTS.md` + `README.md` + ADR + `.gitignore`；PR2 = `scripts/**` + 差分测试与 fixtures。PR2 的分支基于 PR1 合并后的 master（避免栈式 PR 冲突）。

## 10. 验收执行清单（把 spec 第 6 节落成命令）

1. `npx prettier --check .`（含 `skills/`，注意 `skills/**` 只是 eslint 忽略、prettier 仍管）。
2. `npm run typecheck`、`npm run lint`、`npm test`。
3. `node skills/obox-ext-dev/scripts/validate-manifest.mjs --all` → exit 0；对 `bad-ipc-transport.json` → exit 1。
4. 差分测试变异自证（§7 第 4 条）。
5. `create-user-extension.mjs` 在临时目录生成 → `node --test` 通过 → `pack.mjs` 产出 `.oix` → 校验通过。
6. 红队：两个子代理**只读 `SKILL.md`**（不给 references 清单），分别"做一个用户扩展并打包 `.oix`"与"给内置扩展加一个状态栏项"，检查走对路径且未踩坑；发现的坑回填文档。
7. 逐条对照 spec 1.4 / 1.5 勾掉每个硬错误。
8. 合并后：`npm run security:audit`（0 告警）+ Dependabot open 告警 = 0 + `git status` clean + 分支已删。
9. **归档并清空 `tmp/`**：`tmp/spec/obox-ext-dev-skill.md` 与 `-design.md` → `docs/spec/`；`tmp/adr/0020-*.md` → `docs/adr/`；删除整个 `tmp/` 目录（进 PR1 的最后一个 commit）。

## 11. 内容风格约定（所有执行者必须遵守）

- 中文；表格优先；代码证据用 `path:line`；示例可复制即用。
- 一条含义只在一处权威；**不抄** `package.json` scripts、目录树、`--help` 输出这类环境可查的内容。
- 不写"未验证"的结论：没实机验证就标注"未实机验证"。
- 不对 `src/` 源码做任何修改；不 `git add` / `git commit`（由我统一提交）；prettier 由我统一跑。
