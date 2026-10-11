/**
 * 差分门禁：同一批 fixture 同时喂**宿主规则**与**skill 校验脚本**，两边结论必须逐字一致。
 *
 * 为什么要这道门禁：`skills/obox-ext-dev/scripts/validate-manifest.mjs` 是宿主规则的自包含副本
 * （Node 原生跑 `.mjs` 解析不了 `src/` 内部的无扩展名 import，脚本因此不能 import `core/manifest.ts`
 * 与 `shared/ipcDeclaration.ts`）。副本一定会漂移，而且漂移的典型表现正是"给非法 manifest 发绿灯"
 * （历史上脚本漏掉 ipcChannels/keybindings/menus/views 四类 error，对 `transport:"tcp"` 输出「✓ 通过」）。
 * 只有逐字比对 `{level, message}` 才能拦住文案与规则的漂移。
 *
 * 覆盖面说明：宿主 `validateManifest()` **只产出 error**，warning 是在 `host.ts` 的
 * `registerContributions` 阶段追加的（依赖运行期状态：keybindingStore、入口模块导出表）。
 * 所以这里比对的是 error 面；fixtures 必须保持 **0 warning**（否则会出现"仅脚本一侧"的消息，
 * 那是脚本超出 `validateManifest()` 的部分，不是漂移）。脚本侧的 warning 规则另行在脚本内注释说明。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateManifest } from '../src/renderer/src/core/manifest'

/** 仓库根（本文件在 <root>/test/ 下；resolve 会去掉 `..` 带出的尾部路径分隔符） */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(repoRoot, 'skills', 'obox-ext-dev', 'scripts', 'validate-manifest.mjs')
const fixturesDir = join(repoRoot, 'test', 'fixtures', 'manifest-parity')

interface Message {
  level: 'error' | 'warning'
  message: string
}

interface ScriptReport {
  root: string
  files: Array<{ path: string; messages: Message[] }>
  errorCount: number
  warningCount: number
}

/** 跑脚本：exit 0 走返回值，非 0 会 throw（用 err.status/err.stdout 取回来） */
function runScript(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
    return { status: 0, stdout }
  } catch (err) {
    const failure = err as { status?: number | null; stdout?: string | null }
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '' }
  }
}

/** 多重集规范化：排序 + level 与 message 一起编码，避免顺序敏感 */
function multiset(messages: Message[]): string[] {
  return messages.map((m) => `${m.level}\u0000${m.message}`).sort()
}

/** 宿主侧：severity → level */
function hostMessages(fixturePath: string): Message[] {
  const raw: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'))
  return validateManifest(raw).map((v) => ({
    level: v.severity === 'error' ? ('error' as const) : ('warning' as const),
    message: v.message
  }))
}

const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .sort()

/** 设计文档 §7 要求覆盖的用例 */
const requiredFixtures = [
  'ok-full.json',
  'bad-ipc-transport.json',
  'bad-views-shape.json',
  'bad-keybindings.json',
  'bad-menus.json',
  'bad-name-space.json',
  // issue #77：去掉 NAME_RE 的 `i` 后大写 id 必须两侧同样报 error
  'bad-name-uppercase.json',
  // issue #84：navItems / statusBarItems / commands / themes 的非数组形状（四类各取 {}/5/true 之一）
  'bad-nav-items-shape.json',
  'bad-status-bar-items-shape.json',
  'bad-commands-shape.json',
  'bad-themes-shape.json',
  'self-dep.json',
  'high-api-version.json',
  'missing-main.json'
]

describe('manifest 校验：宿主规则与 skill 脚本的差分门禁', () => {
  it('fixtures 覆盖设计要求的全部用例', () => {
    expect(fixtures).toEqual(expect.arrayContaining(requiredFixtures))
  })

  it.each(fixtures)('%s：脚本与宿主的 {level, message} 多重集逐字一致', (name) => {
    const fixturePath = join(fixturesDir, name)
    const host = hostMessages(fixturePath)
    const { status, stdout } = runScript([fixturePath, '--json'])
    const report = JSON.parse(stdout) as ScriptReport

    expect(report.files).toHaveLength(1)
    expect(report.files[0].path).toBe(fixturePath)
    expect(multiset(report.files[0].messages)).toEqual(multiset(host))

    const hostErrors = host.filter((m) => m.level === 'error').length
    expect(report.errorCount).toBe(hostErrors)
    expect(report.warningCount).toBe(0)
    // 退出码必须与 errorCount 一致：0 = 无 error，1 = 有 error
    expect(status).toBe(report.errorCount > 0 ? 1 : 0)
  })

  it('非法 fixture 必须 exit 1（防止"给无效 manifest 发绿灯"复发）', () => {
    const { status, stdout } = runScript([join(fixturesDir, 'bad-ipc-transport.json'), '--json'])
    const report = JSON.parse(stdout) as ScriptReport
    expect(status).toBe(1)
    expect(report.errorCount).toBeGreaterThan(0)
    expect(report.files[0].messages[0].message).toContain('不支持 TCP/端口')
  })

  it('--all 指向仓库根：内置扩展与用户扩展全部合法（exit 0）', () => {
    const { status, stdout } = runScript(['--all', '--root', repoRoot, '--json'])
    const report = JSON.parse(stdout) as ScriptReport
    expect(report.root).toBe(repoRoot)
    expect(status).toBe(0)
    expect(report.errorCount).toBe(0)
    expect(report.files.length).toBeGreaterThan(0)
  })

  it('--all 指向没有扩展目录的根：中文提示且 exit 2（不再 scandir ENOENT 崩栈）', () => {
    const { status, stdout } = runScript(['--all', '--root', fixturesDir, '--json'])
    expect(stdout).toBe('')
    expect(status).toBe(2)
  })
})
