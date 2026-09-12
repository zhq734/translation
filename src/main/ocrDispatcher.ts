import {
  OcrEngineError,
  type OcrEngine,
  type OcrRecognizeInput,
  type OcrRecognizeResult
} from '../shared/ocrEngine'
import {
  compareOcrQuality,
  evaluateOcrQuality,
  type OcrQualityEvaluation
} from '../shared/ocrQuality'
import type { OcrEngineId, OcrEnginePreference } from '../shared/types'

/**
 * 自动 OCR 的粘滞引擎状态：记录最近一次成功引擎，供后续请求优先复用。
 * @author zhenghq
 */
export interface OcrEnginePreferenceState {
  /** 最近一次成功产出有效文本的引擎。 */
  preferredEngine?: OcrEngineId
}

/**
 * 引擎调度器可注入依赖：持有三个可选引擎实例。
 * @author zhenghq
 */
export interface OcrDispatcherDeps {
  /** 当前运行平台，用于 auto 模式的平台映射。 */
  platform: NodeJS.Platform
  /**
   * 可用引擎映射；各引擎可为 null/undefined（表示未注册）。
   */
  engines: {
    system?: OcrEngine | null
    paddle?: OcrEngine | null
    tesseract?: OcrEngine | null
  }
  /** 自动模式跨请求共享的成功引擎状态；指定单引擎偏好时不使用。 */
  enginePreferenceState?: OcrEnginePreferenceState
}

/**
 * 根据引擎偏好和当前平台决定引擎调用顺序。
 * auto 模式优先系统 OCR，再依次使用 PaddleOCR 与 Tesseract 兜底。
 * 若传入最近成功的 preferredEngine，则从该引擎起按默认顺序降级；
 * 降级到队尾后回到队首兜底，确保末位引擎失败时仍可切换。
 * 指定偏好时只返回单个引擎标识。
 * @param preference 用户配置的引擎偏好。
 * @param platform 当前平台标识。
 * @param preferredEngine 最近一次自动识别的成功引擎。
 * @returns 引擎标识数组（调用顺序）。
 * @author zhenghq
 */
export function buildEngineQueue(
  preference: OcrEnginePreference,
  platform: NodeJS.Platform,
  preferredEngine?: OcrEngineId
): OcrEngineId[] {
  if (preference !== 'auto') {
    return [preference as OcrEngineId]
  }
  // auto 模式固定按系统优先，再到 PaddleOCR，最后使用 Tesseract 兜底。
  const defaultQueue: OcrEngineId[] = platform === 'linux'
    ? ['paddle', 'tesseract']
    : ['system', 'paddle', 'tesseract']
  if (!preferredEngine) return defaultQueue
  const preferredIndex = defaultQueue.indexOf(preferredEngine)
  if (preferredIndex < 0) return defaultQueue
  return [
    ...defaultQueue.slice(preferredIndex),
    ...defaultQueue.slice(0, preferredIndex)
  ]
}

/**
 * 记录 OCR 引擎单次结果质量，便于排查乱码是否被采纳。
 * @param result OCR 引擎返回结果。
 * @param accepted 是否被调度器采纳为候选结果。
 * @param quality 统一质量评价摘要。
 * @returns 无返回值。
 * @author zhenghq
 */
function logOcrEngineResult(
  result: OcrRecognizeResult,
  accepted: boolean,
  quality: OcrQualityEvaluation
): void {
  console.log('[ocr] 引擎结果', {
    engine: result.engine,
    textLength: result.text?.length ?? 0,
    score: quality.textScore,
    noise: !quality.valid,
    languageMismatch: quality.languageMismatch,
    averageConfidence: quality.averageConfidence,
    safeToStop: quality.safeToAccept,
    accepted
  })
}

/**
 * OCR 引擎调度编排：按配置顺序依次尝试引擎，
 * 空结果或失败时自动降级到下一层；auto 模式成功后粘滞实际引擎。
 * @author zhenghq
 */
export class OcrDispatcher {
  /** 可注入依赖。 */
  private readonly deps: OcrDispatcherDeps

  /**
   * 创建 OCR 调度器。
   * @param deps 引擎依赖与平台信息。
   * @author zhenghq
   */
  constructor(deps: OcrDispatcherDeps) {
    this.deps = deps
  }

  /**
   * 按指定偏好调度 OCR 识别：
   * 1. 按 buildEngineQueue 决定尝试顺序；
   * 2. 逐层尝试，空结果继续下一层，失败降级；
   * 3. 首个安全结果成功后立即返回，并记录为后续自动请求的首选引擎；
   * 4. 仅有可疑有效结果时继续降级，全部尝试后择优兜底；
   * 5. 无有效结果时抛出 empty；全部引擎不可用/失败时抛出 engine-unavailable。
   * @param input 识别输入。
   * @param preference 引擎偏好（来自设置）。
   * @returns 质量最优的识别结果。
   * @author zhenghq
   */
  async recognize(
    input: OcrRecognizeInput,
    preference: OcrEnginePreference
  ): Promise<OcrRecognizeResult> {
    const queue = buildEngineQueue(
      preference,
      this.deps.platform,
      preference === 'auto' ? this.deps.enginePreferenceState?.preferredEngine : undefined
    )
    const validResults: OcrRecognizeResult[] = []
    const errors: string[] = []
    let attemptedCount = 0
    let engineUnavailableCount = 0

    for (const engineId of queue) {
      const engine = this.deps.engines[engineId]
      if (!engine) continue

      // 检查可用性
      let available = false
      try {
        available = await engine.isAvailable()
      } catch {
        errors.push(`${engineId}: 可用性检测失败`)
        continue
      }
      if (!available) {
        const reason = engine.getUnavailableReason?.() ?? '不可用（平台或模型未就绪）'
        errors.push(`${engineId}: ${reason}`)
        continue
      }

      attemptedCount += 1

      try {
        const result = await engine.recognize(input)
        const quality = evaluateOcrQuality(result, input.language)
        const accepted = quality.valid
        logOcrEngineResult(result, accepted, quality)

        if (quality.safeToAccept) {
          // 安全有效结果已满足业务要求，锁定引擎并立即返回，避免无谓地继续耗费识别时间。
          if (preference === 'auto' && this.deps.enginePreferenceState) {
            this.deps.enginePreferenceState.preferredEngine = result.engine
          }
          return result
        } else if (accepted) {
          // 疑似乱码或低质量结果不能直接锁定，保留为全部引擎失败后的兜底候选。
          validResults.push(result)
        } else {
          errors.push(`${engineId}: 识别结果为空或疑似乱码`)
        }
      } catch (error) {
        if (error instanceof OcrEngineError && error.code === 'timeout') {
          throw error // 超时直接向上传播，不再降级
        }
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`${engineId}: ${message}`)
        if (error instanceof OcrEngineError && error.code === 'engine-unavailable') {
          engineUnavailableCount += 1
        }
      }
    }

    if (validResults.length > 0) {
      // 没有安全结果时按统一质量评价选择兜底候选，并更新后续请求的粘滞引擎。
      const selected = validResults.reduce((best, candidate) => {
        const comparison = compareOcrQuality(
          evaluateOcrQuality(candidate, input.language),
          evaluateOcrQuality(best, input.language)
        )
        return comparison >= 0 ? candidate : best
      })
      if (preference === 'auto' && this.deps.enginePreferenceState) {
        this.deps.enginePreferenceState.preferredEngine = selected.engine
      }
      return selected
    }

    if (attemptedCount === 0 || engineUnavailableCount === attemptedCount) {
      throw new OcrEngineError(
        'engine-unavailable',
        `所有 OCR 引擎均不可用: ${errors.join('; ')}`
      )
    }
    throw new OcrEngineError('empty', `所有 OCR 引擎均未识别到文字: ${errors.join('; ')}`)
  }
}
