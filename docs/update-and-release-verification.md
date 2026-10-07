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
- **`electron-builder` 还会额外产出一份"无架构后缀"的安装包，且 `latest.yml` 的 `path`/首个 `files` 条目指向它**——已在 v1.0.3、v1.0.4 两次发布中复现：

  | 版本 | 无后缀（`path` 指向） | x64 | arm64 |
  | --- | --- | --- | --- |
  | v1.0.3（2026-08-31） | 200 MB | 103 MB | 98 MB |
  | v1.0.4（2026-10-07） | **225.4 MB**（236,335,162 B） | **115.8 MB**（121,374,809 B） | **110.4 MB**（115,798,281 B） |

  无后缀那份的大小≈两个架构之和，具体成因**未查明【运行期未验证】**（已列为待办：查明来源并消除，或让 `latest.yml` 的 `path` 指向架构产物）。
- 影响面（**分工明确**）：
  - **本项目的强制重装/降级通道不受影响**——它走 `src/main/updateFeed.ts` 的 `pickArtifact()`，**优先精确匹配 `-<arch>-setup.`**，因此下载的是架构正确那份。**【源码核验】**
  - **electron-updater 自身**按 `files` 数组选架构产物（`path` 是兼容旧格式的字段）。**【源码核验】**【运行期未验证】
  - 因此**必须**在两种架构上确认"实际下载了哪个产物"，不要假设一定是架构后缀那份（见第 3 节清单第 4 步）。

## 2. 代理与证书

- `api.net.fetch`（扩展联网）与更新下载（electron-updater）的代理均在 **Chromium session 层**应用 `setProxy` + `setCertificateVerifyProc`（见 [ADR-0007 修订](adr/0007-update-provider-and-proxy.md) 与 `src/main/proxy.ts`）。
- **认证代理（需要账号密码）**：
  - 更新下载**支持**——electron-updater 的 `ElectronHttpExecutor` 把 401 作为 `login` 事件抛出，宿主用设置-网络里的账号密码回填（`autoUpdater.on('login')`）。**【源码核验】**
  - `api.net.fetch` **不支持逐请求凭据**（Chromium 的 `session.fetch` 没有 per-request login 回调路径）：命中需要认证的代理时请求会失败（通常 407）。**【源码核验】【运行期未验证】**
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
