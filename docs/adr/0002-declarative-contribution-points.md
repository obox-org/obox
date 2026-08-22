# 声明式贡献点 + 宿主解析注册

扩展的贡献点（导航项、状态栏项、命令）在 manifest 中**声明**，由宿主扫描后统一解析注册；扩展入口只提供数据/回调与视图组件，不在 `apply(ctx)` 里命令式注册 UI。

VS Code 模型（extensionsRegistry.ts 的 `registerExtensionPoint` + `setHandler`）正是"清单声明 + 宿主 handler 注册"：贡献点声明自动生成隐式激活事件、校验错误经 collector 收集、无效声明只跳过不崩溃。命令式注册（扩展直接调 `ctx.registerNavItem`）虽灵活，但宿主无法集中做校验、去重、排序、来源追踪，也偏离了"扩展 = 声明 + 实现"的模型。

据此，manifest 声明三类贡献点元数据，宿主解析后写入注册表（导航项表/状态栏表/命令表），校验错误收集进每扩展的 messages 列表，可在扩展管理器查看。

Status: accepted
