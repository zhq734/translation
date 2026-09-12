import { OcrEngineError, type OcrRecognizeResult } from '../shared/ocrEngine'
import {
  canSafelyAcceptOcrResult,
  compareOcrQuality,
  evaluateOcrQuality,
  type OcrQualityEvaluation
} from '../shared/ocrQuality'
import {
  createAdaptiveOcrFallbackImageBytes,
  preprocessOcrBaselineImageBytes,
  type AdaptiveOcrFallbackStrategy
} from './ocrImagePreprocess'

/** 自适应 OCR 回退诊断事件。 */
export interface AdaptiveOcrDiagnostic {
  /** 诊断事件类型。 */
  event: 'fallback-triggered' | 'fallback-completed' | 'fallback-failed'
  /** 不包含识别正文的回退原因。 */
  reason: string
  /** 唯一备用图片处理策略。 */
  strategy?: AdaptiveOcrFallbackStrategy
  /** 用户配置的最大尝试倍率。 */
  requestedScale?: number
  /** 备用候选实际采用的倍率。 */
  actualScale?: number
  /** 基线结果质量摘要。 */
  baselineQuality?: OcrQualityEvaluation
  /** 备用结果质量摘要。 */
  fallbackQuality?: OcrQualityEvaluation
  /** 回退阶段耗时。 */
  elapsedMs?: number
  /** 最终选择的识别轮次。 */
  selected?: 'baseline' | 'fallback'
}

/** 自适应 OCR 请求参数。 */
export interface AdaptiveOcrOptions {
  /** 未经 OCR 预处理的原始图片字节。 */
  imageBytes: Uint8Array | Buffer
  /** 备用候选允许使用的最大倍率。 */
  maxScale: number
  /** OCR 目标语言。 */
  language?: string
}

/** 自适应 OCR 可注入依赖。 */
export interface AdaptiveOcrDeps {
  /** 使用现有 OCR 调度器识别一张已预处理图片。 */
  recognize: (imageBytes: Buffer) => Promise<OcrRecognizeResult>
  /** 生成固定 1× 基线图片。 */
  createBaseline?: typeof preprocessOcrBaselineImageBytes
  /** 从原图生成唯一备用图片。 */
  createFallback?: typeof createAdaptiveOcrFallbackImageBytes
  /** 接收无敏感内容的结构化诊断。 */
  logger?: (event: AdaptiveOcrDiagnostic) => void
  /** 提供当前时间，便于确定性测试。 */
  now?: () => number
}

/**
 * 输出不含图片和 OCR 正文的默认结构化诊断。
 * @param diagnostic 自适应回退诊断摘要。
 * @returns 无返回值。
 * @author zhenghq
 */
function logAdaptiveOcrDiagnostic(diagnostic: AdaptiveOcrDiagnostic): void {
  console.info('[ocr-adaptive]', diagnostic)
}

/**
 * 根据基线质量生成不含识别正文的回退原因。
 * @param quality 基线 OCR 质量摘要。
 * @returns 稳定的回退原因标识。
 * @author zhenghq
 */
function getFallbackReason(quality: OcrQualityEvaluation): string {
  if (!quality.valid) return 'invalid-baseline'
  if (quality.languageMismatch) return 'language-mismatch'
  if (quality.averageConfidence !== undefined && quality.averageConfidence < 0.6) {
    return 'low-confidence'
  }
  return 'low-text-quality'
}

/**
 * 判断错误是否要求保持既有超时或取消的立即传播语义。
 * @param error OCR 基线阶段抛出的错误。
 * @returns 是否为 OCR 超时或取消错误。
 * @author zhenghq
 */
function isOcrTimeout(error: unknown): boolean {
  return error instanceof OcrEngineError && error.code === 'timeout'
}

/**
 * 执行“固定 1× 基线优先、低质量时单次自适应回退”的 OCR 协调流程。
 * @param options 原图、最大尝试倍率及目标语言。
 * @param deps OCR 调度、图片生成、诊断和计时依赖。
 * @returns 基线与唯一备用候选中按统一质量评价择优的识别结果。
 * @throws 基线超时会立即传播；两轮均失败时传播基线原错误。
 * @author zhenghq
 */
export async function recognizeAdaptiveOcr(
  options: AdaptiveOcrOptions,
  deps: AdaptiveOcrDeps
): Promise<OcrRecognizeResult> {
  const createBaseline = deps.createBaseline ?? preprocessOcrBaselineImageBytes
  const createFallback = deps.createFallback ?? createAdaptiveOcrFallbackImageBytes
  const logger = deps.logger ?? logAdaptiveOcrDiagnostic
  const now = deps.now ?? Date.now
  let baseline: OcrRecognizeResult | undefined
  let baselineQuality: OcrQualityEvaluation | undefined
  let baselineError: unknown
  let fallbackImage: ReturnType<typeof createAdaptiveOcrFallbackImageBytes> | undefined

  try {
    baseline = await deps.recognize(createBaseline(options.imageBytes))
    baselineQuality = evaluateOcrQuality(baseline, options.language)
    if (canSafelyAcceptOcrResult(baseline, options.language)) return baseline
  } catch (error) {
    if (isOcrTimeout(error)) throw error
    baselineError = error
  }

  const reason = baselineQuality ? getFallbackReason(baselineQuality) : 'baseline-failed'
  logger({ event: 'fallback-triggered', reason, baselineQuality })
  const fallbackStartedAt = now()

  try {
    fallbackImage = createFallback(options.imageBytes, options.maxScale)
    const fallback = await deps.recognize(fallbackImage.imageBytes)
    const fallbackQuality = evaluateOcrQuality(fallback, options.language)
    const selected = baseline && baselineQuality
      ? compareOcrQuality(fallbackQuality, baselineQuality) > 0
        ? 'fallback'
        : 'baseline'
      : fallbackQuality.valid
        ? 'fallback'
        : undefined
    logger({
      event: 'fallback-completed',
      reason,
      strategy: fallbackImage.strategy,
      requestedScale: fallbackImage.requestedScale,
      actualScale: fallbackImage.actualScale,
      baselineQuality,
      fallbackQuality,
      elapsedMs: Math.max(0, now() - fallbackStartedAt),
      selected
    })
    if (selected === 'fallback') return fallback
    if (baseline) return baseline
  } catch (fallbackError) {
    logger({
      event: 'fallback-failed',
      reason,
      strategy: fallbackImage?.strategy,
      requestedScale: fallbackImage?.requestedScale,
      actualScale: fallbackImage?.actualScale,
      baselineQuality,
      elapsedMs: Math.max(0, now() - fallbackStartedAt),
      selected: baseline ? 'baseline' : undefined
    })
    if (baseline) return baseline
    throw baselineError ?? fallbackError
  }

  throw baselineError
}
