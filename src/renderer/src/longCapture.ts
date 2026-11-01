import type {
  ScreenshotLongCaptureActionResult,
  ScreenshotLongCapturePreview,
  ScreenshotLongCaptureState
} from '../../shared/types'
import { startLocaleRuntime } from './locale'
import { applyWin7CompatibilityAttribute } from './runtimeCompatibility'
import { startThemeRuntime } from './theme'

applyWin7CompatibilityAttribute()
startThemeRuntime(window.api)
const localeRuntime = startLocaleRuntime(window.api)

const sampling = document.getElementById('long-capture-sampling') as HTMLElement
const frames = document.getElementById('long-capture-frames') as HTMLElement
const height = document.getElementById('long-capture-height') as HTMLElement
const offset = document.getElementById('long-capture-offset') as HTMLElement
const status = document.getElementById('long-capture-status') as HTMLElement
const sampleButton = document.getElementById('long-capture-sample') as HTMLButtonElement
const undoButton = document.getElementById('long-capture-undo') as HTMLButtonElement
const cancelButton = document.getElementById('long-capture-cancel') as HTMLButtonElement
const saveButton = document.getElementById('long-capture-save') as HTMLButtonElement
const copyButton = document.getElementById('long-capture-copy') as HTMLButtonElement

let currentSessionId: number | null = null
let latestState: ScreenshotLongCaptureState | null = null
let actionPending = false

/**
 * 使用当前界面语言翻译词条。
 * @param key 语义化词条 key。
 * @returns 当前语言下的文本。
 * @author zhenghq
 */
function t(key: string): string {
  return localeRuntime.translator.t(key)
}

/**
 * 根据状态同步按钮与统计信息。
 * @param state 主进程下发的长截图状态。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderState(state: ScreenshotLongCaptureState): void {
  currentSessionId = state.sessionId
  latestState = state
  frames.textContent = String(state.frameCount)
  height.textContent = `${state.height} px`
  offset.textContent = `${state.offset > 0 ? '+' : ''}${state.offset} px`
  sampling.textContent = state.sampling
    ? t('screenshot.longCapture.sampling')
    : t('screenshot.longCapture.waiting')
  sampling.dataset.busy = String(state.sampling)
  status.textContent = state.error ?? (state.truncated ? t('screenshot.longCapture.truncated') : '')
  status.dataset.kind = state.error ? 'error' : state.truncated ? 'warning' : 'neutral'
  sampleButton.disabled = actionPending || state.sampling
  undoButton.disabled = actionPending || !state.canUndo
  saveButton.disabled = actionPending || state.height <= 0
  copyButton.disabled = actionPending || state.height <= 0
  cancelButton.disabled = actionPending
}

/**
 * 更新实时预览并保持图片比例。
 * @param payload 主进程下发的预览负载。
 * @returns 无返回值。
 * @author zhenghq
 */
function renderPreview(payload: ScreenshotLongCapturePreview): void {
  if (currentSessionId !== null && payload.sessionId !== currentSessionId) return
}

/**
 * 显示完成动作失败信息并恢复按钮。
 * @param result 完成动作结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function handleActionResult(result: ScreenshotLongCaptureActionResult): void {
  if (currentSessionId !== null && result.sessionId !== currentSessionId) return
  actionPending = false
  if (!result.ok) status.textContent = result.error ?? t('screenshot.longCapture.finishFailed')
  status.dataset.kind = result.ok ? 'neutral' : 'error'
  if (latestState) renderState(latestState)
}

/**
 * 立即采集一帧。
 * @returns 无返回值。
 * @author zhenghq
 */
function sample(): void {
  if (currentSessionId === null || sampleButton.disabled) return
  window.api.sampleScreenshotLongCapture(currentSessionId)
}

/**
 * 撤销最近一次有效拼接。
 * @returns 无返回值。
 * @author zhenghq
 */
function undo(): void {
  if (currentSessionId === null || undoButton.disabled) return
  window.api.undoScreenshotLongCapture(currentSessionId)
}

/**
 * 提交复制或保存动作。
 * @param action 完成动作。
 * @returns 无返回值。
 * @author zhenghq
 */
function finish(action: 'copy' | 'save'): void {
  if (currentSessionId === null || actionPending) return
  actionPending = true
  if (latestState) renderState(latestState)
  window.api.finishScreenshotLongCapture(currentSessionId, action)
}

/**
 * 取消当前长截图会话。
 * @returns 无返回值。
 * @author zhenghq
 */
function cancel(): void {
  if (currentSessionId === null || actionPending) return
  actionPending = true
  window.api.cancelScreenshotLongCapture(currentSessionId)
}

sampleButton.addEventListener('click', sample)
undoButton.addEventListener('click', undo)
copyButton.addEventListener('click', () => finish('copy'))
saveButton.addEventListener('click', () => finish('save'))
cancelButton.addEventListener('click', cancel)
window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    finish('copy')
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    undo()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
})
window.api.onScreenshotLongCaptureState(renderState)
window.api.onScreenshotLongCapturePreview(renderPreview)
window.api.onScreenshotLongCaptureAction(handleActionResult)
localeRuntime.onLocaleChanged(() => {
  if (latestState) renderState(latestState)
})
