/** 应用支持的界面语言。 */
export type Locale = 'zh-CN' | 'en-US'

/** 用户可选择的界面语言偏好，auto 表示跟随系统。 */
export type UiLocale = 'auto' | Locale

/** 应用支持的全部界面语言，顺序用于目录展示。 */
export const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en-US']

/** 所有候选都不可用时的最终兜底语言。 */
export const DEFAULT_LOCALE: Locale = 'en-US'

/** 将系统语言标签规范化为应用支持的 Locale。
 * 支持下划线、编码后缀、修饰符和中文地区变体，不支持的值返回 null。
 * @param value 待规范化的系统语言标签。
 * @returns 规范化后的受支持语言，或 null。
 * @author zhenghq
 */
export function normalizeLocaleTag(value: unknown): Locale | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .trim()
    .replace(/_/gu, '-')
    .replace(/\.[^@]*$/u, '')
    .replace(/@.*$/u, '')
    .trim()
    .toLowerCase()
  if (!normalized || normalized === 'c' || normalized === 'posix') return null

  const language = normalized.split('-')[0]
  if (language === 'zh') return 'zh-CN'
  if (language === 'en') return 'en-US'
  return null
}

/** 将未知设置值规范化为合法界面语言偏好。
 * @param value 待规范化的设置值。
 * @returns auto、zh-CN 或 en-US。
 * @author zhenghq
 */
export function normalizeUiLocale(value: unknown): UiLocale {
  return value === 'auto' || value === 'zh-CN' || value === 'en-US' ? value : 'auto'
}

/** 根据用户偏好和候选语言解析最终界面语言。
 * @param uiLocale 用户保存的界面语言偏好。
 * @param candidates 按优先级排列的系统、环境或浏览器语言候选。
 * @returns 最终使用的界面语言。
 * @author zhenghq
 */
export function resolveLocale(uiLocale: unknown, candidates: readonly unknown[] = []): Locale {
  const preference = normalizeUiLocale(uiLocale)
  if (preference !== 'auto') return preference

  for (const candidate of candidates) {
    const locale = normalizeLocaleTag(candidate)
    if (locale) return locale
  }
  return DEFAULT_LOCALE
}

/** 自动语言检测所需的系统、环境与浏览器候选。 */
export interface DetectSystemLocaleOptions {
  /** Electron 首选系统语言列表，优先级最高。 */
  preferredSystemLanguages?: readonly unknown[]
  /** Electron 系统区域设置。 */
  systemLocale?: unknown
  /** Electron 应用区域设置。 */
  appLocale?: unknown
  /** 进程环境变量，默认读取 LANG、LC_ALL、LC_MESSAGES。 */
  env?: Record<string, string | undefined>
  /** Renderer 浏览器语言列表。 */
  navigatorLanguages?: readonly unknown[]
}

/** 按统一优先级检测系统界面语言。
 * @param options 系统、环境与浏览器语言候选。
 * @returns 检测到的受支持语言，无法识别时回退 en-US。
 * @author zhenghq
 */
export function detectSystemLocale(options: DetectSystemLocaleOptions = {}): Locale {
  const env = options.env ?? {}
  const candidates = [
    ...(options.preferredSystemLanguages ?? []),
    options.systemLocale,
    options.appLocale,
    env.LANG,
    env.LC_ALL,
    env.LC_MESSAGES,
    ...(options.navigatorLanguages ?? [])
  ]
  return resolveLocale('auto', candidates)
}
