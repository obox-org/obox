# 更新与发布链路：验证清单与已知限制

本文档是**更新链路（检查 → 下载 → 安装）与发布流程的运行期验证清单**，以及三项**尚未端到端验证**的限制说明。
配套：[ADR-0007](adr/0007-update-provider-and-proxy.md)（更新提供者与代理决策）、[ADR-0008](adr/0008-branch-protection-and-pr-workflow.md)（发布走 tag + CI）。

> 标记约定：**【源码核验】**= 依据仓库代码或 `node_modules` 中 vendored 的 electron-updater 源码得出；
> **【运行期已验证】**= 本机或线上实际跑过；**【运行期未验证】**= 尚无实测。

## 1. 发布产物与更新元数据

- 工作流 `.github/workflows/release.yml`（`on.push.tags: v*`）在 `windows-latest` 上构建：
  `electron-builder --win nsis --x64 --arm64 --publish never`，输出到 runner 临时目录。
- 产物：`obox-<version>-x64-setup.exe`、`obox-<version>-arm64-setup.exe`、`latest.yml`、`*.blockmap`（差分更新用）。
- **Windows 下更新元数据只有一份 `latest.yml`**（`electron-builder` 不生成 `latest-arm64.yml`；两个架构的安装包都列在同一份 `files` 数组里），electron-updater 按机器架构挑选匹配产物。**【源码核验】**
- **`electron-builder` 还会额外产出一份"无架构后缀"的安装包，且 `latest.yml` 的 `path`/首个 `files` 条目指向它**——已在 v1.0.3–v1.0.9 **七次**发布中复现（七次均为同一形态，成因仍未查明）：

  | 版本                 | 无后缀（`path` 指向）         | x64                           | arm64                         |
  | -------------------- | ----------------------------- | ----------------------------- | ----------------------------- |
  | v1.0.3（2026-08-31） | 200 MB                        | 103 MB                        | 98 MB                         |
  | v1.0.4（2026-10-07） | **225.4 MB**（236,335,162 B） | **115.8 MB**（121,374,809 B） | **110.4 MB**（115,798,281 B） |
  | v1.0.5（2026-10-11） | **225.7 MB**（236,688,736 B） | **115.9 MB**（121,551,525 B） | **110.6 MB**（115,975,063 B） |
  | v1.0.6（2026-10-12） | **225.9 MB**（236,913,120 B） | **116.0 MB**（121,663,585 B） | **110.7 MB**（116,087,354 B） |
  | v1.0.7（2026-10-13） | **225.9 MB**（236,931,359 B） | **116.0 MB**（121,672,893 B） | **110.7 MB**（116,096,324 B） |
  | v1.0.8（2026-10-13） | **226.0 MB**（236,988,202 B） | **116.1 MB**（121,701,202 B） | **110.7 MB**（116,124,845 B） |
  | v1.0.9（2026-10-13） | **226.0 MB**（237,006,813 B） | **116.1 MB**（121,710,580 B） | **110.7 MB**（116,134,090 B） |

  各次发布的 `latest.yml` 均**只有一份**（649 B，见上文），`path` 一律指向无后缀那份
  （v1.0.5 → `obox-1.0.5-setup.exe`；v1.0.6 → `obox-1.0.6-setup.exe`；v1.0.7 → `obox-1.0.7-setup.exe`；v1.0.8 → `obox-1.0.8-setup.exe`；v1.0.9 → `obox-1.0.9-setup.exe`），
  且该文件是 `files` 数组的**首条**——即 electron-updater 的"兼容旧格式"路径也落在它上面。
  无后缀那份的大小≈两个架构之和，具体成因**未查明【运行期未验证】**（已列为待办：查明来源并消除，或让 `latest.yml` 的 `path` 指向架构产物）。

  **发布资产清单（GitHub Release 实测，各 7 项）**：

  | 版本   | 无后缀 `.exe` | 无后缀 `.blockmap` | x64 `.exe`    | x64 `.blockmap` | arm64 `.exe`  | arm64 `.blockmap` | `latest.yml` |
  | ------ | ------------- | ------------------ | ------------- | --------------- | ------------- | ----------------- | ------------ |
  | v1.0.5 | 236,688,736 B | 247,026 B          | 121,551,525 B | 129,398 B       | 115,975,063 B | 121,307 B         | 649 B        |
  | v1.0.6 | 236,913,120 B | 247,328 B          | 121,663,585 B | 129,459 B       | 116,087,354 B | 121,407 B         | 649 B        |
  | v1.0.7 | 236,931,359 B | 246,921 B          | 121,672,893 B | 129,243 B       | 116,096,324 B | 121,253 B         | 649 B        |
  | v1.0.8 | 236,988,202 B | 247,153 B          | 121,701,202 B | 129,413 B       | 116,124,845 B | 121,382 B         | 649 B        |
  | v1.0.9 | 237,006,813 B | 246,975 B          | 121,710,580 B | 129,310 B       | 116,134,090 B | 121,292 B         | 649 B        |

- 影响面（**分工明确**）：
  - **本项目的强制重装/降级通道不受影响**——它走 `src/main/updateFeed.ts` 的 `pickArtifact()`，**优先精确匹配 `-<arch>-setup.`**，因此下载的是架构正确那份。**【源码核验】**
  - **electron-updater 自身**按 `files` 数组选架构产物（`path` 是兼容旧格式的字段）。**【源码核验】**【运行期未验证】
  - 因此**必须**在两种架构上确认"实际下载了哪个产物"，不要假设一定是架构后缀那份（见第 3 节清单第 4 步）。

## 2. 代理与证书

- `api.net.fetch`（扩展联网）与更新下载（electron-updater）的代理均在 **Chromium session 层**应用 `setProxy` + `setCertificateVerifyProc`（见 [ADR-0007 修订](adr/0007-update-provider-and-proxy.md) 与 `src/main/proxy.ts`）。
- 设置-网络里的代理是**单个 URL**（1.0.12 起）：`http://127.0.0.1:7890`、`https://proxy:8443`、`socks5://127.0.0.1:1080`、`http://user:pass@host:1080`（空串 = 直连）；旧形态（host/port/username/password）读取时自动迁移（`src/shared/proxyConfig.ts`）。地址非法时回退直连并在主进程日志写一行 `[proxy] …`。
- **认证代理（需要账号密码）**：
  - 更新下载**支持**——凭据取设置-网络里**代理 URL 的 `user:pass@`**：electron-updater 的 `ElectronHttpExecutor` 把 401 作为 `login` 事件抛出，宿主回填（`autoUpdater.on('login')` → `currentProxyCredentials()`，`src/main/proxy.ts:160-173`）。**【源码核验】**
  - `api.net.fetch` **不支持逐请求凭据**（Chromium 的 `session.fetch` 没有 per-request login 回调路径；`proxyRules` 也带不了 userinfo）：命中需要认证的代理时请求会失败（通常 407）。**【源码核验】【运行期未验证】**
    → 扩展若必须在认证代理后联网，请把该限制作为已知失败路径处理（提示用户改走更新链路或改用直连/免认证代理），不要反复重试。
- `ignoreSSL` 只作用于上述 session（不再是进程级全局开关）。**【运行期未验证】**

## 3. arm64 端到端验证清单（**【运行期未验证】**）

`windows-latest` 是 x64 runner，**能交叉编译 arm64 安装包，但无法运行它**——arm64 的检查/下载/安装链路从未被端到端验证。

| 步  | 动作                                                                  | 判定                                                                                    |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | 在一台 **Windows on ARM** 机器上安装 `obox-<version>-arm64-setup.exe` | 应用能启动，扩展宿主正常（导航栏/扩展管理器可见）                                       |
| 2   | 打开 **设置-更新**，确认更新提供者扩展已选中                          | 状态栏显示当前版本                                                                      |
| 3   | 触发"检查 Obox 更新"（命令面板或状态栏点击）                          | 能解析出更新源并进入"已是最新/发现新版"（不报 404）                                     |
| 4   | 若排查产物选择：查看本次实际下载的资产名                              | **记录是 `-arm64-setup.exe` 还是无后缀的那份**（见第 1 节的实测数据点）                 |
| 5   | 有新版时完成下载 → 安装 → 重启                                        | 版本号变为新版；`latest.yml` 中的 sha512 校验通过（校验失败会在日志报 `sha512` 不匹配） |

**验证结论（跑完后回填）**：

- 机器/版本：
- 实际下载的产物名：
- 结论：

## 4. 代码签名（**【运行期未验证】**，当前**未签名**）

- 现状：`electron-builder.yml` **没有配置任何签名**（无 `win.certificateFile` / `signingHashAlgorithms`），CI 也未注入证书。
- 配置位置（需要签名时）：`electron-builder.yml` 的 `win` 段加
  `certificateFile` + `certificatePassword`（或 `azureSignOptions` 走云签名），密码经 CI secret 注入（如 `CSC_KEY_PASSWORD`），
  证书文件不要入库（`release/`、`*.pfx` 应在 `.gitignore` 里或放 CI secret 以 base64 注入）。
- **未签名时的行为**（**【源码核验】** + 常识）：
  - 用户首次运行安装包会被 **SmartScreen** 拦截（"更多信息 → 仍要运行"可绕过）；
  - electron-updater 的 `NsisUpdater` 在 `publisherName` 为空（即未配置签名）时**跳过安装包签名校验**——因此"未签名"不会阻断自动更新，但也意味着**没有 Authenticode 真实性校验**；
  - 结论：未签名可用但有安全与体验代价；需要真实性保证时必须配证书。
- 成本提示：证书需采购与托管（OV/EV），EV 证书可即时获得 SmartScreen 信誉；**证书采购与密钥托管不在本项目范围**，此处只明确配置位置与行为。

## 5. 降级与同版本重装（**【源码核验】，当前被静默拒绝**）

electron-updater 默认 `allowDowngrade = false`，且版本相同时按 semver 判定"无更新"——**降级与同版本重装都会被静默拒绝，没有强制通道**。

因此：修复损坏安装或回退到稳定版本，目前只能**手工下载对应 release 的安装包覆盖安装**。若需要应用内"强制重装/降级"，需新增显式入口（规格 #28 的 S3 代码部分，待与在挂 PR 合并后再做）。

## 6. 其他已知未验证项

| 项                                 | 状态             | 说明                                                                                               |
| ---------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| 代理/ignoreSSL 真实生效            | 【运行期未验证】 | 机制已改为 session 层（此前 env 方案实测完全无效），但尚未在真实代理环境跑通"检查 → 下载"          |
| 更新事件 UI 反映（进度/完成/错误） | 【运行期未验证】 | 事件链路（主进程 → 渲染进程 → 状态栏）代码路径完整，缺真机串测                                     |
| 下载中断后重试                     | 【运行期未验证】 | `update:check` / `update:download` 已加进行中互斥；中断后的续传/重试行为依赖 electron-updater 语义 |
| Darwin/Linux 发行                  | 不适用           | 当前发布仅 Windows（`release.yml` 只构建 win nsis）                                                |

## 7. 依赖安全：sprintf-js 告警的处置（已修复）

**现状：`npm audit` 0 漏洞；Dependabot 开放告警 0。**

- **告警**：Dependabot #56 —— `sprintf-js`（medium，**development** 作用域），GHSA-hp3w-g68c-fv3c / CVE-2026-97058（precision 说明符无界导致 DoS）。受影响范围 `<= 1.1.3`，而 sprintf-js 上游最新就是 1.1.3 → **没有可升级的修复版本**。
- **来源链**：`electron-builder → app-builder-lib → @electron/get@3（嵌套） → global-agent@3 → roarr@2 → sprintf-js`。顶层那份 `@electron/get` 已是 5.x（不含 global-agent），问题只在 app-builder-lib 要求的 v3 那一份。
- **处置**：`package.json` 加 `overrides: { "roarr": "^7.21.7" }`。roarr 7 改用 `fast-printf`，**sprintf-js 从依赖树中消失**；`npm audit` 由 8 项 moderate 变为 **0 项**（那 8 项其实是同一根因在依赖路径上被逐环标记）。
- **验证（均已实际执行）**：
  - `npm run typecheck` / `npm test`（130 项）/ `npm run lint` 全部通过；
  - `npm run build` 通过；
  - **本地真实打包** `electron-builder --win nsis --x64 --publish never` 成功：Electron 44.6.0 正常下载（走的正是 @electron/get 链路）→ NSIS 产出 + blockmap，退出码 0。
- **残余风险（如实记录）**：`overrides` 覆盖的是**传递依赖**，上游 global-agent@3 并未针对 roarr 7 做过兼容测试；已知受影响面仅为"构建期下载时的代理/日志路径"，且**未在真实代理环境验证**。
- **退场条件**：electron-builder 27 稳定后升级并**移除该 override**（27 采用 `@electron/get` ≥ 4/5，该链路自然消失）；升级后需重跑 `npm audit` 与一次本地/CI 打包确认。

## 8. 本地打包产物膨胀（已修复）

- **现象**（本次依赖验证时发现）：本地 `electron-builder --win nsis --x64` 产出 **820 MB** 安装包，而 CI 同类产物为 115 MB。
- **根因（实测定位，两步）**：
  1. `release/` 是 `directories.output` 指定的**打包输出目录**，却**未在 `files` 中排除** → 本工具把"上一次的安装包"打进新安装包：`app.asar` 实测膨胀到 **1105 MB**；
  2. `vendor/`（VS Code 源码参考目录，本地 506 MB，`.gitignore` 未入库）同样未被排除。
  - CI 因干净 checkout 里没有这两个目录，所以 CI 产物一直正常——**这是只有本地打包才会踩的坑**。
- **风险**：不只体积。若有人在本地打包后上传，用户会拿到含 VS Code 源码与旧安装包的臃肿包（分发与许可都不合适）。
- **修复**：`files` 增加 `!vendor/*` 与 `!release/*`（含注释说明原因）。
- **复核（已执行）**：修复后本地重新打包 → **115.9 MB**（与 CI 的 115.8 MB 齐平），`app.asar` **1105 MB → 6.5 MB**。

### 开机自启（【运行期未验证】）

- **已验证**：注册项构造与"系统真实状态"归并（含任务管理器禁用）、启动参数识别、偏好文件更名与迁移、开关失败回弹
  —— 均由单测覆盖（`test/auto-start.test.ts`、`test/window-behavior.test.ts`）。
- **未验证**：打包版下 `setLoginItemSettings` 真的写入 `HKCU\...\Run`（值名 `com.obox.app`、值含 `--autostart`）、
  开机后确实静默启动、NSIS 卸载确实删除注册表项。开发版按设计不注册，因此这些只能装一次包来验。
- **退场条件**：一次打包安装 → 开开关 → 查注册表 + 重启验证静默启动 → 卸载后确认键值已删。

## 9. v1.0.10 发布数据 + 「更新功能」专项复核（2026-10-14）

### 9.1 v1.0.10 资产（7 个，与历次同形）

| 资产 | 大小 |
| --- | --- |
| `obox-1.0.10-setup.exe` | 237,016,662 B（226.0 MB）|
| `obox-1.0.10-setup.exe.blockmap` | 247,021 B |
| `obox-1.0.10-x64-setup.exe` | 121,715,411 B（116.1 MB）|
| `obox-1.0.10-x64-setup.exe.blockmap` | 129,349 B |
| `obox-1.0.10-arm64-setup.exe` | 116,139,117 B（110.8 MB）|
| `obox-1.0.10-arm64-setup.exe.blockmap` | 121,311 B |
| `latest.yml` | 654 B |

### 9.2 「无架构后缀的臃肿包」**不影响自动更新**（源码级定论，第 8 次复发）

`latest.yml` 的 `files[0]` 与顶层 `path` 依旧指向臃肿的 `obox-1.0.10-setup.exe`（226 MB），
但自动更新**不会**下它：

- `electron-updater@6.8.9` 的 `out/NsisUpdater.js:33` 走 `findFile(provider.resolveFiles(info), "exe")`；
- `out/providers/Provider.js:79-80` 的选择顺序是
  `files.filter(以 .exe 结尾).find(路径含 process.arch) ?? filteredFiles.shift()`。

本机 `process.arch = x64`，而 `latest.yml` 的 `files[1].url = obox-1.0.10-x64-setup.exe`（含 `x64`）⇒
**自动更新下的是 116 MB 的 x64 包**。该臃肿包只影响**手动下载**的用户（以及读顶层 `path` 的老客户端）；
本仓库自己的「强制重装」通道用 `pickArtifact`（优先 `-<arch>-setup`）同样选对。

⇒ 结论：这是发布页的观感/带宽问题，**不是更新故障**；如需彻底消除，应在 electron-builder 侧让无后缀产物不再生成（另行处理）。

### 9.3 「设置 → 更新」手动更新路径的三个缺陷（已在 1.0.11 修复）

复核方式：安装**打包版 1.0.10**（NSIS 静默装到 `%LOCALAPPDATA%\Programs\obox`）+ CDP 驱动真实界面。

| # | 缺陷 | 证据 | 修复 |
| --- | --- | --- | --- |
| 1 | **更新提供者扩展装不上**：`obox-updater` 是**非内置**扩展（`electron-builder.yml` 的 `!extensions/*` 不打包它），而它的 `.oix` 打包脚本在 Windows 上产出的是 **tar**（`tar -a` 按扩展名定格式，`.oix` 非已知后缀）⇒ 宿主报 `invalid-package` | 坏包头部 `6D 61 6E 69`；对照 `tar -a -cf x.zip` → `50 4B 03 04` ✓ / `x.oix` → tar ✗ | obox-updater **1.1.0**：改手写 stored zip + 回读自检 + 4 条打包门禁（30/30），并发布首个 release（含 `.oix`） |
| 2 | 点「检查更新」抛 **`An object could not be cloned.`**，按钮永久停在「检查中…」 | `SettingsView.vue` 把 `reactive` 的代理设置浅拷贝后塞进 IPC（内层 `noProxy` 仍是 Proxy）；用**纯对象**调同一 IPC 返回 `{ok:true}` | 新增 `core/plainProxy.ts`，4 处（设置页 / `api.net.fetch` / `api.update.*` / `api.proxy.get`）统一归一化为纯对象；3 条回归测试 |
| 3 | 选中更新提供者后 **「检查更新」按钮不出现**（只能重启应用），DOM 上是空占位注释 | `core/state.ts:85` 的 `state` 是**普通对象**（非 reactive）⇒ `computed(() => updaterStore.activeId)` 缓存首次 `undefined`；设置页在 `KeepAlive` 内，切走再回来也不重算 | `activeUpdater` 显式 `void settingsRevision.value`；3 条行为/源码门禁 |

**打包版已核实为正常的部分**：`resolveUpdateFeed('obox-org/obox')` → `v1.0.10`；
`checkUpdate(feedUrl)` → `{ok:true, available:"1.0.10"}` + 事件 `update-not-available`（本机已是 1.0.10）
⇒ HTTPS 读 `latest.yml`、版本比较、事件回传这条链路在**打包版**里是通的。

**仍未验证（如实登记）**：打包版上「发现新版本 → 下载 → 安装」的完整链路。原因是 electron-updater 在
**未打包**时直接跳过检查（`Skip checkForUpdates because application is not packed and dev update config is not forced`），
而打包版本机与最新版同号时只能得到 `update-not-available`。
退场条件：保留上一版打包版（如 1.0.10），等下一版发布后点「检查更新」验证发现新版、下载与安装向导。

## 10. v1.0.16 发布数据（2026-10-16）

**触发方式**：本地 `git tag v1.0.16` + `git push origin v1.0.16` ⇒ `.github/workflows/release.yml`（`on.push.tags: v*`）在 `windows-latest` 上构建；工作流第一步**校验 tag 与 `package.json` 的 `version` 一致**（`v1.0.16` ↔ `1.0.16`），不一致直接失败。

**本版头条能力（为什么必须有这一版）**：

- 新增扩展 **`api.overlay`** 命名空间（`create` / `destroy` / `setMouseThrough` / `setPosition`，均按扩展 id 限定作用域）+ `OverlayResult.position`，以及设置页只读 **`progress`** 字段类型；根 `package.json` 的 **`apiVersion` 由 1 升到 2**（决策与四个被否决备选见 [ADR-0024](adr/0024-extension-overlay-window-capability.md)；实现来自 PR #130 / merge `a06bf98`）。
- **这一版是"装机使用宠物扩展"的前提**：`pet` 扩展 v1.0.0（`obox-org/pet` 的 release）在清单里声明 `apiVersion: 2`，而 `apiVersion: 1` 的旧宿主（≤ 1.0.15）会按 `core/manifest.ts:28-38` **直接拒绝加载**（清单无效、管理器标红、入口根本不执行）。因此 v1.0.16 之前，宠物扩展只能在 `npm run dev` 的开发宿主或 `--debug-extension` 下使用。
- 回归范围：既有 rdp / webapp 的 App 卡片窗口不受影响（`isOverlay` 单开关隔离，卡片窗仍为无边框白底 + 标题栏）；未声明 `apiVersion: 2` 的既有扩展在所有版本上照常加载。

**发布资产**：与历次同形 **7 项**（`obox-1.0.16-x64-setup.exe`、`obox-1.0.16-arm64-setup.exe`、两份 `*.blockmap`、`latest.yml` 及工作流上传的其余元数据；具体清单以 release 页面回读为准）。

**本版未新增"运行期未验证"项**：第 3–6 节的既有未验证项（arm64 端到端、代码签名、降级/同版本重装、应用内更新链路）**沿用不变**；本次改动（主进程 overlay 窗体 + 设置页字段渲染 + `apiVersion` 递增）已由宿主单测（`test/overlay-window.test.ts` 67 条、`test/host-api-surface.test.ts` 28 条、`test/settings-progress-field.test.ts` 22 条）与宠物扩展的实机证据覆盖。

**实测记录（发布后回读）**：

| 项 | 结果 |
| --- | --- |
| tag → 工作流 | ✅ `Release` **#32**（run [38862262546](https://github.com/obox-org/obox/actions/runs/38862262546)），`conclusion = success`，耗时约 **5 分钟**（含 tag ↔ `package.json` 版本一致性校验、x64 与 arm64 两轮构建与上传） |
| 资产数 / 名称 | ✅ **7 项**，与历次同形：`obox-1.0.16-x64-setup.exe`（121,777,493 B）、`obox-1.0.16-arm64-setup.exe`（116,200,869 B）、`obox-1.0.16-setup.exe`（237,140,486 B，**无架构后缀的"臃肿包"**，成因见第 8 节与 9.2 节）、三份对应 `*.blockmap`（129,230 / 121,353 / 246,982 B）、`latest.yml`（654 B） |
| `latest.yml` 的版本与一致性 | ✅ `version: 1.0.16`；`files` 列出三份安装包且**尺寸与 release 资产逐一相等**（237140486 / 121777493 / 116200869），`path: obox-1.0.16-setup.exe`（与 9.2 节"无后缀包不影响自动更新"的结论一致）；三个 sha512 字段齐全（`ThJrHCjE…` / `IKhCIH7n…` / `WrTacUnQ…`）。**未下载合计约 475 MB 产物本地重算 sha512**，一致性以"工作流内计算 + 尺寸逐项吻合"为准（如实登记该口径） |

