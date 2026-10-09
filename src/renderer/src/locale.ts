import type { Api, Settings } from '../../shared/types'
import {
  DEFAULT_LOCALE,
  createTranslator,
  normalizeLocaleTag,
  type Locale,
  type Translator
} from '../../shared/i18n'

const LOCALE_CACHE_KEY = 'selection-translator.locale'
const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en-US']

/** Renderer 本地化运行时所需的设置 API。 */
type LocaleApi = Pick<Api, 'getSettings' | 'onSettingsChanged'>

/** Renderer 本地化运行时。 */
export interface LocaleRuntime {
  /** 当前生效的界面语言。 */
  readonly locale: Locale
  /** 当前语言的翻译器。 */
  readonly translator: Translator
  /** 手动切换到指定语言并立即应用到当前文档。 */
  setLocale(locale: Locale): void
  /** 注册语言变化监听，返回取消订阅方法。 */
  onLocaleChanged(listener: (locale: Locale) => void): () => void
  /** 停止运行时并释放设置监听。 */
  dispose(): void
}

/** 判断未知值是否为受支持的 Renderer 界面语言。
 * @param value 待判断的未知值。
 * @returns 是否为受支持的界面语言。
 * @author zhenghq
 */
function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value as Locale)
}

/** 从 preload 同步读取主进程当前已解析语言。
 * @returns 受支持的当前语言；同步通道不可用时返回 null。
 * @author zhenghq
 */
function readInjectedLocale(): Locale | null {
  try {
    if (typeof window.getSelectionTranslatorLocale === 'function') {
      const current = window.getSelectionTranslatorLocale()
      if (isSupportedLocale(current)) return current
    }
    return isSupportedLocale(window.selectionTranslatorLocale)
      ? window.selectionTranslatorLocale
      : null
  } catch {
    return null
  }
}

/** 从 localStorage 读取最近一次合法界面语言。
 * @returns 合法语言，缓存缺失或损坏时返回 null。
 * @author zhenghq
 */
function readCachedLocale(): Locale | null {
  try {
    const injected = readInjectedLocale()
    if (injected) return injected
    const cached = window.localStorage.getItem(LOCALE_CACHE_KEY)
    return isSupportedLocale(cached) ? cached : null
  } catch {
    return null
  }
}

/** 缓存最近一次合法界面语言。
 * @param locale 当前界面语言。
 * @returns 无返回值。
 * @author zhenghq
 */
function cacheLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_CACHE_KEY, locale)
  } catch {
    // 隐私模式或受限环境可能禁止 localStorage，不影响当前窗口的即时切换。
  }
}

/** 解析设置中的最终界面语言，显式选择优先于系统候选。
 * @param settings 当前设置。
 * @returns 当前窗口应使用的界面语言。
 * @author zhenghq
 */
function resolveRendererLocale(settings: Pick<Settings, 'uiLocale'>): Locale {
  if (settings.uiLocale === 'zh-CN' || settings.uiLocale === 'en-US') return settings.uiLocale
  // auto 必须复用主进程按 Electron 系统语言解析的结果，避免 Renderer navigator 与其不一致导致二次切换。
  const injected = readInjectedLocale()
  if (injected) return injected
  const candidates = [
    ...(Array.isArray(window.navigator.languages) ? window.navigator.languages : []),
    window.navigator.language
  ]
  for (const candidate of candidates) {
    const locale = normalizeLocaleTag(candidate)
    if (locale) return locale
  }
  return DEFAULT_LOCALE
}

/** 把语言同步到根节点，供 CSS、辅助技术和测试读取。
 * @param locale 当前界面语言。
 * @returns 无返回值。
 * @author zhenghq
 */
function applyDocumentLocale(locale: Locale): void {
  const root = document.documentElement
  root.lang = locale
  root.setAttribute('data-locale', locale)
}

/** 解析 data-i18n-attr 中声明的属性映射。
 * @param declaration 形如 title:key;aria-label:key 的声明。
 * @returns 属性名到词条 key 的映射。
 * @author zhenghq
 */
function parseAttributeTranslations(declaration: string): Array<[string, string]> {
  return declaration
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':')
      if (separator < 1) return null
      return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()] as [string, string]
    })
    .filter((entry): entry is [string, string] => entry !== null && Boolean(entry[0]) && Boolean(entry[1]))
}

/** 把静态 HTML 中的 data-i18n 与 data-i18n-attr 标记翻译为当前语言。
 * @param root 要翻译的文档或元素。
 * @param translator 当前语言翻译器。
 * @returns 无返回值。
 * @author zhenghq
 */
export function applyStaticTranslations(root: ParentNode, translator: Translator): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset.i18n
    if (key) element.textContent = translator.t(key)
  }

  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    const declaration = element.dataset.i18nAttr
    if (!declaration) continue
    for (const [attribute, key] of parseAttributeTranslations(declaration)) {
      element.setAttribute(attribute, translator.t(key))
    }
  }
}

/** 翻译指定文档中的静态标记。
 * @param document 当前 Renderer 文档。
 * @param translator 当前语言翻译器。
 * @returns 无返回值。
 * @author zhenghq
 */
export function translateDocument(document: Document, translator: Translator): void {
  applyStaticTranslations(document, translator)
  document.documentElement.removeAttribute('data-i18n-pending')
}

/** 启动 Renderer 本地化运行时，负责缓存预应用、主进程校正和设置变更监听。
 * @param api 当前窗口可用的设置 API。
 * @returns 可手动设置语言、监听变化并释放资源的运行时。
 * @author zhenghq
 */
export function startLocaleRuntime(api: LocaleApi): LocaleRuntime {
  const listeners = new Set<(locale: Locale) => void>()
  let locale = readCachedLocale() ?? DEFAULT_LOCALE
  let translator = createTranslator(locale)

  const notify = (nextLocale: Locale): void => {
    locale = nextLocale
    translator = createTranslator(nextLocale)
    applyDocumentLocale(nextLocale)
    cacheLocale(nextLocale)
    translateDocument(document, translator)
    document.dispatchEvent(new CustomEvent<Locale>('locale:changed', { detail: nextLocale }))
    for (const listener of listeners) listener(nextLocale)
  }

  // 首屏先按同步注入或缓存预翻译静态文案，但保留 data-i18n-pending 隐藏标记。
  // 只有拿到主进程设置（权威来源）或设置变更广播后，才释放隐藏标记，避免先显示英文再切中文。
  applyDocumentLocale(locale)
  translator = createTranslator(locale)
  applyStaticTranslations(document, translator)

  const confirmLocale = (nextLocale: Locale): void => {
    if (nextLocale !== locale) {
      notify(nextLocale)
      return
    }
    // 语言未变化时也必须释放首屏隐藏标记，让页面在权威设置确认后显示。
    translateDocument(document, translator)
  }

  const unsubscribeSettings = api.onSettingsChanged((settings) => {
    confirmLocale(resolveRendererLocale(settings))
  })

  void api.getSettings().then((settings) => {
    confirmLocale(resolveRendererLocale(settings))
  }).catch(() => {
    // 主进程设置暂不可用时保留首屏缓存语言或英文兜底，并释放隐藏标记避免页面永久不可见。
    translateDocument(document, translator)
  })

  return {
    get locale() {
      return locale
    },
    get translator() {
      return translator
    },
    setLocale(nextLocale) {
      if (nextLocale !== locale) notify(nextLocale)
    },
    onLocaleChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      unsubscribeSettings()
      listeners.clear()
    }
  }
}
