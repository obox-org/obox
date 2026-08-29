/**
 * uiStore（QuickPick/InputBox/toast/progress）与 outputStore（输出通道）单测。
 * 纯渲染侧状态逻辑，不依赖 DOM/Electron。
 */
import { describe, expect, it } from 'vitest'
import { uiState, uiStore } from '../src/renderer/src/core/uiStore'
import { outputState, outputStore } from '../src/renderer/src/core/outputStore'

describe('uiStore：showQuickPick', () => {
  it('打开后返回选中项 label；取消返回 undefined', async () => {
    const p = uiStore.showQuickPick([{ label: 'A' }, { label: 'B' }], { title: '选择' })
    expect(uiState.quickPick).not.toBeNull()
    expect(uiState.quickPick?.items).toHaveLength(2)
    expect(uiState.quickPick?.title).toBe('选择')

    uiStore.resolveQuickPick('B')
    await expect(p).resolves.toBe('B')
    expect(uiState.quickPick).toBeNull()

    const p2 = uiStore.showQuickPick([{ label: 'A' }])
    uiStore.resolveQuickPick(undefined)
    await expect(p2).resolves.toBeUndefined()
  })
})

describe('uiStore：showInputBox', () => {
  it('返回输入值；支持 password 遮蔽', async () => {
    const p = uiStore.showInputBox({ title: '输入', password: true })
    expect(uiState.inputBox?.password).toBe(true)
    uiState.inputBox!.value = 'secret'
    uiStore.resolveInputBox('secret')
    await expect(p).resolves.toBe('secret')
    expect(uiState.inputBox).toBeNull()
  })
})

describe('uiStore：toast 与 progress', () => {
  it('showToast 入列、dismiss 移除', () => {
    uiStore.showToast('hello', 'info', 0)
    uiStore.showToast('warn', 'warning', 0)
    expect(uiState.toasts).toHaveLength(2)
    const id = uiState.toasts[0].id
    uiStore.dismissToast(id)
    expect(uiState.toasts).toHaveLength(1)
  })

  it('showProgress/hideProgress', () => {
    uiStore.showProgress('同步中', 30)
    expect(uiState.progress).toMatchObject({ title: '同步中', percent: 30 })
    uiStore.hideProgress()
    expect(uiState.progress).toBeNull()
  })
})

describe('outputStore：createChannel', () => {
  it('append/appendLine/clear/show/dispose', () => {
    const ch = outputStore.createChannel('日志')
    expect(outputState.channels).toHaveLength(1)
    ch.append('a')
    ch.appendLine('b')
    const active = outputState.channels[0]
    expect(active.lines).toEqual(['a', 'b\n'])

    ch.show()
    expect(outputState.activeId).toBe(active.id)
    expect(outputState.visible).toBe(true)

    ch.clear()
    expect(active.lines).toEqual([])

    ch.dispose()
    expect(outputState.channels).toHaveLength(0)
  })
})
