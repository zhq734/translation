import type { AiConfigPatch, Settings } from '../shared/types'
import type { AiApiKeyReadResult } from './aiCredentials'

/** AI 配置服务使用的凭证存储最小接口。 */
export interface AiCredentialStoreAdapter {
  /** 读取已保存的 API Key。 */
  readApiKey(): AiApiKeyReadResult
  /** 安全保存新的 API Key。 */
  saveApiKey(apiKey: string): void
  /** 显式清除 API Key。 */
  clearApiKey(): void
}

/** AI 配置服务依赖。 */
export interface AiConfigurationDependencies {
  /** 获取当前公开设置。 */
  getSettings(): Settings
  /** 持久化公开设置补丁。 */
  saveSettings(patch: Partial<Settings>): Settings
  /** 安全凭证存储。 */
  credentialStore: AiCredentialStoreAdapter
  /** 配置成功后广播公开设置。 */
  onSettingsChanged?(settings: Settings): void
  /** AI 相关配置变化后清理翻译运行时。 */
  resetTranslationRuntime?(): void
}

/**
 * 管理 AI 公开设置和 API Key 凭证，保证失败时不发布半成品运行时状态。
 * @param dependencies 设置、凭证、广播和运行时重置依赖。
 * @returns AI 配置服务实例。
 * @author zhenghq
 */
export class AiConfigurationService {
  private apiKey: string | null = null

  constructor(private readonly dependencies: AiConfigurationDependencies) {}

  /**
   * 加载安全凭证并同步公开的已配置标记。
   * @returns 同步后的公开设置。
   * @author zhenghq
   */
  initialize(): Settings {
    const loaded = this.dependencies.credentialStore.readApiKey()
    this.apiKey = loaded.apiKey
    const settings = this.dependencies.getSettings()
    if (settings.aiApiKeyConfigured === loaded.configured) return settings
    return this.dependencies.saveSettings({ aiApiKeyConfigured: loaded.configured })
  }

  /**
   * 应用 AI 配置补丁；空 API Key 保留旧值，失败时回滚已写入的凭证。
   * @param patch AI 启用状态、协议、Base URL、模型和可选新 API Key。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  applyPatch(patch: AiConfigPatch): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousApiKey = this.apiKey
    const submittedKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : ''
    const nextApiKey = submittedKey || previousApiKey
    const keyChanged = Boolean(submittedKey) && submittedKey !== previousApiKey
    const nextPatch: Partial<Settings> = {
      aiEnabled: typeof patch.enabled === 'boolean' ? patch.enabled : previousSettings.aiEnabled,
      aiProtocol: patch.protocol === undefined ? previousSettings.aiProtocol : patch.protocol,
      aiBaseUrl: patch.baseUrl === undefined ? previousSettings.aiBaseUrl : patch.baseUrl,
      aiModel: patch.model === undefined ? previousSettings.aiModel : patch.model,
      aiApiKeyConfigured: nextApiKey != null
    }
    const configurationChanged =
      keyChanged ||
      nextPatch.aiEnabled !== previousSettings.aiEnabled ||
      nextPatch.aiProtocol !== previousSettings.aiProtocol ||
      nextPatch.aiBaseUrl !== previousSettings.aiBaseUrl ||
      nextPatch.aiModel !== previousSettings.aiModel

    if (keyChanged) this.dependencies.credentialStore.saveApiKey(submittedKey)
    let settings: Settings
    try {
      settings = this.dependencies.saveSettings(nextPatch)
    } catch (error) {
      if (keyChanged) this.restoreApiKey(previousApiKey)
      throw error
    }

    this.apiKey = nextApiKey
    if (configurationChanged) this.dependencies.resetTranslationRuntime?.()
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }

  /**
   * 显式清除 API Key，并在公开设置保存失败时恢复旧凭证。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearApiKey(): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousApiKey = this.apiKey
    this.dependencies.credentialStore.clearApiKey()

    let settings: Settings
    try {
      settings = this.dependencies.saveSettings({ aiApiKeyConfigured: false })
    } catch (error) {
      this.restoreApiKey(previousApiKey)
      throw error
    }

    this.apiKey = null
    if (previousApiKey != null || previousSettings.aiApiKeyConfigured) {
      this.dependencies.resetTranslationRuntime?.()
    }
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }

  /**
   * 获取当前主进程使用的 API Key 快照。
   * @returns 解密后的 API Key 或 null。
   * @author zhenghq
   */
  getApiKey(): string | null {
    return this.apiKey
  }

  /**
   * 在保存失败后恢复旧凭证。
   * @param previousApiKey 之前的 API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  private restoreApiKey(previousApiKey: string | null): void {
    this.apiKey = previousApiKey
    if (previousApiKey) {
      this.dependencies.credentialStore.saveApiKey(previousApiKey)
    } else {
      this.dependencies.credentialStore.clearApiKey()
    }
  }
}
