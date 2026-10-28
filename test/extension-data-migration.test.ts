import { describe, expect, it } from 'vitest'
import {
  migrateLegacyExtensionData,
  type LegacyDataMigrationIO
} from '../src/main/extensionDataMigration'

/**
 * 旧目录扩展数据继承（2.0.2）。
 *
 * 真实缺陷：安装目录名从 `<manifest.name>`（`pet`）改成 `<name>_<author>`（`pet_chenzhi`）后，
 * 升级用户的存档留在旧目录里 → 新版读不到 ⇒ 表现为"数据全丢"。本模块在扫描期把旧 `data/`
 * 复制到新目录（**只补、不删、不覆盖**）。
 *
 * 用注入的假 IO 测规则，不碰真实 userData。
 */

interface FakeTree {
  dirs: Set<string>
  files: Map<string, string>
}

function makeIO(tree: FakeTree, manifestNames: Record<string, string>): LegacyDataMigrationIO {
  const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    async readdirPath(path) {
      const base = normalize(path)
      const names = new Set<string>()
      // 取"相对 base 的第一段"：既产出直接子文件，也产出**隐式的中间目录**
      // （假 IO 不维护隐式父目录，真实 fs 会列出来）
      const consider = (raw: string): void => {
        const p = normalize(raw)
        if (!p.startsWith(base + '/')) return
        const rest = p.slice(base.length + 1)
        const first = rest.split('/')[0]
        if (first) names.add(first)
      }
      for (const dir of tree.dirs) consider(dir)
      for (const file of tree.files.keys()) consider(file)
      return [...names]
    },
    async statPath(path) {
      const p = normalize(path)
      // 目录判定：显式建过的目录 **或** 有任何文件以它为父（假 IO 不维护隐式父目录）
      const isDir =
        [...tree.dirs].some((d) => normalize(d) === p) ||
        [...tree.files.keys()].some((f) => normalize(f).startsWith(p + '/'))
      const isFile = [...tree.files.keys()].some((f) => normalize(f) === p)
      if (isDir && !isFile) return { isDirectory: () => true, isFile: () => false }
      if (isFile) return { isDirectory: () => false, isFile: () => true }
      return null
    },
    async mkdirPath(path) {
      tree.dirs.add(normalize(path))
    },
    async copyFileTo(from, to) {
      const content = tree.files.get(normalize(from))
      if (content === undefined) throw new Error(`missing: ${from}`)
      tree.files.set(normalize(to), content)
    },
    async readManifestName(dir) {
      return manifestNames[normalize(dir).split('/').pop() ?? ''] ?? null
    }
  }
}

const ROOT = 'C:/userData/extensions'

function newTree(): FakeTree {
  return { dirs: new Set([ROOT]), files: new Map() }
}

describe('extensionDataMigration', () => {
  it('旧目录有数据、新目录没有 ⇒ 复制过去（不删旧目录）', async () => {
    const tree = newTree()
    tree.files.set(`${ROOT}/pet/manifest.json`, '{}')
    tree.files.set(`${ROOT}/pet/data/state.json`, '{"growth":4.85}')
    tree.files.set(`${ROOT}/pet_chenzhi/manifest.json`, '{}')
    const io = makeIO(tree, { pet_chenzhi: 'pet' })

    const result = await migrateLegacyExtensionData(ROOT, 'pet_chenzhi', io)

    expect(result.migrated).toBe(true)
    expect(result.files).toBe(1)
    expect(tree.files.get(`${ROOT}/pet_chenzhi/data/state.json`)).toBe('{"growth":4.85}')
    // 旧文件与旧目录都还在（保守：只补不删）
    expect(tree.files.get(`${ROOT}/pet/data/state.json`)).toBe('{"growth":4.85}')
  })

  it('新目录已经有数据 ⇒ 绝不覆盖', async () => {
    const tree = newTree()
    tree.files.set(`${ROOT}/pet/data/state.json`, '{"old":true}')
    tree.files.set(`${ROOT}/pet_chenzhi/data/state.json`, '{"new":true}')
    const io = makeIO(tree, { pet_chenzhi: 'pet' })

    const result = await migrateLegacyExtensionData(ROOT, 'pet_chenzhi', io)

    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('target-exists')
    expect(tree.files.get(`${ROOT}/pet_chenzhi/data/state.json`)).toBe('{"new":true}')
  })

  it('目录名与 manifest.name 相同 ⇒ same-dir（不自我复制）', async () => {
    const tree = newTree()
    tree.files.set(`${ROOT}/rdp/data/rdp.db`, 'x')
    const io = makeIO(tree, { rdp: 'rdp' })

    const result = await migrateLegacyExtensionData(ROOT, 'rdp', io)

    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('same-dir')
  })

  it('没有 manifest ⇒ no-manifest', async () => {
    const tree = newTree()
    const io = makeIO(tree, {})
    const result = await migrateLegacyExtensionData(ROOT, 'ghost_chenzhi', io)
    expect(result.reason).toBe('no-manifest')
  })

  it('旧目录不存在或 data 为空 ⇒ no-legacy', async () => {
    const tree = newTree()
    tree.files.set(`${ROOT}/webapp_chenzhi/manifest.json`, '{}')
    const io = makeIO(tree, { webapp_chenzhi: 'webapp' })
    expect((await migrateLegacyExtensionData(ROOT, 'webapp_chenzhi', io)).reason).toBe('no-legacy')

    tree.dirs.add(`${ROOT}/webapp/data`)
    expect((await migrateLegacyExtensionData(ROOT, 'webapp_chenzhi', io)).reason).toBe('no-legacy')
  })

  it('递归复制子目录里的文件（sqlite 之类的嵌套数据）', async () => {
    const tree = newTree()
    tree.files.set(`${ROOT}/todo/data/state/global.json`, '{"todos":[]}')
    tree.files.set(`${ROOT}/todo/data/state/workspace.json`, '{"x":1}')
    tree.files.set(`${ROOT}/todo_chenzhi/manifest.json`, '{}')
    const io = makeIO(tree, { todo_chenzhi: 'todo' })

    const result = await migrateLegacyExtensionData(ROOT, 'todo_chenzhi', io)

    expect(result.migrated).toBe(true)
    expect(result.files).toBe(2)
    expect(tree.files.get(`${ROOT}/todo_chenzhi/data/state/global.json`)).toBe('{"todos":[]}')
  })

  it('IO 抛错时返回 error 而不是把扫描打断', async () => {
    const io: LegacyDataMigrationIO = {
      readdirPath: async () => {
        throw new Error('EACCES')
      },
      statPath: async () => ({ isDirectory: () => true, isFile: () => false }),
      mkdirPath: async () => {
        /* noop */
      },
      copyFileTo: async () => {
        /* noop */
      },
      readManifestName: async () => 'pet'
    }
    const result = await migrateLegacyExtensionData(ROOT, 'pet_chenzhi', io)
    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('error')
  })
})
