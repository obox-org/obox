# 设计文档：RDP 扩展主题跟随 + 修复新建/编辑选项错乱 + 表单说明文本

| 项 | 值 |
| --- | --- |
| 状态 | **已定稿（路径 A）**：D0 已由用户拍板为**路径 A —— 改宿主，让 `url` 型 App 子窗口也能拿到主题 token**；R-D2 / R-D3 与路径 A 无关，按原样执行 |
| 前置 | `tmp/spec/rdp-ui-theme-and-form.md`（R-D1 / R-D2 / R-D3，7 条验收标准） |
| 范围 | ① **宿主**：`src/renderer/src/core/appTheme.ts`（新增）、`src/renderer/src/core/state.ts`、`src/renderer/src/AppWindow.vue`；② **扩展**：`extensions/rdp/`（obox 仓库内 gitignored、独立工程，产物不进 obox 仓库、无需 PR）；③ **文档**：`skills/obox-ext-dev/**`、`README.md`（见 §12）。宿主改动必须走**分支 + PR**（`docs/adr/0008`） |
| 阻塞项 | **无**。原 D0（token 投递路径）已决策为路径 A（见 §0）；剩下的只是执行（见 §13） |
| 归档 | spec 与设计文档 → `extensions/rdp/docs/spec/`；**扩展 ADR → `extensions/rdp/docs/adr/0002`**；**宿主 ADR → 仓库 `docs/adr/0022`（随宿主 PR 提交）**；完成后删除整个 `tmp/` |

---

## 0. D0 已决策：路径 A —— 宿主向 `url` 型 App 子窗口下发主题 token（路径 A 定稿）

### 0.1 决策

**用户已拍板：路径 A —— 改宿主**，让 `url` 型 App 子窗口也能拿到主题 token。理由：R-D1 的验收 1/6（每个主题下外观与宿主一致、切主题即刻生效）只有路径 A 能满足；同时它一次修掉**所有** `url` 型 App 卡片的同一缺陷，与 reference 的承诺对齐；扩展侧因此只写标准 `var()`，不维护 token 副本。

本决策的完整机制、时序与两侧改动清单在 **§2.7**；它带来的 ADR 落位改判（宿主 → 仓库 `docs/adr/0022`）在 **§14**；spec §5「不修改宿主」这条边界的处置见 §0.4。

### 0.2 已核实的事实

spec §1.1 写"宿主**已经**会把当前主题 token 注入 App 子窗口"，据此推出"本次不改宿主"。逐行读代码后，**该结论对 RDP 卡片不成立**；而且旧 §0 的 F8 读错了跨窗口语义（见下）：

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | 主题 token 由 `themeStore.apply()` 写到**当前窗口**的 `document.documentElement`（行内样式） | `src/renderer/src/core/theme.ts:50-55`；启动时 `core/host.ts:930` 调 `applyCurrent()` |
| F2 | `AppWindow.vue` 里 token 的**唯一**注入点是 `iframeSrcdoc`，而它在卡片提供 `url` 时恒为 `undefined` | `src/renderer/src/AppWindow.vue:38-44`（`themeStyleHtml`）、`:46-52`（`url` 时 `return undefined`）、`:150-157`（iframe 同时绑 `:src` 与 `:srcdoc`） |
| F3 | RDP 卡片注册的是 **`url`**（`ui/index.html`），不是 `html` → 走 F2 的 `url` 分支，拿不到注入 | `extensions/rdp/index.js:299` 的 `url: new URL('./ui/index.html', …)`、`manifest.json` |
| F4 | 官方 reference 自己写明了这个边界："用户扩展的 App 子窗口 iframe（**srcdoc**）自动注入…**`url` 场景由扩展自行处理**" | `skills/obox-ext-dev/references/themes-settings.md:12` |
| F5 | iframe 是**独立文档**：CSS 自定义属性不跨 iframe 继承（`srcdoc` 之所以能生效，是因为 token 被拼进了**同一份文档**的 HTML 里，而非"继承"）。`sandbox` 的 `allow-same-origin`（`AppWindow.vue:156`）只让 iframe 保留**它自己的** `app://` 源，不会让它与父文档同源 ⇒ `iframe.contentDocument` 恒为 `null`，宿主**无法**注入 CSS/`<style>` | 平台 CSS 语义 + F2 的实现方式 + `src/main/protocol.ts:18-29` |
| F6 | 扩展宿主侧 API 只能读到主题 **id**，**读不到 token 值**：`api.theme.getCurrent()` 返回 `themeStore.currentId` | `src/renderer/src/core/host.ts:527-547`（`getCurrent` / `onChanged` 都只传 id） |
| F7 | 子窗口 ↔ 扩展的桥**只有** `obox-extension` / `obox-extension-reply` 两种 action，没有主题消息 | `extensions/rdp/src/bridge.js:23-32` |
| F8 | **旧 §0 的 F8 不成立（本次修正）**：`AppWindow.vue` 里 `themeKey`（`:34-37`）与空实现的 `stateStore.onSettingsChanged` 订阅（`:101-109`）都是**子窗口自己的模块级状态**；主窗口切主题只改主窗口的 `stateStore`/`:root`，子窗口的 `stateStore`（`core/state.ts` **无** `storage` 监听）与 `themeStore.themes` 都不变 ⇒ 子窗口的 `themeKey` **不会**变化。**今天主窗口切主题时，子窗口连 `srcdoc` 卡片都不会即时跟随**（只有重开子窗口才对）。旧文档"宿主已做了一半"的结论必须撤回 | `src/renderer/src/AppWindow.vue:34-37`、`:101-109`、`:152`；`src/renderer/src/core/state.ts` 全文无 `storage` 监听；`src/main/**` 无 settings/theme 广播（渲染进程事件通道只有 `nav:open`、`ui:show`、`fs:watch-event`、`timer:fire`、`ipc:event`、`window:state-changed`、`notification:click`、`update:event`、`extension:message`、`extension:hook-request`） |
| F9 | 两个窗口**同源同 session**：主窗口与子窗口加载的是**同一个** `renderer/index.html`（仅 query 不同），`webPreferences` 未指定 `partition` ⇒ 共享 localStorage；`storage` 事件是 Chromium 提供的跨文档通知通道。**但本仓库此前从未使用过它**（故列为 §8 V5 的真机确认点与 §11.2 的 R1） | `src/main/appWindow.ts:25-30`（同一 `index.html`）、`:74-79`（无 `partition`） |
| F10 | 子窗口渲染进程**也**会跑 `host.start()` 的阶段一与收尾：`main.ts:20-30` 传 `activateExtensions:false`，`host.ts:883-896` 照常 `registerContributions`（含主题扩展），`host.ts:930` 调 `themeStore.applyCurrent()` ⇒ 子窗口自己的 `:root` 上就有当前主题的 token，可用 `getComputedStyle` 读出**生效值**；且 `themeStore.themes` 在子窗口里同样含全部主题（含用户主题扩展） | `src/renderer/src/main.ts:20-30`、`src/renderer/src/core/host.ts:883-896`、`:930` |
| F11 | 子窗口内 iframe 的 console 会转发进主进程日志，带 `[child-renderer:<level>]` 前缀 ⇒ 主题下发现场可观测 | `src/main/appWindow.ts:107-112` |

> **F2＋F5＋F8 合起来的后果**：今天把 `styles.css` 全量改成 `var(--token)` 引用，在不改宿主的前提下**每一个变量都会落到初始值**（无 fallback 时即"无值"），外观**既不跟随主题、也会失去配色**。路径 A 是唯一同时解决"值从哪来"与"切换时怎么通知"的方向。

### 0.3 已否决的替代方案（供 ADR-0022 的"备选"一节引用）

| 备选 | 做什么 | 否决理由（逐条对应 §0.2 的事实） |
| --- | --- | --- |
| **B：扩展自带"深/浅"两套 token 副本** | 不动宿主；扩展按 `api.theme.getCurrent()` 的 id 或 `prefers-color-scheme` 选一份自备色表 | ① id 要从扩展侧送进 iframe **仍然**需要一个通道（F6 只给 id、F7 没有主题消息）；② 扩展维护副本，宿主改主题/默认色必然漂移；③ 只能覆盖"深/浅"两档，新主题（例如第三方主题扩展）无法跟随 → 不满足 R-D1 的"每个主题"；④ 仍然要改宿主，代价却没换来正确性 |
| **C：只 token 化 CSS + 写死 fallback** | 零宿主改动；`styles.css` 全量改成 `var(--token, <当前深色值>)` | ① **不满足** R-D1"切换主题立即生效"（今天固定深色）；② 变成"预备好但未生效"，验收 1/6 无法通过；③ 与路径 A 相比省下的只是宿主三处改动，却让 R-D1 整条落空 |
| **D：在 `app://` 协议层注入 `<style>`** | 主进程在返回 iframe HTML 时改写文档、插入 token | 治本但成本高（要解析/改写 HTML、处理缓存与编码、还要覆盖 `file://`/dev 两种父文档场景）；本次不采用，作为 ADR-0022 的**退场条件**之一保留 |

### 0.4 与 spec §5「不改宿主」的处置

- spec §5 写"不改宿主（`src/**`）"、spec §6 写"R-D2 根因若在宿主侧则停下改判范围"。**路径 A 是用户在本轮明确拍板的范围扩张**，因此：
  - 本设计文档（而不是 spec 原文）记录该改判：spec 原文**不改**，保留决策沿革；改判结论以 **ADR-0022**（仓库 `docs/adr/`）为准。
  - 宿主改动**以 §2.7.7 的清单为限**，逐文件、逐位置可核对；除清单外的 `src/**` 一律不动。
  - 宿主改动走**分支 + PR**（`docs/adr/0008`），本地先过 `npm run typecheck` / `npm run lint` / `npm test`，CI `check` 通过后按约定自行 squash 合并。
- R-D2（选项错乱）与 R-D3（表单与说明文本）**与路径 A 无关**，仍按 §3–§6 原样执行；R-D2 若最终证明根因在宿主侧（§11.2 R5），再单独停下并同步 ADR。

---

## 1. 决策摘要（spec → 设计落点）

| spec | 落点 |
| --- | --- |
| **R-D1** 主题跟随 | §0（路径 A 决策与事实）＋ §2（token 映射表，672 行 `styles.css` 逐条映射）＋ **§2.7（下发机制、时序、宿主/扩展改动清单）** ＋ §2.6（核查正则与命令） |
| **R-D2** 修复选项错乱 | §3：**先复现测试**（§3.1，5 个用例，先红后绿）→ 判定根因（§3.2 判定实验）→ 按根因修（§3.3 修法 1–4） |
| **R-D3** 表单结构 | §4（DOM 结构与类名、每项独占一行、全部只吃 token、高级分组折叠保留） |
| **R-D3** 字段说明 | §5（**65** 个字段逐条一句中文说明；未确证者标「待确认」并单列） |
| **R-D3** 取值说明 | §6（**20** 个 select/radio 取值逐条说明；呈现方式决策 + 理由） |
| 验收 5（命令） | §7 测试计划（**§7.4 为宿主侧 vitest 计划**）、§10 验收执行清单、§13 每步验收命令 |
| 验收 6（真机） | §8 真机验证步骤（V1–V6） |
| 验收 7（不改数据模型） | §9 文件与归属、§11 风险与不在范围内 |
| 归档 | §9.3（宿主 ADR → `docs/adr/0022`；扩展 ADR → `extensions/rdp/docs/adr/0002`）＋ §14（两条 ADR 的标题与要点大纲） |
| 文档同步（仓库强制约定） | §12（逐文件、逐句子、逐表格行） |
| 实施顺序 | §13（8 步，每步带验收命令） |
| R-D2 与 R-D3 的遗留核对 | §15（4 个字段 + 1 个取值的独立核对清单） |

---

## 2. R-D1：`styles.css` → 宿主 token（全量映射表）（路径 A 定稿）

### 2.1 现状盘点（命令与数字）

```powershell
cd extensions/rdp
$t = Get-Content src/styles.css -Raw
"行数           : " + (Get-Content src/styles.css).Count          # 672
"hex 字面量     : " + ([regex]::Matches($t,'#[0-9a-fA-F]{3,8}\b')).Count        # 23
"rgb/rgba 字面量: " + ([regex]::Matches($t,'\b(?:rgba?|hsla?)\(')).Count        # 6
"font-family 声明: " + ([regex]::Matches($t,'font-family\s*:')).Count            # 5
```

出现的 18 个**不同** hex 值：`#0e639c #1177bb #1e1e1e #252526 #2d2d30 #333337 #3794ff #3c3c3c #3fb950 #4a4a4a #6b6b6b #8a6d3b #9d9d9d #cccccc #d7ba7d #f14c4c #ff6a6a #ffffff`。

**结论**：目前是"自带一套与宿主无关的完整配色"（`styles.css:1-23` 的注释即承认此点，并声明"§3.9.6 的跟随留到宿主注入 token 之后"）。本次要做的是把上表 18 个值 + 6 个 rgba + 5 处字体族**全部**换成宿主 token 或 token 派生式。

**宿主 token 清单（25 个，本表只用这些；原文写"26 个"是笔误，已按 `src/renderer/src/assets/main.css:2-29` 逐条更正）**：`--bg --bg-panel --bg-sidebar --bg-titlebar --bg-input --border --fg --fg-dim --fg-bright --fg-link --fg-error --fg-warning --fg-success --accent --hover-bg --selection-bg --nav-icon --statusbar-bg --statusbar-fg --font-family --font-size --font-size-sm --font-size-lg --icon-size --nav-icon-size`（取值见 `src/renderer/src/assets/main.css:2-29`）。

### 2.2 根变量与全局（删掉整个 `:root` 自造块）

| # | 现有选择器与属性 | 现有值 | 目标 token |
| --- | --- | --- | --- |
| 1 | `:root --bg` | `#1e1e1e` | `var(--bg)`（作为 `--e-bg` 语义别名，供 §2.3 用） |
| 2 | `:root --panel` | `#252526` | `var(--bg-panel)` |
| 3 | `:root --panel-2` | `#2d2d30` | `var(--bg-input)` |
| 4 | `:root --border` | `#3c3c3c` | `var(--border)` |
| 5 | `:root --fg` | `#cccccc` | `var(--fg)` |
| 6 | `:root --fg-dim` | `#9d9d9d` | `var(--fg-dim)` |
| 7 | `:root --accent` | `#0e639c` | `var(--accent)` |
| 8 | `:root --accent-hover` | `#1177bb` | 删除别名，直接用 `var(--hover-bg)` |
| 9 | `:root --danger` | `#f14c4c` | `var(--fg-error)` |
| 10 | `:root --ok` | `#3fb950` | `var(--fg-success)` |
| 11 | `:root --busy` | `#3794ff` | `var(--accent)` |
| 12 | `:root --mono` | `Consolas, 'Cascadia Mono', monospace` | **降级删除**：`.card__title` 改用 `var(--font-family)`（见 §2.5 决策 E2） |
| 13 | `body background` | `var(--bg)` | `var(--bg)` |
| 14 | `body color` | `var(--fg)` | `var(--fg)` |
| 15 | `body font-family` | `'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif` | `var(--font-family)` |
| 16 | `body font-size` | `13px` | `var(--font-size)` |

> **关于本表与 §2.3–2.5**：为保证不出现"等等/其余同上"，**§2.3 起不再使用 #1–#12 的自造别名**，一律写宿主真名 token；`--radius` / `--radius-lg` 属布局例外（§2.5-例外清单 E1）。

### 2.3 骨架 / 按钮 / 卡片 / 空态 / 状态栏

| # | 现有选择器与属性 | 现有值 | 目标 token |
| --- | --- | --- | --- |
| 17 | `::-webkit-scrollbar-track background` | `var(--bg)` | `var(--bg)` |
| 18 | `::-webkit-scrollbar-thumb background` | `var(--border)` | `var(--border)` |
| 19 | `::-webkit-scrollbar-thumb border` | `2px solid var(--bg)` | `2px solid var(--bg)`（色随 token，宽度留布局） |
| 20 | `::-webkit-scrollbar-thumb:hover background` | `#4a4a4a` | `var(--hover-bg)` |
| 21 | `::-webkit-scrollbar-corner background` | `var(--bg)` | `var(--bg)` |
| 22 | `.app__header background` | `var(--panel)` | `var(--bg-panel)` |
| 23 | `.app__header border-bottom` | `1px solid var(--border)` | `1px solid var(--border)` |
| 24 | `.app__title font-size` | `15px` | `var(--font-size-lg)` |
| 25 | `.app__heading font-size` | `15px` | `var(--font-size-lg)` |
| 26 | `.badge border` | `1px solid var(--border)` | `1px solid var(--border)` |
| 27 | `.badge background` | `var(--panel-2)` | `var(--bg-sidebar)` |
| 28 | `.badge color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 29 | `.badge font-size` | `12px` | `var(--font-size-sm)` |
| 30 | `.app__loading color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 31 | `.alert border` | `1px solid var(--border)` | `1px solid var(--border)` |
| 32 | `.alert font-size` | `12px` | `var(--font-size-sm)` |
| 33 | `.alert--error border-color` | `var(--danger)` | `var(--fg-error)` |
| 34 | `.alert--error background` | `rgba(241, 76, 76, 0.08)` | `color-mix(in srgb, var(--fg-error) 8%, transparent)` |
| 35 | `.alert--error color` | `var(--danger)` | `var(--fg-error)` |
| 36 | `.btn border` | `1px solid var(--border)` | `1px solid var(--border)` |
| 37 | `.btn background` | `var(--panel-2)` | `var(--bg-input)` |
| 38 | `.btn color` | `var(--fg)` | `var(--fg)` |
| 39 | `.btn font-family` | `inherit` | `inherit`（保留） |
| 40 | `.btn font-size` | `13px` | `var(--font-size)` |
| 41 | `.btn:hover border-color` | `#4a4a4a` | `transparent`（hover 底色负责反馈，避免自造描边色） |
| 42 | `.btn:hover background` | `#333337` | `var(--hover-bg)` |
| 43 | `.btn--primary border-color` | `var(--accent)` | `var(--accent)` |
| 44 | `.btn--primary background` | `var(--accent)` | `var(--accent)` |
| 45 | `.btn--primary color` | `#ffffff` | `var(--fg-bright)`（见 §2.5 决策 E3） |
| 46 | `.btn--primary:hover border-color` | `var(--accent-hover)` | `var(--accent)` |
| 47 | `.btn--primary:hover background` | `var(--accent-hover)` | `color-mix(in srgb, var(--accent) 85%, var(--fg-bright))` |
| 48 | `.btn--danger border-color` | `var(--danger)` | `var(--fg-error)` |
| 49 | `.btn--danger background` | `var(--danger)` | `transparent` → **改为描边式危险按钮**（§2.5 决策 E4） |
| 50 | `.btn--danger color` | `#ffffff` | `var(--fg-error)` |
| 51 | `.btn--danger:hover border-color` | `#ff6a6a` | `var(--fg-error)` |
| 52 | `.btn--danger:hover background` | `#ff6a6a` | `color-mix(in srgb, var(--fg-error) 15%, transparent)` |
| 53 | `.btn:focus-visible, .input:focus-visible, .select:focus-visible, .dot:focus-visible, .statusbar__toggle:focus-visible box-shadow` | `0 0 0 2px var(--accent)` | `0 0 0 2px var(--accent)`（色随 token） |
| 54 | `.card border` | `1px solid var(--border)` | `1px solid var(--border)` |
| 55 | `.card background` | `var(--panel)` | `var(--bg-panel)` |
| 56 | `.card__title font-family` | `var(--mono)` | `var(--font-family)`（§2.5 决策 E2） |
| 57 | `.card__title font-size` | `14px` | `var(--font-size)` |
| 58 | `.card__subtitle color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 59 | `.card__subtitle font-size` | `12px` | `var(--font-size-sm)` |
| 60 | `.card__error border` | `1px solid var(--danger)` | `1px solid var(--fg-error)` |
| 61 | `.card__error background` | `rgba(241, 76, 76, 0.08)` | `color-mix(in srgb, var(--fg-error) 8%, transparent)` |
| 62 | `.card__error color` | `var(--danger)` | `var(--fg-error)` |
| 63 | `.card__error font-size` | `12px` | `var(--font-size-sm)` |
| 64 | `.dot background` | `var(--border)` | `var(--border)` |
| 65 | `.dot--opening background` | `var(--busy)` | `var(--accent)` |
| 66 | `.dot--ok background` | `var(--ok)` | `var(--fg-success)` |
| 67 | `.dot--error background` | `var(--danger)` | `var(--fg-error)` |
| 68 | `.empty__icon color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 69 | `.empty__title font-size` | `15px` | `var(--font-size-lg)` |
| 70 | `.empty__hint color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 71 | `.empty__hint font-size` | `13px` | `var(--font-size)` |
| 72 | `.statusbar border-top` | `1px solid var(--border)` | `1px solid var(--border)` |
| 73 | `.statusbar background` | `var(--panel)` | `var(--statusbar-bg)` |
| 74 | `.statusbar color` | `var(--fg-dim)` | `var(--statusbar-fg)` |
| 75 | `.statusbar font-size` | `12px` | `var(--font-size-sm)` |
| 76 | `.statusbar__toggle background` | `transparent` | `transparent`（关键字，非色值） |
| 77 | `.statusbar--ok .statusbar__text color` | `var(--ok)` | `var(--fg-success)` |
| 78 | `.statusbar--error .statusbar__text color` | `var(--danger)` | `var(--fg-error)` |

### 2.4 模态框 / 表单 / 折叠面板 / spinner

| # | 现有选择器与属性 | 现有值 | 目标 token |
| --- | --- | --- | --- |
| 79 | `.overlay background` | `rgba(0, 0, 0, 0.5)` | `color-mix(in srgb, var(--bg) 55%, transparent)`（§2.5 决策 E5） |
| 80 | `.modal border` | `1px solid var(--border)` | `1px solid var(--border)` |
| 81 | `.modal background` | `var(--panel)` | `var(--bg-panel)` |
| 82 | `.modal box-shadow` | `0 12px 32px rgba(0, 0, 0, 0.5)` | `0 12px 32px color-mix(in srgb, var(--bg) 45%, transparent)`（§2.5 决策 E5） |
| 83 | `.modal__header border-bottom` | `1px solid var(--border)` | `1px solid var(--border)` |
| 84 | `.modal__title font-size` | `15px` | `var(--font-size-lg)` |
| 85 | `.modal__close background` | `transparent` | `transparent`（关键字） |
| 86 | `.modal__close color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 87 | `.modal__close font-size` | `15px` | `var(--font-size-lg)` |
| 88 | `.modal__close:hover color` | `var(--fg)` | `var(--fg)` |
| 89 | `.modal__footer border-top` | `1px solid var(--border)` | `1px solid var(--border)` |
| 90 | `.modal__text font-size` | `13px` | `var(--font-size)` |
| 91 | `.modal__hint color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 92 | `.modal__hint font-size` | `12px` | `var(--font-size-sm)` |
| 93 | `.form-group__title color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 94 | `.form-group__title font-size` | `12px` | `var(--font-size-sm)` |
| 95 | `.field__label color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 96 | `.field__label font-size` | `12px` | `var(--font-size-sm)` |
| 97 | `.field__required color` | `var(--danger)` | `var(--fg-error)` |
| 98 | `.field__hint color` | `var(--fg-dim)` | `var(--fg-dim)`（与新增 `.field__desc` 合并，见 §4.3） |
| 99 | `.field__hint font-size` | `12px` | `var(--font-size-sm)` |
| 100 | `.field__error color` | `var(--danger)` | `var(--fg-error)` |
| 101 | `.field__error font-size` | `12px` | `var(--font-size-sm)` |
| 102 | `.badge--warn margin-left` | `4px` | 保留（布局） |
| 103 | `.badge--warn padding` | `0 6px` | 保留（布局） |
| 104 | `.badge--warn border` | `1px solid #8a6d3b` | `1px solid var(--fg-warning)` |
| 105 | `.badge--warn background` | `rgba(138, 109, 59, 0.2)` | `color-mix(in srgb, var(--fg-warning) 15%, transparent)` |
| 106 | `.badge--warn color` | `#d7ba7d` | `var(--fg-warning)` |
| 107 | `.badge--warn font-size` | `11px` | `var(--font-size-sm)` |
| 108 | `.input, .select border` | `1px solid var(--border)` | `1px solid var(--border)` |
| 109 | `.input, .select background` | `var(--panel-2)` | `var(--bg-input)` |
| 110 | `.input, .select color` | `var(--fg)` | `var(--fg)` |
| 111 | `.input, .select font-family` | `inherit` | `inherit`（保留） |
| 112 | `.input, .select font-size` | `13px` | `var(--font-size)` |
| 113 | `.input::placeholder color` | `#6b6b6b` | `var(--fg-dim)`（§2.5 决策 E6） |
| 114 | `.input--error, .select--error border-color` | `var(--danger)` | `var(--fg-error)` |
| 115 | `.pair__sep color` | `var(--fg-dim)` | `var(--fg-dim)` |
| 116 | `.check color` | `var(--fg)` | `var(--fg)` |
| 117 | `.check font-size` | `13px` | `var(--font-size)` |
| 118 | `.check input accent-color` | `var(--accent)` | `var(--accent)` |
| 119 | `.radio-group label font-size` | `13px` | `var(--font-size)` |
| 120 | `.radio-group input accent-color` | `var(--accent)` | `var(--accent)` |
| 121 | `.accordion border` | `1px solid var(--border)` | `1px solid var(--border)` |
| 122 | `.accordion background` | `var(--panel-2)` | `var(--bg-input)` |
| 123 | `.accordion__toggle background` | `transparent` | `transparent`（关键字） |
| 124 | `.accordion__toggle color` | `var(--fg)` | `var(--fg)` |
| 125 | `.accordion__toggle font-family` | `inherit` | `inherit`（保留） |
| 126 | `.accordion__toggle font-size` | `13px` | `var(--font-size)` |
| 127 | `.accordion__toggle:hover background` | `#333337` | `var(--hover-bg)` |
| 128 | `.spinner border` | `2px solid rgba(255, 255, 255, 0.35)` | `2px solid color-mix(in srgb, currentColor 35%, transparent)`（§2.5 决策 E7） |
| 129 | `.spinner border-top-color` | `#ffffff` | `currentColor`（§2.5 决策 E7） |

### 2.5 决策与例外

#### 决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| **E1** | `--radius: 8px`、`--radius-lg: 10px` **保留**（归入布局例外清单） | 宿主 token 清单里**没有**圆角 token（`main.css:2-29` 无 `--radius`），无法映射；硬改成某个值属于无依据的改动 |
| **E2** | `.card__title` 的 `--mono`（`Consolas, 'Cascadia Mono', monospace`）**改为** `var(--font-family)` | 宿主 token 清单里**没有**等宽字体 token，而 R-D1 明令"不得含字体族"。改用宿主字体族是唯一合规解；代价是 `user@host:port` 失去等宽对齐（可接受：该行已 `text-overflow: ellipsis` 单行省略，`title` 悬浮给全量） |
| **E3** | 主按钮文字色由 `#ffffff` → `var(--fg-bright)` | `--fg-bright` 正是"最亮前景"语义（深色 `#ffffff`）；两个主题都保证它是与背景对比最强的一档 |
| **E4** | `.btn--danger` 由"实心红底白字"改为"透明底 + `--fg-error` 描边 + `--fg-error` 文字"，`hover` 用 `color-mix(--fg-error 15%, transparent)` 淡底 | `--fg-error` 在深色主题是**亮红 `#f48771`**，白字压在其上对比度不足（`main.css:13`）；改成描边式后文字与描边同源，天生自洽，且危险语义仍在（红色）。这是**唯一**改变视觉权重的映射，需在真机验收时确认"删除"仍够醒目 |
| **E5** | 遮罩与模态框阴影不再写死黑色，改为由 `--bg` 派生：遮罩 `color-mix(in srgb, var(--bg) 55%, transparent)`、阴影 `color-mix(in srgb, var(--bg) 45%, transparent)` | 黑遮罩在深色主题下几乎看不出层次；由 `--bg` 派生能保证"深色主题下压暗、浅色主题下压深"两个方向都成立。`color-mix()` 在 Electron 内置 Chromium（构建目标 `chrome120`，`vite.config.mjs:19`）可用 |
| **E6** | `::placeholder` 的 `#6b6b6b` → `var(--fg-dim)` | 宿主无 placeholder 专用 token；未标注 placeholder 与已填值需区分，但 `--fg-dim` 在深浅主题下都比 `--fg` 暗一档，语义正好 |
| **E7** | `.spinner` 用 `currentColor` + `color-mix` 代替写死的白色 | spinner 出现在主按钮（`--accent` 底）与危险按钮（透明底）两处，写死白色在其中一处必错；`currentColor` 让描边永远跟随所在按钮的文字色 |

#### 例外清单：**允许保留的纯布局属性**（不含任何色彩与字体族）

| 选择器 | 保留属性（原值） |
| --- | --- |
| `*` | `box-sizing: border-box` |
| `html, body` | `height: 100%` |
| `body` | `margin: 0; overflow: hidden` |
| `#app` | `height: 100%` |
| `::-webkit-scrollbar` | `width: 10px; height: 10px` |
| `::-webkit-scrollbar-thumb` | `border-radius: 5px` |
| `::-webkit-scrollbar-thumb:hover` | 仅 background（**已映射**，不属例外） |
| `.app` | `display:flex; flex-direction:column; height:100vh` |
| `.app__header` | `position:sticky; top:0; z-index:10; flex:0 0 56px; height:56px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 20px` |
| `.app__title` | `display:flex; align-items:center; gap:12px; font-weight:600` |
| `.app__heading` | `margin:0; font-weight:600` |
| `.badge` | `padding:2px 8px; border-radius:999px; font-weight:400` |
| `.app__content` | `flex:1 1 auto; overflow:auto` |
| `.app__grid` | `display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:16px; padding:20px` |
| `.app__loading` | `padding:20px` |
| `.alert` | `margin:0 0 12px; padding:8px 12px; border-radius:var(--radius); word-break:break-all` |
| `@media (max-width:720px) .app__grid` | `grid-template-columns:1fr` |
| `.btn` | `display:inline-flex; align-items:center; justify-content:center; gap:4px; min-height:28px; padding:4px 12px; border-radius:var(--radius); cursor:pointer` |
| `.btn:disabled` | `opacity:0.5; cursor:not-allowed` |
| `.card` | `position:relative; display:flex; flex-direction:column; gap:8px; padding:16px; border-radius:var(--radius)` |
| `.card__title` | `margin:0; padding-right:20px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis` |
| `.card__subtitle` | `margin:0; min-height:16px` |
| `.card__actions` | `display:flex; justify-content:flex-end; gap:8px; margin-top:4px` |
| `.card__error` | `margin:0; padding:8px; border-radius:var(--radius); word-break:break-all` |
| `.dot` | `position:absolute; top:12px; right:12px; width:12px; height:12px; padding:0; border:none; border-radius:50%; cursor:pointer` |
| `.dot--ok` | `cursor:default` |
| `@keyframes dot-pulse` | `opacity` / `transform` 关键帧 |
| `.empty` | `display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; min-height:320px; height:100%; padding:40px 20px; text-align:center` |
| `.empty__icon` | `margin-bottom:8px` |
| `.empty__title` | `margin:0; font-weight:600` |
| `.empty__hint` | `margin:0 0 12px` |
| `.statusbar` | `flex:0 0 40px; height:40px; display:flex; align-items:center; gap:8px; padding:0 20px` |
| `.statusbar--collapsed` | `flex-basis:24px; height:24px; padding:0 12px` |
| `.statusbar__toggle` | `display:inline-flex; align-items:center; gap:4px; padding:2px 4px; border:none; border-radius:4px; font:inherit; cursor:pointer` |
| `.statusbar__text` | `overflow:hidden; white-space:nowrap; text-overflow:ellipsis` |
| `.overlay` | `position:fixed; inset:0; z-index:100; display:flex; align-items:center; justify-content:center; padding:16px` |
| `.modal` | `display:flex; flex-direction:column; width:640px; max-width:100%; max-height:80vh; border-radius:var(--radius-lg)` |
| `.modal--sm` | `width:420px` |
| `.modal__header` | `flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 20px` |
| `.modal__title` | `margin:0; font-weight:600` |
| `.modal__close` | `padding:0 6px; border:none; cursor:pointer` |
| `.modal__body` | `flex:1 1 auto; overflow:auto; padding:16px 20px` |
| `.modal__footer` | `flex:0 0 auto; display:flex; justify-content:flex-end; gap:8px; padding:12px 20px` |
| `.modal__text` | `margin:0 0 8px` |
| `.modal__hint` | `margin:0` |
| `@media (max-width:720px) .modal / .modal--sm` | `width:calc(100% - 32px)` |
| `.form-group` | `margin-bottom:16px` |
| `.form-group__title` | `margin:0 0 8px; font-weight:600; letter-spacing:0.5px` |
| `.form-grid` | **删除**（§4.2 改为单列），其 `gap:12px` 移交给新的 `.form-rows` |
| `.field` | `display:flex; flex-direction:column; gap:4px; min-width:0` |
| `.field--full` | `grid-column:1 / -1`（§4 改为不再需要，保留为无害兼容） |
| `.field__required` | `margin-left:2px` |
| `.field__error` | `margin:0` |
| `.badge--warn` | `border-radius:999px` |
| `.input, .select` | `width:100%; min-height:28px; padding:4px 8px; border-radius:var(--radius)` |
| `.input-row` | `display:flex; align-items:center; gap:8px` |
| `.input-row .input` | `flex:1 1 auto` |
| `.pair` | `display:flex; align-items:center; gap:8px` |
| `.pair .input` | `flex:1 1 0; min-width:0` |
| `.check` | `display:flex; align-items:center; gap:8px; min-height:28px` |
| `.check input` | `width:14px; height:14px; margin:0` |
| `.radio-group` | `display:flex; flex-wrap:wrap; gap:12px; min-height:28px; align-items:center` |
| `.radio-group label` | `display:inline-flex; align-items:center; gap:4px` |
| `.radio-group input` | `margin:0` |
| `.accordion` | `border-radius:var(--radius)` |
| `.accordion__toggle` | `display:flex; align-items:center; gap:8px; width:100%; padding:8px 12px; border:none; border-radius:var(--radius); text-align:left; cursor:pointer` |
| `.accordion__body` | `padding:0 12px 12px` |
| `.spinner` | `display:inline-block; width:12px; height:12px; border-radius:50%; animation:spin 0.8s linear infinite` |
| `@keyframes spin` | `transform: rotate(360deg)` |
| `@media (max-width:560px)` | §4 改为 `.form-rows` 的单列兜底（详见 §4.2） |

> 例外清单里的 `var(--radius)` / `var(--radius-lg)` 是**扩展自定义**的布局变量（E1），不是宿主 token，也不是色彩/字体值。

### 2.6 验收用核查命令（"零自造色值"）

**核查 1：`styles.css` 不得残留任何色彩字面量**

```powershell
cd extensions/rdp
$t = Get-Content src/styles.css -Raw
$hex  = [regex]::Matches($t,'#[0-9a-fA-F]{3,8}\b') | ForEach-Object { $_.Value }
$fn   = [regex]::Matches($t,'\b(?:rgba?|hsla?)\(') | ForEach-Object { $_.Value }
$word = [regex]::Matches($t,':\s*(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|brown|navy|teal|olive|maroon|lime|aqua|fuchsia)\b') | ForEach-Object { $_.Value }
$bad = @($hex) + @($fn) + @($word)
if ($bad.Count -eq 0) { "OK 零自造色值"; exit 0 } else { "FAIL: " + ($bad -join ' '); exit 1 }
```

判定：退出码 **0**。当前基线：hex 23 + rgba 6 + 关键字 0 = **29 处命中**（先记录基线，改完归零）。
正则说明：`#…` 覆盖 hex（含 `#fff` 与 8 位 alpha）；`rgb(`/`rgba(`/`hsl(`/`hsla(` 覆盖函数式；关键字表覆盖 `color: white` 这类。`transparent` **有意不在**关键字表内——它是"无色"而非色值，且 `color-mix()` 的第二参必须用它。

**核查 2：不得残留字体族字面量**

```powershell
cd extensions/rdp
$t = Get-Content src/styles.css -Raw
$fam  = [regex]::Matches($t,'font-family\s*:\s*(?!inherit|var\(--font-family\))') | ForEach-Object { $_.Value }
$mono = [regex]::Matches($t,'\b(?:Consolas|Cascadia|Menlo|Monaco|Courier|monospace)\b') | ForEach-Object { $_.Value }
if (($fam.Count + $mono.Count) -eq 0) { "OK 零自造字体族"; exit 0 } else { "FAIL: " + (@($fam)+@($mono) -join ' '); exit 1 }
```

**核查 3：所有 `var()` 只能引用宿主 token 白名单 + 扩展自有布局变量**

```powershell
cd extensions/rdp
$t = Get-Content src/styles.css -Raw
$allowed = @('--bg','--bg-panel','--bg-sidebar','--bg-titlebar','--bg-input','--border','--fg','--fg-dim','--fg-bright','--fg-link','--fg-error','--fg-warning','--fg-success','--accent','--hover-bg','--selection-bg','--nav-icon','--statusbar-bg','--statusbar-fg','--font-family','--font-size','--font-size-sm','--font-size-lg','--icon-size','--nav-icon-size','--radius','--radius-lg')
$used = [regex]::Matches($t,'var\(\s*(--[a-z0-9-]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$out = $used | Where-Object { $allowed -notcontains $_ }
if (-not $out) { "OK 仅用白名单 token"; exit 0 } else { "FAIL 越界: " + ($out -join ' '); exit 1 }
```

（`--radius` / `--radius-lg` 是例外清单 E1 授权的扩展自有布局变量。）

**核查 4（自动化）**：把核查 1–3 落成 `test/stylesTokens.test.js`（§7），使 `npm test` 即含该门禁，而不是只靠人跑命令。

### 2.7 主题下发机制、时序与两侧改动清单（路径 A 定稿）

#### 2.7.1 硬约束（不可绕过）

| # | 约束 | 依据 |
| --- | --- | --- |
| **C1** | 子窗口 iframe 是**跨源**的：父文档在 dev 是 `http://localhost:5173`、打包是 `file://`，而 iframe 是 `app://extensions/<id>/…` 或 `app://debug/<id>/…` | `src/main/appWindow.ts:25-30`、`src/main/protocol.ts:13-29`、`api-reference.md:176` |
| **C2** | 跨源 ⇒ `iframe.contentDocument` 恒为 `null`，宿主**无法**注入 `<style>` 或改 CSS；`sandbox="allow-scripts allow-same-origin …"` 里的 `allow-same-origin` 只让 iframe 保留**它自己的** `app://` 源，不会让它与父文档同源 | F5；`src/renderer/src/AppWindow.vue:156` |
| **C3** | CSS 自定义属性**不跨文档继承**（`srcdoc` 能生效，是因为 token 被拼进了**同一份文档**的 HTML） | F2；`AppWindow.vue:38-44` |
| **C4** | 因此 token **只能经消息送达**；`postMessage` 本身不受同源限制（既有 `obox-extension` 桥就是这么工作的） | `extensions/rdp/src/bridge.js:1-11` |
| **C5** | 扩展侧 API 只能读到主题 **id**，读不到 token 值 | F6；`src/renderer/src/core/host.ts:527-547` |

#### 2.7.2 消息协议（沿用既有 `obox-*` 协议风格，不另造一套）

| 方向 | 消息 | 触发 | 说明 |
| --- | --- | --- | --- |
| **宿主 → 子窗口 iframe** | `{ source:'obox-app', action:'obox-theme', themeId, tokens }` | ① iframe `load` 完成；② 主题变化（§2.7.4）；③ 收到下面的请求 | 宿主用 `iframe.contentWindow.postMessage(msg, '*')` 发出——targetOrigin 与既有 reply 一致（`AppWindow.vue:73-81`）；`tokens` 是 `Record<token 名, 生效值>`，键形如 `--bg` |
| **子窗口 iframe → 宿主** | `{ source:'obox-app', action:'obox-theme-request' }` | 扩展启动时（0 / 300 / 1000 ms 各一次，收到推送即停） | **不带 `requestId`**：这是"通知 + 请求重发"，不是请求-响应；宿主收到后用**同一条 `obox-theme`** 回，不新增 reply 动作（少一个要同步维护的动作） |
| （不使用） | `obox-extension` / `obox-extension-reply` | — | 主题下发**不经** `api.app.onMessage` 桥：那条桥要经主进程 IPC（60 s 超时，`src/main/appWindow.ts:150-177`），且 handler 在**主窗口**的扩展代码里，而主窗口扩展也拿不到 token 值（C5）。主题是"宿主渲染进程 → iframe"的直连推送 |

**载荷字段**：

| 字段 | 类型 | 约束 | 谁校验 |
| --- | --- | --- | --- |
| `source` | `'obox-app'` | 固定字面量 | 双方 |
| `action` | `'obox-theme'` \| `'obox-theme-request'` | 固定字面量 | 双方 |
| `themeId` | `string` | 当前主题 id（`themeStore.currentId`，如 `theme-dark`）；空串表示当前没有主题扩展 | 扩展侧（日志与 `color-scheme`） |
| `tokens` | `Record<string,string>` | 键匹配 `/^--[a-z0-9-]+$/`、值为**非空 string**；不满足的条目**丢弃**，不抛错 | 宿主构造时过滤一次（`sanitizeThemeTokens`），扩展侧再过滤一次（双保险） |

#### 2.7.3 首次加载时序（谁先谁后，逐步骤）

| 步 | 发生什么 | 依据 |
| --- | --- | --- |
| 1 | 子窗口（独立 `BrowserWindow`）加载 `renderer/index.html?obox-window=app&appId=…`；`main.ts:20-30` **先** `await host.start({ activateExtensions:false })`：阶段一照常注册贡献点（含主题扩展），收尾 `themeStore.applyCurrent()` 把**当前主题的 token 写进子窗口自己的 `:root`**；**然后**才 `createApp(AppWindow).mount()` | `src/renderer/src/main.ts:20-30`、`src/renderer/src/core/host.ts:883-896`、`:930` |
| 2 | AppWindow 挂载 iframe（`:src = registration.url`，跨源），同时在 `setup` 里读一次"生效 token 快照"（`collectThemeTokens` + `getComputedStyle(document.documentElement)`，见 §2.7.5）——第 1 步已 apply，因此快照**此刻就有值** | F10、§2.7.5 |
| 3 | iframe 文档执行 `ui/assets/index-*.js`：`main.js` **第一件事**就是 `installThemeBridge()`——它**同步**把内置兜底 token 写到 iframe 自己的 `documentElement`（首帧即有配色），随后注册 `message` 监听，再发出第一次 `obox-theme-request` | §2.7.8；`extensions/rdp/src/main.js`（现 5 行） |
| 4 | 宿主侧 iframe `@load` 回调触发（HTML 的 `load` 在文档与子资源、含模块脚本加载完成后才发）→ `pushThemeTokens()` 把 `themeId` + 快照 postMessage 给 `iframe.contentWindow` | §2.7.7 第 3 项 |
| 5 | 扩展收到推送 → `applyThemeTokens()` 覆盖兜底值 → 清掉重试定时器 → 记一条 `[rdp] 主题已应用 …` | §2.7.8 |
| 6 | 结果：**兜底（首帧）→ 推送（权威值）**；`obox-theme-request` 是第二条保险：若第 3 步的请求早于宿主监听器就绪而丢失，第 4 步的 `@load` 推送照样送达；反之若 `@load` 因故未到，第 3 步的请求 + 0.3 s / 1 s 重试能补上 | — |

**竞态与保证**：

| 风险 | 为什么不会丢主题 |
| --- | --- |
| 扩展的请求早于宿主的 `message` 监听注册 | 模板上的 `@load` 在元素创建时（`mount()` 期间）就绑定，而 iframe 的 `load` 必然晚于它；且推送**不依赖**请求 |
| 宿主的 `@load` 早于扩展脚本执行完 | `load` 事件在文档与子资源（含模块脚本）加载完成后才触发 |
| 主题在 iframe 加载过程中被切换 | 切换会再触发一次推送（§2.7.4），后到的覆盖先到的（`setProperty` 幂等） |
| 推送到达时扩展还没装上监听 | `installThemeBridge()` 在模块顶层同步执行，早于任何网络往返；请求重试再兜一层 |

#### 2.7.4 主题变化（跨窗口）——本仓库今天缺的那一段

**已核实的缺陷**：子窗口与主窗口是两个 document，模块级状态各自一份。主窗口 `themeStore.setTheme()`（`core/theme.ts:42-47`）只改主窗口的 `stateStore` 与 `:root`；子窗口的 `stateStore`（`core/state.ts` 无 `storage` 监听）与 `themeStore.themes` 都不变 ⇒ `AppWindow.vue` 的 `themeKey`（`:34-37`）**不会**变化。所以路径 A 必须补一条跨窗口通知，否则"切主题 → 推送"永远不会被触发（这也是 F8 修正的实际后果）。

**决策（最小、且不新增 IPC）**：两个窗口**同源同 session**（F9）⇒ 共享 localStorage，`storage` 事件即 Chromium 的跨文档通知通道。三步：

1. `src/renderer/src/core/state.ts`：把 `load()` 里的解析抽成导出的纯函数 `parsePersistedState(raw: string | null): PersistedState`（`load()` 改调它，行为不变）；新增 `stateStore.applyExternal(raw: string): string[]`——解析 → **整体替换** `settings` / `disabledExtensions` / `notificationDisabledExtensions` / `memento` → 返回**发生变化**的 settings key 列表，并按 key 逐个通知 `settingsListeners`（无变化则不通知）；新增纯函数 `diffSettingsKeys(before, after): string[]` 供单测。
2. 同文件末尾（浏览器侧，`typeof window !== 'undefined' && typeof window.addEventListener === 'function'` 才安装；node 单测环境不受影响）：`window.addEventListener('storage', (e) => { if (e.key !== STORAGE_KEY || typeof e.newValue !== 'string') return; stateStore.applyExternal(e.newValue) })`。
3. `src/renderer/src/AppWindow.vue`：订阅 `stateStore.onSettingsChanged((key) => { if (key === undefined || key === 'theme') refreshTheme() })`；`refreshTheme()` = `themeStore.applyCurrent()`（读**已合并**的 settings 里的新 id，用**子窗口自己**注册到的主题 token 应用到自己的 `:root`）→ 更新本地 `themeId` / `themeTokens` → `pushThemeTokens()`。
   - **子窗口绝不调用 `themeStore.setTheme()`**：它会写 localStorage，反向污染主窗口的权威快照并造成事件来回。子窗口只 `applyCurrent()`（只读、只应用）。
   - `srcdoc` 卡片：`frameKey = 'srcdoc:' + themeId`，主题变化 ⇒ key 变化 ⇒ iframe 重建 ⇒ 重新拼 `<style>`（**保留原有重渲染路径**）。
   - `url` 卡片：`frameKey = 'url:' + url`，与主题**无关** ⇒ **不重建**，靠推送更新 —— 这就是 R-D1 里"表单里正在填的内容不会被清空"的实现点。

**触发点总表**：

| 触发 | 宿主动作 | 备注 |
| --- | --- | --- |
| iframe `load` | `pushThemeTokens()` | 首次加载与页面自身刷新都会走 |
| 主题变化（`storage` → `refreshTheme`） | `applyCurrent()` → 刷新快照 → `pushThemeTokens()` | 本节第 1–3 步 |
| 收到 `obox-theme-request` | `pushThemeTokens()` | 幂等；来源校验见 §2.7.9 |
| 其它设置项变化（语言 / 扩展设置 / 快捷键…） | 不做任何事 | 只处理 `key === 'theme'` 与 `key === undefined` |

**风险与退路**：`storage` 事件的跨窗口送达属 Chromium 标准行为，但**本仓库此前从未依赖过**（全仓无 `storage` 监听、`src/main/**` 无 settings/theme 广播）。因此：列为真机确认点 **§8 V5** 与风险 **§11.2 R1**；**若 V5 不成立**，退路是把上面第 1–3 步换成主进程广播（`ipcMain` 收 → `webContents.send` 给所有窗口，仿 `src/main/fs.ts:39-41` 的 `broadcast()`），并同步新增 preload 方法 + `src/shared/types.ts` 类型；**该退路不影响 §2.7.2 的消息协议与扩展侧代码**，只需在 ADR-0022 记明换了哪条通道。

#### 2.7.5 主题 id 与 token 值的关系（下发"生效值"，不是"主题声明"）

- 扩展 API 只能读 id（C5）⇒ **值**必须由宿主下发；`themeId` 随包下发，供扩展记日志、决定 `color-scheme`、以及在宿主未来增删 token 时做兼容判断。
- 下发的 `tokens` 快照 = `HOST_THEME_TOKEN_NAMES`（**25 个**，与 `src/renderer/src/assets/main.css:2-29` 逐条一致）在宿主 `document.documentElement` 上的**生效值**（`getComputedStyle(root).getPropertyValue(name)`），即"`main.css` 默认值 + 当前主题覆盖（+ 上一个主题的残留，因为 `theme.ts:50-55` 只写不清）"。
  - **为什么不只发 `themeStore.current.tokens`**：那是"主题声明值"，部分主题只覆盖少数键，子窗口拿到后其余 token 仍为空；`getComputedStyle` 给出的快照与宿主主窗口**肉眼所见完全一致**，并天然跟随 `theme.ts` 的"不清旧键"语义（一致性优先于洁癖）。
  - 快照在宿主侧**每次推送前现算**（不在 `themeStore` 里缓存），避免主题扩展热重载后拿到旧值。
- 扩展侧**不得**把 `themeId` 当色值用；`color-scheme` 由 `colorSchemeForThemeId(id)` 决定（`/light/i` → `'light'`，否则 `'dark'`），只影响 UA 绘制的原生控件/滚动条底色，不影响任何自绘配色。

#### 2.7.6 降级：拿不到 token 时的行为（不报错、不空白）

| 情形 | 宿主 | 扩展 | 用户可见 |
| --- | --- | --- | --- |
| 宿主是旧版本（无 §2.7 机制） | 不推送、不响应请求 | 3 次请求（0/300/1000 ms）都无响应 → `console.warn` 一次 → 保留内置兜底 | 深色界面照常可用（兜底 = 宿主 dark 默认值），**不空白、不报错** |
| 推送未达但请求成功 | 收到请求即回一条 `obox-theme` | 同正常路径 | 无差别 |
| `tokens` 含非法键名 / 空值 / 非字符串 | 构造时 `sanitizeThemeTokens` 过滤 | 收到后**再过滤一次**，逐条丢弃并 `console.warn` | 无差别 |
| `tokens` 为空对象（无主题扩展 / 主题未注册） | 仍发（`themeId:''`、`tokens:{}`） | 保持兜底值 | 深色兜底（不空白） |
| iframe 加载失败（404 / 白屏） | 无 `load` 事件 ⇒ 不推送 | 页面脚本根本没跑 ⇒ 连兜底都没机会 | 属 App 卡片加载问题（`troubleshooting.md` 第 2 条），不是主题问题 |
| 扩展页在普通浏览器里被直接打开（无宿主） | 无 | 同"旧版本宿主" | 深色兜底可读 —— 这就是 §8 **V6** 的验证手段 |

**兜底表 `FALLBACK_TOKENS`（扩展侧，值 = 宿主 dark 默认值，逐条可核对 `main.css:2-29`）**：

| token | 兜底值 | 本扩展 `styles.css` 是否消费 |
| --- | --- | --- |
| `--bg` | `#1e1e1e` | 是（body/滚动条/遮罩派生） |
| `--bg-panel` | `#252526` | 是（卡片/模态框） |
| `--bg-sidebar` | `#333333` | 是（`.badge`） |
| `--bg-titlebar` | `#323233` | 否（留给宿主标题栏；仍下发/兜底） |
| `--bg-input` | `#3c3c3c` | 是（输入框/按钮/折叠头） |
| `--border` | `#3c3c3c` | 是 |
| `--fg` | `#cccccc` | 是 |
| `--fg-dim` | `#6e6e6e` | 是（标签/说明） |
| `--fg-bright` | `#ffffff` | 是（主按钮文字） |
| `--fg-link` | `#75beff` | 否（仍下发/兜底） |
| `--fg-error` | `#f48771` | 是（错误/危险） |
| `--fg-warning` | `#cca700` | 是（未确认角标） |
| `--fg-success` | `#4ec9b0` | 是（状态点） |
| `--accent` | `#007acc` | 是 |
| `--hover-bg` | `rgba(255, 255, 255, 0.1)` | 是 |
| `--selection-bg` | `#094771` | 否（仍下发/兜底） |
| `--nav-icon` | `#858585` | 否（仍下发/兜底） |
| `--statusbar-bg` | `#2a2a2a` | 是 |
| `--statusbar-fg` | `#cccccc` | 是 |
| `--font-family` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif` | 是 |
| `--font-size` | `13px` | 是 |
| `--font-size-sm` | `12px` | 是 |
| `--font-size-lg` | `16px` | 是 |
| `--nav-icon-size` | `24px` | 否（仍下发/兜底） |
| `--icon-size` | `24px` | 否（仍下发/兜底） |

> 兜底表放在 `src/theme.js`，**不放在 `styles.css`**：R-D1 验收 2 要求 `styles.css` 零色彩/字体字面量，因此 `styles.css` 只写**裸** `var(--token)`，兜底值集中在**一处 JS 常量**里，并由 §7.1 的两个用例钉住"`styles.css` 消费的 token ⊆ 兜底表键 ⊆ 宿主 token 白名单"。这是一笔**有意的技术债**（兜底表是宿主 dark 默认值的副本），退场条件写在 §14 的扩展 ADR 里。

#### 2.7.7 宿主侧改动清单

| # | 文件 | 具体位置 | 改什么 |
| --- | --- | --- | --- |
| H1 | `src/renderer/src/core/appTheme.ts` | **新文件**（纯模块，**零 import**，node 环境可直接单测） | 导出：`APP_THEME_PUSH_ACTION = 'obox-theme'`；`APP_THEME_REQUEST_ACTION = 'obox-theme-request'`；`HOST_THEME_TOKEN_NAMES: readonly string[]`（25 个，逐条对齐 `main.css:2-29`）；`isTokenName(name): boolean`（`/^--[a-z0-9-]+$/`）；`sanitizeThemeTokens(input: unknown): Record<string,string>`（丢弃非法键 / 非字符串 / 空串）；`collectThemeTokens(read: (name: string) => string, names = HOST_THEME_TOKEN_NAMES): Record<string,string>`（逐名读值、空值跳过）；`buildThemeMessage(themeId: string, tokens: Record<string,string>): AppThemeMessage`；`isThemePush(data: unknown): boolean`；`isThemeRequest(data: unknown): boolean`；`appFrameKey(registration: { url?: string } \| undefined, themeId: string): string`；类型 `AppThemeMessage` |
| H2 | `src/renderer/src/core/state.ts` | `:15`（`STORAGE_KEY` 导出）；`:24-54`（`load()` 抽成 `parsePersistedState`）；`:100-118` 附近（新增 `applyExternal` / `diffSettingsKeys`）；文件末尾（新增 `storage` 监听） | 见 §2.7.4 第 1–2 步：`parsePersistedState` 为纯函数、`applyExternal(raw): string[]` 负责合并 + 按变更 key 通知、`storage` 监听只在浏览器侧安装 |
| H3 | `src/renderer/src/AppWindow.vue` | `:8`（import `ref`/`watch`）；`:16` 后（import `./core/appTheme` 的四件套）；`:33-44`（`themeStyleHtml` 改读本地快照）；新增 `frameRef` / `themeId` / `themeTokens` / `frameKey` / `readThemeTokens()` / `refreshTheme()` / `pushThemeTokens()`；`:101-109`（把空订阅换成 `refreshTheme` 触发）；`:139-143`（退订）；`:54-99`（`onMessage` 增加 `obox-theme-request` 分支）；`:150-157`（`ref="frameRef"`、`:key="frameKey"`、`@load="pushThemeTokens"`） | 见下三条要点 |
| H4 | 不改 | `src/api/**`、`src/preload/**`、`src/main/**`、`src/shared/types.ts` | 无新 IPC、无新扩展 API：主题下发是"渲染进程 ↔ iframe"的直连消息 |
| H5 | 测试 | `test/app-theme.test.ts`（新增）、`test/state.test.ts`（扩展）、`test/app-window-wiring.test.ts`（新增） | 见 §7.4 |

**H3 的三条要点（实施时务必照此写）**：

1. **只对 `url` 型卡片推送**：`pushThemeTokens()` 开头 `if (!registration.value?.url) return`；`srcdoc` 卡片走文档内注入 + 重渲染（C3），两条路不叠加。
2. **`pushThemeTokens()` 的失败分支必须可观测**：`const win = frameRef.value?.contentWindow; if (!win) { console.warn('[AppWindow] 主题下发跳过：iframe 未就绪', appId); return }`；成功时 `console.log('[AppWindow] 下发主题', themeId.value, Object.keys(tokens).length + ' 个 token')`。
3. **`onMessage` 里新增的分支**：`case 'obox-theme-request'`：先校验 `e.source === frameRef.value?.contentWindow`（不匹配则 `console.warn('[AppWindow] 忽略来源不明的主题请求')` 并返回），再 `console.log('[AppWindow] 收到子窗口主题请求，下发', themeId.value)`，最后 `pushThemeTokens()`。

#### 2.7.8 扩展侧改动清单

| # | 文件 | 改什么 |
| --- | --- | --- |
| E1 | `extensions/rdp/src/theme.js` | **新文件**。**顶层零副作用**（所有 DOM 访问都在函数内、可注入），导出：`FALLBACK_TOKENS`（§2.7.6 的 25 条）；`isTokenName(name)`；`sanitizeThemeTokens(input)`；`applyThemeTokens(tokens, root): number`（逐条 `root.style.setProperty(k, v)`，非法键丢弃，整体 `try/catch`，异常只 `console.warn('[rdp] 主题应用失败', err)`，返回成功条数）；`colorSchemeForThemeId(themeId): 'light' \| 'dark'`；`installThemeBridge(options = {})`——`options = { window?, root?, post?, schedule?, requestDelaysMs? }`，默认取全局（`window` / `document.documentElement` / `parent.postMessage(…, '*')` / `setTimeout`）。`installThemeBridge` 的行为：① **同步** `applyThemeTokens(FALLBACK_TOKENS, root)` 并设 `root.style.colorScheme = 'dark'`；② `window.addEventListener('message', …)`，只认 `{source:'obox-app', action:'obox-theme'}` 且 `event.source === window.parent` 的消息；③ 按 `requestDelaysMs = [0, 300, 1000]` 发 `{source:'obox-app', action:'obox-theme-request'}`，收到推送即清定时器并设 `received = true`；④ 3 次都没收到 → `console.warn('[rdp] 未收到宿主主题推送（3 次请求无响应），使用内置兜底配色')`；⑤ 返回 `{ dispose() }`。`window` 不存在时（node 单测 / 无 DOM 环境）安全空转返回 `{ dispose(){} }`，**不抛错** |
| E2 | `extensions/rdp/src/main.js` | 在 `createApp(App).mount('#app')` **之前**调用 `installThemeBridge()`（同步写兜底 ⇒ 首帧就有配色；顺序不能反） |
| E3 | `extensions/rdp/src/index.html` | `<head>` 增加 `<meta name="color-scheme" content="dark" />`：JS 执行前由 UA 画出的画布底色用暗色，避免白闪（不含任何色值字面量） |
| E4 | `extensions/rdp/src/styles.css` | 按 §2.2–§2.4 映射为**裸** `var(--token)`（不写 `, fallback` 字面量），并新增 §4.3 的 `.form-rows` / `.field__desc` / `.radio__desc` |
| E5 | `extensions/rdp/src/bridge.js` | **不改**。它服务的是 `obox-extension` 请求-响应桥；主题推送是**单向**消息，二者职责不同（分开写便于各自演进，也避免 `unwrap()` 的信封逻辑被主题消息污染） |
| E6 | 测试与文档 | `extensions/rdp/test/themeBridge.test.js`（新增）、`test/stylesTokens.test.js`（增补两例）、`extensions/rdp/README.md`（主题跟随实现约定）、`extensions/rdp/docs/adr/0002-…` |

#### 2.7.9 边界（本次明确不做，逐条给理由）

| 不做 | 理由 |
| --- | --- |
| 不给 `src/api` 加 `api.theme.getTokens()` | 子窗口里**没有** `api` 对象，加了也解决不了 `url` 型卡片；主窗口侧扩展目前也不需要 token 值。真要做需另开 ADR |
| 不给 `srcdoc` 卡片推送消息 | `srcdoc` 的 token 已拼进同一份文档（C3），保留重渲染路径即可；两套机制同时生效只会带来"谁覆盖谁"的歧义 |
| 不在 `app://` 协议层注入 `<style>`（治本方案） | 要在主进程解析/改写 HTML，还要处理缓存、编码与 dev/packaged 两种父文档场景，成本高于收益；作为 ADR-0022 的**退场条件**之一保留 |
| 不校验 `event.origin`，改校验 `event.source` | `app://` 的 origin 字符串在各平台/版本上的规范化不确定；`event.source === contentWindow`（宿主侧）与 `event.source === parent`（扩展侧）是更稳的**同一性**判据 |
| 不下发宿主 token 白名单之外的变量 | 宿主只发 `HOST_THEME_TOKEN_NAMES`；扩展需要自己的布局变量（如 `--radius`）就自己定义，否则白名单/门禁会失真 |
| 不把主题塞进 `obox-extension-reply` | 复用 reply 会让"请求-响应"语义被污染（主题是通知），且 reply 需要 `requestId`，纯属额外状态 |


---

## 3. R-D2：新建/编辑选项错乱

### 3.1 复现测试（先写，先红后修）

测试文件 **`extensions/rdp/test/formState.test.js`**（`node --test`，与现有 7 个测试同目录同风格：纯 ESM、零新增运行期依赖）。

**为什么不能直接挂载 `ConnectionModal.vue`**：扩展没有 `@vue/test-utils`，且 `package.json` 只声明 `vue` 为依赖（`extensions/rdp/package.json:15-25`）。但已实测 **`vue` / `vue/server-renderer` / `@vue/compiler-sfc` 均可 `import`**（Node v24.14.0），故用例 (c) 用 `@vue/compiler-sfc` 编译 SFC + `renderToString` 做**真实渲染断言**，无需新增依赖。

| 用例 | 名称 | 断言（要点） | 预期 |
| --- | --- | --- | --- |
| **R-D2-1** | `编辑 A 保存后再编辑 B，B 不应残留 A 的值` | 对 `rowToForm(rowA)` → `buildSavePayload` → `rowToForm(rowB)` 全链断言：`name/host/port/username/domain/resolution/audioMode/keyboardHook/authenticationLevel/gatewayHostname` 均等于 rowB 的值；且**每个** `ALL_FIELDS` 的 key 都在 `rowToForm(rowB)` 里等于"rowB 有值取 rowB，无值取 `defaultForm()`" | 若根因在纯逻辑，则 **红**；若纯逻辑正确则 **绿**（见 §3.2 的分支判定） |
| **R-D2-2** | `新建 → 保存 → 再新建，第二次表单须回到默认值` | `defaultForm()` → 改若干值 → `buildSavePayload` → 再次 `defaultForm()`，断言第二次等于首份默认快照（逐 key 深比较，`pair` 拆成 `desktopWidth/desktopHeight`） | 同上 |
| **R-D2-3** | `字段被 showIf 隐藏再出现，不得携带旧值 / 不得影响相邻字段` | 构造"填 `gatewayHostname` → 改 `gatewayUsageMethod` → 清空 `gatewayHostname`"序列，断言隐藏后的 `buildSavePayload` **不再**带上被隐藏字段的旧值（或按 §3.3 决策显式定义语义）；再断言 `fullscreen` 开→关后 `desktopWidth/desktopHeight/smartSizing/dynamicResolution` 重新可见时**元素与值都正确** | 这一条最可能直接 **红**（见 §3.2 嫌疑 2） |
| **R-D2-4**（渲染层） | `visibleFields 过滤变化后，重新出现的复选框不得沿用上一次的 DOM 状态` | 用 `@vue/compiler-sfc` 编译一个最小 SFC（`v-for` + `showIf` 过滤 + `:key`，复刻 `ConnectionModal.vue:122-130` 的结构），`renderToString` 两次：第一次 `fullscreen=false`（4 项），第二次 `fullscreen=true`（2 项，且勾选态不同），断言第二次 HTML 中不再出现被隐藏项、且可见项的 `checked` 为**假** | 若根因在渲染复用，则 **红** |
| **R-D2-5**（守卫） | `VISIBILITY 规则不得泄漏到其他字段` | 断言 `ALL_FIELDS` 中**每个**带 `showIf` 的字段都在 `VISIBILITY` 里有对应 key，且未带规则的字段 `showIf === undefined` | 恒绿（防回归，钉死 §3.4 的挂载方式） |

**先红后绿的留证方式**：
1. 在**未改任何源码**时跑 `cd extensions/rdp && npm test`，把失败用例名与输出存为 `tmp/rdp-d2-before.txt`；
2. 按 §3.3 修复后重跑，把输出存为 `tmp/rdp-d2-after.txt`；
3. 两份输出一并作为验收 3 的证据（归档时写进 ADR 的"证据"一节）。

**如果全部用例初次即全绿**：说明 R-D2 的根因**不在纯逻辑层**，此时按 §3.2 的分支 B 推进（渲染层/父级），并把该结论写进 ADR——**不得**为了"凑一个红灯"而改断言或改测试。

### 3.2 判定实验设计（不先断言根因）

spec §1.2 给了两个嫌疑，本设计**把二者落成可判定的实验分支**，而不是先下结论：

| 分支 | 嫌疑 | 判定实验 | 观察 |
| --- | --- | --- | --- |
| **A. 组件生命周期/状态重建** | `ConnectionModal.vue:23` 的 `const form = reactive(rowToForm(props.row))` 只在 `setup` 求值一次 | ① 静态读 `App.vue` 的挂载条件；② 若 R-D2-1/2 全绿 → A 在**当前用法**下不成立，属**潜在**缺陷 | 已核实：`App.vue:140` **确实**把 `modalOpen` 置 `false`（`closeModal`），`:331` 是 `v-if="modalOpen"` → **每次关闭都会卸载组件**，下次打开是**新实例**、`setup` 重新跑。因此 A **不足以**解释用户看到的现象（但仍是"改 props 不重建 form"的隐患，见 §3.3 修法 1） |
| **B. 可见性过滤 + `v-for` key** | `ConnectionModal.vue:33-37` 的 `visibleFields(group)`（调用点 `:123` 常用区、`:150` 高级区）与 `:key="field.key"` 的组合 | R-D2-3 与 R-D2-4 | 若 R-D2-3 或 R-D2-4 **红** → 根因在 B（过滤变化时的状态/渲染复用）；若二者皆绿 → B 也不成立，转分支 C |
| **C. 其他（穷举定位）** | `VISIBILITY`（`fields.js:553-579`）与 `buildSavePayload`（`:614-636`）的交互 | 加一组"属性测试"：对 `fuzz` 出的表单随机翻转 `fullscreen/multimon/gatewayHostname/remoteApplicationMode/enableRdsAadAuth`，断言 `buildSavePayload` 的输出**只**由当前表单值决定，与历史序列**无关**（同一份表单值、不同到达路径 → 输出必须逐字节相同） | 这是**最强的判定器**：若同一表单值经不同路径得到不同 payload，则根因在"历史残留"，`VISIBILITY` 是主嫌 |

**已核实的高风险点（作为 C 的具体线索，不是结论）**：
- `VISIBILITY` 表是**模块级副作用挂载**（`fields.js:581-586`：遍历 `ALL_FIELDS`，把规则写到字段对象的 `showIf` 上）。字段对象是**模块级单例**（`COMMON_GROUPS`/`ADVANCED_GROUPS`），规则一旦挂上就**全局共享**；而 `visibleFields` 在**渲染时**用**当前** `form` 求值（`ConnectionModal.vue:33-37`）。字段对象被"就地改写"意味着任何按 key 复用字段对象的地方都会受影响——这正是"选项错乱"最容易出现的机制。
- `buildSavePayload`（`:617-628`）**遍历 `ALL_FIELDS`，完全不看 `showIf`**：被隐藏字段的值**照样提交**。于是"隐藏 → 保存 → 重新打开"会把**用户看不见的值**写进库。这是与 `VISIBILITY` 直接相关的行为缺陷，必须在 §3.3 明确语义（本次选"隐藏即不提交"，见修法 2）。
- `singlemonInWindowedMode` 的规则是 `() => false`（`:560`），即**永远隐藏**——字段仍在 `ALL_FIELDS` 里被 `buildSavePayload` 提交（`def: false` → 提交 `0`）。属于"永远不可达但参与提交"，一并按修法 2 处理。

### 3.3 修法（按根因分支取用，均不采用"强制销毁重建"）

| 修法 | 适用分支 | 内容 | 为什么不是"掩盖根因" |
| --- | --- | --- | --- |
| **1. 把 props → form 的同步显式化** | A（以及无论根因如何都应做） | 在 `ConnectionModal.vue` 用 `watch(() => props.row, (row) => Object.assign(form, rowToForm(row)), { immediate: true })` **替换** `const form = reactive(rowToForm(props.row))` 的一次性求值；`form` 先以 `reactive(defaultForm())` 建空壳 | 修的是**状态来源**（props 是唯一真源），而不是"每次强制重挂"；`v-if` 仍在，但正确性不再依赖父级是否重建 |
| **2. 让"隐藏"在数据上真正生效** | B / C | ① 在 `fields.js` 导出 `visibleFieldKeys(form)`（把 `ConnectionModal.vue:33-37` 的过滤逻辑上移为**纯函数**，组件改调它，保证"UI 显示"与"提交范围"同源）；② `buildSavePayload(form)` 遍历时**跳过 `showIf(form) === false` 的字段**（用 `defaultForm()` 的默认值回填，而不是提交用户看不见的旧值） | 这是**语义修正**：让"看不见的选项"不再进库，从根上消除"选项错乱"的数据来源。可单测、可穷举 |
| **3. 消除模块级副作用挂载** | C | 把 `fields.js:581-586` 的 `for (const field of ALL_FIELDS) { … field.showIf = rule }` 改为**不改字段对象**：在 `ALL_FIELDS` 生成时用 `{ ...field, showIf }` 构造新对象（或让 `visibleFieldKeys` 在求值时合并 `field.showIf ?? VISIBILITY[key]`） | 去掉隐式全局可变状态；`VISIBILITY` 保持纯数据表，`fields.js` 仍是纯模块（R-D2-5 守卫用例钉死此性质） |
| **4.（仅当 1–3 都不足以解释时）显式重挂模态框** | 兜底 | 给 `App.vue:330-339` 的 `<ConnectionModal>` 加 `:key`（用 `modalMode + (modalRow?.id ?? 'new')`），强制每行/每模式一个实例 | spec R-D2 明确**不允许**用"每次强制销毁重建"掩盖根因，除非设计文档论证必要。**本设计不推荐**；若最终采用，必须在 ADR 写清"1–3 已排除"的证据 |

**本次默认执行顺序**：修法 1（无论根因都做，成本极低且消除隐患）→ 修法 3（去掉全局可变状态）→ 修法 2（让隐藏生效，这是行为语义变更，最需要真机确认）→ 用 §3.1 的 5 个用例验收。**修法 4 默认不做。**

**倾向与理由（一句话）**：我**倾向根因在"可见性过滤 + `buildSavePayload` 无视 `showIf`"这一侧（分支 B/C），而不是"form 只求值一次"**，因为已核实 `App.vue:140` 会把 `modalOpen=false`、`:331` 是 `v-if`，模态框每次关闭都被卸载，`setup` 会重跑，`rowToForm` 每次都重新执行——所以单实例残留解释不了现象，而 `VISIBILITY` 的模块级就地挂载 + 提交范围无视可见性，恰好能造成"选中/提交的选项与屏幕上看到的不一致"。

### 3.4 `VISIBILITY` 的处置（明确结论）

| 项 | 结论 |
| --- | --- |
| 保留吗 | **保留**。它在上一轮解决了真机踩过的冲突（`screen mode id` 缺省全屏、`use multimon` 跨屏全屏等，`fields.js:526-542` 有依据记录），删掉会退化 |
| 改什么 | ① 求值入口从"组件内联过滤"上移为 `fields.js` 的纯函数；② 去掉对字段对象的**就地挂载**（改为构造期派生或求值时合并）；③ 让它同时约束 **UI 显示** 与 **提交范围**，两者同源 |
| 不改什么 | 规则本身（谓词内容）**本次不改**——除非 §3.1 的用例红在某条规则上，此时只改那一条并在 ADR 记录依据 |

---

## 4. R-D3：表单结构与样式

### 4.1 目标结构（每项独占一行 + 灰色说明 + 高级仍分组折叠）

```
form-group（分组标题 h3）
└─ .form-rows                        ← 单列纵向，gap 12px（取代 .form-grid 的两列栅格）
   └─ .field                         ← 每个字段一项，独占一行（block，宽度 100%）
      ├─ .field__row                 ← 一行内放"标签 + 控件"（成对字段在同一 .field__row 内）
      │  ├─ .field__label            ← 标签（--fg-dim / --font-size-sm）
      │  ├─ .field__control          ← 控件区（flex:1 1 auto; min-width:0）
      │  │  ├─ input.input / select.select / radio-group / .check / .pair
      │  │  └─ .badge--warn          ← 「未官方确认」角标
      │  └─ .field__required         ← 必填 *
      ├─ .field__desc                ← 【新增】灰色说明行（--fg-dim / --font-size-sm）★每项都有
      └─ .field__error               ← 校验红字（--fg-error / --font-size-sm）★仅出错时
```

**关键点**：
- `.field` 是 **100% 宽、独占一行**：`.form-rows { display:flex; flex-direction:column; gap:12px }`，`.field { width:100% }`。**删除** `.form-grid`（`styles.css:490-494`）与 `.field--full`（`:503-505`）的栅格语义。
- **成对字段**（`resolution` → `desktopWidth`/`desktopHeight`）：仍是**一个** `.field`（独占一行），其 `.field__control` 内是 `.pair`（两个数字输入 + `×` 分隔），**不**拆成两行。
- **勾选框**（`type: 'check'`，共 34 个）：`.field__row` 内是 `.check`（方框 + 标签同行），`.field__desc` **在其下方另起一行**——即"标签与方框同行、说明在整项下方"，不破坏"每项独占一行"。
- **说明行统一为 `.field__desc`**：数据来自 `field.desc`（§5）。现有 `field.hint`（仅 `selectedMonitors`、`gatewayCredentialsSource` 两个字段有）**并入 `.field__desc` 同一行渲染**（`hint` 优先，否则 `desc`），避免一个字段两行灰字。`.field__hint` 类名保留为别名以兼容，但样式与 `.field__desc` 合并。
- **校验红字与说明不互相遮挡**：`.field__error` 排在 `.field__desc` **之后**（更靠近模态框底部方向），两者都是独立行、各自 `margin:0`，不会重叠；红字出现时说明仍在（属于"说明 + 报错"叠加，用户能同时看到"这项是什么"和"哪里错了"）。
- **高级项仍分组折叠**：`.accordion`（`styles.css:623-651`）与其 `.accordion__toggle` / `.accordion__body` 结构**不变**，只是组内从 `.form-grid` 换成 `.form-rows`。默认折叠（`advancedOpen = false`，`ConnectionModal.vue:27`）保持不变。

### 4.2 响应式

| 断点 | 行为 |
| --- | --- |
| 任意宽度 | `.form-rows` 恒为单列（本来就是纵向单列） |
| `max-width: 560px` | 原 `styles.css:671-674` 的 `.form-grid { grid-template-columns: 1fr }` 已无对象 → **删除**该媒体查询；单列在窄屏本来成立，无需兜底 |
| `max-width: 720px` | 沿用：`.app__grid` 单列（`:149-153`）、`.modal` 宽度 `calc(100% - 32px)`（`:466-474`） |

> 由于 R-D3 要求"不再使用多列栅格挤压布局"，**不**在宽屏下恢复两列（即使空间足够）。成对字段靠 `.pair` 在同一行内并排，不属于"多列栅格"。

### 4.3 样式（全部只吃 token）

| 选择器 | 属性 → token | 说明 |
| --- | --- | --- |
| `.form-rows` | `display:flex; flex-direction:column; gap:12px` | 纯布局 |
| `.field` | `display:flex; flex-direction:column; gap:4px; min-width:0; width:100%` | 纯布局 |
| `.field__row` | `display:flex; align-items:center; gap:8px` | 标签与控件同行（纯布局） |
| `.field__label` | `color: var(--fg-dim); font-size: var(--font-size-sm)` | 沿用 §2.4-#95/96 |
| `.field__control` | `flex:1 1 auto; min-width:0` | 纯布局 |
| `.field__desc` | `margin:0; color: var(--fg-dim); font-size: var(--font-size-sm); line-height:1.5` | **R-D3 的灰色说明行**；`line-height` 属布局 |
| `.field__error` | `margin:0; color: var(--fg-error); font-size: var(--font-size-sm)` | 沿用 §2.4-#100/101 |
| `.badge--warn` | `border: 1px solid var(--fg-warning); background: color-mix(in srgb, var(--fg-warning) 15%, transparent); color: var(--fg-warning); font-size: var(--font-size-sm)` | 沿用 §2.4-#104–107 |

**注意**：`.field__row` 用 `align-items:center` 时，若标签很长会挤压控件；因此约定 `.field__label { flex: 0 0 auto }`、`.field__control { flex: 1 1 auto; min-width: 0 }`，长标签折行由 `.form-rows` 的单列宽度兜住。

---

## 5. 字段说明文本清单（65 个字段）

### 5.1 来源优先级与「待确认」纪律

优先级：**①** `extensions/rdp/lib/rdpFile.mjs` 的字段表注释（`:48-329`，含 3 处真机实测结论）→ **②** `extensions/rdp/docs/spec/rdp-remote-desktop-design.md` §3.6 的 `.rdp` 字段表（`:142-200`，标注"源自微软官方文档"）→ **③** 微软官方文档（`learn.microsoft.com` 的 *Supported RDP properties with Remote Desktop Services* / *Remote Desktop Protocol (.rdp) settings*）。

**纪律（本次严格执行）**：本文件在编写时**无法访问网络**（本会话的检索工具不可用），因此**没有任何一条说明是本次从官方文档新确证的**。凡来源 ①/② 未明确给出语义的字段，一律标 **「待确认」**，并集中列在 §5.3。**不编造语义**。

因此 §5.2 的"来源"列**只写 ① 或 ②**（可核对的仓内来源）；标「待确认」的行在开工前必须由**具备网络访问**的执行者按来源 ③ 补齐（§5.3 给了逐条核对的锚点）。

### 5.2 逐字段说明（按 `fields.js` 的分组与顺序）

**常用区（19 个）**

| # | key | 标签 | 建议中文说明（一句话） | 来源 |
| --- | --- | --- | --- | --- |
| 1 | `name` | 连接名 | 只在本扩展的列表里标识这条连接，会写进卡片副行，不进入 `.rdp` 文件。 | ②§3.6（`name` 非 `.rdp` 键，属扩展自有） |
| 2 | `host` | 主机 | 目标机器的地址或名称，对应 `.rdp` 的 `full address`；端口为 3389 时只写主机。 | ①`rdpFile.mjs:345-349`；②§3.6 |
| 3 | `port` | 端口 | 目标 RDP 端口，默认 3389；非 3389 时地址写成 `主机:端口`，并额外保存一条带端口的凭据。 | ①`rdpFile.mjs:341-349`、`lib/cmdkeyArgs.mjs`（两条目标串策略） |
| 4 | `username` | 用户名 | 登录目标机器的账号，对应 `.rdp` 的 `username`；开启 Entra ID 认证时会被忽略。 | ②§3.6；`fields.js:575`（Entra 互斥） |
| 5 | `domain` | 域 | 账号所属域或计算机名，对应 `.rdp` 的 `domain`，用于 `域\用户` 形式登录。 | ②§3.6；①`rdpFile.mjs:50` |
| 6 | `password` | 密码 | 只交给本机凭据管理器（`cmdkey`）保存，**不写进 `.rdp`、不入库**。 | ①`rdpFile.mjs:6-7`（`password 51:b:` 绝不写）；②§3.6 |
| 7 | `remember` | 记住密码 | 勾选后保存连接时一并把密码写入本机凭据，取消则保存前删除旧凭据。 | ②§3.9.2（密码与记住语义） |
| 8 | `fullscreen` | 全屏启动 | 是否全屏启动；勾选写 `screen mode id:i:2`，不勾写 `i:1`（不写该键时 mstsc 默认全屏）。 | ①`rdpFile.mjs:74-86`（真机实测） |
| 9 | `multimon` | 多显示器 | 是否在所有显示器上铺开远程桌面；**只在全屏时显示**，因它会让 mstsc 忽略窗口模式。 | ①`rdpFile.mjs:87-98`；`fields.js:82-91` |
| 10 | `resolution` | 分辨率 | 窗口模式下的桌面宽×高（像素），对应 `desktopwidth` / `desktopheight`；全屏时隐藏。 | ②§3.6；`fields.js:554-555` |
| 11 | `smartSizing` | 智能缩放 | 窗口尺寸变化时把远程画面整体缩放到窗口内（等比），不改变远程分辨率；全屏时隐藏。 | ②§3.6；`fields.js:556` |
| 12 | `dynamicResolution` | 动态分辨率 | 窗口尺寸变化时**改变远程桌面的分辨率**去适应窗口，画面更清晰但会重排远程桌面；全屏时隐藏。 | ②§3.6；`fields.js:557` |
| 13 | `clipboard` | 剪贴板 | 允许在本机与远程之间复制粘贴文本和文件（`redirectclipboard`）。 | ②§3.6；①`rdpFile.mjs:133` |
| 14 | `audioMode` | 音频 | 远程声音在哪播放：本机 / 远程 / 不播放（`audiomode` 取 0/1/2）。 | ②§3.6；`fields.js:11-15` |
| 15 | `keyboardHook` | 键盘钩子 | Windows 键（如 Win、Alt+Tab）交给本机还是远程、以及是否只在全屏时交给远程（`keyboardhook` 取 0/1/2/3）。 | ②§3.6；`fields.js:17-23` |
| 16 | `authenticationLevel` | 认证级别 | 服务器身份验证失败时怎么办：不验证 / 拒绝连接 / 警告后继续（`authentication level` 取 0/1/2/3）。 | ②§3.6；`fields.js:25-31` |
| 17 | `nla` | NLA（网络级认证） | 连接前先完成凭据认证（Network Level Authentication），可减少中间人风险（`enablecredsspsupport`）。 | ②§3.6；①`rdpFile.mjs:59` |
| 18 | `adminSession` | 管理会话 | 以管理会话方式登录（等价 `mstsc /admin`），用于排障；RemoteApp 模式下互斥隐藏。 | ②§3.6；`fields.js:573` |
| 19 | `autoReconnect` | 自动重连 | 网络闪断后自动尝试重新连上原会话（`autoreconnection enabled`）。 | ②§3.6；①`rdpFile.mjs:67-73` |

**高级区 · 显示（4 个）**

| # | key | 标签 | 建议中文说明 | 来源 |
| --- | --- | --- | --- | --- |
| 20 | `sessionBpp` | 色深 | 远程画面的颜色位数，位数越高颜色越准、占用带宽越大（`session bpp` 取 8/16/24/32）。 | ②§3.6；`fields.js:42-48` |
| 21 | `selectedMonitors` | 指定显示器 | 只在选定显示器上全屏，值填 `mstsc /l` 列出的显示器 ID、多个用逗号分隔；留空表示全部；需先开全屏 + 多显示器。 | ②§3.6；`fields.js:189`、`:558` |
| 22 | `maximizeToCurrentDisplays` | 全屏时占满当前显示器 | 全屏时把窗口铺满当前所在的显示器，而不是跨全部显示器；需先开全屏 + 多显示器。 | ②§3.6；`fields.js:559` |
| 23 | `singleMonInWindowedMode` | 窗口模式单显 | **待确认**（本扩展已判定"多显必须全屏"，该组合不可达 → 该字段永远隐藏，见 `fields.js:560`）。 | **待确认** |

**高级区 · 本地资源（10 个）**

| # | key | 标签 | 建议中文说明 | 来源 |
| --- | --- | --- | --- | --- |
| 24 | `audioCaptureMode` | 麦克风重定向 | 把本机麦克风带到远程会话里，供远程程序录音（`audiocapturemode`）。 | ②§3.6 |
| 25 | `redirectPrinters` | 打印机 | 让远程会话能使用本机打印机（`redirectprinters`）。 | ②§3.6 |
| 26 | `redirectComPorts` | COM 口 | 把本机串口映射进远程会话（`redirectcomports`）。 | ②§3.6 |
| 27 | `redirectSmartCards` | 智能卡 | 让远程会话能读取插在本机的智能卡（`redirectsmartcards`）。 | ②§3.6 |
| 28 | `redirectLocation` | 位置 | 把本机的位置信息提供给远程会话（`redirectlocation`）。 | ②§3.6 |
| 29 | `redirectWebAuthn` | WebAuthn | 让远程会话里能用本机的 Windows Hello 等 WebAuthn 凭据（`redirectwebauthn`）。 | ②§3.6 |
| 30 | `driveStoreDirect` | 驱动器 | 把本机磁盘映射进远程会话；写 `*` 表示全部驱动器、`DynamicDrives` 表示连接时插上的、也可写 `C:\;E:\;` 列具体盘符。 | ②§3.6；`fields.js:258` |
| 31 | `usbDeviceStoreDirect` | USB 重定向 | 把本机 USB 设备重定向到远程会话，取值写法遵循微软的设备重定向语法。 | ②§3.6；**取值语法待确认** |
| 32 | `deviceStoreDirect` | MTP/PTP 设备 | 重定向便携设备（相机、手机等 MTP/PTP 设备），默认 `*` 表示全部。 | ②§3.6；①`rdpFile.mjs:171-177` |
| 33 | `cameraStoreDirect` | 摄像头 | 把本机摄像头重定向到远程会话，取值遵循设备重定向语法。 | ②§3.6；**取值语法待确认** |

**高级区 · 体验（12 个）**

| # | key | 标签 | 建议中文说明 | 来源 |
| --- | --- | --- | --- | --- |
| 34 | `networkAutoDetect` | 网络自动检测 | 自动探测网络质量并据此调整体验（`networkautodetect`）。 | ②§3.6 |
| 35 | `bandwidthAutoDetect` | 带宽自动检测 | 自动探测可用带宽并调整传输量（`bandwidthautodetect`）。 | ②§3.6 |
| 36 | `compression` | 批量压缩 | 压缩传输的数据以减少带宽占用，弱网下更明显（`compression`）。 | ②§3.6 |
| 37 | `videoPlaybackMode` | 多媒体流 | 优化视频等多媒体内容的播放（`videoplaybackmode`）。 | ②§3.6 |
| 38 | `bitmapCachePersistEnable` | 位图缓存持久化 | 把位图缓存留在磁盘上，下次连接复用，加快重绘（`bitmapcachepersistenable`）。 | ②§3.6 |
| 39 | `allowFontSmoothing` | 字体平滑 | 在远程桌面上启用 ClearType 字体平滑（`allow font smoothing`）。 | ②§3.6 |
| 40 | `allowDesktopComposition` | 桌面合成 | 允许远程会话的桌面合成效果（透明、阴影等），更美观但更耗带宽（`allow desktop composition`）。 | ②§3.6 |
| 41 | `disableWallpaper` | 禁用壁纸 | 远程会话不显示桌面壁纸，省带宽（`disable wallpaper`）。 | ②§3.6 |
| 42 | `disableFullWindowDrag` | 禁用全窗口拖动 | 拖动窗口时只显示窗口轮廓而不是完整内容，省带宽（`disable full window drag`）。 | ②§3.6 |
| 43 | `disableMenuAnims` | 禁用菜单动画 | 关闭菜单淡入淡出等动画，省带宽（`disable menu anims`）。 | ②§3.6 |
| 44 | `disableThemes` | 禁用主题 | 远程会话不使用视觉主题，省带宽（`disable themes`）。 | ②§3.6 |
| 45 | `disableCursorSetting` | 禁用光标设置 | 不应用远程桌面的鼠标指针方案（`disable cursor setting`）。 | ②§3.6 |

**高级区 · 安全与网关（8 个）**

| # | key | 标签 | 建议中文说明 | 来源 |
| --- | --- | --- | --- | --- |
| 46 | `promptForCredentials` | 强制弹出凭据框 | 连接时总是弹出 Windows 凭据输入框，即使已保存密码（`prompt for credentials`）。 | ②§3.6；①`rdpFile.mjs:51-57` |
| 47 | `gatewayHostname` | 网关地址 | 经由 RD 网关连接时填网关主机名；**填了它，下面三项网关设置才会出现**。 | ②§3.6；`fields.js:561-563` |
| 48 | `gatewayUsageMethod` | 网关用法 | 何时使用网关：不使用 / 始终 / 自动检测 / 用默认设置 / 本地地址绕过（`gatewayusagemethod` 取 0–4）。 | ②§3.6；`fields.js:33-40` |
| 49 | `gatewayCredentialsSource` | 网关凭据来源 | **待确认**（官方文档未给出取值枚举；本扩展标「未官方确认」、留空则不写该键，按字符串直通）。 | **待确认**（①`rdpFile.mjs:254-260` 只记录了"官方未确认"，无枚举） |
| 50 | `promptCredentialOnce` | 网关与主机共用凭据 | 只用一套凭据同时通过网关和主机认证，避免重复输入（`promptcredentialonce`）。 | ②§3.6；`fields.js:541` |
| 51 | `negotiateSecurityLayer` | 协商安全层 | 与服务器协商使用哪一层安全协议（`negotiate security layer`）。 | ②§3.6 |
| 52 | `disableConnectionSharing` | 不复用已断会话 | 不复用断线留下的已有会话，而是新建一个（`disableconnectionsharing`）。 | ②§3.6 |
| 53 | `enableRdsAadAuth` | Entra ID 认证 | 用 Microsoft Entra ID 登录远程主机；**开启后用户名/域/密码会被忽略**（本扩展自动隐藏这四项）。 | ②§3.6；`fields.js:574-578` |

**高级区 · RemoteApp（12 个）**

| # | key | 标签 | 建议中文说明 | 来源 |
| --- | --- | --- | --- | --- |
| 54 | `alternateShell` | 替代 shell | 登录后启动的程序，代替默认的桌面 shell（`alternate shell`）。 | ②§3.6 |
| 55 | `shellWorkingDirectory` | 工作目录 | 上面那个替代 shell 的工作目录（`shell working directory`）。 | ②§3.6 |
| 56 | `remoteApplicationMode` | RemoteApp 模式 | 打开后按 RemoteApp 方式发布单个程序，而不是整个桌面；打开后下列各项才出现，且「管理会话」自动隐藏。 | ②§3.6；`fields.js:564-573` |
| 57 | `remoteApplicationProgram` | 程序 | 要发布的远程程序路径或别名（`remoteapplicationprogram`）。 | ②§3.6 |
| 58 | `remoteApplicationName` | 名称 | 程序在客户端显示的名字（`remoteapplicationname`）。 | ②§3.6 |
| 59 | `remoteApplicationCmdLine` | 命令行 | 传给远程程序的命令行参数（`remoteapplicationcmdline`）。 | ②§3.6 |
| 60 | `remoteApplicationFile` | 文件 | 要由远程程序打开的文件（`remoteapplicationfile`）。 | ②§3.6 |
| 61 | `remoteApplicationIcon` | 图标 | 客户端为该程序显示的图标路径（`remoteapplicationicon`）。 | ②§3.6 |
| 62 | `remoteApplicationGuid` | GUID | 该 RemoteApp 的唯一标识，便于客户端区分同名程序（`remoteapplicationguid`）。 | ②§3.6 |
| 63 | `remoteApplicationExpandCmdLine` | 展开命令行变量 | 是否把命令行里的环境变量在**客户端**展开后再发（`remoteapplicationexpandcmdline`）。 | ②§3.6 |
| 64 | `remoteApplicationExpandWorkingDir` | 展开工作目录变量 | 是否把工作目录里的环境变量在**客户端**展开（`remoteapplicationexpandworkingdir`）。 | ②§3.6 |
| 65 | `loadBalanceInfo` | 负载均衡 Cookie | 交给负载均衡器用来把连接导向正确会话的 Cookie（`loadbalanceinfo`）。 | ②§3.6 |

> **计数（以代码为准，已实测）**：`ALL_FIELDS.length === 65`。逐组：常用 **19**（连接 7 + 显示 5 + 本地资源 3 + 安全 4）＋ 高级 **46**（显示 4 + 本地资源 10 + 体验 12 + 安全与网关 8 + RemoteApp 12）＝ **65**。
>
> 本表 **#1–#65 共 65 行**，按 `fields.js` 的分组与书写顺序与 `ALL_FIELDS` 逐条对齐，**一条不漏、无占位**。
>
> 对照：`lib/rdpFile.mjs` 的 `RDP_FIELDS` 为 **61** 条 `.rdp` 键；差额 4 条是**只存在于界面/数据库、不进 `.rdp` 的字段**：`name`、`port`、`password`、`remember`。两处数字不同是正常的，不是遗漏。

### 5.3 「待确认」字段清单（开工前必须按来源 ③ 补齐）

| key | 标签 | 为什么待确认 | 需从官方文档核对什么 |
| --- | --- | --- | --- |
| `singleMonInWindowedMode` | 窗口模式单显 | ②§3.6 只写"窗口模式单显"，未给语义细节；且本扩展已判定该组合不可达（永远隐藏） | `singlemoninwindowedmode` 的确切语义与取值，以及它与 `use multimon` / `screen mode id` 的关系 |
| `gatewayCredentialsSource` | 网关凭据来源 | ①`rdpFile.mjs:254-260` 明确记录"官方未确认取值"；②§3.6 同样标 `[未确认]` | `gatewaycredentialssource` 是否存在官方取值枚举（0/1/2/3/4 分别是什么）；若官方无枚举，保持"留空不写"并在 UI 保留角标 |
| `usbDeviceStoreDirect` | USB 重定向 | ②§3.6 只写"USB 重定向"，未给取值语法 | `usbdevicestoredirect` 的取值语法（是否与 `devicestoredirect` 的 `*` / 设备 ID 语法一致） |
| `cameraStoreDirect` | 摄像头 | ②§3.6 只写"摄像头"，未给取值语法 | `camerastoredirect` 的取值语法（`*` / 具体设备 ID / 是否有 `DynamicDevices` 之类关键字） |

**共 4 个字段标「待确认」**，key 为：`singleMonInWindowedMode`、`gatewayCredentialsSource`、`usbDeviceStoreDirect`、`cameraStoreDirect`。

> 这 4 个字段的 `.field__desc` **不得**为了让测试通过而写编造文本；在补齐前，其 `desc` 就用"待确认：见 docs/spec 的设计文档 §5.3"这类**显式占位**，并由 §7 的覆盖率断言把"desc 非空"与"desc 已确证"**分开**统计（前者必须 100%，后者允许存在待确认计数）。

---

## 6. 取值说明对照表（select / radio 的每个取值）

### 6.1 覆盖清单（**20** 个取值、**5** 个字段）

> **计数（以代码为准，已实测）**：`ALL_FIELDS` 中带 `options` 的字段共 **5** 个，取值合计 `3+4+4+4+5 = 20`：`audioMode` 3、`keyboardHook` 4、`authenticationLevel` 4、`sessionBpp` 4、`gatewayUsageMethod` 5。下表 **#1–#20 共 20 行**，一条不漏。

| # | 字段 key | 标签 | 控件 | 取值 | 现有 label（`fields.js`） | 建议中文说明（一句话） | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `audioMode` | 音频 | radio | `0` | 本地播放 | 远程会话的声音在本机扬声器播放（默认）。 | ②§3.6（"0 本地/1 远程/2 无"）；`fields.js:11-15` |
| 2 | `audioMode` | 音频 | radio | `1` | 远程播放 | 声音留在远程主机上播放，本机听不到（远程机器需有声卡）。 | ②§3.6 |
| 3 | `audioMode` | 音频 | radio | `2` | 不播放 | 完全不传输声音，省带宽。 | ②§3.6 |
| 4 | `keyboardHook` | 键盘钩子 | select | `0` | 本机（Win 键不交给远程） | 所有 Windows 组合键（含 Win 键）都由本机处理，不送进远程会话。 | ②§3.6（"Win 键归属 0/1/2/3"）；`fields.js:17-23` |
| 5 | `keyboardHook` | 键盘钩子 | select | `1` | 远程 | 窗口模式与全屏下都把 Windows 组合键送给远程会话。 | ②§3.6 |
| 6 | `keyboardHook` | 键盘钩子 | select | `2` | 仅全屏时交给远程 | 只有全屏时才把 Windows 组合键送给远程，窗口模式下留给本机（默认）。 | ②§3.6；①`rdpFile.mjs:179`（默认 2） |
| 7 | `keyboardHook` | 键盘钩子 | select | `3` | 始终交给远程 | 无论窗口还是全屏都交给远程（等同取值 1 的语义，但按"始终"表述）。 | **待确认**（0/1/2/3 中 1 与 3 的差别官方表述需核对） |
| 8 | `authenticationLevel` | 认证级别 | select | `0` | 不验证，直接连接 | 不校验远程主机身份，直接连接（最不安全，仅信任网络内可用）。 | ②§3.6（默认 2）；`fields.js:25-31` |
| 9 | `authenticationLevel` | 认证级别 | select | `1` | 验证失败则不连接 | 无法验证远程主机身份时**拒绝连接**（最严格）。 | ②§3.6 |
| 10 | `authenticationLevel` | 认证级别 | select | `2` | 验证失败时警告（默认） | 无法验证身份时给出警告，由用户决定是否继续（默认）。 | ②§3.6 |
| 11 | `authenticationLevel` | 认证级别 | select | `3` | 不要求验证 | 不要求服务器提供身份验证，连接继续。 | ②§3.6 |
| 12 | `gatewayUsageMethod` | 网关用法 | select | `0` | 不使用网关 | 完全不经过 RD 网关，直连目标主机。 | ②§3.6（"0 不用/1 始终/2 检测/3 默认/4 本地绕过"） |
| 13 | `gatewayUsageMethod` | 网关用法 | select | `1` | 始终使用 | 所有连接都经网关转发（含内网地址）。 | ②§3.6 |
| 14 | `gatewayUsageMethod` | 网关用法 | select | `2` | 自动检测 | 由客户端探测目标是否可达，决定是否经网关。 | ②§3.6 |
| 15 | `gatewayUsageMethod` | 网关用法 | select | `3` | 使用默认设置 | 沿用系统/客户端的网关默认设置（本扩展默认）。 | ②§3.6；`fields.js:370`（def 3） |
| 16 | `gatewayUsageMethod` | 网关用法 | select | `4` | 本地地址绕过网关 | 目标是本地/内网地址时绕过网关直连，其余仍走网关。 | ②§3.6 |
| 17 | `sessionBpp` | 色深 | select | `8` | 8 位 | 每像素 8 位，颜色最少、带宽最省，画面有明显色带。 | ②§3.6；`fields.js:42-48` |
| 18 | `sessionBpp` | 色深 | select | `16` | 16 位 | 每像素 16 位（高彩），颜色与带宽的折中。 | ②§3.6 |
| 19 | `sessionBpp` | 色深 | select | `24` | 24 位 | 每像素 24 位（真彩），颜色准确度更高、带宽更大。 | ②§3.6 |
| 20 | `sessionBpp` | 色深 | select | `32` | 32 位（默认） | 每像素 32 位（含 Alpha 通道），画质最好、带宽最大（默认）。 | ②§3.6；`fields.js:179`（def 32） |

**计数**：`audioMode` 3 + `keyboardHook` 4 + `authenticationLevel` 4 + `gatewayUsageMethod` 5 + `sessionBpp` 4 = **20 个取值**，分布在 **5 个 select/radio 字段**上（与 §6.1 的实测数字一致）。

**待确认取值 1 个**：`keyboardHook = 3`（"始终交给远程"与取值 `1`（"远程"）的官方差别表述，②处未展开；见 §6.4）。

### 6.2 呈现方式决策

**决策：采用「选中后下方说明」为主 + 「下拉项内不写长说明」；`radio` 与 `select` 的具体做法如下。**

| 控件 | 呈现方式 | 具体做法 |
| --- | --- | --- |
| `select`（`keyboardHook` / `authenticationLevel` / `gatewayUsageMethod` / `sessionBpp`） | **选项内保持短 label + 控件下方一行动态说明** | `<option>` 只放现有短 label（如"32 位（默认）"）；`.field__desc` 在第一行显示字段级说明（§5），**下面再一行**显示"当前选中取值"的说明（如"每像素 32 位…"）。改选后该行动态更新。 |
| `radio`（`audioMode`） | **每个选项右侧跟一句短说明** | `.radio-group` 每项渲染为 `<label><input> <span class="radio__label">本地播放</span><span class="radio__desc">声音在本机播放</span></label>`；4 个取值最多 3 项，纵向排列也不长。 |

**为什么不做「下拉项副标题」**：原生 `<select>` 的 `<option>` **不能可靠地渲染富文本或换行**（不同平台/Chromium 版本会截断或忽略额外元素），要塞副标题只能换成自绘 listbox——那会丢掉原生下拉的键盘可达性与 `role` 语义，还得自己实现 `ariacombobox`/`activedescendant`。**代价高于收益**。

**为什么不做「行内小字跟随每个 option」**（对 select）：原生 `<option>` 内同样放不下；而且 5 个取值 × 每个一句会把视觉噪音拉到与说明同一水平。

**优点（选中后下方说明）**：
- 用原生控件，键盘/读屏行为不变（无自定义 listbox）；
- 说明与"当前选择"强绑定，用户改选立刻看到解释，最贴合"我该选哪个"的疑问；
- 与 R-D3 的 `.field__desc` 灰色说明行**同一样式与同一区域**，视觉一致，不额外增加结构。

**缺点（须在真机确认）**：
- 需要**先选**才看到该取值的解释，用户要"逐个试"才能比较 → 缓解：`.field__desc` 第一行给字段级说明（如"Windows 键交给谁"），且**默认值**的说明一打开就可见；
- `radio` 的"每项一句"在窄屏下会换行变高 → 可接受（4 项 × 2 行 ≈ 8 行，远小于 65 个字段的说明总量）。

**实现要点**：`fields.js` 的每个 `options` 元素加 `desc` 字段（`{ value, label, desc }`）；`ConnectionField.vue` 对 `select` 渲染"选中值说明行"（`computed` 取 `field.options.find(o => o.value === form[field.key])?.desc`），对 `radio` 在每项 label 内渲染 `option.desc`。两者都用 `.field__desc` / `.radio__desc`，只吃 `--fg-dim` + `--font-size-sm`。

### 6.3 与 §5 的字段说明不重复

`field.desc`（§5，字段级）+ 选中值 `option.desc`（§6.1，取值级）是**两层**：前者回答"这项是干什么的"，后者回答"这个取值意味着什么"。若某字段的字段级说明与某个取值说明语义重叠（例如 `keyboardHook`），以 §5 为准收敛措辞，避免同一个 `.field` 下出现两句近义灰字。

### 6.4 取值层面的「待确认」清单

| 字段 key | 取值 | 现有 label | 为什么待确认 | 需从官方文档核对什么 |
| --- | --- | --- | --- | --- |
| `keyboardHook` | `3` | 始终交给远程 | ②§3.6 只把该键概括为"Win 键归属 0/1/2/3"，未给出 `1`（"远程"）与 `3`（"始终交给远程"）的差别表述；本扩展的这两个 label 目前近乎同义 | `keyboardhook` 各取值的官方定义，特别是 `1` / `2` / `3` 三者"窗口模式 vs 全屏"的差别；若官方确认 `1` 与 `3` 同义，须合并或改用更准确的 label |

**取值级待确认计 1 个**（`keyboardHook = 3`）。与 §5.3 的 4 个字段级待确认**分开统计**：`fieldDocs.test.js` 分别断言"字段 desc 非空 65/65"、"取值 desc 非空 20/20"，以及"待确认清单恰为 4 个字段 key + 1 个取值"。在补齐前，该取值的 `desc` 用显式占位文本（如"待确认：见设计文档 §6.4"），**不得**编造语义。

---

## 7. 测试计划（路径 A 定稿）

> §7.1–§7.3 是**扩展侧**（`extensions/rdp`，`node --test`）；**§7.4 是宿主侧**（仓库根 `test/**`，vitest）。

### 7.1 新增 / 修改的测试文件（扩展侧）

| 文件 | 新增/修改 | 用例名（`node --test` 的 `test()` 标题） |
| --- | --- | --- |
| `extensions/rdp/test/formState.test.js` | **新增** | `R-D2-1 编辑 A 保存后再编辑 B 不残留 A 的值`；`R-D2-2 新建→保存→再新建须回到默认值`；`R-D2-3 隐藏字段不得携带旧值/影响相邻字段`；`R-D2-4 visibleFields 过滤变化后重新可见的复选框不沿用旧 DOM 状态`；`R-D2-5 VISIBILITY 规则不泄漏到其他字段` |
| `extensions/rdp/test/stylesTokens.test.js` | **新增** | `styles.css 零自造色值`（§2.6 核查 1）；`styles.css 零自造字体族`（核查 2）；`styles.css 仅引用白名单 token`（核查 3）；`styles.css 保留圆角例外仅限 --radius/--radius-lg`；**`styles.css 消费的每个 token 都在 FALLBACK_TOKENS 内`**（解析 `var(--x)` 集合 ⊆ 兜底表键 ⇒ 推送未达也不空白）；**`FALLBACK_TOKENS 的键全部在宿主 token 白名单内`**（兜底表不得自造 token） |
| `extensions/rdp/test/themeBridge.test.js` | **新增** | `installThemeBridge 启动即写兜底 token（假 root 记录 setProperty）`；`收到 obox-theme 推送后 token 生效并覆盖兜底值`；`推送里的非法键名/空值/非字符串被丢弃且不抛错`；`收到推送后不再重发 obox-theme-request（请求最多 3 次）`；`3 次请求均无响应 → 保留兜底并打印一次 warn`；`来源不是 parent 的消息被忽略`；`colorSchemeForThemeId：含 light 的 id → light，其余 → dark`；`无 window 环境（node）下 installThemeBridge 安全空转不抛错` |
| `extensions/rdp/test/fieldDocs.test.js` | **新增** | `每个字段都有 desc 且非空`（覆盖率 65/65）；`每个 select/radio 的每个取值都有 desc`（覆盖率 20/20）；`待确认清单恰为 4 个字段 + 1 个取值`；`desc 不得含禁止词`（断言不含"等等/其余同上/TODO"） |
| `extensions/rdp/test/rdpFile.test.js` | 可能**修改** | 若 §3.3 修法 2 改了 `buildSavePayload` 的提交范围，需同步断言"隐藏字段不写进 `.rdp`"（受影响字段：`singleMonInWindowedMode` 等） |
| `extensions/rdp/test/connection.test.js` | 不动 | — |

### 7.2 命令（两侧都要跑）

```powershell
# 扩展侧（extensions/rdp，独立工程）
cd extensions/rdp
node --test                 # 或 npm test（package.json:11 → "node --test"）
npx prettier --check .       # 扩展内格式门禁
npm run build                # vite build → ui/（package.json:10；改了 src/** 必须重跑，否则调试加载的是旧 ui/）

# 宿主侧（obox 仓库根；路径 A 后为**必跑**，且是 PR 的 CI 门禁）
npm run typecheck            # typecheck:node + typecheck:web（vue-tsc 会查 AppWindow.vue 模板）
npm run lint                 # 0 error
npm test                     # vitest run
```

提交按 `docs/adr/0008`：宿主改动走**分支 + PR**（`feat/…`），CI `check` 通过后自行 squash 合并；`extensions/rdp` 是 gitignored 的独立工程，**无需 PR**。

### 7.3 三层验证对应关系

| 层 | 内容 |
| --- | --- |
| 纯逻辑单测（扩展） | R-D2 的 5 个用例、token 核查 6 个用例、主题桥 8 个用例、说明覆盖率 4 个用例 |
| 渲染层单测（扩展） | R-D2-4（`@vue/compiler-sfc` + `vue/server-renderer`，无需新增依赖） |
| 纯逻辑单测（宿主） | §7.4 的 `test/app-theme.test.ts`、`test/state.test.ts`、`test/app-window-wiring.test.ts` |
| 构建 + 真机 | 扩展 `npm run build`；宿主 `npm run dev`；§8 的 V1–V6 |

### 7.4 宿主侧测试（路径 A 定稿）

**环境事实**：`vitest.config.ts` 是 `environment: 'node'`、`include: ['test/**/*.test.ts']`、`globals: false`；仓库**没有** `@vue/test-utils` / `jsdom` 先例。因此宿主侧测试一律落在**纯函数 + 读源文件的接线门禁**上（先例：`test/state.test.ts` 直接 import `core/state`；`test/manifest-script-parity.test.ts` 用读文件做跨文件比对）。

| 文件 | 新增/修改 | 用例名 | 断言要点 |
| --- | --- | --- | --- |
| `test/app-theme.test.ts` | **新增** | `HOST_THEME_TOKEN_NAMES 与 main.css 的 :root 逐条一致` | 读 `src/renderer/src/assets/main.css`，解析 `:root { … }` 的自定义属性名，与 `HOST_THEME_TOKEN_NAMES` **集合与顺序**逐一相等（token 漂移即红） |
| 同上 | | `collectThemeTokens 按白名单逐个取值并跳过空值` | 传一个只会对部分名字返回值的假 `read`，断言只收非空项、键集合正确 |
| 同上 | | `buildThemeMessage 生成 {source,action,themeId,tokens}` | 逐字段断言——**这是"token 消息的构造"**这一验收点的落点 |
| 同上 | | `sanitizeThemeTokens 丢弃非法键名/非字符串/空串` | 输入 `{ '--bg':'#fff', 'bg':'x', '--x':1, '--y':'', '--z':null }` → 只留 `--bg` |
| 同上 | | `appFrameKey：url 型卡片与 themeId 无关（切主题不换 key）` | 同一 `{url}` + 两个不同 themeId → **同一个 key**（Vue 的 `:key` 不变即不重建元素 ⇒ **url 型卡片不重渲染**） |
| 同上 | | `appFrameKey：srcdoc 型卡片随 themeId 变化（切主题换 key）` | `{html}` + theme-dark / theme-light → 两个不同 key（**srcdoc 型仍重渲染**） |
| 同上 | | `appFrameKey：无 url 且无 html 时按 srcdoc 处理` | `undefined` / `{}` → `srcdoc:<themeId>` |
| 同上 | | `isThemePush / isThemeRequest 只认本协议形状` | 拒绝 `null`、字符串、`action` 不匹配、`source` 不是 `obox-app`、以及 `obox-extension` 这类串消息 |
| `test/state.test.ts` | **修改**（新增一个 `describe('stateStore · 跨窗口 storage 合并')`） | `parsePersistedState：null / 畸形 JSON → 全空结构（纯函数）` | 不抛错、四个字段都为空对象/空数组 |
| 同上 | | `applyExternal：合并另一窗口快照并按变更 key 通知` | 先本地 `theme=theme-dark`，`applyExternal` 一份 `theme=theme-light` 的完整快照 → `settings.theme` 变为 light，且监听者收到 key `'theme'` |
| 同上 | | `applyExternal：内容无变化时不通知` | 用与当前完全相同的快照调用 → 监听者**零**回调 |
| 同上 | | `applyExternal：只改非主题键时只通知该键` | 只改 `keybinding.x` → 回调 key 恰为该 key，`theme` 未被通知 |
| 同上 | | `applyExternal：畸形快照不破坏当前状态且不抛错` | `'{'` / `'null'` / `'[]'` → 当前值保持、无异常 |
| `test/app-window-wiring.test.ts` | **新增** | `AppWindow.vue 的 iframe 以 frameKey 作 key（不再是 themeKey）` | 读源文件断言模板含 `:key="frameKey"`、**不含** `:key="themeKey"` |
| 同上 | | `AppWindow.vue 在 iframe 的 load 上绑定主题下发` | 源文件含 `@load="pushThemeTokens"` 与 `ref="frameRef"` |
| 同上 | | `AppWindow.vue 处理 obox-theme-request 且校验 e.source 与 contentWindow` | 源文件含 `obox-theme-request` 分支与 `e.source === frameRef.value?.contentWindow` 判据 |
| 同上 | | `AppWindow.vue 只在 registration.url 存在时推送` | 源文件 `pushThemeTokens` 体内含 `registration.value?.url` 守卫 |

**为什么不用真实 iframe / 不用 jsdom（这条必须写在 ADR 的"验证"里）**：`app://` 协议由主进程注册（`src/main/protocol.ts`），真实 iframe 需要 Electron 多进程环境，单测里无法复现；仓库也无 DOM 测试先例。而"是否重渲染"在 Vue 里**完全由 `:key` 决定**——因此把它落成纯函数 `appFrameKey`（用例 5–7）+ 一条读源码的接线门禁（用例 12–15）是**等价且不脆弱**的验证；端到端确认交给 §8 的 V3（url 型：切主题后表单内容仍在）与 V5。

---

## 8. 真机验证步骤（路径 A 定稿）

**前置**：`cd extensions/rdp && npm run build`（构建到 `ui/`；改过 `src/**` 必须重跑，否则加载的是旧产物）；在 obox 仓库根启动 `npm run dev -- -- --debug-extension rdp@<扩展目录绝对路径>`（调试目录优先，见上一轮设计 §3.8）；重启 obox。

| 步 | 动作 | 期望 | 留证 |
| --- | --- | --- | --- |
| **V1 新建** | 点「＋ 新建连接」→ 逐项检查：① 每个选项**独占一行**（无两列挤压）；② 每个选项**下方**有一行灰色说明；③ 4 个下拉/单选逐个切换，确认选中值说明随之变化；④ 勾「全屏启动」→ 「分辨率」「智能缩放」「动态分辨率」「多显示器」的显示/隐藏符合规则。填 `name=验证A`、`host=10.0.0.8`、`port=3389` → 保存 | 表单结构如 §4.1；切换选项无错乱；保存后卡片出现 | 全屏截图（表单上部 + 高级展开各一张），保留**默认值与切换后**两态 |
| **V2 编辑** | 对刚建的「验证A」点「编辑」→ 断言：所有字段回填**正确**（尤其 4 个下拉/单选与 4 个勾选）；**不改任何值**直接保存 → 再点「编辑」→ 断言二次打开的值与第一次**完全一致**（无串扰）；再编辑另一条已有连接 → 断言**不残留**「验证A」的任何值 | 三次打开互不串扰（对应验收 3、R-D2） | 三次打开的表单截图；若首次即发现问题，一并保存 `tmp/rdp-d2-before.txt`（§3.1） |
| **V3 切主题（url 型 + srcdoc 型）** | ① 打开设置 → 外观 → 在 **dark ↔ light**（以及所有已注册主题）间来回切换，每次切完**不关子窗口**，观察 RDP 卡片子窗口（**url 型**）；② **不保存**地在「新建连接」表单里填几个字段（例如把「连接名」填成 `填写中-勿动`、勾上「剪贴板」）→ 再切一次主题 → 断言字段内容与勾选**仍在**（url 型卡片**不重渲染**）；③ 另外造一张 **srcdoc 型**测试卡片（`api.app.register({ html })`，最小 `<!doctype html><p>x</p>` 即可）→ 切主题 → 断言整页重渲染（表单值清空属**预期**） | ① 子窗口外观立即跟随（背景/文字/边框/按钮/说明灰字全部变化）；② **无**任何区域仍是旧的写死深色 —— 逐处核对这 **7 处**：模态框遮罩、滚动条、状态点、删除按钮、说明灰字、placeholder、主按钮文字；③ 文字对比度可读；④ url 型卡片切主题后**表单内容不丢**；⑤ srcdoc 型卡片切主题后**确实重建** | 每个主题下同一屏截图（dark + light 各一张子窗口全屏截图，文件名带主题 id）；②的"填写中"两态各一张；子窗口 DevTools 控制台截图（应出现 `[AppWindow] 下发主题 …` 与 `[rdp] 主题已应用 …`） |
| **V4 回归** | 删除一条连接（确认删除按钮辨识度，E4）；打开一条连接（确认状态点与状态栏） | 删除按钮仍够醒目；打开流程不回归 | 删除确认框截图 |
| **V5 跨窗口主题通知（§2.7.4 的假设验证）** | 保持 V3 的子窗口开着，在**主窗口**切一次主题；同时看子窗口 DevTools 控制台与主进程日志（带 `[child-renderer:…]` 前缀） | **成立**：子窗口收到 `storage` 事件 → 打印 `[AppWindow] 下发主题 <新 id>`，且 iframe 内打印 `[rdp] 主题已应用 <新 id>`，外观随新主题变化。**不成立**（无任何日志）：按 §2.7.4 的退路改主进程广播，并在 ADR-0022 记明换了通道；此时**不得**把 V3 判为通过 | 子窗口控制台日志截图（**必须**含一行 `[AppWindow] 下发主题` 与一行 `[rdp] 主题已应用`，作为"跨窗口通道成立"的证据）；若不成立，留一张空日志截图作为改判依据 |
| **V6 降级（无宿主时的兜底）** | 用系统浏览器直接打开构建产物 `extensions/rdp/ui/index.html`（或用 `cd extensions/rdp && npm run dev` 打开 vite 页面）——此时没有宿主、没有任何推送 | 页面**深色可读、不空白、不报错**；控制台出现一次 `[rdp] 未收到宿主主题推送（3 次请求无响应），使用内置兜底配色`；再手工 `postMessage` 一条 `{source:'obox-app',action:'obox-theme',tokens:{'--bg':'#ffffff','--fg':'#000000'}}` → 页面背景/文字**立即变浅**（证明"收到推送即生效"这条链路本身通） | 直开页面的截图（深色兜底）+ 控制台 warn 截图 + 手工推送后的浅色截图 |

**路径 A 下的 V 判定**：**V3 必须通过**（它就是验收 1 与验收 6 的判据）；**V5 决定 §2.7.4 的通道是否成立**（不成立 → 走退路并改 ADR，V3 的"切主题立刻生效"在退路完成后必须重做）；**V6 证明降级不空白、不报错**（对应 spec R-D1 的降级要求）。

---

## 9. 文件与归属（路径 A 定稿）

### 9.1 本次改动的文件

**9.1.1 宿主侧（obox 仓库；走分支 + PR；范围**严格**以 §2.7.7 为限）**

| 文件 | 改动 |
| --- | --- |
| `src/renderer/src/core/appTheme.ts` | **新增**：token 白名单、`sanitizeThemeTokens` / `collectThemeTokens` / `buildThemeMessage` / `isThemePush` / `isThemeRequest` / `appFrameKey`（§2.7.7 H1） |
| `src/renderer/src/core/state.ts` | `parsePersistedState` 抽出、`applyExternal` / `diffSettingsKeys` 新增、浏览器侧 `storage` 监听（§2.7.4、§2.7.7 H2） |
| `src/renderer/src/AppWindow.vue` | 主题快照 + `pushThemeTokens()` + `obox-theme-request` 分支 + `frameKey`（url 不重渲染 / srcdoc 重渲染）+ `refreshTheme` 订阅（§2.7.7 H3） |
| `test/app-theme.test.ts` | **新增**（§7.4） |
| `test/state.test.ts` | 修改：新增"跨窗口 storage 合并"用例组（§7.4） |
| `test/app-window-wiring.test.ts` | **新增**：读源文件的接线门禁（§7.4） |
| `docs/adr/0022-…md` | **新增**：宿主 ADR（§14） |
| `skills/obox-ext-dev/references/themes-settings.md`、`api-reference.md`、`manifest-reference.md`、`guides-user.md`、`troubleshooting.md`、`SKILL.md`、`scripts/create-user-extension.mjs`、`README.md` | 文档同步（逐条见 §12） |

**9.1.2 扩展侧（`extensions/rdp/`；该目录在 obox 仓库中 gitignored，独立工程、无需 PR）**

| 文件 | 改动 |
| --- | --- |
| `extensions/rdp/src/styles.css` | §2 全量 token 化（**裸 `var(--token)`**，不写兜底字面量）；§4 的 `.form-rows` / `.field__desc` / `.radio__desc` 新增，`.form-grid` 与 `--mono` 删除 |
| `extensions/rdp/src/theme.js` | **新增**：`FALLBACK_TOKENS` + `applyThemeTokens` + `installThemeBridge` + `colorSchemeForThemeId`（§2.7.8 E1） |
| `extensions/rdp/src/main.js` | `mount()` **之前**调用 `installThemeBridge()`（§2.7.8 E2） |
| `extensions/rdp/src/index.html` | 加 `<meta name="color-scheme" content="dark" />`（§2.7.8 E3） |
| `extensions/rdp/src/fields.js` | 每个字段加 `desc`（§5）；每个 `options` 元素加 `desc`（§6）；`VISIBILITY` 去就地挂载（§3.3 修法 3）；导出 `visibleFieldKeys(form)` |
| `extensions/rdp/src/components/ConnectionModal.vue` | `form` 改为 `reactive(defaultForm())` + `watch(props.row, …, { immediate: true })`（修法 1）；`visibleFields` 改调 `visibleFieldKeys`；`.form-grid` → `.form-rows` |
| `extensions/rdp/src/components/ConnectionField.vue` | 加 `.field__row` / `.field__control` / `.field__desc` 结构；`select` 渲染选中值说明；`radio` 每项加 `.radio__desc` |
| `extensions/rdp/src/App.vue` | **不改**（除非最终采用 §3.3 修法 4；默认不采用） |
| `extensions/rdp/src/bridge.js` | **不改**（`obox-extension` 请求-响应桥与主题单向推送职责不同，§2.7.8 E5） |
| `extensions/rdp/test/formState.test.js` | 新增（§7.1） |
| `extensions/rdp/test/stylesTokens.test.js` | 新增（§7.1，含"styles.css 消费的 token ⊆ 兜底表"两例） |
| `extensions/rdp/test/themeBridge.test.js` | 新增（§7.1，8 个用例） |
| `extensions/rdp/test/fieldDocs.test.js` | 新增（§7.1） |
| `extensions/rdp/test/rdpFile.test.js` | 可能修改（提交范围变化时） |
| `extensions/rdp/README.md` | 补：说明文本来源与「待确认」处置方式；**主题跟随的实现约定**（token 来自宿主推送、兜底表位置与退场条件） |
| `extensions/rdp/docs/adr/0002-…md` | **新增**：扩展 ADR（§14） |
| `extensions/rdp/ui/**` | `npm run build` 产物（不手工编辑；`pack.mjs` 会打进 `.oix`） |

### 9.2 不改的东西（硬边界）

- **宿主只改 §2.7.7 列的 3 个源码文件 + 3 个测试文件**：`src/api/**`、`src/preload/**`、`src/main/**`、`src/shared/types.ts` **一律不动**（无新 IPC、无新扩展 API）。
- **不新增扩展 API**：`api.theme` 仍只有 `getCurrent` / `onChanged`（只给 id）。若将来要 `getTokens()`，另开 ADR。
- **不改数据模型**：**不新增、不重命名、不删除任何 DB 列**；`fields.js` 的 key 与 `lib/rdpFile.mjs` 的 `field` 一一对应关系不变（`rdpFile.mjs:8-9`）；`.rdp` 字段集合不变。
- **不改 `lib/**` 的生成逻辑**（除非 §7.1 提到的提交范围变化需要同步，且仅限测试断言）。
- **不处理 spec §5 列的上一轮遗留项**（`adminSession` 默认值、用户名形态提示、保存后回读校验、归档文档 prettier）。

### 9.3 归档与提交

- spec：`tmp/spec/rdp-ui-theme-and-form.md` → `extensions/rdp/docs/spec/rdp-ui-theme-and-form.md`
- **本设计文档**：`tmp/spec/rdp-ui-theme-and-form-design.md` → `extensions/rdp/docs/spec/rdp-ui-theme-and-form-design.md`
- **两条 ADR（路径 A 定稿后的落位）**：
  - **宿主那条**（宿主/扩展系统行为变更）→ **仓库 `docs/adr/0022-…md`**（现最大编号 0021，顺延为 **0022**），随宿主 PR 提交；同时按 `AGENTS.md` 的 README 要求更新 `README.md:152` 的 ADR 索引行。
  - **扩展那条**（用户扩展自己的取舍）→ `extensions/rdp/docs/adr/0002-…md`（该目录现只有 `0001-rdp-extension-launch-and-storage.md`，顺延为 **0002**）。
  - 两条 ADR 的**标题与要点大纲**见 §14；**正文在开发完成后书写**（含实测数据、证据与退场条件）。
  - 说明：原 §9.3 提到的第三条 ADR（"未确证字段用显式占位，不编造语义"）本次**不单列**——它已由 §5.3 + §6.4 + §15 的清单与 `fieldDocs.test.js` 的断言完整承担，且它不是"架构决策"而是"写作纪律"；若下一轮核对后仍有残留，再补 ADR。
- 完成后**删除整个 `tmp/`**（`gitignore` 已忽略 `/tmp/`）。
- **提交**：`extensions/` 独立工程（gitignored），**无需 PR**；宿主与文档改动**必须**走分支 + PR（`docs/adr/0008`），中文标题/正文用 UTF-8 文件 + 字节体发送；合并后按 `AGENTS.md` 做依赖安全检查（`npm run security:audit` 0 告警、Dependabot 开放告警 0）。


---

## 10. 验收执行清单（把 spec §3 落成命令）（路径 A 定稿）

| spec 验收 | 执行 | 期望 |
| --- | --- | --- |
| 2. 零自造色值 | §2.6 核查 1/2/3（或 `node --test test/stylesTokens.test.js`） | 三项退出码 0；命中数由基线 29 → 0 |
| 3. 复现测试先红后绿 | `node --test test/formState.test.js`，改前/改后各一次 | 改前至少 1 个 `not ok`；改后全 `ok`；输出存 `tmp/rdp-d2-before.txt` / `-after.txt` |
| 4. 说明文本 100% | `node --test test/fieldDocs.test.js` | 65/65 字段有 `desc`；20/20 取值有 `desc`；待确认恰为 4 个字段 key + 1 个取值 |
| 5. 扩展内门禁 | `node --test`、`npx prettier --check .`、`npm run build` | 全部退出码 0 |
| **5'. 宿主门禁（路径 A 新增）** | 仓库根 `npm run typecheck`、`npm run lint`、`npm test` | 三条全绿；PR 的 CI `check` 通过后才可 squash 合并（`docs/adr/0008`） |
| 6. 真机三步 | §8 的 V1/V2/V3（+ V4 回归 + **V5 跨窗口通道** + **V6 降级**） | V1–V4 全过；**V5 成立**（否则走 §2.7.4 的退路并改 ADR）；V6 证明兜底不空白、不报错 |
| 1. 每个主题外观一致 | §8 V3（**url 型**与 **srcdoc 型**各一张卡片） | 各主题截图逐张比对；7 处重点区域逐一核对；url 型切主题后表单内容仍在 |
| 7. 不改数据模型 | `git -C extensions/rdp diff --stat`（独立工程）+ 人工核对 | 无 `ALTER TABLE` / 无列名增删改 |
| **文档同步（仓库强制约定）** | 按 §12 逐条勾掉 | 9 个文件全部改到位；`git status` 里能看到这些改动 |
| 阶段七审视 | 派**独立子代理**对照 spec 与本设计文档 review | 它报的每条问题**逐条处置**（改掉或写明不改） |
| 收尾 | §13 第 8 步 | `tmp/` 已删除；宿主 PR 已合并；`npm run security:audit` 0 告警、Dependabot 开放告警 0 |

---

## 11. 风险与不在范围内（路径 A 定稿）

### 11.1 沿用 spec 的两条风险

| spec 风险 | 本次处置 |
| --- | --- |
| **token 覆盖不全**（跟随了主题但看不清） | ① §2.4 决策 **E4/E5/E7** 专治对比度（危险按钮改描边式、遮罩/阴影由 `--bg` 派生、spinner 用 `currentColor`）；② **§8 V3 列出 7 处逐处截图**：模态框遮罩、滚动条、状态点、删除按钮、说明灰字、placeholder、主按钮文字；③ 说明灰字用 `--fg-dim`——注意深色主题 `--fg-dim` 是 `#6e6e6e`（`main.css:10`），**比现在的 `#9d9d9d` 更暗**，须在 V3 专门确认可读性，若不可读则升级为 `--fg` + `--font-size-sm`（届时记入 ADR） |
| **说明文本体量**（约 65 字段 + 20 取值，显著拉长表单） | ① 高级区**仍默认折叠**（65 个字段里 **46** 个在高级区，打开高级前只看到 19 项）；② 字段级说明**固定一行**（§6.3 要求收敛措辞，超长则截断并保留 `title` 悬浮全文）；③ 取值说明只显示**当前选中**那一条（§6.2），不是 5 条一起铺；④ `radio` 的 4 项说明纵向展开在常用区可接受 |

### 11.2 本次新增的风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| **R1：跨窗口主题通知依赖 `storage` 事件**（§2.7.4） | 若不成立，主窗口切主题**不会**触发子窗口推送 ⇒ R-D1 的"切换立即生效"落空（但外观仍为正确的初始主题，不会白屏） | 本仓库首次依赖该机制（F9）：由 **§8 V5** 真机确认；不成立则按 §2.7.4 的退路改**主进程广播**（同时新增 preload 方法与 `src/shared/types.ts` 类型），并在 ADR-0022 记明换了通道；协议与扩展侧代码不受影响 |
| **R2：`--fg-dim` 变暗导致说明可读性下降** | 说明文本（大量使用 `--fg-dim`）在深色主题下对比度不如现状 | §8 V3 专项确认；不可读则按 §11.1 升级方案处置并记 ADR |
| **R3：E4 删除按钮改为描边式后辨识度下降** | 危险操作不够醒目 | §8 V4 确认；不足则给 hover/常态加 `color-mix(--fg-error 15%, transparent)` 底色 |
| **R4：`color-mix()` 的兼容性** | 若某 Electron 版本不支持则声明整条失效 | 构建目标 `chrome120`（`vite.config.mjs:19`）已支持；`stylesTokens.test.js` 无法运行时验证，故 §8 V3 须留意"遮罩/阴影/spinner 是否还在"，并对 `color-mix` 声明**始终提供等价 fallback**（如先写 `transparent` 再写 `color-mix`） |
| **R5：R-D2 根因在宿主侧**（spec §6 第三条风险） | 若真机现象由 App 子窗口的组件复用行为引起，则要改判范围 | §3.2 分支 C 的"路径无关性"属性测试是最强判定器；若证明在宿主，**停下来问用户**并把 ADR 落位改判到仓库 `docs/adr/`（与 ADR-0022 分开记） |
| **R6：修法 2 改变提交语义** | "隐藏字段不再提交"是**行为变更**；旧数据里已有的隐藏字段值，保存后可能被默认值覆盖 | ① 这是期望行为（消除"看不见的值进库"）；② 保存前不主动清库，仅影响再次保存；③ README 与 ADR 写明；④ `node --test` 加断言钉死语义 |
| **R7：65 个 `desc` 的措辞工作量与一致性** | 说明文本可能风格不一、或与取值说明重叠 | §5（字段级）与 §6.1（取值级）两层分工；§6.3 要求重叠时以 §5 为准收敛 |
| **R8：4 个待确认字段 + 1 个待确认取值** | 若不补齐就上，说明文本可能是错的 | §5.3 / §6.4 显式占位 + §15 的核对清单（下一轮一次性确证）+ `fieldDocs.test.js` 把"非空"与"已确证"分开统计；补齐后才可移除占位（退场条件） |
| **R9：兜底表是宿主默认色的副本，会漂移**（§2.7.6） | 宿主改了 `main.css` 的默认色，扩展兜底仍是旧色（只在"拿不到推送"时才可见） | `stylesTokens.test.js` 钉住"兜底表键 ⊆ 宿主 token 白名单"与"`styles.css` 消费的 token ⊆ 兜底表键"；**值**的一致性只能在真机 V6 用肉眼确认（写进扩展 ADR 的"退场条件"） |
| **R10：`url` 卡片不再重渲染带来的副作用面** | 切主题时 iframe 不重载 ⇒ 除 CSS 变量外，任何"依赖重载才更新"的页面状态不会更新（例如页面自己缓存的、从 `getComputedStyle` 读到的值） | 这正是 R-D1 想要的（表单内容不被清空）；限制在 V3 里逐项确认：**页面自身状态必须来自 CSS 变量而非 JS 快照**；扩展侧本次没有这类缓存（`theme.js` 每次推送都重新 `setProperty`） |
| **R11：子窗口的 `storage` 合会是"整份快照替换"语义**（§2.7.4 第 1 步） | 若将来有两个窗口同时写 localStorage，后写的快照会覆盖先写的（快照粒度 = 整个 state） | 现状下**子窗口从不写**（不激活扩展、不调 `setTheme`）⇒ 单写者，无冲突；若将来子窗口需要写，需改为按键合并（记入 ADR-0022 的退场条件） |

### 11.3 不在范围内

- 宿主只改 §2.7.7 列的 3 个源码文件 + 3 个测试文件；**不新增 IPC、不改 preload / main / shared types / `src/api`**（除非 R1 的退路被触发，届时按 §2.7.4 与 ADR-0022 的范围执行）。
- 不新增扩展 API（`api.theme` 仍只给 id）；不做 `api.theme.getTokens()`。
- 不改数据模型：**不新增 / 不重命名 DB 列**、不改 `.rdp` 字段集合、不改 `lib/**` 的生成语义。
- 不做深浅色以外的主题定制（不引入新主题、不做 token 覆盖）；不校验 `event.origin`（改校验 `event.source`，理由见 §2.7.9）。
- 不引入运行期 npm 依赖（`@vue/compiler-sfc` / `vue/server-renderer` 是 **devDependency 侧**、且已随 `vue` 可解析，实测可用；**不新增 `package.json` 依赖**）。
- 不做"自绘 listbox / combobox"（§6.2 已否决）。
- 不处理 spec §5 的上一轮遗留项。
- 不改 `App.vue` 的模态框挂载策略（§3.3 修法 4 默认不做）。
- 不在 `app://` 协议层注入 `<style>`（§0.3 方案 D，作为 ADR-0022 的退场条件保留）。
- 不把主题下发接进 `api.app.onMessage` 桥（§2.7.9 已给理由）。

---

## 12. 文档同步清单（路径 A 定稿）

本次改了**宿主行为**（新增一条"宿主 → 子窗口"的主题下发协议、新增跨窗口设置同步）与**扩展约定**，按 `AGENTS.md` 的"持续更新要求（强制）"，以下文件**必须**随本次改动一起改。逐条给出：位置、现在写的是什么、改成什么。

| # | 文件 | 位置 | 现在写的是 | 改成什么 |
| --- | --- | --- | --- | --- |
| S1 | `skills/obox-ext-dev/references/themes-settings.md` | 第 12 行（"主题系统 · 机制"第 4 条） | "用户扩展的 App 子窗口 iframe（srcdoc）**自动注入当前主题 token**，扩展页面用 `var(--token)` 即可跟随主题；`url` 场景由扩展自行处理" | 拆成三条：① `srcdoc` 卡片仍**自动注入**（行为不变）；② **`url` 卡片**：宿主在 iframe `load` 完成时、每次主题变化时、以及收到 `obox-theme-request` 时，向 `iframe.contentWindow` 下发 `{source:'obox-app', action:'obox-theme', themeId, tokens}`；扩展侧把 `tokens` 逐条 `documentElement.style.setProperty(k, v)` 即跟随主题（**不再需要** `var(--token, fallback)` 的兜底值当实际色值）；③ 给出**最小接收代码**（`installThemeBridge` 的等价片段）+ 首帧兜底建议 + 指向 `src/renderer/src/core/appTheme.ts`、`src/renderer/src/AppWindow.vue` 的引用 |
| S2 | 同上 | 第 10 行（"选中后把 token `setProperty` 到 `document.documentElement`（`:root`）并持久化"） | 只描述了主窗口 | 追加一句："**每个渲染窗口各有一份 `:root`**；App 子窗口（`?obox-window=app`）启动时由 `host.start()` 收尾的 `applyCurrent()` 应用一次（`core/host.ts:930`），主窗口此后切主题时经 `storage` 事件把新快照合并进子窗口并重新应用（`core/state.ts` 的 `applyExternal`，ADR-0022）" |
| S3 | 同上 | 第 75 行（"`apply()` 只写主题声明过的键、**不清除**上一个主题写入的行内值……直到重载页面"） | 只讲主窗口的残留语义 | 原句**保留**，追加："该残留语义同样体现在下发给 App 子窗口的 token 快照里——快照取自 `getComputedStyle(document.documentElement)` 的**生效值**（`collectThemeTokens`），因此子窗口与主窗口**所见一致**（这是一致性优先的选择）" |
| S4 | `skills/obox-ext-dev/references/api-reference.md` | `:465-473` `### theme（主题）` | 只有 `getCurrent()` / `onChanged()` 两段代码，没有"拿不到 token 值"的说明 | 追加一行（放在代码块后）："`api.theme` **只提供主题 id**，**不提供 token 值**；App 子窗口里的页面**没有** `api` 对象，取 token 请用 `app.register` 小节里的**主题下发协议**（详见 `themes-settings.md`）" |
| S5 | 同上 | `:174-176`（`app.register` 小节的"子窗口内容通信""url 加载用户扩展静态页""这是跨源加载"三条 bullet） | 只写了窗口控制消息与 `api.app.onMessage` 桥 | 新增一条 bullet：**"主题下发（宿主 → 子窗口，单向）"**——消息形状 `{source:'obox-app', action:'obox-theme', themeId, tokens}`、三个触发时机、`tokens` 是宿主 25 个 token 的**生效值**、扩展侧应 `setProperty` 到自己 `documentElement`、拿不到时用内置兜底；并写明 **`url` 型卡片切主题不再重渲染（`url` 不变则 `:key` 不变）**、`srcdoc` 型仍靠重渲染；引用 `core/appTheme.ts` 与 `AppWindow.vue` |
| S6 | 同上 | `:178` 起 `### app.onMessage(handler)` | 未区分"请求-响应桥"与"宿主单向推送" | 追加一句："`app.onMessage` 是**请求/响应**桥（经主进程 IPC、60 s 超时、需要扩展注册 handler）；**主题是宿主单向推送**，不经该桥、**不需要** handler——两者不要混用" |
| S7 | `skills/obox-ext-dev/references/troubleshooting.md` | 文末（现最大条目为第 28 条） | 无此条目 | 新增 **`## 29. App 子窗口（url 型）拿不到主题 token / 切主题不跟随`**：症状（页面用 `var(--token)` 全落空、切主题无反应、表单配色丢失）；原因（跨源不能注入 ⇒ 必须走消息；扩展没装接收桥；宿主未推送）；排查（子窗口 DevTools 看两条日志 `[AppWindow] 下发主题 …` 与 `[rdp] 主题已应用 …`；确认收到 `obox-theme`）；修法（装接收桥 + 首帧兜底）；**已知坑**（跨窗口主题同步依赖 `storage` 事件，本仓库自 ADR-0022 起使用；若日志里没有任何 `下发主题` 行，按 ADR-0022 的退路排查） |
| S8 | 同上 | 第 5 条（`## 5. iframe 内联脚本不生效（CSP 阻止）`） | 只讲内联脚本被拦 | 追加一句："**主题下发不受 CSP 影响**（它是 `postMessage`，不是脚本/样式注入）；因此**不要**为了让主题生效去放宽 CSP 或注入内联 `<style>`——那在跨源 iframe 里根本做不到（见第 29 条）" |
| S9 | `skills/obox-ext-dev/SKILL.md` | 第 60 行文档路由表的"主题 token、设置系统"一行 | "主题 token、设置系统 → `references/themes-settings.md`" | 说明列补成"主题 token、设置系统、**App 子窗口主题下发协议** → `references/themes-settings.md`"（让 URL 型子窗口的主题问题能被路由到正确文档） |
| S10 | `skills/obox-ext-dev/references/manifest-reference.md` | 第 129 行（`themes` 小节末尾） | "子窗口 iframe（srcdoc）自动注入当前主题 token，扩展页面用 `var(--bg)` 等即可跟随主题。" | 与 S1 同步为"`srcdoc` 自动注入；**`url` 由宿主下发**（协议见 `themes-settings.md`）"——同一条事实只在两处出现，必须一起改，否则下一轮又会以旧句为准 |
| S11 | `skills/obox-ext-dev/references/guides-user.md` | 第 126 行（App 子窗口主题那条） | "主题：宿主只给 `html`/`srcdoc` 那条路注入主题 token（`AppWindow.vue:38-52`），`url` 静态页拿不到宿主 token —— 自备样式，或写 `var(--token, fallback)` 兜底。" | 改成："主题：`srcdoc` 由宿主注入；**`url` 静态页由宿主下发**（`obox-theme` 推送，协议见 `themes-settings.md`），**仍建议保留一份兜底**（老宿主 / 推送未达时不空白），但兜底值应集中在**一处**常量而不是散在 CSS 里" |
| S12 | `skills/obox-ext-dev/scripts/create-user-extension.mjs` | 第 284 行、第 754-755 行、第 803 行的注释（"子窗口是独立文档（`app://` 协议），拿不到宿主主题变量 → token 一律写 `var(--token, fallback)`"） | 与新协议矛盾 | 三处注释统一改为："子窗口是独立文档（`app://` 协议），**CSS 自定义属性不跨文档继承**；宿主会通过 `obox-theme` 消息下发 token（见 `themes-settings.md`），**在收到之前**用 `var(--token, fallback)` 兜住首帧 / 老宿主"；并在生成的 `app/main.ts` 骨架里加一行 `installAppThemeBridge()`（骨架内自带最小接收函数，注释标明"与宿主协议一致，勿改消息形状"），使脚手架产出**默认就是跟随主题**的 |
| S13 | `README.md` | 第 152 行 ADR 索引行 | "… / **0021 扩展数据升级保留与 JS 助手运行时**" | 行尾追加 " / **0022 宿主向 `url` 型 App 子窗口下发主题 token**"（`AGENTS.md` 的 README 更新要求：文档导航变化必须同步） |
| S14 | `docs/adr/0022-….md` | 新文件 | — | 宿主 ADR 正文（标题与要点见 §14；开发完成后补实测数据） |
| S15 | `extensions/rdp/README.md` | 主题相关小节（现有文档无此小节则**新增**"主题跟随"一节） | 现无对应说明 | 写清：token 来源 = 宿主 `obox-theme` 推送；首帧兜底在 `src/theme.js` 的 `FALLBACK_TOKENS`；`color-scheme` 由 `themeId` 决定；`styles.css` 只写裸 `var(--token)`（不用 fallback 字面量）；以及**退场条件**（宿主能在首帧前注入 token，或扩展能声明并强制校验最低宿主版本） |
| S16 | `extensions/rdp/docs/spec/rdp-ui-theme-and-form-design.md` | 归档本文件 | — | spec 与设计文档归档（路径与编号见 §9.3；该目录 gitignored） |

**已核对、本次无需改动的文件**（避免下一轮重复排查）：

| 文件 | 结论 |
| --- | --- |
| `CONTEXT.md` | 全文无"主题 token"相关术语条目（只提到 App 子窗口/静态资源加载），本次不新增术语 |
| `skills/obox-ext-dev/references/workflow.md` | 流程（提问 → spec → 设计 → 开发 → 测试与审视 → ADR → 归档）未变；本次只是**再次触发**了"要改宿主 → ADR 落位改判到仓库 `docs/adr/`"这条既有约定 |
| `skills/obox-ext-dev/references/guides-builtin.md` | 内置扩展不受影响（主题扩展只提供 token，行为不变） |
| `skills/obox-ext-dev/scripts/validate-manifest.mjs` 及其差分门禁 `test/manifest-script-parity.test.ts` | manifest 校验规则未变（没动 `contributes` schema） |
| `src/renderer/src/assets/main.css`、`theme-dark` / `theme-light` 的 manifest | token 集合与默认值未变（`HOST_THEME_TOKEN_NAMES` 必须与 `main.css:2-29` 一致，由 `test/app-theme.test.ts` 钉住） |

---

## 13. 实施顺序与每步验收命令（路径 A 定稿）

顺序与 `AGENTS.md` 的 workflow 一致；**宿主在前**（它决定 token 能不能到），扩展主题接收在后；R-D2 / R-D3 与路径 A 解耦，可并行但要各自留证。

| 步 | 做什么 | 产出 | 验收命令 | 通过标准 |
| --- | --- | --- | --- | --- |
| **1. 宿主改动** | 按 §2.7.7 实现 H1（`core/appTheme.ts`）、H2（`core/state.ts` 的 `parsePersistedState`/`applyExternal`/`storage` 监听）、H3（`AppWindow.vue` 的快照、推送、请求分支、`frameKey`、`refreshTheme`） | 3 个宿主源码文件 | `npm run typecheck`；`npm run lint` | typecheck 通过（含 `vue-tsc` 的模板检查）；lint **0 error** |
| **2. 宿主测试** | 按 §7.4 新增 `test/app-theme.test.ts`、扩充 `test/state.test.ts`、新增 `test/app-window-wiring.test.ts` | 3 个测试文件 | `npm test` | 全绿；其中 `appFrameKey` 的 3 个用例与 `buildThemeMessage` 用例必须存在（它们就是"构造 + 不重渲染/仍重渲染"的判据） |
| **3. 扩展主题接收** | 按 §2.7.8 实现 E1–E4（`theme.js` + `main.js` + `index.html` + `styles.css` 全量 token 化） | 4 个扩展文件 | `cd extensions/rdp && node --test && npx prettier --check . && npm run build` | 三条全绿；`stylesTokens.test.js` 的核查 1–3 退出码 0（自造色值命中数 29 → 0），且新增的"兜底覆盖"两例（`styles.css` 消费的 token ⊆ `FALLBACK_TOKENS` ⊆ 宿主白名单）为绿 |
| **4. R-D2 先红后修** | 先写 §3.1 的 5 个用例并**在未改源码时跑一次留红**（存 `tmp/rdp-d2-before.txt`）→ 按 §3.3 的修法 1→3→2 实施 → 再跑（存 `tmp/rdp-d2-after.txt`） | `test/formState.test.js`、`fields.js`、`ConnectionModal.vue` | `cd extensions/rdp && node --test test/formState.test.js` | 改前至少 1 个 `not ok`；改后全 `ok`；两份输出留证（对应验收 3）。**若首次即全绿**：按 §3.1 的说明转 §3.2 分支 B/C，不得改断言凑红灯 |
| **5. R-D3 表单与说明文本** | 按 §4（`.form-rows` / `.field__desc` 结构）、§5（65 个字段 `desc`）、§6（20 个取值 `desc` + 呈现方式）实施；未确证者用显式占位（§5.3 / §6.4 / §15） | `ConnectionField.vue`、`ConnectionModal.vue`、`fields.js`、`styles.css`、`test/fieldDocs.test.js` | `cd extensions/rdp && node --test test/fieldDocs.test.js && npx prettier --check . && npm run build` | 65/65 字段 desc 非空、20/20 取值 desc 非空、待确认恰为 4 字段 + 1 取值（对应验收 4） |
| **6. 全量测试 + 独立审视** | 两侧全量门禁 + 派**独立子代理**对照 spec 与本设计文档 review | 全绿 + 审视报告 | 宿主：`npm run typecheck && npm run lint && npm test`；扩展：`cd extensions/rdp && node --test && npx prettier --check . && npm run build` | 两侧全绿；子代理报的每条问题**逐条处置**（改掉或写明不改并留理由） |
| **7. ADR** | 写 §14 的两条 ADR 正文（含实测数据、证据、退场条件）+ 完成 §12 的全部文档同步 | `docs/adr/0022-….md`；`extensions/rdp/docs/adr/0002-….md`；§12 的 S1–S16 | 人工核对：§12 逐条勾掉；`git status` 能看到 S1–S13 涉及的文件改动 | 两条 ADR 落位正确（宿主 → `docs/adr/`；扩展 → `extensions/rdp/docs/adr/`）；文档同步无遗漏 |
| **8. 归档 + 提交** | spec 与设计文档归档到 `extensions/rdp/docs/spec/`；删除整个 `tmp/`；宿主改动走分支 + PR | 归档文件；PR | 宿主：`npm run typecheck && npm run lint && npm test` → 建分支 → push → 用 `.gitoken` 开 PR（中文标题/正文走 UTF-8 文件 + 字节体）→ 等 CI `check` | 目标分支上的 PR `check` = `success`、`mergeable=true` → squash 合并 → 删除源分支；合并后 `npm run security:audit` **0 告警** + Dependabot 开放告警 **0**；`tmp/` 已删除 |

**真机验证（§8）在各步的位置**：V6（降级）在第 3 步后即可做（直开 `ui/index.html`）；V1/V2 在第 4、5 步后做（表单相关）；V3/V4 在第 5 步后做（外观与回归）；**V5 必须**在第 1、2 步后尽早做一次（它决定 §2.7.4 的通道要不要换退路）——早发现早改，避免扩展侧白做。

---

## 14. ADR 计划（路径 A 定稿）

两条 ADR 的落位不同（宿主行为 → 仓库；用户扩展取舍 → 扩展目录）。**编号已按目标目录现有最大编号顺延**：仓库 `docs/adr/` 现有 `0001`–`0021`（最大 `0021-extension-data-durability-and-js-sidecar.md`）→ 宿主 ADR 取 **0022**；`extensions/rdp/docs/adr/` 现有 `0001-rdp-extension-launch-and-storage.md` → 扩展 ADR 取 **0002**。**正文在开发完成后写**（含实测数据与证据），本次只定标题与要点大纲。

### 14.1 宿主 ADR

- **编号与文件名**：`docs/adr/0022-url-app-window-theme-token-delivery.md`
- **标题**：《`url` 型 App 子窗口的主题 token 下发与跨窗口主题同步》
- **要点大纲**：
  1. **背景**：主题 token 只被拼进 `srcdoc`（`AppWindow.vue:38-52`）；`url` 型卡片（RDP 等）走 `app://extensions|debug/...`，与父文档**跨源** ⇒ 既不能注入 CSS（`contentDocument` 恒为 `null`），也不能继承自定义属性 ⇒ 完全拿不到 token。另记录一处**既有缺陷**：子窗口是独立 document，主窗口切主题时**没有任何**跨窗口通知（`state.ts` 无 `storage` 监听、`src/main/**` 无 settings/theme 广播），因此连 `srcdoc` 卡片也不会即时跟随。另有 `api.theme` 只提供 id（`host.ts:527-547`）、既有消息桥只有 `obox-extension(-reply)`。
  2. **决策**：① 宿主**单向推送** `{source:'obox-app', action:'obox-theme', themeId, tokens}`（触发：iframe `load`、主题变化、子页面 `obox-theme-request`），扩展侧 `setProperty` 到自己 `documentElement`；② 下发的 `tokens` 是**生效值快照**（`collectThemeTokens` + `getComputedStyle`，25 个白名单 token），与主窗口所见一致；③ **`url` 型卡片不再以主题为 `:key`**（`appFrameKey` → `url:<url>`），**`srcdoc` 型保留重渲染**（`srcdoc:<themeId>`）；④ `state.ts` 增加**跨窗口快照合并**（`storage` 事件 → `applyExternal` → 按变更 key 通知）作为"主题变化"的唯一跨窗口通道，子窗口只 `applyCurrent()`、**不写** localStorage；⑤ 扩展侧拿不到 token 时用内置兜底（不报错、不空白）；⑥ **不新增扩展 API**（`src/api`、`src/preload`、`src/main`、`src/shared/types.ts` 不动）。
  3. **后果**：好处（R-D1 落地；一次修掉全部 `url` 型卡片的同一缺陷；子窗口 chrome 与 `srcdoc` 卡片也顺带跟随主题；扩展侧零 token 副本依赖）；代价/风险（新增一条宿主 ↔ 子窗口协议 + 跨窗口设置同步语义，需文档化；`storage` 事件跨窗口送达为本仓库首次依赖，退路 = 主进程广播；扩展侧兜底表是宿主默认色的副本，会漂移，靠测试钉住键集合；`color-scheme` 用 id 启发式）。
  4. **退场条件**：① 若改为在 `app://` 协议层注入 `<style>`（治本方案，见设计 §0.3 方案 D），则推送机制与扩展兜底表都可删；② 若 `storage` 事件在目标平台/版本不可靠，改用主进程广播（`ipcMain` → `webContents.send` 所有窗口，仿 `src/main/fs.ts:39-41`），本 ADR 相应修订；③ 若将来 `api.theme` 提供 `getTokens()`，主窗口侧扩展可用，但 `url` 子窗口仍必须靠推送（子窗口无 `api`）⇒ **不构成**本条的退场理由；④ 若子窗口开始写 localStorage，则"整份快照替换"需改为按键合并（设计 §11.2 R11）。
  5. **验证（开发完成后回填）**：`test/app-theme.test.ts` / `test/state.test.ts` / `test/app-window-wiring.test.ts` 的用例清单与结果；真机 §8 V3（url 不重渲染 + 7 处配色核对）、V5（`storage` 通道成立与否）、V6（降级不空白）；宿主门禁 `typecheck`/`lint`/`test` 与 PR 的 CI 结论。

### 14.2 扩展 ADR

- **编号与文件名**：`extensions/rdp/docs/adr/0002-app-window-theme-bridge-and-fallback.md`
- **标题**：《子窗口主题接收桥（`obox-theme`）与内置兜底配色》
- **要点大纲**：
  1. **背景**：`app://` 静态页与宿主**跨源**，CSS 变量拿不到；宿主推送是**唯一** token 来源；首帧（模块脚本执行前）早于任何推送；R-D1 同时要求 `styles.css` **零色彩/字体字面量**，因此兜底值不能写进 CSS。
  2. **决策**：① 新增 `src/theme.js`：`FALLBACK_TOKENS`（宿主 dark 的 25 个 token 副本）+ `applyThemeTokens` + `installThemeBridge`（`requestDelaysMs = [0, 300, 1000]` 三请求 + 收到即停）；② `main.js` 在 `mount()` **之前**调用它，**同步**写兜底（首帧即有配色）；③ `styles.css` 只写**裸** `var(--token)`；④ 非法 token 名 / 非字符串 / 空值一律丢弃，任何异常只 `console.warn('[rdp] …')`，**不抛错**；⑤ `color-scheme` 由 `colorSchemeForThemeId(themeId)`（`/light/i`）决定；⑥ `bridge.js` **不改**（请求-响应桥与单向推送职责分开）。
  3. **后果与风险**：兜底表是宿主默认色的副本 ⇒ 会随宿主漂移（只影响"拿不到推送"的场景）；首帧仍有一瞬由 UA 画布色决定（用 `index.html` 的 `<meta name="color-scheme" content="dark">` 兜暗色）；`themeId` 启发式判深浅对第三方主题可能不准（只影响原生控件底色）。
  4. **退场条件**：① 宿主能在**首帧之前**注入 token（协议层注入，或 `srcdoc` 化）；② 扩展能声明并**强制校验**最低宿主版本（此时可删兜底表，只保留 warn）。二者任一落地即可移除 `FALLBACK_TOKENS`。
  5. **验证（开发完成后回填）**：`test/themeBridge.test.js` 的 8 个用例结果；`test/stylesTokens.test.js` 的"`styles.css` 消费的 token ⊆ 兜底表键 ⊆ 宿主白名单"两例；真机 §8 V3（跟随主题）与 V6（直开 `ui/index.html` 的深色兜底 + 3 次请求后的 warn + 手工推送立即生效）。

---

## 15. 「待确认」独立核对清单（4 个字段 + 1 个取值）（路径 A 定稿）

本节把 §5.3（4 个字段级）与 §6.4（1 个取值级）合并成**一张可一次性核对的清单**，供下一轮（**具备网络访问**的执行者）逐条确证。它与路径 A 无关，但必须在**写 §5/§6 的 `desc` 之前**完成，否则只能继续用显式占位。

**核对方法（统一）**：优先查**来源 ③**（微软官方文档）→ 用**真机导出 `.rdp`**做交叉验证（`mstsc` 界面里配置好后导出，看实际写入值）→ 若两者冲突，以**实测写入值**为最终依据，并把冲突记入扩展 ADR。核对完成后：回填 §5.2 / §6.1 的对应 `desc`，把 §5.3 / §6.4 / 本节该行标记为「已确证」并写明来源与日期，同时更新 `fieldDocs.test.js` 的"待确认清单恰为 4 字段 + 1 取值"断言（该断言是清单变化的**门禁**）。

| # | 字段 / 取值 | 待确认的具体问题（一句话） | 候选解释 | 用什么来源可以确证 |
| --- | --- | --- | --- | --- |
| **K1** | `singleMonInWindowedMode`（`.rdp` 键 `singlemoninwindowedmode`） | 这个键在"窗口模式 + 多显示器"下到底控制什么，取值是布尔还是别的？ | 候选 A：布尔，`1` = 窗口模式下**只用单个**显示器（避免多显窗口模式）、`0` = 不限制；候选 B：它不是布尔而是"显示器序号 / 掩码"；候选 C：它已被 `use multimon` + `screen mode id` 完全取代，只对老客户端生效（本扩展判定的"不可达"因此有可能是对的） | ① 微软 Learn《Supported RDP properties with Remote Desktop Services》的该键条目；② `mstsc` 的"显示"选项卡在"窗口模式 + 勾选使用所有显示器"前后**导出 `.rdp`** 对比实际写入值；③ 本仓库既有实测记录 `extensions/rdp/lib/rdpFile.mjs`（`use multimon` / `screen mode id` 那几条）作为旁证 |
| **K2** | `gatewayCredentialsSource`（`gatewaycredentialssource`） | 官方是否存在取值枚举（0/1/2/3/4 各是什么），还是根本没有官方定义？ | 候选 A：官方文档**未列**该键 ⇒ 保持"留空不写 + UI 角标（未官方确认）"；候选 B：有枚举且与 `gatewayusagemethod` 同族（如 0 无 / 1 显式凭据 / 2 智能卡 / 3 已保存凭据 / 4 Any）；候选 C：取值是**字符串**（如 `Ask`/`Cookie`）而非数字 | ① 微软 Learn 的 RD 网关（RD Gateway）属性表 / *Supported RDP properties*；② **真机导出**：在 `mstsc` 里配置"RD 网关 → 使用凭据"的不同选项后导出 `.rdp`，看实际写入的数字或字符串；③ 组策略文档（"Specify settings for RD Gateway"）与 RD 客户端（`mstscax.dll`/Remote Desktop 应用）帮助中的同名字段 |
| **K3** | `usbDeviceStoreDirect`（`usbdevicestoredirect`） | 它的取值语法是否与 `devicestoredirect` **完全一致**（`*` / `DynamicDevices` / 设备 ID 列表）？ | 候选 A：同族同语法，`*` 与设备 ID 都接受；候选 B：只接受 USB 设备实例 ID（`USB\VID_…`），**不接受** `*`；候选 C：必须配合"允许列表"（如 `deviceaccepted 4:…`）才生效 | ① 微软 Learn 的设备重定向语法条目（`devicestoredirect` / `usbdevicestoredirect` 并列看差异）；② **真机导出**：`mstsc` → 本地资源 → 更多 → 勾选"其他支持的 USB 设备"（及逐个勾选具体设备）后导出 `.rdp`，对比写入值；③ 与 `deviceStoreDirect`（`*` 已被本扩展确认）的写法做**同机对照**，差异即语法差异 |
| **K4** | `cameraStoreDirect`（`camerastoredirect`） | 它的取值语法是什么（`*` / 具体设备 ID / 是否有 `DynamicDevices` 之类关键字）？ | 候选 A：`*` 或设备 ID 列表，与 `devicestoredirect` 同族；候选 B：只接受摄像头设备实例 ID / 符号链接（不接受 `*`）；候选 C：需与"位置重定向"（`redirectlocation`）共同生效，单独写无效 | ① 微软 Learn 的 `camerastoredirect` 条目（并确认其支持的 Windows 版本范围）；② **真机导出**：`mstsc` → 本地资源 → 勾选"摄像头"后导出 `.rdp`，对比写入值；③ 同机对照 `redirectlocation` 勾选/取消对写入值的影响 |
| **K5** | `keyboardHook = 3`（取值级，不是字段级） | 官方定义里 `1`（本扩展 label「远程」）与 `3`（label「始终交给远程」）的差别是什么，两者是否**同义**？ | 候选 A：`1` = 窗口模式也交给远程、`2` = 仅全屏交给远程、`3` = 无论模式都交给远程（则 `1` 与 `3` 需按官方措辞区分）；候选 B：`1` 与 `3` **同义**（历史遗留）⇒ 应合并 label 或按官方措辞改写；候选 C：`3` 的语义是"即使本机存在同热键也交给远程"，与全屏/窗口无关 | ① 微软 Learn 的 `keyboardhook` 条目（0/1/2/3 四条定义的原文）；② **真机导出**：`mstsc` → 本地资源 → 键盘 → "应用 Windows 组合键"的三档选项，逐档导出 `.rdp` 看实际写入值（即可确定 UI 三档与数值的映射）；③ 本仓库既有记录 `extensions/rdp/lib/rdpFile.mjs:179`（默认 `2`）作为旁证，但**不足以**定 `1`/`3` |

**条数核对**：字段级 **4** 条（`singleMonInWindowedMode`、`gatewayCredentialsSource`、`usbDeviceStoreDirect`、`cameraStoreDirect`）+ 取值级 **1** 条（`keyboardHook = 3`）= **5** 条，与 §5.3（4 个字段 key）和 §6.4（1 个取值）完全一致；`fieldDocs.test.js` 的"待确认清单恰为 4 个字段 + 1 个取值"断言即本节的机读形式。


