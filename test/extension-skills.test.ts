/**
 * 九步链一致性门禁（ADR-0023 决策 1–13）。
 *
 * 为什么需要：扩展开发流程从"一个技能"拆成"九个技能 + 一份公共总览"后，最大的风险不是某个技能写错，
 * 而是九个文件**各说各话**——门禁选项措辞漂移、下一步指错、API 公共路径失效、旧的 `tmp/spec` 流程复活。
 * 这些错误单看一个文件都不显眼，只有跨文件比对才暴露，所以钉在测试里而不是靠人工审查。
 *
 * 门禁同时钉死两条**用户决策**（易被后来者好心"改进"掉）：
 * - 决策 11：流程**不设入口**——`AGENTS.md` 与 `README.md` 都不得出现九步链总览的指针；
 * - 决策 5：API 文档唯一真相在 `docs/extension-api/`，技能里**不得**再引用旧的技能内 references 路径。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 九步链顺序（ADR-0023 决策 1）；顺序本身也要被断言，因此写成数组而非集合 */
const CHAIN = ['init', 'grill', 'proposal', 'design', 'validation', 'task', 'dev', 'check', 'ship']
const NEXT: Record<string, string | null> = {
  init: 'obox-ext-grill',
  grill: 'obox-ext-proposal',
  proposal: 'obox-ext-design',
  design: 'obox-ext-validation',
  validation: 'obox-ext-task',
  task: 'obox-ext-dev',
  dev: 'obox-ext-check',
  check: 'obox-ext-ship',
  ship: null
}

/** 必须在技能里出现 `docs/extension-api/` 的阶段：spec / design / validation / dev（ADR-0023 决策 5） */
const STAGES_NEEDING_API = ['proposal', 'design', 'validation', 'dev']
/** 必须出现三档结论的阶段（ADR-0023 决策 8） */
const STAGES_WITH_GRADES = ['validation', 'check']

const skillDir = (stage: string): string => join(repoRoot, 'skills', `obox-ext-${stage}`)
const skillFile = (stage: string): string => join(skillDir(stage), 'SKILL.md')
const readSkill = (stage: string): string => readFileSync(skillFile(stage), 'utf8')

/** 拆出 frontmatter 的 name/description 与正文 */
function parseFrontmatter(text: string): { name: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!match) return { name: '', description: '', body: text }
  const [, head, body] = match
  const field = (key: string): string => {
    const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(head)
    return line ? line[1].trim() : ''
  }
  return { name: field('name'), description: field('description'), body }
}

describe('九步链：文件与顺序', () => {
  it('九个技能目录各有 SKILL.md', () => {
    const missing = CHAIN.filter((stage) => !existsSync(skillFile(stage)))
    expect(missing).toEqual([])
  })

  it('顺序与 ADR-0023 决策 1 一致（init → … → ship）', () => {
    // 用每份 SKILL.md 里"下一步技能"的指向串成链，验证的是一条**可走的路径**而不是目录名列表
    const problems: string[] = []
    for (const stage of CHAIN) {
      const text = readSkill(stage)
      const next = NEXT[stage]
      if (next === null) {
        if (!/流程结束|最后一步|没有下一步/.test(text)) {
          problems.push(`obox-ext-${stage}：作为末步必须写明"流程结束/最后一步/没有下一步"`)
        }
        continue
      }
      if (!text.includes(next)) problems.push(`obox-ext-${stage}：未指向下一步 ${next}`)
    }
    expect(problems).toEqual([])
  })

  it('一份 SKILL.md 不超过 8000 字符（ADR-0020 记录的 8192 裁剪阈值）', () => {
    const tooLong = CHAIN.map((stage) => ({
      stage,
      chars: [...readSkill(stage)].length
    })).filter((entry) => entry.chars > 8000)
    expect(tooLong).toEqual([])
  })
})

describe('九步链：frontmatter 与可触发性', () => {
  it('name 与目录同名、description 非空且九个互不重复', () => {
    const names: string[] = []
    const descriptions: string[] = []
    for (const stage of CHAIN) {
      const { name, description } = parseFrontmatter(readSkill(stage))
      expect(name, `obox-ext-${stage} 的 frontmatter.name`).toBe(`obox-ext-${stage}`)
      expect(description.length, `obox-ext-${stage} 的 description 过短`).toBeGreaterThan(20)
      expect(description.length, `obox-ext-${stage} 的 description 过长`).toBeLessThan(400)
      names.push(name)
      descriptions.push(description)
    }
    expect(new Set(names).size).toBe(CHAIN.length)
    expect(new Set(descriptions).size).toBe(CHAIN.length)
  })

  it('每个技能都指向公共总览，并声明用 ask_user_question 提问', () => {
    const problems: string[] = []
    for (const stage of CHAIN) {
      const text = readSkill(stage)
      if (!text.includes('docs/extension-workflow.md')) {
        problems.push(`obox-ext-${stage}：未引用公共总览 docs/extension-workflow.md`)
      }
      if (!text.includes('ask_user_question')) {
        problems.push(`obox-ext-${stage}：未声明用 ask_user_question 提问`)
      }
    }
    // 总览与技能必须用同一个工具名：历史上总览写成了 PascalCase 的 `AskUserQuestion`
    const overview = readFileSync(join(repoRoot, 'docs/extension-workflow.md'), 'utf8')
    if (!overview.includes('ask_user_question')) {
      problems.push('docs/extension-workflow.md：未使用 ask_user_question')
    }
    if (overview.includes('AskUserQuestion')) {
      problems.push('docs/extension-workflow.md：出现 PascalCase 的 AskUserQuestion')
    }
    expect(problems).toEqual([])
  })
})

describe('九步链：门禁与三档结论', () => {
  it('每个技能的门禁都含固定四选项措辞', () => {
    // ① 的措辞按位置区分：init…check 是"通过，自动进入 <下一步>"；ship 是末步，① 是"通过，流程结束"
    const problems: string[] = []
    for (const stage of CHAIN) {
      const text = readSkill(stage)
      const enterPhrase = NEXT[stage] === null ? '流程结束' : '自动进入'
      // `init` 是链条第 1 步、没有上一步：它的第 3 项写成「回到第 0 步重选模式」（见 workflow §五）
      const backPhrase = stage === 'init' ? '回到第 0 步重选模式' : '回到上一步'
      for (const phrase of [backPhrase, '部分修改后重跑本步', '暂停', enterPhrase]) {
        if (!text.includes(phrase)) problems.push(`obox-ext-${stage}：门禁缺少「${phrase}」`)
      }
    }
    expect(problems).toEqual([])
  })

  it('validation 与 check 都含三档结论与修复意见', () => {
    const problems: string[] = []
    for (const stage of STAGES_WITH_GRADES) {
      const text = readSkill(stage)
      for (const phrase of ['一般建议', '普通问题', '严重问题', '修复意见']) {
        if (!text.includes(phrase)) problems.push(`obox-ext-${stage}：缺少「${phrase}」`)
      }
      if (!/文件:行|文件：行/.test(text))
        problems.push(`obox-ext-${stage}：未要求给「文件:行」定位`)
    }
    expect(problems).toEqual([])
  })
})

describe('九步链：各阶段特有职责', () => {
  it('spec / design / validation / dev 都能看到 API 公共文档', () => {
    const problems = STAGES_NEEDING_API.filter(
      (stage) => !readSkill(stage).includes('docs/extension-api/')
    ).map((stage) => `obox-ext-${stage}：未引用 docs/extension-api/`)
    expect(problems).toEqual([])
  })

  it('task 要求文件所有权与并行组，dev 明确不提交，ship 负责归档与发版', () => {
    const task = readSkill('task')
    for (const phrase of ['文件所有权', '并行组', 'notes/tasks/']) {
      expect(task, `obox-ext-task 缺少「${phrase}」`).toContain(phrase)
    }
    const dev = readSkill('dev')
    for (const phrase of ['不提交', 'notes/dev.md']) {
      expect(dev, `obox-ext-dev 缺少「${phrase}」`).toContain(phrase)
    }
    const ship = readSkill('ship')
    for (const phrase of ['docs/spec/UID-', 'index.md', 'openspec archive', '发版']) {
      expect(ship, `obox-ext-ship 缺少「${phrase}」`).toContain(phrase)
    }
  })

  it('init 具备新建 / 修复双模式', () => {
    const init = readSkill('init')
    for (const phrase of ['新建', '修复', 'openspec/', 'docs/spec/UID-']) {
      expect(init, `obox-ext-init 缺少「${phrase}」`).toContain(phrase)
    }
  })
})

describe('九步链：被取代的旧流程不得复活', () => {
  it('技能里不出现旧的技能内 references 路径与 tmp 流程', () => {
    const forbidden = [
      'references/api-reference.md',
      'references/manifest-reference.md',
      'references/themes-settings.md',
      'references/troubleshooting.md',
      'references/workflow.md',
      'tmp/spec',
      'tmp/adr'
    ]
    const problems: string[] = []
    for (const stage of CHAIN) {
      const text = readSkill(stage)
      for (const phrase of forbidden) {
        if (text.includes(phrase)) problems.push(`obox-ext-${stage}：出现被取代的「${phrase}」`)
      }
      if (/\bM[1-8]\b/.test(text)) problems.push(`obox-ext-${stage}：出现旧的 M1–M8 流程字样`)
    }
    expect(problems).toEqual([])
  })

  it('流程不设入口：AGENTS.md 与 README.md 都不得出现九步链总览的指针（ADR-0023 决策 11）', () => {
    const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8')
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
    expect(agents).not.toContain('docs/extension-workflow.md')
    expect(readme).not.toContain('docs/extension-workflow.md')
  })
})

describe('九步链：引用的仓库内路径必须真实存在', () => {
  it('技能里反引号内的仓库路径可解析（挡 dangling reference）', () => {
    // 只校验**仓库根锚定**的前缀：`skills/**` 与 `docs/**`。
    // 技能里的 `scripts/**` 多半指**扩展工程内**的路径（如生成的 `scripts/pack.mjs`），不锚定 obox 仓库根，
    // 因此只放行仓库级那一个脚本（它另由"公共文档与 ADR 都在位"用例把关）。
    const prefixes = ['skills/', 'docs/']
    const repoLevelScripts = ['scripts/validate-manifest.mjs']
    const problems: string[] = []
    for (const stage of CHAIN) {
      const text = readSkill(stage)
      const matches = text.matchAll(/`([A-Za-z0-9_./-]+)`/g)
      for (const [, raw] of matches) {
        if (!prefixes.some((prefix) => raw.startsWith(prefix)) && !repoLevelScripts.includes(raw)) {
          continue
        }
        if (raw.includes('obox-ext-*')) continue // 通配写法，不是具体路径
        const abs = join(repoRoot, raw)
        if (!existsSync(abs)) problems.push(`obox-ext-${stage}: \`${raw}\` 不存在`)
        else if (raw.endsWith('/') && !statSync(abs).isDirectory()) {
          problems.push(`obox-ext-${stage}: \`${raw}\` 不是目录`)
        }
      }
    }
    expect([...new Set(problems)]).toEqual([])
  })

  it('公共文档与 ADR 都在位', () => {
    const required = [
      'docs/extension-workflow.md',
      'docs/extension-api/api-reference.md',
      'docs/extension-api/manifest-reference.md',
      'docs/extension-api/themes-settings.md',
      'docs/extension-api/troubleshooting.md',
      'docs/adr/0023-extension-dev-openspec-workflow.md',
      'scripts/validate-manifest.mjs'
    ]
    expect(required.filter((path) => !existsSync(join(repoRoot, path)))).toEqual([])
  })
})
