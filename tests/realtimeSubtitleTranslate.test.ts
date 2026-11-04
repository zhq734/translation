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
 * 校验只有 final 段进入翻译，且增量与完成回调携带同一段标识。
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
 * 校验 partial 内容变化会取消旧请求并清空旧译文，避免短暂展示过期翻译。
 * @returns 无返回值。
 * @author zhenghq
 */
test('字幕 partial 变化应取消旧预翻译并清空旧译文', async () => {
  const manualTimers = createManualTimers()
  const reset: Array<{ id: string; phase: string }> = []
  let aborted = false
  const coordinator = new SubtitleTranslationCoordinator({
    getSettings: () => normalizeSettings({ targetLang: 'zh-CN' }),
    getDingTalkCredentials: () => null,
    getAiApiKey: () => null,
    previewDebounceMs: 200,
    setTimeoutFn: manualTimers.setTimeoutFn,
    clearTimeoutFn: manualTimers.clearTimeoutFn,
    translateStream: async (_text, _settings, _dingTalk, _aiKey, options) => {
      options.onDelta('旧译文')
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        }, { once: true })
      }) as never
    },
    onDelta: () => undefined,
    onComplete: () => undefined,
    onError: () => assert.fail('取消请求不应上报错误'),
    onReset: (id, phase) => reset.push({ id, phase })
  })

  coordinator.preview('Hello', 'en', 1, 'segment-1')
  manualTimers.timers[0]?.callback()
  await flush()
  coordinator.preview('Hello world', 'en', 1, 'segment-1')

  assert.equal(aborted, true)
  assert.deepEqual(reset, [{ id: 'segment-1', phase: 'preview' }])
  coordinator.invalidate()
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
