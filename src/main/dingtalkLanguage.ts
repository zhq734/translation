/** 钉钉可执行的语言对。 */
export interface SupportedDingTalkLanguagePair {
  supported: true
  sourceLanguage: string
  targetLanguage: string
}

/** 钉钉不支持、应直接跳过的语言对。 */
export interface UnsupportedDingTalkLanguagePair {
  supported: false
}

export type DingTalkLanguagePair =
  | SupportedDingTalkLanguagePair
  | UnsupportedDingTalkLanguagePair

const SUPPORTED_LANGUAGES = new Set([
  'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'ru', 'id', 'vi', 'th', 'ar', 'tr'
])

/**
 * 将应用内部语言代码转换为钉钉使用的小写 ISO-639-1 代码。
 * @param language 应用内部语言代码。
 * @returns 规范化代码；无法转换时返回 null。
 * @author zhenghq
 */
function normalizeDingTalkLanguage(language: string): string | null {
  const normalized = language.trim().toLowerCase().split('-')[0]
  if (!normalized || normalized === 'auto') return null
  return SUPPORTED_LANGUAGES.has(normalized) ? normalized : null
}

/**
 * 解析钉钉翻译语言对，自动模式按现有中英目标结果补全源语言。
 * @param text 待翻译文本，保留用于与统一语言解析接口对齐。
 * @param sourceLanguage 应用已经解析的源语言，可能为 auto。
 * @param targetLanguage 应用已经解析的目标语言。
 * @returns 受支持的钉钉语言对，或可直接跳过的结果。
 * @author zhenghq
 */
export function resolveDingTalkLanguagePair(
  text: string,
  sourceLanguage: string,
  targetLanguage: string
): DingTalkLanguagePair {
  void text
  const target = normalizeDingTalkLanguage(targetLanguage)
  if (!target) return { supported: false }

  let source = normalizeDingTalkLanguage(sourceLanguage)
  if (sourceLanguage.trim().toLowerCase() === 'auto') {
    if (target === 'en') source = 'zh'
    else if (target === 'zh') source = 'en'
    else return { supported: false }
  }

  if (!source || source === target) return { supported: false }
  return { supported: true, sourceLanguage: source, targetLanguage: target }
}
