/**
 * 在首屏主题样式应用前标记 Windows 7 兼容外观。
 *
 * Win7 与 Electron 22 的透明窗口合成不稳定，透明圆角和阴影可能形成黑色边缘。
 * 根节点标记必须尽早写入，让 CSS 在首次绘制时直接使用不透明平面外观。
 * @returns 无返回值。
 * @author zhenghq
 */
export function applyWin7CompatibilityAttribute(): void {
  let enabled = false
  try {
    enabled = window.getSelectionTranslatorWin7Compatibility?.() === true
  } catch {
    enabled = false
  }
  const root = document.documentElement
  if (enabled) {
    root.setAttribute('data-win7-compatibility', 'true')
  } else {
    root.removeAttribute('data-win7-compatibility')
  }
}
