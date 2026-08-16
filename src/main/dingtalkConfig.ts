import type { DingTalkConfigPatch, Settings } from '../shared/types'
import type { DingTalkSecretReadResult } from './dingtalkCredentials'

/** 主进程调用钉钉接口所需的完整凭证快照。 */
export interface DingTalkCredentials {
  corpId: string
  clientId: string
  clientSecret: string
}

/** 钉钉配置服务使用的凭证存储最小接口。 */
export interface DingTalkCredentialStoreAdapter {
  /** 读取已保存的 Secret。 */
  readSecret(): DingTalkSecretReadResult
  /** 安全保存新的 Secret。 */
  saveSecret(secret: string): void
  /** 显式清除 Secret。 */
  clearSecret(): void
}

/** 钉钉配置服务依赖。 */
export interface DingTalkConfigurationDependencies {
  /** 获取当前公开设置。 */
  getSettings(): Settings
  /** 持久化公开设置补丁。 */
  saveSettings(patch: Partial<Settings>): Settings
  /** 安全凭证存储。 */
  credentialStore: DingTalkCredentialStoreAdapter
  /** 配置成功后广播公开设置。 */
  onSettingsChanged?(settings: Settings): void
  /** 钉钉相关配置变化后清理翻译运行时。 */
  resetTranslationRuntime?(): void
}

/**
 * 管理钉钉公开设置和安全凭证，并保证失败时不发布半成品运行时状态。
 * @param dependencies 设置、凭证、广播和运行时重置依赖。
 * @returns 钉钉配置服务实例。
 * @author zhenghq
 */
export class DingTalkConfigurationService {
  private secret: string | null = null
  private credentialError: string | undefined

  constructor(private readonly dependencies: DingTalkConfigurationDependencies) {}

  /**
   * 加载安全凭证并同步公开的已配置标记。
   * @returns 同步后的公开设置。
   * @author zhenghq
   */
  initialize(): Settings {
    const loaded = this.dependencies.credentialStore.readSecret()
    this.secret = loaded.secret
    this.credentialError = loaded.error
    const settings = this.dependencies.getSettings()
    if (settings.dingTalkSecretConfigured === loaded.configured) return settings
    return this.dependencies.saveSettings({ dingTalkSecretConfigured: loaded.configured })
  }

  /**
   * 应用钉钉配置补丁；空 Secret 保留旧值，失败时回滚已写入的凭证。
   * @param patch 钉钉启用状态、标识字段和可选新 Secret。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  applyPatch(patch: DingTalkConfigPatch): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousSecret = this.secret
    const submittedSecret = typeof patch.clientSecret === 'string'
      ? patch.clientSecret.trim()
      : ''
    const nextSecret = submittedSecret || previousSecret
    const secretChanged = Boolean(submittedSecret) && submittedSecret !== previousSecret
    const nextPatch: Partial<Settings> = {
      dingTalkEnabled: typeof patch.enabled === 'boolean'
        ? patch.enabled
        : previousSettings.dingTalkEnabled,
      dingTalkCorpId: patch.corpId === undefined
        ? previousSettings.dingTalkCorpId
        : patch.corpId.trim(),
      dingTalkClientId: patch.clientId === undefined
        ? previousSettings.dingTalkClientId
        : patch.clientId.trim(),
      dingTalkSecretConfigured: nextSecret != null
    }
    const configurationChanged = secretChanged ||
      nextPatch.dingTalkEnabled !== previousSettings.dingTalkEnabled ||
      nextPatch.dingTalkCorpId !== previousSettings.dingTalkCorpId ||
      nextPatch.dingTalkClientId !== previousSettings.dingTalkClientId

    if (secretChanged) this.dependencies.credentialStore.saveSecret(submittedSecret)
    let settings: Settings
    try {
      settings = this.dependencies.saveSettings(nextPatch)
    } catch (error) {
      if (secretChanged) this.restoreSecret(previousSecret)
      throw error
    }

    this.secret = nextSecret
    this.credentialError = undefined
    if (configurationChanged) this.dependencies.resetTranslationRuntime?.()
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }

  /**
   * 显式清除 ClientSecret，并在公开设置保存失败时恢复旧凭证。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearSecret(): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousSecret = this.secret
    this.dependencies.credentialStore.clearSecret()

    let settings: Settings
    try {
      settings = this.dependencies.saveSettings({ dingTalkSecretConfigured: false })
    } catch (error) {
      this.restoreSecret(previousSecret)
      throw error
    }

    this.secret = null
    this.credentialError = undefined
    if (previousSecret != null || previousSettings.dingTalkSecretConfigured) {
      this.dependencies.resetTranslationRuntime?.()
    }
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }

  /**
   * 获取当前请求使用的主进程凭证快照，可选择是否要求启用开关已开启。
   * @param requireEnabled 是否要求钉钉启用开关为开启状态。
   * @returns 配置完整时的凭证快照，否则返回 null。
   * @author zhenghq
   */
  getCredentialsSnapshot(requireEnabled = true): DingTalkCredentials | null {
    const settings = this.dependencies.getSettings()
    if (requireEnabled && !settings.dingTalkEnabled) return null
    if (!settings.dingTalkCorpId || !settings.dingTalkClientId || !this.secret) return null
    return {
      corpId: settings.dingTalkCorpId,
      clientId: settings.dingTalkClientId,
      clientSecret: this.secret
    }
  }

  /**
   * 返回读取安全凭证时产生的脱敏错误。
   * @returns 脱敏凭证错误，未发生错误时为 undefined。
   * @author zhenghq
   */
  getCredentialError(): string | undefined {
    return this.credentialError
  }

  /**
   * 将凭证存储恢复到指定 Secret，用于配置事务失败回滚。
   * @param secret 需要恢复的旧 Secret；null 表示恢复为未配置。
   * @returns 无返回值。
   * @author zhenghq
   */
  private restoreSecret(secret: string | null): void {
    try {
      if (secret == null) this.dependencies.credentialStore.clearSecret()
      else this.dependencies.credentialStore.saveSecret(secret)
    } catch {
      // 回滚失败不能暴露 Secret；运行时仍保留上一份内存配置。
    }
  }
}
