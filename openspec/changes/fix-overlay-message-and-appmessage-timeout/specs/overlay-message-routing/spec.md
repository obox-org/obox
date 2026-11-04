# Spec Delta

## Purpose

保证宿主进程创建的 overlay 浮层页面与创建它的扩展入口之间的消息可达，并在不可达时给出可诊断、可执行的原因，而不是让页面永久停在"正在连接"。

## ADDED Requirements

### Requirement: 宿主创建的 overlay 页面消息 MUST 路由到创建它的扩展

宿主进程里 `api.overlay.create` 创建浮层后，该页面发出的每条消息 MUST 被投递给**创建它的那个扩展**的 `api.app.onMessage` 处理器，处理器的返回值 MUST 作为回包送回该页面。

#### Scenario: 页面消息到达扩展

- **WHEN** 宿主模式下的扩展创建 overlay，页面发送一条消息（channel + payload）
- **THEN** 该扩展的 `app.onMessage` 处理器被调用一次，参数与页面发出的 channel/payload 逐字相同

#### Scenario: 扩展回包回到页面

- **WHEN** 扩展处理器返回 `{ ok: true, data }` 或 `{ ok: false, error }`
- **THEN** 页面在预算内收到对应回包，且不会重复收到同一次请求的第二份回包

### Requirement: 路由失败 MUST 可诊断，且 MUST NOT 静默丢弃

当消息无法投递时，系统 MUST 记录足以定位**失败跳**的信息（页面消息 id、`appId`、判定结果：命中卡片 / 命中 overlay 归属 / 未命中，以及处理器是否存在），并 MUST 让页面收到一条明确的错误回包，而不是无限等待。

#### Scenario: 归属未登记

- **WHEN** 页面消息的 `appId` 在归属表与卡片表中都查不到
- **THEN** 日志中出现该 `appId` 与"归属未命中"，页面收到 `{ ok: false, error }` 且在预算内返回

#### Scenario: 处理器未注册

- **WHEN** 归属命中但该扩展尚未注册 `app.onMessage` 处理器
- **THEN** 日志中区分"处理器未注册"（与"归属未命中"不同），页面收到可读错误

### Requirement: overlay 归属 MUST 在页面可发消息之前建立

`api.overlay.create` 只有在归属通知已成功投递到渲染侧之后才 MUST 返回成功；若链路未就绪，create MUST 明确失败并回收已创建的窗口，MUST NOT 留下可见但不可交互的窗口。

#### Scenario: 链路未就绪时 create 失败

- **WHEN** 宿主到渲染侧的消息链路尚未建立时调用 `api.overlay.create`
- **THEN** create 返回失败并给出中文原因，且屏幕上不出现该 overlay 窗口

### Requirement: 归属 MUST 随窗口生命周期注销

overlay 销毁或扩展停用后，其归属 MUST 被注销；同一 `overlayId` 重新创建后 MUST 能重新路由。

#### Scenario: 销毁后不再路由

- **WHEN** 某 overlay 被销毁后，其页面仍有残留消息到达
- **THEN** 该消息不再投递给原扩展，命中的是"归属未命中"诊断

#### Scenario: 重建后恢复路由

- **WHEN** 同一扩展用同一 `overlayId` 重新创建 overlay 并发送消息
- **THEN** 消息照常投递给该扩展

### Requirement: 消息 MUST NOT 跨扩展串号

不同扩展的 overlay MUST 互相隔离：一个扩展的页面消息 MUST NOT 被投递给另一个扩展的处理器。

#### Scenario: 两个扩展各建一个 overlay

- **WHEN** 扩展 A 与扩展 B 各创建一个 overlay，A 的页面发送消息
- **THEN** 只有 A 的处理器被调用，B 的处理器调用次数为零
