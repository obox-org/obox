# 更新提供者扩展 + 代理配置

新增 obox 更新能力与代理配置：

1. **更新提供者扩展**：obox 更新逻辑不再内置默认源——由非内置扩展声明 `contributes.updater` 成为"更新提供者扩展"，在**设置-更新**中选择生效（**只能一个**）。宿主提供执行能力（`api.update`：getVersion/check/download/install/事件，底层 electron-updater 跑主进程），扩展提供更新源（feedUrl）与触发时机。未选择更新提供者时不检查更新。
2. **代理配置**：设置-**网络**页配置 `http.proxy`（host/port/username/password/忽略 SSL/noProxy 排除列表，VS Code 风格），存统一设置存储（`network.proxy`）。obox 主进程网络请求（更新下载等）自动应用；内置扩展经 `api.proxy.get()` 读取并应用；非内置扩展可选使用。
3. **CI**：release 工作流补发 `latest.yml`（electron-updater 定位新版安装包所需），与 `obox-<version>-setup.exe` 一起上传；源码归档由 GitHub 自动生成。

选择"扩展提供更新 + 宿主执行"而非宿主内置：保持更新源可插拔（不同分发渠道由不同扩展提供），且更新执行（下载/校验/安装/重启）复用 electron-updater 标准能力，避免每个扩展重复实现。

## 修订

- **代理应用改到 session 层**（批次 A 修复）：原先写 `HTTP_PROXY` 等环境变量的方案，对 Node 全局 `fetch`（undici）与 Electron `net.request`（Chromium）**都不生效**（实测：代理指向不可达地址仍直连成功），等于代理与 `ignoreSSL` 全程失效、且 `NODE_TLS_REJECT_UNAUTHORIZED=0` 是进程级副作用。现改为在请求真正经过的 session 上 `setProxy` / `setCertificateVerifyProc`：扩展联网用专用 session `obox-net`，更新下载用 electron-updater 自己的 session，代理认证经 `autoUpdater.on('login')` 回填凭据。属实现缺陷修复，不改变本 ADR 的决策。
- **更新源解析语义收紧**：`resolveFeed(repo)` 不再"按创建时间取最新 release"，改为取**第一个「非 draft、非预发布、且资产含 `latest.yml`」**的正式 release（避免 latest 标记/创建顺序指向未完成编译或预发布的 release）；无可用项时返回 `ok:false`，由扩展回落 `releases/latest/download/`。
- **CI 产物**：Windows 下更新元数据只有单一 `latest.yml`（electron-builder 不生成 `latest-arm64.yml`，arm64 安装包并入同一 files），另上传 `*.blockmap` 供差分更新。
- **强制重装/降级走独立通道**（S3）：electron-updater 在 `allowDowngrade = false` 且远端版本与本地**相等**时按 semver 判"无更新"，因此**同版本重装与降级无法经它完成**。宿主新增 `api.update.install({ force: true, feedUrl })`：直接读更新源的 `latest.yml` → 按本机架构挑安装包 → 流式下载 → 校验 sha512 → 启动安装向导（应用不退出，用户完成安装）。该通道与 electron-updater 的检查/下载链路并行存在；元数据不可读、HTTP 失败、sha512 不匹配等错误一律**不启动安装器**（不匹配的下载文件会被删除）。

Status: accepted
