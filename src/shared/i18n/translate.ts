import type { CatalogValue, PluralForms, TranslationParams } from './catalog.ts'
import { enUSCatalog } from './catalog.en-US.ts'
import { zhCNCatalog } from './catalog.zh-CN.ts'
import { DEFAULT_LOCALE, type Locale } from './locale.ts'

/** 英文目录中定义的合法翻译 key。 */
export type TranslationKey = keyof typeof enUSCatalog

/** 当前语言翻译器。 */
export interface Translator {
  /** 当前生效的界面语言。 */
  locale: Locale
  /** 翻译普通词条并执行命名参数插值。 */
  t(key: TranslationKey | string, params?: TranslationParams): string
  /** 根据数量选择复数分支并执行命名参数插值。 */
  plural(key: TranslationKey | string, count: number, params?: TranslationParams): string
  /** 判断当前语言或英文兜底目录是否存在词条。 */
  has(key: TranslationKey | string): boolean
}

const CATALOGS: Record<Locale, Record<string, CatalogValue>> = {
  'zh-CN': zhCNCatalog,
  'en-US': enUSCatalog
}

/** 将参数值替换到 {{name}} 占位符。
 * @param template 含占位符的词条文本。
 * @param params 命名参数。
 * @returns 完成插值后的文本。
 * @author zhenghq
 */
function interpolate(template: string, params: TranslationParams = {}): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (placeholder, name: string) => {
    const value = params[name]
    return value === undefined ? placeholder : String(value)
  })
}

/** 将复数词条解析为指定数量的文本。
 * @param forms 复数词条。
 * @param count 当前数量。
 * @returns 匹配的复数分支，缺失时回退 other。
 * @author zhenghq
 */
function selectPluralForm(forms: PluralForms, count: number): string {
  if (count === 0 && forms.zero !== undefined) return forms.zero
  if (count === 1) return forms.one
  return forms.other
}

/** 查找指定语言的词条，缺失时回退英文目录。
 * @param locale 当前语言。
 * @param key 语义化词条 key。
 * @returns 当前语言词条、英文词条或 undefined。
 * @author zhenghq
 */
function findValue(locale: Locale, key: string): CatalogValue | undefined {
  return CATALOGS[locale]?.[key] ?? CATALOGS[DEFAULT_LOCALE][key]
}

/** 创建指定界面语言的翻译器。
 * @param locale 当前界面语言。
 * @returns 可执行 t、plural 和 has 的翻译器。
 * @author zhenghq
 */
export function createTranslator(locale: Locale): Translator {
  const currentLocale = CATALOGS[locale] ? locale : DEFAULT_LOCALE

  return {
    locale: currentLocale,
    t(key, params) {
      const value = findValue(currentLocale, key)
      if (typeof value === 'string') return interpolate(value, params)
      if (value) return interpolate(selectPluralForm(value, Number(params?.count ?? 0)), params)
      return key
    },
    plural(key, count, params) {
      const value = findValue(currentLocale, key)
      const mergedParams = { ...params, count }
      if (typeof value === 'string') return interpolate(value, mergedParams)
      if (value) return interpolate(selectPluralForm(value, count), mergedParams)
      return key
    },
    has(key) {
      return findValue(currentLocale, key) !== undefined
    }
  }
}
