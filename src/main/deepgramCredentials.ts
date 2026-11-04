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

/** Deepgram 凭证读取结果，只在主进程内部携带 API Key。 */
export interface DeepgramApiKeyReadResult {
  /** 是否存在可用的 API Key。 */
  configured: boolean
  /** 解密后的 API Key；公开设置不会包含该字段。 */
  apiKey: string | null
  /** 脱敏错误提示。 */
  error?: string
}

interface DeepgramCredentialFile {
  /** 凭证文件格式版本。 */
  version: 1
  /** safeStorage 加密后的 Deepgram API Key。 */
  deepgramApiKey: string
}

/**
 * 使用 Electron safeStorage 安全保存 Deepgram API Key。
 * @param path 凭证文件路径。
 * @param safeStorage 可注入的安全存储实现。
 * @author zhenghq
 */
export class DeepgramCredentialStore {
  private readonly temporaryPath: string

  /**
   * 创建 Deepgram 凭证存储。
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
   * 读取并解密 Deepgram API Key，异常只返回脱敏错误。
   * @returns 凭证配置状态和主进程内部 API Key。
   * @author zhenghq
   */
  readApiKey(): DeepgramApiKeyReadResult {
    if (!existsSync(this.path)) return { configured: false, apiKey: null }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return {
        configured: false,
        apiKey: null,
        error: translateMain('settings.realtimeSubtitle.credentials.secureStorageUnavailableRead')
      }
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<DeepgramCredentialFile>
      if (raw.version !== 1 || typeof raw.deepgramApiKey !== 'string' || !raw.deepgramApiKey) {
        throw new Error('invalid deepgram credential file')
      }
      const apiKey = this.safeStorage.decryptString(Buffer.from(raw.deepgramApiKey, 'base64'))
      if (!apiKey) throw new Error('empty deepgram api key')
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
   * 加密并原子写入新的 Deepgram API Key；空值不会覆盖旧凭证。
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
    const payload: DeepgramCredentialFile = { version: 1, deepgramApiKey: ciphertext }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.temporaryPath, JSON.stringify(payload), { mode: 0o600 })
    renameSync(this.temporaryPath, this.path)
  }

  /**
   * 显式删除持久化的 Deepgram API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearApiKey(): void {
    if (existsSync(this.path)) unlinkSync(this.path)
    if (existsSync(this.temporaryPath)) unlinkSync(this.temporaryPath)
  }
}
