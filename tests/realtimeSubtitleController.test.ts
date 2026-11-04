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
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
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
        active.updatedAt = Date.now()
      } else {
        this.segments.push({
          id: `segment-${++this.sequence}`,
          sourceText: event.text,
          translatedText: '',
          status: 'partial',
          updatedAt: Date.now()
        })
      }
      this.sourceText = event.text
    } else if (event.type === 'final') {
      this.audioActivity = 'speech-detected'
      const active = this.segments.find((segment) => segment.status === 'partial')
      if (active) {
        active.sourceText = event.text
        active.status = 'translating'
        active.updatedAt = Date.now()
      } else {
        this.segments.push({
          id: `segment-${++this.sequence}`,
          sourceText: event.text,
          translatedText: '',
          status: 'translating',
          updatedAt: Date.now()
        })
      }
      this.sourceText = event.text
      this.translatedText = ''
    } else if (event.type === 'level') {
      if (event.rms >= 0.01 && this.audioActivity === 'idle') {
        this.audioActivity = 'speech-pending'
      }
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
  options: { previewDebounceMs?: number } = {}
) {
  const host = new FakeHost()
  const broadcasts: RealtimeSubtitleSnapshot[] = []
  const windowStates: boolean[] = []
  const settings = normalizeSettings({ targetLang: 'zh-CN', ...overrides })
  const translateCalls: Array<{
    text: string
    sourceLang: string | undefined
    id: string
    iTranslateApiKey: string | null | undefined
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
    getITranslateApiKey: () => 'it-secret',
    previewDebounceMs: options.previewDebounceMs,
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
        resolveTranslation = () => {
          options.onDelta('你好')
          resolve({ translation: '你好' } as never)
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
 * 校验稳定 partial 会提前预翻译，final 同文时复用请求并完成段落。
 * @returns 无返回值。
 * @author zhenghq
 */
test('实时字幕应提前翻译稳定 partial 并在 final 同文时复用', async () => {
  const harness = createHarness({}, { previewDebounceMs: 0 })
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'partial', text: 'Hello', lang: 'en-US' })
  assert.equal(harness.controller.snapshot().sourceText, 'Hello')
  await flush()
  assert.deepEqual(harness.translateCalls.map((call) => call.text), ['Hello'])

  harness.host.emit({ type: 'final', text: 'Hello', lang: 'en-US' })
  await flush()
  assert.deepEqual(harness.translateCalls.map((call) => call.text), ['Hello'])
  assert.equal(harness.translateCalls[0]?.sourceLang, 'en-US')
  assert.equal(harness.translateCalls[0]?.iTranslateApiKey, 'it-secret')

  harness.finishTranslation()
  await harness.controller.idle()
  const segment = harness.controller.snapshot().segments[0]
  assert.equal(segment?.translatedText, '你好')
  assert.equal(segment?.status, 'translated')
  assert.equal(harness.controller.snapshot().translatedText, '你好')
})

/**
 * 校验有声音但尚无识别文本时，控制器广播的提示可被设置页和字幕窗读取。
 * @returns 无返回值。
 * @author zhenghq
 */
test('有声音但无识别文本时应广播 speech-pending 提示', () => {
  const harness = createHarness()
  harness.controller.start()
  harness.host.emit({ type: 'ready' })
  harness.host.emit({ type: 'level', rms: 0.2 })

  assert.equal(harness.controller.snapshot().audioActivity, 'speech-pending')
  assert.equal(harness.broadcasts.at(-1)?.audioActivity, 'speech-pending')
  assert.equal(harness.controller.viewModel().audioActivity, 'speech-pending')
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
  const firstTimer = harness.timers.at(-1)
  assert.equal(firstTimer?.delayMs, 8000)

  harness.host.emit({ type: 'partial', text: 'Hello world', lang: 'en' })
  assert.equal(firstTimer?.cleared, true, '更新识别文本时应取消上一轮计时')
  assert.equal(harness.timers.at(-1)?.delayMs, 8000)
  assert.notEqual(harness.timers.at(-1), firstTimer)
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
  const previousTimer = harness.timers.at(-1)

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
