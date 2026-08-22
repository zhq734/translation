import {
  OcrEngineError,
  type OcrEngine,
  type OcrRecognizeInput,
  type OcrRecognizeResult
} from '../shared/ocrEngine'
import { isMostlyNoise, scoreOcrText } from '../shared/ocrScoring'
import type { OcrEngineId, OcrEnginePreference } from '../shared/types'

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
}

/**
 * 根据引擎偏好和当前平台决定引擎调用顺序。
 * auto 模式优先 Tesseract，Paddle 放最后兜底，避免英文截图被 Paddle 误识别为乱码。
 * 指定偏好时只返回单个引擎标识。
 * @param preference 用户配置的引擎偏好。
 * @param platform 当前平台标识。
 * @returns 引擎标识数组（调用顺序）。
 * @author zhenghq
 */
export function buildEngineQueue(
  preference: OcrEnginePreference,
  platform: NodeJS.Platform
): OcrEngineId[] {
  if (preference !== 'auto') {
    return [preference as OcrEngineId]
  }
  // auto 模式按平台决定顺序：macOS 的 Swift OSA 可能缺失，Windows 系统 OCR 相对稳定。
  if (platform === 'darwin') {
    return ['tesseract', 'system', 'paddle']
  }
  if (platform === 'win32') {
    return ['system', 'tesseract', 'paddle']
  }
  // Linux 无系统 OCR，优先使用 Tesseract，Paddle 仅作最后兜底。
  return ['tesseract', 'paddle']
}

/**
 * 判断 OCR 结果是否为有效非空文本（排除噪声）。
 * @param result OCR 识别结果。
 * @returns 是否有效。
 * @author zhenghq
 */
function isValidResult(result: OcrRecognizeResult): boolean {
  if (!result.text || !result.text.trim()) return false
  if (isMostlyNoise(result.text)) return false
  const score = scoreOcrText(result.text)
  return score > 0
}

/**
 * 记录 OCR 引擎单次结果质量，便于排查乱码是否被采纳。
 * @param result OCR 引擎返回结果。
 * @param accepted 是否被调度器采纳为候选结果。
 * @returns 无返回值。
 * @author zhenghq
 */
function logOcrEngineResult(result: OcrRecognizeResult, accepted: boolean): void {
  console.log('[ocr] 引擎结果', {
    engine: result.engine,
    textLength: result.text?.length ?? 0,
    score: scoreOcrText(result.text ?? ''),
    noise: isMostlyNoise(result.text ?? ''),
    accepted
  })
}

/**
 * OCR 引擎调度编排：按配置顺序依次尝试引擎，
 * 空结果或失败时自动降级到下一层，多引擎有效结果质量择优。
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
   * 3. 收集所有有效结果，按质量分择优返回；
   * 4. 无有效结果时抛出 empty；全部引擎不可用/失败时抛出 engine-unavailable。
   * @param input 识别输入。
   * @param preference 引擎偏好（来自设置）。
   * @returns 质量最优的识别结果。
   * @author zhenghq
   */
  async recognize(
    input: OcrRecognizeInput,
    preference: OcrEnginePreference
  ): Promise<OcrRecognizeResult> {
    const queue = buildEngineQueue(preference, this.deps.platform)
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
        const accepted = isValidResult(result)
        logOcrEngineResult(result, accepted)

        if (accepted) {
          // 收集有效结果，继续尝试其他引擎以便择优
          validResults.push(result)
          // 若当前为指定单引擎偏好（非 auto），直接返回
          if (preference !== 'auto') return result
          // auto 模式：如果首层已有高质量结果，不必继续
          if (validResults.length >= 1 && scoreOcrText(result.text) >= 5) break
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

    if (validResults.length === 0) {
      if (attemptedCount === 0 || engineUnavailableCount === attemptedCount) {
        throw new OcrEngineError(
          'engine-unavailable',
          `所有 OCR 引擎均不可用: ${errors.join('; ')}`
        )
      }
      throw new OcrEngineError(
        'empty',
        `所有 OCR 引擎均未识别到文字: ${errors.join('; ')}`
      )
    }

    // 多结果择优：按质量分排序取最高分
    return validResults.reduce((best, candidate) =>
      scoreOcrText(candidate.text) >= scoreOcrText(best.text) ? candidate : best
    )
  }
}
