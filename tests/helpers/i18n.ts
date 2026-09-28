import { createTranslator, type Locale, type TranslationParams } from '../../src/shared/i18n/index.ts'

/**
 * 使用固定界面语言生成测试期望文案。
 * @param locale 期望文案对应的界面语言。
 * @param key 语义化词条 key。
 * @param params 插值参数。
 * @returns 指定语言下完成插值的词条文本。
 * @author zhenghq
 */
export function tForTest(
  locale: Locale,
  key: string,
  params?: TranslationParams
): string {
  return createTranslator(locale).t(key, params)
}

/**
 * 创建固定语言的翻译器，便于测试复用同一套断言辅助。
 * @param locale 翻译器使用的界面语言。
 * @returns 指定语言的共享翻译器。
 * @author zhenghq
 */
export function translatorForTest(locale: Locale) {
  return createTranslator(locale)
}

/**
 * 从 HTML 开始标签中读取 data-i18n 声明的文本 key。
 * @param tag 待解析的 HTML 开始标签。
 * @returns 声明的词条 key；未声明时返回 null。
 * @author zhenghq
 */
export function readTextI18nKey(tag: string): string | null {
  return tag.match(/\bdata-i18n="([^"]+)"/u)?.[1] ?? null
}

/**
 * 从 HTML 开始标签中读取 data-i18n-attr 声明的指定属性 key。
 * @param tag 待解析的 HTML 开始标签。
 * @param attribute 目标属性名，例如 aria-label、title 或 placeholder。
 * @returns 声明的词条 key；未声明时返回 null。
 * @author zhenghq
 */
export function readAttributeI18nKey(tag: string, attribute: string): string | null {
  const declaration = tag.match(/\bdata-i18n-attr="([^"]+)"/u)?.[1]
  if (!declaration) return null
  for (const entry of declaration.split(';')) {
    const separator = entry.indexOf(':')
    if (separator < 1) continue
    if (entry.slice(0, separator).trim() === attribute) {
      return entry.slice(separator + 1).trim() || null
    }
  }
  return null
}

/**
 * 从 HTML 文本中提取指定 id 元素的开始标签。
 * @param html 待搜索的 HTML 文本。
 * @param id 元素 id。
 * @returns 元素开始标签；未找到时返回 null。
 * @author zhenghq
 */
export function findOpeningTagById(html: string, id: string): string | null {
  return html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, 'u'))?.[0] ?? null
}

/**
 * 生成中文界面下的用户可见文案，供 Renderer 控制器测试注入 getMessage。
 * @param key 语义化词条 key。
 * @returns 中文词条文本。
 * @author zhenghq
 */
export function zhMessage(key: string): string {
  return createTranslator('zh-CN').t(key)
}
