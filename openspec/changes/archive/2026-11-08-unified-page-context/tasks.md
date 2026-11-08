# Tasks

## 1. 上下文协议与纯逻辑

- [x] 1.1 新增 `src/shared/pageContext.ts`：定义 `obox:context` / `obox:context-request` 的消息类型、`PAGE_CONTEXT_VERSION`、`isPageContext` / `isContextRequest` / `buildPageContext`（过滤非法 token 名与非字符串值），并在 `test/page-context.test.ts` 覆盖合法/非法载荷、空 `messages`、未知字段忽略
- [x] 1.2 新增 `src/renderer/src/core/pageContext.ts`：从 `themeStore`（25 个生效 token + `colorScheme`）与 `extensionI18n`（按扩展 id 取当前语言整包）组装上下文，提供 `pushContext(win, extId)` 与"当前上下文快照"，单测验证 `colorScheme` 取值优先级（主题声明 > id 推断）与"只包含本扩展词条"
- [x] 1.3 主题贡献点支持可选 `colorScheme`（`src/api/contributions.ts` + 两个内置主题 manifest 显式声明），并让 `themeStore` 快照带上它；单测覆盖声明/未声明/`light` id 三种情况

## 2. 推送到三种页面容器

- [x] 2.1 `src/renderer/src/components/ContentArea.vue`：iframe load、主题变化（`settings` 的 `theme` 键）、语言变化、收到 `obox:context-request` 四个时机推送 `obox:context`；组件测试或事件单测验证"切主题后再次推送"
- [x] 2.2 `src/renderer/src/AppWindow.vue`：`url` 卡片与 overlay 改用同一条上下文推送，保留旧 `obox-theme` 消息（双发）；验证既有 `test/app-theme.test.ts` 不回归，并补"上下文与旧消息同时到达"的用例
- [x] 2.3 旧协议双发顺序与静默忽略：旧消息先发、`obox:context` 后发；文档写明页面必须忽略未知 `type`；用单测断言两种消息都被投递

## 3. 宿主页面运行时

- [x] 3.1 新增 `src/page-runtime/page.js`（无 Node API，只碰 DOM 与 `postMessage`）：`startPageContext({ onChange })` 完成 token 写入、`colorScheme`、`t(key, params)`、0/300/1000ms 请求重试、同值去重；用注入的假 `window`/`parent`/`document` 写单测覆盖"收到即停""重复上下文不重复写 DOM""缺 key 回退并 warn"
- [x] 3.2 `src/main/protocol.ts` 增加 `app://obox/` 命名空间指向运行时构建产物；`electron-builder.yml`/`scripts` 确保该产物随包分发；用协议单测或打包冒烟验证 `app://obox/page.js` 可 200 加载且 `..`/非法转义仍被拒绝
- [x] 3.3 运行时在老宿主下降级：1.5s 未收到上下文时使用内置默认 token 并只 warn 一次；单测覆盖"一直无消息"与"迟到消息"两条路径

## 4. 扩展标签本地化（`%key%`）

- [x] 4.1 新增 `%key%` 解析器（纯函数，输入原文 + 扩展 id + locale）：普通字符串原样返回、命中返回词条、缺失返回占位符原文并每扩展每 key 只 warn 一次；单测覆盖三种输入与告警去重
- [x] 4.2 壳子渲染点接入：`src/renderer/src/components/NavBar.vue`、`CommandPalette.vue`、`src/renderer/src/core/registry.ts` 的命令/状态栏标签、主题 `label`；单测或组件测试验证切换语言后标题变化
- [x] 4.3 对外数据先解析：`src/renderer/src/core/hostQueryDeps.ts` 的扩展列表（`displayName`/`description`）与设置页快照（扩展设置字段 `label`/`description`）在序列化前解析成本地化文本；单测断言页面拿到的是成品文本而非 `%key%`
- [x] 4.4 `titleKey` 降级：保持行为不变，代码注释与类型文档标注遗留；单测保证使用 `titleKey` 的既有扩展输出不变

## 5. 语言单一源与传播

- [x] 5.1 语言移入设置：`stateStore` 增加 `locale` 键，`src/renderer/src/i18n/index.ts` 改为读设置、旧 `obox:locale:v1` 一次性迁移并停用旧键；单测覆盖"首启默认 zh""迁移后不再读旧键""非法值回退 zh"
- [x] 5.2 切换传播：`i18n.setLocale` 写设置后，壳子 chrome、扩展宿主 snapshot（`onLocaleChanged`）、页面上下文三处同时更新；单测/集成测试断言宿主收到 `en` 且页面收到新 `locale`
- [x] 5.3 主进程跟随：preload 增加 locale 推送 IPC，main 缓存并在托盘/关窗提示/关于对话框使用；`src/main/trayCore.ts`、`windowBehaviorCore.ts` 的纯函数沿用现有 locale 参数，补"设置 en 而系统 zh 时输出英文"的单测

## 6. 三个系统扩展页面迁移

- [x] 6.1 `settings` 扩展：manifest 标签改 `%key%`、补 `contributes.i18n`（zh/en key 集合一致）、page.js 删自建主题收包、全部中文字面量换 `t()`；验证 `openspec` 不适用、跑 `test/system-extensions-independence.test.ts` 并按截图核对中英两套文案
- [x] 6.2 `app` 扩展：同上（卡片列表/空态/右键菜单文案），验证切换语言与主题后页面即时变化
- [x] 6.3 `ext-manager` 扩展：同上（列表/详情/卸载确认/安装结果文案），验证 `displayName` 与字段标签随语言变化
- [x] 6.4 `scripts/validate-manifest.mjs` 增加 `contributes.i18n` 的 zh/en key 集合一致性校验，并同步 `test/manifest-script-parity.test.ts` 差分门禁

## 7. 文档与 README

- [x] 7.1 重写 `docs/extension-api/themes-settings.md` 的主题协议章节：`obox:context` 契约、页面运行时用法、`colorScheme`、四时机、旧协议保留期；删除与代码漂移的 overlay 描述；验证文档中的示例代码在示例页里可运行
- [x] 7.2 `docs/extension-api/manifest-reference.md`：`contributes.i18n` 用途扩大、`%key%` 规则与缺 key 行为、`titleKey` 标注遗留；`guides-user.md`/`guides-builtin.md` 补最小示例
- [x] 7.3 `docs/extension-api/troubleshooting.md` 增加条目：页面主题不跟随 / 文案显示 `%key%` / 老宿主降级；`docs/extension-api/api-reference.md` 的 `api.theme` 段落说明 `colorScheme`
- [x] 7.4 `README.md` 更新目录树（新增 `src/shared/pageContext.ts`、`src/page-runtime/`）与扩展页面上下文一句话说明

## 8. 集成验收

- [x] 8.1 `npm run typecheck` + `npm run lint` + `npm test` 全绿，并且新增测试覆盖 proposal 中每个 capability 的至少一条场景
- [x] 8.2 真机验证（dev 窗口，CDP 断言）：三个系统扩展页（应用/设置/扩展）主题 × 语言两轮来回 13/13 + 15/15；App `url` 卡片窗口（临时调试扩展）主题/旧协议/上下文/locale 8/8；overlay 窗口 token（主进程链路）+ 新旧协议 3/3；优雅退出后重启，`theme-light` + `en` 从设置恢复（`--bg` 浅色、页面标题 `Apps`）。托盘菜单文案由 `main-locale` 单测（`trayMenuItems(getMainLocale())` 英文输出）+ `locale:apply` 源码门禁覆盖，**托盘 UI 未目视**
- [x] 8.3 兼容验证：pet overlay（只实现旧协议的已发布页面）仍收到旧 `obox-theme` 且主题跟随；新页面在旧宿主（≤2.3.x）的降级路径由 `test/page-runtime.test.ts` 覆盖（1.5s 内无上下文 → 默认 token/zh + 只 warn 一次，不抛错）；**未实际安装 ≤2.3.x 宿主**

## Workflow follow-up

- 旧协议（`obox-theme` 与 `{type:'obox-theme'}`）在一个 minor 版本后删除，另开 change 并在 `troubleshooting` 记录退场时间点。
- 语言迁移的旧键读取代码在下一个 minor 版本删除。
