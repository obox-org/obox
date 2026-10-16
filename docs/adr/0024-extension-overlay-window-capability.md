# 扩展 `overlay` 窗体能力（透明 / 置顶 / 不占任务栏 / 可移动）与 `apiVersion` 升至 2

## 背景

1. **App 卡片窗不能满足"桌面宠物"这类形态。** 卡片窗本身就是无边框（`src/main/appWindow.ts` 的 `frame: false`），但**没有** `transparent` / `alwaysOnTop` / `skipTaskbar` / 初始坐标；且卡片必须出现在启动器里、被点击才打开（`api.app.register` → 卡片 → `openAppWindow`）。桌面宠物的要求正相反：**后台常驻、无入口、装完就出现、无边框透明置顶、不占任务栏、贴在屏幕角落**。
2. **扩展完全无法开关/移动自己的窗口。** 改动前 `api.app` 只有 `register` / `onMessage`（`src/api/types.ts`），宿主也没有对应的 IPC 面 ⇒ 扩展既不能创建第二个窗口，也不能销毁/移动它。
3. **"隐藏"在 obox 里应当等价于"关闭窗口"。** 用户对宠物扩展的硬约束是"隐藏就是关闭窗体，而不是隐藏窗体，降低 CPU 使用率"（grill Q2）。这要求宿主提供**真正的销毁**（而不是 `win.hide()`），并且销毁后窗口驱动的 rAF/定时器要随之停止。实测：窗体存活时约 296.9 ms/10s，销毁后回落到 ~15 ms/10s（仅剩扩展入口的结算 tick 与长轮询）。
4. **设置页缺"只读进度条"这类呈现。** 宠物有三条 0–100 的属性要展示为进度条 + `{cur}/100`，而既有字段类型只有 `text/number/boolean/select/directory/status`（+ `status` 上的 `modal`）。
5. **老宿主必须能明确拒绝新扩展。** 扩展一旦用了 `api.overlay` 或 `progress`，在没有这两项能力的宿主上会运行期撞 `undefined`（或把进度条降级成可编辑文本框）。清单里需要一个**可声明的最低宿主版本**机制，且已经存在：`core/manifest.ts:28-38` 对"高于宿主 API 版本"的清单直接判 error、拒绝加载。

**备选与否决理由**

| 备选 | 做什么 | 否决理由 |
| --- | --- | --- |
| **B：给 App 卡片加 `transparent/alwaysOnTop/anchor` 选项** | 复用卡片窗，只加几个参数 | 卡片语义（可点击入口、启动器可见、`appStore` 持久化、标题栏/主题桥）与桌面宠物冲突；宠物**不能**出现在启动器里，且要默认鼠标穿透、可整窗移动 —— 在卡片语义上叠这些开关会让两个概念互相污染 |
| **C：扩展侧用 `BrowserWindow` 之外的方案（如 CSS 在卡片内浮动）** | 不新增宿主能力，把宠物画在卡片/主窗口里 | 卡片必须被打开才有窗口；主窗口不可能"透明置顶贴在桌面右下角"；且无法实现"关 = 真销毁省 CPU" |
| **D：`api.app.createWindow`（挂 `api.app` 命名空间）** | 与既有 `api.app` 放一起 | `api.app` 的既有语义是"App 卡片"（`register` 的入参就是卡片元数据、卡片进启动器）。把"后台无入口窗体"塞进同一命名空间会让 `api.app` 一句话说不清；独立 `api.overlay` 命名空间可按 id 限定作用域 |
| **E：`apiVersion` 不升，只靠"文档写明需要新宿主"** | 省一次版本递增 | 老宿主会**静默**降级（`api.overlay` 为 `undefined` ⇒ 扩展抛错；`progress` 字段降级成可编辑 text），用户看到的是"扩展坏了"而不是"宿主太老" |

## 决策

1. **新增扩展 API 命名空间 `api.overlay`（四个方法，均按 `extId` 限定作用域）**：
   - `create(options: CreateOverlayRequest): Promise<OverlayResult>` —— 创建窗体；`options` = `{ id, url, width, height, anchor, margin?, transparent?, alwaysOnTop?, skipTaskbar? }`，`anchor ∈ { bottom-right, bottom-left, top-right, top-left }` 由宿主按**主显示器工作区**折算坐标（扩展拿不到 workArea）；
   - `destroy(id)` —— **真销毁**（不是 `hide()`），幂等；pending 的消息请求以「overlay 窗体已销毁」立即结算；
   - `setMouseThrough(id, through)` —— 整窗 `win.setIgnoreMouseEvents(through, { forward: true })`（平台 `darwin`/`win32`）；**Electron 没有逐像素穿透**，这是已知取舍；
   - `setPosition(id, x, y)` —— 运行期移动（拖动换位用）；坐标**必须为有限数字**，非法直接拒绝（**不钳不猜**）；合法但越界由宿主**兜底**钳到主显示器工作区。`OverlayResult.position?: { x, y }` 在 `create` 与 `setPosition` 成功时回传**实际坐标**，作为扩展侧的绝对基准。
2. **overlay 窗体是"第三类窗口"**：不进启动器、不写 `appStore`、不作为卡片；查询串 `?obox-window=overlay&extId=…&overlayId=…&appId=…&url=…`；外壳复用但 **overlay 模式不渲染 TitleBar/PromptHost、不接主题推送**（`pushThemeTokens()` 对无 registration 的情况直接返回），页面需要主题只能走消息桥。`url` 与卡片路径**同判据双重校验**（主进程 + 外壳各一次：`app://` + host ∈ {extensions,builtin,debug} + 路径首段 = extId + 有子路径 + 拒 `..`）。
3. **消息桥复用 `api.app.onMessage`**：宿主按 `extId` 路由（先查卡片、未命中按 overlayId 查 `overlayOwners`）；单次请求 60 s 超时不变 ⇒ **扩展侧的长轮询 hold MUST 显著小于 60 s**（宠物用 25 s，页面侧本地 35 s 超时后重订阅）。
4. **生命周期由宿主兜底回收**：扩展停用/卸载、主窗口关闭时一并销毁其全部 overlay（幂等）；创建失败返回 `{ ok:false, error }`，不抛。
5. **新增设置字段类型 `progress`（只读）**：`SettingField` 增 `max?: number`（缺省 100）；渲染为 `role="progressbar"` 槽 + 填充（条宽用**未取整**真实比例）+ 右侧 `{cur}/{max}`（`{cur}` 显示为 `Math.floor(clamp(v, 0, max))`）；**不渲染 `description`**；非数字按 0 + 一条按 slot 去重的 warn；样式**只用既有主题 token**（`--bg-input`/`--accent`/`--border`/`--font-size-sm`），零新增 token、零写死色值。
6. **`apiVersion` 由 1 升到 2**（根 `package.json` 单源）：v2 = `api.overlay` + `progress`（**纯加法**，无破坏性签名变更）。递增目的是给扩展一个**可声明的最低宿主版本门槛**：用这两项能力的扩展写 `apiVersion: 2`，老宿主读到 2 按 `core/manifest.ts:28-38` **直接拒绝加载**（清单无效、管理器标红、入口根本不执行）。不声明或声明 1 的既有扩展在每个宿主上照常加载。
7. **`scripts/validate-manifest.mjs` 增加 settings 静态校验（脚本独有的收紧）**：类型白名单（含 `progress`，与 `SettingFieldType` 逐字同序）、`key`/`label` 非空、`max` 出现必须为 >0 的有限数字、`progress` 的 `default` 出现必须为数字（越界不报错，渲染时钳制）。宿主运行期对未知类型走兜底渲染而非清单 error ⇒ **刻意的"脚本严于宿主"**，理由与差分 fixture 不受影响已写进脚本与 `test/manifest-script-parity.test.ts` 注释。

## 后果

- **好处**：obox 有了"后台无入口窗体"这一等公民（桌面宠物、悬浮挂件、状态浮层都可用它）；扩展可真正**销毁**窗口把 CPU 还给用户（实测 296.9 → 15.6 ms/10s，且"关窗不停结算"由扩展自理）；`setPosition` 让"拖动换位"不需要新协议（增量 + 宿主钳位）；`progress` 让只读数值有了合适的呈现；`apiVersion` 让"宿主太老"在**加载前**就报清楚。
- **代价**：宿主新增 1 个命名空间（4 方法）、1 条 IPC 面、1 种设置字段类型；外壳要同时服务卡片窗与 overlay（用 `isOverlay` 单开关 + 根 class 隔离，**改错会影响既有 rdp/webapp 卡片窗** ⇒ 回归项已固定为"卡片窗仍有标题栏、背景不透明"的断言 + 截图对比）；`apiVersion` 递增会让"声明 2 的扩展"在所有旧宿主上不可用（这是**目的**，但升级路径要写在扩展 README 里）。
- **风险与退路**：
  - **无逐像素穿透**：整窗切换意味着"指针在宠物上"期间窗体空白区也会捕获点击（已知取舍，已在 `troubleshooting.md` 记为排查项）。退路：将来若要逐像素，需要基于 `setShape`/区域命中或改用多个小窗，属独立演进。
  - **`forward: true` 对注入式合成输入间歇性不转发**（本机实测 5 组中 3 组为 0，根因未查明，疑虚拟显示/远控输入栈）⇒ 自动化验收不可据此判失败，须用真实鼠标或 `WindowFromPoint` 复核。已写进 `troubleshooting.md`。
  - **透明窗体的平台限制**（DWM 被关则透明失效、`transparent` 不可运行期切换、全屏独占可能被遮、开 DevTools 变不透明）与"多显示器/混合 DPI 未实机验证"逐条写在 `docs/extension-api/troubleshooting.md` 与宠物扩展 README。
  - **`core/manifest.ts` 仍不校验 settings**（只有脚本收紧）：若将来要求两侧对齐，需另开改动同时补 parity fixture。
