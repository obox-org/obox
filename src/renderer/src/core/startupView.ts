/**
 * 启动视图选择（纯函数，可单测）。
 *
 * 策略：**每次启动固定显示"应用"（Apps）扩展**，不恢复上次选择——
 * 启动行为必须可预期：无论上次停在哪个导航项，重启后都回到"应用"。
 *
 * 找不到目标项时逐级回退，避免目标扩展被禁用/卸载后内容区白屏。
 */

/** 启动时固定显示的导航项 id（"应用"扩展贡献的 app.main） */
export const STARTUP_NAV_ID = 'app.main'

export interface StartupNavCandidate {
  id: string
  active: boolean
  group?: string
}

/**
 * 选启动时激活的导航项：
 *
 * 1. 目标项（默认 `app.main`）且处于激活态 → 用它；
 * 2. 否则第一个激活的 `top` 组项；
 * 3. 否则第一个激活项（任意组）；
 * 4. 都没有 → `null`（内容区显示空态）。
 */
export function pickStartupNavId(
  items: readonly StartupNavCandidate[],
  targetId: string = STARTUP_NAV_ID
): string | null {
  const active = items.filter((i) => i.active)
  const target = active.find((i) => i.id === targetId)
  if (target) return target.id
  const top = active.find((i) => (i.group ?? 'top') === 'top')
  return (top ?? active[0])?.id ?? null
}
