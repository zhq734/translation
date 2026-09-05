// 截图动作提示窗口：独立小窗口渲染，与截图覆盖层生命周期完全解耦。

import { startThemeRuntime } from './theme'

startThemeRuntime(window.api)

const toastElement = document.getElementById('toast') as HTMLElement

/**
 * 展示一条截图动作提示：设置文本后通过主进程完成尺寸测量与窗口居中显示。
 * @param message 提示文本。
 * @param displayTimeMs 主进程安排的停留时长（毫秒）。
 * @returns 无返回值。
 * @author zhenghq
 */
function showToast(message: string, displayTimeMs: number): void {
  toastElement.textContent = message
  // 先测量内容尺寸，让主进程据此调整窗口大小并居中到当前屏幕。
  const rect = toastElement.getBoundingClientRect()
  window.api.showScreenshotToastWindow({
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
    displayTimeMs
  })
  // 强制重排后加 visible 类触发淡入动画。
  toastElement.classList.remove('visible')
  void toastElement.offsetWidth
  toastElement.classList.add('visible')
}

window.api.onShowScreenshotToast((payload) => {
  showToast(payload.message, payload.displayTimeMs)
})
