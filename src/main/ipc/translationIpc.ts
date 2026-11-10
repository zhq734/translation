import { ipcMain } from 'electron'
import type {
  EdgeSpeechResult,
  Settings,
  TranslationOrigin
} from '../../shared/types'
import type { TranslationHistoryController } from '../translationHistoryController'

/** 翻译文本时使用的展示与历史来源参数。 */
export interface TranslationTextOptions {
  /** 源语言偏好。 */
  sourceLang: string
  /** 目标语言偏好。 */
  targetLang: string
}

/** 翻译 IPC 注册依赖。 */
export interface TranslationIpcDependencies {
  /** 打开手动翻译弹窗。 */
  openManualTranslation(): void
  /** 校验并提交手动翻译请求。 */
  translateManualRequest(request: unknown): Promise<void>
  /** 取消尚未完成的 Edge 语音请求。 */
  cancelEdgeSpeech(requestId: string): void
  /** 请求 Edge 在线语音。 */
  synthesizeEdgeSpeech(
    requestId: string,
    text: string,
    language: string,
    ipa: string
  ): Promise<EdgeSpeechResult>
  /** 保存弹窗重新翻译时选择的语言偏好。 */
  applySettingsPatch(patch: Partial<Settings>): Promise<Settings>
  /** 返回最近一次 OCR 原文。 */
  getLastOcrText(): string
  /** 返回最近一次划词原文。 */
  getLastSelectedText(): string
  /** 返回最近一次 OCR 锚点。 */
  getLastOcrAnchor(): { x: number; y: number } | undefined
  /** 返回最近一次划词锚点。 */
  getLastSelectionAnchor(): { x: number; y: number } | undefined
  /** 翻译指定文本。 */
  translateText(
    text: string,
    anchor: { x: number; y: number } | undefined,
    preferences: TranslationTextOptions | undefined,
    origin: TranslationOrigin,
    interactionToken?: number,
    historyOrigin?: TranslationOrigin
  ): Promise<void>
  /** 统一翻译历史控制器。 */
  translationHistory: TranslationHistoryController
  /** 触发当前选区翻译按钮流程。 */
  translateSelectionButton(): void
}

/**
 * 注册手动翻译、语音、弹窗重译与统一翻译历史 IPC。
 * @param dependencies 翻译运行时、历史存储与弹窗状态依赖。
 * @returns 无返回值。
 * @author zhenghq
 */
export function registerTranslationIpc(dependencies: TranslationIpcDependencies): void {
  ipcMain.on('selection:translate', () => {
    void dependencies.translateSelectionButton()
  })
  ipcMain.on('manual-translate:open-request', () => dependencies.openManualTranslation())
  ipcMain.handle('manual-translate:submit', (_event, request: unknown) =>
    dependencies.translateManualRequest(request)
  )
  ipcMain.on('speech:edge-cancel', (_event, requestId: unknown) => {
    dependencies.cancelEdgeSpeech(String(requestId ?? ''))
  })
  ipcMain.handle('speech:edge-synthesize', (
    _event,
    requestId: unknown,
    text: unknown,
    language: unknown,
    ipa: unknown
  ) =>
    dependencies.synthesizeEdgeSpeech(
      String(requestId ?? ''),
      String(text ?? ''),
      String(language ?? ''),
      String(ipa ?? '')
    )
  )
  /**
   * 按弹窗中最新选择的语言重新翻译当前原文。
   * @param _event IPC 事件对象。
   * @param sourceLang 源语言偏好。
   * @param targetLang 目标语言偏好。
   * @param origin 翻译来源。
   * @returns 重新翻译完成后的 Promise。
   * @author zhenghq
   */
  ipcMain.handle('popup:retranslate', async (
    _event,
    sourceLang: string,
    targetLang: string,
    origin?: TranslationOrigin
  ) => {
    const sourcePreference = sourceLang || 'auto'
    const targetPreference = targetLang || 'auto'
    await dependencies.applySettingsPatch({
      sourceLang: sourcePreference,
      targetLang: targetPreference
    })
    const text = origin === 'ocr' ? dependencies.getLastOcrText() : dependencies.getLastSelectedText()
    const anchor = origin === 'ocr'
      ? dependencies.getLastOcrAnchor()
      : dependencies.getLastSelectionAnchor()
    if (!text) return
    await dependencies.translateText(text, anchor, {
      sourceLang: sourcePreference,
      targetLang: targetPreference
    }, origin === 'ocr' ? 'ocr' : 'selection')
  })

  /** 返回统一翻译历史，收藏项优先。 */
  ipcMain.handle('translation-history:list', () => dependencies.translationHistory.list())
  /** 设置指定历史记录的收藏状态并返回最新列表。 */
  ipcMain.handle('translation-history:set-favorite', async (_event, id: unknown, favorite: unknown) => {
    const normalizedId = typeof id === 'string' ? id.trim() : ''
    if (normalizedId) await dependencies.translationHistory.setFavorite(normalizedId, favorite === true)
    return dependencies.translationHistory.list()
  })
  /** 删除指定历史记录并返回最新列表。 */
  ipcMain.handle('translation-history:delete', async (_event, id: unknown) => {
    const normalizedId = typeof id === 'string' ? id.trim() : ''
    if (normalizedId) await dependencies.translationHistory.delete(normalizedId)
    return dependencies.translationHistory.list()
  })
  /** 清空所有非收藏历史并返回保留的收藏项。 */
  ipcMain.handle('translation-history:clear-unfavorited', async () => {
    await dependencies.translationHistory.clearNonFavorites()
    return dependencies.translationHistory.list()
  })
  /** 使用历史记录中的原文和语言重新翻译。 */
  ipcMain.handle('translation-history:retranslate', async (_event, id: unknown) => {
    const normalizedId = typeof id === 'string' ? id.trim() : ''
    if (!normalizedId) return
    const entry = await dependencies.translationHistory.find(normalizedId)
    if (!entry) return
    await dependencies.translateText(
      entry.sourceText,
      undefined,
      {
        sourceLang: entry.sourceLang,
        targetLang: entry.targetLang
      },
      entry.origin === 'manual' ? 'selection' : entry.origin,
      undefined,
      entry.origin
    )
  })
}
