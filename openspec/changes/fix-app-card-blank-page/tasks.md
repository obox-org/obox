# Tasks

## 1. 归一化纯函数

- [ ] 1.1 新增 `src/renderer/src/core/appPageUrl.ts`：`normalizeCardUrl(raw)` 返回 `{ kind: 'ok', url } | { kind: 'normalized', url, from } | { kind: 'unusable', reason }`；规则：`app:` 且 host ∈ {extensions, builtin, debug} ⇒ ok；`file:` 且路径含 `/extensions/<段>/` ⇒ normalized（产出 `app://extensions/<段>/<余下>`）；其余 ⇒ unusable（带人话原因）
- [ ] 1.2 单测 `test/app-page-url.test.ts`：Windows 正/反斜杠、URL 编码空格、`..` 段拒绝、`app://` 三 host、`http(s)`/`data:`/空串、`file://` 不在 extensions 下、非 ASCII 目录名

## 2. 窗口接线

- [ ] 2.1 `src/renderer/src/AppWindow.vue`：`iframeSrc` 改为经 `normalizeCardUrl`；`kind === 'unusable'` 时**不渲染 iframe**，渲染诊断块（应用名、原始 url、原因、修复提示）；overlay 分支保持"不画像素"，只告警
- [ ] 2.2 告警去重：模块内 `Set`，键 = `appId|原始地址`，`[AppWindow]` 前缀；`normalized` 与 `unusable` 各一条
- [ ] 2.3 `.app-frame` 底色改为 `var(--bg, #1e1e1e)`
- [ ] 2.4 诊断块样式走既有 token（`--bg-panel`/`--fg`/`--fg-dim`/`--border`），并把原始地址渲染成可选中文本

## 3. 文案与 i18n

- [ ] 3.1 `src/renderer/src/i18n/locales/{zh,en}.ts` 增加 `appExt.loadFailed.*`：标题、原因（协议不符 / file 无法判定 / 其它）、提示、复制地址按钮文案
- [ ] 3.2 单测断言 zh/en 键集合一致（沿用既有 i18n 门禁模式）

## 4. 文档

- [ ] 4.1 `docs/extension-api/troubleshooting.md` 增加新条目「App 卡片打开是白色空白页」：成因（`file://` + CSP）、自查（DevTools 看 iframe src、看 `[AppWindow]` 告警）、修法（`appPageUrl()`）
- [ ] 4.2 `docs/extension-api/guides-user.md` §4 把"卡片 `url` 必须是 `app://…`"写成硬要求，并给出 `appPageUrl()` 片段；`themes-settings.md` 不涉及
- [ ] 4.3 `docs/extension-api/api-reference.md` 的 `app.register` 段落补一句：非 `app://` 的 `url` 会被宿主判定为不可用并显示诊断

## 5. 验收

- [ ] 5.1 `npm run typecheck` + `npm run lint`（0 error）+ `npm test` 全绿
- [ ] 5.2 真机：把已安装的 `rdp.chenzhi`（旧构建、`file://` 卡片）打开，确认页面正常渲染且控制台有一条归一化警告
- [ ] 5.3 真机：临时注册一个 `https://` 卡片，确认显示诊断块（不是白屏）且 iframe 未创建
- [ ] 5.4 真机：深色/浅色主题下确认 iframe 底色跟随（不再纯白）
