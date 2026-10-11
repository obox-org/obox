# 托盘常驻与关闭行为（Windows）

## 背景

obox 主窗口是常规窗口（`src/main/window.ts:26` 创建，未设 `skipTaskbar`），关窗即退出（`src/main/index.ts:95-99` 的 `window-all-closed → app.quit()`）；仓内**没有**托盘、单实例锁，也没有任何退出期清理钩子（扩展资源清理只挂在渲染进程热移除的 `extension:cleanup` IPC 上）。

需求：**任务栏不显示图标，改为常驻系统托盘**，右键有 打开/设置/关于/退出，双击打开 obox；并让用户能选择"关闭时到底是退出还是收进托盘"。

相关决策：ADR-0001（渲染进程扩展宿主）、ADR-0012（`api.window.create` 不做，多窗口由 App 子窗口覆盖）、ADR-0015（扩展受信，能力不是安全边界）。

## 决策

1. **平台范围：仅 Windows**（`process.platform === 'win32'`）。托盘创建与 `skipTaskbar` 都在该分支下生效，mac/Linux 行为不变——macOS 需要 `app.dock` 另一套语义，Linux 托盘依赖桌面环境扩展，本期不做以免半成品。
2. **任务栏隐藏只有主窗口**（建窗即 `skipTaskbar: true`）。App 子窗口保持现状：用户从"应用"打开的卡片窗口仍应在任务栏可见、可切换；主窗口收进托盘时**不联动隐藏**子窗口。
3. **托盘**：`Tray` + 专用 `resources/tray.ico`（16/20/24/32 多尺寸，由 `build/icon.png` 经 `png-to-ico` 生成；`asarUnpack: resources/**` 已覆盖）。tooltip = `<应用名> <版本>`；**单击弹菜单、双击打开主窗口**（用双击间隔区分，避免单击时先弹菜单）。
4. **托盘菜单四项**：打开、设置、关于、退出。打开**恒为"打开"**（`show()+restore()+focus()`，不随窗口可见性变文案）；退出**不再二次确认**。
5. **关闭行为是三态用户偏好**：`询问`（默认）/ `收进托盘` / `退出`。关闭按钮与最小化按钮都按它处理；`询问` 时用 **Electron 原生** `dialog.showMessageBox`（`checkboxLabel` = 记住我的选择；按钮 收进托盘 / 退出 / 取消；`cancelId` = 取消、`defaultId` = 收进托盘），**勾选后点击即写入偏好**；取消 = 什么都不做。最小化**静默**收进托盘（不弹提示）。
6. **收进托盘 = `hide()`**（不销毁，窗口与渲染进程状态保留），托盘"打开"还原它。真正退出必须绕过关闭拦截：主进程用 `quitting` 标志，否则"退出"会被自己的拦截吞掉。
7. **偏好由主进程持有**：`userData/window-behavior.json`（先例 `secrets.json`）。理由：关闭/最小化拦截发生在主进程且必须**同步**决策，而主进程当前读不到渲染进程设置（`stateStore` 在 localStorage，无读取通道）。渲染进程设置页经**新增 IPC** 读写，主进程是唯一权威。设置项放**新增的"通用"分区**，且**仅 Windows 显示**（`window.api.env.platform`）。
8. **托盘"设置"= 打开主窗口并切到设置页**：切页状态是 `App.vue` 的局部 ref，主进程无法直接切，因此新增一条 main→renderer 事件 `nav:open`，由 `App.vue` 订阅后 `selectNav(id)`。托盘"关于"用原生对话框显示 `app.getVersion()`。
9. **单实例**：`requestSingleInstanceLock()`。第二实例的**启动参数被忽略**（主进程日志明确打印被忽略的参数），只把已有主窗口唤到前台——参数转发（如动态追加 `--debug-extension`）需要合并/去重语义，属独立设计。
10. **退出清理**：`before-quit` 遍历"已知扩展"调用**与 `extension:cleanup` 同一组清理函数**（定时器 / SQLite 句柄 / 文件监听 / 系统通知 / IPC 通道 / Python 进程树 `taskkill`），3 秒超时兜底、失败仅日志。系统关机/注销**不阻塞**。
11. **核心逻辑 electron-free**：`windowBehaviorCore.ts`（偏好解析、关闭决策矩阵、提示文案与按钮、勾选语义）与 `trayCore.ts`（菜单项与 tooltip）可确定性单测；`windowBehavior.ts` / `tray.ts` 只做 Electron 接线与 IO。

## 备选与否决

- **应用内自绘弹窗**（含复用现有 `PromptHost`）：需要新模态组件（焦点陷阱、Esc、i18n），且渲染进程无响应时无法决策；原生对话框原生支持勾选框与 `cancelId`，成本最低。
- **偏好双写**（渲染进程 `stateStore` 为主 + 主进程缓存）：两份状态容易长期不一致；主进程自持 + IPC 读写只有一处权威。
- **默认收进托盘且不询问**：与"让用户知道 obox 常驻托盘"的目标相悖（关窗即消失、无任何提示）。
- **托盘图标复用 `resources/icon.png`**：缩到 16px 易糊；常驻可见的图标值得一份专用多尺寸资源。
- **非 Windows 一并实现**：见决策 1。
- **第二实例参数转发**：见决策 9。

## 后果

- **关窗不再等于退出**：行为由偏好决定，退出走托盘菜单或偏好=退出；`window-all-closed → app.quit()` 需要按"是否存在托盘"守卫。
- 新增：一个偏好文件、两条 IPC（`getCloseBehavior`/`setCloseBehavior`）、一条 main→renderer 事件（`nav:open`）、设置树新增"通用"分区。
- **`--debug-extension` 在单实例下会被忽略**（需在 troubleshooting 里写明），开机自启已在后续修订中落地（见文末"修订"一节）。
- 验收以**真机（Windows）**为准：任务栏无图标、托盘图标与四项菜单、单击/双击、关闭三态（含勾选记住）、最小化收托盘、子窗口仍在任务栏、第二实例唤前台、托盘退出后无孤儿 Python 进程、设置-通用项即时生效、关于显示版本。

## 验收记录（2026-10-11，Windows 本机）

**自动验证**（用调试扩展直接驱动 `window.api`，避免人工点击）：

- 偏好读写：`window-behavior.json` 写入后读回一致；文件缺失/损坏回落默认 `ask`；
- 偏好 `hide`：触发关闭后渲染进程**存活**、electron 进程仍在 → 窗口被隐藏而非退出。这条路径**只有托盘创建成功**（`trayAvailable()` 为真）才会走到，因此同时验证了托盘已建立；
- 偏好 `quit`：应用**真退出**（渲染进程终止、进程数 0）；
- 偏好 `ask`：关闭被拦住、进程存活（原生提示由主进程弹出）；
- 单实例：已有实例在跑时第二个进程立即退出，日志打印 `[single-instance] …本次启动的参数被忽略（…）`（开关**连同其值**）；
- 退出清理：走"偏好=退出 → 关窗"路径时打印 `[quit] 主进程资源清理完成：N 个扩展`，退出后无残留 electron 进程。

**人工验收**（项目所有者，本机）：任务栏不显示 obox 图标、托盘图标存在、右键菜单四项（打开/设置/关于/退出）、单击弹出菜单、双击打开主窗口、关闭时的原生提示框与三个按钮、设置-通用里的关闭行为项生效。

**已知未覆盖**：非 Windows 平台（本 ADR 明确不改其行为，代码以 `process.platform === 'win32'` 为界）；开机自启（已在后续修订中落地）。

## 修订：开机自启（决策 12–16，2026-10-11 落地）

12. **仅 Windows**（与托盘同范围）、**默认关**、在 设置-通用 配置。**开发版禁用该开关**：开发版的
    `process.execPath` 是 `node_modules/electron/dist/electron.exe`，注册只会留下无效启动项。
13. **开机启动是静默的**：Electron 44 已**移除 `openAsHidden`**（官方 breaking changes），Windows 也没有
    "本次是否由登录项启动"的 API（`wasOpenedAtLogin` 仅 macOS）→ 注册项带 `--autostart`，启动时识别该参数：
    不显示主窗口、只创建托盘、不弹提示。**`--autostart` 拉起的第二实例静默退出、不唤前台**（否则开机时会抢焦点）。
14. **系统真实状态是权威**：写 `setLoginItemSettings({ openAtLogin, path: process.execPath, args: ['--autostart'],
name: 'com.obox.app', enabled: true })`；读必须传**同样的 path/args**（d.ts 明确：不传同样的参数
    `openAtLogin` 就不准），并结合 `launchItems[].enabled` 判断任务管理器是否禁用了它（Run 值可以仍在，
    用户看到的却是"已禁用"）。读到即回写偏好；设置失败时**开关回弹到真实状态 + 就地显示原因**。
15. **卸载清理**：NSIS `customUnInstall`（`build/installer.nsh`，经 `nsis.include` 挂载）删除 Run 值与
    StartupApproved 值，避免任务管理器残留指向已删除 exe 的条目。
16. **偏好文件更名** `window-behavior.json` → `app-preferences.json`（内容已不止窗口行为），启动时读一次旧文件
    后迁移并删除；同时修掉"写关闭行为时整对象覆盖、会抹掉其它偏好字段"的既有缺陷。

**本次明确不做**：macOS/Linux 的开机自启（需 Login Items / `.desktop`，本机无法验证）；启动时的其它自动动作（如自动检查更新）。
