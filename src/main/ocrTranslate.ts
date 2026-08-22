import { cleanOcrText } from '../shared/ocrText'
import { scoreOcrText, isMostlyNoise } from '../shared/ocrScoring'
import { resolveLanguagePair } from '../shared/selectionBehavior'
import type { OcrRecognizeResult } from '../shared/ocrEngine'
import type { TranslateOutput } from './translate'
import type { Settings } from '../shared/types'
import type { DingTalkCredentials } from './dingtalkConfig'

/** OCR 翻译结果：合并翻译输出与 OCR 元信息。 */
export interface OcrTranslateResult {
  /** 翻译结果文本；噪声/空时为空字符串。 */
  translation?: string
  /** 检测到的语言。 */
  detectedLang?: string
  /** 实际使用的翻译通道。 */
  provider?: string
  /** 实际使用的翻译子通道。 */
  channel?: string
  /** 清洗后的 OCR 原文；噪声/空时仍返回清洗结果。 */
  ocrText: string
  /** OCR 引擎返回的原始文本，用于弹窗展示和排查识别质量。 */
  ocrRawText: string
  /** OCR 文本质量分。 */
  ocrScore: number
  /** 实际产出 OCR 结果的引擎。 */
  ocrEngine: OcrRecognizeResult['engine']
  /**
   * OCR/翻译的细分错误分类：
   * - 'empty'：未识别到文字
   * - 'noise'：识别为噪声，未进入翻译
   * - 'cancelled'：请求已取消
   * 无错误时为 undefined。
   */
  ocrCode?: 'empty' | 'noise' | 'cancelled'
  /** 翻译失败时的错误描述。 */
  error?: string
}

/** OCR 翻译管道可注入依赖（仅需 translate 函数，便于测试）。 */
export interface OcrTranslateDeps {
  /**
   * 翻译函数，复用现有 TranslationRuntime。
   * @param text 待翻译文本。
   * @param settings 当前设置快照。
   * @param dingTalkCredentials 钉钉凭证（可选）。
   * @param aiApiKey AI 密钥（可选）。
   * @returns 翻译结果。
   */
  translate(
    text: string,
    settings?: Settings,
    dingTalkCredentials?: DingTalkCredentials | null,
    aiApiKey?: string | null
  ): Promise<TranslateOutput>
  /** 取消信号（可选）。 */
  signal?: AbortSignal
}

/**
 * OCR 翻译管道：将 OCR 识别结果清洗、质量评分后接入 TranslationRuntime 翻译管道。
 * 噪声或空文本不进入翻译，直接返回含错误码的结果对象（不 throw）。
 * 翻译失败时也返回含 error 字段的结果对象。
 * @param ocrResult OCR 识别结果。
 * @param settings 当前设置快照。
 * @param deps 可注入依赖（translate 函数）。
 * @returns OCR 翻译结果对象。
 * @author zhenghq
 */
export async function translateOcrResult(
  ocrResult: OcrRecognizeResult,
  settings: Settings,
  deps: OcrTranslateDeps
): Promise<OcrTranslateResult> {
  // 清洗 OCR 原文
  const cleaned = cleanOcrText(ocrResult.text ?? '')
  const score = scoreOcrText(cleaned)
  const base = {
    ocrText: cleaned,
    ocrRawText: ocrResult.text ?? '',
    ocrScore: score,
    ocrEngine: ocrResult.engine
  }

  // 空结果
  if (!cleaned) {
    return { ...base, ocrCode: 'empty' }
  }

  // 噪声检测
  if (isMostlyNoise(cleaned)) {
    return { ...base, ocrCode: 'noise' }
  }

  // 检查取消
  if (deps.signal?.aborted) {
    return { ...base, ocrCode: 'cancelled' }
  }

  // 接入 TranslationRuntime
  try {
    const pair = resolveLanguagePair(cleaned, settings.sourceLang, settings.targetLang)
    const requestSettings = {
      ...settings,
      sourceLang: pair.sourceLang,
      targetLang: pair.targetLang
    }
    const translateResult = await deps.translate(cleaned, requestSettings, null, null)
    return {
      ...base,
      translation: translateResult.translation,
      detectedLang: translateResult.detectedLang,
      provider: translateResult.provider,
      channel: translateResult.channel
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, error: message }
  }
}
