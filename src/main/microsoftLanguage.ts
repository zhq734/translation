/** 微软翻译可执行的语言对。 */
export interface SupportedMicrosoftLanguagePair {
  supported: true
  /** 未指定时由微软 Translator 自动检测源语言。 */
  sourceLanguage?: string
  targetLanguage: string
}

/** 微软翻译不支持、应直接跳过的语言对。 */
export interface UnsupportedMicrosoftLanguagePair {
  supported: false
}

/** 微软翻译语言对解析结果。 */
export type MicrosoftLanguagePair =
  | SupportedMicrosoftLanguagePair
  | UnsupportedMicrosoftLanguagePair

const MICROSOFT_LANGUAGE_CODES: Record<string, string> = {
  ZH: 'zh-Hans',
  EN: 'en',
  JA: 'ja',
  KO: 'ko',
  FR: 'fr',
  DE: 'de',
  ES: 'es',
  PT: 'pt',
  IT: 'it',
  NL: 'nl',
  PL: 'pl',
  RU: 'ru',
  TR: 'tr',
  ID: 'id',
  UK: 'uk',
  AR: 'ar',
  SV: 'sv',
  DA: 'da',
  CS: 'cs',
  EL: 'el',
  FI: 'fi',
  HU: 'hu',
  RO: 'ro',
  SK: 'sk',
  BG: 'bg',
  LT: 'lt',
  LV: 'lv',
  ET: 'et',
  SL: 'sl'
}

/**
 * 将应用内部语言代码转换为微软 Translator 使用的语言代码。
 * @param language 应用内部语言代码。
 * @returns 可用的微软语言代码；无法转换时返回 null。
 * @author zhenghq
 */
function normalizeMicrosoftLanguage(language: string): string | null {
  return MICROSOFT_LANGUAGE_CODES[language.trim().toUpperCase()] ?? null
}

/**
 * 解析微软翻译语言对，源语言为 auto 时省略 from 参数以启用服务端自动检测。
 * @param sourceLanguage 应用已解析的源语言，可能为 auto。
 * @param targetLanguage 应用已解析的目标语言。
 * @returns 受支持的语言对，或可直接跳过的结果。
 * @author zhenghq
 */
export function resolveMicrosoftLanguagePair(
  sourceLanguage: string,
  targetLanguage: string
): MicrosoftLanguagePair {
  const target = normalizeMicrosoftLanguage(targetLanguage)
  if (!target) return { supported: false }

  if (sourceLanguage.trim().toLowerCase() === 'auto') {
    return { supported: true, targetLanguage: target }
  }

  const source = normalizeMicrosoftLanguage(sourceLanguage)
  if (!source || source === target) return { supported: false }
  return { supported: true, sourceLanguage: source, targetLanguage: target }
}
