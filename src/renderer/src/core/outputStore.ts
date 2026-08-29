/**
 * 扩展输出通道状态（渲染侧）：OutputChannel 数据 + 底部面板开关。
 */
import { reactive } from 'vue'

export interface OutputChannelState {
  id: string
  name: string
  lines: string[]
}

export const outputState = reactive({
  channels: [] as OutputChannelState[],
  activeId: null as string | null,
  visible: false
})

let channelSeq = 0

export const outputStore = {
  /** 创建输出通道（返回扩展侧句柄） */
  createChannel(name: string): {
    append(text: string): void
    appendLine(text: string): void
    show(): void
    clear(): void
    dispose(): void
  } {
    const id = `out-${++channelSeq}`
    const state: OutputChannelState = { id, name, lines: [] }
    outputState.channels.push(state)
    return {
      append: (text) => {
        state.lines.push(String(text ?? ''))
      },
      appendLine: (text) => {
        state.lines.push(String(text ?? '') + '\n')
      },
      show: () => {
        outputState.activeId = id
        outputState.visible = true
      },
      clear: () => {
        state.lines = []
      },
      dispose: () => {
        outputState.channels = outputState.channels.filter((c) => c.id !== id)
        if (outputState.activeId === id) {
          outputState.activeId = outputState.channels[0]?.id ?? null
        }
      }
    }
  },

  setActive(id: string): void {
    outputState.activeId = id
  },

  toggle(): void {
    outputState.visible = !outputState.visible
  },

  close(): void {
    outputState.visible = false
  }
}
