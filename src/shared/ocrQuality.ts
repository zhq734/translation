import type { OcrRecognizeResult } from './ocrEngine'
import { isMostlyNoise, scoreOcrText } from './ocrScoring'

/** 允许 OCR 结果被安全接受的最低平均置信度。 */
export const RELIABLE_OCR_CONFIDENCE_THRESHOLD = 0.6
/** 中文优先场景判定纯拉丁结果不匹配所需的最少拉丁字母数。 */
const LANGUAGE_MISMATCH_MIN_LATIN_COUNT = 6
/** OCR 文本通过安全接受门控所需的最低质量分。 */
const SAFE_OCR_TEXT_SCORE = 5

/** 统一 OCR 结果质量摘要。 */
export interface OcrQualityEvaluation {
  /** 结果是否包含有效且非噪声的文本。 */
  valid: boolean
  /** 结果是否与目标语言明显不匹配。 */
  languageMismatch: boolean
  /** 有效逐行置信度的平均值；引擎未提供时为空。 */
  averageConfidence?: number
  /** OCR 文本质量分。 */
  textScore: number
  /** 结果是否可直接安全接受。 */
  safeToAccept: boolean
}

/**
 * 判断输入语言是否属于显式中文优先场景。
 * auto 表示自动检测，不预设目标语言，因此不参与语言不匹配惩罚；
 * 只有显式选择中文或中文地区变体时才按中文优先校验结果。
 * @param language OCR 输入语言；缺失时按 auto 处理。
 * @returns 显式中文或中文地区变体返回 true，auto 返回 false。
 * @author zhenghq
 */
function isChinesePreferredLanguage(language?: string): boolean {
  const normalized = language?.trim().toLowerCase()
  if (!normalized) return false
  return normalized === 'zh' || normalized.startsWith('zh-')
}

/**
 * 判断结果文本是否与中文优先输入明显不匹配。
 * @param text OCR 结果文本。
 * @param language OCR 输入语言。
 * @returns 中文优先输入得到足量纯拉丁文本时返回 true。
 * @author zhenghq
 */
function hasOcrLanguageMismatch(text: string, language?: string): boolean {
  if (!isChinesePreferredLanguage(language)) return false
  if (/\p{Script=Han}/u.test(text)) return false
  const latinCount = (text.match(/[A-Za-z]/g) || []).length
  return latinCount >= LANGUAGE_MISMATCH_MIN_LATIN_COUNT
}

/**
 * 计算 OCR 结果中有效行置信度的平均值。
 * @param result OCR 识别结果。
 * @returns 0～1 范围置信度的平均值；没有有效值时返回 undefined。
 * @author zhenghq
 */
function getAverageOcrConfidence(result: OcrRecognizeResult): number | undefined {
  const confidenceValues = result.lines
    .filter((line) => Boolean(line.text?.trim()))
    .map((line) => line.confidence)
    .filter(
      (confidence): confidence is number =>
        typeof confidence === 'number' &&
        Number.isFinite(confidence) &&
        confidence >= 0 &&
        confidence <= 1
    )
  if (confidenceValues.length === 0) return undefined
  return confidenceValues.reduce((sum, confidence) => sum + confidence, 0) /
    confidenceValues.length
}

/**
 * 判断 OCR 结果是否为有效非空文本，并排除噪声与非正质量分结果。
 * @param result OCR 识别结果。
 * @returns 结果是否有效。
 * @author zhenghq
 */
export function isOcrResultValid(result: OcrRecognizeResult): boolean {
  if (!result.text || !result.text.trim()) return false
  if (isMostlyNoise(result.text)) return false
  return scoreOcrText(result.text) > 0
}

/**
 * 生成可复用于引擎调度和图片回退的 OCR 质量摘要。
 * @param result OCR 识别结果。
 * @param language OCR 输入语言。
 * @returns 确定性的质量评价摘要。
 * @author zhenghq
 */
export function evaluateOcrQuality(
  result: OcrRecognizeResult,
  language?: string
): OcrQualityEvaluation {
  const valid = isOcrResultValid(result)
  const textScore = scoreOcrText(result.text ?? '')
  const languageMismatch = hasOcrLanguageMismatch(result.text ?? '', language)
  const averageConfidence = getAverageOcrConfidence(result)
  const safeToAccept = valid &&
    !languageMismatch &&
    textScore >= SAFE_OCR_TEXT_SCORE &&
    (averageConfidence === undefined || averageConfidence >= RELIABLE_OCR_CONFIDENCE_THRESHOLD)
  return { valid, languageMismatch, averageConfidence, textScore, safeToAccept }
}

/**
 * 判断 OCR 结果是否满足统一安全接受门控。
 * @param result OCR 识别结果。
 * @param language OCR 输入语言。
 * @returns 是否可直接安全接受并停止后续尝试。
 * @author zhenghq
 */
export function canSafelyAcceptOcrResult(
  result: OcrRecognizeResult,
  language?: string
): boolean {
  return evaluateOcrQuality(result, language).safeToAccept
}

/**
 * 严格比较两个 OCR 质量摘要，正数表示候选更优、负数表示更差、零表示平局。
 * 排序依次考虑有效性、语言匹配、双方均可用的置信度和文本质量分。
 * @param candidate 待比较的候选质量。
 * @param baseline 当前基线质量。
 * @returns 1、-1 或 0；无法证明候选更优时不会返回正数。
 * @author zhenghq
 */
export function compareOcrQuality(
  candidate: OcrQualityEvaluation,
  baseline: OcrQualityEvaluation
): number {
  if (candidate.valid !== baseline.valid) return candidate.valid ? 1 : -1
  if (candidate.languageMismatch !== baseline.languageMismatch) {
    return candidate.languageMismatch ? -1 : 1
  }
  if (
    candidate.averageConfidence !== undefined &&
    baseline.averageConfidence !== undefined &&
    candidate.averageConfidence !== baseline.averageConfidence
  ) {
    return candidate.averageConfidence > baseline.averageConfidence ? 1 : -1
  }
  if (candidate.textScore === baseline.textScore) return 0
  return candidate.textScore > baseline.textScore ? 1 : -1
}
