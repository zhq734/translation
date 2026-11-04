import type { ITranslateConfigPatch, Settings } from '../shared/types'
import type { ITranslateApiKeyReadResult } from './itranslateCredentials'

/** iTranslate 配置服务使用的凭证存储最小接口。 */
export interface ITranslateCredentialStoreAdapter {
  /** 读取已保存的 API Key。 */
  readApiKey(): ITranslateApiKeyReadResult
  /** 安全保存新的 API Key。 */
  saveApiKey(apiKey: string): void
  /** 显式清除 API Key。 */
  clearApiKey(): void
}

/** iTranslate 配置服务依赖。 */
export interface ITranslateConfigurationDependencies {
  /** 获取当前公开设置。 */
  getSettings(): Settings
  /** 持久化公开设置补丁。 */
  saveSettings(patch: Partial<Settings>): Settings
  /** 安全凭证存储。 */
  credentialStore: ITranslateCredentialStoreAdapter
  /** 配置成功后广播公开设置。 */
  onSettingsChanged?(settings: Settings): void
  /** 翻译配置变化后重置多通道翻译运行时。 */
  resetTranslationRuntime?(): void
}

/**
 * 管理 iTranslate 可选翻译通道的公开设置和 API Key 凭证。
 * @param dependencies 设置、凭证、广播和运行时重置依赖。
 * @returns iTranslate 配置服务实例。
 * @author zhenghq
 */
export class ITranslateConfigurationService {
  private apiKey: string | null = null

  /**
   * 创建 iTranslate 配置服务。
   * @param dependencies 设置、凭证、广播和运行时重置依赖。
   * @author zhenghq
   */
  constructor(private readonly dependencies: ITranslateConfigurationDependencies) {}

  /**
   * 加载安全凭证并同步公开的已配置标记。
   * @returns 同步后的公开设置。
   * @author zhenghq
   */
  initialize(): Settings {
    const loaded = this.dependencies.credentialStore.readApiKey()
    this.apiKey = loaded.apiKey
    const settings = this.dependencies.getSettings()
    if (settings.itranslateApiKeyConfigured === loaded.configured) return settings
    return this.dependencies.saveSettings({ itranslateApiKeyConfigured: loaded.configured })
  }

  /**
   * 应用 iTranslate 配置补丁；空 API Key 保留旧值，设置保存失败时回滚凭证。
   * @param patch iTranslate 启用状态和可选新 API Key。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  configure(patch: ITranslateConfigPatch): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousApiKey = this.apiKey
    const submittedKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : ''
    const nextApiKey = submittedKey || previousApiKey
    const keyChanged = Boolean(submittedKey) && submittedKey !== previousApiKey
    const nextPatch: Partial<Settings> = {
      itranslateEnabled: typeof patch.enabled === 'boolean'
        ? patch.enabled
        : previousSettings.itranslateEnabled,
      itranslateApiKeyConfigured: nextApiKey != null
    }
    const configurationChanged = keyChanged ||
      nextPatch.itranslateEnabled !== previousSettings.itranslateEnabled ||
      nextPatch.itranslateApiKeyConfigured !== previousSettings.itranslateApiKeyConfigured

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
   * 显式清除 iTranslate API Key，并保持当前启用开关不变。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearApiKey(): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousApiKey = this.apiKey
    this.dependencies.credentialStore.clearApiKey()

    let settings: Settings
    try {
      settings = this.dependencies.saveSettings({ itranslateApiKeyConfigured: false })
    } catch (error) {
      this.restoreApiKey(previousApiKey)
      throw error
    }

    this.apiKey = null
    if (previousApiKey != null || previousSettings.itranslateApiKeyConfigured) {
      this.dependencies.resetTranslationRuntime?.()
    }
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }

  /**
   * 获取当前主进程使用的 iTranslate API Key 快照。
   * @returns 解密后的 API Key 或 null。
   * @author zhenghq
   */
  getApiKey(): string | null {
    return this.apiKey
  }

  /**
   * 在设置保存失败后恢复旧凭证。
   * @param previousApiKey 之前的 API Key。
   * @returns 无返回值。
   * @author zhenghq
   */
  private restoreApiKey(previousApiKey: string | null): void {
    this.apiKey = previousApiKey
    try {
      if (previousApiKey) this.dependencies.credentialStore.saveApiKey(previousApiKey)
      else this.dependencies.credentialStore.clearApiKey()
    } catch {
      // 回滚失败不能暴露 API Key；内存状态仍恢复到上一份配置。
    }
  }
}
