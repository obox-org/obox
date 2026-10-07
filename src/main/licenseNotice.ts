/**
 * 第三方许可汇总（不依赖 electron，可单测；见 issue #51 / ADR-0018）。
 *
 * 义务来源（访谈时核实过）：
 * - **PSF License v2 第 2 条**：分发 Python 或其衍生版本时必须保留 PSF 许可证与版权声明；
 * - **第 3 条**：分发含 Python 的衍生版本要附"对 Python 的修改摘要"——我们裁剪过运行时，因此需要；
 * - 各第三方库自带义务（FreeType 的文档署名、ColorBrewer 的 Apache NOTICE、STIX 的 OFL 等）——
 *   好在这类文本都随 wheel 落在 `*.dist-info/licenses/**` 或库目录里，可以直接收集。
 *
 * 本模块只做"挑哪些文件 + 拼成一份可分发文本 + 算指纹（防漂移）"；读写盘由 CLI 负责。
 */
import { createHash } from 'node:crypto'

/** 我们对运行时的修改摘要（PSF 第 3 条要求；与打包脚本共用同一份描述，避免两处口径漂移） */
export const RUNTIME_MODIFICATIONS: readonly string[] = [
  '使用 python-build-standalone 的 install_only_stripped 归档（已去除调试符号 .pdb）',
  '删除 include/ 与 libs/（编译 C 扩展所需，运行期不需要）',
  '删除 Lib/idlelib/ 与 Lib/turtledemo/（开发工具与示例，运行期不需要）',
  '未修改任何 Python 源码；保留 tkinter/Tcl、pip、venv、ensurepip 与全部标准库模块'
]

const LICENSE_BASENAMES = [
  'license',
  'license.txt',
  'license.md',
  'license.rst',
  'licence',
  'licence.txt',
  'copying',
  'copying.txt',
  'copyright',
  'notice',
  'notice.txt',
  'license.terms',
  'license-mit',
  'license-apache',
  'license.bsd'
]

/** 判断某个相对路径是否为"许可/声明"文件（含 `*.dist-info/licenses/**` 下的任意文件） */
export function isLicenseFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const segments = normalized.split('/')
  const base = segments[segments.length - 1] ?? ''
  if (segments.some((segment) => segment.endsWith('.dist-info') && segments.includes('licenses'))) {
    // <pkg>.dist-info/licenses/... 下的所有文件都是许可文本
    const licensesIndex = segments.indexOf('licenses')
    const distInfoIndex = segments.findIndex((segment) => segment.endsWith('.dist-info'))
    if (licensesIndex > distInfoIndex) return true
  }
  if (base === 'license.terms') return true
  return (
    LICENSE_BASENAMES.includes(base) || base.startsWith('license-') || base.startsWith('licence-')
  )
}

/** 从目录清单里挑出所有许可文件（保持传入顺序，便于稳定输出） */
export function collectLicenseFiles(paths: readonly string[]): string[] {
  return paths.filter((path) => isLicenseFile(path))
}

export interface NoticeFile {
  path: string
  content: string
}

export interface NoticesInput {
  /** 包名/扩展名（写进标题） */
  subject: string
  /** CPython 版本（含补丁号） */
  pythonVersion: string
  arch: string
  files: readonly NoticeFile[]
  /** 覆盖修改摘要（默认用 {@link RUNTIME_MODIFICATIONS}） */
  modifications?: readonly string[]
}

/** 拼出可直接分发的 `THIRD-PARTY-NOTICES.txt` 内容 */
export function buildNotices(input: NoticesInput): string {
  const modifications = input.modifications ?? RUNTIME_MODIFICATIONS
  const lines: string[] = [
    `${input.subject} 第三方许可与声明`,
    '='.repeat(40),
    '',
    `本扩展包内含 Python 运行时（CPython ${input.pythonVersion}，${input.arch}）及其第三方依赖。`,
    '以下汇总随包分发的许可证与版权声明，自动生成、请勿手工编辑。',
    '',
    '== 对 Python 的修改摘要（PSF License v2 第 3 条） ==',
    '',
    ...modifications.map((item) => `- ${item}`),
    '',
    '== 许可证与版权声明 ==',
    ''
  ]
  for (const file of [...input.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )) {
    lines.push(`--- ${file.path} ---`, '', file.content.trimEnd(), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * 汇总内容的指纹：只对"来源文件路径 + 内容"取哈希。
 * CLI 的 `--check` 模式据此判断已生成的声明是否与包内实际内容一致（防漂移）。
 */
export function noticesDigest(files: readonly NoticeFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\0${file.content}\n`)
  }
  return hash.digest('hex')
}

/** 机器可读的汇总元数据（写进 `license-notices.json`，供 CLI `--check` 比对） */
export interface NoticesMeta {
  subject: string
  pythonVersion: string
  arch: string
  licenseFileCount: number
  digest: string
}

export function noticesMeta(input: NoticesInput): NoticesMeta {
  return {
    subject: input.subject,
    pythonVersion: input.pythonVersion,
    arch: input.arch,
    licenseFileCount: input.files.length,
    digest: noticesDigest(input.files)
  }
}
