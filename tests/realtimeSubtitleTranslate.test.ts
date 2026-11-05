import assert from 'node:assert/strict'
import test from 'node:test'
import { SubtitleTranslationCoordinator } from '../src/main/subtitleTranslate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'

/** 创建字幕预翻译测试使用的手动定时器。 */
function createManualTimers(): {
  timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }>
  setTimeoutFn: (callback: () => void, delayMs: number) => unknown
  clearTimeoutFn: (handle: unknown) => void
} {
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = []
  return {
    timers,
    setTimeoutFn: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    }
  }
}

/** 等待协调器完成内部事件循环。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * 等待条件成立，用于跨越协调器延迟启动的多个事件循环。
 * @param predicate 条件判断函数。
 * @param attempts 最大轮询次数。
 * @returns 条件成立时 resolve；超过次数后使测试失败。
 * @author zhenghq
 */
async function waitFor(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await flush()
  }
  assert.fail('等待条件超时')
}

/**
 * 创建延迟可控的翻译 Promise。
 * @param resolve 完成函数。
 * @returns 延迟句柄与 Promise。
 * @author zhenghq
 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

/**
 * 校验 final 段进入翻译，且增量与完成回调携带同一段标识。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕 final 应复用流式翻译并保留段落标识', async () => {
  const deltas: string[] = []
  const completed: string[] = []
  const calls: Array<{ text: string; sourceLang: string }> = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    translateStream: async (text, settings, _dingTalk, _aiKey, options) => {
      calls.push({ text, sourceLang: settings.sourceLang })
      options.onDelta('你')
      options.onDelta('好')
      return { translation: '你好' } as never
    },
    onDelta: (_id, delta) => deltas.push(delta),
    onComplete: (id) => completed.push(id),
    onError: () => assert.fail('不应失败')
  })

  const id = coordinator.submit('Hello', 'en-US', 1, 'segment-1')
  await coordinator.idle()
  assert.equal(id, 'segment-1')
  assert.deepEqual(calls, [{ text: 'Hello', sourceLang: 'en-US' }])
  assert.deepEqual(deltas, ['你', '好'])
  assert.deepEqual(completed, [id])
})

/**
 * 校验服务端拆句后的多条 final 译文按段落标识隔离，不会互相追加。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 final 的译文应按各自段落隔离', async () => {
  const sentences = [
    '蔡永嘉,你听明白了吗?',
    '听明白了,一会儿行政大队就去忍。',
    '你们把李小交接,是。'
  ]
  const deltas: Array<{ id: string; delta: string }> = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    translateStream: async (text, _settings, _dingTalk, _aiKey, options) => {
      const translated = `译文:${text}`
      options.onDelta(translated)
      return { translation: translated } as never
    },
    onDelta: (id, delta) => deltas.push({ id, delta }),
    onComplete: () => undefined,
    onError: () => assert.fail('不应失败')
  })

  sentences.forEach((sentence, index) => {
    coordinator.submit(sentence, 'zh', 1, `segment-${index + 1}`)
  })
  await coordinator.idle()

  assert.deepEqual(
    deltas.map((item) => item.id),
    ['segment-1', 'segment-2', 'segment-3']
  )
  assert.deepEqual(
    deltas.map((item) => item.delta),
    sentences.map((sentence) => `译文:${sentence}`)
  )
})

/**
 * 校验连续 final 只允许有限请求并发，其余段落按顺序等待，避免快速识别时拖垮翻译通道。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 final 应限制并发并按顺序翻译', async () => {
  const calls: string[] = []
  const pending: Array<ReturnType<typeof deferred<{ translation: string }>>> = []
  const completed: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    maxConcurrentFinalRequests: 1,
    maxQueuedFinalRequests: 3,
    translateStream: async (text) => {
      calls.push(text)
      const request = deferred<{ translation: string }>()
      pending.push(request)
      return request.promise as never
    },
    onDelta: () => undefined,
    onComplete: (id) => completed.push(id),
    onError: () => assert.fail('队列容量内不应失败')
  })

  for (let index = 1; index <= 4; index += 1) {
    coordinator.submit(`sentence-${index}`, 'en', 1, `segment-${index}`)
  }
  await flush()
  assert.deepEqual(calls, ['sentence-1'], '同一时刻只应发起一个 final 请求')

  for (let index = 0; index < 4; index += 1) {
    pending[index]?.resolve({ translation: `译文-${index + 1}` })
    await waitFor(() => pending.length === Math.min(index + 2, 4))
  }
  await coordinator.idle()

  assert.deepEqual(calls, ['sentence-1', 'sentence-2', 'sentence-3', 'sentence-4'])
  assert.deepEqual(completed, ['segment-1', 'segment-2', 'segment-3', 'segment-4'])
})

/**
 * 校验 final 等待队列达到上限时只报告当前段落失败，不无限积压请求。
 * @returns 无返回值。
 * @author zhenghq
 */
test('final 等待队列满时应拒绝新增任务并报告错误', async () => {
  const pending = deferred<{ translation: string }>()
  const calls: string[] = []
  const errors: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    maxConcurrentFinalRequests: 1,
    maxQueuedFinalRequests: 2,
    translateStream: async (text) => {
      calls.push(text)
      return pending.promise as never
    },
    onDelta: () => undefined,
    onComplete: () => assert.fail('队列中任务不应提前完成'),
    onError: (id, error) => errors.push(`${id}:${error.message}`)
  })

  for (let index = 1; index <= 4; index += 1) {
    coordinator.submit(`sentence-${index}`, 'en', 1, `segment-${index}`)
  }
  await flush()

  assert.deepEqual(calls, ['sentence-1'])
  assert.deepEqual(errors, ['segment-4:subtitle translation queue is full'])

  coordinator.invalidate()
  pending.resolve({ translation: '完成' })
  await coordinator.idle()
})

/**
 * 校验默认 final 并发 2 且等待队列能容纳 12 条 cue。
 * @returns 无返回值。
 * @author zhenghq
 */
test('默认 final 应并发 2 且等待队列容纳 12 条 cue', async () => {
  const pending = deferred<{ translation: string }>()
  const calls: string[] = []
  const errors: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    translateStream: async (text) => {
      calls.push(text)
      return pending.promise as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: (id, error) => errors.push(`${id}:${error.message}`)
  })

  for (let index = 1; index <= 15; index += 1) {
    coordinator.submit(`sentence-${index}`, 'zh', 1, `segment-${index}`)
  }
  await flush()

  assert.deepEqual(calls, ['sentence-1', 'sentence-2'])
  assert.deepEqual(errors, ['segment-15:subtitle translation queue is full'])
  coordinator.invalidate()
  pending.resolve({ translation: '完成' })
  await coordinator.idle()
})

/**
 * 校验默认 final 截止时间为 45 秒，允许 20 秒的 Retry-After 等待。
 * @returns 无返回值。
 * @author zhenghq
 */
test('默认 final 截止时间应允许 20 秒重试等待', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    finalMaxAttempts: 3,
    finalRetryBaseDelayMs: 600,
    nowFn: () => 0,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      if (calls.length === 1) {
        throw Object.assign(new Error('rate limited'), {
          kind: 'rate-limit',
          retryAfterMs: 20_000
        })
      }
      return { translation: '你好' } as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('45 秒截止时间内应继续重试'),
    onReset: () => undefined
  })

  coordinator.submit('Hello', 'en', 1, 'segment-1')
  await flush()

  assert.ok(
    manualTimers.timers.some((timer) => !timer.cleared && timer.delayMs === 20_000),
    '默认截止时间 45 秒应允许 20 秒重试等待'
  )
  coordinator.invalidate()
})

/**
 * 校验 final 之后迟到的 partial 不会重新开启预览翻译，避免旧段落继续追加译文。
 * @returns 无返回值。
 * @author zhenghq
 */
test('final 后迟到的 partial 不得重新开启预览翻译', async () => {
  const calls: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    translateStream: async (text) => {
      calls.push(text)
      return { translation: '你好' } as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('不应失败')
  })

  coordinator.submit('Hello', 'en-US', 1, 'segment-1')
  await coordinator.idle()
  coordinator.preview('Hello again', 'en-US', 1, 'segment-1')
  await coordinator.idle()

  assert.deepEqual(calls, ['Hello'])
})

/**
 * 校验会话代次变化后，迟到翻译结果不再写入字幕。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕会话停止后应丢弃迟到译文', async () => {
  const pending = deferred<{ translation: string }>()
  const deltas: string[] = []
  const completed: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({}),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    translateStream: async (_text, _settings, _dingTalk, _aiKey, options) => {
      options.onDelta('late')
      return pending.promise as never
    },
    onDelta: (_id, delta) => deltas.push(delta),
    onComplete: (id) => completed.push(id),
    onError: () => undefined
  })

  coordinator.submit('Hello', undefined, 1, 'segment-1')
  await new Promise((resolve) => setImmediate(resolve))
  coordinator.invalidate()
  pending.resolve({ translation: '迟到' })
  await coordinator.idle()
  assert.deepEqual(deltas, [])
  assert.deepEqual(completed, [])
})

/**
 * 校验单段翻译失败不会抛出到识别链路，并通知错误回调。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕翻译失败应保留识别会话并通知错误', async () => {
  const errors: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({}),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    finalMaxAttempts: 1,
    translateStream: async () => {
      throw new Error('network down')
    },
    onDelta: () => undefined,
    onComplete: () => assert.fail('失败时不应完成'),
    onError: (id, error) => errors.push(`${id}:${error.message}`)
  })

  const id = coordinator.submit('Hello', 'en', 1, 'segment-1')
  await coordinator.idle()
  assert.deepEqual(errors, [`${id}:network down`])
})

/**
 * 校验稳定 partial 会在 final 前启动流式翻译，final 到达后复用同一请求。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕 partial 稳定后应提前流式翻译并在 final 到达后复用', async () => {
  const pending = deferred<{ translation: string }>()
  const manualTimers = createManualTimers()
  const calls: string[] = []
  const deltas: Array<{ delta: string; phase: string }> = []
  const completed: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 320,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text, _settings, _dingTalk, _aiKey, options) => {
      calls.push(text)
      options.onDelta('你')
      return pending.promise as never
    },
    onDelta: (_id, delta, phase) => deltas.push({ delta, phase }),
    onComplete: (id) => completed.push(id),
    onError: () => assert.fail('不应失败'),
    onReset: () => undefined
  })

  coordinator.preview('Hello wo', 'en-US', 1, 'segment-1')
  assert.equal(manualTimers.timers[0]?.delayMs, 320)
  assert.deepEqual(calls, [])
  manualTimers.timers[0]?.callback()
  await flush()
  assert.deepEqual(calls, ['Hello wo'])

  const id = coordinator.submit('Hello wo', 'en-US', 1, 'segment-1')
  assert.deepEqual(calls, ['Hello wo'])
  pending.resolve({ translation: '你好' })
  await coordinator.idle()

  assert.equal(id, 'segment-1')
  assert.deepEqual(deltas, [
    { delta: '你', phase: 'preview' },
    { delta: '好', phase: 'final' }
  ])
  assert.deepEqual(completed, ['segment-1'])
})

/**
 * 校验连续 partial 更新不会反复中止在途预翻译，并在完成后自动追上最新文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕 partial 连续变化应合并预翻译并在完成后追最新文本', async () => {
  const manualTimers = createManualTimers()
  const first = deferred<{ translation: string }>()
  const second = deferred<{ translation: string }>()
  const calls: string[] = []
  const deltas: Array<{ delta: string; phase: string }> = []
  const reset: Array<{ id: string; phase: string }> = []
  let aborted = false
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 200,
    previewMinIntervalMs: 0,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text, _settings, _dingTalk, _aiKey, options) => {
      const index = calls.length
      calls.push(text)
      options.signal?.addEventListener('abort', () => {
        aborted = true
      }, { once: true })
      options.onDelta(index === 0 ? '旧' : '新')
      return (index === 0 ? first.promise : second.promise) as never
    },
    onDelta: (_id, delta, phase) => deltas.push({ delta, phase }),
    onComplete: () => undefined,
    onError: () => assert.fail('取消请求不应上报错误'),
    onReset: (id, phase) => reset.push({ id, phase })
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  manualTimers.timers[0]?.callback()
  await flush()
  assert.deepEqual(calls, ['Hello'])

  coordinator.preview('Hello world', 'en', 1, 'segment-1')
  assert.deepEqual(calls, ['Hello'])
  assert.equal(aborted, false)
  assert.deepEqual(reset, [])

  first.resolve({ translation: '旧译' })
  await waitFor(() => calls.length === 2)
  assert.deepEqual(calls, ['Hello', 'Hello world'])
  assert.equal(aborted, false)
  assert.deepEqual(reset, [{ id: 'segment-1', phase: 'preview' }])

  second.resolve({ translation: '新译' })
  await coordinator.idle()
  assert.deepEqual(deltas, [
    { delta: '旧', phase: 'preview' },
    { delta: '译', phase: 'preview' },
    { delta: '新', phase: 'preview' },
    { delta: '译', phase: 'preview' }
  ])
})

/**
 * 校验识别文本回退到当前请求原文时，不应继续翻译已过时的排队文本。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕 partial 回到当前原文时应丢弃旧排队文本', async () => {
  const manualTimers = createManualTimers()
  const pending = deferred<{ translation: string }>()
  const calls: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 200,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      return pending.promise as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('预翻译不应失败'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  manualTimers.timers[0]?.callback()
  await flush()
  coordinator.preview('Hello world', 'en', 1, 'segment-1')
  coordinator.preview('Hello', 'en', 1, 'segment-1')

  pending.resolve({ translation: '你好' })
  await coordinator.idle()
  assert.deepEqual(calls, ['Hello'])
})

/**
 * 校验 final 到达时应立即抢占运行中的预翻译，避免继续等待旧 partial。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕 final 应抢占运行中的预翻译并跳过排队文本', async () => {
  const manualTimers = createManualTimers()
  const pending = deferred<{ translation: string }>()
  const calls: string[] = []
  const completed: string[] = []
  let aborted = false
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 200,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text, _settings, _dingTalk, _aiKey, options) => {
      calls.push(text)
      if (text === 'Hello') {
        options.signal?.addEventListener('abort', () => {
          aborted = true
          pending.reject(new Error('aborted'))
        }, { once: true })
        return pending.promise as never
      }
      options.onDelta('最终')
      return { translation: '最终' } as never
    },
    onDelta: () => undefined,
    onComplete: (id) => completed.push(id),
    onError: () => assert.fail('final 翻译不应失败'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  manualTimers.timers[0]?.callback()
  await flush()
  coordinator.preview('Hello world', 'en', 1, 'segment-1')

  coordinator.submit('Hello world!', 'en', 1, 'segment-1')
  await coordinator.idle()

  assert.equal(aborted, true)
  assert.deepEqual(calls, ['Hello', 'Hello world!'])
  assert.deepEqual(completed, ['segment-1'])
})

/**
 * 校验已完成的预翻译可直接用于同文 final，避免重复请求模型。
 * @returns 无返回值。
 * @author zhenghq
 */
test('已完成 partial 预翻译应直接复用于同文 final', async () => {
  const manualTimers = createManualTimers()
  let calls = 0
  const completed: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 100,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async () => {
      calls += 1
      return { translation: '你好' } as never
    },
    onDelta: () => undefined,
    onComplete: (id) => completed.push(id),
    onError: () => assert.fail('不应失败'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  manualTimers.timers[0]?.callback()
  await coordinator.idle()
  assert.equal(calls, 1)
  assert.deepEqual(completed, [])

  coordinator.submit('Hello', 'en', 1, 'segment-1')
  assert.equal(calls, 1)
  assert.deepEqual(completed, ['segment-1'])
})

/**
 * 校验新 partial 重置稳定计时，但首次草稿的最大等待计时不会被重置。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 partial 应重置稳定计时但不重置最大等待', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  let now = 0
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 300,
    previewMaxWaitMs: 1_000,
    previewMinIntervalMs: 0,
    nowFn: () => now,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      return { translation: `译文:${text}` } as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('预翻译不应失败'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  const firstStableTimer = manualTimers.timers.find(
    (timer) => timer.delayMs === 300 && !timer.cleared
  )
  const maximumWaitTimer = manualTimers.timers.find(
    (timer) => timer.delayMs === 1_000 && !timer.cleared
  )
  assert.ok(firstStableTimer)
  assert.ok(maximumWaitTimer)

  now = 200
  coordinator.preview('Hello world', 'en', 1, 'segment-1')
  assert.equal(firstStableTimer.cleared, true, '新 partial 应重置稳定计时')
  assert.equal(
    manualTimers.timers.filter((timer) => timer.delayMs === 300 && !timer.cleared).length,
    1,
    '应只保留一个有效的稳定计时器'
  )
  assert.equal(maximumWaitTimer.cleared, false, '后续 partial 不应重置最大等待计时器')

  maximumWaitTimer.callback()
  await flush()
  assert.deepEqual(calls, ['Hello world'], '最大等待到点后应翻译最新的完整草稿')
  assert.equal(
    manualTimers.timers.filter((timer) => timer.delayMs === 300 && !timer.cleared).length,
    0,
    '最大等待触发时应取消尚未执行的稳定计时'
  )
})

/**
 * 校验稳定计时到点后清除最大等待计时，避免同一草稿重复发起预览。
 * @returns 无返回值。
 * @author zhenghq
 */
test('稳定计时触发后应清除最大等待计时', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 250,
    previewMaxWaitMs: 1_000,
    previewMinIntervalMs: 0,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      return { translation: '你好' } as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('预翻译不应失败'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  const stableTimer = manualTimers.timers.find((timer) => timer.delayMs === 250)
  const maximumWaitTimer = manualTimers.timers.find((timer) => timer.delayMs === 1_000)
  assert.ok(stableTimer)
  assert.ok(maximumWaitTimer)

  stableTimer.callback()
  await coordinator.idle()

  assert.deepEqual(calls, ['Hello'])
  assert.equal(maximumWaitTimer.cleared, true)
})

/**
 * 校验不同原文的预览翻译遵守最小请求间隔，避免连续 partial 触发请求风暴。
 * @returns 无返回值。
 * @author zhenghq
 */
test('连续 partial 的预览翻译应遵守最小请求间隔', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  let now = 10_000
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 0,
    previewMinIntervalMs: 1_500,
    nowFn: () => now,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      return { translation: `译文:${text}` } as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('预翻译不应失败'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  await coordinator.idle()
  assert.deepEqual(calls, ['Hello'])

  now += 500
  coordinator.preview('Hello world', 'en', 1, 'segment-1')
  assert.deepEqual(calls, ['Hello'], '最小间隔内的新预览不得立即发请求')
  const paceTimer = manualTimers.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 1_000
  )
  assert.ok(paceTimer, '应按剩余最小间隔安排预览请求')

  now += 1_000
  paceTimer.callback()
  await coordinator.idle()
  assert.deepEqual(calls, ['Hello', 'Hello world'])
})

/**
 * 校验 final 翻译不受预览翻译最小间隔限制。
 * @returns 无返回值。
 * @author zhenghq
 */
test('final 翻译应立即抢占预览请求间隔', async () => {
  const manualTimers = createManualTimers()
  const first = deferred<{ translation: string }>()
  const calls: string[] = []
  let now = 20_000
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 0,
    previewMinIntervalMs: 1_500,
    nowFn: () => now,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text, _settings, _dingTalk, _aiKey, options) => {
      calls.push(text)
      if (text === 'Hello') {
        options.signal?.addEventListener('abort', () => first.reject(new Error('aborted')), { once: true })
        return first.promise as never
      }
      return { translation: '最终译文' } as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('final 翻译不应失败'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  await flush()
  assert.deepEqual(calls, ['Hello'])

  now += 100
  coordinator.submit('Hello world!', 'en', 1, 'segment-1')
  await coordinator.idle()

  assert.deepEqual(calls, ['Hello', 'Hello world!'])
})

/**
 * 校验会话失效会取消等待最小间隔的预览任务。
 * @returns 无返回值。
 * @author zhenghq
 */
test('会话失效应取消预览请求节流计时器', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  let now = 30_000
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 0,
    previewMinIntervalMs: 1_500,
    nowFn: () => now,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      return { translation: '你好' } as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('取消请求不应上报错误'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  await coordinator.idle()
  now += 200
  coordinator.preview('Hello world', 'en', 1, 'segment-1')
  const paceTimer = manualTimers.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 1_300
  )
  assert.ok(paceTimer)

  coordinator.invalidate()
  assert.equal(paceTimer.cleared, true)
  paceTimer.callback()
  await flush()
  assert.deepEqual(calls, ['Hello'])
})

/**
 * 校验预览翻译遇到限流后会暂停后续预览请求，避免持续放大 429 错误。
 * @returns 无返回值。
 * @author zhenghq
 */
test('预览翻译遇到限流后应进入冷却期', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  let now = 40_000
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 0,
    previewMinIntervalMs: 1_500,
    previewRateLimitCooldownMs: 30_000,
    nowFn: () => now,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      if (calls.length === 1) {
        throw Object.assign(new Error('rate limited'), { kind: 'rate-limit' })
      }
      return { translation: '你好' } as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('预览限流不应作为 final 错误上报'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  await coordinator.idle()
  now += 100
  coordinator.preview('Hello world', 'en', 1, 'segment-1')

  assert.deepEqual(calls, ['Hello'])
  const cooldownTimer = manualTimers.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 29_900
  )
  assert.ok(cooldownTimer, '限流后应按冷却剩余时间安排下一次预览')

  now += 29_900
  cooldownTimer.callback()
  await coordinator.idle()
  assert.deepEqual(calls, ['Hello', 'Hello world'])
})

/**
 * 校验预览限流错误携带 Retry-After 时应优先采用服务端建议的冷却时间。
 * @returns 无返回值。
 * @author zhenghq
 */
test('预览限流应优先遵守 Retry-After 建议的冷却时间', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  let now = 45_000
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 0,
    previewMinIntervalMs: 0,
    previewRateLimitCooldownMs: 30_000,
    nowFn: () => now,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      if (calls.length === 1) {
        throw Object.assign(new Error('rate limited'), {
          kind: 'rate-limit',
          retryAfterMs: 4_000
        })
      }
      return { translation: '你好' } as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('预览限流不应作为 final 错误上报'),
    onReset: () => undefined
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  await coordinator.idle()
  now += 100
  coordinator.preview('Hello world', 'en', 1, 'segment-1')

  const cooldownTimer = manualTimers.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 3_900
  )
  assert.ok(cooldownTimer, '应按 Retry-After 的剩余 3.9 秒安排下一次预览')
})

/**
 * 校验 final 翻译遇到可恢复错误时会退避重试并最终完成。
 * @returns 无返回值。
 * @author zhenghq
 */
test('final 翻译失败后应退避重试并最终完成', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  const completed: string[] = []
  let now = 50_000
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    finalMaxAttempts: 3,
    finalRetryBaseDelayMs: 600,
    finalRequestDeadlineMs: 15_000,
    nowFn: () => now,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      if (calls.length === 1) {
        throw Object.assign(new Error('network down'), { kind: 'network' })
      }
      return { translation: '你好' } as never
    },
    onDelta: () => undefined,
    onComplete: (id) => completed.push(id),
    onError: () => assert.fail('可恢复错误重试成功后不应上报失败'),
    onReset: () => undefined
  })

  coordinator.submit('Hello', 'en', 1, 'segment-1')
  await flush()
  assert.deepEqual(calls, ['Hello'])
  const retryTimer = manualTimers.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 600
  )
  assert.ok(retryTimer, 'final 失败后应按退避间隔安排重试')

  now += 600
  retryTimer.callback()
  await coordinator.idle()
  assert.deepEqual(calls, ['Hello', 'Hello'])
  assert.deepEqual(completed, ['segment-1'])
})

/**
 * 校验 final 限流重试应等待服务端建议时间，而不是立即按较短退避重试。
 * @returns 无返回值。
 * @author zhenghq
 */
test('final 限流重试应遵守 Retry-After 建议', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  const completed: string[] = []
  let now = 55_000
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    finalMaxAttempts: 3,
    finalRetryBaseDelayMs: 600,
    finalRequestDeadlineMs: 15_000,
    nowFn: () => now,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      if (calls.length === 1) {
        throw Object.assign(new Error('rate limited'), {
          kind: 'rate-limit',
          retryAfterMs: 3_000
        })
      }
      return { translation: '你好' } as never
    },
    onDelta: () => undefined,
    onComplete: (id) => completed.push(id),
    onError: () => assert.fail('限流重试成功后不应上报失败'),
    onReset: () => undefined
  })

  coordinator.submit('Hello', 'en', 1, 'segment-1')
  await flush()
  const retryTimer = manualTimers.timers.find(
    (timer) => !timer.cleared && timer.delayMs === 3_000
  )
  assert.ok(retryTimer, 'final 应等待 Retry-After 后再重试')

  now += 3_000
  retryTimer.callback()
  await coordinator.idle()
  assert.deepEqual(calls, ['Hello', 'Hello'])
  assert.deepEqual(completed, ['segment-1'])
})

/**
 * 校验 final 翻译达到最大尝试次数后只上报一次失败。
 * @returns 无返回值。
 * @author zhenghq
 */
test('final 翻译重试耗尽后应只上报一次错误', async () => {
  const manualTimers = createManualTimers()
  const errors: string[] = []
  let now = 60_000
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    finalMaxAttempts: 3,
    finalRetryBaseDelayMs: 500,
    finalRequestDeadlineMs: 15_000,
    nowFn: () => now,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async () => {
      throw Object.assign(new Error('service unavailable'), { kind: 'service' })
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: (_id, error) => errors.push(error.message),
    onReset: () => undefined
  })

  coordinator.submit('Hello', 'en', 1, 'segment-1')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await flush()
    const timer = manualTimers.timers.find((candidate) => !candidate.cleared)
    assert.ok(timer, '失败后应安排下一次退避重试')
    now += timer.delayMs
    timer.cleared = true
    timer.callback()
  }
  await coordinator.idle()

  assert.equal(manualTimers.timers.length, 2)
  assert.deepEqual(errors, ['service unavailable'])
})

/**
 * 校验会话失效会取消等待中的 final 重试,避免旧会话继续请求。
 * @returns 无返回值。
 * @author zhenghq
 */
test('会话失效应取消等待中的 final 重试', async () => {
  const manualTimers = createManualTimers()
  const calls: string[] = []
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    finalMaxAttempts: 3,
    finalRetryBaseDelayMs: 600,
    nowFn: () => 70_000,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (text) => {
      calls.push(text)
      throw Object.assign(new Error('timeout'), { kind: 'timeout' })
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('取消的重试不应上报失败'),
    onReset: () => undefined
  })

  coordinator.submit('Hello', 'en', 1, 'segment-1')
  await flush()
  const retryTimer = manualTimers.timers.find((timer) => !timer.cleared)
  assert.ok(retryTimer)

  coordinator.invalidate()
  assert.equal(retryTimer.cleared, true)
  retryTimer.callback()
  await flush()
  assert.deepEqual(calls, ['Hello'])
})
