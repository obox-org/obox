# 禁用/卸载重启后生效

禁用、启用、卸载均标记状态并在**重启后生效**；运行中的扩展不被强行移除。

VS Code 源码（abstractExtensionService.ts:392-405 `canRemoveExtension`）明确：已激活（activationStarted）的扩展不可运行时移除，只对未激活扩展做 delta 热增删。强行运行时停用需要额外的贡献项回收机制，且容易留下悬空视图/命令/状态栏项。

我们的语义：状态变更（禁用/启用/卸载）写入 userData JSON；重启后扫描时按状态过滤，被禁用的扩展不加载、被卸载的扩展目录已删除。UI 上状态变更后提示"重启后生效"。未激活扩展的变更可立即生效（扫描前尚未加载）。

Status: accepted
