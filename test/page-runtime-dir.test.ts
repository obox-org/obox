/**
 * 页面运行时目录解析（change `unified-page-context` 任务 3.2 的打包侧）。
 *
 * 覆盖判据：
 * - 开发期指向仓库 `src/page-runtime`（改动即时生效，不需要构建步骤）；
 * - 打包后指向 `<resources>/page-runtime`（electron-builder `extraResources` 的目标，
 *   asar 外、`net.fetch(file://)` 可直接读）；
 * - 两者不同正是"打包后 app://obox/page.js 404"的常见根因，所以必须钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ packaged: false, resourcesPath: 'C:\\app\\resources' }))

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return state.packaged
    },
    getPath: (): string => 'C:\\userData',
    getAppPath: (): string => 'C:\\repo'
  }
}))

import { getPageRuntimeDir } from '../src/main/paths'

describe('getPageRuntimeDir', () => {
  beforeEach(() => {
    state.packaged = false
  })
  afterEach(() => {
    state.packaged = false
  })

  it('开发期：仓库 src/page-runtime', () => {
    const dir = getPageRuntimeDir()
    expect(dir.endsWith('src\\page-runtime') || dir.endsWith('src/page-runtime')).toBe(true)
  })

  it('打包后：<resources>/page-runtime', () => {
    state.packaged = true
    const oldResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', {
      value: state.resourcesPath,
      configurable: true
    })
    try {
      expect(getPageRuntimeDir()).toBe('C:\\app\\resources\\page-runtime')
    } finally {
      if (oldResources) Object.defineProperty(process, 'resourcesPath', oldResources)
    }
  })
})
