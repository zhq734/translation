import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

/** Electron safeStorage 所需的最小依赖接口，便于微软凭证测试注入假实现。 */
export interface MicrosoftSafeStorageAdapter {
  /**
   * 判断当前系统是否可以安全加密。
   * @returns 安全加密能力是否可用。
   * @author zhenghq
   */
  isEncryptionAvailable(): boolean
  /**
   * 加密明文订阅密钥。
   * @param value 待加密的明文订阅密钥。
   * @returns 系统安全存储生成的密文。
   * @author zhenghq
   */
  encryptString(value: string): Buffer
  /**
   * 解密订阅密钥密文。
   * @param value 待解密的密文。
   * @returns 解密后的订阅密钥。
   * @author zhenghq
   */
  decryptString(value: Buffer): string
}

/** 微软凭证文件的最小磁盘依赖接口。 */
export interface MicrosoftCredentialFileAdapter {
  /**
   * 判断文件是否存在。
   * @param path 待检查的文件路径。
   * @returns 文件是否存在。
   * @author zhenghq
   */
  exists(path: string): boolean
  /**
   * 读取文件内容。
   * @param path 待读取的文件路径。
   * @returns 文件文本内容。
   * @author zhenghq
   */
  read(path: string): string
  /**
   * 确保目录存在。
   * @param path 待创建的目录路径。
   * @returns 无返回值。
   * @author zhenghq
   */
  mkdir(path: string): void
  /**
   * 写入文件内容。
   * @param path 待写入的文件路径。
   * @param content 待写入的文本内容。
   * @returns 无返回值。
   * @author zhenghq
   */
  write(path: string, content: string): void
  /**
   * 原子替换文件。
   * @param from 临时文件路径。
   * @param to 目标文件路径。
   * @returns 无返回值。
   * @author zhenghq
   */
  rename(from: string, to: string): void
  /**
   * 删除文件。
   * @param path 待删除的文件路径。
   * @returns 无返回值。
   * @author zhenghq
   */
  unlink(path: string): void
}

/** 微软订阅密钥读取结果，只在主进程内部携带密钥。 */
export interface MicrosoftKeyReadResult {
  /** 是否存在可用的订阅密钥。 */
  configured: boolean
  /** 解密后的订阅密钥；公开快照不会包含该字段。 */
  subscriptionKey: string | null
  /** 脱敏错误提示。 */
  error?: string
}

interface CredentialFile {
  version: 1
  microsoftSubscriptionKey: string
}

const defaultFileAdapter: MicrosoftCredentialFileAdapter = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
  rename: renameSync,
  unlink: unlinkSync
}

/**
 * 负责使用 Electron safeStorage 安全保存微软 Translator 订阅密钥。
 * @param path 凭证文件路径。
 * @param safeStorage 可注入的安全存储实现。
 * @param files 可注入的文件操作实现。
 * @returns 微软凭证存储实例。
 * @author zhenghq
 */
export class MicrosoftCredentialStore {
  private readonly temporaryPath: string

  constructor(
    private readonly path: string,
    private readonly safeStorage: MicrosoftSafeStorageAdapter,
    private readonly files: MicrosoftCredentialFileAdapter = defaultFileAdapter
  ) {
    this.temporaryPath = `${path}.tmp`
  }

  /**
   * 读取并解密订阅密钥，读取异常只返回脱敏错误。
   * @returns 凭证配置状态和主进程内部订阅密钥。
   * @author zhenghq
   */
  readKey(): MicrosoftKeyReadResult {
    if (!this.files.exists(this.path)) return { configured: false, subscriptionKey: null }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { configured: false, subscriptionKey: null, error: '当前系统无法使用安全存储，无法读取微软翻译凭证' }
    }
    try {
      const raw = JSON.parse(this.files.read(this.path)) as Partial<CredentialFile>
      if (raw.version !== 1 ||
          typeof raw.microsoftSubscriptionKey !== 'string' ||
          !raw.microsoftSubscriptionKey) {
        throw new Error('invalid credential file')
      }
      const subscriptionKey = this.safeStorage.decryptString(
        Buffer.from(raw.microsoftSubscriptionKey, 'base64')
      )
      if (!subscriptionKey) throw new Error('empty subscription key')
      return { configured: true, subscriptionKey }
    } catch {
      return { configured: false, subscriptionKey: null, error: '无法读取已保存的微软翻译凭证，请重新配置' }
    }
  }

  /**
   * 加密并原子写入新的订阅密钥；空值不会覆盖旧凭证。
   * @param subscriptionKey 待保存的微软 Translator 订阅密钥。
   * @returns 无返回值。
   * @author zhenghq
   */
  saveKey(subscriptionKey: string): void {
    const normalized = subscriptionKey.trim()
    if (!normalized) return
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统安全存储不可用，无法保存微软翻译凭证')
    }
    const ciphertext = this.safeStorage.encryptString(normalized).toString('base64')
    const payload: CredentialFile = { version: 1, microsoftSubscriptionKey: ciphertext }
    this.files.mkdir(dirname(this.path))
    this.files.write(this.temporaryPath, JSON.stringify(payload))
    this.files.rename(this.temporaryPath, this.path)
  }

  /**
   * 显式删除持久化的订阅密钥。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearKey(): void {
    if (this.files.exists(this.path)) this.files.unlink(this.path)
    if (this.files.exists(this.temporaryPath)) this.files.unlink(this.temporaryPath)
  }
}
