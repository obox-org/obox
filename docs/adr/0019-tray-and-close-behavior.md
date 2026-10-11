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
- **`--debug-extension` 在单实例下会被忽略**（需在 troubleshooting 里写明），开机自启本期不做。
- 验收以**真机（Windows）**为准：任务栏无图标、托盘图标与四项菜单、单击/双击、关闭三态（含勾选记住）、最小化收托盘、子窗口仍在任务栏、第二实例唤前台、托盘退出后无孤儿 Python 进程、设置-通用项即时生效、关于显示版本。
