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
import { translateMain } from './messages'

/** Gemini Live API Key 读取结果，只在主进程内部携带明文密钥。 */
export interface GeminiLiveApiKeyReadResult {
  /** 是否存在可用的 API Key。 */
  configured: boolean
  /** 解密后的 API Key；公开设置不会包含该字段。 */
  apiKey: string | null
  /** 脱敏错误提示。 */
  error?: string
}

interface GeminiLiveCredentialFile {
  /** 凭证文件格式版本。 */
  version: 1
  /** safeStorage 加密后的 Gemini API Key。 */
  geminiApiKey: string
}

/**
 * 使用 Electron safeStorage 安全保存 Gemini Live API Key。
 * @author zhenghq
 */
export class GeminiLiveCredentialStore {
  private readonly temporaryPath: string

  /**
   * 创建 Gemini Live 凭证存储。
   * @param path 凭证文件路径。
   * @param safeStorage 可注入的安全存储实现。
   * @author zhenghq
   */
  constructor(
    private readonly path: string,
    private readonly safeStorage: SafeStorageAdapter
  ) {
    this.temporaryPath = `${path}.tmp`
  }

  /**
   * 读取并解密 Gemini API Key，异常只返回脱敏错误。
   * @returns 凭证配置状态和主进程内部 API Key。
   * @author zhenghq
   */
  readApiKey(): GeminiLiveApiKeyReadResult {
    if (!existsSync(this.path)) return { configured: false, apiKey: null }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return {
        configured: false,
        apiKey: null,
        error: translateMain('settings.realtimeSubtitle.credentials.secureStorageUnavailableRead')
      }
    }
    try {
      const raw = JSON.parse(
        readFileSync(this.path, 'utf8')
      ) as Partial<GeminiLiveCredentialFile>
      if (raw.version !== 1 || typeof raw.geminiApiKey !== 'string' || !raw.geminiApiKey) {
        throw new Error('invalid gemini live credential file')
      }
      const apiKey = this.safeStorage.decryptString(Buffer.from(raw.geminiApiKey, 'base64'))
      if (!apiKey) throw new Error('empty gemini live api key')
      return { configured: true, apiKey }
    } catch {
      return {
        configured: false,
        apiKey: null,
        error: translateMain('settings.realtimeSubtitle.credentials.readFailed')
      }
    }
  }

  /**
   * 加密并原子写入新的 Gemini API Key；空值不会覆盖旧凭证。
   * @param apiKey 待保存的 API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  saveApiKey(apiKey: string): void {
    const normalized = apiKey.trim()
    if (!normalized) return
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error(
        translateMain('settings.realtimeSubtitle.credentials.secureStorageUnavailableSave')
      )
    }
    const ciphertext = this.safeStorage.encryptString(normalized).toString('base64')
    const payload: GeminiLiveCredentialFile = {
      version: 1,
      geminiApiKey: ciphertext
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.temporaryPath, JSON.stringify(payload), { mode: 0o600 })
    renameSync(this.temporaryPath, this.path)
  }

  /**
   * 显式删除持久化的 Gemini API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearApiKey(): void {
    if (existsSync(this.path)) unlinkSync(this.path)
    if (existsSync(this.temporaryPath)) unlinkSync(this.temporaryPath)
  }
}
