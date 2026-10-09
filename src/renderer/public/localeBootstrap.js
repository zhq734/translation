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
  // 静态 HTML 是英文兜底，但首屏语言必须由 locale runtime 依据主进程设置确认后再显示。
  // 同步注入可能只是主进程尚未就绪时的英文兜底，若此时直接放行，会先绘制英文再切换成中文。
  root.setAttribute('data-i18n-pending', 'true')
  // 模块脚本异常时也要恢复可见，避免页面永久停留在隐藏状态。
  // 冷启动首次加载模块脚本可能明显超过 1 秒，兜底时间必须足够长，
  // 否则会在中文环境下先露出英文静态兜底，再切换成中文。
  var LOCALE_PENDING_FALLBACK_MS = 5000
  window.setTimeout(function releaseLocalePendingFallback() {
    root.removeAttribute('data-i18n-pending')
  }, LOCALE_PENDING_FALLBACK_MS)
})()
