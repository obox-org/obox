import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * `api.pages.open` / `api.extensions.restartHost` 的落地链路（change 任务 5.2）。
 *
 * 这两项跨了四层：宿主 api → 渲染侧 hostQuery 分发 → shell（App.vue）/ main IPC。
 * 任何一层漏接都会"调用成功但什么都没发生"，所以用源码门禁钉住每一层的存在。
 */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL('../' + rel, import.meta.url)), 'utf8')
}

describe('pages.open / restartHost 链路', () => {
  it('shell（App.vue）监听 obox:host-request 并切到 pageId', () => {
    const src = read('src/renderer/src/App.vue')
    expect(src).toContain("addEventListener('obox:host-request'")
    expect(src).toContain('selectNav(detail.pageId)')
    expect(src).toContain("removeEventListener('obox:host-request'")
  })

  it('restartHost 走 main 的 app:relaunch', () => {
    expect(read('src/renderer/src/core/hostQueryDeps.ts')).toContain('window.api.relaunchApp()')
    expect(read('src/main/capabilities.ts')).toContain("ipcMain.handle('app:relaunch'")
    expect(read('src/preload/index.ts')).toContain("invoke('app:relaunch')")
    expect(read('src/shared/types.ts')).toContain('relaunchApp(): Promise<void>')
  })

  it('宿主 api 的 pages/restartHost 走 ui.hostQuery（不是本地 no-op）', () => {
    const src = read('src/extension-host/apiFactory.ts')
    expect(src).toContain("plane.hostQuery('pages.open'")
    expect(src).toContain("plane.hostQuery('extensions.restartHost'")
  })
})
