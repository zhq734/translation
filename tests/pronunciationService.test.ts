import assert from 'node:assert/strict'
import test from 'node:test'
import { PronunciationService } from '../src/main/pronunciationService.ts'

const helloPayload = [
  {
    phonetics: [
      { text: '/həˈloʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-us.mp3' },
      { text: '/həˈləʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3' }
    ],
    license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0' },
    sourceUrls: ['https://en.wiktionary.org/wiki/hello']
  }
]

const helloPayloadWithFiveDefinitions = [
  {
    phonetics: [
      { text: '/həˈloʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-us.mp3' }
    ],
    meanings: [
      {
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'A greeting said when meeting someone.' },
          { definition: 'The act of saying hello.' },
          { definition: 'An utterance of hello.' },
          { definition: 'A call to attract attention.' },
          { definition: 'A message of greeting.' }
        ]
      }
    ]
  }
]

/**
 * 创建测试用 JSON 响应。
 * @param payload 响应 JSON 负载。
 * @param init 可选状态码与响应头。
 * @returns Fetch Response 对象。
 * @author zhenghq
 */
function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  })
}

test('词典服务成功查询应返回音标并复用缓存', async () => {
  const urls: string[] = []
  const service = new PronunciationService({
    fetch: async (input) => {
      urls.push(String(input))
      return jsonResponse(helloPayload)
    }
  })

  const first = await service.lookup('hello')
  const second = await service.lookup('HELLO')

  assert.equal(first.status, 'available')
  assert.deepEqual(second, first)
  assert.equal(urls.length, 1)
  assert.match(urls[0], /^https:\/\/api\.dictionaryapi\.dev\/api\/v2\/entries\/en\/hello$/u)
})

test('通用词典释义达到上限时仍应保留雅思中文释义', async () => {
  const service = new PronunciationService({
    fetch: async () => jsonResponse(helloPayloadWithFiveDefinitions),
    ieltsDictionary: {
      lookup: (word) => word === 'hello'
        ? {
            word: 'hello',
            ipa: 'həˈləʊ',
            definitions: [{ text: 'int. 喂；哈喽；n. “喂”的招呼声或问候声', language: 'zh', source: 'iscorevoc' }],
            source: 'iscorevoc'
          }
        : null
    }
  })

  const result = await service.lookup('hello')

  assert.equal(result.status, 'available')
  assert.equal(result.definitions?.length, 5)
  assert.deepEqual(result.definitions?.[0], {
    text: 'int. 喂；哈喽；n. “喂”的招呼声或问候声',
    language: 'zh',
    source: 'iscorevoc'
  })
})

test('词典服务应将 404、非 JSON 和超大响应降级为脱敏不可用结果', async () => {
  const notFound = new PronunciationService({ fetch: async () => new Response('not found', { status: 404 }) })
  assert.equal((await notFound.lookup('missing')).status, 'unavailable')

  const invalidJson = new PronunciationService({ fetch: async () => new Response('not json', { status: 200 }) })
  assert.equal((await invalidJson.lookup('hello')).status, 'unavailable')

  const oversized = new PronunciationService({
    maxResponseBytes: 16,
    fetch: async () => jsonResponse(helloPayload)
  })
  assert.equal((await oversized.lookup('hello')).status, 'unavailable')
})

test('词典服务超时应中止请求并返回脱敏不可用结果', async () => {
  let aborted = false
  const service = new PronunciationService({
    timeoutMs: 10,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  })

  const result = await service.lookup('hello')
  assert.equal(result.status, 'unavailable')
  assert.equal(aborted, true)
})

test('相同单词并发查询应只请求上游一次', async () => {
  let requests = 0
  let resolveFetch: ((response: Response) => void) | null = null
  const service = new PronunciationService({
    fetch: async () => {
      requests += 1
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    }
  })

  const first = service.lookup('hello')
  const second = service.lookup('hello')
  await Promise.resolve()
  assert.equal(requests, 1)
  resolveFetch?.(jsonResponse(helloPayload))

  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(left, right)
  assert.equal(requests, 1)
})

test('单个调用方取消不应中止其它调用方共享的词典查询', async () => {
  let requests = 0
  let aborted = false
  let resolveFetch: ((response: Response) => void) | null = null
  const service = new PronunciationService({
    fetch: async (_input, init) => {
      requests += 1
      return new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
    }
  })
  const firstController = new AbortController()
  const first = service.lookup('hello', firstController.signal)
  const second = service.lookup('hello')
  await Promise.resolve()

  firstController.abort()
  resolveFetch?.(jsonResponse(helloPayload))

  assert.equal((await first).status, 'unavailable')
  assert.equal((await first).word, 'hello')
  assert.equal((await second).status, 'available')
  assert.equal(requests, 1)
  assert.equal(aborted, false)
})

test('无取消信号的调用方仍依赖共享查询时，另一个调用方取消不得中止上游', async () => {
  let aborted = false
  let resolveFetch: ((response: Response) => void) | null = null
  const service = new PronunciationService({
    fetch: async (_input, init) => new Promise<Response>((resolve, reject) => {
      resolveFetch = resolve
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  })
  const secondController = new AbortController()
  const first = service.lookup('hello')
  const second = service.lookup('hello', secondController.signal)
  await Promise.resolve()

  secondController.abort()
  resolveFetch?.(jsonResponse(helloPayload))

  assert.equal((await second).status, 'unavailable')
  assert.equal((await first).status, 'available')
  assert.equal(aborted, false)
})

test('相同单词的所有调用方取消后才中止上游查询', async () => {
  let aborted = false
  const service = new PronunciationService({
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  })
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = service.lookup('hello', firstController.signal)
  const second = service.lookup('hello', secondController.signal)
  await Promise.resolve()

  firstController.abort()
  await first
  assert.equal(aborted, false)

  secondController.abort()
  assert.equal((await second).status, 'unavailable')
  assert.equal(aborted, true)
})

test('所有格精确查询失败后应回退基础词并保留当前查询词', async () => {
  const urls: string[] = []
  const service = new PronunciationService({
    fetch: async (input) => {
      urls.push(String(input))
      if (urls.length === 1) return new Response('not found', { status: 404 })
      return jsonResponse(helloPayload)
    }
  })

  const result = await service.lookup('student’s')
  assert.equal(result.status, 'available')
  assert.equal(result.word, "student's")
  assert.deepEqual(urls.map((url) => new URL(url).pathname.split('/').at(-1)), ['student%27s', 'student'])
})

test('词典服务错误不得泄露底层异常内容', async () => {
  const service = new PronunciationService({
    fetch: async () => {
      throw new Error('secret stack and query hello')
    }
  })

  const result = await service.lookup('hello')
  assert.deepEqual(result, {
    status: 'unavailable',
    word: 'hello',
    language: 'en',
    variants: [],
    source: 'dictionaryapi'
  })
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('词典服务不应为不可查询输入发起网络请求', async () => {
  let requests = 0
  const service = new PronunciationService({
    fetch: async () => {
      requests += 1
      return jsonResponse(helloPayload)
    }
  })

  const result = await service.lookup('https://example.com')
  assert.equal(result.status, 'unsupported')
  assert.equal(requests, 0)
})
