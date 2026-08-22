import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createEdgePlaybackController,
  type EdgeAudioBufferLike,
  type EdgeAudioContextLike,
  type EdgeAudioLike
} from '../src/renderer/src/edgeSpeechPlayback.ts'

class FakeAudio implements EdgeAudioLike {
  onended: ((event: Event) => void) | null = null
  onerror: (() => void) | null = null
  pauseCount = 0
  loadCount = 0
  removedAttributes: string[] = []
  playCalledWithoutLoad = false
  preload = ''
  volume = 0
  muted = true

  constructor(
    public src: string,
    private readonly playResult: 'pending' | 'resolve' | 'reject' = 'pending'
  ) {}

  /** 模拟开始播放，并按测试配置决定结果。 */
  async play(): Promise<void> {
    this.playCalledWithoutLoad = this.loadCount === 0
    if (this.playResult === 'reject') throw new Error('play failed')
    if (this.playResult === 'resolve') this.onended?.(new Event('ended'))
  }

  /** 记录暂停次数。 */
  pause(): void {
    this.pauseCount += 1
  }

  /** 记录移除的音频属性。 */
  removeAttribute(name: string): void {
    this.removedAttributes.push(name)
  }

  /** 记录音频资源重置次数。 */
  load(): void {
    this.loadCount += 1
  }
}

class FakeBufferSource {
  buffer: EdgeAudioBufferLike | null = null
  onended: ((event: Event) => void) | null = null
  startTimes: number[] = []
  connectedTo: unknown = null

  /** 连接到 AudioContext 的目标节点。 */
  connect(destination: unknown): void {
    this.connectedTo = destination
  }

  /** 记录音频源的计划开始时间。 */
  start(when = 0): void {
    this.startTimes.push(when)
  }

  /** 模拟停止音频源并触发结束回调。 */
  stop(): void {
    this.onended?.(new Event('ended'))
  }
}

class FakeAudioContext implements EdgeAudioContextLike {
  readonly destination = {}
  readonly sources: FakeBufferSource[] = []
  readonly decodedByteLengths: number[] = []
  currentTime = 10
  closed = false

  /** 模拟恢复 AudioContext。 */
  async resume(): Promise<void> {}

  /** 记录并返回一个固定时长的解码音频缓冲区。 */
  async decodeAudioData(data: ArrayBuffer): Promise<EdgeAudioBufferLike> {
    this.decodedByteLengths.push(data.byteLength)
    return { duration: 1.5 }
  }

  /** 创建并记录一个可测试的音频源。 */
  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource()
    this.sources.push(source)
    return source
  }

  /** 模拟关闭 AudioContext。 */
  async close(): Promise<void> {
    this.closed = true
  }
}

/** 等待当前微任务队列执行完毕。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('Edge 长文本应按顺序合成播放并释放每个临时 URL', async () => {
  const chunks: string[] = []
  const audios: FakeAudio[] = []
  const revoked: string[] = []
  let completed = 0
  const controller = createEdgePlaybackController({
    maxChunkLength: 4,
    synthesize: async (text) => {
      chunks.push(text)
      return { ok: true, audio: new Uint8Array([chunks.length]) }
    },
    createObjectUrl: () => `blob:${chunks.length}`,
    revokeObjectUrl: (url) => revoked.push(url),
    createAudio: (url) => {
      const audio = new FakeAudio(url)
      audios.push(audio)
      return audio
    },
    onComplete: () => { completed += 1 }
  })

  const resultPromise = controller.start('第一段。第二段。', 'ZH')
  await flushMicrotasks()
  assert.equal(audios.length, 1)
  audios[0].onended?.(new Event('ended'))
  await flushMicrotasks()
  assert.equal(audios.length, 2)
  audios[1].onended?.(new Event('ended'))

  assert.deepEqual(await resultPromise, { ok: true })
  assert.deepEqual(chunks, ['第一段。', '第二段。'])
  assert.deepEqual(revoked, ['blob:1', 'blob:2'])
  assert.equal(completed, 1)
  assert.equal(controller.isSpeaking(), false)
})

test('Edge 播放当前片段时应提前合成并预加载下一个片段', async () => {
  const chunks: string[] = []
  const audios: FakeAudio[] = []
  let resolveSecond: ((result: { ok: true; audio: Uint8Array }) => void) | null = null
  const controller = createEdgePlaybackController({
    maxChunkLength: 4,
    synthesize: (text) => {
      chunks.push(text)
      if (chunks.length === 1) return Promise.resolve({ ok: true, audio: new Uint8Array([1]) })
      return new Promise((resolve) => {
        resolveSecond = resolve
      })
    },
    createObjectUrl: () => `blob:${audios.length + 1}`,
    revokeObjectUrl: () => {},
    createAudio: (url) => {
      const audio = new FakeAudio(url)
      audios.push(audio)
      return audio
    }
  })

  const resultPromise = controller.start('第一段。第二段。', 'ZH')
  await flushMicrotasks()
  assert.deepEqual(chunks, ['第一段。', '第二段。'])
  assert.equal(audios.length, 1)

  audios[0].onended?.(new Event('ended'))
  await flushMicrotasks()
  assert.equal(audios.length, 1)

  resolveSecond?.({ ok: true, audio: new Uint8Array([2]) })
  await flushMicrotasks()
  assert.equal(audios.length, 2)
  assert.equal(audios[1].loadCount > 0, true)
  audios[1].onended?.(new Event('ended'))

  assert.deepEqual(await resultPromise, { ok: true })
})

test('Edge AudioContext 应按时间轴连续调度多个已解码片段', async () => {
  const context = new FakeAudioContext()
  const requested: string[] = []
  const controller = createEdgePlaybackController({
    maxChunkLength: 2,
    prefetchAhead: 2,
    synthesize: async (text) => {
      requested.push(text)
      return { ok: true, audio: new Uint8Array([requested.length, 2, 3]) }
    },
    createAudioContext: () => context,
    createAudio: () => new FakeAudio('unused'),
    createObjectUrl: () => 'unused',
    revokeObjectUrl: () => {}
  })

  const resultPromise = controller.start('一。二。三。', 'ZH')
  for (let index = 0; index < 12; index += 1) await flushMicrotasks()
  assert.deepEqual(requested, ['一。', '二。', '三。'])
  assert.equal(context.sources.length, 3)
  assert.deepEqual(context.sources.map((source) => source.startTimes[0]), [10.02, 11.52, 13.02])
  assert.deepEqual(context.decodedByteLengths, [3, 3, 3])
  assert.equal(context.sources.every((source) => source.connectedTo === context.destination), true)

  context.sources.at(-1)?.onended?.(new Event('ended'))
  assert.deepEqual(await resultPromise, { ok: true })
  assert.equal(context.closed, true)
})

test('Edge AudioContext 解码失败时应关闭上下文并返回脱敏错误', async () => {
  const context = new FakeAudioContext()
  context.decodeAudioData = async () => {
    throw new Error('decode failed')
  }
  const controller = createEdgePlaybackController({
    prefetchAhead: 1,
    synthesize: async () => ({ ok: true, audio: new Uint8Array([1, 2, 3]) }),
    createAudioContext: () => context,
    createAudio: () => new FakeAudio('unused'),
    createObjectUrl: () => 'unused',
    revokeObjectUrl: () => {}
  })

  const result = await controller.start('测试。', 'ZH')
  assert.deepEqual(result, { ok: false, error: 'Edge 音频解码失败' })
  assert.equal(context.closed, true)
})

test('Edge 音频开始播放前应主动加载音频资源', async () => {
  let audio: FakeAudio | null = null
  const controller = createEdgePlaybackController({
    synthesize: async () => ({ ok: true, audio: new Uint8Array([1]) }),
    createObjectUrl: () => 'blob:load',
    revokeObjectUrl: () => {},
    createAudio: (url) => {
      audio = new FakeAudio(url, 'resolve')
      return audio
    }
  })

  assert.deepEqual(await controller.start('测试', 'ZH'), { ok: true })
  assert.equal(audio?.playCalledWithoutLoad, false)
})

test('Edge 播放应依次报告网络请求、收到音频和开始播放阶段', async () => {
  const stages: string[] = []
  const controller = createEdgePlaybackController({
    synthesize: async () => ({ ok: true, audio: new Uint8Array([1, 2, 3]) }),
    createObjectUrl: () => 'blob:stages',
    revokeObjectUrl: () => {},
    createAudio: (url) => new FakeAudio(url, 'resolve'),
    onSynthesisStart: () => stages.push('request'),
    onAudioReady: (byteLength) => stages.push(`audio:${byteLength}`),
    onPlaybackStart: () => stages.push('play')
  })

  assert.deepEqual(await controller.start('测试', 'ZH'), { ok: true })
  assert.deepEqual(stages, ['request', 'audio:3', 'play'])
})

test('停止 Edge 播放应取消当前会话及预取请求', async () => {
  const chunks: string[] = []
  const audios: FakeAudio[] = []
  const states: boolean[] = []
  const controller = createEdgePlaybackController({
    maxChunkLength: 4,
    synthesize: async (text) => {
      chunks.push(text)
      return { ok: true, audio: new Uint8Array([1]) }
    },
    createObjectUrl: () => 'blob:current',
    revokeObjectUrl: () => {},
    createAudio: (url) => {
      const audio = new FakeAudio(url)
      audios.push(audio)
      return audio
    },
    onSpeakingChange: (speaking) => states.push(speaking)
  })

  const resultPromise = controller.start('第一段。第二段。', 'ZH')
  await flushMicrotasks()
  controller.stop()

  assert.deepEqual(await resultPromise, { ok: false, error: 'Edge 语音请求已取消' })
  assert.deepEqual(chunks, ['第一段。', '第二段。'])
  assert.equal(audios[0].pauseCount > 0, true)
  assert.deepEqual(states, [true, false])
})

test('新 Edge 会话应替换旧会话且旧音频回调不影响新会话', async () => {
  const audios: FakeAudio[] = []
  const controller = createEdgePlaybackController({
    synthesize: async () => ({ ok: true, audio: new Uint8Array([1]) }),
    createObjectUrl: () => `blob:${audios.length + 1}`,
    revokeObjectUrl: () => {},
    createAudio: (url) => {
      const audio = new FakeAudio(url)
      audios.push(audio)
      return audio
    }
  })

  const first = controller.start('旧译文', 'ZH')
  await flushMicrotasks()
  const staleEnded = audios[0].onended
  const second = controller.start('新译文', 'ZH')
  await flushMicrotasks()
  staleEnded?.(new Event('ended'))
  assert.equal(controller.isSpeaking(), true)
  audios[1].onended?.(new Event('ended'))

  assert.deepEqual(await first, { ok: false, error: 'Edge 语音请求已取消' })
  assert.deepEqual(await second, { ok: true })
})

test('Edge 音频播放拒绝时应返回脱敏错误并释放资源', async () => {
  const revoked: string[] = []
  const errors: string[] = []
  const controller = createEdgePlaybackController({
    synthesize: async () => ({ ok: true, audio: new Uint8Array([1]) }),
    createObjectUrl: () => 'blob:failed',
    revokeObjectUrl: (url) => revoked.push(url),
    createAudio: (url) => new FakeAudio(url, 'reject'),
    onError: (message) => errors.push(message)
  })

  assert.deepEqual(await controller.start('测试', 'ZH'), {
    ok: false,
    error: 'Edge 音频播放失败'
  })
  assert.deepEqual(revoked, ['blob:failed'])
  assert.deepEqual(errors, ['Edge 音频播放失败'])
})
