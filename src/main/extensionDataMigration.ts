/**
 * 旧目录扩展数据的自动继承（2.0.2）。
 *
 * ## 背景
 *
 * 扩展的数据目录是 `<userData>/extensions/<安装目录名>/data`。安装目录名曾经是
 * `<manifest.name>`（如 `pet`），后来改成 `<name>_<清洗后 author>`（如 `pet_chenzhi`）。
 * 于是从旧版升级上来的用户，程序装进了新目录、**数据还留在旧目录**：
 * 新版读不到存档，表现为"成长值/待办/网页账号全没了"——文件其实一个都没丢。
 *
 * 实测案例：`extensions/pet/data/state.json`（旧）vs `extensions/pet_chenzhi/data/`（新，不存在）。
 *
 * ## 规则（保守：只补、不删、不覆盖）
 *
 * 1. 目标 `<新目录>/data` 已存在且有内容 ⇒ 什么都不做（**绝不覆盖**用户现有数据）；
 * 2. 读新目录的 `manifest.json` 得到 `name`，旧目录候选 = `<userData>/extensions/<name>`；
 * 3. 旧目录 == 新目录 ⇒ 跳过；
 * 4. 旧目录的 `data/` 不存在或为空 ⇒ 跳过；
 * 5. 否则**递归复制**过去（不移动、不删除旧目录）：旧目录没有 manifest 会被扫描跳过，
 *    留着不影响运行，万一迁移有误用户的数据仍在原处。
 *
 * 依赖全部注入，便于单测（node 环境没有 Electron，也不该碰真实 userData）。
 */

import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 迁移结果（日志与测试断言都用它；不抛错，失败只记原因） */
export interface LegacyDataMigrationResult {
  migrated: boolean
  /** 旧数据目录（迁移成功或"目标已存在"时为 null） */
  from?: string
  /** 复制的文件数 */
  files?: number
  /** 未迁移的原因（`target-exists` / `no-manifest` / `same-dir` / `no-legacy` / `error`） */
  reason?: string
}

export interface LegacyDataMigrationIO {
  /** 列目录（不存在时抛 ENOENT，由本模块统一吞掉） */
  readdirPath(path: string): Promise<string[]>
  /** 路径类型（不存在返回 null） */
  statPath(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean } | null>
  mkdirPath(path: string): Promise<void>
  copyFileTo(from: string, to: string): Promise<void>
  /** 读 `<dir>/manifest.json` 的 `name`（读不到 / 非法返回 null） */
  readManifestName(dir: string): Promise<string | null>
}

export const nodeLegacyDataMigrationIO: LegacyDataMigrationIO = {
  async readdirPath(path) {
    return readdir(path)
  },
  async statPath(path) {
    try {
      return await stat(path)
    } catch {
      return null
    }
  },
  async mkdirPath(path) {
    await mkdir(path, { recursive: true })
  },
  async copyFileTo(from, to) {
    await copyFile(from, to)
  },
  async readManifestName(dir) {
    try {
      const raw = await readFile(join(dir, 'manifest.json'), 'utf8')
      const parsed = JSON.parse(raw) as { name?: unknown }
      return typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : null
    } catch {
      return null
    }
  }
}

/** 递归复制一个目录（只复制文件；空目录也会建出来） */
async function copyDir(
  io: LegacyDataMigrationIO,
  from: string,
  to: string,
  counter: { files: number }
): Promise<void> {
  await io.mkdirPath(to)
  const entries = await io.readdirPath(from)
  for (const entry of entries) {
    const src = join(from, entry)
    const dst = join(to, entry)
    const info = await io.statPath(src)
    if (!info) continue
    if (info.isDirectory()) {
      await copyDir(io, src, dst, counter)
    } else if (info.isFile()) {
      await io.copyFileTo(src, dst)
      counter.files += 1
    }
  }
}

/**
 * 若存在"旧安装目录名"的数据目录且新目录还没有数据，则复制过来。
 *
 * @param root 扩展根目录（`<userData>/extensions`）
 * @param id 当前安装目录名（如 `pet_chenzhi`）
 */
export async function migrateLegacyExtensionData(
  root: string,
  id: string,
  io: LegacyDataMigrationIO = nodeLegacyDataMigrationIO
): Promise<LegacyDataMigrationResult> {
  try {
    const installDir = join(root, id)
    const targetData = join(installDir, 'data')

    // 1) 先判"旧目录与新目录同名"：这条与数据无关，且语义最明确
    //    （同名时 target/legacy 是同一个目录，往下走会误判成 target-exists）
    const name = await io.readManifestName(installDir)
    if (!name) return { migrated: false, reason: 'no-manifest' }
    if (name === id) return { migrated: false, reason: 'same-dir' }

    // 2) 目标已有数据 ⇒ 绝不覆盖
    const targetInfo = await io.statPath(targetData)
    if (targetInfo?.isDirectory()) {
      const existing = await io.readdirPath(targetData)
      if (existing.length > 0) return { migrated: false, reason: 'target-exists' }
    }

    const legacyData = join(root, name, 'data')
    const legacyInfo = await io.statPath(legacyData)
    if (!legacyInfo?.isDirectory()) return { migrated: false, reason: 'no-legacy' }
    const legacyEntries = await io.readdirPath(legacyData)
    if (legacyEntries.length === 0) return { migrated: false, reason: 'no-legacy' }

    // 3) 复制（不移动、不删除旧目录）
    const counter = { files: 0 }
    await copyDir(io, legacyData, targetData, counter)
    return { migrated: true, from: legacyData, files: counter.files }
  } catch {
    return {
      migrated: false,
      reason: 'error'
    }
  }
}
