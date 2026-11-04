import type { Settings } from '../shared/types'
import type { DingTalkCredentials } from './dingtalkConfig'
import type { TranslateOutput } from './translate'
import {
  createRealtimeSubtitleViewModel,
  type RealtimeSubtitleAudioSource,
  type RealtimeSubtitleAsrProvider,
  type RealtimeSubtitleSegment,
  type RealtimeSubtitleSnapshot,
  type RealtimeSubtitleViewModel,
  type RealtimeSubtitleWindowAppearance,
  type SubtitleSidecarEvent
} from '../shared/subtitleSession'
import { SubtitleSessionHost } from './subtitleSession'
import {
  SubtitleTranslationCoordinator,
  type SubtitleTranslationPhase
} from './subtitleTranslate'
import {
  resolveSubtitleReconnectDelay,
  shouldReconnectSubtitle,
  SUBTITLE_MAX_NETWORK_RECONNECTS
} from '../shared/subtitleReconnect'

/** 控制器使用的 sidecar 宿主最小接口。 */
export interface RealtimeSubtitleHost {
  /** 启动新会话。 */
  start(options: {
    source: RealtimeSubtitleAudioSource
    asr: RealtimeSubtitleAsrProvider
    language: string
    deepgramApiKey?: string | null
    whisperBaseUrl?: string
    whisperModel?: string
    whisperApiKey?: string | null
  }): number
  /** 暂停识别。 */
  pause(): void
  /** 恢复识别。 */
  resume(): void
  /** 停止识别。 */
  stop(): void
  /** 释放宿主。 */
  dispose(): void
  /** 读取当前快照。 */
  snapshot(): RealtimeSubtitleSnapshot
  /** 更新段落译文。 */
  updateTranslation(
    segmentId: string,
    translatedText: string,
    status: RealtimeSubtitleSegment['status']
  ): void
  /** 清空当前显示文本与段落，但不停止识别会话。 */
  clearDisplay(): void
}

/** 实时字幕控制器依赖。 */
export interface RealtimeSubtitleControllerOptions {
  /** 创建 sidecar 宿主。 */
  createHost?: (onEvent: (event: SubtitleSidecarEvent, generation: number) => void) => RealtimeSubtitleHost
  /** 读取当前设置。 */
  getSettings: () => Settings
  /** 读取钉钉凭据。 */
  getDingTalkCredentials: () => DingTalkCredentials | null
  /** 读取 AI API Key。 */
  getAiApiKey: () => string | null
  /** 读取 Deepgram API Key；仅在实时字幕需要启动 Deepgram ASR 时使用。 */
  getDeepgramApiKey?: () => string | null
  /** 读取 Whisper API Key；本地无鉴权服务可返回 null。 */
  getWhisperApiKey?: () => string | null
  /** 读取 iTranslate API Key；仅启用且已配置时返回。 */
  getITranslateApiKey?: () => string | null
  /** 复用现有流式翻译运行时。 */
  translateStream: (
    text: string,
    settings: Settings,
    dingTalkCredentials: DingTalkCredentials | null,
    aiApiKey: string | null,
    options: { onDelta: (delta: string) => void; signal?: AbortSignal },
    iTranslateApiKey?: string | null
  ) => Promise<TranslateOutput>
  /** partial 稳定多久后发起预翻译，默认 300ms。 */
  previewDebounceMs?: number
  /** 广播快照。 */
  onSnapshot: (snapshot: RealtimeSubtitleSnapshot) => void
  /** 控制字幕窗口显隐。 */
  setWindowVisible: (visible: boolean) => void
  /** 同步字幕窗视觉设置。 */
  setWindowAppearance?: (appearance: RealtimeSubtitleWindowAppearance) => void
  /** 网络或音频设备错误允许的自动恢复次数，默认 3 次。 */
  maxNetworkReconnects?: number
  /** 定时器工厂，便于测试注入退避调度。 */
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown
  /** 清除定时器函数。 */
  clearTimeoutFn?: (handle: unknown) => void
}

/**
 * 编排实时识别、字幕段落和流式翻译。
 * @author zhenghq
 */
export class RealtimeSubtitleController {
  private readonly options: RealtimeSubtitleControllerOptions
  private readonly host: RealtimeSubtitleHost
  private readonly translation: SubtitleTranslationCoordinator
  private generation = 0
  private disposed = false
  private appearanceSink?: (appearance: RealtimeSubtitleWindowAppearance) => void
  private latestSettings: Settings
  private startupError: { code: import('../shared/subtitleSession').RealtimeSubtitleErrorCode; message: string } | null = null
  private readonly maxNetworkReconnects: number
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimeoutFn: (handle: unknown) => void
  private reconnectAttempts = 0
  private reconnectTimer: unknown = null
  private hideTimer: unknown = null

  /**
   * 创建实时字幕控制器。
   * @param options 控制器依赖。
   * @author zhenghq
   */
  constructor(options: RealtimeSubtitleControllerOptions) {
    this.options = options
    this.latestSettings = options.getSettings()
    this.appearanceSink = options.setWindowAppearance
    this.maxNetworkReconnects = options.maxNetworkReconnects ?? SUBTITLE_MAX_NETWORK_RECONNECTS
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    this.translation = new SubtitleTranslationCoordinator({
      getSettings: options.getSettings,
      getDingTalkCredentials: options.getDingTalkCredentials,
      getAiApiKey: options.getAiApiKey,
      getITranslateApiKey: options.getITranslateApiKey,
      translateStream: options.translateStream,
      previewDebounceMs: options.previewDebounceMs,
      setTimeoutFn: this.setTimeoutFn,
      clearTimeoutFn: this.clearTimeoutFn,
      onDelta: (segmentId, delta, phase) => this.applyDelta(segmentId, delta, phase),
      onReset: (segmentId, phase) => this.applyReset(segmentId, phase),
      onComplete: (segmentId) => this.applyComplete(segmentId),
      onError: (segmentId, error) => this.applyTranslationError(segmentId, error)
    })
    this.host = (options.createHost ?? ((onEvent) => new SubtitleSessionHost({
      onEvent,
      getDisplayMode: () => this.latestSettings.realtimeSubtitleDisplayMode
    })))((event, generation) => this.handleSidecarEvent(event, generation))
  }

  /**
   * 按当前设置启动实时字幕。
   * @returns 启动后的快照。
   * @author zhenghq
   */
  start(): RealtimeSubtitleSnapshot {
    this.assertActive()
    this.latestSettings = this.options.getSettings()
    return this.startCurrentSession()
  }

  /**
   * 暂停当前识别。
   * @returns 更新后的快照。
   * @author zhenghq
   */
  pause(): RealtimeSubtitleSnapshot {
    this.clearHideTimer()
    this.host.pause()
    return this.publish()
  }

  /**
   * 恢复已暂停的识别。
   * @returns 更新后的快照。
   * @author zhenghq
   */
  resume(): RealtimeSubtitleSnapshot {
    this.host.resume()
    return this.publish()
  }

  /**
   * 停止识别、取消翻译并隐藏字幕窗。
   * @returns 空闲快照。
   * @author zhenghq
   */
  stop(): RealtimeSubtitleSnapshot {
    this.clearReconnectTimer()
    this.clearHideTimer()
    this.reconnectAttempts = 0
    this.translation.invalidate()
    this.host.stop()
    this.options.setWindowVisible(false)
    return this.publish()
  }

  /**
   * 切换启动或停止状态，供全局快捷键使用。
   * @returns 操作后的快照。
   * @author zhenghq
   */
  toggle(): RealtimeSubtitleSnapshot {
    return this.snapshot().state === 'idle' ? this.start() : this.stop()
  }

  /**
   * 读取当前快照。
   * @returns 当前实时字幕状态。
   * @author zhenghq
   */
  snapshot(): RealtimeSubtitleSnapshot {
    return this.mergeStartupError(this.host.snapshot())
  }

  /**
   * 将快照转换为字幕窗视图模型。
   * @returns 可直接渲染的视图。
   * @author zhenghq
   */
  viewModel(): RealtimeSubtitleViewModel {
    return createRealtimeSubtitleViewModel(this.snapshot())
  }

  /**
   * 应用最新设置并同步窗口样式。
   * @param settings 最新完整设置。
   * @returns 无返回值。
   * @author zhenghq
   */
  applySettings(settings: Settings): void {
    const runtimeChanged = this.hasRuntimeSettingChanged(settings)
    const shouldRestart = runtimeChanged && this.host.snapshot().state !== 'idle'
    const hideAfterChanged =
      settings.realtimeSubtitleHideAfterMs !== this.latestSettings.realtimeSubtitleHideAfterMs
    this.latestSettings = settings
    this.syncAppearance()
    if (shouldRestart) {
      // 音频来源、识别语言或 ASR 配置变化后必须重建 sidecar，确保新参数立即生效。
      this.host.stop()
      this.startCurrentSession()
      return
    }
    if (hideAfterChanged) {
      const snapshot = this.host.snapshot()
      const hasDisplayContent =
        snapshot.sourceText.length > 0 ||
        snapshot.translatedText.length > 0 ||
        snapshot.segments.length > 0
      if (snapshot.state === 'running' && hasDisplayContent) {
        this.scheduleHideTimer(this.generation)
      } else {
        this.clearHideTimer()
      }
    }
    this.publish()
  }

  /**
   * 使用最新设置启动当前实时字幕会话。
   * @returns 启动后的快照。
   * @author zhenghq
   */
  private startCurrentSession(): RealtimeSubtitleSnapshot {
    this.clearReconnectTimer()
    this.clearHideTimer()
    this.reconnectAttempts = 0
    this.generation += 1
    this.translation.invalidate()
    this.startupError = null
    const hostGeneration = this.host.start(this.createStartOptions())
    this.generation = hostGeneration
    const snapshot = this.host.snapshot()
    if (snapshot.state === 'idle') {
      this.options.setWindowVisible(false)
      return this.publishWithStartupError(snapshot)
    }
    this.options.setWindowVisible(true)
    this.syncAppearance()
    return this.publish()
  }

  /**
   * 判断设置变化是否要求重建 sidecar 会话。
   * @param settings 最新完整设置。
   * @returns 音频采集或 ASR 配置发生变化时返回 true。
   * @author zhenghq
   */
  private hasRuntimeSettingChanged(settings: Settings): boolean {
    return settings.realtimeSubtitleAudioSource !==
        this.latestSettings.realtimeSubtitleAudioSource ||
      settings.realtimeSubtitleRecognitionLang !==
        this.latestSettings.realtimeSubtitleRecognitionLang ||
      settings.realtimeSubtitleAsrProvider !==
        this.latestSettings.realtimeSubtitleAsrProvider ||
      settings.realtimeSubtitleWhisperBaseUrl !==
        this.latestSettings.realtimeSubtitleWhisperBaseUrl ||
      settings.realtimeSubtitleWhisperModel !==
        this.latestSettings.realtimeSubtitleWhisperModel
  }

  /**
   * 注册字幕窗口视觉设置接收器，便于窗口创建后接管样式。
   * @param sink 接收器。
   * @returns 无返回值。
   * @author zhenghq
   */
  setWindowAppearanceSink(sink: (appearance: RealtimeSubtitleWindowAppearance) => void): void {
    this.appearanceSink = sink
    this.syncAppearance()
  }

  /**
   * 等待在途翻译任务结束。
   * @returns 所有任务完成后 resolve。
   * @author zhenghq
   */
  async idle(): Promise<void> {
    await this.translation.idle()
  }

  /**
   * 释放 sidecar、翻译任务与窗口资源。
   * @returns 无返回值。
   * @author zhenghq
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearReconnectTimer()
    this.clearHideTimer()
    this.translation.invalidate()
    this.host.dispose()
    this.options.setWindowVisible(false)
  }

  /**
   * 处理 sidecar 事件，确保旧代次结果不会进入当前界面。
   * @param event sidecar 事件。
   * @param generation 事件代次。
   * @returns 无返回值。
   * @author zhenghq
   */
  private handleSidecarEvent(event: SubtitleSidecarEvent, generation: number): void {
    if (this.disposed || generation !== this.generation) return
    if (event.type === 'ready') {
      // 只有真正收到 ready 才视为恢复成功，避免启动即失败时重置重试预算。
      this.reconnectAttempts = 0
      this.startupError = null
      this.publish()
      return
    }
    if (event.type === 'partial') {
      const segment = this.host.snapshot().segments.at(-1)
      if (segment?.status === 'partial' && segment.sourceText === event.text) {
        this.translation.preview(event.text, event.lang, generation, segment.id)
      }
      this.scheduleHideTimer(generation)
      this.publish()
      return
    }
    if (event.type === 'final') {
      this.scheduleHideTimer(generation)
      const snapshot = this.host.snapshot()
      const segment = snapshot.segments.at(-1)
      this.publish()
      if (!segment || segment.sourceText !== event.text) return
      this.translation.submit(event.text, event.lang, generation, segment.id)
      return
    }
    if (event.type === 'error') {
      this.clearHideTimer()
      this.startupError = {
        code: event.code,
        message: event.message ?? event.code
      }
      if (shouldReconnectSubtitle(event.code, this.reconnectAttempts, this.maxNetworkReconnects)) {
        this.scheduleReconnect()
        return
      }
      this.options.setWindowVisible(false)
    }
    this.publish()
  }

  /**
   * 按指数退避安排一次会话重连，并保留已展示字幕与字幕窗口。
   * @returns 无返回值。
   * @author zhenghq
   */
  private scheduleReconnect(): void {
    const delay = resolveSubtitleReconnectDelay(this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.clearReconnectTimer()
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null
      if (this.disposed) return
      this.host.stop()
      this.translation.invalidate()
      this.latestSettings = this.options.getSettings()
      // 宿主的同步启动错误会在 start() 返回前派发事件；先推进控制器代次，
      // 让这类事件不会被误判为旧会话而丢弃。
      this.generation += 1
      const hostGeneration = this.host.start(this.createStartOptions())
      this.generation = hostGeneration
      const snapshot = this.host.snapshot()
      if (snapshot.state === 'idle') {
        // 已安排下一轮重试时保留字幕窗；不可恢复的同步错误则关闭窗口。
        this.options.setWindowVisible(this.reconnectTimer !== null)
        this.publish()
        return
      }
      this.options.setWindowVisible(true)
      this.publish()
    }, delay)
    this.publish()
  }

  /**
   * 清除尚未执行的会话自动恢复定时器。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return
    this.clearTimeoutFn(this.reconnectTimer)
    this.reconnectTimer = null
  }

  /**
   * 根据当前设置构造 sidecar 启动参数，确保自动重连沿用同一 ASR 提供商。
   * @returns 当前 provider 对应的宿主启动参数。
   * @author zhenghq
   */
  private createStartOptions(): Parameters<RealtimeSubtitleHost['start']>[0] {
    const base = {
      source: this.latestSettings.realtimeSubtitleAudioSource,
      asr: this.latestSettings.realtimeSubtitleAsrProvider,
      language: this.latestSettings.realtimeSubtitleRecognitionLang
    }
    if (base.asr === 'whisper') {
      return {
        ...base,
        deepgramApiKey: null,
        whisperBaseUrl: this.latestSettings.realtimeSubtitleWhisperBaseUrl,
        whisperModel: this.latestSettings.realtimeSubtitleWhisperModel,
        whisperApiKey: this.options.getWhisperApiKey?.() ?? null
      }
    }
    return {
      ...base,
      deepgramApiKey: this.options.getDeepgramApiKey?.() ?? null
    }
  }

  /**
   * 按最新设置安排无新识别文本时的清屏计时器。
   * @param generation 当前会话代次。
   * @returns 无返回值。
   * @author zhenghq
   */
  private scheduleHideTimer(generation: number): void {
    this.clearHideTimer()
    const delayMs = this.latestSettings.realtimeSubtitleHideAfterMs
    if (delayMs <= 0 || generation !== this.generation) return
    this.hideTimer = this.setTimeoutFn(() => {
      this.hideTimer = null
      if (
        this.disposed ||
        generation !== this.generation ||
        this.host.snapshot().state !== 'running'
      ) {
        return
      }
      this.host.clearDisplay()
      this.publish()
    }, delayMs)
  }

  /**
   * 清除尚未执行的自动隐藏计时器。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearHideTimer(): void {
    if (this.hideTimer === null) return
    this.clearTimeoutFn(this.hideTimer)
    this.hideTimer = null
  }

  /**
   * 把译文增量写入宿主段落并广播。
   * @param segmentId 段落标识。
   * @param delta 新增译文。
   * @returns 无返回值。
   * @author zhenghq
   */
  private applyDelta(
    segmentId: string,
    delta: string,
    phase: SubtitleTranslationPhase
  ): void {
    const segment = this.host.snapshot().segments.find((candidate) => candidate.id === segmentId)
    if (!segment) return
    this.host.updateTranslation(
      segmentId,
      segment.translatedText + delta,
      phase === 'preview' ? 'partial' : 'translating'
    )
    this.publish()
  }

  /**
   * 清空指定阶段的旧译文，避免 partial 内容变化后展示过期翻译。
   * @param segmentId 段落标识。
   * @param phase 预翻译或最终校正阶段。
   * @returns 无返回值。
   * @author zhenghq
   */
  private applyReset(segmentId: string, phase: SubtitleTranslationPhase): void {
    const segment = this.host.snapshot().segments.find((candidate) => candidate.id === segmentId)
    if (!segment) return
    const status = phase === 'preview' && segment.status === 'partial' ? 'partial' : 'translating'
    this.host.updateTranslation(segmentId, '', status)
    this.publish()
  }

  /**
   * 标记段落翻译完成。
   * @param segmentId 段落标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  private applyComplete(segmentId: string): void {
    const segment = this.host.snapshot().segments.find((candidate) => candidate.id === segmentId)
    if (!segment) return
    this.host.updateTranslation(segmentId, segment.translatedText, 'translated')
    this.publish()
  }

  /**
   * 标记单段翻译失败，但不中断识别会话。
   * @param segmentId 段落标识。
   * @param error 翻译错误。
   * @returns 无返回值。
   * @author zhenghq
   */
  private applyTranslationError(segmentId: string, error: Error): void {
    const segment = this.host.snapshot().segments.find((candidate) => candidate.id === segmentId)
    if (!segment) return
    this.host.updateTranslation(segmentId, segment.translatedText, 'error')
    console.error('[subtitle] 段落翻译失败:', error.message)
    this.publish()
  }

  /**
   * 发布最新快照。
   * @returns 当前快照。
   * @author zhenghq
   */
  private publish(): RealtimeSubtitleSnapshot {
    const snapshot = this.mergeStartupError(this.host.snapshot())
    this.options.onSnapshot(snapshot)
    return snapshot
  }

  /**
   * 在宿主未持久化同步错误时补充控制器兜底错误，保证界面仍可展示原因。
   * @param snapshot 宿主快照。
   * @returns 合并后的快照。
   * @author zhenghq
   */
  private mergeStartupError(snapshot: RealtimeSubtitleSnapshot): RealtimeSubtitleSnapshot {
    if (!this.startupError || snapshot.state !== 'idle') return snapshot
    return {
      ...snapshot,
      error: snapshot.error ?? this.startupError.message,
      errorCode: snapshot.errorCode ?? this.startupError.code
    }
  }

  /**
   * 发布带同步启动错误的空闲快照。
   * @param snapshot 宿主快照。
   * @returns 已广播的快照。
   * @author zhenghq
   */
  private publishWithStartupError(snapshot: RealtimeSubtitleSnapshot): RealtimeSubtitleSnapshot {
    const merged = this.mergeStartupError(snapshot)
    this.options.onSnapshot(merged)
    return merged
  }

  /**
   * 同步字幕窗外观设置。
   * @returns 无返回值。
   * @author zhenghq
   */
  private syncAppearance(): void {
    this.appearanceSink?.({
      displayMode: this.latestSettings.realtimeSubtitleDisplayMode,
      fontSize: this.latestSettings.realtimeSubtitleFontSize,
      textColor: this.latestSettings.realtimeSubtitleTextColor,
      clickThrough: this.latestSettings.realtimeSubtitleClickThrough
    })
  }

  /**
   * 防止已释放控制器继续启动会话。
   * @returns 无返回值。
   * @author zhenghq
   */
  private assertActive(): void {
    if (this.disposed) throw new Error('realtime subtitle controller disposed')
  }
}
