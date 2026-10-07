/**
 * 收集扩展包内 Python 运行时与三方库的许可文本，生成 `THIRD-PARTY-NOTICES.txt`（含 PSF 第 3 条要求的
 * "对 Python 的修改摘要"），并写 `license-notices.json` 作为指纹留痕（见 issue #51 / ADR-0018）。
 *
 *   node scripts/collect-python-licenses.mts --ext extensions/my-py-ext          # 生成/更新
 *   node scripts/collect-python-licenses.mts --ext extensions/my-py-ext --check   # 只校验（CI 防漂移）
 *
 * 挑选与拼接逻辑（`isLicenseFile` / `collectLicenseFiles` / `buildNotices` / `noticesMeta`）都在
 * `src/main/licenseNotice.ts`，有单测；这里只做 I/O。
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  buildNotices,
  collectLicenseFiles,
  noticesMeta,
  type NoticeFile
} from '../src/main/licenseNotice.ts'

const NOTICES_NAME = 'THIRD-PARTY-NOTICES.txt'
const META_NAME = 'license-notices.json'

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const out: string[] = []
  for (const item of await readdir(current, { withFileTypes: true })) {
    const abs = join(current, item.name)
    if (item.isDirectory()) {
      out.push(...(await listFiles(root, abs)))
      continue
    }
    out.push(relative(root, abs).split(sep).join('/'))
  }
  return out
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    // 容错 BOM：清单可能由别的工具/编辑器写出（PowerShell 的 `Set-Content -Encoding utf8` 就带 BOM，
    // 而 JSON.parse 遇到 BOM 会直接失败——本地冒烟时真踩到了）
    const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const extArg = argValue('ext')
  if (!extArg) throw new Error('必填：--ext <扩展目录>')
  const ext = resolve(extArg)
  const pythonDir = join(ext, 'python')
  const check = process.argv.includes('--check')

  // 运行时信息优先取自打包脚本留下的 python-package.json，其次取参数
  const pkg = await readJson<{ arch?: string; python?: string }>(join(ext, 'python-package.json'))
  const manifest = await readJson<{ name?: string; displayName?: string }>(
    join(ext, 'manifest.json')
  )
  const pythonVersion = argValue('python') ?? pkg?.python
  const arch = argValue('arch') ?? pkg?.arch
  if (!pythonVersion || !arch) {
    throw new Error(
      '缺 Python 版本/架构：请先跑 scripts/build-python-runtime.mts，或用 --python/--arch 指定'
    )
  }
  const subject = manifest?.displayName ?? manifest?.name ?? ext.split(sep).pop() ?? 'extension'

  // 收集许可文件（只读文本；二进制跳过）
  const all = await listFiles(pythonDir).catch(() => [] as string[])
  if (all.length === 0)
    throw new Error(`没有找到运行时目录：${pythonDir}（先跑 build-python-runtime.mts）`)
  const files: NoticeFile[] = []
  for (const rel of collectLicenseFiles(all)) {
    const abs = join(pythonDir, rel)
    const info = await stat(abs)
    if (info.size > 512 * 1024) continue // 超大文件不是许可文本
    files.push({ path: `python/${rel}`, content: await readFile(abs, 'utf8') })
  }

  const input = { subject, pythonVersion, arch, files }
  const meta = noticesMeta(input)
  const noticesPath = join(ext, NOTICES_NAME)
  const metaPath = join(ext, META_NAME)

  if (check) {
    const existing = await readJson<{ digest?: string; licenseFileCount?: number }>(metaPath)
    const noticesText = await readFile(noticesPath, 'utf8').catch(() => undefined)
    const problems: string[] = []
    if (!noticesText) problems.push(`缺少 ${NOTICES_NAME}`)
    if (!existing) problems.push(`缺少 ${META_NAME}`)
    if (existing && existing.digest !== meta.digest) {
      problems.push(
        `许可内容已变化（记录 ${existing.digest.slice(0, 12)}… ≠ 当前 ${meta.digest.slice(0, 12)}…）`
      )
    }
    if (problems.length > 0) {
      console.error(`[licenses] ✗ ${problems.join('；')}`)
      console.error(
        '[licenses] 重新生成：node scripts/collect-python-licenses.mts --ext <扩展目录>'
      )
      process.exitCode = 1
      return
    }
    console.log(
      `[licenses] ✓ 声明与包内一致（${meta.licenseFileCount} 份，${meta.digest.slice(0, 12)}…）`
    )
    return
  }

  await writeFile(noticesPath, buildNotices(input), 'utf8')
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  console.log(`[licenses] 已写 ${NOTICES_NAME}（${meta.licenseFileCount} 份许可）+ ${META_NAME}`)
  if (files.length === 0) {
    console.warn(
      '[licenses] 警告：没有找到任何许可文件——请确认运行时目录完整（LICENSE.txt 应存在）'
    )
  }
}

await main()
