import { createTranslator, type Locale, type Translator } from './i18n'

export interface Lang {
  /** 翻译服务使用的语言代码。 */
  code: string
  /** 英文兜底名称；界面展示请使用 langLabel 或 localizedLanguages。 */
  label: string
}

// DeepL 支持的语言子集（大写代码，DeepLX 兼容），label 仅作英文兜底。
export const LANGUAGES: Lang[] = [
  { code: 'ZH', label: 'Chinese' },
  { code: 'EN', label: 'English' },
  { code: 'JA', label: 'Japanese' },
  { code: 'KO', label: 'Korean' },
  { code: 'FR', label: 'French' },
  { code: 'DE', label: 'German' },
  { code: 'ES', label: 'Spanish' },
  { code: 'PT', label: 'Portuguese' },
  { code: 'IT', label: 'Italian' },
  { code: 'NL', label: 'Dutch' },
  { code: 'PL', label: 'Polish' },
  { code: 'RU', label: 'Russian' },
  { code: 'TR', label: 'Turkish' },
  { code: 'ID', label: 'Indonesian' },
  { code: 'UK', label: 'Ukrainian' },
  { code: 'AR', label: 'Arabic' },
  { code: 'SV', label: 'Swedish' },
  { code: 'DA', label: 'Danish' },
  { code: 'CS', label: 'Czech' },
  { code: 'EL', label: 'Greek' },
  { code: 'FI', label: 'Finnish' },
  { code: 'HU', label: 'Hungarian' },
  { code: 'RO', label: 'Romanian' },
  { code: 'SK', label: 'Slovak' },
  { code: 'BG', label: 'Bulgarian' },
  { code: 'LT', label: 'Lithuanian' },
  { code: 'LV', label: 'Latvian' },
  { code: 'ET', label: 'Estonian' },
  { code: 'SL', label: 'Slovenian' }
]

/**
 * 解析翻译目标语言的词条 key。
 * @param code 语言代码。
 * @returns 对应的语义化词条 key。
 * @author zhenghq
 */
function langKey(code: string): string {
  return `lang.${code.toUpperCase()}`
}

/**
 * 把界面语言或翻译器统一解析为翻译器实例。
 * @param locale 当前界面语言或翻译器。
 * @returns 可执行 t 与 has 的翻译器。
 * @author zhenghq
 */
function resolveTranslator(locale: Locale | Translator): Translator {
  return typeof locale === 'string' ? createTranslator(locale) : locale
}

/**
 * 按当前界面语言获取语言名称。
 * @param code 语言代码，auto 表示自动检测。
 * @param locale 当前界面语言或翻译器。
 * @returns 本地化后的语言名称，未知代码回退为原始代码。
 * @author zhenghq
 */
export function langLabel(code: string, locale: Locale | Translator = 'en-US'): string {
  if (!code) return ''
  const translator = resolveTranslator(locale)
  if (code.toLowerCase() === 'auto') return translator.t('settings.sourceLang.auto')
  const normalized = code.toUpperCase()
  const key = langKey(normalized)
  return translator.has(key) ? translator.t(key) : normalized
}

/**
 * 生成按当前界面语言本地化的语言下拉选项。
 * @param locale 当前界面语言或翻译器。
 * @returns 含 code 与本地化 label 的语言列表。
 * @author zhenghq
 */
export function localizedLanguages(locale: Locale | Translator = 'en-US'): Lang[] {
  const translator = resolveTranslator(locale)
  return LANGUAGES.map((language) => ({
    code: language.code,
    label: translator.has(langKey(language.code))
      ? translator.t(langKey(language.code))
      : language.label
  }))
}
