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

/** 可注入测试的 AudioBuffer 接口。 */
export interface EdgeAudioBufferLike {
  /** 音频时长，单位为秒。 */
  duration: number
}

/** 可注入测试的 AudioBufferSourceNode 接口。 */
export interface EdgeBufferSourceLike {
  buffer: EdgeAudioBufferLike | null
  onended: ((event: Event) => void) | null
  connect(destination: unknown): void
  start(when?: number): void
  stop(when?: number): void
}

/** 可注入测试的 AudioContext 接口。 */
export interface EdgeAudioContextLike {
  currentTime: number
  destination: unknown
  resume(): Promise<void>
  decodeAudioData(data: ArrayBuffer): Promise<EdgeAudioBufferLike>
  createBufferSource(): EdgeBufferSourceLike
  close(): Promise<void>
}

interface EdgePlaybackOptions {
  synthesize(text: string, language: string, signal?: AbortSignal): Promise<EdgeSpeechResult>
  createAudio(url: string): EdgeAudioLike
  createObjectUrl(blob: Blob): string
  revokeObjectUrl(url: string): void
  maxChunkLength?: number
  /** 当前片段之外最多提前请求的片段数。 */
  prefetchAhead?: number
  /** 创建 AudioContext；返回 null 时回退到 HTMLAudioElement 播放。 */
  createAudioContext?: () => EdgeAudioContextLike | null
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
  let currentAudioContext: EdgeAudioContextLike | null = null
  let currentAudioSources: EdgeBufferSourceLike[] = []
  let currentAudioWaitResolve: (() => void) | null = null
  const activeAborts = new Set<AbortController>()
  const activePlaybacks = new Set<ActivePlayback>()

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
    activePlaybacks.delete(playback)
    if (currentPlayback === playback) currentPlayback = null
  }

  /**
   * 释放当前会话创建的所有音频资源。
   * @returns 无返回值。
   * @author zhenghq
   */
  function releaseAllPlaybacks(): void {
    for (const playback of [...activePlaybacks]) releasePlayback(playback)
  }

  /**
   * 释放当前 AudioContext 及其已经创建的音频源。
   * @returns 无返回值。
   * @author zhenghq
   */
  function releaseAudioContext(): void {
    currentAudioWaitResolve?.()
    currentAudioWaitResolve = null
    for (const source of currentAudioSources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // 已经结束或已经停止的音频源会抛异常，忽略即可。
      }
    }
    currentAudioSources = []
    const context = currentAudioContext
    currentAudioContext = null
    if (context) void context.close().catch(() => {})
  }

  /**
   * 请求一个文本片段并登记可取消的 AbortController。
   * @param text 待合成的文本片段。
   * @param language 目标语言。
   * @param activeSession 当前播放会话序号。
   * @returns Edge 合成结果。
   * @author zhenghq
   */
  async function synthesizeChunk(
    text: string,
    language: string,
    activeSession: number
  ): Promise<EdgeSpeechResult> {
    if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
    const abort = new AbortController()
    activeAborts.add(abort)
    currentAbort = abort
    options.onSynthesisStart?.(text, language)
    try {
      return await options.synthesize(text, language, abort.signal)
    } finally {
      activeAborts.delete(abort)
      if (currentAbort === abort) currentAbort = null
    }
  }

  /**
   * 将合成结果转换为已加载的临时音频，供播放阶段直接使用。
   * @param result Edge 合成结果。
   * @param activeSession 当前播放会话序号。
   * @returns 已加载的活动音频；合成失败时返回 null。
   * @author zhenghq
   */
  function preparePlayback(
    result: EdgeSpeechResult,
    activeSession: number
  ): ActivePlayback | null {
    if (activeSession !== sessionId) return null
    if (!result.ok || !result.audio || result.audio.length === 0) return null
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
    activePlaybacks.add(playback)
    return playback
  }

  /**
   * 合成并预加载指定片段，为当前片段播放时提前准备下一片段。
   * @param chunks 全部待播放片段。
   * @param index 当前片段索引。
   * @param language 目标语言。
   * @param activeSession 当前播放会话序号。
   * @returns 已加载的活动音频或合成结果错误。
   * @author zhenghq
   */
  async function prepareChunk(
    chunks: readonly string[],
    index: number,
    language: string,
    activeSession: number
  ): Promise<{ playback: ActivePlayback | null; error?: string }> {
    const result = await synthesizeChunk(chunks[index], language, activeSession)
    if (activeSession !== sessionId) return { playback: null, error: 'Edge 语音请求已取消' }
    if (!result.ok || !result.audio || result.audio.length === 0) {
      return { playback: null, error: result.error ?? 'Edge 在线语音暂不可用' }
    }
    const playback = preparePlayback(result, activeSession)
    return playback
      ? { playback }
      : { playback: null, error: 'Edge 语音请求已取消' }
  }

  /**
   * 播放一个已预加载的音频并等待其结束。
   * @param playback 待播放音频。
   * @param activeSession 当前播放会话序号。
   * @returns 播放是否正常结束。
   * @author zhenghq
   */
  async function playPlayback(playback: ActivePlayback, activeSession: number): Promise<boolean> {
    currentPlayback = playback
    try {
      options.onPlaybackStart?.()
      await new Promise<void>((resolve, reject) => {
        playback.audio.onended = () => resolve()
        playback.audio.onerror = () => reject(new Error('音频播放失败'))
        playback.cancel = () => reject(new Error('音频播放已取消'))
        void playback.audio.play().catch(reject)
      })
      return activeSession === sessionId
    } catch {
      return false
    } finally {
      releasePlayback(playback)
    }
  }

  /**
   * 将 Edge 音频字节复制为独立 ArrayBuffer 并解码。
   * @param audio Edge 返回的音频字节。
   * @param context 当前 AudioContext。
   * @returns 已解码的音频缓冲区。
   * @author zhenghq
   */
  async function decodeEdgeAudio(
    audio: Uint8Array,
    context: EdgeAudioContextLike
  ): Promise<EdgeAudioBufferLike> {
    const buffer = new ArrayBuffer(audio.byteLength)
    new Uint8Array(buffer).set(audio)
    return context.decodeAudioData(buffer)
  }

  /**
   * 使用 AudioContext 并发预取、解码并按顺序调度 Edge 音频片段。
   * @param chunks 待播放文本片段。
   * @param language 目标语言。
   * @param activeSession 当前播放会话序号。
   * @param context 当前 AudioContext。
   * @returns 播放结果。
   * @author zhenghq
   */
  async function startAudioContextPlayback(
    chunks: readonly string[],
    language: string,
    activeSession: number,
    context: EdgeAudioContextLike
  ): Promise<SpeechStartResult> {
    const prefetchAhead = Math.max(0, Math.floor(options.prefetchAhead ?? 2))
    const pending = new Map<number, Promise<{ decoded: EdgeAudioBufferLike } | { error: string }>>()
    let nextToRequest = 0
    let firstSource = true
    let scheduleCursor = 0

    /**
     * 在有界窗口内发起后续合成请求。
     * @returns 无返回值。
     * @author zhenghq
     */
    function fillRequestWindow(currentIndex: number): void {
      const maxRequestedIndex = Math.min(chunks.length - 1, currentIndex + prefetchAhead)
      while (nextToRequest <= maxRequestedIndex) {
        const index = nextToRequest
        pending.set(index, synthesizeChunk(chunks[index], language, activeSession).then(async (result) => {
          if (activeSession !== sessionId) return { error: 'Edge 语音请求已取消' }
          if (!result.ok || !result.audio || result.audio.length === 0) {
            return { error: result.error ?? 'Edge 在线语音暂不可用' }
          }
          options.onAudioReady?.(result.audio.byteLength)
          try {
            return { decoded: await decodeEdgeAudio(result.audio, context) }
          } catch {
            return { error: 'Edge 音频解码失败' }
          }
        }))
        nextToRequest += 1
      }
    }

    try {
      currentAudioContext = context
      await context.resume()
      if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
      fillRequestWindow(0)
      let lastSourceEnded: Promise<void> | null = null

      for (let index = 0; index < chunks.length; index += 1) {
        if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
        const preparedPromise = pending.get(index)
        if (!preparedPromise) return fail(activeSession, 'Edge 在线语音暂不可用')
        const prepared = await preparedPromise
        pending.delete(index)
        if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
        if ('error' in prepared) return fail(activeSession, prepared.error)

        const source = context.createBufferSource()
        source.buffer = prepared.decoded
        source.connect(context.destination)
        lastSourceEnded = new Promise((resolve) => {
          source.onended = () => resolve()
          currentAudioWaitResolve = resolve
        })
        const startAt = Math.max(context.currentTime + 0.02, scheduleCursor)
        source.start(startAt)
        scheduleCursor = startAt + Math.max(0, prepared.decoded.duration)
        currentAudioSources.push(source)
        if (firstSource) {
          firstSource = false
          options.onPlaybackStart?.()
        }
        fillRequestWindow(index)
      }

      if (!lastSourceEnded) return fail(activeSession, 'Edge 语音服务未返回音频')
      await lastSourceEnded
      if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
      setSpeaking(false)
      options.onComplete?.()
      return { ok: true }
    } catch {
      if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
      return fail(activeSession, 'Edge 音频播放失败')
    } finally {
      if (currentAudioContext === context) {
        releaseAudioContext()
      }
    }
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
    for (const abort of activeAborts) abort.abort()
    sessionId += 1
    releaseAllPlaybacks()
    releaseAudioContext()
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
      const audioContext = options.createAudioContext?.()
      if (audioContext) {
        return startAudioContextPlayback(chunks, language, activeSession, audioContext)
      }
      let prepared = await prepareChunk(chunks, 0, language, activeSession)
      if (!prepared.playback) return fail(activeSession, prepared.error ?? 'Edge 在线语音暂不可用')

      for (let index = 0; index < chunks.length; index += 1) {
        if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
        const nextPreparedPromise = index + 1 < chunks.length
          ? prepareChunk(chunks, index + 1, language, activeSession)
          : null
        const played = await playPlayback(prepared.playback, activeSession)
        if (!played) {
          if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
          return fail(activeSession, 'Edge 音频播放失败')
        }
        if (!nextPreparedPromise) break
        prepared = await nextPreparedPromise
        if (!prepared.playback) return fail(activeSession, prepared.error ?? 'Edge 在线语音暂不可用')
      }

      if (activeSession !== sessionId) return { ok: false, error: 'Edge 语音请求已取消' }
      setSpeaking(false)
      options.onComplete?.()
      return { ok: true }
    },

    stop(): void {
      sessionId += 1
      for (const abort of activeAborts) abort.abort()
      currentAbort = null
      currentPlayback?.cancel()
      releaseAllPlaybacks()
      releaseAudioContext()
      setSpeaking(false)
    },

    isSpeaking(): boolean {
      return speaking
    }
  }
}
