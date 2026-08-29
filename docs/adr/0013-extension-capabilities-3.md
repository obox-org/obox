# 扩展能力扩展（三批）：交互 UI、输出面板、密钥存储、文件监听、菜单

对照 VS Code 扩展 API 补齐：`api.ui`（showQuickPick/showInputBox/showMessage/withProgress）、`api.output`（输出通道+底部面板）、`api.secrets`（safeStorage 加密存储）、`api.fs.watch`（文件监听）、`api.settings.onChanged`、`api.env.language`、`api.window.isFocused/onFocusChanged`、manifest 贡献点 `contributes.menus`（上下文菜单）。

## 背景与问题

1. 扩展命令缺交互入口：参数选择/输入只能靠 dialog 阻塞消息框或系统通知，无应用内轻量交互（QuickPick/InputBox/toast）。
2. 扩展日志/结果无展示去处；token/凭据只能明文存 Memento；扩展数据目录变化无监听。
3. VS Code 对照：以上均为常用 API，obox 此前全部缺失。

## 决策

1. **api.ui 纯渲染侧实现**（Promise 驱动）：uiStore 状态 + PromptHost/ToastHost 组件（Teleport 模态）；无需 IPC。QuickPick 支持过滤/键盘导航；InputBox 支持 password；toast 非模态自动消失；withProgress 复用进度 UI。
2. **api.output 渲染侧**（outputStore + 底部 OutputPanel 组件，多通道 tab）——扩展日志不经过主进程。
3. **api.secrets 走主进程 safeStorage**（Windows DPAPI/macOS Keychain 加密）存 userData/secrets.json；加密不可用时返回错误（不降级明文）。
4. **api.fs.watch 主进程 fs.watch**（递归监听扩展 data 目录），相对路径事件经 'fs:watch-event' 广播，扩展停用经 extension:cleanup 清理 watchers。
5. **settings.onChanged 复用 stateStore.onSettingsChanged**（key 粒度不追踪，通知全部监听者）；env.language 读 i18n locale；window 聚焦复用已有 getWindowState/window:state-changed（零新 IPC）。
6. **contributes.menus 首版挂 App 卡片右键**（registry 收集，AppView 渲染右键菜单），command 须已声明；when 仅 'false' 生效。
7. **src/api 保持纯接口层**：移除 runtime.ts 的 vue Component 依赖（ExtensionViews → Record<string, unknown>），扩展导入类型不需要宿主框架。
8. **apiVersion 保持 1**（全部纯新增）。

## 备选与权衡

- showQuickPick/InputBox 走主进程 dialog：Electron 无原生 QuickPick/InputBox → 渲染侧自绘，样式与宿主一致。
- secrets 降级明文存储（加密不可用时）：不安全 → 直接报错。
- output 走主进程持久化：首版仅会话内（内存），不做磁盘日志。
- menus 挂多位置（导航栏/状态栏等）：首版仅 App 卡片，其余后续。

Status: accepted
