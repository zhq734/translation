import type {
  Settings,
  TranslationProviderId,
  TranslationProviderPreference
} from './types'

export interface TranslationProviderDefinition {
  /** 稳定的翻译 API 标识。 */
  id: TranslationProviderId
  /** 面向用户展示的 API 名称。 */
  label: string
}

/** 弹窗中可供选择的翻译 API，顺序与默认降级顺序一致。 */
export const TRANSLATION_PROVIDERS: readonly TranslationProviderDefinition[] = [
  { id: 'ai', label: 'AI 翻译' },
  { id: 'dingtalk', label: '钉钉翻译' },
  { id: 'microsoft', label: '微软翻译' },
  { id: 'deeplx-self', label: '自建 DeepLX' },
  { id: 'deeplx-public', label: '公共 DeepLX' },
  { id: 'google', label: 'Google 翻译' },
  { id: 'mymemory', label: 'MyMemory 翻译' }
]

/**
 * 判断未知值是否为支持的翻译 API 偏好。
 * @param value 待校验的设置值。
 * @returns 是否可以安全写入翻译 API 偏好。
 * @author zhenghq
 */
export function isTranslationProviderPreference(
  value: unknown
): value is TranslationProviderPreference {
  return value === 'auto' || TRANSLATION_PROVIDERS.some((provider) => provider.id === value)
}

/**
 * 获取翻译 API 的展示名称。
 * @param providerId 翻译 API 标识或自动选择偏好。
 * @returns 面向用户展示的名称。
 * @author zhenghq
 */
export function translationProviderLabel(
  providerId: TranslationProviderPreference
): string {
  if (providerId === 'auto') return '自动选择'
  return TRANSLATION_PROVIDERS.find((provider) => provider.id === providerId)?.label ?? providerId
}

/**
 * 判断翻译 API 是否已具备当前设置所需的基础配置。
 * @param providerId 翻译 API 标识。
 * @param settings 当前完整设置。
 * @returns 是否允许用户选择该 API。
 * @author zhenghq
 */
export function isTranslationProviderAvailable(
  providerId: TranslationProviderId,
  settings: Settings
): boolean {
  if (providerId === 'dingtalk') {
    return settings.dingTalkEnabled &&
      Boolean(settings.dingTalkCorpId) &&
      Boolean(settings.dingTalkClientId) &&
      settings.dingTalkSecretConfigured
  }
  if (providerId === 'ai') {
    return settings.aiEnabled &&
      Boolean(settings.aiBaseUrl.trim()) &&
      Boolean(settings.aiModel.trim())
  }
  if (providerId === 'microsoft') return settings.microsoftEnabled
  if (providerId === 'deeplx-self') return Boolean(settings.deepLxUrl.trim())
  return true
}
