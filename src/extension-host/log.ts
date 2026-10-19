/**
 * 宿主进程的**日志出口**与「发一个信封」的唯一入口。
 *
 * 为什么日志必须走 `log` 信封而不是 stdout/stderr：打包后的 `utilityProcess` 的 stdout/stderr
 * 不会出现在用户能拿到的地方（ADR-0026 决策 7 的「查看日志」要能真的看到东西）。所以宿主里
 * 任何需要被看见的信息都经这里 → `log` 信封 → main。
 *
 * 同时这里承担**帧上限守卫**：协议层的 8 MB 上限（`FRAME_LIMIT_BYTES`）不该在每个调用点各判一次，
 * 统一在发送口判——超限的帧直接丢弃并记一条 error，而不是让 `postMessage` 在跨进程边界上抛错
 * （那时栈已经不在宿主里，排查只能靠运气）。
 */
import {
  checkFrameSize,
  createLogEnvelope,
  type Envelope,
  type LogLevel
} from '../shared/extensionHostProtocol'
import { toErrorMessage } from './errors'
import type { HostPort } from './port'

/** 宿主侧日志函数（`log` 信封的本地形态；`detail` 只进信封文本，不单独成字段） */
export type HostLogger = (level: LogLevel, message: string, detail?: string) => void

/** 发一个信封（`rpc.ts` / `runtime.ts` 共用；已有帧上限与异常兜底） */
export type EnvelopeSink = (envelope: Envelope) => void

/** 拼日志文本：有 detail 时用全角括号接在后面，保持单行可读 */
export function formatLog(message: string, detail?: string): string {
  return detail === undefined || detail === '' ? message : `${message}（${detail}）`
}

/**
 * 把 `HostPort` 包装成 `EnvelopeSink`：先估帧大小，再发；超限/发送失败都只记日志不抛。
 *
 * `onFailure` 是「发送本身失败」时的兜底出口——此时 `log` 信封同样发不出去，只能退到本地
 * stderr（`runtime.ts` 在 `index.ts` 里会传入 console 兜底，单测里传空实现）。
 */
export function createEnvelopeSink(
  port: HostPort,
  onFailure: (message: string) => void = (): void => {}
): EnvelopeSink {
  return (envelope: Envelope): void => {
    const frame = checkFrameSize(envelope)
    if (!frame.ok) {
      onFailure(`丢弃一帧（t=${envelope.t}）：${frame.why}`)
      return
    }
    try {
      port.post(envelope)
    } catch (error) {
      onFailure(`发送信封失败（t=${envelope.t}）：${toErrorMessage(error)}`)
    }
  }
}

/** 控制台回声的级别映射（`debug`/`info` 走 log，其余走 warn/error） */
function echoLine(level: LogLevel, text: string): void {
  const line = `[extension-host] ${level.toUpperCase()} ${text}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/**
 * 造一个 `HostLogger`：每条日志都发成 `log` 信封。
 *
 * `echoToConsole` 只给**入口**（`index.ts`）开：开发时 `--inspect` + 终端能看到东西；单测里关掉，
 * 否则每个用例的期望日志都会刷进测试输出，噪声会盖住真正的失败信息。
 */
export function createEnvelopeLogger(
  send: EnvelopeSink,
  options: { echoToConsole?: boolean } = {}
): HostLogger {
  const echo = options.echoToConsole === true
  return (level: LogLevel, message: string, detail?: string): void => {
    const text = formatLog(message, detail)
    if (echo) echoLine(level, text)
    send(createLogEnvelope(level, text))
  }
}
