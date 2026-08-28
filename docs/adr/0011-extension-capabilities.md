# 扩展能力扩展：sqlite（node:sqlite 内置驱动）、主进程定时器、系统提醒

给扩展 API 增加三个能力：`api.sqlite`（数据库读写，**必须指定相对路径**，解析到扩展私有 data 目录）、`api.timer`（全局定时器，主进程精确计时，整数秒粒度）、`api.notification`（操作系统通知，设置-通知可逐扩展关闭）。

## 背景与问题

1. 扩展需要持久化数据（目前只有 Memento 键值存储，无结构化/查询能力）；需要定时执行任务（渲染进程 `setTimeout` 在窗口最小化/不可见时被节流到 1s，精确定时不可靠）；需要主动提醒用户（无通知能力）。
2. 扩展运行在渲染进程、经 `app://` 访问文件，**拿不到真实磁盘路径**——数据库文件位置必须由宿主解析。

## 决策

1. **sqlite 驱动用 node:sqlite（Node 22 内置）**：零依赖、无需 native 编译/electron-builder rebuild；Electron 39（Node 22.22）实测可用。弃 better-sqlite3（native 模块 + prebuild 匹配成本）。API 为"更上层"表集合封装（insert/update/get/get_all/get_by/del/del_by/clear + exec/query），首次写入自动建表（id 主键，列按 JS 类型声明，boolean 以 0/1 存取并还原），避免裸 SQL 门槛；`exec` 保留给建索引/初始化脚本，`query` 给复杂查询。
2. **路径策略：必须显式相对路径**，解析到 `userData/extensions/<扩展id>/data/<name>`（自动建目录），拒绝绝对路径/`..`/盘符——数据按扩展隔离、扩展无需知道磁盘路径、防越权写。
3. **定时器放主进程**（`api.timer`，整数秒 ≥1s）：主进程计时不受渲染进程后台节流影响；按扩展隔离（内部 key 前缀扩展 id）；触发经 `timer:fire` 事件回渲染进程分发回调；扩展停用/卸载经 `extension:cleanup` IPC 清理（定时器 + 数据库连接）。
4. **通知用 Electron Notification**（操作系统 API）；设置-通知新增节点，逐扩展开关（持久化），关闭后 `show` no-op；点击通知宿主聚焦主窗口 + 回调扩展 `onClick`。顺带修正 electron-builder `appId` 与 `setAppUserModelId('com.obox.app')` 一致（此前 com.electron.app 不一致，Windows 通知关联异常）。
5. **apiVersion 不递增**（保持 1）：三项均为纯新增 API，无破坏性变更（符合 ADR 0010 递增策略）。

## 备选与权衡

- better-sqlite3：API 成熟、同步、性能好，但引入 native 依赖与构建成本 → 否定，node:sqlite 零依赖且满足需求。
- 裸 DatabaseSync 直接暴露：灵活但扩展作者要懂 prepare 生命周期 → 否定，上层表集合封装 + exec/query 兜底。
- 定时器放渲染进程包一层：实现最简，但后台节流问题依旧 → 否定，主进程计时。
- 通知不加开关：信任扩展自律 → 用户选择加，设置页逐扩展开关。

Status: accepted
