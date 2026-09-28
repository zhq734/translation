import { DEFAULT_LOCALE, resolveLocale, type Locale } from '../shared/i18n/index.ts'

/**
 * 将界面语言转换为 Intl 可使用的 BCP 47 标签。
 * @param locale 当前界面语言。
 * @returns 对应的 BCP 47 语言标签。
 * @author zhenghq
 */
export function localeToIntlTag(locale: Locale): string {
  return locale === 'zh-CN' ? 'zh-CN' : 'en-US'
}

/**
 * 返回与界面语言匹配的字段分隔符。
 * @param locale 当前界面语言。
 * @returns 中文使用全角冒号，英文使用 ASCII 冒号加空格。
 * @author zhenghq
 */
export function localeFieldSeparator(locale: Locale): string {
  return locale === 'zh-CN' ? '：' : ': '
}

/**
 * 按界面语言格式化日期时间。
 * @param date 待格式化日期。
 * @param locale 当前界面语言。
 * @param options Intl 日期时间格式选项。
 * @returns 与界面语言一致的日期时间文本。
 * @author zhenghq
 */
export function formatLocaleDateTime(
  date: Date,
  locale: Locale = DEFAULT_LOCALE,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'long' }
): string {
  return new Intl.DateTimeFormat(localeToIntlTag(locale), options).format(date)
}

/**
 * 按界面语言格式化短日期。
 * @param date 待格式化日期。
 * @param locale 当前界面语言。
 * @returns 与界面语言一致的日期文本。
 * @author zhenghq
 */
export function formatLocaleDate(date: Date, locale: Locale = DEFAULT_LOCALE): string {
  return formatLocaleDateTime(date, locale, { dateStyle: 'medium' })
}

/**
 * 检测当前主进程界面语言；优先读取持久化设置，读取失败时回退系统语言。
 * @returns 当前界面语言。
 * @author zhenghq
 */
export function detectMainProcessLocale(): Locale {
  let uiLocale: unknown = 'auto'
  try {
    const settings = require('./settings') as typeof import('./settings')
    uiLocale = settings.getSettings().uiLocale
  } catch {
    // 测试或 Electron 尚未就绪时按系统语言检测。
  }
  return resolveLocale(uiLocale, collectMainProcessLocaleCandidates())
}

/**
 * 汇总主进程环境可用的系统语言候选。
 * @returns 按优先级排列的系统语言候选。
 * @author zhenghq
 */
function collectMainProcessLocaleCandidates(): unknown[] {
  try {
    const { app } = require('electron') as typeof import('electron')
    return [
      ...app.getPreferredSystemLanguages(),
      app.getSystemLocale(),
      app.getLocale(),
      process.env.LANG,
      process.env.LC_ALL,
      process.env.LC_MESSAGES
    ]
  } catch {
    return [process.env.LANG, process.env.LC_ALL, process.env.LC_MESSAGES]
  }
}
