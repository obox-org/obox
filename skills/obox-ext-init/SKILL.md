---
name: obox-ext-init
description: obox 扩展开发九步链的**第 1 步**：定扩展工程与需求容器。当用户说"开始做一个 obox 扩展 / 按 obox-ext-init 走扩展开发流程 / 给某个扩展补需求"，或要新建扩展工程、给既有扩展补 openspec/ 与交付归档目录时使用。
---

# obox-ext-init — 定工程与需求容器

## 职责

**做**：先分**新建 / 修复**两种模式；把当前需求挂到一个确定的扩展工程上，并配齐承载后续八步产物的容器——`openspec/` 根与交付归档目录 `docs/spec/UID-…/`。

**不做**：不写功能代码、不写 proposal / design / spec，不回答需求问题（下一步 `obox-ext-grill`），不 `git commit` / 不建 git 远端。

公共约定（目录布局、双标识、门禁四选项、提问规范）**唯一真相在** [`docs/extension-workflow.md`](../../docs/extension-workflow.md)，冲突时以它为准。

## 输入与前置检查

输入：用户点名的需求方向（一句话即可）。开工前查清，并**在任何提问里带上已查明的事实**：

1. 处在 obox 仓库根：`package.json` 的 `name === 'obox'` 且存在 `src/renderer/src/extensions/`。不满足 → 报错停下，让用户回到仓库根重跑。
2. 既有扩展清单（用命令查，不凭记忆）：`Get-ChildItem extensions, src/renderer/src/extensions -Directory`。
3. `openspec --version` 是否可用。**装与不装都不阻塞本步**（CLI 是可选增强，见 workflow 第九节）。
4. 真相文档存在性：`docs/extension-api/{manifest-reference,api-reference,themes-settings,troubleshooting}.md`。缺任何一个 → 报错并让用户先修文档迁移，**不要凭记忆继续**。

## 步骤

### 第 0 步：问模式

`ask_user_question` 问一次（单次只问一个问题）：

1. **新建工程（推荐）** —— 从零建 `extensions/<英文名>/` 并配齐容器。优点：容器一次到位、后续八步无返工，也是九步链的默认起点；缺点：需先定名，改名要动目录。
2. **修复既有工程** —— 给已有扩展补容器或开新 change。优点：承接存量代码与 `docs/spec/**`；缺点：缺 `openspec/` 时补建与反向提炼要多一轮。
3. **其他（我来说明）**。

**完成判据**：模式已定，且你记下了用户的依据原话。

### 第 1 步（新建）：问齐工程身份

`ask_user_question` 对**每个字段各问一次**，字段与落点：

| 字段     | 落到哪                                                                                      |
| -------- | ------------------------------------------------------------------------------------------- |
| 中文名   | `manifest.displayName`；UID 目录的中文描述                                                  |
| 英文名   | `extensions/<英文名>/` 目录名 = `manifest.name`（宿主 `NAME_RE`：`^[a-z0-9][a-z0-9._-]*$`） |
| 简要功能 | `manifest.description`；下一步 grill 的输入                                                 |
| 作者     | `manifest.author`；`.oix` 安装目录名 = `<name>_<author>`                                    |

每次 2–4 个具体候选 + 优缺点 + 恰好一个「推荐」置首 + 一个「其他（我来说明）」；候选由你从需求方向推导，不问"要不要填"。

**完成判据**：四个字段都有用户确认的值，且英文名已过第 2 步校验。

### 第 2 步（新建）：校验英文名

```powershell
Test-Path extensions\<英文名>; Test-Path src\renderer\src\extensions\<英文名>
```

- 必须匹配 `^[a-z0-9][a-z0-9._-]*$`（**小写**；大写即宿主判清单无效）。
- 两处任一已存在 → 停下，把冲突路径给用户，让他改名或转到修复模式。
- `change-id` 在第 4 步按同一套 lower-case kebab-case 规则生成（见 workflow §三），**不得用中文**，与扩展英文名各自独立。

**完成判据**：两条 `Test-Path` 都为 `False`，且正则通过。

### 第 3 步（新建）：问扩展形态，并据此生成工程

事实（脚本实测，见 `skills/obox-ext-init/scripts/README.md`，**那本 README 与本表是同一张表**）：不带 `--vue` 时脚本生成 App 卡片**静态页** `page.html` / `page.js` / `theme.js`；`--vue` 把静态页换成 **Vue 子应用**（`app/` + `vite.config.ts` + `build` / `dev` 脚本，产物进 `dist/`，需 `npm install`）。用户扩展的公共参数一律 `--title "<中文名>" --author "<作者>" --desc "<简要功能>"`：

| 形态                                                  | 脚本参数                                                   | 优点 / 缺点                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1. 仅入口（命令 / 树视图 / 状态栏）                   | `create-user-extension.mjs <英文名> …`（**不带** `--vue`） | 零依赖、最快闭环 / 做不了复杂表单与卡片列表                                                |
| 2. 入口 + App 卡片（静态页）                          | 同上（**不带** `--vue`）                                   | `extensions/rdp`、`extensions/webapp` 可抄 / 子窗口跨源，主题 token 走 `obox-theme` 推送桥 |
| 3. 入口 + App 卡片 + 设置页                           | 同上（**不带** `--vue`），另手写 `contributes.settings`    | 可给全局配置项 / 脚手架不生成设置页，按 `docs/extension-api/manifest-reference.md` 手写    |
| 4. 要 Vue 子应用（额外能力，与"有没有 App 卡片"无关） | 形态 1–3 任一行**再加** `--vue`                            | 可用 Vue 组件化写卡片 / 多一层构建期依赖，只有 `dist/` 进包                                |
| 5. 内置扩展（用户明确说"要进 obox 仓库源码"才选）     | `create-extension.mjs <英文名> --title … --desc …`         | 可用宿主构建管线与 `navItems[].view` / 不能 `.oix` 分发                                    |

**形态 1–3 都不带 `--vue`**；`--vue` 只在用户明确要 Vue 子应用时加（形态 4）。用 `ask_user_question` 问形态：选项沿用上表（具体形态候选 + 「其他（我来说明）」逃生项），各带优缺点、恰好一个「推荐」置首。

调用后**原样读脚本的自检输出**（用法与参数见 `skills/obox-ext-init/scripts/README.md`），不要改写。

**完成判据**：脚本 exit 0；`<扩展目录>` 下 `manifest.json`、`index.js`、`test/`、`scripts/pack.mjs` 均存在；形态 1–3 另需 `page.html` + `page.js` + `theme.js`；形态 4 另需 `app/` 与 `vite.config.ts`；形态 5 另需 `index.ts` 与 `<Pascal>View.vue`。

### 第 4 步（新建）：配容器

对形态 1–4（`extensions/<英文名>/`，**它自己是独立仓库**，所以 `openspec/` 与 `docs/` 都随它走）：

1. `git init`（**不建远端、不 commit**）。
2. 建 `openspec/`：`config.yaml`（根标记，缺它 OpenSpec 根解析会向上漂；最小模板见 `docs/extension-workflow.md` §二）、`specs/`、`changes/archive/`。装了 CLI 就用 `openspec init --tools none`，未装则手工建这三个形状。
3. **同一步生成 `change-id` 并建 change 目录**：按 workflow §三 生成 lower-case kebab-case 的 `change-id`（`openspec/changes/` 下不重名），写 `openspec/changes/<change-id>/.openspec.yaml`——三个字段：`schema: spec-driven`、`created: YYYY-MM-DD`（当天）、`uid: UID-…`。
4. 建 `docs/spec/UID-{YYYYMMDDHHmmss}-{≤10字中文描述}/index.md`，**当步就填上 `change-id:`**（与第 3 项 `.openspec.yaml` 的 `uid:` 互指，不存在"待填"；UID 约束见 workflow §三）。

对形态 5（`src/renderer/src/extensions/<英文名>/`）：**不** `git init`（它属于宿主仓库），`openspec/` 与 `docs/spec/UID-…/` 按 `docs/extension-workflow.md` 第二节落在该工程目录内。

**完成判据**：`openspec/config.yaml`、`openspec/specs/`、`openspec/changes/archive/`、`openspec/changes/<change-id>/.openspec.yaml`（三字段齐）、`docs/spec/UID-…/index.md`（`change-id:` 已填）都存在，且两个标识互指。

### 第 1′–4′ 步（修复）：挂到既有工程并开新 change

1. `ask_user_question` 选工程：选项 = 每个候选扩展（标注**是否有 `openspec/`**、`displayName` / `version`、最近 change），加一个「其他（我手输路径）」。**完成判据**：得到唯一且存在的工程目录。
2. 缺 `openspec/` → 按官方最小布局补建（同第 4 步第 2 项）。**完成判据**：三处形状齐。
3. 为**本次修复开一个新 change**：按 workflow 第三节生成 kebab-case 的 `change-id`（`openspec/changes/` 下不重名）与 UID；`openspec/changes/<change-id>/.openspec.yaml` 写 `schema: spec-driven`、`created`、`uid: UID-…`；把 `docs/spec/UID-…/index.md` 的 `change-id:` 填上。**完成判据**：`.openspec.yaml` 的 `uid` 与 `index.md` 的 `change-id` 互相指得通。
4. 默认从既有 `<工程>/docs/spec/**` **反向提炼"当前真相"**到 `openspec/specs/<capability>/spec.md`：通读既有 spec → 提**能力划分草案** → 用 `ask_user_question` 让用户确认 → 按官方 spec 结构落笔。**完成判据**：用户确认了能力清单，且每个 `openspec/specs/<capability>/spec.md` 都有一节"反向提炼来源"标注它取自哪个 `docs/spec/**` 文件。

## 产物与路径

```text
extensions/<英文名>/                        # 新建；自身是独立 git 仓库，git init 不建远端
├── manifest.json / index.js / test/ / 自带打包脚本   # 脚手架产物
├── app/ + vite.config.ts                   # 仅加了 --vue 时
├── openspec/config.yaml                    # OpenSpec 根标记（最小模板见 workflow §二）
├── openspec/specs/                         # "当前真相"（修复模式在这里反向提炼）
├── openspec/changes/archive/               # 工具归档落点
├── openspec/changes/<change-id>/.openspec.yaml   # 新建 / 修复均在开 change 的当步建立
└── docs/spec/UID-{YYYYMMDDHHmmss}-{≤10字中文描述}/index.md   # change-id: 已填
```

内置扩展路线（形态 5）把这些容器放到 `src/renderer/src/extensions/<英文名>/` 下。

## 门禁

用 `ask_user_question` 问「本步产出是否符合要求？」。门禁固定四选项（见 `docs/extension-workflow.md` §五）；本步是链条第 1 步、**没有上一步**，故第 3 项写成「**回到第 0 步重选模式**」：

1. **通过，自动进入 `obox-ext-grill`（推荐）** —— 下一步穷尽提问并产出 `openspec/changes/<change-id>/notes/grill.md`；选它时**读 `skills/obox-ext-grill/SKILL.md` 并照做**。
2. **部分修改后重跑本步** —— 用户说明要改什么（改名、换形态、补字段）。
3. **回到第 0 步重选模式** —— 回到第 0 步重选新建 / 修复，再重跑本步；若用户本就不该走这条链，此选项即退出。
4. **暂停** —— 用户先人工检查。

## 完成判据

- 模式已定，工程路径唯一且存在；
- `manifest.json` 已含用户确认的中文名 / 英文名 / 简要功能 / 作者；
- `openspec/` 三处形状齐（`config.yaml` + `specs/` + `changes/archive/`）；
- `openspec/changes/<change-id>/.openspec.yaml` 三字段齐（`schema: spec-driven`、`created: YYYY-MM-DD`、`uid: UID-…`）；
- `docs/spec/UID-…/index.md` 存在，且与 change 的 `.openspec.yaml` 双向映射齐（**新建 / 修复都一样：`change-id:` 与 `uid:` 当步互指，无"待填"**）；
- 新建模式另需：`git init` 已执行且**无远端**、工作区里没有 commit；
- 形态 5 另需：确认过"不进 `extensions/` 而是改宿主仓库源码"，且未对宿主仓库执行 `git init`。
