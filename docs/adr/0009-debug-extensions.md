# 调试扩展（--debug-extension）：VS Code 调试扩展代码，不安装、不依赖 obox 源码

obox 提供调试加载能力：`obox --debug-extension <id>@<绝对路径>`（可重复）把扩展本地目录作为扩展源直接加载，**不做 .oix 安装**（不写 userData、无安装时间戳、重启消失）；扩展代码经 `app://debug/<id>/` 协议加载，配合 `--remote-debugging-port` 的 CDP，可在 VS Code 里对扩展源码打断点调试，扩展仓库无需依赖 obox 源码。

## 背景与问题

1. **用户扩展在独立仓库开发**（obox-org/<id>）：调试扩展代码时要么打包 .oix 装进应用（迭代慢、污染安装态），要么依赖 obox 源码（违背独立仓库约定）。
2. 扩展代码运行在 obox **渲染进程**（宿主内），VS Code 调试器需经 **CDP** 挂到渲染进程，并把 `app://debug/<id>/...` 脚本 URL 映射回本地仓库文件（pathMapping）才能打断点。

## 决策

1. **声明**：CLI 参数 `--debug-extension <id>@<绝对路径>`（可重复；id 正则校验、路径必须存在）。主进程解析为"调试扩展映射"（id → 目录）。
2. **协议**：新 hostname **`app://debug/<id>/<rest>`** 映射到调试目录（仅服务已声明的 id，带路径穿越防护）；与安装态 `app://extensions` 彻底隔离。CSP 无需改（同为 app: scheme）。
3. **加载**：加载器收集调试扩展为 `source: 'debug'` 条目（复用 manifest 校验/贡献点注册/激活流程）；扩展管理器显示**「调试中」徽标、来源=调试、不可卸载/禁用**；重启后消失。
4. **VS Code 接入**：obox 启动带 `--remote-debugging-port`（CDP）；扩展仓库 `.vscode/launch.json` 用模板（node launch 启动 obox + chrome attach 渲染进程 + compound），`pathMapping: { "app://debug/<id>/": "${workspaceFolder}" }` 使源码可断点。
5. **范围**：dev（electron-vite dev 传参）与打包版 obox.exe 都支持；改代码后手动重载窗口生效（v1 无自动 watch）。

## 备选与权衡

- 复用 `app://extensions/<id>/`（与安装态 URL 一致）：调试/安装同名冲突、需调试优先逻辑 → 否定，用独立 hostname 语义更清晰。
- 仅 DevTools 手动调试（不接 VS Code）：不满足"在 VS Code 里 debug" → 否定。
- 调试扩展持久化记录（重启仍加载）：偏离"不真正安装" → 否定，每次按参数加载。

Status: accepted
