# Spec Delta

## Purpose

让渲染进程与扩展宿主之间的反向请求拥有与工作性质相符的时间预算，并把"仍在执行"与"对端无响应"在用户可见层面区分开，避免把正常的慢操作报成故障。

## ADDED Requirements

### Requirement: 消息类反向请求 MUST 使用与其工作量相符的预算

`api.app.onMessage`、`api.executeCommand`、`api.views` 的树取子节点这类**可能执行 IO 或等待用户**的反向请求，MUST NOT 沿用普通往返的 3 秒预算；其预算 MUST 明确且可被调用方按次覆盖，扩展 API 形状不变。

#### Scenario: 慢 handler 不报超时

- **WHEN** 扩展的 `app.onMessage` 处理器耗时 5 秒后返回结果
- **THEN** 请求成功返回该结果，日志中不出现超时错误

#### Scenario: 按次覆盖预算

- **WHEN** 同一方法先后以不同预算调用两次
- **THEN** 两次各自按自己的预算计时，互不影响

### Requirement: 超时 MUST 区分"仍在执行"与"对端无响应"

超时发生时，用户可见文案 MUST 说明该请求可能仍在宿主侧执行，并 MUST 给出可执行动作（等待或重试、必要时重启扩展宿主）；MUST NOT 让用户据此判断"扩展坏了"。

#### Scenario: 超过预算但宿主仍在跑

- **WHEN** 某请求超过其预算仍未被回包
- **THEN** 页面收到带 `EH_TIMEOUT` 的错误，文案含"可能仍在执行"与下一步动作，且日志记录方法名、请求 id 与实际耗时

### Requirement: 超时 MUST 只观测，不终止宿主侧执行

渲染侧放弃等待后，宿主侧的执行 MUST 继续到自然结束；其迟到的结果 MUST 被丢弃并记录，MUST NOT 触发宿主重启或扩展停用。

#### Scenario: 迟到结果被安全丢弃

- **WHEN** 请求在超时之后才完成
- **THEN** 宿主进程保持运行、扩展保持激活，迟到结果不投递给页面，日志中留一条记录

### Requirement: 子进程冷启动 MUST 在预算内完成或被明确标注为"启动中"

`api.ipc.connect` 首次连接（会拉起 sidecar 子进程）MUST 获得足以覆盖冷启动的预算；若仍超过预算，错误 MUST 明确标注为"正在启动子进程"而非"对端无响应"。

#### Scenario: 首次连接耗时 5 秒

- **WHEN** 扩展首次调用 `api.ipc.connect`，子进程启动耗时 5 秒
- **THEN** 连接成功，不出现超时错误

#### Scenario: 启动超过预算

- **WHEN** 子进程启动超过预算仍未完成
- **THEN** 报错文案标注为"正在启动子进程"，并给出重试建议
