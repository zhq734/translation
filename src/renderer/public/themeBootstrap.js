// 主题预应用脚本：必须以经典脚本（非 module）在 <head> 中同步执行，
// 这样主题属性会在首次样式计算前写入根节点，避免窗口先渲染默认主题再切换。
// 该文件不能使用 ES 模块语法，键名与白名单需与 src/renderer/src/theme.ts 保持一致。
;(function applyCachedThemeBeforeFirstPaint() {
  var CACHE_KEY = 'selection-translator.theme'
  var PRESETS = ['sakura', 'emerald', 'sky', 'navy', 'platinum-black']
  var MODES = ['system', 'light', 'dark']
  try {
    var raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return
    var parsed = JSON.parse(raw)
    if (PRESETS.indexOf(parsed.themePreset) < 0) return
    if (MODES.indexOf(parsed.themeMode) < 0) return
    var mode = parsed.themeMode
    if (mode === 'system') {
      mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    var root = document.documentElement
    root.setAttribute('data-theme', parsed.themePreset)
    root.setAttribute('data-theme-mode', mode)
  } catch (_) {
    // 缓存不可用或内容损坏时保留共享样式默认值，正式设置仍会异步应用。
  }
})()
