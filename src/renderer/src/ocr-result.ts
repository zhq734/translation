import { startLocaleRuntime } from './locale'
import { applyWin7CompatibilityAttribute } from './runtimeCompatibility'
import { startThemeRuntime } from './theme'

applyWin7CompatibilityAttribute()
// 共用权威设置请求，确保主题和语言确认后才允许主进程显示首帧。@author zhenghq
const settingsReady = window.api.getSettings()
const settingsApi = { getSettings: () => settingsReady, onSettingsChanged: window.api.onSettingsChanged }
startThemeRuntime(settingsApi)
const localeRuntime = startLocaleRuntime(settingsApi)
const ocrPanelText = document.getElementById('ocr-panel-text') as HTMLTextAreaElement
const translationText = document.getElementById('ocr-panel-translation') as HTMLTextAreaElement
const status = document.getElementById('ocr-panel-status') as HTMLElement
const pinButton = document.getElementById('ocr-panel-pin') as HTMLButtonElement
const copyButton = document.getElementById('ocr-panel-copy') as HTMLButtonElement
const translateButton = document.getElementById('ocr-panel-translate') as HTMLButtonElement
const resizeHandle = document.getElementById('ocr-panel-resize') as HTMLElement
let pinned = true
let translationPending = false
let resizeDrag: { pointerId: number; screenX: number; screenY: number; width: number; height: number } | null = null

/** 从三角角标开始缩放，保存当前尺寸并捕获指针。@param event 按下事件。@returns 无返回值。@author zhenghq */
function startResize(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  resizeDrag = { pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY,
    width: window.innerWidth, height: window.innerHeight }
  resizeHandle.setPointerCapture(event.pointerId)
}

/** 按屏幕位移请求缩放，不修改窗口位置。@param event 指针移动事件。@returns 无返回值。@author zhenghq */
function moveResize(event: PointerEvent): void {
  const drag = resizeDrag
  if (!drag || event.pointerId !== drag.pointerId) return
  event.preventDefault()
  const width = Math.round(drag.width + event.screenX - drag.screenX)
  const height = Math.round(drag.height + event.screenY - drag.screenY)
  window.api.resizePinnedOcrPanel({ width: Math.max(320, width), height: Math.max(160, height) })
}

/** 结束或取消缩放，防止松开指针后继续改变尺寸。@param event 指针结束事件。@returns 无返回值。@author zhenghq */
function stopResize(event: PointerEvent): void {
  if (resizeDrag?.pointerId !== event.pointerId) return
  resizeDrag = null
  if (resizeHandle.hasPointerCapture(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId)
}

/** 同步图钉提示及无障碍状态；无参数和返回值。@author zhenghq */
function syncPinButton(): void {
  pinButton.setAttribute('aria-pressed', String(pinned))
  pinButton.title = localeRuntime.translator.t(pinned ? 'popup.unpinWindow' : 'popup.pin')
  pinButton.setAttribute('aria-label', pinButton.title)
}

/** 切换独立窗口置顶状态，不关闭结果；无参数和返回值。@author zhenghq */
function togglePin(): void {
  pinned = !pinned
  window.api.setPinnedOcrPanel(pinned)
  syncPinButton()
}

/** 复制完整 OCR 原文，保留换行空格；无参数和返回值。@author zhenghq */
function copyText(): void {
  if (!ocrPanelText.value.trim()) return
  window.api.copy(ocrPanelText.value)
  status.textContent = localeRuntime.translator.t('popup.copied')
}

/** 在独立窗口内翻译或切换译文，与截图会话无关；返回处理完成状态。@author zhenghq */
async function translateText(): Promise<void> {
  if (translationPending || !ocrPanelText.value.trim()) return
  if (!translationText.hidden) { translationText.hidden = true; return }
  if (translationText.value) { translationText.hidden = false; return }
  translationPending = true
  translateButton.disabled = true
  status.textContent = localeRuntime.translator.t('selection.loadingTranslating')
  try {
    translationText.value = await window.api.translatePinnedOcrText(ocrPanelText.value)
    translationText.hidden = false
    status.textContent = localeRuntime.translator.t('selection.translate')
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : localeRuntime.translator.t('selection.recognizeFailed')
  } finally {
    translationPending = false
    translateButton.disabled = false
  }
}

/** 读取窗口自身保存的结果并初始化，失败时显示错误；返回初始化完成状态。@author zhenghq */
async function initialize(): Promise<void> {
  copyButton.disabled = true
  translateButton.disabled = true
  try {
    const [payload] = await Promise.all([window.api.getPinnedOcrPanel(), settingsReady.catch(() => null)])
    if (!payload) return
    ocrPanelText.value = payload.text
    translationText.value = payload.translation
    translationText.hidden = !payload.translation
    status.textContent = payload.status
    copyButton.disabled = !payload.text.trim()
    translateButton.disabled = !payload.text.trim()
    // 等待内容和样式完成绘制，防止旧面板隐藏后显示空白或未本地化的新窗口。@author zhenghq
    requestAnimationFrame(() => requestAnimationFrame(() => window.api.notifyPinnedOcrPanelReady()))
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : localeRuntime.translator.t('selection.recognizeFailed')
  }
}

pinButton.addEventListener('click', togglePin)
resizeHandle.addEventListener('pointerdown', startResize)
resizeHandle.addEventListener('pointermove', moveResize)
resizeHandle.addEventListener('pointerup', stopResize)
resizeHandle.addEventListener('pointercancel', stopResize)
resizeHandle.addEventListener('lostpointercapture', stopResize)
copyButton.addEventListener('click', copyText)
translateButton.addEventListener('click', () => { void translateText() })
document.getElementById('ocr-panel-close')?.addEventListener('click', () => window.api.closePinnedOcrPanel())
localeRuntime.onLocaleChanged(syncPinButton)
syncPinButton()
void initialize()
