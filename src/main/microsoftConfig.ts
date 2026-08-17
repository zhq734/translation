import type { MicrosoftConfigPatch, Settings } from '../shared/types'
import type { MicrosoftKeyReadResult } from './microsoftCredentials'

/** 主进程调用微软 Translator 所需的完整凭证快照。 */
export interface MicrosoftCredentials {
  subscriptionKey: string
  region: string
}

/** 微软配置服务使用的凭证存储最小接口。 */
export interface MicrosoftCredentialStoreAdapter {
  /**
   * 读取已保存的订阅密钥。
   * @returns 凭证配置状态和主进程内部订阅密钥。
   * @author zhenghq
   */
  readKey(): MicrosoftKeyReadResult
  /**
   * 安全保存新的订阅密钥。
   * @param subscriptionKey 待加密保存的订阅密钥。
   * @returns 无返回值。
   * @author zhenghq
   */
  saveKey(subscriptionKey: string): void
  /**
   * 显式清除订阅密钥。
   * @returns 无返回值。
   * @author zhenghq
   */
  clearKey(): void
}

/** 微软配置服务依赖。 */
export interface MicrosoftConfigurationDependencies {
  /**
   * 获取当前公开设置。
   * @returns 当前脱敏设置快照。
   * @author zhenghq
   */
  getSettings(): Settings
  /**
   * 持久化公开设置补丁。
   * @param patch 待保存的公开设置补丁。
   * @returns 保存后的脱敏设置。
   * @author zhenghq
   */
  saveSettings(patch: Partial<Settings>): Settings
  /** 安全凭证存储。 */
  credentialStore: MicrosoftCredentialStoreAdapter
  /**
   * 配置成功后广播公开设置。
   * @param settings 保存后的脱敏设置。
   * @returns 无返回值。
   * @author zhenghq
   */
  onSettingsChanged?(settings: Settings): void
  /**
   * 微软相关配置变化后清理翻译运行时。
   * @returns 无返回值。
   * @author zhenghq
   */
  resetTranslationRuntime?(): void
}

/**
 * 管理微软公开设置和安全订阅密钥，并保证失败时不发布半成品运行时状态。
 * @param dependencies 设置、凭证、广播和运行时重置依赖。
 * @returns 微软配置服务实例。
 * @author zhenghq
 */
export class MicrosoftConfigurationService {
  private subscriptionKey: string | null = null
  private credentialError: string | undefined

  constructor(private readonly dependencies: MicrosoftConfigurationDependencies) {}

  /**
   * 加载安全订阅密钥并同步公开的已配置标记。
   * @returns 同步后的公开设置。
   * @author zhenghq
   */
  initialize(): Settings {
    const loaded = this.dependencies.credentialStore.readKey()
    this.subscriptionKey = loaded.subscriptionKey
    this.credentialError = loaded.error
    const settings = this.dependencies.getSettings()
    if (settings.microsoftSubscriptionKeyConfigured === loaded.configured) return settings
    return this.dependencies.saveSettings({ microsoftSubscriptionKeyConfigured: loaded.configured })
  }

  /**
   * 应用微软配置补丁；空订阅密钥保留旧值，失败时回滚已写入的凭证。
   * @param patch 微软启用状态、区域和可选新订阅密钥。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  applyPatch(patch: MicrosoftConfigPatch): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousKey = this.subscriptionKey
    const submittedKey = typeof patch.subscriptionKey === 'string'
      ? patch.subscriptionKey.trim()
      : ''
    const nextKey = submittedKey || previousKey
    const keyChanged = Boolean(submittedKey) && submittedKey !== previousKey
    const nextPatch: Partial<Settings> = {
      microsoftEnabled: typeof patch.enabled === 'boolean'
        ? patch.enabled
        : previousSettings.microsoftEnabled,
      microsoftRegion: patch.region === undefined
        ? previousSettings.microsoftRegion
        : patch.region.trim(),
      microsoftSubscriptionKeyConfigured: nextKey != null
    }
    const configurationChanged = keyChanged ||
      nextPatch.microsoftEnabled !== previousSettings.microsoftEnabled ||
      nextPatch.microsoftRegion !== previousSettings.microsoftRegion

    if (keyChanged) this.dependencies.credentialStore.saveKey(submittedKey)
    let settings: Settings
    try {
      settings = this.dependencies.saveSettings(nextPatch)
    } catch (error) {
      if (keyChanged) this.restoreKey(previousKey)
      throw error
    }

    this.subscriptionKey = nextKey
    this.credentialError = undefined
    if (configurationChanged) this.dependencies.resetTranslationRuntime?.()
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }

  /**
   * 显式清除订阅密钥，并在公开设置保存失败时恢复旧凭证。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearKey(): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousKey = this.subscriptionKey
    this.dependencies.credentialStore.clearKey()

    let settings: Settings
    try {
      settings = this.dependencies.saveSettings({ microsoftSubscriptionKeyConfigured: false })
    } catch (error) {
      this.restoreKey(previousKey)
      throw error
    }

    this.subscriptionKey = null
    this.credentialError = undefined
    if (previousKey != null || previousSettings.microsoftSubscriptionKeyConfigured) {
      this.dependencies.resetTranslationRuntime?.()
    }
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }

  /**
   * 获取当前请求使用的主进程凭证快照，可选择是否要求启用开关已开启。
   * @param requireEnabled 是否要求微软翻译开关为启用状态。
   * @returns 完整凭证快照；配置不完整时返回 null。
   * @author zhenghq
   */
  getCredentialsSnapshot(requireEnabled = true): MicrosoftCredentials | null {
    const settings = this.dependencies.getSettings()
    if (requireEnabled && !settings.microsoftEnabled) return null
    if (!settings.microsoftSubscriptionKeyConfigured || !this.subscriptionKey) return null
    return {
      subscriptionKey: this.subscriptionKey,
      region: settings.microsoftRegion
    }
  }

  /**
   * 返回读取安全凭证时的脱敏异常状态。
   * @returns 凭证读取错误；正常时返回 undefined。
   * @author zhenghq
   */
  getCredentialError(): string | undefined {
    return this.credentialError
  }

  /**
   * 回滚已变更的订阅密钥，优先恢复旧值；旧值不存在时确保删除新文件。
   * @param previousKey 变更前的订阅密钥。
   * @returns 无返回值。
   * @author zhenghq
   */
  private restoreKey(previousKey: string | null): void {
    try {
      if (previousKey) this.dependencies.credentialStore.saveKey(previousKey)
      else this.dependencies.credentialStore.clearKey()
    } catch {
      console.error('[microsoft] 回滚订阅密钥失败，请重新配置')
    }
  }
}
