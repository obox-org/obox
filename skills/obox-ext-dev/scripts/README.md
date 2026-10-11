# Scripts

`skills/obox-ext-dev/scripts/` 下的扩展开发工具脚本。共同约束：

- **零 npm 依赖**、只用 `node:*`、跨平台、报错为中文；
- **不 import `src/` 下的任何模块**（Node 原生跑 `.mjs` 解析不了 `src/` 内部的无扩展名 import —— 同 `scripts/make-tray-icon.mts` 头部记录的坑）；
- `skills/**` 被 `eslint.config.mjs:8` 忽略，所以脚本没有 lint/typecheck 门禁 → **校验规则靠差分门禁防漂移**。

## 为什么 `validate-manifest.mjs` 是"自包含副本"

宿主规则分散在 `src/renderer/src/core/manifest.ts`（error）、`src/shared/ipcDeclaration.ts`（`ipcChannels`）、`src/renderer/src/core/host.ts:125-207`（warning）三处，而脚本**不能 import 它们**（上面的约束）。规则因此在这里重写一份副本，代价是可能漂移，防线是仓库内的差分测试：

```bash
npx vitest run test/manifest-script-parity.test.ts
```

它把 `test/fixtures/manifest-parity/*.json` 同一批 fixture 同时喂给宿主 `validateManifest()` 与脚本 `--json`，比对两边的 `{level, message}` 多重集**逐字相同**，并断言退出码与 `errorCount` 一致。改了 `src/renderer/src/core/manifest.ts` 或本脚本的规则，这个测试必须同步；否则它会红。

脚本里**故意不实现**两条宿主 warning（静态拿不到运行期状态）：

- `快捷键 X 已被 Y 占用（… 未注册）`——需要宿主 `keybindingStore` 的全局状态；
- `导航项 … 声明的视图组件 … 未在扩展入口导出`——需要扩展入口模块的具名导出表。

另外：数组形状本身已非法时不再追加"引用的命令未声明"warning（避免级联噪音）。

## validate-manifest.mjs — manifest 校验

```bash
# 校验单个/多个 manifest
node skills/obox-ext-dev/scripts/validate-manifest.mjs src/renderer/src/extensions/app/manifest.json

# 校验仓库里全部扩展（内置 + 用户扩展仓库布局）
node skills/obox-ext-dev/scripts/validate-manifest.mjs --all

# 指定仓库根 / 机器可读
node skills/obox-ext-dev/scripts/validate-manifest.mjs --all --root <dir> --json
```

| 选项                  | 说明                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `<manifest.json ...>` | 显式文件路径（可多个），相对路径按当前目录解析                                                                                       |
| `--all`               | 扫描 `<root>/src/renderer/src/extensions/*/manifest.json` 与 `<root>/extensions/*/manifest.json`（两处都不存在 → 中文提示 + exit 2） |
| `--root <dir>`        | 仓库根（默认：脚本位置向上三级；`apiVersion` 也从这里读 `package.json`）                                                             |
| `--json`              | stdout 只输出 JSON：`{"root","files":[{"path","messages":[{"level","message"}]}],"errorCount","warningCount"}`                       |
| `-h`, `--help`        | 帮助                                                                                                                                 |

退出码：`0` = 无 error（warning 允许）｜`1` = 存在 error（含 JSON 解析失败）｜`2` = 用法错误（未知选项、缺目标、`--all` 找不到扩展目录、路径不存在或为目录）。

容错（不会崩栈）：`<root>/package.json` 缺失/损坏/带 BOM → `apiVersion` 视为 `0` 并继续；`--all` 下没有 `manifest.json` 的目录会被跳过并提示。

## create-extension.mjs — **内置扩展**脚手架

在**当前 obox 仓库**的 `src/renderer/src/extensions/<id>/` 生成骨架（`manifest.json` + `index.ts` + `<Pascal>View.vue`）。

```bash
node skills/obox-ext-dev/scripts/create-extension.mjs my-hello \
  --title "你好" \
  --desc "示例扩展"
```

| 参数      | 说明                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`    | 扩展 id（必填），与宿主 `NAME_RE`（`core/manifest.ts:11`）一致：`^[a-z0-9][a-z0-9._-]*$`（**不带 `i`**，只接受小写）。注意：本脚本自身的 `ID_RE` 仍带 `i`（未同步，见下） |
| `--title` | 显示名（默认 = id）                                                                                                                                                       |
| `--desc`  | 简介                                                                                                                                                                      |

- 生成前断言"必须在 obox 仓库内"：`<root>/package.json` 的 `name === 'obox'` 且存在 `<root>/src/renderer/src/extensions/`，否则中文报错 exit 1（以前在任意裸目录都能静默生成跑不起来的骨架）。
- 模板已含 `navItems[].titleKey`（提示往宿主语言包 `src/renderer/src/i18n/locales/{zh,en}.ts` 补词条，不补则导航项显示原始 key）与 `<style scoped>` + `var(--token, fallback)`。
- 目录已存在则中止，不覆盖。
- 退出码：`0` = 成功｜`1` = 生成失败｜`2` = 用法错误。
- 生成后按 `references/guides-builtin.md` 继续（TS + Vite、i18n、质量门禁）。

## create-user-extension.mjs — **用户扩展**脚手架（纯 ESM + `.oix`）

生成独立可发布的用户扩展（**零运行时依赖**：入口只依赖注入的 `api`）。

```bash
node skills/obox-ext-dev/scripts/create-user-extension.mjs my-ext \
  --title "我的扩展" --author "me" --desc "示例" \
  [--dir <父目录>] [--vue]
```

| 参数       | 说明                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| `<id>`     | 扩展 id（必填），规则同上（宿主侧不带 `i`；本脚本 `ID_RE` 仍带 `i`，未同步）     |
| `--title`  | 显示名（默认 = id）                                                              |
| `--author` | 作者；`.oix` 安装目录名 = `<name>_<author>`（`src/main/oixCore.ts:51`）          |
| `--desc`   | 简介                                                                             |
| `--dir`    | 生成到 `<父目录>/<id>/`（默认 `<仓库根>/extensions/`）                           |
| `--vue`    | 额外生成 Vue 子应用骨架（`app/` + `vite.config.ts`，构建期依赖，产物进 `dist/`） |

生成物：

| 路径                     | 说明                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `manifest.json`          | `main: "./index.js"`；声明 `views`（导航树）/ `commands` / `statusBarItems` / `i18n`    |
| `index.js`               | 纯 ESM：`default` 插件函数 + 具名导出 `greet` + 释放函数；命令/树数据源/App 卡片/消息桥 |
| `page.html` + `page.js`  | App 卡片静态页（脚本是**独立文件**：srcdoc 模式继承宿主 CSP，内联 `<script>` 会被拦）   |
| `test/extension.test.js` | `node --test` + mock api，零依赖                                                        |
| `scripts/pack.mjs`       | zip → `out/<id>-<version>.oix`（零依赖，自己写 zip；包根 = manifest + 入口 + 静态资源） |
| `package.json`           | `type: module`；`scripts`: `test` / `pack` / `release`（`release` = `test` + `pack`）   |
| `README.md`              | 安装、调试、贡献点与 i18n（`titleKey`）说明                                             |

退出码：`0` = 成功｜`1` = 生成失败｜`2` = 用法错误。生成后在扩展目录里 `npm test`、`npm run pack` 即可，无需 `npm install`（`--vue` 需 `npm install` 才能 `build`）。后续按 `references/guides-user.md` 继续（`.oix` 安装、`--debug-extension`、Python 运行时打包）。

## 相关

- 内置扩展路线：`references/guides-builtin.md`
- 用户扩展路线：`references/guides-user.md`
- manifest 字段与校验规则：`references/manifest-reference.md`
- 开发流程（提问 → spec → 设计 → 开发 → 测试审视 → ADR）：`references/workflow.md`
