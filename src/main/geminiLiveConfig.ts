import type { GeminiLiveConfigPatch, Settings } from '../shared/types'
import type { GeminiLiveApiKeyReadResult } from './geminiLiveCredentials'

/** Gemini Live 配置服务使用的凭证存储最小接口。 */
export interface GeminiLiveCredentialStoreAdapter {
  /** 读取已保存的 API Key。 */
  readApiKey(): GeminiLiveApiKeyReadResult
  /** 安全保存新的 API Key。 */
  saveApiKey(apiKey: string): void
  /** 显式清除 API Key。 */
  clearApiKey(): void
}

/** Gemini Live 配置服务依赖。 */
export interface GeminiLiveConfigurationDependencies {
  /** 获取当前公开设置。 */
  getSettings(): Settings
  /** 持久化公开设置补丁。 */
  saveSettings(patch: Partial<Settings>): Settings
  /** 安全凭证存储。 */
  credentialStore: GeminiLiveCredentialStoreAdapter
  /** 配置成功后广播公开设置。 */
  onSettingsChanged?(settings: Settings): void
  /** ASR 配置变化后重置实时字幕运行时。 */
  resetRealtimeSubtitleRuntime?(): void
}

/**
 * 管理 Gemini Live 原生翻译的公开配置和 API Key 凭证。
 * @author zhenghq
 */
export class GeminiLiveConfigurationService {
  private apiKey: string | null = null

  /**
   * 创建 Gemini Live 配置服务。
   * @param dependencies 设置、凭证、广播和运行时重置依赖。
   * @author zhenghq
   */
  constructor(private readonly dependencies: GeminiLiveConfigurationDependencies) {}

  /**
   * 加载安全凭证并同步公开的已配置标记。
   * @returns 同步后的公开设置。
   * @author zhenghq
   */
  initialize(): Settings {
    const loaded = this.dependencies.credentialStore.readApiKey()
    this.apiKey = loaded.apiKey
    const settings = this.dependencies.getSettings()
    if (settings.realtimeSubtitleGeminiApiKeyConfigured === loaded.configured) return settings
    return this.dependencies.saveSettings({
      realtimeSubtitleGeminiApiKeyConfigured: loaded.configured
    })
  }

  /**
   * 应用 Gemini Live 配置补丁；空 API Key 保留旧值，设置保存失败时回滚凭证。
   * @param patch WebSocket 地址、模型和可选新 API Key。
   * @returns 保存成功后的脱敏公开设置。
   * @author zhenghq
   */
  configure(patch: GeminiLiveConfigPatch): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousApiKey = this.apiKey
    const submittedKey = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : ''
    const nextApiKey = submittedKey || previousApiKey
    const keyChanged = Boolean(submittedKey) && submittedKey !== previousApiKey
    const nextPatch: Partial<Settings> = {
      realtimeSubtitleGeminiUrl: patch.url === undefined
        ? previousSettings.realtimeSubtitleGeminiUrl
        : patch.url,
      realtimeSubtitleGeminiModel: patch.model === undefined
        ? previousSettings.realtimeSubtitleGeminiModel
        : patch.model,
      realtimeSubtitleGeminiApiKeyConfigured: nextApiKey != null
    }
    const configurationChanged = keyChanged ||
      nextPatch.realtimeSubtitleGeminiUrl !== previousSettings.realtimeSubtitleGeminiUrl ||
      nextPatch.realtimeSubtitleGeminiModel !== previousSettings.realtimeSubtitleGeminiModel ||
      nextPatch.realtimeSubtitleGeminiApiKeyConfigured !==
        previousSettings.realtimeSubtitleGeminiApiKeyConfigured

    if (keyChanged) this.dependencies.credentialStore.saveApiKey(submittedKey)
    let settings: Settings
    try {
      settings = this.dependencies.saveSettings(nextPatch)
    } catch (error) {
      if (keyChanged) this.restoreApiKey(previousApiKey)
      throw error
    }

    this.apiKey = nextApiKey
    if (configurationChanged) this.dependencies.resetRealtimeSubtitleRuntime?.()
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }

  /**
   * 显式清除 Gemini API Key，并在设置保存失败时恢复旧凭证。
   * @returns 清除后的脱敏公开设置。
   * @author zhenghq
   */
  clearApiKey(): Settings {
    const previousSettings = this.dependencies.getSettings()
    const previousApiKey = this.apiKey
    this.dependencies.credentialStore.clearApiKey()

    let settings: Settings
    try {
      settings = this.dependencies.saveSettings({
        realtimeSubtitleGeminiApiKeyConfigured: false
      })
    } catch (error) {
      this.restoreApiKey(previousApiKey)
      throw error
    }

    this.apiKey = null
    if (previousApiKey != null || previousSettings.realtimeSubtitleGeminiApiKeyConfigured) {
      this.dependencies.resetRealtimeSubtitleRuntime?.()
    }
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }

  /**
   * 获取当前主进程使用的 Gemini API Key 快照。
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
