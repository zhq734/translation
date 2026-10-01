import { createTranslator, type Locale, type Translator } from './i18n'
import type {
  Settings,
  TranslationProviderId,
  TranslationProviderPreference
} from './types'

export interface TranslationProviderDefinition {
  /** 稳定的翻译 API 标识。 */
  id: TranslationProviderId
  /** 英文兜底名称；界面展示请使用 translationProviderLabel。 */
  label: string
}

/** 弹窗中可供选择的翻译 API，顺序与默认降级顺序一致。 */
export const TRANSLATION_PROVIDERS: readonly TranslationProviderDefinition[] = [
  { id: 'ai', label: 'AI Translation' },
  { id: 'dingtalk', label: 'DingTalk' },
  { id: 'microsoft', label: 'Microsoft Translator' },
  { id: 'deeplx-self', label: 'Self-hosted DeepLX' },
  { id: 'deeplx-public', label: 'Public DeepLX' },
  { id: 'google', label: 'Google Translate' },
  { id: 'mymemory', label: 'MyMemory' }
]

/**
 * 解析翻译 API 名称的词条 key。
 * @param providerId 翻译 API 标识。
 * @returns 对应的语义化词条 key。
 * @author zhenghq
 */
function providerKey(providerId: TranslationProviderId): string {
  return `provider.${providerId}`
}

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
 * @param locale 当前界面语言或翻译器。
 * @returns 面向用户展示的本地化名称。
 * @author zhenghq
 */
export function translationProviderLabel(
  providerId: TranslationProviderPreference,
  locale: Locale | Translator = 'en-US'
): string {
  const translator: Translator = typeof locale === 'string' ? createTranslator(locale) : locale
  if (providerId === 'auto') return translator.t('provider.auto')
  const key = providerKey(providerId)
  if (translator.has(key)) return translator.t(key)
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
