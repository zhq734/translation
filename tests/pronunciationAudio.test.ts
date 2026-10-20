import assert from 'node:assert/strict'
import test from 'node:test'
import { PronunciationService } from '../src/main/pronunciationService.ts'

const dictionaryPayload = [
  {
    phonetics: [
      { text: '/həˈloʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-us.mp3' }
    ]
  }
]

/**
 * 创建测试用 JSON 响应。
 * @param payload 响应 JSON 负载。
 * @returns Fetch Response 对象。
 * @author zhenghq
 */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

test('音频代理只允许下载已缓存音标结果中登记的变体', async () => {
  const urls: string[] = []
  const service = new PronunciationService({
    fetch: async (input) => {
      urls.push(String(input))
      if (urls.length === 1) return jsonResponse(dictionaryPayload)
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '3' }
      })
    }
  })

  const result = await service.lookup('hello')
  const variant = result.variants[0]
  assert.ok(variant)

  const audio = await service.getAudio('hello', variant.id)
  assert.equal(audio.ok, true)
  if (audio.ok) {
    assert.deepEqual(Array.from(audio.audio), [1, 2, 3])
    assert.equal(audio.mimeType, 'audio/mpeg')
    assert.equal(audio.size, 3)
  }

  const before = urls.length
  const rejected = await service.getAudio('hello', 'forged-variant')
  assert.equal(rejected.ok, false)
  assert.equal(urls.length, before)
})

test('音频代理应拒绝未缓存单词、非音频 MIME、超大响应和下载失败', async () => {
  const oversizedService = new PronunciationService({
    maxAudioBytes: 2,
    fetch: async (input) => {
      if (String(input).includes('/hello')) return jsonResponse(dictionaryPayload)
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '3' }
      })
    }
  })
  const result = await oversizedService.lookup('hello')
  assert.equal((await oversizedService.getAudio('hello', result.variants[0]?.id ?? '')).ok, false)

  const htmlService = new PronunciationService({
    fetch: async (input) => {
      if (String(input).includes('/hello')) return jsonResponse(dictionaryPayload)
      return new Response('<html>not audio</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    }
  })
  const htmlResult = await htmlService.lookup('hello')
  assert.equal((await htmlService.getAudio('hello', htmlResult.variants[0]?.id ?? '')).ok, false)

  const failingService = new PronunciationService({
    fetch: async (input) => {
      if (String(input).includes('/hello')) return jsonResponse(dictionaryPayload)
      throw new Error('download failed with secret')
    }
  })
  const failingResult = await failingService.lookup('hello')
  const failure = await failingService.getAudio('hello', failingResult.variants[0]?.id ?? '')
  assert.equal(failure.ok, false)
  assert.equal(JSON.stringify(failure).includes('secret'), false)

  const uncached = await failingService.getAudio('world', 'us-0')
  assert.equal(uncached.ok, false)
})

test('音频代理应支持取消并停止继续下载', async () => {
  let aborted = false
  const service = new PronunciationService({
    fetch: async (input, init) => {
      if (String(input).includes('/hello')) return jsonResponse(dictionaryPayload)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
    }
  })

  const result = await service.lookup('hello')
  const controller = new AbortController()
  const pending = service.getAudio('hello', result.variants[0]?.id ?? '', controller.signal)
  await Promise.resolve()
  controller.abort()

  const audio = await pending
  assert.equal(audio.ok, false)
  assert.equal(aborted, true)
})
