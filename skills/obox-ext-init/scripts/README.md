# Scripts（obox-ext-init）

`skills/obox-ext-init/scripts/` 下的**扩展工程脚手架**脚本，由 `obox-ext-init`（九步链第 1 步）在新建模式下调用。两个脚本分工固定：

| 脚本                        | 路线                                    | 生成位置                                          | 生成物                                            |
| --------------------------- | --------------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| `create-extension.mjs`      | **内置扩展**（随应用打包，TS + Vite）   | `<obox 仓库>/src/renderer/src/extensions/<id>/`   | `manifest.json` + `index.ts` + `<Pascal>View.vue` |
| `create-user-extension.mjs` | **用户扩展**（纯 ESM JS + `.oix` 分发） | `<仓库根>/extensions/<id>/`（`--dir` 可改，见下） | 见下                                              |

共同约束：

- **零 npm 依赖**、只用 `node:*`、跨平台、报错为中文；
- **不 import `src/` 下的任何模块**（Node 原生跑 `.mjs` 解析不了 `src/` 内部的无扩展名 import —— 同 `scripts/make-tray-icon.mts` 头部记录的坑）；
- `skills/**` 被 `eslint.config.mjs:8` 忽略，所以脚本没有 lint/typecheck 门禁 → **校验规则靠差分门禁防漂移**；
- 两个脚本的 `ID_RE` 必须与宿主 `NAME_RE`（`src/renderer/src/core/manifest.ts:11`）及 `scripts/validate-manifest.mjs:39` **逐字一致**：`^[a-z0-9][a-z0-9._-]*$`，**不带 `i`**。否则脚本会 exit 0 地生成宿主判「清单无效」的 manifest，门禁形同虚设（issue #77；两个脚本此前带 `i`，现已同步为快速失败）；
- 仓库根 = `skills/obox-ext-init/scripts` 的**上三级**（`..\..\..`）；脚本移动位置时必须同步这个常量。

## create-extension.mjs — 内置扩展脚手架

```bash
node skills/obox-ext-init/scripts/create-extension.mjs my-hello \
  --title "你好" \
  --desc "示例扩展"
```

| 参数      | 说明                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`    | 扩展 id（必填），与宿主 `NAME_RE`（`src/renderer/src/core/manifest.ts:11`）及仓库校验脚本 `scripts/validate-manifest.mjs:39` **逐字一致**：`^[a-z0-9][a-z0-9._-]*$`（**不带 `i`**，只接受小写）。本脚本自身的 `ID_RE` 已同步为同一正则（改前带 `i`） |
| `--title` | 显示名（默认 = id）                                                                                                                                                                                                                                  |
| `--desc`  | 简介                                                                                                                                                                                                                                                 |

- 生成前断言"必须在 obox 仓库内"：`<仓库根>/package.json` 的 `name === 'obox'` 且存在 `<仓库根>/src/renderer/src/extensions/`，否则中文报错 exit 1（以前在任意裸目录都能静默生成跑不起来的骨架）。
- 模板已含 `navItems[].titleKey`（提示往宿主语言包 `src/renderer/src/i18n/locales/{zh,en}.ts` 补词条，不补则导航项显示原始 key）与 `<style scoped>` + `var(--token, fallback)`。
- **目录已存在则中止，不覆盖**；退出码：`0` = 成功｜`1` = 生成失败｜`2` = 用法错误。
- 生成后按 `docs/extension-api/guides-builtin.md` 继续（TS + Vite、i18n、质量门禁）。

## create-user-extension.mjs — 用户扩展脚手架

```bash
node skills/obox-ext-init/scripts/create-user-extension.mjs my-ext \
  --title "我的扩展" --author "me" --desc "示例" \
  [--dir <父目录>] [--vue]
```

| 参数       | 说明                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>`     | 扩展 id（必填），规则同上（本脚本 `ID_RE` 已与宿主 / 校验脚本同步为 `^[a-z0-9][a-z0-9._-]*$`，**不带 `i`**）；大写 id **立即失败**：exit 1 + 中文报错并附宿主校验器原文 |
| `--title`  | 显示名（默认 = id）                                                                                                                                                     |
| `--author` | 作者；`.oix` 安装目录名 = `<name>_<author>`（`src/main/oixCore.ts:51`）                                                                                                 |
| `--desc`   | 简介                                                                                                                                                                    |
| `--dir`    | 生成到 `<父目录>/<id>/`；**相对当前工作目录（CWD）解析**，也可给绝对路径（见下）                                                                                        |
| `--vue`    | 额外生成 Vue 子应用骨架（`app/` + `vite.config.ts`，构建期依赖，产物进 `dist/`）                                                                                        |

### `--dir` 的解析基准（写清，防歧义）

`--dir` 由脚本里的 `resolve(dirArg)` 解析 ⇒ **相对进程的当前工作目录（CWD）**，与 `npm` / `git` 的路径参数语义一致；绝对路径原样使用。两种情形要分清：

- **省略 `--dir`**：默认父目录是 `<仓库根>/extensions/`，其中仓库根由**脚本自身位置**推导（`skills/obox-ext-init/scripts` 上三级）——**与 CWD 无关**，任何目录下执行都落在同一个 `<仓库根>/extensions/`。
- **给了 `--dir`**：`--dir foo` = `<CWD>/foo`；从仓库根执行 `--dir extensions/ext-demo/_probe` 就是 `<仓库根>/extensions/ext-demo/_probe`。用户扩展通常是独立仓库/目录，需要落到别处时给绝对路径最稳。

保留 CWD 基准（而不是改成相对仓库根）的理由：① 与 Node `path.resolve` 及所有主流 CLI 的既有语义一致，最不意外；② `--dir ..\my-ext-repo` 这类"指向 obox 仓库之外"的用法在 CWD 基准下才成立，改成仓库根基准反而会把路径困在仓库内；③ 默认值本来就不走 CWD（由脚本位置推导），两条语义已在上面分别写明，无需再改实现。

生成物：

| 路径                      | 说明                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`           | `main: "./index.js"`；声明 `views`（导航树）/ `commands` / `statusBarItems` / `i18n`                                                                             |
| `index.js`                | 纯 ESM：`default` 插件函数 + 具名导出 `greet` + 释放函数；命令/树数据源/App 卡片/消息桥                                                                          |
| `page.html` + `page.js`   | App 卡片静态页（脚本是**独立文件**：srcdoc 模式继承宿主 CSP，内联 `<script>` 会被拦）；**不带 `--vue` 时生成**，带了 `--vue` 则由 `app/` 源码 + `dist/` 产物取代 |
| `theme.js`                | 子窗口主题接收桥（协议见 `docs/extension-api/themes-settings.md` 与 ADR-0022）                                                                                   |
| `test/extension.test.js`  | `node --test` + mock api，零依赖（实测 6 passed）                                                                                                                |
| `scripts/pack.mjs`        | zip → `out/<id>-<version>.oix`（零依赖，自己写 zip；已排除 `data/`、`out/`、`node_modules/`、`.git/`）                                                           |
| `package.json`            | `type: module`；`scripts`: `test` / `pack` / `release`（`release` = `test` + `pack`）；**`--vue` 额外加 `build` / `dev`** 与 vite/vue 构建期依赖                 |
| `app/` + `vite.config.ts` | **仅 `--vue`**：Vue 子应用源码，`vite build` 产物进 `dist/`（`pack.mjs` 只收 `dist/`，源码 `app/` 不进包）                                                       |
| `README.md`               | 安装、调试、贡献点与 i18n（`titleKey`）说明                                                                                                                      |

退出码：`0` = 成功｜`1` = 生成失败｜`2` = 用法错误。生成后在扩展目录里 `npm test`、`npm run pack` 即可，无需 `npm install`（`--vue` 需 `npm install` 才能 `build`）。后续按 `docs/extension-api/guides-user.md` 继续（`.oix` 安装、`--debug-extension`、Python 运行时打包）。

## obox-ext-init 如何调用

1. **先问模式**（新建 / 修复），并问齐 中文名 / 英文名 / 简要功能 / 作者 + 扩展形态（见 `../SKILL.md`）。
2. **校验英文名**：kebab-case、`extensions/<英文名>/` 与 `src/renderer/src/extensions/<英文名>/` 都不重名。
3. 按形态选脚本并**原样读取其自检输出**（缺 `--author` 会让 `.oix` 安装目录名退化为 `<name>_`）。

**形态 → 脚本参数（唯一一张表，与 `../SKILL.md` 第 3 步的表内容一致）**：

| 形态                                       | 脚本与参数                                                                                           | 生成物要点                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 仅入口（命令 / 树视图 / 状态栏）           | `create-user-extension.mjs <id> --title … --author … --desc …`（**不带 `--vue`**）                   | `index.js` + `page.html`/`page.js`（App 卡片静态页）+ `theme.js` + `test/` + `scripts/pack.mjs`                                             |
| 入口 + App 卡片（静态页）                  | 同上（**不带 `--vue`**）                                                                             | 同上；**不带 `--vue` 也已经**有 `page.html` + `page.js`，点 App 卡片就能开静态页                                                            |
| 入口 + App 卡片 + 设置页                   | 同上（**不带 `--vue`**；脚手架**不**生成 `contributes.settings`，需按 `manifest-reference.md` 手写） | 同上 + 手写的设置表单声明                                                                                                                   |
| 要 Vue 子应用（额外能力，非"有 App 卡片"） | 上表形态 1–3 任一行**再加 `--vue`**（内置扩展路线没有 `--vue`）                                      | **取代** `page.html` / `page.js`（改为 `app/` + `vite.config.ts`）；`package.json` 多 `build`/`dev`，构建产物进 `dist/`（需 `npm install`） |
| 内置扩展（随应用打包，改宿主仓库源码）     | `create-extension.mjs <id> --title … --desc …`                                                       | `manifest.json` + `index.ts` + `<Pascal>View.vue`                                                                                           |

即：**前三种形态都不带 `--vue`**（`--vue` 与"有没有 App 卡片"无关，只决定 App 卡片是用自带静态页还是 Vue 子应用渲染）；只有"要 Vue 子应用"才带。对应命令：

```bash
# 形态 1–3（都不带 --vue；App 卡片走脚手架自带的 page.html + page.js 静态页）
node skills/obox-ext-init/scripts/create-user-extension.mjs <id> \
  --title "<中文名>" --author "<作者>" --desc "<简要功能>"

# 形态 4：要 Vue 子应用（构建期依赖，需 npm install；产物进 dist/）
node skills/obox-ext-init/scripts/create-user-extension.mjs <id> \
  --title "<中文名>" --author "<作者>" --desc "<简要功能>" --vue

# 形态 5：内置扩展（仅当用户明确要随应用打包）
node skills/obox-ext-init/scripts/create-extension.mjs <id> --title "<中文名>" --desc "<简要功能>"
```

4. 生成后在 `<扩展目录>` 里 `git init`（**不建远端**）、建 `openspec/`（`config.yaml` + `specs/` + `changes/archive/`）与 `docs/spec/UID-{YYYYMMDDHHmmss}-{≤10字中文描述}/index.md`。

## 已不在此目录的脚本

- `validate-manifest.mjs`：现位于**仓库根 `scripts/validate-manifest.mjs`**（校验单个/多个 manifest，`--all` 扫内置与用户扩展，`--json` 机器可读）。它仍是"自包含副本"，防漂移门禁是 `npx vitest run test/manifest-script-parity.test.ts`（同一批 `test/fixtures/manifest-parity/*.json` 喂给脚本与宿主 `validateManifest()`，`{level,message}` 多重集必须逐字相同）。

## 相关

- 流程总览（九步链）：`docs/extension-workflow.md`
- 内置扩展路线：`docs/extension-api/guides-builtin.md`
- 用户扩展路线：`docs/extension-api/guides-user.md`
- manifest 字段与校验规则：`docs/extension-api/manifest-reference.md`
