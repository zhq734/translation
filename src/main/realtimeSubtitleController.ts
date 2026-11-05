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

/** final 译文出现后的最短展示时长，避免下一句 partial 立刻覆盖导致一闪而过。 */
const DEFAULT_TRANSLATION_DISPLAY_HOLD_MS = 1500

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
    webSocketUrl?: string
    dashScopeUrl?: string
    dashScopeModel?: string
    dashScopeApiKey?: string | null
    openAIRealtimeUrl?: string
    openAIRealtimeModel?: string
    openAIRealtimeApiKey?: string | null
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
  /** 读取 DashScope API Key；仅在实时字幕使用 DashScope ASR 时注入。 */
  getDashScopeApiKey?: () => string | null
  /** 读取 OpenAI Realtime API Key；仅在实时字幕使用 OpenAI ASR 时注入。 */
  getOpenAIRealtimeApiKey?: () => string | null
  /** 读取 iTranslate API Key；仅启用且已配置时返回。 */
  getITranslateApiKey?: () => string | null
  /** 读取实时识别网络中断的本地化提示。 */
  getNetworkErrorMessage?: () => string
  /** 主进程诊断日志接收器；默认写入 console，断链与重连使用 warn 级别。 */
  log?: (message: string, level?: 'info' | 'warn') => void
  /** 复用现有流式翻译运行时。 */
  translateStream: (
    text: string,
    settings: Settings,
    dingTalkCredentials: DingTalkCredentials | null,
    aiApiKey: string | null,
    options: { onDelta: (delta: string) => void; signal?: AbortSignal },
    iTranslateApiKey?: string | null
  ) => Promise<TranslateOutput>
  /** 稳定 partial 的预览翻译防抖配置，final 到达后复用或校正该结果。 */
  previewDebounceMs?: number
  /** 两次预览翻译请求之间的最短间隔，默认 1500ms；设为 0 可关闭。 */
  previewMinIntervalMs?: number
  /** 预览翻译遇到限流后的冷却时长，默认 30000ms；设为 0 可关闭。 */
  previewRateLimitCooldownMs?: number
  /** final 翻译最大尝试次数（含首次），默认 3 次。 */
  finalMaxAttempts?: number
  /** final 翻译首次重试等待时间，默认 600ms，后续按指数退避。 */
  finalRetryBaseDelayMs?: number
  /** final 翻译从入队到结束的总时限，默认 15000ms。 */
  finalRequestDeadlineMs?: number
  /** 当前时间读取函数，便于测试控制预览请求节流。 */
  nowFn?: () => number
  /** final 译文出现后的最短展示时长，默认 1500ms；设为 0 可关闭。 */
  translationDisplayHoldMs?: number
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
  private readonly getNetworkErrorMessage: () => string
  private readonly logSink: (message: string, level?: 'info' | 'warn') => void
  private readonly translationDisplayHoldMs: number
  private reconnectAttempts = 0
  private reconnectTimer: unknown = null
  private hideTimer: unknown = null
  private translationDisplayHoldTimer: unknown = null
  private translationDisplayUpdatePending = false
  private translationDisplayHoldSegmentId: string | null = null
  /** 已到达译文、但尚未轮到的段落，按到达顺序依次展示。 */
  private readonly pendingTranslationDisplaySegmentIds: string[] = []
  /** 待展示段落去重集合，避免流式增量反复入队。 */
  private readonly pendingTranslationDisplaySegmentIdSet = new Set<string>()
  /** 已完成过展示锁的段落，避免旧段落的后续增量再次抢占屏幕。 */
  private readonly displayedTranslationSegmentIds = new Set<string>()
  /** 最近一次真正推送给字幕窗的快照，用于展示锁期间保持界面内容不变。 */
  private lastPublishedSnapshot: RealtimeSubtitleSnapshot | null = null

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
    this.getNetworkErrorMessage = options.getNetworkErrorMessage ?? (() => 'network')
    const translationDisplayHoldMs =
      options.translationDisplayHoldMs ?? DEFAULT_TRANSLATION_DISPLAY_HOLD_MS
    this.translationDisplayHoldMs = Number.isFinite(translationDisplayHoldMs)
      ? Math.max(0, translationDisplayHoldMs)
      : DEFAULT_TRANSLATION_DISPLAY_HOLD_MS
    this.logSink = options.log ?? ((message, level = 'info') => {
      const line = `[subtitle] ${message}`
      if (level === 'warn') console.warn(line)
      else console.log(line)
    })
    this.translation = new SubtitleTranslationCoordinator({
      getSettings: options.getSettings,
      getDingTalkCredentials: options.getDingTalkCredentials,
      getAiApiKey: options.getAiApiKey,
      getITranslateApiKey: options.getITranslateApiKey,
      translateStream: options.translateStream,
      previewDebounceMs: options.previewDebounceMs,
      previewMinIntervalMs: options.previewMinIntervalMs,
      previewRateLimitCooldownMs: options.previewRateLimitCooldownMs,
      finalMaxAttempts: options.finalMaxAttempts,
      finalRetryBaseDelayMs: options.finalRetryBaseDelayMs,
      finalRequestDeadlineMs: options.finalRequestDeadlineMs,
      nowFn: options.nowFn,
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
    this.clearTranslationDisplayHold()
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
    this.clearTranslationDisplayHold()
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
   * 展示锁生效时宿主已产生下一句内容，但字幕窗仍应停留在上一句，
   * 因此这里读取最近一次实际推送的快照，而不是宿主实时快照。
   * @returns 可直接渲染的视图。
   * @author zhenghq
   */
  viewModel(): RealtimeSubtitleViewModel {
    return createRealtimeSubtitleViewModel(this.lastPublishedSnapshot ?? this.snapshot())
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
    this.clearTranslationDisplayHold()
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
    this.clearTranslationDisplayHold()
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
        this.latestSettings.realtimeSubtitleWhisperModel ||
      settings.realtimeSubtitleWebSocketUrl !==
        this.latestSettings.realtimeSubtitleWebSocketUrl ||
      settings.realtimeSubtitleDashScopeUrl !==
        this.latestSettings.realtimeSubtitleDashScopeUrl ||
      settings.realtimeSubtitleDashScopeModel !==
        this.latestSettings.realtimeSubtitleDashScopeModel ||
      settings.realtimeSubtitleOpenAIRealtimeUrl !==
        this.latestSettings.realtimeSubtitleOpenAIRealtimeUrl ||
      settings.realtimeSubtitleOpenAIRealtimeModel !==
        this.latestSettings.realtimeSubtitleOpenAIRealtimeModel
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
    this.clearTranslationDisplayHold()
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
      if (this.reconnectAttempts > 0) {
        this.logSink(
          `ASR 重连成功 provider=${this.latestSettings.realtimeSubtitleAsrProvider} attempts=${this.reconnectAttempts}`,
          'info'
        )
      }
      // 只有真正收到 ready 才视为恢复成功，避免启动即失败时重置重试预算。
      this.reconnectAttempts = 0
      this.startupError = null
      this.publish()
      return
    }
    if (event.type === 'partial') {
      this.scheduleHideTimer(generation)
      const snapshot = this.host.snapshot()
      const segment = snapshot.segments.at(-1)
      this.publishDisplayUpdate()
      // partial 已由宿主覆盖到当前段落，只有仍是最新编辑中的同文段落才启动
      // 预览翻译，避免迟到事件给历史段落重新发起请求。
      if (!segment || segment.status !== 'partial' || segment.sourceText !== event.text) return
      this.translation.preview(event.text, event.lang, generation, segment.id)
      return
    }
    if (event.type === 'final') {
      this.scheduleHideTimer(generation)
      const snapshot = this.host.snapshot()
      const segment = snapshot.segments.at(-1)
      this.publishDisplayUpdate()
      if (!segment || segment.sourceText !== event.text) return
      this.translation.submit(event.text, event.lang, generation, segment.id)
      return
    }
    if (event.type === 'error') {
      this.clearHideTimer()
      this.clearTranslationDisplayHold()
      this.logSink(
        `${event.code === 'network' ? 'ASR 连接中断' : 'ASR 会话错误'} provider=${this.latestSettings.realtimeSubtitleAsrProvider} code=${event.code} message=${event.message ?? event.code} attempts=${this.reconnectAttempts}/${this.maxNetworkReconnects}`,
        'warn'
      )
      this.startupError = {
        code: event.code,
        message: event.message ?? event.code
      }
      if (shouldReconnectSubtitle(event.code, this.reconnectAttempts, this.maxNetworkReconnects)) {
        this.scheduleReconnect()
        return
      }
      this.options.setWindowVisible(false)
    } else if (event.type === 'status' && event.state === 'idle') {
      this.clearHideTimer()
      this.clearTranslationDisplayHold()
      // 结构化错误通常紧跟着 stopped 状态；已有错误或待执行重连时不得重复调度。
      if (this.startupError || this.reconnectTimer !== null) {
        this.publish()
        return
      }
      this.logSink(
        `ASR 会话意外停止 provider=${this.latestSettings.realtimeSubtitleAsrProvider}；若为 websocket，请检查 WS 是否断链`,
        'warn'
      )
      const reconnectable = shouldReconnectSubtitle(
        'network',
        this.reconnectAttempts,
        this.maxNetworkReconnects
      )
      this.startupError = {
        code: 'network',
        message: this.getNetworkErrorMessage()
      }
      if (reconnectable) {
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
    if (this.reconnectTimer !== null) return
    const delay = resolveSubtitleReconnectDelay(this.reconnectAttempts)
    const attempt = this.reconnectAttempts + 1
    this.reconnectAttempts += 1
    this.logSink(
      `ASR 断链，安排第 ${attempt}/${this.maxNetworkReconnects} 次重连 provider=${this.latestSettings.realtimeSubtitleAsrProvider} retryInMs=${delay}`,
      'warn'
    )
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null
      if (this.disposed) return
      this.logSink(
        `ASR 开始第 ${attempt}/${this.maxNetworkReconnects} 次重连 provider=${this.latestSettings.realtimeSubtitleAsrProvider}`
      )
      this.host.stop()
      this.translation.invalidate()
      this.clearTranslationDisplayHold()
      this.latestSettings = this.options.getSettings()
      // 新一轮启动可能再次立即停止；先清除上一轮错误，才能继续安排下一档退避。
      this.startupError = null
      // 宿主的同步启动错误会在 start() 返回前派发事件；先推进控制器代次，
      // 让这类事件不会被误判为旧会话而丢弃。
      this.generation += 1
      const hostGeneration = this.host.start(this.createStartOptions())
      this.generation = hostGeneration
      const snapshot = this.host.snapshot()
      if (snapshot.state === 'idle') {
        this.logSink(
          `ASR 第 ${attempt}/${this.maxNetworkReconnects} 次重连后仍处于 idle，provider=${this.latestSettings.realtimeSubtitleAsrProvider}`,
          'warn'
        )
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
    if (base.asr === 'websocket') {
      return {
        ...base,
        deepgramApiKey: null,
        webSocketUrl: this.latestSettings.realtimeSubtitleWebSocketUrl
      }
    }
    if (base.asr === 'alibaba' || base.asr === 'custom-dashscope') {
      return {
        ...base,
        dashScopeUrl: this.latestSettings.realtimeSubtitleDashScopeUrl,
        dashScopeModel: this.latestSettings.realtimeSubtitleDashScopeModel,
        dashScopeApiKey: this.options.getDashScopeApiKey?.() ?? null
      }
    }
    if (base.asr === 'custom-openai') {
      return {
        ...base,
        openAIRealtimeUrl: this.latestSettings.realtimeSubtitleOpenAIRealtimeUrl,
        openAIRealtimeModel: this.latestSettings.realtimeSubtitleOpenAIRealtimeModel,
        openAIRealtimeApiKey: this.options.getOpenAIRealtimeApiKey?.() ?? null
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
      this.clearTranslationDisplayHold()
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
    const segments = this.host.snapshot().segments
    const segment = segments.find((candidate) => candidate.id === segmentId)
    if (!segment) return
    if (phase === 'preview') {
      // 过期预览只能作用于仍处于编辑中的最新段落；历史段落已定稿时
      // 继续写 partial 会让下一句复用它并粘在上一句后面。
      if (segments.at(-1)?.id !== segmentId || segment.status !== 'partial') return
    }
    this.host.updateTranslation(
      segmentId,
      segment.translatedText + delta,
      phase === 'preview' ? 'partial' : 'translating'
    )
    this.publishTranslationUpdate(segmentId)
  }

  /**
   * 清空指定阶段的旧译文，避免 partial 内容变化后展示过期翻译。
   * @param segmentId 段落标识。
   * @param phase 预翻译或最终校正阶段。
   * @returns 无返回值。
   * @author zhenghq
   */
  private applyReset(segmentId: string, phase: SubtitleTranslationPhase): void {
    const segments = this.host.snapshot().segments
    const segment = segments.find((candidate) => candidate.id === segmentId)
    if (!segment) return
    if (phase === 'preview') {
      // final 修正原文时，宿主会先把段落切到 translating，再同步取消旧预览。
      // 此时仍必须允许清空旧译文；已定稿段落则拒绝迟到预览改写结果。
      if (
        segments.at(-1)?.id !== segmentId ||
        (segment.status !== 'partial' && segment.status !== 'translating')
      ) return
    }
    const status = phase === 'preview' && segment.status === 'partial' ? 'partial' : 'translating'
    this.host.updateTranslation(segmentId, '', status)
    this.publishTranslationUpdate(segmentId)
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
    this.publishTranslationUpdate(segmentId)
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
    this.publishTranslationUpdate(segmentId)
  }

  /**
   * 发布识别文本更新；若刚出现 final 译文，则暂缓替换以便用户读完。
   * @returns 无返回值。
   * @author zhenghq
   */
  private publishDisplayUpdate(): void {
    if (this.translationDisplayHoldTimer !== null) {
      this.translationDisplayUpdatePending = true
      const heldSegmentId = this.translationDisplayHoldSegmentId
      if (heldSegmentId) {
        // 展示锁只固定主字幕，不阻断下一句草稿进入独立的实时轨。
        this.publishPinnedSegment(this.host.snapshot(), heldSegmentId)
      }
      return
    }
    this.publish()
  }

  /**
   * 发布译文更新：当前段刷新展示计时，尚未上屏的历史段进入队列依次展示。
   * @param segmentId 译文对应的段落标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  private publishTranslationUpdate(segmentId: string): void {
    const snapshot = this.host.snapshot()
    const segment = snapshot.segments.find((candidate) => candidate.id === segmentId)
    if (!segment) return

    // 当前展示锁属于本段时，继续把流式译文刷新到这一段；即使宿主中已经
    // 创建了下一句段落，也不能让下一句把还在增长的译文挤出屏幕。
    if (this.translationDisplayHoldSegmentId === segmentId &&
        this.translationDisplayHoldTimer !== null) {
      this.scheduleTranslationDisplayHold(segmentId)
      this.publishPinnedSegment(snapshot, segmentId)
      return
    }

    // 关闭展示锁时保持原有实时行为，只展示最新段落。
    if (this.translationDisplayHoldMs <= 0) {
      if (snapshot.segments.at(-1)?.id !== segmentId) return
      this.translationDisplayUpdatePending = false
      this.publish()
      return
    }

    // final 开始时的空译文重置不进入历史队列；最新段落仍按实时原文展示。
    if (!segment.translatedText.trim()) {
      if (
        this.translationDisplayHoldTimer === null &&
        snapshot.segments.at(-1)?.id === segmentId
      ) {
        this.publish()
      }
      return
    }

    const isLatest = snapshot.segments.at(-1)?.id === segmentId
    if (this.translationDisplayHoldTimer !== null) {
      // 最新段落的流式译文先进入实时轨，同时仍按到达顺序排队，
      // 待固定展示结束后再成为主轨并进入下一次最短展示计时。
      if (isLatest && this.translationDisplayHoldSegmentId) {
        this.publishPinnedSegment(snapshot, this.translationDisplayHoldSegmentId)
      }
      if (!this.displayedTranslationSegmentIds.has(segmentId)) {
        this.enqueueTranslationDisplay(segmentId)
      }
      return
    }

    // 最新段落可以随流式增量持续刷新；历史段落只展示一次，避免旧译文回跳。
    if (isLatest) {
      this.scheduleTranslationDisplayHold(segmentId)
      this.publish()
      return
    }
    if (this.displayedTranslationSegmentIds.has(segmentId)) return
    this.enqueueTranslationDisplay(segmentId)
    this.drainTranslationDisplayQueue()
  }

  /**
   * 安排指定段落的最短展示计时；计时结束后继续展示排队译文或最新字幕。
   * @param segmentId 正在展示的段落标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  private scheduleTranslationDisplayHold(segmentId: string): void {
    this.clearTranslationDisplayHoldTimer()
    if (this.translationDisplayHoldMs <= 0) {
      this.translationDisplayHoldSegmentId = null
      return
    }
    this.displayedTranslationSegmentIds.add(segmentId)
    this.translationDisplayHoldSegmentId = segmentId
    this.translationDisplayHoldTimer = this.setTimeoutFn(() => {
      this.translationDisplayHoldTimer = null
      this.translationDisplayHoldSegmentId = null
      if (this.disposed) return
      this.drainTranslationDisplayQueue()
    }, this.translationDisplayHoldMs)
  }

  /**
   * 将已到达译文的段落加入待展示队列，使用集合去重。
   * @param segmentId 段落标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  private enqueueTranslationDisplay(segmentId: string): void {
    if (segmentId === this.translationDisplayHoldSegmentId) return
    if (this.pendingTranslationDisplaySegmentIdSet.has(segmentId)) return
    this.pendingTranslationDisplaySegmentIdSet.add(segmentId)
    this.pendingTranslationDisplaySegmentIds.push(segmentId)
  }

  /**
   * 在没有展示锁时依次展示排队译文，队列清空后补发最新实时字幕。
   * @returns 无返回值。
   * @author zhenghq
   */
  private drainTranslationDisplayQueue(): void {
    if (this.disposed || this.translationDisplayHoldTimer !== null) return
    while (this.pendingTranslationDisplaySegmentIds.length > 0) {
      const segmentId = this.pendingTranslationDisplaySegmentIds.shift()
      if (!segmentId) continue
      this.pendingTranslationDisplaySegmentIdSet.delete(segmentId)
      const snapshot = this.host.snapshot()
      const segment = snapshot.segments.find((candidate) => candidate.id === segmentId)
      // 自动清屏或段落上限可能已移除旧段落，跳过失效标识继续处理后续译文。
      if (!segment || !segment.translatedText.trim()) continue
      this.scheduleTranslationDisplayHold(segmentId)
      if (snapshot.segments.at(-1)?.id === segmentId) {
        this.publish()
      } else {
        this.publishPinnedSegment(snapshot, segmentId)
      }
      return
    }
    this.translationDisplayUpdatePending = false
    // 展示锁到期后必须回到宿主最新段落;即使期间没有新的识别事件,
    // 也要解除 pinned 快照,否则字幕会永久停在上一句。
    this.publish()
  }

  /**
   * 发布指定段落作为展示锁主轨，同时保留最新段落供实时轨并行展示。
   * @param snapshot 宿主当前快照。
   * @param segmentId 需要固定在末尾展示的段落标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  private publishPinnedSegment(snapshot: RealtimeSubtitleSnapshot, segmentId: string): void {
    const segment = snapshot.segments.find((candidate) => candidate.id === segmentId)
    if (!segment) {
      this.publish()
      return
    }
    const pinned: RealtimeSubtitleSnapshot = {
      ...snapshot,
      sourceText: segment.sourceText,
      translatedText: segment.translatedText,
      displaySegmentId: segmentId
    }
    this.publishSnapshot(this.mergeStartupError(pinned))
  }

  /**
   * 只清除译文最短展示计时，保留待补发状态与当前展示段标识。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearTranslationDisplayHoldTimer(): void {
    if (this.translationDisplayHoldTimer === null) return
    this.clearTimeoutFn(this.translationDisplayHoldTimer)
    this.translationDisplayHoldTimer = null
  }

  /**
   * 清除译文展示计时、待补发状态、待展示队列与已展示段落记录。
   * @returns 无返回值。
   * @author zhenghq
   */
  private clearTranslationDisplayHold(): void {
    this.clearTranslationDisplayHoldTimer()
    this.translationDisplayHoldSegmentId = null
    this.translationDisplayUpdatePending = false
    this.pendingTranslationDisplaySegmentIds.length = 0
    this.pendingTranslationDisplaySegmentIdSet.clear()
    this.displayedTranslationSegmentIds.clear()
  }

  /**
   * 发布最新快照。
   * @returns 当前快照。
   * @author zhenghq
   */
  private publish(): RealtimeSubtitleSnapshot {
    const snapshot = this.mergeStartupError(this.host.snapshot())
    return this.publishSnapshot(snapshot)
  }

  /**
   * 记录并推送字幕快照，确保视图模型与字幕窗渲染使用同一份内容。
   * @param snapshot 待推送快照。
   * @returns 已推送的快照。
   * @author zhenghq
   */
  private publishSnapshot(snapshot: RealtimeSubtitleSnapshot): RealtimeSubtitleSnapshot {
    this.lastPublishedSnapshot = snapshot
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
    return this.publishSnapshot(merged)
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
