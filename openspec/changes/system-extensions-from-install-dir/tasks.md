# Tasks

## 1. 双根扫描与 id 规则（主进程）

- [x] 1.1 `paths.ts` 增加 `getSystemExtensionsDir()`（`<installDir>/extensions`，dev 用仓库 `extensions/`）并把用户根保持为 `<userData>/extensions`；验证：单测断言 dev/prod 两个返回值
- [x] 1.2 实现 `scanExtensions()`：先系统根后用户根，按目录名取 id，跨根同 id 标 `shadowed`；验证：单测覆盖"只在系统""只在用户""两处同名""同根重复"
- [x] 1.3 目录名与清单一致性校验（系统 `author=obox` 且 `id=name`；用户 `id=<name>.<author>`）；验证：单测给出不一致时的可读错误
- [x] 1.4 `extensions:list-user` 改为返回 `{id, source, dir, shadowed}`（IPC + `shared/types` 同步）；验证：单测断言字段与顺序
- [x] 1.5 旧下划线目录跳过并记一次日志；验证：单测断言不加载且只 warn 一次

## 2. 数据根解耦

- [x] 2.1 `extensionDataDirOf` 改为按 id 拼 `<userData>/extensions/<id>/data`（宿主侧），main 的 fs/sqlite/python 保持同一算式；验证：单测断言两处逐字相等（含系统扩展 id）
- [x] 2.2 宿主 `init` 不再用 `ext.path` 推导数据目录；验证：接缝测试用系统根路径传入，断言数据仍落在 userData
- [x] 2.3 文档 `docs/extension-api/api-reference.md` 写明"代码在安装目录、数据在 userData"；验证：文档含该句与示例

## 3. 协议与权限

- [x] 3.1 `protocol.ts`：`app://extensions/<id>` 按扫描表解析根；`app://builtin/<id>` 指向系统根；验证：单测覆盖两个根与越界 403
- [x] 3.2 `extensions:uninstall` 与宿主/渲染的 `setEnabled` 对 `source==='system'` 拒绝；验证：单测断言返回「系统扩展不可卸载/不可禁用」
- [x] 3.3 overlay URL 允许范围随 id 规则更新（`app://extensions/<id>` 与 `<installDir>` 根）；验证：既有 overlay-window 用例全绿 + 新增系统根用例

## 4. 打包链

- [ ] 4.1 三个系统扩展各自加 `vite build` 配置，输出 `.build/extensions/<name>/`；验证：`npm run build` 后三个目录各有 `index.html` 与 manifest
- [ ] 4.2 `electron-builder.yml` 增加 `extraFiles`（`.build/extensions` → `extensions`）；验证：`--dir` 打包产物里 `<installDir>/extensions/settings` 存在
- [ ] 4.3 `/extensions/` 的 gitignore 规则调整：系统扩展目录（`extensions/settings` 等）入库，用户扩展仓库仍忽略；验证：`git check-ignore` 对两者分别成立

## 5. 公共 API 增量

- [ ] 5.1 `api.settings.host.*`（get/set/onChanged）+ `api.theme.*` + `api.keybindings.*`；验证：单测 + 文档条目
- [ ] 5.2 `api.extensions.*`（list/setEnabled/uninstall/restartHost）与 `api.apps.list` / `api.commands.*` / `api.pages.open`；验证：单测 + 文档条目
- [x] 5.3 `apiVersion` +1（3 → 4）并同步 `core/manifest.ts`、`scripts/validate-manifest.mjs` 与 parity 测试；验证：`npm test` 中 parity 用例全绿
- [ ] 5.4 `docs/extension-api/` 记录新能力与"对所有扩展开放"的信任模型说明；验证：文档含信任模型段落

## 6. 三个系统扩展迁移

- [ ] 6.1 `ext-manager`：迁到 `extensions/ext-manager/`，改为独立页面，用公共 API 实现列表/装/卸/启停；验证：真机可安装、禁用、卸载用户扩展，系统扩展无卸载按钮
- [ ] 6.2 `settings`：迁到 `extensions/settings/`，用公共 API 读写宿主设置/主题/快捷键；验证：改代理与主题即时生效
- [ ] 6.3 `app`：迁到 `extensions/app/`，用 `api.apps.list` 渲染首页；验证：首页卡片与命令面板可用
- [ ] 6.4 外壳兜底：`App.vue` 缺失系统 `app` 扩展时显示错误页；验证：单测（源码门禁）+ 手工删除 `.build/extensions/app` 后启动
- [ ] 6.5 源码门禁：三个系统扩展不得 import 渲染进程内部单例；验证：新增测试扫描 import 并失败

## 7. 集成与发版

- [ ] 7.1 全量门槛：`npm run typecheck` / `lint` / `npm test` / `npm run build` 全绿
- [ ] 7.2 真机验收：安装包安装后，安装目录存在 `extensions/{settings,app,ext-manager}`；管理器显示三者「系统扩展」；用户扩展仍可装卸
- [ ] 7.3 发版：版本 +1（minor）、`docs/update-and-release-verification.md` 记录发版数据与"不迁移"的兼容说明
