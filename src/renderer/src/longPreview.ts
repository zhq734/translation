import type { ScreenshotLongCapturePreview } from '../../shared/types'
import { startLocaleRuntime } from './locale'
import { applyWin7CompatibilityAttribute } from './runtimeCompatibility'
import { startThemeRuntime } from './theme'

applyWin7CompatibilityAttribute()
startThemeRuntime(window.api)
startLocaleRuntime(window.api)

const image = document.getElementById('long-preview-image') as HTMLImageElement
const empty = document.querySelector('.long-preview-empty') as HTMLElement

/**
 * 用主进程下发的压缩 PNG 更新独立预览窗。
 * @param preview 长截图实时预览负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderPreview(preview: ScreenshotLongCapturePreview): void {
  image.src = preview.dataUrl
  image.hidden = false
  empty.hidden = true
}

image.addEventListener('error', () => {
  image.hidden = true
  empty.hidden = false
})
window.api.onScreenshotLongCapturePreview(renderPreview)
