# `url` 型 App 子窗口的主题 token 下发与跨窗口主题同步

## 背景

1. **`url` 型 App 卡片拿不到主题 token。** 主题 token 由 `themeStore.apply()` 写到**当前窗口**的 `document.documentElement`（`src/renderer/src/core/theme.ts:50-55`），而 `AppWindow.vue` 里唯一的 token 注入点是 `iframeSrcdoc`，它在卡片提供 `url` 时恒为 `undefined`（`src/renderer/src/AppWindow.vue`）。`url` 型卡片（如 RDP 扩展的 `ui/index.html`）加载的是 `app://extensions|debug/<id>/…`，与父文档（dev `http://localhost:5173`、打包 `file://`）**跨源** ⇒ ① `iframe.contentDocument` 恒为 `null`，宿主**无法**注入 `<style>`（`sandbox` 的 `allow-same-origin` 只让 iframe 保留它**自己的** `app://` 源）；② CSS 自定义属性**不跨文档继承**（`srcdoc` 能生效，是因为 token 被拼进了**同一份**文档的 HTML）。因此这一路径今天完全拿不到 token，把 `styles.css` 改成 `var(--token)` 只会让**每个变量都落到初始值**。
2. **跨窗口主题变化没有任何通知通道（既有缺陷）。** 子窗口是独立 `BrowserWindow`，加载同一份 `renderer/index.html`（仅 query 不同），模块级状态各自一份。主窗口 `themeStore.setTheme()` 只改主窗口的 `stateStore` 与 `:root`；子窗口的 `stateStore`（`core/state.ts` 此前**没有** `storage` 监听）与 `themeStore.themes` 都不变，`src/main/**` 也没有 settings/theme 广播。因此**主窗口切主题时，连 `srcdoc` 卡片都不会即时跟随**（只有重开子窗口才对）——这条既有结论此前被文档误记，本 ADR 一并修正。
3. **扩展侧取不到 token 值。** `api.theme.getCurrent()` / `onChanged()` 只给主题 **id**（`src/renderer/src/core/host.ts:527-547`）；子窗口里**没有** `api` 对象（`host.ts` 只注册贡献点、不激活扩展）；既有子窗口 ↔ 扩展桥只有 `obox-extension` / `obox-extension-reply` 两种 action，且它要经**主进程** IPC（60 s 超时）而 handler 在**主窗口**的扩展代码里，主窗口同样拿不到 token 值。

**备选与否决理由**

| 备选                                    | 做什么                                                                                   | 否决理由                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **B：扩展自带"深/浅"两套 token 副本**   | 不动宿主；扩展按 `api.theme.getCurrent()` 的 id 或 `prefers-color-scheme` 选一份自备色表 | ① id 送进 iframe **仍然**需要一个通道；② 扩展维护副本必然与宿主漂移；③ 只能覆盖深/浅两档，第三方主题无法跟随；④ 仍然要改宿主 |
| **C：只 token 化 CSS + 写死 fallback**  | `var(--token, <当前深色值>)`                                                             | 不满足"切换主题立即生效"（今天固定深色）；变成"预备好但未生效"                                                               |
| **D：在 `app://` 协议层注入 `<style>`** | 主进程改写返回的 HTML 插入 token                                                         | 治本但成本高（解析/改写 HTML、缓存与编码、dev 与 packaged 两种父文档场景）；本次不采用，列为**退场条件**                     |

## 决策

1. **宿主单向推送主题消息**（渲染进程 ↔ iframe 直连，**不新增 IPC、不新增扩展 API**）：
   - 宿主 → 子窗口：`{ source:'obox-app', action:'obox-theme', themeId, tokens }`
   - 子窗口 → 宿主：`{ source:'obox-app', action:'obox-theme-request' }`（**不带** `requestId`：这是"通知 + 请求重发"，不是请求-响应，故不新增 reply 动作）
   - 触发时机三个：iframe `load` 完成、主题变化、收到 `obox-theme-request`。协议常量、载荷过滤与 `:key` 计算集中在**零 import 的纯模块** `src/renderer/src/core/appTheme.ts`（`sanitizeThemeTokens` / `collectThemeTokens` / `buildThemeMessage` / `isThemePush` / `isThemeRequest` / `appFrameKey`）。
   - 来源校验用 `event.source === frameRef.value?.contentWindow`（宿主侧）与 `event.source === window.parent`（扩展侧），**不**校验 `event.origin`：`app://` 的 origin 字符串在各平台/版本上的规范化不确定，同一性判据更稳。
2. **下发的 `tokens` 是"生效值快照"**：`HOST_THEME_TOKEN_NAMES`（25 个，逐条对齐 `src/renderer/src/assets/main.css:2-29`）在宿主 `document.documentElement` 上用 `getComputedStyle` 逐个读值（`collectThemeTokens`），即"`main.css` 默认值 + 当前主题覆盖（+ 上一主题的残留）"。**不**只发 `themeStore.current.tokens`（那是主题**声明值**，部分主题只覆盖少数键，子窗口拿到后其余 token 仍为空）。快照每次推送前现算，不缓存。非法键名 / 非字符串 / 空串在构造时丢弃（扩展侧再过滤一次，双保险）。
3. **`url` 型卡片不再以主题为 `:key`，`srcdoc` 型保留重渲染**：`appFrameKey()` 对 `url` 卡片返回 `url:<url>`（**与 themeId 无关** ⇒ Vue 不重建 iframe ⇒ 页内表单内容不丢，主题靠推送更新），对 `srcdoc` 卡片返回 `srcdoc:<themeId>`（切主题换 key ⇒ 重建 ⇒ 重新拼 `<style>`）。
4. **跨窗口同步用 `storage` 事件**（两个窗口同源同 session ⇒ 共享 localStorage，`storage` 是 Chromium 的跨文档通知通道）：
   - `core/state.ts` 把 `load()` 的解析抽成纯函数 `parsePersistedState`，新增 `stateStore.applyExternal(raw): string[]`（解析 → **整体替换** `settings`/`disabledExtensions`/`notificationDisabledExtensions`/`memento` → 返回并逐个通知**变化了的** settings key）与纯函数 `diffSettingsKeys(before, after)`；
   - 浏览器侧（非 node 单测环境）安装 `storage` 监听：只认本 key + 字符串 `newValue`；`storage` 事件只在**其它**文档写入时触发，本窗口 `save()` 不自触发 ⇒ 无回环；
   - `AppWindow.vue` 订阅 `stateStore.onSettingsChanged`，只在 `key === 'theme'` 或 `key === undefined` 时 `refreshTheme()`：`themeStore.applyCurrent()`（用**子窗口自己**注册到的主题 token 应用到自己的 `:root`）→ 刷新本地 `themeId`/`themeTokens` 快照 → `pushThemeTokens()`。**子窗口绝不调 `themeStore.setTheme()`**（它会写 localStorage，反向污染主窗口的权威快照并造成事件来回）。
5. **扩展侧拿不到 token 时用内置兜底**（不报错、不空白）：`srcdoc`/`url` 页在收到推送前用自备兜底值，首帧即可读；3 次请求（0/300/1000 ms）无响应只 `console.warn` 一次。兜底表放在扩展的 JS 常量里，**不写进 CSS**（那会让"CSS 零色彩字面量"的门禁失真）。
6. **不改 `src/api/**`、`src/preload/**`、`src/main/**`、`src/shared/types.ts`**：无新 IPC、无新扩展 API。

## 后果

- **好处**：`url` 型 App 卡片（RDP 等）能跟随宿主的**每一个**主题（含第三方主题扩展），且切主题**不再重渲染** ⇒ 表单里正在填的内容不会被清空；一次修掉**所有** `url` 型卡片的同一缺陷；子窗口 chrome 与 `srcdoc` 卡片也顺带跟随主题（修掉背景 2 的既有缺陷）；扩展侧不需要维护 token 副本，只写标准 `var()`。
- **代价**：新增一条宿主 ↔ 子窗口协议（要文档化、要门禁）；新增"跨窗口设置快照合并"语义；下发的快照携带"上一主题残留"（一致性优先于洁癖，与主窗口所见一致）。
- **风险**：
  - `storage` 事件的跨窗口送达属 Chromium 标准行为，但**本仓库此前从未依赖过**。**退路**：改为主进程广播（`ipcMain` 收 → `webContents.send` 给所有窗口，仿 `src/main/fs.ts` 的 `broadcast()`），并同步新增 preload 方法与 `src/shared/types.ts` 类型；**该退路不影响本 ADR 的消息协议与扩展侧代码**，只需记明换了哪条通道。
  - `applyExternal` 是"整份快照替换"：若将来有两个窗口同时写 localStorage，后写的会覆盖先写的。现状下**子窗口从不写**（不激活扩展、不调 `setTheme`）⇒ 单写者，无冲突。
  - `url` 卡片不再重渲染 ⇒ 除 CSS 变量外，任何"依赖重载才更新"的页面状态不会更新。这是本决策**想要**的行为（表单内容不丢）；约束是"页面自身状态必须来自 CSS 变量而非 JS 快照"。
  - 扩展侧兜底表是宿主默认色的副本，宿主改默认色会漂移（只在"拿不到推送"时可见）；靠测试钉住**键集合**（`styles.css` 消费的 token ⊆ 兜底表键 ⊆ 宿主白名单），**值**的一致性由真机确认。
  - `color-scheme` 由 `themeId` 启发式决定（`/light/i` → `light`，否则 `dark`），对命名不含 light 的浅色主题可能不准（只影响 UA 绘制的原生控件/滚动条底色，不影响自绘配色）。

## 退场条件

1. 若改为在 `app://` 协议层注入 `<style>`（方案 D，治本），本推送机制与扩展侧兜底表都可删。
2. 若 `storage` 事件在目标平台/版本不可靠，改用**主进程广播**（同"风险"一节的退路），本 ADR 相应修订。
3. 若将来 `api.theme` 提供 `getTokens()`：主窗口侧扩展可用，但 `url` 子窗口**仍必须**靠推送（子窗口无 `api`）⇒ **不构成**本条的退场理由。
4. 若子窗口开始写 localStorage，"整份快照替换"必须改为按键合并（否则会出现互相覆盖）。

## 实测与验证

| 项                                      | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| token 白名单漂移门禁                    | `test/app-theme.test.ts`：读 `main.css` 的 `:root` 与 `HOST_THEME_TOKEN_NAMES` 比**集合与顺序**（25 个）→ 通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 消息构造 / 载荷过滤                     | 同文件：`collectThemeTokens`（跳过空值、只取白名单）、`buildThemeMessage`（`{source,action,themeId,tokens}` 逐字段）、`sanitizeThemeTokens`（丢弃非法键名/非字符串/空串）、`isThemePush`/`isThemeRequest`（拒绝 `null`/字符串/错 source/错 action/既有 `obox-extension(-reply)` 串消息）→ 通过                                                                                                                                                                                                                                                                                                 |
| **url 不重渲染 / srcdoc 仍重渲染**      | 同文件 3 例：`url` + 两个 themeId → **同一个** `appFrameKey`（Vue `:key` 不变 ⇒ 不重建）；`srcdoc` + 两个 themeId → **两个不同** key；无 url/html → 按 `srcdoc` 处理 → 通过                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 跨窗口快照合并                          | `test/state.test.ts` 新增 8 例：`parsePersistedState`（null/畸形 JSON/非对象/字段回落）、`diffSettingsKeys`（增删改值、顺序、深比较）、`applyExternal`（按变更 key 通知 / 无变化不通知 / 只改非主题键只通知该键 / 畸形快照不抛错）、浏览器侧 `storage` 监听（伪造 `window` 动态导入 → 非本 key 与 `newValue=null` 忽略、本 key 合并生效）→ 通过                                                                                                                                                                                                                                                |
| 接线门禁                                | `test/app-window-wiring.test.ts` 7 例（读源文件，去注释后断言）：iframe `:key="frameKey"` 且**不含** `:key="themeKey"`、`ref="frameRef"` + `@load="pushThemeTokens"`、`obox-theme-request` 分支 + `e.source !== frameRef.value?.contentWindow` 判据、`pushThemeTokens` 内有 `registration.value?.url` 守卫与可观测 warn、`refreshTheme` 只 `applyCurrent()` + 推送且全文**不含** `themeStore.setTheme`、首次加载在 setup 阶段同步取快照（`ref(themeStore.currentId)` + `readThemeTokens()`，且不再读 `themeStore.current?.tokens`）、`state.ts` 安装 `storage` 监听并调 `applyExternal` → 通过 |
| **不用真实 iframe / 不用 jsdom 的理由** | `app://` 协议由主进程注册（`src/main/protocol.ts`），真实 iframe 需要 Electron 多进程环境，单测无法复现；仓库也无 DOM 测试先例（`vitest` 是 `environment: 'node'`，无 `@vue/test-utils`/`jsdom`）。而"是否重渲染"在 Vue 里**完全由 `:key` 决定** ⇒ 把它落成纯函数 `appFrameKey` + 一条读源码的接线门禁是**等价且不脆弱**的验证；端到端由真机步骤确认                                                                                                                                                                                                                                           |
| 宿主门禁                                | `npm run typecheck` 通过（含 `vue-tsc` 模板检查）；`npm run lint` **0 error**；`npm test` **443 passed / 5 skipped**（39 passed files + 2 skipped files）；PR 的 CI `check` 通过后 squash 合并                                                                                                                                                                                                                                                                                                                                                                                                 |
| 真机（待补）                            | 验收步骤：① url 型卡片在 dark ↔ light（及所有已注册主题）下外观即刻跟随；② 表单填到一半切主题，内容**仍在**（不重渲染）；③ srcdoc 型卡片切主题**确实重建**；④ 跨窗口通道成立（子窗口日志出现 `[AppWindow] 下发主题 …`，iframe 内出现主题已应用日志）——若不成立按"退场条件 2"改主进程广播；⑤ 无宿主时（浏览器直开构建产物）深色兜底可读、不报错、不空白                                                                                                                                                                                                                                         |
