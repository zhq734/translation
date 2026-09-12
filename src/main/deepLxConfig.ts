import type { DeepLxConfigPatch, Settings } from '../shared/types'

/** DeepLX 配置服务依赖。 */
export interface DeepLxConfigurationDependencies {
  /** 获取当前公开设置。 */
  getSettings(): Settings
  /** 持久化公开设置补丁。 */
  saveSettings(patch: Partial<Settings>): Settings
  /** 配置成功后广播公开设置。 */
  onSettingsChanged?(settings: Settings): void
  /** 配置变化后清理 DeepLX 翻译运行时。 */
  resetTranslationRuntime?(): void
}

/**
 * 管理 DeepLX 多地址公开设置。
 * @param dependencies 设置、广播和运行时重置依赖。
 * @returns DeepLX 配置服务实例。
 * @author zhenghq
 */
export class DeepLxConfigurationService {
  constructor(private readonly dependencies: DeepLxConfigurationDependencies) {}

  /**
   * 应用 DeepLX 多地址配置。
   * @param patch DeepLX 配置补丁。
   * @returns 保存后的公开设置。
   * @author zhenghq
   */
  applyPatch(patch: DeepLxConfigPatch): Settings {
    const previousSettings = this.dependencies.getSettings()
    const nextUrl = patch.url === undefined ? previousSettings.deepLxUrl : patch.url.trim()
    const settings = this.dependencies.saveSettings({ deepLxUrl: nextUrl })
    if (nextUrl !== previousSettings.deepLxUrl) this.dependencies.resetTranslationRuntime?.()
    this.dependencies.onSettingsChanged?.(settings)
    return settings
  }
}
