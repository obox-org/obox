/**
 * stdio 助手启动参数解析：`.js/.cjs/.mjs` 必须跑成**纯 Node**。
 *
 * 背景（实测）：宿主用 `process.execPath`（electron.exe）跑扩展随包的 JS 助手。若不给
 * `ELECTRON_RUN_AS_NODE=1`，Electron 会以**应用模式**启动脚本——脚本会执行，但 **stdin 不接**、
 * 进程永不退出，于是 `api.ipc` 的 stdio 协议根本收不到请求。这个用例把该约束钉死。
 */
import { describe, expect, it } from 'vitest'
import { resolveStdioSpawn } from '../src/main/ipcCore'

const EXEC = 'C:\\path\\to\\electron.exe'

describe('resolveStdioSpawn：stdio 助手的启动参数', () => {
  it('.cjs 助手 → 换成宿主 Node 并注入 ELECTRON_RUN_AS_NODE', () => {
    const r = resolveStdioSpawn({ program: 'helper.cjs', args: ['--selftest'], execPath: EXEC })
    expect(r.isJs).toBe(true)
    expect(r.program).toBe(EXEC)
    expect(r.args).toEqual(['helper.cjs', '--selftest'])
    expect(r.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it.each(['a.js', 'a.cjs', 'a.mjs', 'A.CJS'])('%s 都按 JS 处理（大小写不敏感）', (program) => {
    const r = resolveStdioSpawn({ program, execPath: EXEC })
    expect(r.isJs).toBe(true)
    expect(r.program).toBe(EXEC)
    expect(r.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('编译产物/系统程序 → 原样执行，不注入 electron 环境变量', () => {
    const r = resolveStdioSpawn({
      program: 'bin/server.exe',
      args: ['--port', '1'],
      execPath: EXEC
    })
    expect(r).toEqual({ program: 'bin/server.exe', args: ['--port', '1'], isJs: false })
    expect(r.env).toBeUndefined()
  })

  it('args 缺省时给空数组（spawn 不接受 undefined 参数表）', () => {
    expect(resolveStdioSpawn({ program: 'helper.mjs', execPath: EXEC }).args).toEqual([
      'helper.mjs'
    ])
  })
})
