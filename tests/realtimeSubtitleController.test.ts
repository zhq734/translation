import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeSubtitleController } from '../src/main/realtimeSubtitleController.ts'
import type {
  RealtimeSubtitleAudioSource,
  RealtimeSubtitleAsrProvider,
  RealtimeSubtitleDisplayMode,
  RealtimeSubtitleSegment,
  RealtimeSubtitleSessionState,
  RealtimeSubtitleSnapshot,
  SubtitleSidecarEvent
} from '../src/shared/subtitleSession.ts'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/shared/settingsDefaults.ts'
import { splitSubtitleCue } from '../src/shared/subtitleSession.ts'
import type { Settings } from '../src/shared/types.ts'
import {
  resolveSubtitleReconnectDelay,
  shouldReconnectSubtitle,
  SUBTITLE_MAX_NETWORK_RECONNECTS
} from '../src/shared/subtitleReconnect.ts'

/** 控制器测试使用的可脚本化会话宿主。 */
class FakeHost {
  private state: RealtimeSubtitleSessionState = 'idle'
  private audioSource: RealtimeSubtitleAudioSource = 'system'
  private sourceText = ''
  private translatedText = ''
  private audioActivity: 'idle' | 'speech-pending' | 'speech-detected' = 'idle'
  private segments: RealtimeSubtitleSegment[] = []
  private sequence = 0
  private generation = 0
  private error: string | undefined

  /** 记录 start 参数。 */
  starts: Array<{
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
    geminiUrl?: string
    geminiModel?: string
    geminiApiKey?: string | null
    targetLang?: string
  }> = []
  /** 记录 pause/resume/stop 调用。 */
  calls: string[] = []
  /** 接收 sidecar 事件。 */
  onEvent: (event: SubtitleSidecarEvent, generation: number) => void = () => undefined
  /** 当前显示模式提供器。 */
  getDisplayMode: () => RealtimeSubtitleDisplayMode = () => 'bilingual'
  /** dispose 是否已执行。 */
  disposed = false

  /**
   * 模拟启动 sidecar。
   * @param options 启动参数。
   * @returns 新会话代次。
   * @author zhenghq
   */
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
    geminiUrl?: string
    geminiModel?: string
    geminiApiKey?: string | null
    targetLang?: string
  }): number {
    this.starts.push(options)
    this.generation += 1
    this.audioSource = options.source
    this.state = 'starting'
    this.sourceText = ''
    this.translatedText = ''
    this.audioActivity = 'idle'
    this.segments = []
    this.error = undefined
    return this.generation
  }

  /** 模拟暂停。 */
  pause(): void {
    this.calls.push('pause')
    this.state = 'paused'
  }

  /** 模拟恢复。 */
  resume(): void {
    this.calls.push('resume')
    this.state = 'running'
  }

  /** 模拟停止。 */
  stop(): void {
    this.calls.push('stop')
    this.state = 'idle'
  }

  /** 模拟释放。 */
  dispose(): void {
    this.disposed = true
    this.state = 'idle'
  }

  /** 模拟翻译状态更新。 */
  updateTranslation(
    segmentId: string,
    translatedText: string,
    status: RealtimeSubtitleSegment['status']
  ): void {
    const segment = this.segments.find((candidate) => candidate.id === segmentId)
    if (!segment) return
    segment.translatedText = translatedText
    segment.status = status
    segment.updatedAt = Date.now()
    this.translatedText = translatedText
  }

  /** 模拟自动隐藏时清空当前显示内容。 */
  clearDisplay(): void {
    this.sourceText = ''
    this.translatedText = ''
    this.segments = []
  }

  /** 模拟快照。 */
  snapshot(): RealtimeSubtitleSnapshot {
    return {
      state: this.state,
      audioSource: this.audioSource,
      displayMode: this.getDisplayMode(),
      windowVisible: this.state !== 'idle',
      sourceText: this.sourceText,
      translatedText: this.translatedText,
      audioActivity: this.audioActivity,
      segments: this.segments.map((segment) => ({ ...segment })),
      ...(this.error ? { error: this.error } : {})
    }
  }

  /**
   * 发送 sidecar 事件并同步宿主快照。
   * @param event sidecar 事件。
   * @author zhenghq
   */
  emit(event: SubtitleSidecarEvent): void {
    if (event.type === 'ready') {
      this.state = 'running'
    } else if (event.type === 'partial') {
      this.audioActivity = 'speech-detected'
      const active = this.segments.find((segment) => segment.status === 'partial')
      if (active) {
        active.sourceText = event.text
        if (event.translatedText) active.translatedText = event.translatedText
        active.updatedAt = Date.now()
      } else {
        this.segments.push({
          id: `segment-${++this.sequence}`,
          sourceText: event.text,
          translatedText: event.translatedText ?? '',
          status: 'partial',
          updatedAt: Date.now()
        })
      }
      this.sourceText = event.text
      if (event.translatedText) this.translatedText = event.translatedText
    } else if (event.type === 'final') {
      this.audioActivity = 'speech-detected'
      const active = this.segments.find((segment) => segment.status === 'partial')
      if (active) {
        active.sourceText = event.text
        active.translatedText = event.translatedText ?? active.translatedText
        active.status = event.translatedText ? 'translated' : 'translating'
        active.updatedAt = Date.now()
      } else {
        this.segments.push({
          id: `segment-${++this.sequence}`,
          sourceText: event.text,
          translatedText: event.translatedText ?? '',
          status: event.translatedText ? 'translated' : 'translating',
          updatedAt: Date.now()
        })
      }
      this.sourceText = event.text
      this.translatedText = event.translatedText ?? ''
    } else if (event.type === 'level') {
      // 人声判定由上游 ASR/VAD 负责，客户端电平事件不驱动本地状态。
      return
    } else if (event.type === 'error') {
      this.error = event.message ?? event.code
      this.state = 'idle'
    } else if (event.type === 'status') {
      this.state = event.state
    }
    this.onEvent(event, this.generation)
  }
}

/**
 * 创建可记录窗口和广播行为的控制器依赖。
 * @returns 测试依赖与观察数组。
 * @author zhenghq
 */
function createHarness(
  overrides: Partial<Settings> = {},
  options: {
    previewDebounceMs?: number
    previewMinIntervalMs?: number
    finalMaxAttempts?: number
    finalRetryBaseDelayMs?: number
    finalRequestDeadlineMs?: number
    maxConcurrentFinalRequests?: number
    maxQueuedFinalRequests?: number
    translationDisplayHoldMs?: number
    whisperApiKey?: string | null
    dashScopeApiKey?: string | null
    openAIRealtimeApiKey?: string | null
    geminiApiKey?: string | null
    logs?: string[]
  } = {}
) {
  const host = new FakeHost()
  const broadcasts: RealtimeSubtitleSnapshot[] = []
  const windowStates: boolean[] = []
  const settings = normalizeSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    targetLang: 'zh-CN',
    ...overrides
  })
  const translateCalls: Array<{
    text: string
    sourceLang: string | undefined
    id: string
    iTranslateApiKey: string | null | undefined
  }> = []
  const pendingTranslations: Array<{
    text: string
    onDelta: (delta: string) => void
    resolve: () => void
    reject: (error: Error) => void
  }> = []
  let resolveTranslation: (() => void) | null = null
  let rejectTranslation: ((error: Error) => void) | null = null
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = []
  const controller = new RealtimeSubtitleController({
    createHost: (onEvent) => {
      host.onEvent = onEvent
      return host
    },
    getSettings: () => settings,
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    getWhisperApiKey: () => options.whisperApiKey ?? null,
    getDashScopeApiKey: () => options.dashScopeApiKey ?? null,
    getOpenAIRealtimeApiKey: () => options.openAIRealtimeApiKey ?? null,
    getGeminiApiKey: () => options.geminiApiKey ?? null,
    getITranslateApiKey: () => 'it-secret',
    previewDebounceMs: options.previewDebounceMs,
    previewMinIntervalMs: options.previewMinIntervalMs,
    finalMaxAttempts: options.finalMaxAttempts ?? 1,
    finalRetryBaseDelayMs: options.finalRetryBaseDelayMs,
    finalRequestDeadlineMs: options.finalRequestDeadlineMs,
    maxConcurrentFinalRequests: options.maxConcurrentFinalRequests,
    maxQueuedFinalRequests: options.maxQueuedFinalRequests,
    translationDisplayHoldMs: options.translationDisplayHoldMs ?? 0,
    log: (message) => options.logs?.push(message),
    translateStream: async (text, _settings, _dingTalk, _apiKey, options, iTranslateApiKey) => {
      translateCalls.push({
        text,
        sourceLang: _settings.sourceLang,
        id: text,
        iTranslateApiKey
      })
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        }, { once: true })
        const pending = {
          text,
          onDelta: options.onDelta,
          resolve: () => resolve({ translation: '' } as never),
          reject
        }
        pendingTranslations.push(pending)
        resolveTranslation = () => {
          pending.onDelta('你好')
          pending.resolve()
        }
        rejectTranslation = reject
      })
    },
    onSnapshot: (snapshot) => broadcasts.push(snapshot),
    setWindowVisible: (visible) => windowStates.push(visible),
    setTimeoutFn: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    }
  })
  return {
    controller,
    host,
    settings,
    broadcasts,
    windowStates,
    translateCalls,
    timers,
    /** 按原文结束指定的在途翻译，并推送自定义译文。 */
    finishTranslationFor: (text: string, translation: string) => {
      const pending = pendingTranslations.find((candidate) => candidate.text === text)
      if (!pending) throw new Error(`no pending translation for ${text}`)
      pending.onDelta(translation)
      pending.resolve()
    },
    runNextReconnect: () => {
      const timer = timers.find((candidate) => !candidate.cleared)
      if (!timer) throw new Error('no pending reconnect timer')
      timer.cleared = true
      timer.callback()
    },
    finishTranslation: () => resolveTranslation?.(),
    failTranslation: (error: Error) => rejectTranslation?.(error)
  }
}

/** 等待翻译协调器完成一个事件循环。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * 等待条件成立，避免全量测试并发负载下把调度延迟误判为业务失败。
 * @param predicate 条件判断函数。
 * @param attempts 最大轮询次数。
 * @returns 条件成立时 resolve；超过次数后使测试失败。
 * @author zhenghq
 */
async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await flush()
  }
  assert.fail('等待条件超时')
}

/**
 * 校验 partial 稳定后即翻译当前可见 cue，final 到达后复用同文结果。
 * @returns 无返回值。
 * @author zhenghq
 */
test('partial 应翻译当前可见 cue 且 final 复用结果', async () => {
  const harness = createHarness({}, { previewDebounceMs: 0 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'partial', text: 'Hello', lang: 'en-US' })
  assert.equal(harness.controller.snapshot().sourceText, 'Hello')
  await waitFor(() => harness.translateCalls.length === 1)
  assert.deepEqual(harness.translateCalls.map((call) => call.text), ['Hello'])
  assert.equal(harness.translateCalls[0]?.sourceLang, 'en-US')
  assert.equal(harness.translateCalls[0]?.iTranslateApiKey, 'it-secret')
  harness.finishTranslationFor('Hello', '你好')
  await waitFor(() => harness.controller.viewModel().translatedText === '你好')

  harness.host.emit({ type: 'final', text: 'Hello', lang: 'en-US' })
  await harness.controller.idle()
  assert.deepEqual(harness.translateCalls.map((call) => call.text), ['Hello'])
  const segment = harness.controller.snapshot().segments[0]
  assert.equal(segment?.translatedText, '你好')
  assert.equal(segment?.status, 'translated')
  assert.equal(harness.controller.snapshot().translatedText, '你好')
})

/**
 * 校验连续 partial 的预览请求合并到最新可见 cue，final 修正后翻译最终文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 partial 应合并预览请求且 final 翻译最终文本', async () => {
  const harness = createHarness({}, { previewDebounceMs: 300 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'partial', text: 'Hello', lang: 'en-US' })
  harness.host.emit({ type: 'partial', text: 'Hello world', lang: 'en-US' })
  await flush()
  assert.deepEqual(harness.translateCalls, [])
  const previewTimer = harness.timers.find((timer) => timer.delayMs === 300 && !timer.cleared)
  assert.ok(previewTimer)
  previewTimer.callback()
  await waitFor(() => harness.translateCalls.length === 1)
  assert.deepEqual(harness.translateCalls.map((call) => call.text), ['Hello world'])

  harness.host.emit({ type: 'final', text: 'Hello world!', lang: 'en-US' })
  await flush()
  assert.deepEqual(harness.translateCalls.map((call) => call.text), ['Hello world', 'Hello world!'])
  harness.finishTranslationFor('Hello world', '你好，世界')
  await flush()
  harness.finishTranslationFor('Hello world!', '你好，世界！')
  await harness.controller.idle()
})

/**
 * 校验累计 partial 变长时只翻译显示层最近 cue，而不是整段草稿。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长 partial 应只翻译最近可见 cue', async () => {
  const harness = createHarness({}, { previewDebounceMs: 0 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  const text = '第一句已经确认。第二句仍在识别中而且内容已经很长需要只显示最近一段实时草稿文本'
  harness.host.emit({ type: 'partial', text, lang: 'zh-CN' })
  await waitFor(() => harness.translateCalls.length === 1)

  const visibleText = splitSubtitleCue(text, { maxLength: 32 }).at(-1)
  assert.ok(visibleText)
  assert.deepEqual(harness.translateCalls.map((call) => call.text), [visibleText])
  assert.equal(harness.controller.viewModel().sourceText, visibleText)

  harness.finishTranslationFor(visibleText, '当前草稿译文')
  await waitFor(() => harness.controller.viewModel().translatedText === '当前草稿译文')
})

/**
 * 校验 partial 进入下一条可见 cue 时会清空上一条 cue 的预览译文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('partial 切换可见 cue 时应清空旧预览译文', async () => {
  const harness = createHarness({}, { previewDebounceMs: 0 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({
    type: 'partial',
    text: '第一句已经确认。',
    lang: 'zh-CN'
  })
  await waitFor(() => harness.translateCalls.length === 1)
  harness.finishTranslationFor('第一句已经确认。', '第一句译文。')
  await waitFor(() => harness.controller.viewModel().translatedText === '第一句译文。')

  harness.host.emit({
    type: 'partial',
    text: '第一句已经确认。第二句仍在识别中',
    lang: 'zh-CN'
  })
  await flush()
  assert.equal(harness.controller.viewModel().sourceText, '第二句仍在识别中')
  assert.equal(harness.controller.viewModel().translatedText, '')
})

/**
 * 校验 final 修正 partial 原文后只翻译确认后的整句。
 * @returns 无返回值。
 * @author zhenghq
 */
test('final 原文变化应翻译修正后的整句', async () => {
  const harness = createHarness({}, { previewDebounceMs: 0 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'partial', text: 'Hello', lang: 'en-US' })
  await waitFor(() => harness.translateCalls.length === 1)
  harness.finishTranslationFor('Hello', '你好')
  await waitFor(() => harness.controller.viewModel().translatedText === '你好')

  harness.host.emit({ type: 'final', text: 'Hello world', lang: 'en-US' })
  await flush()

  assert.deepEqual(harness.translateCalls.map((call) => call.text), ['Hello', 'Hello world'])
  assert.equal(harness.controller.snapshot().segments.at(-1)?.translatedText, '')

  harness.finishTranslationFor('Hello world', '你好，世界')
  await harness.controller.idle()
  assert.equal(harness.controller.snapshot().translatedText, '你好，世界')
  assert.equal(harness.controller.snapshot().segments.at(-1)?.status, 'translated')
})

/**
 * 校验 final 译文会保持最短展示时间，避免下一句 partial 立刻覆盖。
 * @returns 无返回值。
 * @author zhenghq
 */
test('final 译文应保持最短展示时间后再显示下一句', async () => {
  const harness = createHarness({}, { translationDisplayHoldMs: 1500 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'partial', text: 'Hello', lang: 'en-US' })
  harness.host.emit({ type: 'final', text: 'Hello', lang: 'en-US' })
  await flush()
  harness.finishTranslation()
  await harness.controller.idle()

  assert.equal(harness.broadcasts.at(-1)?.segments.at(-1)?.translatedText, '你好')
  harness.host.emit({ type: 'partial', text: 'Next sentence', lang: 'en-US' })
  assert.equal(harness.controller.viewModel().sourceText, 'Hello')
  assert.equal(harness.controller.viewModel().translatedText, '你好')
  assert.equal(harness.controller.viewModel().live?.sourceText, 'Next sentence')
  assert.deepEqual(
    harness.broadcasts.at(-1)?.segments.map((segment) => segment.sourceText),
    ['Hello', 'Next sentence'],
    '展示锁不应打乱段落的时间顺序'
  )

  const holdTimer = harness.timers.find((timer) => !timer.cleared && timer.delayMs === 1500)
  assert.ok(holdTimer, '应安排译文最短展示计时器')
  holdTimer.callback()
  assert.equal(harness.controller.viewModel().sourceText, 'Next sentence')
  assert.equal(harness.controller.viewModel().committed?.sourceText, 'Hello')
  assert.equal(harness.controller.viewModel().live, null)
})

/**
 * 校验上一句迟到译文不会打断当前展示，但会在当前展示结束后补上。
 * @returns 无返回值。
 * @author zhenghq
 */
test('上一句迟到译文应排队展示而不是被丢弃', async () => {
  const harness = createHarness({}, { translationDisplayHoldMs: 1500 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'final', text: 'First', lang: 'en-US' })
  harness.host.emit({ type: 'final', text: 'Second', lang: 'en-US' })
  await flush()

  harness.finishTranslationFor('First', '第一句译文')
  await flush()

  assert.equal(harness.controller.viewModel().sourceText, 'First')
  assert.equal(harness.controller.viewModel().translatedText, '第一句译文')
  const firstHoldTimer = harness.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 1500
  )
  assert.ok(firstHoldTimer, '迟到译文上屏后也应进入最短展示计时')

  harness.finishTranslationFor('Second', '第二句译文')
  await harness.controller.idle()

  assert.equal(harness.controller.viewModel().sourceText, 'First')
  assert.equal(harness.controller.viewModel().translatedText, '第一句译文')
  assert.equal(firstHoldTimer.cleared, false, '后到译文不得提前打断当前句展示')

  firstHoldTimer.callback()

  assert.equal(harness.controller.viewModel().sourceText, 'Second')
  assert.equal(harness.controller.viewModel().translatedText, '第二句译文')
})

/**
 * 校验连续 final 的译文按顺序逐条展示，前面段落的译文不得静默丢失。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 final 的译文应逐条展示且不丢失', async () => {
  const harness = createHarness({}, { translationDisplayHoldMs: 1500 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'final', text: 'First', lang: 'en-US' })
  harness.host.emit({ type: 'final', text: 'Second', lang: 'en-US' })
  harness.host.emit({ type: 'final', text: 'Third', lang: 'en-US' })
  await flush()

  harness.finishTranslationFor('First', '第一句译文')
  await flush()
  // final 请求串行执行；前一段结束后队列才会启动下一段。
  await flush()
  harness.finishTranslationFor('Second', '第二句译文')
  await flush()
  await flush()
  harness.finishTranslationFor('Third', '第三句译文')
  await harness.controller.idle()

  assert.equal(harness.controller.viewModel().sourceText, 'First')
  assert.equal(harness.controller.viewModel().translatedText, '第一句译文')

  const firstHoldTimer = harness.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 1500
  )
  assert.ok(firstHoldTimer, '第一句译文应进入最短展示计时')
  firstHoldTimer.callback()

  assert.equal(harness.controller.viewModel().sourceText, 'Second')
  assert.equal(harness.controller.viewModel().translatedText, '第二句译文')

  const secondHoldTimer = harness.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 1500
  )
  assert.ok(secondHoldTimer, '第二句译文应进入最短展示计时')
  secondHoldTimer.callback()

  assert.equal(harness.controller.viewModel().sourceText, 'Third')
  assert.equal(harness.controller.viewModel().translatedText, '第三句译文')
})

/**
 * 校验当前句译文展示期间，下一句 final 译文应排队到计时结束后再替换。
 * @returns 无返回值。
 * @author zhenghq
 */
test('下一句 final 译文应等待当前译文展示结束再替换', async () => {
  const harness = createHarness({}, { translationDisplayHoldMs: 1500 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'final', text: 'First', lang: 'en-US' })
  await flush()
  harness.finishTranslationFor('First', '第一句译文')
  await harness.controller.idle()

  assert.equal(harness.controller.viewModel().sourceText, 'First')
  assert.equal(harness.controller.viewModel().translatedText, '第一句译文')
  const firstHoldTimer = harness.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 1500
  )
  assert.ok(firstHoldTimer, '第一句译文应进入最短展示计时')

  harness.host.emit({ type: 'final', text: 'Second', lang: 'en-US' })
  await flush()
  harness.finishTranslationFor('Second', '第二句译文')
  await harness.controller.idle()

  assert.equal(harness.controller.viewModel().sourceText, 'First')
  assert.equal(harness.controller.viewModel().translatedText, '第一句译文')
  assert.equal(firstHoldTimer.cleared, false, '下一句译文不得提前取消当前句展示计时')

  firstHoldTimer.callback()

  assert.equal(harness.controller.viewModel().sourceText, 'Second')
  assert.equal(harness.controller.viewModel().translatedText, '第二句译文')
  const secondHoldTimer = harness.timers
    .filter((timer) => !timer.cleared && timer.delayMs === 1500)
    .at(-1)
  assert.ok(secondHoldTimer, '第二句译文上屏后也应进入最短展示计时')
  assert.notEqual(secondHoldTimer, firstHoldTimer)
})

/**
 * 校验并发翻译乱序完成时，后一句译文必须等待前一句先上屏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('并发 final 译文乱序完成时仍应按原文顺序展示', async () => {
  const harness = createHarness({}, { translationDisplayHoldMs: 700 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'final', text: 'First', lang: 'en-US' })
  harness.host.emit({ type: 'final', text: 'Second', lang: 'en-US' })
  await waitFor(() => harness.translateCalls.length === 2)
  assert.deepEqual(
    harness.translateCalls.map((call) => call.text),
    ['First', 'Second'],
    '默认并发 2 应同时启动前两句翻译'
  )

  harness.finishTranslationFor('Second', '第二句译文')
  await flush()
  assert.equal(harness.controller.viewModel().sourceText, 'Second')
  assert.equal(
    harness.controller.viewModel().translatedText,
    '',
    '前一句仍在翻译时不得先展示后一句译文'
  )

  harness.finishTranslationFor('First', '第一句译文')
  await harness.controller.idle()
  assert.equal(harness.controller.viewModel().sourceText, 'First')
  assert.equal(harness.controller.viewModel().translatedText, '第一句译文')

  const firstHoldTimer = harness.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 700
  )
  assert.ok(firstHoldTimer, '第一句译文上屏后应进入展示锁')
  firstHoldTimer.callback()

  assert.equal(harness.controller.viewModel().sourceText, 'Second')
  assert.equal(harness.controller.viewModel().translatedText, '第二句译文')
})

/**
 * 校验服务端拆句后的多条 final 会逐条翻译，界面只保留最后一句及其译文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 final 应逐条翻译且不把前一句译文带入最后一句', async () => {
  const harness = createHarness()
  const sentences = [
    '蔡永嘉,你听明白了吗?',
    '听明白了,一会儿行政大队就去忍。',
    '你们把李小交接,是。'
  ]
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'partial', text: sentences.join(''), lang: 'zh' })
  for (const sentence of sentences) {
    harness.host.emit({ type: 'final', text: sentence, lang: 'zh' })
  }

  const snapshot = harness.controller.snapshot()
  assert.equal(snapshot.segments.length, 3)
  assert.deepEqual(
    snapshot.segments.map((segment) => segment.sourceText),
    sentences
  )
  assert.equal(snapshot.translatedText, '')
  assert.equal(harness.controller.viewModel().sourceText, sentences[2])
  assert.equal(harness.controller.viewModel().translatedText, '')

  await flush()
  assert.deepEqual(
    harness.translateCalls.map((call) => call.text),
    sentences.slice(0, 2),
    '默认并发 2 时应先启动前两段 final 翻译'
  )

  const translations = ['译文一', '译文二', '译文三']
  for (const [index, sentence] of sentences.entries()) {
    await waitFor(
      () => harness.translateCalls.length === Math.min(index + 2, sentences.length)
    )
    assert.deepEqual(
      harness.translateCalls.map((call) => call.text),
      sentences.slice(0, Math.min(index + 2, sentences.length)),
      '前一段完成后应继续补满 final 并发槽位'
    )
    harness.finishTranslationFor(sentence, translations[index] ?? '')
    await flush()
  }
  await harness.controller.idle()

  assert.deepEqual(
    harness.controller.snapshot().segments.map((segment) => segment.translatedText),
    translations,
    '每条 final 应各自持有译文，不得把前一句译文拼进下一句'
  )
  assert.equal(harness.controller.viewModel().sourceText, sentences[2])
  assert.equal(harness.controller.viewModel().translatedText, translations[2])
})

/**
 * 校验宿主拆分后的多个 final 会各自成为字幕并逐条翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
test('拆分后的多个 final 应逐条翻译并保留独立译文', async () => {
  const harness = createHarness()
  const cues = ['第一句。', '第二句！']
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  for (const cue of cues) harness.host.emit({ type: 'final', text: cue, lang: 'zh' })
  await flush()

  assert.equal(harness.controller.snapshot().segments.length, 2)
  assert.deepEqual(
    harness.controller.snapshot().segments.map((segment) => segment.sourceText),
    cues
  )
  assert.deepEqual(harness.translateCalls.map((call) => call.text), cues)

  harness.finishTranslationFor(cues[0]!, '第一句译文。')
  await flush()
  harness.finishTranslationFor(cues[1]!, '第二句译文！')
  await harness.controller.idle()
  assert.deepEqual(
    harness.controller.snapshot().segments.map((segment) => segment.translatedText),
    ['第一句译文。', '第二句译文！']
  )
})

/**
 * 校验超长 final 拆出的每条字幕各自翻译，结果写回对应段落。
 * @returns 无返回值。
 * @author zhenghq
 */
test('超长 final 应逐 cue 翻译且每条字幕保留自己的译文', async () => {
  const harness = createHarness({}, { finalMaxAttempts: 1 })
  const text = [
    '淋巴结宫的成长通道还可以报考养老服务师也可以走向管理岗位取得养老服务师职业资格证书的',
    '可以在养老服务机构内就业也可以在相关企业单位',
    '包括老年人能力评估机构是老化改造企业老年教育培培训机构老年产品用品生产流通企业就业',
    '截至二零二五年底全国，例如这个，有时拆分的是合理的'
  ].join('')
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  const cues = splitSubtitleCue(text)
  for (const cue of cues) harness.host.emit({ type: 'final', text: cue, lang: 'zh' })
  await flush()

  const segments = harness.controller.snapshot().segments
  assert.ok(segments.length > 1, `超长 final 应拆成多条字幕，实际 ${segments.length} 条`)
  assert.equal(segments.map((segment) => segment.sourceText).join(''), text)
  assert.deepEqual(segments.map((segment) => segment.sourceText), cues)
  assert.deepEqual(
    harness.translateCalls.map((call) => call.text),
    segments.slice(0, 2).map((segment) => segment.sourceText)
  )

  for (const [index, segment] of segments.entries()) {
    harness.finishTranslationFor(segment.sourceText, `译文-${index + 1}`)
    await flush()
  }
  await harness.controller.idle()

  assert.deepEqual(
    harness.translateCalls.map((call) => call.text),
    segments.map((segment) => segment.sourceText),
    '并发槽位释放后应按原文顺序启动后续 cue 翻译'
  )
  assert.deepEqual(
    harness.controller.snapshot().segments.map((segment) => segment.translatedText),
    segments.map((_, index) => `译文-${index + 1}`)
  )
})

/**
 * 校验音频电平不会触发客户端本地的人声判定或状态广播。
 * @returns 无返回值。
 * @author zhenghq
 */
test('音频电平不应触发本地 speech-pending 状态', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  const broadcastCount = harness.broadcasts.length
  harness.host.emit({ type: 'level', rms: 0.95 })

  assert.equal(harness.controller.snapshot().audioActivity, 'idle')
  assert.equal(harness.broadcasts.length, broadcastCount)
  assert.equal(harness.controller.viewModel().audioActivity, 'idle')
})

/**
 * 校验最后一条字幕在无新识别文本时按配置自动清空，并在新语音到达后恢复显示。
 * @returns 无返回值。
 * @author zhenghq
 */
test('长时间无新字幕时应自动隐藏旧字幕并在新识别后恢复', () => {
  const harness = createHarness({ realtimeSubtitleHideAfterMs: 8000 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'final', text: 'Hello', lang: 'en' })

  assert.equal(harness.controller.snapshot().sourceText, 'Hello')
  const hideTimer = harness.timers.find((timer) => timer.delayMs === 8000)
  assert.ok(hideTimer, '应安排字幕自动隐藏计时器')
  hideTimer.callback()

  assert.equal(harness.controller.snapshot().sourceText, '')
  assert.equal(harness.controller.snapshot().translatedText, '')
  assert.equal(harness.controller.snapshot().segments.length, 0)
  assert.equal(harness.controller.snapshot().state, 'running')
  assert.equal(harness.windowStates.at(-1), true, '自动隐藏只清空文本，不应关闭字幕窗口')
  assert.equal(harness.controller.viewModel().empty, true)

  harness.host.emit({ type: 'partial', text: 'Next sentence', lang: 'en' })
  assert.equal(harness.controller.snapshot().sourceText, 'Next sentence')
  assert.equal(harness.controller.viewModel().empty, false)
})

/**
 * 校验新 partial/final 会重置自动隐藏计时，避免一句长语音过早清屏。
 * @returns 无返回值。
 * @author zhenghq
 */
test('新识别文本应重置字幕自动隐藏计时', () => {
  const harness = createHarness({ realtimeSubtitleHideAfterMs: 8000 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'partial', text: 'Hello', lang: 'en' })
  const firstTimer = harness.timers.find(
    (timer) => timer.delayMs === 8000 && !timer.cleared
  )
  assert.equal(firstTimer?.delayMs, 8000)

  harness.host.emit({ type: 'partial', text: 'Hello world', lang: 'en' })
  assert.equal(firstTimer?.cleared, true, '更新识别文本时应取消上一轮计时')
  const nextTimer = harness.timers.find(
    (timer) => timer.delayMs === 8000 && !timer.cleared
  )
  assert.equal(nextTimer?.delayMs, 8000)
  assert.notEqual(nextTimer, firstTimer)
})

/**
 * 校验显式关闭自动隐藏时不创建计时器，保持用户选择。
 * @returns 无返回值。
 * @author zhenghq
 */
test('自动隐藏时长为 0 时不应创建清屏计时器', () => {
  const harness = createHarness({ realtimeSubtitleHideAfterMs: 0 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'final', text: 'Hello', lang: 'en' })

  assert.equal(harness.timers.length, 0)
  assert.equal(harness.controller.snapshot().sourceText, 'Hello')
})

/**
 * 校验运行中修改自动隐藏时长会取消旧计时器，并按新时长重新计时。
 * @returns 无返回值。
 * @author zhenghq
 */
test('运行中修改自动隐藏时长应重新安排当前字幕计时', () => {
  const harness = createHarness({ realtimeSubtitleHideAfterMs: 8000 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'partial', text: 'Hello', lang: 'en' })
  const previousTimer = harness.timers.find(
    (timer) => timer.delayMs === 8000 && !timer.cleared
  )

  harness.controller.applySettings({
    ...harness.settings,
    realtimeSubtitleHideAfterMs: 3000
  })

  assert.equal(previousTimer?.cleared, true, '修改时长时应取消旧计时器')
  assert.equal(harness.timers.at(-1)?.delayMs, 3000)
  assert.notEqual(harness.timers.at(-1), previousTimer)
})

/**
 * 校验没有可清空字幕时修改自动隐藏时长不会创建空计时器。
 * @returns 无返回值。
 * @author zhenghq
 */
test('无字幕内容时修改自动隐藏时长不应创建清屏计时器', () => {
  const harness = createHarness({ realtimeSubtitleHideAfterMs: 8000 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })

  harness.controller.applySettings({
    ...harness.settings,
    realtimeSubtitleHideAfterMs: 3000
  })

  assert.equal(harness.timers.length, 0)
})

/**
 * 校验暂停和停止会取消自动隐藏计时，避免后台会话误改状态。
 * @returns 无返回值。
 * @author zhenghq
 */
test('暂停或停止时应取消字幕自动隐藏计时', () => {
  const harness = createHarness({ realtimeSubtitleHideAfterMs: 8000 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'final', text: 'Hello', lang: 'en' })
  const pauseTimer = harness.timers.at(-1)

  harness.controller.pause()
  assert.equal(pauseTimer?.cleared, true)

  harness.controller.resume()
  harness.host.emit({ type: 'final', text: 'Again', lang: 'en' })
  const stopTimer = harness.timers.at(-1)
  harness.controller.stop()
  assert.equal(stopTimer?.cleared, true)
})

/**
 * 校验停止会取消在途翻译并关闭字幕窗口。
 * @returns 无返回值。
 * @author zhenghq
 */
test('停止实时字幕应取消迟到译文并隐藏窗口', async () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'final', text: 'Hello', lang: 'en' })
  await flush()
  harness.controller.stop()
  harness.finishTranslation()
  await harness.controller.idle()
  assert.equal(harness.controller.snapshot().state, 'idle')
  assert.equal(harness.controller.snapshot().segments[0]?.status, 'translating')
  assert.equal(harness.windowStates.at(-1), false)
  assert.deepEqual(harness.host.calls, ['stop'])
})

/**
 * 校验单段翻译失败只标记该段，不终止实时识别。
 * @returns 无返回值。
 * @author zhenghq
 */
test('单段翻译失败不应停止实时字幕会话', async () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'final', text: 'Hello', lang: 'en' })
  await flush()
  harness.failTranslation(new Error('network down'))
  await harness.controller.idle()
  const segment = harness.controller.snapshot().segments[0]
  assert.equal(segment?.status, 'error')
  assert.equal(segment?.translatedText, '')
  assert.equal(harness.controller.snapshot().state, 'running')
})

/**
 * 校验设置变化可同步显示模式、点击穿透和字幕窗口样式。
 * @returns 无返回值。
 * @author zhenghq
 */
test('设置变化应同步字幕窗口显示参数', () => {
  const harness = createHarness()
  const patches: Array<Record<string, unknown>> = []
  harness.controller.setWindowAppearanceSink((appearance) => patches.push(appearance))
  harness.controller.applySettings({
    ...harness.settings,
    realtimeSubtitleDisplayMode: 'target',
    realtimeSubtitleFontSize: 28,
    realtimeSubtitleTextColor: '#abcdef',
    realtimeSubtitleClickThrough: false
  })
  assert.deepEqual(patches.at(-1), {
    displayMode: 'target',
    fontSize: 28,
    textColor: '#abcdef',
    clickThrough: false
  })
})

/**
 * 校验运行中切换 ASR 提供商应停止旧会话，并用新配置重新启动。
 * @returns 无返回值。
 * @author zhenghq
 */
test('运行中切换 Whisper 应重启实时字幕会话', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })

  harness.controller.applySettings({
    ...harness.settings,
    realtimeSubtitleAsrProvider: 'whisper',
    realtimeSubtitleWhisperBaseUrl: 'http://127.0.0.1:9000/v1',
    realtimeSubtitleWhisperModel: 'small'
  })

  assert.deepEqual(harness.host.calls, ['stop'])
  assert.equal(harness.host.starts.length, 2)
  assert.deepEqual(harness.host.starts[1], {
    source: 'system',
    asr: 'whisper',
    language: 'auto',
    deepgramApiKey: null,
    whisperBaseUrl: 'http://127.0.0.1:9000/v1',
    whisperModel: 'small',
    whisperApiKey: null
  })
  assert.equal(harness.windowStates.at(-1), true)
  assert.equal(harness.controller.snapshot().state, 'starting')
})

/**
 * 校验运行中修改 Whisper 地址或模型会立即重启，而不是继续使用旧 sidecar。
 * @returns 无返回值。
 * @author zhenghq
 */
test('运行中修改 Whisper 地址和模型应重启实时字幕会话', () => {
  const harness = createHarness({
    realtimeSubtitleAsrProvider: 'whisper',
    realtimeSubtitleWhisperBaseUrl: 'http://127.0.0.1:8000/v1',
    realtimeSubtitleWhisperModel: 'small'
  })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })

  harness.controller.applySettings({
    ...harness.settings,
    realtimeSubtitleWhisperBaseUrl: 'http://127.0.0.1:9000/v1',
    realtimeSubtitleWhisperModel: 'large-v3'
  })

  assert.deepEqual(harness.host.calls, ['stop'])
  assert.equal(harness.host.starts.length, 2)
  assert.equal(harness.host.starts[1]?.whisperBaseUrl, 'http://127.0.0.1:9000/v1')
  assert.equal(harness.host.starts[1]?.whisperModel, 'large-v3')
})

/**
 * 校验仅修改字幕显示参数时不应无谓重启正在运行的 ASR 会话。
 * @returns 无返回值。
 * @author zhenghq
 */
test('运行中修改字幕外观不应重启实时字幕会话', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })

  harness.controller.applySettings({
    ...harness.settings,
    realtimeSubtitleDisplayMode: 'target',
    realtimeSubtitleFontSize: 28,
    realtimeSubtitleTextColor: '#abcdef',
    realtimeSubtitleClickThrough: false,
    realtimeSubtitleHideAfterMs: 3000
  })

  assert.deepEqual(harness.host.calls, [])
  assert.equal(harness.host.starts.length, 1)
  assert.equal(harness.controller.snapshot().state, 'running')
})

/**
 * 校验启动参数来自当前设置，并在重启时使旧代次翻译失效。
 * @returns 无返回值。
 * @author zhenghq
 */
test('启动应使用当前音频来源与识别语言', () => {
  const harness = createHarness({
    realtimeSubtitleAudioSource: 'both',
    realtimeSubtitleRecognitionLang: 'ja-JP'
  })
  harness.controller.start()
  assert.deepEqual(harness.host.starts[0], {
    source: 'both',
    asr: 'deepgram',
    language: 'ja-JP',
    deepgramApiKey: null
  })
})

/**
 * 校验 Whisper provider 会把独立配置传给宿主，而不依赖 Deepgram 凭据。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Whisper 启动应传入本地服务配置和可选密钥', () => {
  const harness = createHarness({
    realtimeSubtitleAsrProvider: 'whisper',
    realtimeSubtitleWhisperBaseUrl: 'http://127.0.0.1:9000/v1',
    realtimeSubtitleWhisperModel: 'large-v3'
  }, {
    whisperApiKey: 'whisper-secret'
  })
  harness.controller.start()
  assert.deepEqual(harness.host.starts[0], {
    source: 'system',
    asr: 'whisper',
    language: 'auto',
    deepgramApiKey: null,
    whisperBaseUrl: 'http://127.0.0.1:9000/v1',
    whisperModel: 'large-v3',
    whisperApiKey: 'whisper-secret'
  })
})

/**
 * 校验网络自动重连仍沿用用户选择的 Whisper provider。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Whisper 自动重连不应回退到 Deepgram', () => {
  const harness = createHarness({
    realtimeSubtitleAsrProvider: 'whisper',
    realtimeSubtitleWhisperBaseUrl: 'http://localhost:8000/v1',
    realtimeSubtitleWhisperModel: 'small'
  }, {
    whisperApiKey: null
  })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'error', code: 'network', message: 'offline' })
  harness.runNextReconnect()

  assert.equal(harness.host.starts.length, 2)
  assert.equal(harness.host.starts[1]?.asr, 'whisper')
  assert.equal(harness.host.starts[1]?.whisperBaseUrl, 'http://localhost:8000/v1')
  assert.equal(harness.host.starts[1]?.whisperModel, 'small')
  assert.equal(harness.host.starts[1]?.whisperApiKey, null)
})

/**
 * 校验 WebSocket provider 会把服务地址传给宿主，且自动重连保持同一 provider。
 * @returns 无返回值。
 * @author zhenghq
 */
test('WebSocket 启动与自动重连应传入并保持服务地址', () => {
  const harness = createHarness({
    realtimeSubtitleAsrProvider: 'websocket',
    realtimeSubtitleWebSocketUrl: 'ws://127.0.0.1:9092/ws/asr?language=zh'
  })
  harness.controller.start()
  assert.deepEqual(harness.host.starts[0], {
    source: 'system',
    asr: 'websocket',
    language: 'auto',
    deepgramApiKey: null,
    webSocketUrl: 'ws://127.0.0.1:9092/ws/asr?language=zh'
  })

  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'error', code: 'network', message: 'offline' })
  harness.runNextReconnect()

  assert.equal(harness.host.starts.length, 2)
  assert.equal(harness.host.starts[1]?.asr, 'websocket')
  assert.equal(
    harness.host.starts[1]?.webSocketUrl,
    'ws://127.0.0.1:9092/ws/asr?language=zh'
  )
})

/**
 * 校验 DashScope provider 会传入地址、模型和主进程密钥，并在配置变化时重建会话。
 * @returns 无返回值。
 * @author zhenghq
 */
test('DashScope 启动应传入隔离配置且运行中修改应重启会话', () => {
  const harness = createHarness({
    realtimeSubtitleAsrProvider: 'alibaba',
    realtimeSubtitleDashScopeUrl: 'wss://dashscope.example.com/api-ws/v1/inference',
    realtimeSubtitleDashScopeModel: 'qwen-audio-custom'
  }, { dashScopeApiKey: 'dashscope-secret' })

  harness.controller.start()
  assert.equal(harness.host.starts[0]?.asr, 'alibaba')
  assert.equal(
    harness.host.starts[0]?.dashScopeUrl,
    'wss://dashscope.example.com/api-ws/v1/inference'
  )
  assert.equal(harness.host.starts[0]?.dashScopeModel, 'qwen-audio-custom')
  assert.equal(harness.host.starts[0]?.dashScopeApiKey, 'dashscope-secret')

  harness.host.emit({ type: 'ready' })
  harness.controller.applySettings({
    ...harness.settings,
    realtimeSubtitleDashScopeModel: 'qwen-audio-next'
  })

  assert.deepEqual(harness.host.calls, ['stop'])
  assert.equal(harness.host.starts.length, 2)
  assert.equal(harness.host.starts[1]?.dashScopeModel, 'qwen-audio-next')
})

/**
 * 校验 OpenAI Realtime provider 会传入地址、模型和主进程密钥，并在配置变化时重建会话。
 * @returns 无返回值。
 * @author zhenghq
 */
test('OpenAI Realtime 启动应传入隔离配置且运行中修改应重启会话', () => {
  const harness = createHarness({
    realtimeSubtitleAsrProvider: 'custom-openai',
    realtimeSubtitleOpenAIRealtimeUrl: 'wss://realtime.example.com/v1/realtime',
    realtimeSubtitleOpenAIRealtimeModel: 'gpt-4o-mini-transcribe'
  }, { openAIRealtimeApiKey: 'openai-secret' })

  harness.controller.start()
  assert.equal(harness.host.starts[0]?.asr, 'custom-openai')
  assert.equal(
    harness.host.starts[0]?.openAIRealtimeUrl,
    'wss://realtime.example.com/v1/realtime'
  )
  assert.equal(
    harness.host.starts[0]?.openAIRealtimeModel,
    'gpt-4o-mini-transcribe'
  )
  assert.equal(harness.host.starts[0]?.openAIRealtimeApiKey, 'openai-secret')

  harness.host.emit({ type: 'ready' })
  harness.controller.applySettings({
    ...harness.settings,
    realtimeSubtitleOpenAIRealtimeModel: 'gpt-4o-transcribe'
  })

  assert.deepEqual(harness.host.calls, ['stop'])
  assert.equal(harness.host.starts.length, 2)
  assert.equal(harness.host.starts[1]?.openAIRealtimeModel, 'gpt-4o-transcribe')
})

/**
 * 校验 WebSocket 断链和自动恢复过程会写入可追踪日志。
 * @returns 无返回值。
 * @author zhenghq
 */
test('WebSocket 断链重连应输出可追踪日志', () => {
  const logs: string[] = []
  const harness = createHarness({
    realtimeSubtitleAsrProvider: 'websocket',
    realtimeSubtitleWebSocketUrl: 'ws://127.0.0.1:9092/ws/asr?language=zh'
  }, { logs })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })

  harness.host.emit({ type: 'error', code: 'network', message: 'websocket closed' })
  assert.ok(logs.some((line) => line.includes('ASR 连接中断') && line.includes('provider=websocket')))
  assert.ok(logs.some((line) => line.includes('安排第 1/') && line.includes('retryInMs=')))

  harness.runNextReconnect()
  assert.ok(logs.some((line) => line.includes('开始第 1/') && line.includes('provider=websocket')))

  harness.host.emit({ type: 'ready' })
  assert.ok(logs.some((line) => line.includes('ASR 重连成功') && line.includes('attempts=1')))
})

/**
 * 校验运行中修改 WebSocket 地址会重启识别会话。
 * @returns 无返回值。
 * @author zhenghq
 */
test('运行中修改 WebSocket 地址应重启实时字幕会话', () => {
  const harness = createHarness({
    realtimeSubtitleAsrProvider: 'websocket',
    realtimeSubtitleWebSocketUrl: 'ws://127.0.0.1:9092/ws/asr'
  })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })

  harness.controller.applySettings({
    ...harness.settings,
    realtimeSubtitleWebSocketUrl: 'ws://127.0.0.1:9093/ws/asr'
  })

  assert.deepEqual(harness.host.calls, ['stop'])
  assert.equal(harness.host.starts.length, 2)
  assert.equal(harness.host.starts[1]?.webSocketUrl, 'ws://127.0.0.1:9093/ws/asr')
})

/**
 * 校验 sidecar 在 start 调用内同步报错时不显示空字幕窗。
 * @returns 无返回值。
 * @author zhenghq
 */
test('同步启动错误应隐藏窗口并广播可恢复错误', () => {
  const host = new FakeHost()
  const snapshots: RealtimeSubtitleSnapshot[] = []
  const windowStates: boolean[] = []
  host.start = function (this: FakeHost) {
    this.generation += 1
    host.onEvent({
      type: 'error',
      code: 'permission-denied',
      message: '屏幕录制权限未开启'
    }, this.generation)
    return this.generation
  }
  const controller = new RealtimeSubtitleController({
    createHost: (onEvent) => {
      host.onEvent = onEvent
      return host
    },
    getSettings: () => normalizeSettings({}),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    translateStream: async () => ({ translation: '' }) as never,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    setWindowVisible: (visible) => windowStates.push(visible)
  })

  controller.start()
  assert.equal(windowStates.includes(true), false)
  assert.equal(controller.snapshot().state, 'idle')
  assert.equal(controller.snapshot().errorCode, 'permission-denied')
  assert.equal(controller.snapshot().error, '屏幕录制权限未开启')
  assert.equal(snapshots.at(-1)?.errorCode, 'permission-denied')
})

/**
 * 校验网络断线会保留字幕窗并按指数退避自动重启 sidecar。
 * @returns 无返回值。
 * @author zhenghq
 */
test('网络断线后应自动重连并保留字幕窗口', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'error', code: 'network', message: 'asr network failure' })

  assert.equal(harness.controller.snapshot().state, 'idle')
  assert.equal(harness.timers.length, 1)
  assert.equal(harness.timers[0]?.delayMs, resolveSubtitleReconnectDelay(0))
  assert.equal(harness.windowStates.at(-1), true)

  harness.runNextReconnect()
  assert.equal(harness.host.starts.length, 2)
  assert.equal(harness.controller.snapshot().state, 'starting')
})

/**
 * 校验 sidecar 进程异常退出后会自动重建会话。
 * @returns 无返回值。
 * @author zhenghq
 */
test('sidecar 不可用后应自动重连', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({
    type: 'error',
    code: 'sidecar-unavailable',
    message: 'subtitle sidecar exited unexpectedly'
  })

  assert.equal(harness.timers.length, 1)
  assert.equal(harness.timers[0]?.delayMs, resolveSubtitleReconnectDelay(0))
  assert.equal(harness.windowStates.at(-1), true)

  harness.runNextReconnect()
  assert.equal(harness.host.starts.length, 2)
  assert.equal(harness.controller.snapshot().state, 'starting')
})

/**
 * 校验 ASR 连接无错误地停止时仍会触发自动恢复，避免界面永久假运行。
 * @returns 无返回值。
 * @author zhenghq
 */
test('运行中收到停止状态后应自动重连', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'status', state: 'idle' })

  assert.equal(harness.controller.snapshot().state, 'idle')
  assert.equal(harness.timers.length, 1)
  assert.equal(harness.timers[0]?.delayMs, resolveSubtitleReconnectDelay(0))
  assert.equal(harness.windowStates.at(-1), true)

  harness.runNextReconnect()
  assert.equal(harness.host.starts.length, 2)
})

/**
 * 校验错误后紧跟停止状态时只安排一次重连，避免重复事件消耗重试预算。
 * @returns 无返回值。
 * @author zhenghq
 */
test('错误后收到停止状态不应重复安排重连', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'error', code: 'network', message: 'asr network failure' })
  harness.host.emit({ type: 'status', state: 'idle' })

  const activeTimers = harness.timers.filter((timer) => !timer.cleared)
  assert.equal(activeTimers.length, 1)
  assert.equal(activeTimers[0]?.delayMs, resolveSubtitleReconnectDelay(0))
})

/**
 * 校验重连后再次收到停止状态时继续按下一档退避重试。
 * @returns 无返回值。
 * @author zhenghq
 */
test('重连后再次停止应继续退避重试', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'status', state: 'idle' })

  const originalStart = harness.host.start.bind(harness.host)
  harness.host.start = function (options) {
    const generation = originalStart(options)
    harness.host.emit({ type: 'status', state: 'idle' })
    return generation
  }

  harness.runNextReconnect()

  const activeTimers = harness.timers.filter((timer) => !timer.cleared)
  assert.equal(activeTimers.length, 1)
  assert.equal(activeTimers[0]?.delayMs, resolveSubtitleReconnectDelay(1))
  assert.equal(harness.controller.snapshot().state, 'idle')
  assert.equal(harness.windowStates.at(-1), true)
})

/**
 * 校验重连启动过程中同步失败时仍会进入下一轮退避，而不是丢失错误事件。
 * @returns 无返回值。
 * @author zhenghq
 */
test('重连启动同步报网络错误时应继续安排重试', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'error', code: 'network', message: 'asr network failure' })

  const originalStart = harness.host.start.bind(harness.host)
  harness.host.start = function (options) {
    const generation = originalStart(options)
    harness.host.emit({ type: 'error', code: 'network', message: 'reconnect failed' })
    return generation
  }

  harness.runNextReconnect()

  assert.equal(harness.controller.snapshot().state, 'idle')
  assert.equal(harness.controller.snapshot().errorCode, 'network')
  assert.equal(harness.timers.filter((timer) => !timer.cleared).length, 1)
  assert.equal(harness.timers.at(-1)?.delayMs, resolveSubtitleReconnectDelay(1))
  assert.equal(harness.windowStates.at(-1), true)
})

/**
 * 校验连续网络失败达到上限后停止重连，避免无限拉起 sidecar。
 * @returns 无返回值。
 * @author zhenghq
 */
test('网络重连达到上限后应停止自动重试', () => {
  const harness = createHarness()
  harness.controller.start()
  for (let attempt = 0; attempt < SUBTITLE_MAX_NETWORK_RECONNECTS; attempt += 1) {
    harness.host.emit({ type: 'error', code: 'network', message: 'asr network failure' })
    assert.equal(
      shouldReconnectSubtitle('network', attempt, SUBTITLE_MAX_NETWORK_RECONNECTS),
      true
    )
    harness.runNextReconnect()
  }
  harness.host.emit({ type: 'error', code: 'network', message: 'asr network failure' })
  assert.equal(harness.timers.filter((timer) => !timer.cleared).length, 0)
  assert.equal(harness.windowStates.at(-1), false)
})

/**
 * 校验鉴权错误不会触发自动重连。
 * @returns 无返回值。
 * @author zhenghq
 */
test('鉴权错误不应自动重连', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'error', code: 'auth', message: 'asr authentication failed' })

  assert.equal(harness.timers.length, 0)
  assert.equal(harness.windowStates.at(-1), false)
  assert.equal(harness.controller.snapshot().errorCode, 'auth')
})

/**
 * 校验切换视频导致系统音频设备重建时，设备故障应触发自动恢复。
 * @returns 无返回值。
 * @author zhenghq
 */
test('设备不可用时应自动重连', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'error', code: 'device-unavailable', message: 'audio device unavailable' })

  assert.equal(harness.timers.length, 1)
  assert.equal(harness.timers[0]?.delayMs, resolveSubtitleReconnectDelay(0))
  assert.equal(harness.windowStates.at(-1), true)
})

/**
 * 校验手动停止会取消待执行的自动恢复。
 * @returns 无返回值。
 * @author zhenghq
 */
test('手动停止应取消待执行的网络重连', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'error', code: 'network', message: 'asr network failure' })
  harness.controller.stop()

  assert.equal(harness.timers[0]?.cleared, true)
  assert.equal(harness.host.starts.length, 1)
})

/**
 * 校验重连成功收到 ready 后恢复重试预算，后续断线仍可自动恢复。
 * @returns 无返回值。
 * @author zhenghq
 */
test('重连成功后应重置网络重试次数', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'error', code: 'network', message: 'asr network failure' })
  harness.runNextReconnect()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'error', code: 'network', message: 'asr network failure' })

  assert.equal(harness.timers.at(-1)?.delayMs, resolveSubtitleReconnectDelay(0))
  assert.equal(harness.windowStates.at(-1), true)
})

/**
 * 校验 dispose 后待执行的重连会被取消，不会拉起新 sidecar。
 * @returns 无返回值。
 * @author zhenghq
 */
test('释放控制器应取消待执行的网络重连', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'error', code: 'network', message: 'asr network failure' })
  const timer = harness.timers[0]
  harness.controller.dispose()

  assert.equal(timer?.cleared, true)
  assert.equal(harness.host.starts.length, 1)
  assert.equal(harness.host.disposed, true)
})

/**
 * 校验旧会话延迟到达的错误不会停止或重连新会话。
 * @returns 无返回值。
 * @author zhenghq
 */
test('旧会话事件不应影响新会话', () => {
  const harness = createHarness()
  harness.controller.start()
  const oldGeneration = harness.host.generation
  harness.controller.stop()
  harness.controller.start()

  harness.host.onEvent({ type: 'error', code: 'network', message: 'stale network failure' }, oldGeneration)

  assert.equal(harness.controller.snapshot().state, 'starting')
  assert.equal(harness.timers.length, 0)
  assert.equal(harness.host.starts.length, 2)
})

/**
 * 校验 Gemini 启动会传入 Live 配置、API Key 和当前目标语言。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Gemini 启动应传入 Live 配置与目标语言', () => {
  const harness = createHarness({
    targetLang: 'zh-CN',
    realtimeSubtitleAsrProvider: 'gemini',
    realtimeSubtitleGeminiUrl: 'wss://gemini.example.com/live',
    realtimeSubtitleGeminiModel: 'gemini-custom-live'
  }, { geminiApiKey: 'gemini-secret' })

  harness.controller.start()
  assert.deepEqual(harness.host.starts[0], {
    source: 'system',
    asr: 'gemini',
    language: 'auto',
    targetLang: 'zh-CN',
    geminiUrl: 'wss://gemini.example.com/live',
    geminiModel: 'gemini-custom-live',
    geminiApiKey: 'gemini-secret'
  })
})

/**
 * 校验目标语言为 auto 时不请求原生翻译，交由现有文字翻译链路处理。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Gemini 目标语言为 auto 时不应传入原生翻译目标', () => {
  const harness = createHarness({
    targetLang: 'auto',
    realtimeSubtitleAsrProvider: 'gemini'
  }, { geminiApiKey: 'gemini-secret' })

  harness.controller.start()
  assert.equal(harness.host.starts[0]?.asr, 'gemini')
  assert.equal(harness.host.starts[0]?.targetLang, undefined)
})

/**
 * 校验 Gemini partial 原生译文实时上屏，且不重复调用文字翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Gemini 原生译文不应再调用文字翻译', async () => {
  const harness = createHarness({ realtimeSubtitleAsrProvider: 'gemini' }, { previewDebounceMs: 0 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({
    type: 'partial',
    text: 'Hello',
    lang: 'en',
    translatedText: '你好',
    translatedLang: 'zh-Hans'
  })
  await flush()
  assert.deepEqual(harness.translateCalls, [])
  assert.equal(harness.controller.viewModel().translatedText, '你好')

  harness.host.emit({
    type: 'final',
    text: 'Hello world.',
    lang: 'en',
    translatedText: '你好，世界。',
    translatedLang: 'zh-Hans'
  })
  await flush()
  assert.deepEqual(harness.translateCalls, [])
  const segment = harness.controller.snapshot().segments.at(-1)
  assert.equal(segment?.translatedText, '你好，世界。')
  assert.equal(segment?.status, 'translated')
  assert.equal(harness.controller.viewModel().translatedText, '你好，世界。')
})

/**
 * 校验 Gemini 缺少原生译文时，partial 与 final 都沿用文字翻译链路。
 * @returns 无返回值。
 * @author zhenghq
 */
test('Gemini 缺少原生译文时应继续调用文字翻译', async () => {
  const harness = createHarness({ realtimeSubtitleAsrProvider: 'gemini' }, { previewDebounceMs: 0 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'partial', text: 'Hello', lang: 'en' })
  await waitFor(() => harness.translateCalls.length === 1)
  assert.deepEqual(harness.translateCalls.map((call) => call.text), ['Hello'])
  harness.finishTranslationFor('Hello', '你好')
  await waitFor(() => harness.controller.viewModel().translatedText === '你好')

  harness.host.emit({ type: 'final', text: 'Hello', lang: 'en' })
  await flush()
  assert.deepEqual(harness.translateCalls.map((call) => call.text), ['Hello'])
})
