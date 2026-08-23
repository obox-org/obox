/**
 * .oix 扩展包安装能力。
 * - .oix 本质是 zip：根目录含 manifest.json + 入口 + 静态资源（扁平布局）
 * - 安装：校验 manifest（name/version/main）→ 防路径穿越解压到 userData/extensions/<name>_<author>/
 * - 目录名 = <name>_<清洗后 author>（author 清洗后为空则退化为纯 name）
 * - 同名存在 → 覆盖安装（升级语义）
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import AdmZip from 'adm-zip'
import type { InstallOixResult } from '../shared/types'
import { getUserExtensionsDir } from './capabilities'

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i
const SAFE_DIR_RE = /^[a-z0-9._-]+$/i
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

/** 从 manifest 派生安装目录名：<name>_<清洗后 author> */
export function deriveDirName(name: string, author?: string): string {
  const safeAuthor = (author ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '')
  return safeAuthor ? `${name}_${safeAuthor}` : name
}

function readRootManifest(zip: AdmZip): Record<string, unknown> | null {
  const entry = zip.getEntries().find((e) => e.entryName === 'manifest.json')
  if (!entry) return null
  const buf = zip.readFile(entry)
  if (!buf) return null
  try {
    const parsed = JSON.parse(buf.toString('utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 校验 zip 条目路径并解析为目标目录下的安全绝对路径。
 * 拒绝：空路径、绝对路径（/ 开头或盘符）、反斜杠、.. 段、目标目录外的路径。
 */
function resolveEntry(
  target: string,
  entryName: string
): { filePath: string; isDir: boolean } | null {
  if (!entryName || entryName.includes('\\')) return null
  if (entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) return null
  const isDir = entryName.endsWith('/')
  const clean = entryName.replace(/\/+$/, '')
  const parts = clean.split('/')
  if (parts.some((p) => p === '..' || p === '')) return null
  const filePath = resolve(target, ...parts)
  if (filePath !== target && !filePath.startsWith(target + sep)) return null
  return { filePath, isDir }
}

/** 从 .oix 文件安装扩展，返回安装结果；失败抛错（消息可直接展示给用户） */
export async function installOixFromPath(filePath: string): Promise<InstallOixResult> {
  let zip: AdmZip
  try {
    zip = new AdmZip(filePath)
  } catch {
    throw new Error('无法解析该文件：不是有效的 .oix（zip）包')
  }

  const manifest = readRootManifest(zip)
  if (!manifest) throw new Error('oix 包内缺少根 manifest.json')
  const { name, version, main } = manifest
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('manifest.name 非法（只能含字母/数字/./_/-）')
  }
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new Error('manifest.version 非法（需 semver，如 1.0.0）')
  }
  if (typeof main !== 'string' || !main.trim()) {
    throw new Error('manifest.main（入口文件）必填')
  }
  const mainClean = main.replace(/^\.\//, '')
  if (!zip.getEntries().some((e) => e.entryName === mainClean)) {
    throw new Error(`入口文件 ${main} 不在 oix 包内`)
  }
  const author = typeof manifest.author === 'string' ? manifest.author : undefined
  const displayName = typeof manifest.displayName === 'string' ? manifest.displayName : undefined

  const id = deriveDirName(name, author)
  if (!SAFE_DIR_RE.test(id)) throw new Error(`派生的安装目录名非法: ${id}`)

  // SAFE_DIR_RE 已保证 id 无路径分隔符，target 必在 userData/extensions 之下
  const root = getUserExtensionsDir()
  const target = resolve(root, id)

  // 覆盖安装：同名已存在则先删除旧目录
  let replaced = false
  try {
    await fs.access(target)
    replaced = true
  } catch {
    replaced = false
  }
  if (replaced) await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true })

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const r = resolveEntry(target, entry.entryName)
    if (!r) throw new Error(`oix 包内含非法条目路径: ${entry.entryName}`)
    const data = zip.readFile(entry)
    if (!data) continue
    await fs.mkdir(dirname(r.filePath), { recursive: true })
    await fs.writeFile(r.filePath, data)
  }

  // 安装时间戳（扩展管理器 Last Updated 展示；经 app://extensions/<id>/.obox-meta.json 读取）
  await fs.writeFile(
    join(target, '.obox-meta.json'),
    JSON.stringify({ installedTimestamp: Date.now() }),
    'utf8'
  )

  return { id, name, displayName, version, author, replaced }
}

export function registerOixIpc(): void {
  // 对话框选 .oix 并安装；取消返回 null
  ipcMain.handle('extensions:install-oix-dialog', async (e): Promise<InstallOixResult | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      title: '安装扩展',
      filters: [{ name: 'Obox 扩展包', extensions: ['oix'] }],
      properties: ['openFile']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return installOixFromPath(result.filePaths[0])
  })

  // 按路径安装（拖拽场景：渲染进程经 webUtils.getPathForFile 取得真实路径）
  ipcMain.handle(
    'extensions:install-oix-path',
    async (_e, filePath: unknown): Promise<InstallOixResult> => {
      if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('无效的安装路径')
      return installOixFromPath(filePath)
    }
  )
}
