# 禁用/卸载重启后生效（安装热生效）

**安装**：安装 .oix 后**热生效**——宿主立即增量加载（扫描 manifest → 校验 → 注册贡献点 → 激活），列表即时显示、导航/状态栏/命令立即可用，无需重启。

**禁用/卸载**：分两种情况——
- **未激活扩展**：立即热移除（贡献项/视图/App 卡片/清理函数全部回收），无需重启
- **已激活扩展**：标记需重启，UI 显示"立即重启"按钮（VS Code Reload Window 语义），点击后重载渲染进程窗口（`window.location.reload()`）使变更生效

VS Code 源码（abstractExtensionService.ts:392-405 `canRemoveExtension`）明确：已激活（activationStarted）的扩展不可运行时移除。我们同样遵循：运行中的扩展不强行移除，但安装场景（新增扩展，尚未运行）天然可热生效，故安装走热加载路径；禁用/卸载对未激活扩展也走热移除路径（贡献项回收机制已实现：`registry.deactivateExtension` + `removeViewComponents` + `appStore.deactivateExtension` + 宿主 cleanup）。

状态持久化语义不变：禁用列表存 userData JSON，"缺省即启用"；卸载删目录（主进程执行）。

Status: accepted, supersedes 0003
