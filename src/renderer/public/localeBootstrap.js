// 界面语言预应用脚本：必须以经典脚本（非 module）在 <head> 中同步执行，
// 这样首屏样式计算和 DOM 渲染前就能得到正确语言，避免先显示英文再切换。
// 该文件不能使用 ES 模块语法，缓存键与白名单需和 src/renderer/src/locale.ts 保持一致。
;(function applyCachedLocaleBeforeFirstPaint() {
  var CACHE_KEY = 'selection-translator.locale'
  var SUPPORTED_LOCALES = ['zh-CN', 'en-US']
  var DEFAULT_LOCALE = 'en-US'
  var root = document.documentElement
  var locale = DEFAULT_LOCALE

  try {
    // preload 在页面脚本执行前同步取得主进程已解析语言；首次启动没有缓存时也能首帧正确。
    var injected = typeof window.getSelectionTranslatorLocale === 'function'
      ? window.getSelectionTranslatorLocale()
      : window.selectionTranslatorLocale
    if (SUPPORTED_LOCALES.indexOf(injected) >= 0) {
      locale = injected
    } else {
      var cached = window.localStorage.getItem(CACHE_KEY)
      if (SUPPORTED_LOCALES.indexOf(cached) >= 0) locale = cached
    }
  } catch (_) {
    // 缓存不可用或内容损坏时保持 HTML 中的英文兜底，正式设置仍会异步校正。
  }

  document.documentElement.lang = locale
  root.setAttribute('data-locale', locale)
  // 静态 HTML 是英文兜底：仅当目标语言不是英文时先隐藏，等模块脚本完成翻译再显示，
  // 避免首次启动在中文环境下先绘制英文再替换成中文，也不让英文环境无谓白屏。
  if (locale !== DEFAULT_LOCALE) {
    root.setAttribute('data-i18n-pending', 'true')
    // 模块脚本异常时也要恢复可见，避免页面永久停留在隐藏状态。
    window.setTimeout(function releaseLocalePendingFallback() {
      root.removeAttribute('data-i18n-pending')
    }, 1200)
  }
})()
