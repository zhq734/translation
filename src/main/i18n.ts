import {
  createTranslator,
  detectSystemLocale,
  resolveLocale,
  type Locale,
  type Translator,
  type UiLocale
} from '../shared/i18n'
import { setMainMessageTranslator } from './messages'

/** 主进程界面语言运行时所需的系统语言来源。 */
export interface MainI18nLocaleSources {
  /** Electron 首选系统语言列表。 */
  preferredSystemLanguages?: readonly unknown[]
  /** Electron 系统区域设置。 */
  systemLocale?: unknown
  /** Electron 应用区域设置。 */
  appLocale?: unknown
  /** 进程环境变量。 */
  env?: Record<string, string | undefined>
}

/** 主进程界面语言运行时配置。 */
export interface MainI18nRuntimeOptions {
  /** 读取当前持久化设置中的界面语言偏好。 */
  getUiLocale(): UiLocale
  /** 解析系统语言所需的候选来源。 */
  localeSources?: MainI18nLocaleSources
  /** 语言变化后的同步回调，用于重建菜单和窗口标题。 */
  onLocaleChanged?(locale: Locale): void
}

/** 主进程界面语言运行时。 */
export interface MainI18nRuntime {
  /** 当前生效的界面语言。 */
  readonly locale: Locale
  /** 当前语言翻译器。 */
  readonly translator: Translator
  /** 根据当前设置重新解析语言；变化时触发同步回调。 */
  refresh(): Locale
  /** 注册语言变化监听，返回取消订阅方法。 */
  onChange(listener: (locale: Locale) => void): () => void
}

/**
 * 创建主进程界面语言运行时。
 * @param options 设置读取、系统语言来源和变化回调。
 * @returns 可刷新并监听语言变化的主进程运行时。
 * @author zhenghq
 */
export function createMainI18nRuntime(options: MainI18nRuntimeOptions): MainI18nRuntime {
  const listeners = new Set<(locale: Locale) => void>()
  let locale = resolveLocale(
    options.getUiLocale(),
    collectLocaleCandidates(options.localeSources)
  )
  let translator = createTranslator(locale)
  setMainMessageTranslator(translator)

  /**
   * 广播当前界面语言变化。
   * @param nextLocale 新的界面语言。
   * @returns 无返回值。
   * @author zhenghq
   */
  function notify(nextLocale: Locale): void {
    options.onLocaleChanged?.(nextLocale)
    for (const listener of listeners) listener(nextLocale)
  }

  return {
    get locale() {
      return locale
    },
    get translator() {
      return translator
    },
    refresh() {
      const nextLocale = resolveLocale(
        options.getUiLocale(),
        collectLocaleCandidates(options.localeSources)
      )
      if (nextLocale === locale) return locale
      locale = nextLocale
      translator = createTranslator(locale)
      setMainMessageTranslator(translator)
      notify(locale)
      return locale
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/**
 * 汇总 Electron 与进程环境提供的语言候选。
 * @param sources 系统语言来源。
 * @returns 按优先级排列的语言候选。
 * @author zhenghq
 */
export function collectLocaleCandidates(
  sources: MainI18nLocaleSources = {}
): unknown[] {
  const env = sources.env ?? {}
  return [
    ...(sources.preferredSystemLanguages ?? []),
    sources.systemLocale,
    sources.appLocale,
    env.LANG,
    env.LC_ALL,
    env.LC_MESSAGES
  ]
}

/**
 * 按当前主进程环境直接检测界面语言。
 * @param sources 系统语言来源。
 * @returns 检测到的受支持语言。
 * @author zhenghq
 */
export function detectMainLocale(sources: MainI18nLocaleSources = {}): Locale {
  return detectSystemLocale({
    preferredSystemLanguages: sources.preferredSystemLanguages,
    systemLocale: sources.systemLocale,
    appLocale: sources.appLocale,
    env: sources.env
  })
}
