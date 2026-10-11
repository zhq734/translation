import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiStreamParser } from '../src/main/aiStreamProtocol.ts'
import { AiTranslationStreamSanitizer } from '../src/shared/aiTranslationStreamSanitize.ts'
import { AiTranslationClient } from '../src/main/aiTranslationClient.ts'
import { AiError } from '../src/main/aiErrors.ts'
import { TranslationRuntime } from '../src/main/translate.ts'
import { normalizeSettings } from '../src/shared/settingsDefaults.ts'
import type { Settings } from '../src/shared/types.ts'

/**
 * 构造一个按给定分片输出的 SSE 响应。
 * @param chunks 网络分片文本。
 * @param contentType 响应 Content-Type。
 * @returns 可供流式客户端读取的 Response。
 * @author zhenghq
 */
function streamingResponse(chunks: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': contentType } })
}

/**
 * 构造启用 AI 的设置快照。
 * @param overrides 覆盖字段。
 * @returns 规范化后的设置。
 * @author zhenghq
 */
function aiSettings(overrides: Partial<Settings> = {}): Settings {
  return normalizeSettings({
    schemaVersion: 20,
    aiEnabled: true,
    aiProtocol: 'openai',
    aiBaseUrl: 'https://api.example.com',
    aiModel: 'gpt-4o',
    aiApiKeyConfigured: true,
    sourceLang: 'EN',
    targetLang: 'ZH',
    ...overrides
  } as never)
}

/**
 * 构造 OpenAI SSE 文本增量事件。
 * @param text 增量文本。
 * @returns SSE 事件字符串。
 * @author zhenghq
 */
function openAiDelta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

test('OpenAI SSE 解析应支持多个 data 增量、空增量与 [DONE] 结束标记', () => {
  const parser = createAiStreamParser('openai')
  const deltas = [
    ...parser.push(openAiDelta('你好')),
    ...parser.push('data: {"choices":[{"delta":{}}]}\n\n'),
    ...parser.push(openAiDelta('，世界')),
    ...parser.push('data: [DONE]\n\n')
  ]
  assert.deepEqual(deltas, ['你好', '，世界'])
  assert.deepEqual(parser.finish(), [])
})

test('OpenAI SSE 解析应缓冲被网络分片切断的事件', () => {
  const parser = createAiStreamParser('openai')
  const first = parser.push('data: {"choices":[{"delta":{"cont')
  const second = parser.push('ent":"跨分片"}}]}\n\n')
  assert.deepEqual(first, [])
  assert.deepEqual(second, ['跨分片'])
})

test('OpenAI SSE 遇到 error 事件应抛出脱敏 AiError，非 JSON 数据应忽略', () => {
  const parser = createAiStreamParser('openai')
  parser.push('data: not-json\n\n')
  assert.throws(
    () => parser.push('data: {"error":{"message":"boom"}}\n\n'),
    (error: unknown) => error instanceof AiError && error.kind === 'service'
  )
})

test('Ollama 逐行 JSON 解析应支持多行、done 标记与错误行', () => {
  const parser = createAiStreamParser('ollama')
  const deltas = [
    ...parser.push('{"message":{"content":"第一"},"done":false}\n'),
    ...parser.push('{"message":{"content":""},"done":false}\n{"message":{"content":"第二"},"done":false}\n'),
    ...parser.push('{"message":{"content":""},"done":true}\n')
  ]
  assert.deepEqual(deltas, ['第一', '第二'])

  const errorParser = createAiStreamParser('ollama')
  assert.throws(
    () => errorParser.push('{"error":"model not found"}\n'),
    (error: unknown) => error instanceof AiError && error.kind === 'service'
  )
})

test('Ollama 逐行 JSON 解析应缓冲跨网络分片的行', () => {
  const parser = createAiStreamParser('ollama')
  assert.deepEqual(parser.push('{"message":{"cont'), [])
  assert.deepEqual(parser.push('ent":"补齐"},"done":false}\n'), ['补齐'])
})

test('Claude SSE 解析应读取文本增量、忽略元数据事件并识别结束与错误事件', () => {
  const parser = createAiStreamParser('claude-code')
  const deltas = [
    ...parser.push('event: message_start\ndata: {"type":"message_start"}\n\n'),
    ...parser.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude"}}\n\n'),
    ...parser.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" 译文"}}\n\n'),
    ...parser.push('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  ]
  assert.deepEqual(deltas, ['Claude', ' 译文'])

  const errorParser = createAiStreamParser('claude-code')
  assert.throws(
    () => errorParser.push('event: error\ndata: {"type":"error","error":{"message":"boom"}}\n\n'),
    (error: unknown) => error instanceof AiError
  )
})

test('流式净化应暂存跨片段的推理标签，闭合后才输出后续译文', () => {
  const sanitizer = new AiTranslationStreamSanitizer()
  assert.equal(sanitizer.push('<thi'), '')
  assert.equal(sanitizer.push('nk>先分析'), '')
  assert.equal(sanitizer.push('再输出</thi'), '')
  assert.equal(sanitizer.push('nk>你好'), '你好')
  assert.equal(sanitizer.finish(), '你好')
})

test('流式净化应暂存工具调用前缀与调度指令，不把噪声当作译文显示', () => {
  const sanitizer = new AiTranslationStreamSanitizer()
  assert.equal(sanitizer.push('sea'), '')
  assert.equal(sanitizer.push('rch("x")fast|translate phrase'), '')
  assert.equal(sanitizer.push('\n你好'), '你好')
  assert.equal(sanitizer.finish(), '你好')
})

test('流式净化应暂存未闭合的 Markdown 包裹并去掉译文标签前缀', () => {
  const sanitizer = new AiTranslationStreamSanitizer()
  assert.equal(sanitizer.push('```text\n'), '')
  assert.equal(sanitizer.push('你好'), '')
  assert.equal(sanitizer.push('\n```'), '你好')
  assert.equal(sanitizer.finish(), '你好')

  const labeled = new AiTranslationStreamSanitizer()
  assert.equal(labeled.push('译'), '')
  assert.equal(labeled.push('文：你好'), '你好')
  assert.equal(labeled.finish(), '你好')
})

test('流式净化 finish 应以完整清洗结果校正已展示片段', () => {
  const sanitizer = new AiTranslationStreamSanitizer()
  sanitizer.push('你好，世')
  assert.equal(sanitizer.push('界'), '界')
  assert.equal(sanitizer.finish(), '你好，世界')
})

test('流式客户端应按顺序回调安全片段并返回最终清洗译文', async () => {
  const deltas: string[] = []
  const client = new AiTranslationClient({
    fetch: async () => streamingResponse([
      openAiDelta('你'),
      openAiDelta('好'),
      'data: [DONE]\n\n'
    ])
  })
  const final = await client.stream({
    protocol: 'openai',
    baseUrl: 'https://api.example.com',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    text: 'hello',
    sourceLang: 'EN',
    targetLang: 'ZH'
  }, { onDelta: (delta) => deltas.push(delta) })
  assert.deepEqual(deltas, ['你', '好'])
  assert.equal(final, '你好')
})

test('流式客户端应支持外部 AbortSignal 取消并抛出超时分类错误', async () => {
  const client = new AiTranslationClient({
    fetch: async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        }
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
  })
  const controller = new AbortController()
  const promise = client.stream({
    protocol: 'openai',
    baseUrl: 'https://api.example.com',
    model: 'gpt-4o',
    apiKey: null,
    text: 'hello',
    sourceLang: 'EN',
    targetLang: 'ZH'
  }, { onDelta: () => undefined, signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, (error: unknown) => error instanceof AiError)
})

test('AI 首个片段前失败时允许降级到后续通道', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('chat/completions')) throw new Error('network down')
      if (value.includes('api.deeplx.org')) {
        return new Response(JSON.stringify({ code: 200, data: '降级结果' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      throw new Error(`不应请求：${value}`)
    }
  })
  const deltas: string[] = []
  const result = await runtime.translateStream('hello', aiSettings(), null, 'sk-ai', {
    onDelta: (delta) => deltas.push(delta)
  })
  assert.equal(result.provider, 'deeplx-public')
  assert.equal(result.translation, '降级结果')
  assert.deepEqual(deltas, [])
  assert.ok(calls.some((url) => url.includes('chat/completions')))
})

test('AI 首个片段后失败时不得静默降级替换，且保留已展示内容', async () => {
  const calls: string[] = []
  const runtime = new TranslationRuntime({
    fetch: async (url) => {
      const value = String(url)
      calls.push(value)
      if (value.includes('chat/completions')) {
        const encoder = new TextEncoder()
        let pulls = 0
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1
            if (pulls === 1) {
              controller.enqueue(encoder.encode(openAiDelta('半')))
              return
            }
            controller.error(new Error('connection reset'))
          }
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify({ code: 200, data: '不应使用' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  })
  const deltas: string[] = []
  await assert.rejects(
    runtime.translateStream('hello', aiSettings(), null, 'sk-ai', {
      onDelta: (delta) => deltas.push(delta)
    })
  )
  assert.deepEqual(deltas, ['半'])
  assert.equal(calls.some((url) => url.includes('deeplx')), false)
})
