import { clipboard, ipcMain } from 'electron'
import { isPopupAutoSizeRequest } from '../../shared/popupAutoSize'
import type { PronunciationService } from '../pronunciationService'
import type { PronunciationRequestRegistry } from '../pronunciationRequests'

/** 弹窗、音标和设置页指针 IPC 注册依赖。 */
export interface PopupIpcDependencies {
  /** 隐藏弹窗。 */
  hidePopup(): void
  /** 调整弹窗尺寸。 */
  resizePopup(size: { width: number; height: number }): void
  /** 设置弹窗固定状态。 */
  setPopupPinned(pinned: boolean): void
  /** 判断 WebContents 是否属于弹窗。 */
  isPopupWebContents(sender: Electron.WebContents): boolean
  /** 设置语言选择交互状态。 */
  setPopupLanguageInteraction(active: boolean, scope: 'selector' | 'retranslation'): void
  /** 设置音标交互状态。 */
  setPronunciationInteraction(active: boolean): void
  /** 音标查询服务。 */
  pronunciationService: PronunciationService
  /** 可取消音标请求注册表。 */
  pronunciationRequests: PronunciationRequestRegistry
  /** 判断 IPC 是否来自设置页。 */
  isSettingsWindowSender(sender: Electron.WebContents): boolean
  /** 恢复设置窗口焦点。 */
  restoreSettingsWindowFocus(): void
  /** 释放设置窗口焦点保护。 */
  releaseSettingsWindowFocus(): void
  /** 释放选区焦点租约。 */
  releaseSelectionFocusLease(): void
  /** 从弹窗打开设置页。 */
  openSettings(): void
}

/**
 * 规范化 Renderer 传入的音标请求 ID，避免异常长值或非字符串进入注册表。
 * @param value 未信任请求 ID。
 * @returns 合法请求 ID；非法时返回空字符串。
 * @author zhenghq
 */
function normalizePronunciationRequestId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 128 ? normalized : ''
}

/**
 * 注册弹窗、音标查询与设置页指针 IPC。
 * @param dependencies 弹窗、音标、焦点恢复和设置页操作依赖。
 * @returns 无返回值。
 * @author zhenghq
 */
export function registerPopupIpc(dependencies: PopupIpcDependencies): void {
  ipcMain.on('popup:copy', (_event, text: unknown) => {
    clipboard.writeText(String(text ?? ''))
  })
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.on('popup:hide', () => dependencies.hidePopup())
  ipcMain.on('popup:resize', (_event, size: unknown) => {
    if (isPopupAutoSizeRequest(size)) dependencies.resizePopup(size)
  })
  ipcMain.on('popup:set-pinned', (_event, pinned: unknown) => {
    dependencies.setPopupPinned(Boolean(pinned))
  })
  ipcMain.on('popup:language-interaction', (event, active: unknown, scope: unknown) => {
    if (!dependencies.isPopupWebContents(event.sender)) return
    const normalizedScope = scope === 'retranslation' ? 'retranslation' : 'selector'
    dependencies.setPopupLanguageInteraction(active === true, normalizedScope)
  })
  /**
   * 查询单个英文单词的音标；主进程再次校验输入，避免 Renderer 绕过词形边界。
   * @param _event IPC 事件对象。
   * @param word Renderer 传入的待查询单词。
   * @param requestId Renderer 生成的请求 ID。
   * @returns 脱敏音标结果。
   * @author zhenghq
   */
  ipcMain.handle('pronunciation:lookup', (_event, word: unknown, requestId: unknown) => {
    const normalized = typeof word === 'string' ? word.trim() : ''
    if (!normalized || normalized.length > 64) {
      return {
        status: 'unsupported',
        word: normalized.slice(0, 64),
        language: 'en',
        variants: [],
        source: 'dictionaryapi'
      }
    }
    const normalizedRequestId = normalizePronunciationRequestId(requestId)
    if (!normalizedRequestId) return dependencies.pronunciationService.lookup(normalized)
    const controller = new AbortController()
    return dependencies.pronunciationRequests.run(
      normalizedRequestId,
      controller,
      dependencies.pronunciationService.lookup(normalized, controller.signal)
    )
  })
  /**
   * 下载当前已缓存音标变体的音频；变体 ID 必须由主进程查询结果生成。
   * @param _event IPC 事件对象。
   * @param word 当前查询词。
   * @param variantId 已登记的变体标识。
   * @param requestId Renderer 生成的请求 ID。
   * @returns 临时音频字节或脱敏错误。
   * @author zhenghq
   */
  ipcMain.handle(
    'pronunciation:audio',
    (_event, word: unknown, variantId: unknown, requestId: unknown) => {
      const normalizedWord = typeof word === 'string' ? word.trim() : ''
      const normalizedVariantId = typeof variantId === 'string' ? variantId.trim() : ''
      if (!normalizedWord || normalizedWord.length > 64 || !normalizedVariantId) {
        return { ok: false, error: 'Pronunciation audio is unavailable' }
      }
      const normalizedRequestId = normalizePronunciationRequestId(requestId)
      if (!normalizedRequestId) {
        return dependencies.pronunciationService.getAudio(normalizedWord, normalizedVariantId)
      }
      const controller = new AbortController()
      return dependencies.pronunciationRequests.run(
        normalizedRequestId,
        controller,
        dependencies.pronunciationService.getAudio(
          normalizedWord,
          normalizedVariantId,
          controller.signal
        )
      )
    }
  )
  ipcMain.on('pronunciation:cancel', (_event, requestId: unknown) => {
    const normalized = normalizePronunciationRequestId(requestId)
    if (normalized) dependencies.pronunciationRequests.cancel(normalized)
  })
  ipcMain.on('pronunciation:interaction', (_event, active: unknown) => {
    dependencies.setPronunciationInteraction(active === true)
  })
  ipcMain.on('settings:pointerdown', (event) => {
    // 只有设置页自己的 renderer 能证明事件确实送达设置窗口。全局钩子的矩形
    // 判定无法区分后台窗口重叠与真实点击，不能在该通道中恢复可聚焦性。
    if (!dependencies.isSettingsWindowSender(event.sender)) return
    dependencies.restoreSettingsWindowFocus()
    dependencies.releaseSettingsWindowFocus()
    dependencies.releaseSelectionFocusLease()
  })
  ipcMain.on('settings:open', () => dependencies.openSettings())
}
