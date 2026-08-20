import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createEdgePlaybackController,
  type EdgeAudioLike
} from '../src/renderer/src/edgeSpeechPlayback.ts'

class FakeAudio implements EdgeAudioLike {
  onended: (() => void) | null = null
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
    if (this.playResult === 'resolve') this.onended?.()
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
  audios[0].onended?.()
  await flushMicrotasks()
  assert.equal(audios.length, 2)
  audios[1].onended?.()

  assert.deepEqual(await resultPromise, { ok: true })
  assert.deepEqual(chunks, ['第一段。', '第二段。'])
  assert.deepEqual(revoked, ['blob:1', 'blob:2'])
  assert.equal(completed, 1)
  assert.equal(controller.isSpeaking(), false)
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

test('停止 Edge 播放应取消当前会话且不再合成后续片段', async () => {
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
  assert.deepEqual(chunks, ['第一段。'])
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
  staleEnded?.()
  assert.equal(controller.isSpeaking(), true)
  audios[1].onended?.()

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
