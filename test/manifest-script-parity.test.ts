/**
 * 差分门禁：同一批 fixture 同时喂**宿主规则**与**仓库级校验脚本**，两边结论必须逐字一致。
 *
 * 为什么要这道门禁：`scripts/validate-manifest.mjs` 是宿主规则的自包含副本
 * （Node 原生跑 `.mjs` 解析不了 `src/` 内部的无扩展名 import，脚本因此不能 import `core/manifest.ts`
 * 与 `shared/ipcDeclaration.ts`）。副本一定会漂移，而且漂移的典型表现正是"给非法 manifest 发绿灯"
 * （历史上脚本漏掉 ipcChannels/keybindings/menus/views 四类 error，对 `transport:"tcp"` 输出「✓ 通过」）。
 * 只有逐字比对 `{level, message}` 才能拦住文案与规则的漂移。
 *
 * 脚本自 ADR-0023 决策 5 起位于仓库级 `scripts/`（不再是 `skills/obox-ext-dev/scripts/`），
 * 但"自包含 + 可复制到无 obox 源码的扩展仓库"这条性质不变——它仍然只 import `node:` 内建模块。
 *
 * 覆盖面说明：宿主 `validateManifest()` **只产出 error**，warning 是在 `host.ts` 的
 * `registerContributions` 阶段追加的（依赖运行期状态：keybindingStore、入口模块导出表）。
 * 所以这里比对的是 error 面；fixtures 必须保持 **0 warning**（否则会出现"仅脚本一侧"的消息，
 * 那是脚本超出 `validateManifest()` 的部分，不是漂移）。脚本侧的 warning 规则另行在脚本内注释说明。
 *
 * 例外段（progress 字段全链，卡 04）：脚本对 `contributes.settings` 做了**独有的静态收紧**
 * （字段类型白名单 / `max` 必须 >0 的数字 / `progress` 的 `default` 必须是数字），宿主的
 * `validateManifest()` **不**校验 settings——宿主运行期对未知字段类型的策略是"兜底渲染成
 * 可编辑 text + console.warn"（SettingsView.vue 链尾 v-else），不是清单 error。收紧的理由：
 * type 写错（如 'gauge'）的 manifest 一旦发布，只读字段（status/progress）在用户机器上就是
 * 一个**可编辑文本框**，误编辑即覆盖扩展写的状态——静态校验是发布前唯一拦截点。
 * 该段不参与 fixture 差分比对（现有 fixtures 不含非法 settings；ok-full.json 的 settings
 * 声明合法，两侧 0 error）；白名单与宿主 `SettingFieldType` 的一致性由下方专门的
 * 源码解析断言钉住（TS 类型别名没有运行时痕迹，只能两侧各自解析源码比对）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateManifest } from '../src/renderer/src/core/manifest'

/** 仓库根（本文件在 <root>/test/ 下；resolve 会去掉 `..` 带出的尾部路径分隔符） */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(repoRoot, 'scripts', 'validate-manifest.mjs')
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

/**
 * 宿主 `SettingFieldType` 白名单：从 src/api/contributions.ts **源码**解析联合类型声明。
 * TS 类型别名没有运行时痕迹（编译后即消失），无法经 import 取值——解析源码是差分的唯一形态。
 * 声明形状固定为 `export type SettingFieldType =` 起、到下一个空行止（成员全是单引号字面量）。
 */
function hostSettingFieldTypes(): string[] {
  const src = readFileSync(join(repoRoot, 'src', 'api', 'contributions.ts'), 'utf8')
  const at = src.indexOf('export type SettingFieldType')
  expect(at).toBeGreaterThan(-1)
  const decl = src.slice(at, src.indexOf('\n\n', at))
  const types = [...decl.matchAll(/'([^']+)'/g)].map((m) => m[1])
  expect(types.length).toBeGreaterThan(0)
  return types
}

/** 脚本侧白名单：从 scripts/validate-manifest.mjs 源码解析 `SETTING_FIELD_TYPES` 数组 */
function scriptSettingFieldTypes(): string[] {
  const src = readFileSync(scriptPath, 'utf8')
  const decl = /const SETTING_FIELD_TYPES = \[([\s\S]*?)\]/.exec(src)?.[1] ?? ''
  const types = [...decl.matchAll(/'([^']+)'/g)].map((m) => m[1])
  expect(types.length).toBeGreaterThan(0)
  return types
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

describe('manifest 校验：宿主规则与仓库脚本的差分门禁', () => {
  it('fixtures 覆盖设计要求的全部用例', () => {
    expect(fixtures).toEqual(expect.arrayContaining(requiredFixtures))
  })

  it('脚本保持自包含：只 import node 内建模块（可复制到没有 obox 源码的扩展仓库）', () => {
    // 注释里出现的 import 字样不算：先剥掉块注释再抽真实的 import 说明符
    const code = readFileSync(scriptPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const specifiers: string[] = []
    const importRe = /\bimport\b[\s\S]*?from\s*['"]([^'"]+)['"]/g
    let match = importRe.exec(code)
    while (match) {
      specifiers.push(match[1])
      match = importRe.exec(code)
    }
    expect(specifiers.length).toBeGreaterThan(0)
    // 只允许 node: 内建模块——不得出现 src/**、相对路径或 npm 包
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([])
  })

  it('settings 字段类型白名单：脚本与宿主 SettingFieldType 逐字相等（含 API v2 新增的 progress）', () => {
    const host = hostSettingFieldTypes()
    const script = scriptSettingFieldTypes()
    // 逐字相等 = 集合与**顺序**都一致：脚本报错文案「允许：text / number / …」直接列出该顺序，
    // 顺序不同即文案漂移
    expect(script).toEqual(host)
    // progress（设置页进度条字段）必须两侧都在——宿主类型加了而脚本白名单漏了的话，
    // 合法 progress manifest 会被脚本判 error（"给合法清单亮红灯"方向的漂移，同样是门禁要拦的）
    expect(host).toContain('progress')
    expect(host).toEqual(['text', 'number', 'boolean', 'select', 'directory', 'status', 'progress'])
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
