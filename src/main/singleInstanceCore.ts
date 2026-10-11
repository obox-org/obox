/**
 * 单实例的纯逻辑（ADR-0019 决策 9）。
 *
 * 决策：第二个进程**不转发**启动参数（转发需要合并/去重语义，如 `--debug-extension` 可重复、
 * `--remote-debugging-port` 语义特殊），只把已有主窗口唤到前台，并在日志里**明确说明**参数被忽略——
 * 否则开发时"obox 已在托盘、再跑一次带调试扩展的启动却没生效"会非常难查。
 */

/** Electron/Chromium 自己注入的开关，不该出现在"被忽略的参数"清单里 */
const INTERNAL_SWITCHES: readonly RegExp[] = [
  /^--allow-file-access-from-files$/,
  /^--original-process-start-time=/,
  /^--user-data-dir=/,
  /^--no-sandbox$/
]

/**
 * 从 argv 里挑出"用户传入但会被忽略"的开关，**连同它的值**（如 `--debug-extension demo@C:\path`）。
 * 只列开关本身会把 `--debug-extension` 的扩展 id/路径丢掉，等于没记（单测覆盖）。
 */
export function ignoredArgs(argv: readonly string[]): string[] {
  const picked: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    if (INTERNAL_SWITCHES.some((pattern) => pattern.test(arg))) continue
    picked.push(arg)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      picked.push(next)
      i += 1
    }
  }
  return picked
}

/** 第二实例的日志文案（中英同形：主进程日志本来就是技术日志，这里保持中文） */
export function secondaryInstanceNotice(argv: readonly string[], appName = 'obox'): string {
  const args = ignoredArgs(argv)
  const head = `已有 ${appName} 实例在运行`
  if (args.length === 0) return `${head}：只把已有主窗口唤到前台`
  return `${head}：本次启动的参数被忽略（${args.join(' ')}），只把已有主窗口唤到前台`
}
