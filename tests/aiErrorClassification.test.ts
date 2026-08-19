import assert from 'node:assert/strict'
import test from 'node:test'
import { AiTranslationClient, type AiFetch } from '../src/main/aiTranslationClient.ts'
import type { AiProtocol } from '../src/shared/types.ts'

/**
 * 构造一个 JSON 响应。
 * @param body 响应体。
 * @param status HTTP 状态码。
 * @returns 可供客户端解析的 Response。
 * @author zhenghq
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const baseInput = {
  baseUrl: 'https://api.example.com',
  model: 'gpt-4o',
  text: 'hello',
  sourceLang: 'EN',
  targetLang: 'ZH'
} as const

/**
 * 构造一个可注入网络请求的 AI 翻译客户端。
 * @param fetch 可注入的请求函数。
 * @returns AI 翻译客户端实例。
 * @author zhenghq
 */
function makeClient(fetch: AiFetch): AiTranslationClient {
  return new AiTranslationClient({ fetch, timeoutMs: 200 })
}

test('HTTP 401 应分类为鉴权错误且不含 API Key', async () => {
  const calls: Record<string, string | null>[] = []
  const client = makeClient(async (url, init) => {
    const headers = init?.headers as Record<string, string>
    calls.push({ url: String(url), auth: headers?.['Authorization'] ?? null })
    return jsonResponse({ error: 'invalid api key sk-leak' }, 401)
  })
  await assert.rejects(
    client.translate({ ...baseInput, protocol: 'openai', apiKey: 'sk-secret' }),
    (error: Error) => {
      assert.match(error.message, /鉴权/u)
      assert.equal(error.message.includes('sk-secret'), false)
      assert.equal(error.message.includes('sk-leak'), false)
      return true
    }
  )
  assert.equal(calls[0].auth, 'Bearer sk-secret')
})

test('HTTP 429 应分类为限流错误', async () => {
  const client = makeClient(async () => jsonResponse({ error: 'rate limited' }, 429))
  await assert.rejects(
    client.translate({ ...baseInput, protocol: 'openai', apiKey: 'sk-x' }),
    (error: Error) => { assert.match(error.message, /限流/u); return true }
  )
})

test('HTTP 404 应分类为模型不存在错误', async () => {
  const client = makeClient(async () => jsonResponse({ error: 'model not found' }, 404))
  await assert.rejects(
    client.translate({ ...baseInput, protocol: 'openai', apiKey: 'sk-x' }),
    (error: Error) => { assert.match(error.message, /模型/u); return true }
  )
})

test('空译文应分类为服务错误', async () => {
  const client = makeClient(async () => jsonResponse({ choices: [{ message: { content: '   ' } }] }))
  await assert.rejects(
    client.translate({ ...baseInput, protocol: 'openai', apiKey: 'sk-x' }),
    (error: Error) => { assert.match(error.message, /空|服务/u); return true }
  )
})

test('响应结构异常应分类为服务错误', async () => {
  const client = makeClient(async () => jsonResponse({ unexpected: true }))
  await assert.rejects(
    client.translate({ ...baseInput, protocol: 'ollama', apiKey: null }),
    (error: Error) => { assert.match(error.message, /服务|空/u); return true }
  )
})

test('超时应分类为超时错误且可熔断', async () => {
  const client = makeClient(async () => {
    await new Promise((r) => setTimeout(r, 500))
    return jsonResponse({ message: { content: 'late' } })
  })
  await assert.rejects(
    client.translate({ ...baseInput, protocol: 'ollama', apiKey: null }),
    (error: Error) => { assert.match(error.message, /超时/u); return true }
  )
})

test('网络错误应分类为网络错误且不含 URL', async () => {
  const client = makeClient(async () => { throw new TypeError('fetch failed for https://api.example.com') })
  await assert.rejects(
    client.translate({ ...baseInput, protocol: 'openai', apiKey: 'sk-x' }),
    (error: Error) => {
      assert.match(error.message, /网络/u)
      assert.equal(error.message.includes('https://api.example.com'), false)
      return true
    }
  )
})

test('非 JSON 响应应分类为服务错误', async () => {
  const client = makeClient(async () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }))
  await assert.rejects(
    client.translate({ ...baseInput, protocol: 'openai', apiKey: 'sk-x' }),
    (error: Error) => { assert.match(error.message, /服务/u); return true }
  )
})
