# overlay-message-routing

## Purpose

浮层（overlay）窗口里的页面没有 `api` 对象，它的全部能力都靠"页面 → 外壳 → 宿主"的消息桥；这套寻址必须在宿主模式（用户扩展跑在 Extension Host 进程）下与渲染模式等价，否则窗口看得见、功能全哑。

## ADDED Requirements

### Requirement: 浮层消息按可信 extId 寻址

浮层窗口的所属扩展 SHALL 由**主进程写入查询串的 `extId`**（外壳已二次校验：`app:` 协议 + 合法 host + 路径首段 = extId）决定；外壳转发页面消息时 MUST 带上该 `extId`，宿主侧 MUST 优先按它寻址，MUST NOT 要求扩展或页面自行声明归属。

#### Scenario: 宿主模式下宠物订阅

- **WHEN** 用户扩展（`OBOX_EXTENSION_HOST` 开）创建 overlay 后，页面发出 `pet.subscribe`
- **THEN** 该消息被投递到该扩展注册的 `app.onMessage` 处理器，回包原路返回页面
- **AND** 控制台不再出现 `扩展消息未投递 … 归属=未命中`

#### Scenario: 页面伪造别人的 extId

- **WHEN** 浮层页面在消息里自行带上另一个扩展的 `extId`（或 `appId`）
- **THEN** 宿主忽略页面自带的归属字段，只用查询串里那份（外生、可信）
- **AND** 该消息仍然只能到达"本窗口所属扩展"，越权不成立

### Requirement: 卡片窗口寻址行为不变

非浮层的 App 卡片子窗口 MUST 继续按 `appId` 查 App 卡片归属；本次改动 MUST NOT 改变卡片窗口的寻址结果（含找不到时的错误文案）。

#### Scenario: 卡片窗口消息

- **WHEN** 卡片窗口页面发出消息
- **THEN** 仍按卡片 `appId` 找到所属扩展，行为与改动前逐字一致

#### Scenario: 卡片 id 不存在

- **WHEN** 卡片窗口的 `appId` 查不到
- **THEN** 仍返回原有的「未找到处理器」错误，不因新增的 extId 分支而改变

### Requirement: 兜底与诊断

当可信 `extId` 缺失（旧数据/异常形状）时，宿主 SHALL 依次回落到 App 卡片表与 `overlayOwners`；三条路都查不到时 MUST 输出一条包含**已尝试路径**的诊断日志，而 MUST NOT 只写"未命中"。

#### Scenario: extId 缺失但有归属表

- **WHEN** 消息没有可信 extId，但 `overlayOwners` 里登记了该 `overlayId`
- **THEN** 按登记项投递成功

#### Scenario: 三条路都查不到

- **WHEN** 消息既无 extId、卡片表与归属表也查不到
- **THEN** 日志包含"卡片 / 查询串 extId / 归属表"三条尝试结果与最终丢弃结论，便于一眼定位

### Requirement: 归属表不再承担唯一通路

`overlayOwners`（EH-D8b 由宿主事件回填）SHALL 只作为兜底存在；即使回填事件丢失或晚到，浮层消息 MUST 仍能按可信 extId 送达，且 MUST NOT 因此产生"窗口可见但功能全哑"的静默失败。

#### Scenario: 回填事件丢失

- **WHEN** 宿主 `overlay-owner` 事件没有到达渲染侧（端口未就绪 / 事件被丢弃）
- **THEN** 浮层消息依然按查询串 extId 正确寻址，功能正常

### Requirement: 回归门禁

仓库 SHALL 增加断言钉住"浮层消息按可信 extId 寻址"，并覆盖**宿主模式**；门禁 MUST 在缺少该分支时失败。

#### Scenario: 移除 extId 分支

- **WHEN** 有人删掉"按可信 extId 寻址"的分支
- **THEN** 门禁用例失败并指出寻址优先级被破坏
