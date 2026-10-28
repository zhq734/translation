import type { Api } from '../../shared/types'
import type { Locale } from '../../shared/i18n/locale'

declare global {
  interface Window {
    api: Api
    /** preload 暴露的当前主进程界面语言同步读取函数。 */
    getSelectionTranslatorLocale?: () => Locale
    /** 兼容首屏脚本的静态语言注入回退值。 */
    selectionTranslatorLocale?: Locale
  }
}

export {}
