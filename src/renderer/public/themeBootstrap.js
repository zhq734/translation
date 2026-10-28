// 主题预应用脚本：必须以经典脚本（非 module）在 <head> 中同步执行，
// 这样主题属性会在首次样式计算前写入根节点，避免窗口先渲染默认主题再切换。
// 该文件不能使用 ES 模块语法，键名与白名单需与 src/renderer/src/theme.ts 保持一致。
;(function applyCachedThemeBeforeFirstPaint() {
  var root = document.documentElement
  try {
    // preload 在页面脚本前同步读取主进程运行时；首帧前标记可避免 Win7 先合成透明窗口再切换。
    var win7Compatibility = typeof window.getSelectionTranslatorWin7Compatibility === 'function'
      ? window.getSelectionTranslatorWin7Compatibility() === true
      : false
    if (win7Compatibility) {
      root.setAttribute('data-win7-compatibility', 'true')
    } else {
      root.removeAttribute('data-win7-compatibility')
    }
  } catch (_) {
    // 同步通道不可用时保持现代系统外观，模块入口仍会做一次幂等兜底。
  }
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
    root.setAttribute('data-theme', parsed.themePreset)
    root.setAttribute('data-theme-mode', mode)
  } catch (_) {
    // 缓存不可用或内容损坏时保留共享样式默认值，正式设置仍会异步应用。
  }
})()
