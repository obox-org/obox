/**
 * 宿主侧错误的**归一与翻译**：把任意 `unknown` 变成能给用户看的一句话 + 能进日志的细节，
 * 以及「能力尚未迁移」这一种专项错误（EH-A3 的阶段 B 桩）。
 *
 * 为什么单独一个文件：宿主里同时有四种错误来源——协议守卫（`EhProtocolError`）、Node 系统错误
 * （`ErrnoException`）、扩展插件抛出的任意值（字符串/对象/`undefined` 都可能）、以及 RPC 远端
 * 回的 `err` 信封。这四种错误最终都要落成「`log` 信封 + 状态表」两处记录，如果各处各写一份
 * `String(error)`，日志会出现 `[object Object]` 与空消息混在一起的情况，排查时无法区分
 * 「扩展抛了 undefined」和「宿主代码 bug」。
 */
import { EH_ERROR_TEXT, EhProtocolError, type EhErrorCode } from '../shared/extensionHostProtocol'

/**
 * 阶段 B 的统一提示（`docs/extension-host-migration.md` 的 EH-B1…EH-B5）。
 * 所有桩能力都带这一句：用户/扩展作者一眼能看出「不是坏了，是还没搬」。
 */
export const CAPABILITY_NOT_MIGRATED_HINT =
  '该能力尚未迁移，见 docs/extension-host-migration.md 阶段 B'

/** 桩能力被调用时抛的错误：`EH_INTERNAL` + 迁移提示 + 具体能力名 */
export function stubCapabilityError(capability: string): EhProtocolError {
  return new EhProtocolError(
    'EH_INTERNAL',
    CAPABILITY_NOT_MIGRATED_HINT,
    `api.${capability} 在扩展宿主进程（EH-A3）里只有桩`
  )
}

/**
 * 任意值 → 一行错误消息。
 *
 * 扩展可以 `throw 'oops'`、`throw { code }`、`throw undefined`（`throw` 后不接表达式的语法
 * 在部分转译产物里会出现），所以这里必须穷举这些形状，并且**永不抛错**（自己抛错会掩盖原始错误）。
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim() === '' ? error.name : error.message
  if (typeof error === 'string') return error.trim() === '' ? '（错误消息为空字符串）' : error
  if (error === undefined) return '（抛出值为 undefined）'
  if (error === null) return '（抛出值为 null）'
  try {
    const text = JSON.stringify(error)
    return text === undefined ? String(error) : text
  } catch {
    return String(error)
  }
}

/**
 * 任意值 → 诊断细节（进 `log` / `err.detail`，不进给用户看的 `message`）。
 * 优先用 `EhProtocolError.detail` 与 `Error.stack`：栈是宿主里唯一能定位「哪个扩展的哪一行」的线索。
 */
export function toErrorDetail(error: unknown): string {
  if (error instanceof EhProtocolError && error.detail !== undefined && error.detail !== '') {
    return error.detail
  }
  if (error instanceof Error && typeof error.stack === 'string' && error.stack !== '') {
    return error.stack
  }
  return toErrorMessage(error)
}

/** 取错误码：只有 `EhProtocolError` 自带码，其它一律回落到给定默认值 */
export function errorCodeOf(error: unknown, fallback: EhErrorCode = 'EH_INTERNAL'): EhErrorCode {
  return error instanceof EhProtocolError ? error.code : fallback
}

/** `错误码：消息` 形式的一行，用于日志标题（`EH_ACTIVATION_FAILED：扩展入口…`） */
export function describeError(error: unknown): string {
  return `${errorCodeOf(error)}：${toErrorMessage(error)}`
}

/** 保证拿到一个 `Error` 实例（需要抛错/当 cause 用时） */
export function ensureError(error: unknown): Error {
  if (error instanceof Error) return error
  const wrapped = new Error(toErrorMessage(error))
  wrapped.name = 'ExtensionHostError'
  return wrapped
}

/** `EH_ERROR_TEXT` 的中文文案（桩/守卫抛错时复用，避免各处重复写文案） */
export function errorTextOf(code: EhErrorCode): string {
  return EH_ERROR_TEXT[code]
}
