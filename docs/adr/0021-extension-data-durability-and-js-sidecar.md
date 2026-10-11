# 扩展数据目录的升级保留与 JS 助手的运行时语义

## 背景

做 RDP 扩展时踩到两条**实测出来的宿主缺陷**，两条都与"文档写了、代码没做到"有关。相关决策：ADR-0016（IPC 传输与协议——它写的是"`.js/.cjs/.mjs` 由宿主自带的 Node 运行"，但没写实现机制；本 ADR 补齐 `ELECTRON_RUN_AS_NODE` 这一步，0016 的表述本身无需改动）、ADR-0018（Python 运行时，其"用户库随升级保留"的注释依赖本 ADR 决策 1 才成立）。

1. **覆盖安装会删掉扩展的运行时数据**。扩展数据目录固定为 `userData/extensions/<扩展id>/data/`（`api.fs` 与 `api.sqlite` 的落点，见 `src/main/fs.ts:12-19`、`src/main/sqlite.ts:35-37`），而 `<扩展id>` 就是**安装目录名** `<name>_<author>`（`capabilities.ts:75-79` 返回目录名；`api-reference.md:374` 的例子即 `…/todo_chenzhi/data/todo.db`）。安装器是"暂存目录整体替换目标目录、旧目录备份后删除"（`oixCore.ts:289-303`），`data/` 是它的子目录 → **每次升级连库带文件一起消失**。用真实 `installFromPackage` 实测：`升级后 data 目录存在=false、rdp.db 存在=false、probe.txt 存在=false`。仓库自己的注释一直认为应当保留（`python.ts:104`「用户库目录（随扩展升级保留）」），即代码与意图矛盾。
2. **`api.ipc` 的 JS 助手跑不成 Node**。宿主约定"`.js/.cjs/.mjs` 用宿主自带 Node 运行"（`ipc.ts:155-163`），实现是用 `process.execPath`（Electron 可执行文件）执行脚本，但子进程环境由 `minimalEnv()` 白名单构造（`ipcTransport.ts:28-35`，只透传 `PATH/SystemRoot/TEMP/TMP/HOME/USERPROFILE/LANG`）——**没有 `ELECTRON_RUN_AS_NODE`**。实测：无该变量时 Electron 以**应用模式**启动脚本，脚本确实执行（`BOOT node=24.21.0 electron=44.6.0`），但 `process.stdin` 未接（`isTTY=undefined`、收不到任何数据）、进程永不退出 ⇒ stdio 的 JSON-RPC 根本送不进去；显式加 `ELECTRON_RUN_AS_NODE=1` 后 stdin 正常、`node:sqlite` 可用、`process.exit(0)` 立即退出。

## 决策

1. **覆盖安装保留 `data/`**：在删备份之前，把 `backup/data` 搬回新目录（`rename`，同卷原子）。失败**只记日志**，不阻断安装、不回滚新版本；回滚路径（`rename(stage→target)` 失败）不受影响，因为那时 `data/` 从未被移动。目录名抽成 `EXT_DATA_DIR` 常量，供本条与下条共用。
2. **`.oix` 包内禁止包含 `data/`**：安装校验期（解压之前）拒绝，新增错误码 `forbidden-entry`，报错文案指明"它是扩展运行时数据目录，升级时由宿主保留"。理由：若允许打进包，旧包会用陈旧数据覆盖用户数据；拒绝在解压前可保证**不落盘、无残留**。
3. **JS 助手以纯 Node 运行**：为 `.js/.cjs/.mjs` 程序的子进程环境注入 `ELECTRON_RUN_AS_NODE=1`。为可单测，启动参数解析抽成纯函数 `resolveStdioSpawn({program,args,execPath})`（`execPath` 由调用方注入，Core 不读全局），`ipc.ts` 调用它并把 `env` 透传给 `openStdioTransport`。
4. **数据目录位置不变**：仍为 `userData/extensions/<扩展id>/data/`；不新增 `api.env.dataDir` 之类的路径 API，也不给 `api.sqlite` 加"持久库"选项——升级保留由宿主在安装流程里保证，扩展侧代码零改动。
5. **schema 迁移由扩展自己负责**：宿主只保证文件不丢；扩展在 `install(ctx)` 里按需 `ALTER TABLE`。

## 后果

- **好处**：`api.sqlite` 的 CRUD 从"升级即清空"变成真持久化；`api.fs`、python `user-site` 一并受益（那句"随升级保留"的注释才成立）；JS sidecar 从此可用（`api.ipc` 的便利约定从"写着的"变成"真的"），且助手能自行 `process.exit`、可用 `node:*` 全部内置模块；"包内不得含 data/"把一类数据覆盖事故堵在安装口。
- **代价**：安装流程多一步 `rename` 与一条日志分支；多一个稳定错误码（文档需同步）；`ELECTRON_RUN_AS_NODE` 进入子进程环境（仅对 JS 程序注入，不影响编译产物助手）；拒绝含 `data/` 的包属**行为收紧**，既有包若违规会安装失败（当前无此类包）。
- **风险与退场条件**：`data/` 的 `rename` 在跨卷时理论上会失败——但 `stage`/`backup`/`target` 同在 `userData/extensions/` 下，同卷；失败已降级为日志，不影响安装。若将来改为"扩展数据目录独立于安装目录"（例如 `userData/extension-data/<id>/`），本条保留逻辑即可删除，错误码 `forbidden-entry` 也应重新评估（独立目录下包内 `data/` 不再有覆盖风险）。

## 实测与验证

| 项                   | 结果                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 升级保留             | 新增 `test/oix-data-preservation.test.ts`：安装 v1 → 写 `data/rdp.db` 与 `notes.txt` → 覆盖安装 v2 → 文件与目录仍在、入口为新版本、无暂存残留 |
| 隔离性（先证明会红） | 临时把保留分支短路（`if (false && …)`）→ 该用例失败；还原（SHA256 一致）→ 4 passed                                                            |
| 包内禁 data/         | 同文件：含 `data/rdp.db` 与 `data/sub/x.json` 的包均抛 `forbidden-entry`，`targetRoot` 下无目录、`.tmp` 无残留                                |
| JS 助手语义          | 新增 `test/ipc-spawn.test.ts`：`.js/.cjs/.mjs`（含大写）→ 换成宿主 Node 且注入 `ELECTRON_RUN_AS_NODE=1`；`.exe` → 原样执行、不注入            |
| 端到端实证           | 手动按宿主方式 spawn：无该变量 → 收不到请求、20s 不退出；加变量 → 收到请求并回包、`sqlite":"yes"`、干净退出                                   |
| 门禁                 | `npm run typecheck`、`npm run lint`（清缓存）、`npm test`（419 passed / 5 skipped）；PR 的 CI `check` 通过后 squash 合并                      |
