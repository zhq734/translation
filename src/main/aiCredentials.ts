import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import type { SafeStorageAdapter } from './dingtalkCredentials'

/** AI 凭证文件读取结果，只在主进程内部携带 API Key。 */
export interface AiApiKeyReadResult {
  /** 是否存在可用的 API Key。 */
  configured: boolean
  /** 解密后的 API Key；公开快照不会包含该字段。 */
  apiKey: string | null
  /** 脱敏错误提示。 */
  error?: string
}

interface AiCredentialFile {
  version: 1
  aiApiKey: string
}

/**
 * 负责使用 Electron safeStorage 安全保存 AI API Key。
 * @param path 凭证文件路径。
 * @param safeStorage 可注入的安全存储实现。
 * @author zhenghq
 */
export class AiCredentialStore {
  private readonly temporaryPath: string

  constructor(
    private readonly path: string,
    private readonly safeStorage: SafeStorageAdapter
  ) {
    this.temporaryPath = `${path}.tmp`
  }

  /**
   * 读取并解密 AI API Key，读取异常只返回脱敏错误。
   * @returns 凭证配置状态和主进程内部 API Key。
   * @author zhenghq
   */
  readApiKey(): AiApiKeyReadResult {
    if (!existsSync(this.path)) return { configured: false, apiKey: null }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { configured: false, apiKey: null, error: '当前系统无法使用安全存储，无法读取 AI 凭证' }
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AiCredentialFile>
      if (raw.version !== 1 || typeof raw.aiApiKey !== 'string' || !raw.aiApiKey) {
        throw new Error('invalid ai credential file')
      }
      const ciphertext = Buffer.from(raw.aiApiKey, 'base64')
      const apiKey = this.safeStorage.decryptString(ciphertext)
      if (!apiKey) throw new Error('empty api key')
      return { configured: true, apiKey }
    } catch {
      return { configured: false, apiKey: null, error: '无法读取已保存的 AI 凭证，请重新配置' }
    }
  }

  /**
   * 加密并原子写入新的 AI API Key；空值不会覆盖旧凭证。
   * @param apiKey 待保存的 API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  saveApiKey(apiKey: string): void {
    const normalized = apiKey.trim()
    if (!normalized) return
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统安全存储不可用，无法保存 AI 凭证')
    }
    const ciphertext = this.safeStorage.encryptString(normalized).toString('base64')
    const payload: AiCredentialFile = { version: 1, aiApiKey: ciphertext }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.temporaryPath, JSON.stringify(payload), { mode: 0o600 })
    renameSync(this.temporaryPath, this.path)
  }

  /**
   * 显式删除持久化的 AI API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearApiKey(): void {
    if (existsSync(this.path)) unlinkSync(this.path)
    if (existsSync(this.temporaryPath)) unlinkSync(this.temporaryPath)
  }
}
