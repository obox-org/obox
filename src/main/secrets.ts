/**
 * 扩展密钥存储（api.secrets）：safeStorage 加密存 userData。
 * 安全模型：值经 Electron safeStorage（Windows DPAPI / macOS Keychain）加密后
 * 存 userData/secrets.json（key = <扩展id>:<键>）；解密仅主进程可做。
 */
import { app, ipcMain, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface SecretsFile {
  [key: string]: string // 加密后的 base64
}

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

function load(): SecretsFile {
  try {
    return JSON.parse(readFileSync(secretsPath(), 'utf8')) as SecretsFile
  } catch {
    return {}
  }
}

function save(data: SecretsFile): void {
  writeFileSync(secretsPath(), JSON.stringify(data, null, 2), 'utf8')
}

function keyOf(extId: string, key: string): string {
  return `${extId}:${key}`
}

function encrypt(value: string): string {
  return safeStorage.encryptString(value).toString('base64')
}

function decrypt(enc: string): string {
  return safeStorage.decryptString(Buffer.from(enc, 'base64'))
}

export function registerSecretsIpc(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[secrets] 系统加密不可用（safeStorage），secrets 存储将不可用')
  }
  ipcMain.handle(
    'secrets:get',
    (_e, extId: string, key: string): { ok: boolean; value?: string; error?: string } => {
      try {
        if (!safeStorage.isEncryptionAvailable()) {
          return { ok: false, error: '系统加密不可用（safeStorage）' }
        }
        const enc = load()[keyOf(extId, key)]
        if (enc === undefined) return { ok: true, value: undefined }
        return { ok: true, value: decrypt(enc) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'secrets:set',
    (_e, extId: string, key: string, value: string): { ok: boolean; error?: string } => {
      try {
        if (!safeStorage.isEncryptionAvailable()) {
          return { ok: false, error: '系统加密不可用（safeStorage）' }
        }
        const data = load()
        if (value === undefined || value === null) {
          delete data[keyOf(extId, key)]
        } else {
          data[keyOf(extId, key)] = encrypt(String(value))
        }
        save(data)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'secrets:delete',
    (_e, extId: string, key: string): { ok: boolean; error?: string } => {
      try {
        const data = load()
        delete data[keyOf(extId, key)]
        save(data)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
