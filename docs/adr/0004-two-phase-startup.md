# 两阶段启动：先注册贡献点、后激活扩展

启动流程分两阶段：**扫描清单 → 注册贡献点 → 释放 barrier → 激活扩展**。

对齐 VS Code 的 `whenInstalledExtensionsRegistered()` barrier（abstractExtensionService.ts:1069-1071）：贡献点注册完成前 UI 不查询注册表，避免 UI 先渲染、扩展贡献项后注册的空窗竞态。全量激活（不做懒激活）前提下，两阶段保证扩展的 `apply(ctx)` 执行时，宿主注册表已就绪；UI 组件一律等 barrier 后再渲染导航/状态栏/命令面板。

Status: accepted
