import type { EdgeSpeechResult } from '../../shared/types'
import { splitSpeechText, type SpeechStartResult } from './speech'

/** 可注入测试的 HTML 音频对象接口。 */
export interface EdgeAudioLike {
  onended: (() => void) | null
  onerror: (() => void) | null
  play(): Promise<void>
  pause(): void
  removeAttribute(name: string): void
  load(): void
  src: string
  preload?: string
  volume?: number
  muted?: boolean
  remove?(): void
}

interface EdgePlaybackOptions {
  synthesize(text: string, language: string, signal?: AbortSignal): Promise<EdgeSpeechResult>
  createAudio(url: string): EdgeAudioLike
  createObjectUrl(blob: Blob): string
  revokeObjectUrl(url: string): void
  maxChunkLength?: number
  onSynthesisStart? (text: string, language: string): void
  onAudioReady? (byteLength: number): void
  onPlaybackStart? (): void
  onSpeakingChange? (speaking: boolean): void
  onComplete? (): void
  onError? (message: string): void
}

interface ActivePlayback {
  audio: EdgeAudioLike
  url: string
  cancel: () => void
  released: boolean
}

/** Edge 在线音频播放控制器。 */
export interface EdgePlaybackController {
  /** 开始合成并播放译文。 */
  start(text: string, language: string): Promise<SpeechStartResult>
  /** 停止当前音频和网络请求。 */
  stop(): void
  /** 判断当前是否存在播放会话。 */
  isSpeaking(): boolean
}

/**
 * 创建支持长文本分段和取消的 Edge 音频播放控制器。
 * @param options 合成、音频和临时 URL 操作依赖。
 * @returns Edge 音频播放控制器。
 * @author zhenghq
 */
export function createEdgePlaybackController(options: EdgePlaybackOptions): EdgePlaybackController {
  let speaking = false
  let sessionId = 0
  let currentPlayback: ActivePlayback | null = null
  let currentAbort: AbortController | null = null

  /**
   * 更新当前播放状态。
   * @param value 是否正在播放或合成。
   * @returns 无返回值。
   * @author zhenghq
   */
  function setSpeaking(value: boolean): void {
    if (speaking === value) return
    speaking = value
    options.onSpeakingChange?.(value)
  }

  /**
   * 释放当前音频对象和临时 URL。
   * @returns 无返回值。
   * @author zhenghq
   */
  function releasePlayback(playback: ActivePlayback | null = currentPlayback): void {
    if (!playback || playback.released) return
    playback.released = true
    playback.audio.onended = null
    playback.audio.onerror = null
    playback.audio.pause()
    playback.audio.removeAttribute('src')
    playback.audio.load()
    playback.audio.remove?.()
    options.revokeObjectUrl(playback.url)
    if (currentPlayback === playback) currentPlayback = null
  }

  /**
   * 结束指定会话并显示脱敏错误。
   * @param activeSession 当前会话序号。
   * @param message 错误提示。
   * @returns 播放失败结果。
   * @author zhenghq
   */
  function fail(activeSession: number, message: string): SpeechStartResult {
    if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
    releasePlayback()
    currentAbort = null
    setSpeaking(false)
    options.onError?.(message)
    return { ok: false, error: message }
  }

  return {
    async start(text: string, language: string): Promise<SpeechStartResult> {
      const normalizedText = text.trim()
      if (!normalizedText) return { ok: false, error: '暂无可朗读的译文' }
      this.stop()
      const activeSession = ++sessionId
      const chunks = splitSpeechText(normalizedText, options.maxChunkLength)
      if (chunks.length === 0) return { ok: false, error: '暂无可朗读的译文' }
      setSpeaking(true)

      for (const chunk of chunks) {
        if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
        const abort = new AbortController()
        currentAbort = abort
        options.onSynthesisStart?.(chunk, language)
        const result = await options.synthesize(chunk, language, abort.signal)
        currentAbort = null
        if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
        if (!result.ok || !result.audio || result.audio.length === 0) {
          return fail(activeSession, result.error ?? 'Edge 在线语音暂不可用')
        }
        options.onAudioReady?.(result.audio.byteLength)

        const audioBuffer = new ArrayBuffer(result.audio.byteLength)
        new Uint8Array(audioBuffer).set(result.audio)
        const blob = new Blob([audioBuffer], { type: result.mimeType ?? 'audio/mpeg' })
        const url = options.createObjectUrl(blob)
        const audio = options.createAudio(url)
        audio.src = url
        audio.preload = 'auto'
        audio.volume = 1
        audio.muted = false
        audio.load()
        let cancelPlayback = (): void => {}
        const playback: ActivePlayback = {
          audio,
          url,
          cancel: () => cancelPlayback(),
          released: false
        }
        currentPlayback = playback
        try {
          options.onPlaybackStart?.()
          await new Promise<void>((resolve, reject) => {
            audio.onended = () => resolve()
            audio.onerror = () => reject(new Error('音频播放失败'))
            cancelPlayback = () => reject(new Error('音频播放已取消'))
            void audio.play().catch(reject)
          })
        } catch {
          if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
          return fail(activeSession, 'Edge 音频播放失败')
        } finally {
          releasePlayback(playback)
        }
      }

      if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
      setSpeaking(false)
      options.onComplete?.()
      return { ok: true }
    },

    stop(): void {
      sessionId += 1
      currentAbort?.abort()
      currentAbort = null
      currentPlayback?.cancel()
      releasePlayback()
      setSpeaking(false)
    },

    isSpeaking(): boolean {
      return speaking
    }
  }
}
