# 扩展内嵌 Python 运行时：形态、分发与裁剪

## 背景

扩展此前只能写 JavaScript（宿主在渲染进程动态 `import` 扩展入口）。要让扩展复用 Python 生态（首要目标：`matplotlib` 等三方库），必须决定：Python 跑在哪、运行时从哪来、怎么适配 CPU 架构、体积与安防怎么权衡。相关决策：ADR-0004（两阶段启动）、ADR-0015（扩展受信、能力不是安全边界）、ADR-0016（端口无关 IPC，`api.ipc`）。

## 决策

1. **形态：独立进程 sidecar**。宿主把 CPython 当子进程拉起，经 `api.ipc` 的 stdio 传输做 JSON-RPC 2.0 双向通信；**不采用 PyO3 进程内嵌入**——PyO3 仍要为每个平台/架构提供 `libpython`（官方文档："By default PyO3 links to `libpython`"），却把 Python 的崩溃/内存泄漏/GIL 带进 Electron 主进程，且为 CI 引入 Rust 逐平台编译（当前 CI 无任何原生构建步骤）。
2. **平台：win-x64 + win-arm64**。Electron 44.6.0 **已无 ia32 产物**（仓库 `electron-builder.yml:24` 与 `node_modules/electron/README.md:40` 一致），32 位 Windows 上应用本身跑不起来；且 `matplotlib` 自 3.8 起不再发布 `win32` wheel（3.12+ 完全没有），而 `matplotlib`/`numpy` 现已提供 **`win_arm64` 原生 wheel**（分别自 3.10.5 / 2.3.0 起），arm64 无需编译器。
3. **运行时来源：随扩展 `.oix` 分发**（不随应用、不按需下载），**每架构一个包**；manifest 声明 `arch`，错架构包在安装时直接拒绝。
4. **三方库落点：pip 直接装进扩展安装目录的 `python/Lib/site-packages`**（不引入 venv 层）；**覆盖安装时保留 `python/Lib/site-packages` 与 `Scripts`**，新包同名文件以保留的旧文件为准。版本变化时保留失效：manifest 声明 `python` 版本，宿主据此校验，不一致则不保留并提示重装依赖。
5. **信任：受信、不隔离**，与 ADR-0015 一致；文档明确"不构成沙箱"。
6. **作者体验：内置 `api.python.*` 封装**（`run` / `install` 等），扩展不接触进程、协议与路径；pip 复用宿主已有的 session 代理设置。
7. **交互式窗口：由脚本自行选择后端**（不在本设计内取舍）——因此运行时**必须保留 `tkinter` 与 `tcl/`**（`matplotlib` 在 Windows 默认后端 TkAgg 依赖它们）。
8. **`run()` 默认不超时**（一直等到进程结束）：交互式脚本 `plt.show()` 阻塞到用户关窗属预期行为。
9. **不处理用户 `print`**：脚本若向 stdout 打印会破坏 `Content-Length` 分帧，本次运行以 `protocol-error` 失败——扩展作者指南要求改用事件/返回值；`pip install` 作为独立子进程调用，其输出不进协议通道。
10. **裁剪档位**：以 `install_only_stripped` 为基线（上游只去掉 `.pdb`），再删 `include/`、`libs/`、`Lib/idlelib`、`Lib/turtledemo`。**保留** `pip`、`venv`、`ensurepip`、`tkinter`/`tcl`、`sqlite3`、`ssl`/`hashlib`、`ctypes`。
11. **`.oix` 限额放宽**：条目 2000 → **10000**、总字节 64 MiB → **512 MiB**；**不加大包确认闸门**。硬上限与"超限中止 + 回滚"的原子安装语义不变。
12. **许可**：自动收集运行时与 `site-packages` 内的许可文件（`LICENSE.txt`、`*.dist-info/licenses/**`、`tcl*/license.terms` 等）生成第三方声明汇总，并在文档中写明**对运行时的修改摘要**（PSF-2.0 第 3 条要求），以 CI 校验防漂移。

## 实测依据（CPython 3.13.16 + python-build-standalone tag 20261003）

| 项 | win-x64 | win-arm64 |
| --- | --- | --- |
| 归档 `.tar.gz` | 45.22 MB | 42.37 MB |
| 解压后 | 144.97 MB / 3350 文件 | 146.95 MB / 3350 文件 |
| `install_only_stripped`（去 41 个 `.pdb`） | 59.7 MB / 3309 文件 | 60.6 MB / 3309 文件 |

- 逐组裁剪后 ≈**56 MB / ≈3000 文件**（`include`+`libs` −2.25 MB、`idlelib`+`turtledemo` −1.16 MB）；`__pycache__` 可省 8.8 MB 但仅当目录只读（一次验证运行即重生 5.1 MB）。
- 裁剪后 `python -m venv` + `pip install matplotlib` **成功**（matplotlib 3.11.2 + numpy 2.5.3，Agg 后端实际出图）；冷下载 16.2 s、warm 11.4 s；**装 matplotlib 的代价 = +119 MB / +3385 文件**。
- **不可删清单**（逐项实测）：`python3.dll`（abi3 轮子依赖，删了 `python.exe` 仍能跑但 `cryptography` 等报 DLL load failed）、`Lib/ensurepip`（venv 带 pip）、`Lib/venv`、`Lib/tomllib`（pip 26.2.1 依赖）、`_socket`+`_select`+`_overlapped`+`_multiprocessing`（asyncio/multiprocessing）、`_ssl`+`libssl`+`libcrypto`（HTTPS 与 hashlib）、`unicodedata`、`_sqlite3`+`sqlite3.dll`+`Lib/sqlite3`、`_ctypes`+`libffi-8.dll`、`_bz2`/`_lzma`/`pyexpat`。
- Windows 版 PBS **没有 `Scripts/pip.exe`**（上游已知限制），因此 pip 一律用 `python -m pip` 调用。

## 后果

- **好处**：扩展获得完整 Python 生态且离线可用；崩溃被进程边界隔离；装机包不被 Python 拖大；pip 与代理沿用既有链路。
- **代价与残余风险（如实记录）**：
  1. **限额放宽 8 倍且取消大包闸门**——反 zip 炸弹防线只剩"硬上限 + 超限中止回滚"；这是本决策接受的残余风险。
  2. **每个需要 Python 的扩展各带一份 ≈56 MB 运行时×架构**，且升级扩展要重传。
  3. **`run()` 不超时**：写错的脚本（死循环、`input()`）会永久挂住调用方，扩展无自主恢复手段。
  4. **不处理 `print`**：用户脚本的一行 `print` 即可使本次运行失败（错误信息会指向该原因）。
  5. **保留 `site-packages` 只在 Python 版本一致时安全**；跨大版本保留会得到 ABI 不兼容的 `.pyd`，故版本变化一律不保留。
  6. **arm64 无法在本机验证**（CI 是 x64 runner）；arm64 的 `python.exe -V` 与 matplotlib 实装均**未实测**。
  7. 钩子（`install`/`uninstall`）与本次运行时的交互、以及钩子失败语义，见后续规格（本 ADR 不涉及）。

## 未采纳的替代方案

- **随应用分发（`extraResources`）**：安装包每架构 +≈50 MB，对所有用户收费；换取"零等待"。否决理由：Python 是可选能力。
- **首次使用下载到 userData**：安装包不变大且运行时版本可独立升级；否决理由：扩展作者选择"随包分发"，离线与可复现性优先。
- **单包含双架构**：包体积翻倍（每架构 ~56 MB 各一份）。否决。
- **不裁剪（145 MB/3350 文件）**：最省心但要放宽到 200 MB/4000+ 条目。否决。
- **PyO3 进程内嵌入**：见决策 1。否决。
- **协议改走命名管道以隔离用户输出**：依赖尚未实现的 pipe 服务端（issue #43），且本决策选择"不处理 print"。否决（可回访）。

Status: accepted

## 待确认（写规格前需需求方拍板）

- pip 默认索引与镜像（拟：官方 PyPI，可配置镜像）
- 启动器形态（拟：随运行时放一份受信小启动器负责建立协议通道，**不做** print 重定向）
- 错误码集合（拟沿用 `api.ipc` 风格：`python-not-installed` / `arch-mismatch` / `version-changed` / `pip-failed` / `script-error`）
- 生命周期钩子线（声明方式/时机/可选已定：入口具名导出、安装后激活前与卸载前、可为空、失败归为激活失败；**待定**：能否拿完整 `api`、覆盖安装是否重跑 `install()`、卸载失败策略、幂等要求）
