import type { PronunciationAccent } from '../../shared/types'
import type { SpeechStartResult } from './speech'

/** 单词 TTS 兜底可使用的在线或系统语音控制器。 */
export interface PronunciationFallbackController {
  /** 开始朗读指定文本，单词变体可附带 IPA 音标。 */
  start(
    text: string,
    language: string,
    ipa?: string
  ): SpeechStartResult | Promise<SpeechStartResult>
  /** 判断控制器当前是否存在播放会话。 */
  isSpeaking(): boolean
}

/** 单词 TTS 兜底依赖。 */
export interface PronunciationSpeechFallbackOptions {
  /** 当前语音服务偏好。 */
  speechProvider: 'system' | 'edge' | undefined
  /** 当前点击的音标变体；用于保留口音和 IPA 信息。 */
  variant?: { accent: PronunciationAccent; ipa: string }
  /** 当前单词播放会话的取消信号。 */
  signal?: AbortSignal
  /** Edge 在线语音控制器。 */
  edge: PronunciationFallbackController
  /** 系统语音控制器。 */
  system: PronunciationFallbackController
}

/** 单词 TTS 兜底结果。 */
export type PronunciationSpeechFallbackResult =
  | { status: 'started'; provider: 'edge' | 'system' }
  | { status: 'failed' }

/**
 * 按当前语音偏好启动单词 TTS；Edge 失败时回退系统语音。
 * @param text 待朗读的英文单词。
 * @param options 当前语音偏好和可用控制器。
 * @returns 实际启动的语音服务；两者均不可用时返回 failed。
 * @author zhenghq
 */
export async function startPronunciationSpeechFallback(
  text: string,
  options: PronunciationSpeechFallbackOptions
): Promise<PronunciationSpeechFallbackResult> {
  const normalizedText = text.trim()
  if (!normalizedText) return { status: 'failed' }
  if (options.signal?.aborted) return { status: 'failed' }
  const language = options.variant?.accent === 'UK' ? 'en-GB' : 'en-US'
  const ipa = options.variant?.ipa.trim() || undefined
  if (options.speechProvider === 'edge') {
    try {
      const edgeResult = await options.edge.start(normalizedText, language, ipa)
      if (options.signal?.aborted) return { status: 'failed' }
      // Edge 在整段播放完成后才返回成功，此时 isSpeaking() 已恢复 false，不能据此重复回退。
      if (edgeResult.ok) return { status: 'started', provider: 'edge' }
    } catch {
      // Edge 合成异常与显式失败一样回退系统语音，不把底层异常泄露到界面。
    }
  }
  if (options.signal?.aborted) return { status: 'failed' }
  const systemResult = await options.system.start(normalizedText, language)
  // 系统语音调用 speak 后可能瞬时回传未播放，启动结果应以 start() 的返回值判定。
  return systemResult.ok
    ? { status: 'started', provider: 'system' }
    : { status: 'failed' }
}
