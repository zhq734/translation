import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

/** Electron safeStorage 所需的最小依赖接口，便于单元测试注入假实现。 */
export interface SafeStorageAdapter {
  /** 判断当前系统是否可以安全加密。 */
  isEncryptionAvailable(): boolean
  /** 加密明文 Secret。 */
  encryptString(value: string): Buffer
  /** 解密密文。 */
  decryptString(value: Buffer): string
}

/** 钉钉凭证文件的最小磁盘依赖接口。 */
export interface CredentialFileAdapter {
  /** 判断文件是否存在。 */
  exists(path: string): boolean
  /** 读取文件内容。 */
  read(path: string): string
  /** 确保目录存在。 */
  mkdir(path: string): void
  /** 写入文件内容。 */
  write(path: string, content: string): void
  /** 原子替换文件。 */
  rename(from: string, to: string): void
  /** 删除文件。 */
  unlink(path: string): void
}

/** 钉钉凭证读取结果，只在主进程内部携带 Secret。 */
export interface DingTalkSecretReadResult {
  /** 是否存在可用的 Secret。 */
  configured: boolean
  /** 解密后的 Secret；公开快照不会包含该字段。 */
  secret: string | null
  /** 脱敏错误提示。 */
  error?: string
}

interface CredentialFile {
  version: 1
  dingTalkClientSecret: string
}

const defaultFileAdapter: CredentialFileAdapter = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
  rename: renameSync,
  unlink: unlinkSync
}

/**
 * 负责使用 Electron safeStorage 安全保存钉钉 ClientSecret。
 * @param path 凭证文件路径。
 * @param safeStorage 可注入的安全存储实现。
 * @param files 可注入的文件操作实现。
 * @returns 钉钉凭证存储实例。
 * @author zhenghq
 */
export class DingTalkCredentialStore {
  private readonly temporaryPath: string

  constructor(
    private readonly path: string,
    private readonly safeStorage: SafeStorageAdapter,
    private readonly files: CredentialFileAdapter = defaultFileAdapter
  ) {
    this.temporaryPath = `${path}.tmp`
  }

  /**
   * 读取并解密 ClientSecret，读取异常只返回脱敏错误。
   * @returns 凭证配置状态和主进程内部 Secret。
   * @author zhenghq
   */
  readSecret(): DingTalkSecretReadResult {
    if (!this.files.exists(this.path)) return { configured: false, secret: null }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { configured: false, secret: null, error: '当前系统无法使用安全存储，无法读取钉钉凭证' }
    }
    try {
      const raw = JSON.parse(this.files.read(this.path)) as Partial<CredentialFile>
      if (raw.version !== 1 || typeof raw.dingTalkClientSecret !== 'string' || !raw.dingTalkClientSecret) {
        throw new Error('invalid credential file')
      }
      const ciphertext = Buffer.from(raw.dingTalkClientSecret, 'base64')
      const secret = this.safeStorage.decryptString(ciphertext)
      if (!secret) throw new Error('empty secret')
      return { configured: true, secret }
    } catch {
      return { configured: false, secret: null, error: '无法读取已保存的钉钉凭证，请重新配置' }
    }
  }

  /**
   * 加密并原子写入新的 ClientSecret；空值不会覆盖旧凭证。
   * @param secret 待保存的 ClientSecret。
   * @returns 无返回值。
   * @author zhenghq
   */
  saveSecret(secret: string): void {
    const normalized = secret.trim()
    if (!normalized) return
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统安全存储不可用，无法保存钉钉凭证')
    }
    const ciphertext = this.safeStorage.encryptString(normalized).toString('base64')
    const payload: CredentialFile = { version: 1, dingTalkClientSecret: ciphertext }
    this.files.mkdir(dirname(this.path))
    this.files.write(this.temporaryPath, JSON.stringify(payload))
    this.files.rename(this.temporaryPath, this.path)
  }

  /**
   * 显式删除持久化的 ClientSecret。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearSecret(): void {
    if (this.files.exists(this.path)) this.files.unlink(this.path)
    if (this.files.exists(this.temporaryPath)) this.files.unlink(this.temporaryPath)
  }
}
